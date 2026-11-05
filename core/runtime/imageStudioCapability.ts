import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { registerArtifact } from '../domain/artifacts';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from './toolRunner';
import {
  ComfyUiError,
  buildTextToImageWorkflow,
  cancelComfyQueueItem,
  comfyUiBaseUrl,
  fetchComfyImage,
  listComfyCheckpoints,
  readComfyJob,
  submitComfyWorkflow,
  waitForComfyJob,
} from './comfyUiClient';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8989';
const MAX_PROMPT_CHARS = 4_000;
const MAX_PROVIDER_MESSAGE_CHARS = 500;
const GENERATION_TIMEOUT_MS = 12 * 60_000;

export interface ImageStudioCapabilityOptions {
  db: CoreDatabase;
  studioRoot: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Where Pandesh writes the images ComfyUI produced for it. */
  outputDir?: string;
  /** The ComfyUI endpoint, when it is not the default loopback one. */
  comfyUrl?: string;
}

interface StudioGenerateResponse {
  status?: string;
  message?: string;
  images?: Array<{ path?: string; seed?: number; prompt?: string; ts?: string }>;
  enhanced_prompt?: string;
  used_checkpoint?: string;
}

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

function boundedProviderMessage(value: unknown, fallback: string): string {
  const compact = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!compact) return fallback;
  return compact.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${compact.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}…`
    : compact;
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : fallback;
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`value must be between ${min} and ${max}`);
  return number;
}

/** One serial, governed bridge to the existing local Studio. Core owns the
 * durable invocation/approval identity; serial execution makes Studio's
 * otherwise-global progress/interrupt endpoint attributable to that one job. */
/** One job Pandesh submitted to ComfyUI, as it is remembered on disk. */
interface ComfyJobRecord {
  promptId: string;
  prompt: string;
  checkpoint: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  startedAt: string;
  conversationId: string | null;
  artifactId: string | null;
}

/**
 * The durable ledger of ComfyUI jobs.
 *
 * The prompt id is the job's identity, and it survives a Core restart: a new
 * Core can keep asking ComfyUI for the same job and still get the picture
 * that was already computed. Without this, a generation that finished while
 * the Core was down was simply lost.
 */
function readJobLedger(file: string): Record<string, ComfyJobRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs?: Record<string, ComfyJobRecord> };
    return parsed.jobs ?? {};
  } catch {
    return {};
  }
}

function writeJobLedger(file: string, jobs: Record<string, ComfyJobRecord>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, jobs }, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch {
    // The generation still happened; only the resume record is lost.
  }
}

export function createImageStudioCapabilityAdapter(options: ImageStudioCapabilityOptions): GovernedCapabilityAdapter {
  const baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
  if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) {
    throw new Error('Image Studio endpoint must be loopback HTTP');
  }
  const studioRoot = path.resolve(options.studioRoot);
  const outputRoot = path.resolve(studioRoot, 'output');
  const fetcher = options.fetchImpl ?? fetch;
  let running = false;

  // ---- Direct ComfyUI ----------------------------------------------------
  // Pandesh drives ComfyUI itself, so the prompt id belongs to Pandesh and a
  // finished generation survives a Core restart. The Studio app stays the
  // path for video (LTX) and for the Studio's own gallery.
  const comfyOutputDir = path.resolve(options.outputDir ?? path.join(studioRoot, 'output', 'pandesh'));
  const jobLedgerFile = path.join(comfyOutputDir, 'jobs.json');
  const comfyBase = (() => {
    try { return comfyUiBaseUrl(options.comfyUrl); } catch { return null; }
  })();

  async function comfyCheckpoints(): Promise<string[]> {
    if (!comfyBase) return [];
    return listComfyCheckpoints({ baseUrl: comfyBase });
  }

  /** Registers the rendered image as a durable Core artifact. */
  function registerComfyArtifact(params: {
    bytes: Buffer;
    promptId: string;
    index: number;
    title: string;
    prompt: string;
    checkpoint: string;
    seed: number;
    width: number;
    height: number;
    steps: number;
    cfg: number;
    conversationId: string | null;
    attemptId: string | null;
  }): string {
    // The prompt id comes from ComfyUI's HTTP response. Keep it a file-name
    // component so even a compromised local service cannot escape this folder.
    const safePromptId = String(params.promptId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'job';
    const fileName = `pandesh-${safePromptId}-${params.index}.png`;
    const absolutePath = path.join(comfyOutputDir, fileName);
    fs.mkdirSync(comfyOutputDir, { recursive: true });
    fs.writeFileSync(absolutePath, params.bytes);
    const artifact = registerArtifact(options.db, {
      conversationId: params.conversationId,
      attemptId: params.attemptId,
      kind: 'image',
      title: params.title.slice(0, 120),
      mimeType: 'image/png',
      absolutePath,
      source: 'comfyui-direct',
      metadata: {
        prompt: params.prompt,
        checkpoint: params.checkpoint,
        seed: params.seed,
        width: params.width,
        height: params.height,
        steps: params.steps,
        cfg: params.cfg,
        promptId: params.promptId,
      },
      actor: 'core:comfyui',
      clientId: null,
    });
    return artifact.id;
  }

  /** Collects a finished job's images into artifacts. */
  async function collectComfyJob(job: ComfyJobRecord, outputs: Array<{ filename: string; subfolder: string; type: string }>, attemptId: string | null): Promise<string[]> {
    const artifactIds: string[] = [];
    let index = 0;
    for (const output of outputs) {
      const bytes = await fetchComfyImage(output, { baseUrl: comfyBase ?? undefined });
      artifactIds.push(registerComfyArtifact({
        bytes,
        promptId: job.promptId,
        index: index += 1,
        title: job.prompt,
        prompt: job.prompt,
        checkpoint: job.checkpoint,
        seed: job.seed,
        width: job.width,
        height: job.height,
        steps: job.steps,
        cfg: job.cfg,
        conversationId: job.conversationId,
        attemptId,
      }));
    }
    return artifactIds;
  }

  async function runComfyGenerate(call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!comfyBase) return failure('the ComfyUI endpoint is not configured as loopback HTTP', 'comfyui_not_configured');
    const args = call.arguments ?? {};
    const prompt = typeof args.prompt === 'string' ? args.prompt.replace(/\s+/g, ' ').trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) return failure('prompt must be 1-4000 characters', 'invalid_arguments');
    let checkpoints: string[];
    try {
      checkpoints = await comfyCheckpoints();
    } catch (error) {
      return failure(boundedProviderMessage(error instanceof Error ? error.message : String(error), 'ComfyUI is not reachable'), 'comfyui_unavailable');
    }
    if (checkpoints.length === 0) return failure('ComfyUI reports no checkpoints; install one before generating', 'comfyui_no_checkpoints');
    const requested = typeof args.checkpoint === 'string' ? args.checkpoint.trim() : '';
    // The checkpoint must be one ComfyUI actually has. A model-invented name
    // would fail deep inside the graph with an opaque error.
    const checkpoint = requested && checkpoints.includes(requested) ? requested : checkpoints[0];
    if (requested && !checkpoints.includes(requested)) {
      return failure(`ComfyUI has no checkpoint named "${requested}". Installed: ${checkpoints.join(', ')}`, 'comfyui_unknown_checkpoint');
    }
    let width: number; let height: number; let steps: number; let cfg: number; let seed: number;
    try {
      width = Math.round(numberArg(args.width, 1024, 256, 2048) / 8) * 8;
      height = Math.round(numberArg(args.height, 1024, 256, 2048) / 8) * 8;
      steps = numberArg(args.steps, 20, 1, 100);
      cfg = numberArg(args.cfg, 7, 1, 30);
      seed = numberArg(args.seed, Math.floor(Math.random() * 2 ** 32), 0, 2 ** 32 - 1);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'invalid_arguments');
    }
    const workflow = buildTextToImageWorkflow({ prompt, checkpoint, width, height, steps, cfg, seed });
    let promptId: string;
    try {
      promptId = await submitComfyWorkflow(workflow, { baseUrl: comfyBase });
    } catch (error) {
      if (error instanceof ComfyUiError) return failure(error.message, `comfyui_${error.reason}`);
      return failure(error instanceof Error ? error.message : String(error), 'comfyui_submit_failed');
    }
    const conversationExists = ctx.correlationId ? options.db.get('SELECT id FROM conversations WHERE id = ?', [ctx.correlationId]) : undefined;
    const job: ComfyJobRecord = {
      promptId,
      prompt,
      checkpoint,
      seed,
      width,
      height,
      steps,
      cfg,
      startedAt: new Date().toISOString(),
      conversationId: conversationExists ? (ctx.correlationId ?? null) : null,
      artifactId: null,
    };
    const ledger = readJobLedger(jobLedgerFile);
    ledger[promptId] = job;
    writeJobLedger(jobLedgerFile, ledger);

    let state;
    try {
      state = await waitForComfyJob(promptId, { baseUrl: comfyBase, signal: ctx.signal, timeoutMs: GENERATION_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof ComfyUiError) return failure(`${error.message} (ComfyUI prompt id ${promptId})`, `comfyui_${error.reason}`);
      return failure(error instanceof Error ? error.message : String(error), 'comfyui_failed');
    }
    if (state.state === 'failed') {
      ledger[promptId].artifactId = null;
      writeJobLedger(jobLedgerFile, ledger);
      return failure(state.error ?? `ComfyUI job ${promptId} failed`, 'comfyui_job_failed');
    }
    if (state.outputs.length === 0) {
      return failure(`ComfyUI job ${promptId} finished without producing an image`, 'comfyui_no_output');
    }
    let artifactIds: string[];
    try {
      artifactIds = await collectComfyJob(job, state.outputs, ctx.attemptId ?? null);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'comfyui_collect_failed');
    }
    ledger[promptId].artifactId = artifactIds[0] ?? null;
    writeJobLedger(jobLedgerFile, ledger);
    return {
      status: 'succeeded',
      exitCode: 0,
      output: JSON.stringify({
        artifactIds,
        promptId,
        checkpoint,
        seed,
        width,
        height,
        message: `Generated ${artifactIds.length} image(s) with ComfyUI (${checkpoint})`,
      }),
      resultCategory: 'comfyui_image_artifact_created',
      normalizedArguments: { prompt, checkpoint, width, height, steps, cfg, seed },
      activity: { kind: 'image', title: prompt.slice(0, 120), artifactIds },
    };
  }

  /** Picks up a job that finished while nobody was watching. */
  async function runComfyResume(_call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!comfyBase) return failure('the ComfyUI endpoint is not configured as loopback HTTP', 'comfyui_not_configured');
    const ledger = readJobLedger(jobLedgerFile);
    const pending = Object.values(ledger).filter((job) => !job.artifactId);
    if (pending.length === 0) return { status: 'succeeded', exitCode: 0, output: 'No unfinished ComfyUI job is on record.', resultCategory: 'comfyui_nothing_to_resume' };
    const recovered: Array<{ promptId: string; artifactIds: string[] }> = [];
    const stillRunning: string[] = [];
    const failed: string[] = [];
    for (const job of pending) {
      try {
        const state = await readComfyJob(job.promptId, { baseUrl: comfyBase });
        if (state.state === 'running') { stillRunning.push(job.promptId); continue; }
        if (state.state === 'failed') { failed.push(job.promptId); continue; }
        const artifactIds = await collectComfyJob(job, state.outputs, ctx.attemptId ?? null);
        ledger[job.promptId].artifactId = artifactIds[0] ?? null;
        recovered.push({ promptId: job.promptId, artifactIds });
      } catch (error) {
        failed.push(`${job.promptId} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    writeJobLedger(jobLedgerFile, ledger);
    const lines = [
      `ComfyUI jobs on record: ${pending.length}; recovered: ${recovered.length}; still running: ${stillRunning.length}; failed: ${failed.length}`,
      ...recovered.map((entry) => `recovered ${entry.promptId} -> ${entry.artifactIds.join(', ')}`),
      ...(stillRunning.length ? [`still running: ${stillRunning.join(', ')}`] : []),
      ...(failed.length ? [`failed: ${failed.join('; ')}`] : []),
    ];
    return {
      status: recovered.length > 0 ? 'succeeded' : 'failed',
      exitCode: recovered.length > 0 ? 0 : 1,
      output: lines.join('\n'),
      resultCategory: 'comfyui_jobs_resumed',
    };
  }

  async function runComfyStatus(): Promise<ToolExecutionResult> {
    if (!comfyBase) return failure('the ComfyUI endpoint is not configured as loopback HTTP', 'comfyui_not_configured');
    try {
      const checkpoints = await comfyCheckpoints();
      const ledger = readJobLedger(jobLedgerFile);
      const pending = Object.values(ledger).filter((job) => !job.artifactId).map((job) => job.promptId);
      return {
        status: 'succeeded',
        exitCode: 0,
        output: JSON.stringify({ endpoint: comfyBase, checkpoints, unfinishedJobs: pending }),
        resultCategory: 'comfyui_status',
      };
    } catch (error) {
      return failure(boundedProviderMessage(error instanceof Error ? error.message : String(error), 'ComfyUI is not reachable'), 'comfyui_unavailable');
    }
  }

  async function json(urlPath: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetcher(new URL(urlPath, baseUrl), init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Image Studio ${urlPath} failed (${response.status})`);
    return body;
  }

  async function listCheckpoints(): Promise<ToolExecutionResult> {
    try {
      const body = await json('/api/models') as { checkpoints?: Array<{ name?: unknown; category?: unknown }> };
      const checkpoints = (body.checkpoints ?? []).flatMap((item) => typeof item.name === 'string'
        ? [{ name: item.name, category: typeof item.category === 'string' ? item.category : 'other' }]
        : []);
      return {
        status: 'succeeded', exitCode: 0,
        output: JSON.stringify({ checkpoints }),
        resultCategory: 'image_checkpoints_listed',
      };
    } catch (error) {
      return failure(
        boundedProviderMessage(error instanceof Error ? error.message : String(error), 'Image Studio checkpoint list is unavailable'),
        'image_studio_error',
      );
    }
  }

  /** A previously generated image artifact, usable as a Studio reference
   * (Studio resolves references by file name inside its output folder). */
  function referenceFileName(artifactId: unknown): string | null {
    let targetId = artifactId;
    if (targetId === undefined || targetId === null || targetId === '') {
      // Find the latest ready image artifact in the database to bind follow-up edits
      if (options.db) {
        try {
          const latest = options.db.get<{ id: string; absolutePath: string; kind: string }>(
            "SELECT id, absolutePath, kind FROM artifacts WHERE kind = 'image' AND availability = 'ready' ORDER BY createdAt DESC LIMIT 1"
          );
          if (latest) targetId = latest.id;
        } catch {}
      }
    }
    if (!targetId) return null;
    const row = options.db.get<{ absolutePath: string; kind: string }>('SELECT absolutePath, kind FROM artifacts WHERE id = ?', [String(targetId)]);
    if (!row || row.kind !== 'image') throw new Error('reference must be an existing image artifact');
    const resolved = path.resolve(row.absolutePath);
    if (!fs.existsSync(resolved)) throw new Error('reference image file does not exist');
    return path.basename(resolved);
  }

  /** Video and SDXL do not fit beside a ~18 GB chat model in 24 GB VRAM:
   * ask Ollama to unload idle models first. Best effort; a model that is
   * mid-request finishes that request before unloading. */
  async function releaseIdleChatModels(): Promise<string[]> {
    const ollama = process.env.OLLAMA_HOST ? new URL(process.env.OLLAMA_HOST.startsWith('http') ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : new URL('http://127.0.0.1:11434');
    try {
      const ps = await (await fetcher(new URL('/api/ps', ollama), { signal: AbortSignal.timeout(3_000) })).json() as { models?: Array<{ name?: string }> };
      const names = (ps.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
      await Promise.all(names.map((model) => fetcher(new URL('/api/generate', ollama), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined)));
      return names;
    } catch {
      return [];
    }
  }

  async function runVideo(args: Record<string, unknown>, prompt: string, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    let seconds: number; let width: number; let height: number; let startImage: string | null;
    try {
      seconds = numberArg(args.seconds, 4, 1, 8);
      width = Math.round(numberArg(args.width, 768, 256, 1280) / 32) * 32;
      height = Math.round(numberArg(args.height, 512, 256, 1280) / 32) * 32;
      startImage = referenceFileName(args.startArtifactId);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'invalid_arguments');
    }
    const fps = 24;
    const length = Math.min(257, Math.max(9, Math.round((seconds * fps) / 8) * 8 + 1));
    running = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => { abort.abort(new Error('Video generation timed out')); void json('/api/interrupt', { method: 'POST' }).catch(() => undefined); }, GENERATION_TIMEOUT_MS);
    timeout.unref?.();
    const onAbort = () => { abort.abort(ctx.signal?.reason); void json('/api/interrupt', { method: 'POST' }).catch(() => undefined); };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const health = await json('/api/status') as { comfyui?: boolean };
      if (!health.comfyui) return failure('ComfyUI is not ready; video generation was not started', 'image_studio_comfyui_unavailable');
      const released = await releaseIdleChatModels();
      const response = await json('/api/generate-video', {
        method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, width, height, length, fps, frame_rate: fps, ...(startImage ? { start_image: startImage } : {}) }),
      }) as { status?: string; message?: string; video?: { path?: string; seed?: number } };
      if (response.status !== 'completed' || !response.video?.path) {
        return failure(boundedProviderMessage(response.message, 'Image Studio did not return a completed video'), 'video_generation_failed');
      }
      const fileName = path.basename(String(response.video.path));
      const absolutePath = path.resolve(outputRoot, 'videos', fileName);
      if (!fileName || !absolutePath.startsWith(`${path.join(outputRoot, 'videos')}${path.sep}`) || !fs.existsSync(absolutePath)) {
        return failure('Image Studio returned an invalid video path', 'image_studio_invalid_output');
      }
      const extension = path.extname(fileName).toLowerCase();
      const mimeType = extension === '.mp4' ? 'video/mp4' : extension === '.webm' ? 'video/webm' : '';
      if (!mimeType) return failure('Image Studio returned an unsupported video format', 'image_studio_invalid_output');
      const conversationExists = ctx.correlationId ? options.db.get('SELECT id FROM conversations WHERE id = ?', [ctx.correlationId]) : undefined;
      const artifact = registerArtifact(options.db, {
        conversationId: conversationExists ? ctx.correlationId : null,
        attemptId: ctx.attemptId ?? null,
        kind: 'video', title: prompt.slice(0, 120), mimeType, absolutePath, source: 'image-generation-studio',
        metadata: { prompt, seed: response.video.seed ?? null, seconds: Math.round(((length - 1) / fps) * 10) / 10, width, height, frames: length, startImage, releasedChatModels: released },
        actor: 'core:image-studio', clientId: null,
      });
      return {
        status: 'succeeded', exitCode: 0,
        output: JSON.stringify({ artifactIds: [artifact.id], message: `Generated a ${Math.round(((length - 1) / fps) * 10) / 10}s ${width}×${height} video` }),
        resultCategory: 'video_artifact_created',
        normalizedArguments: { prompt, seconds, width, height, startArtifactId: args.startArtifactId ?? null },
        activity: { kind: 'video', title: prompt.slice(0, 120), artifactIds: [artifact.id] },
      };
    } catch (error) {
      const cancelled = ctx.signal?.aborted === true;
      return failure(cancelled ? 'Video generation cancelled' : boundedProviderMessage(error instanceof Error ? error.message : String(error), 'Video generation failed'), cancelled ? 'cancelled' : 'video_generation_failed');
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener('abort', onAbort);
      running = false;
    }
  }

  async function run(call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (call.name === 'image_list_checkpoints') return listCheckpoints();
    if (call.name === 'comfyui_status') return runComfyStatus();
    if (call.name === 'comfyui_generate_image') return runComfyGenerate(call, ctx);
    if (call.name === 'comfyui_resume_jobs') return runComfyResume(call, ctx);
    if (running) return failure('Image Studio is already generating; wait for that governed job to finish', 'image_studio_busy');
    const args = call.arguments;
    const prompt = typeof args.prompt === 'string' ? args.prompt.replace(/\s+/g, ' ').trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) return failure('prompt must be 1-4000 characters', 'invalid_arguments');
    if (call.name === 'video_generate') return runVideo(args, prompt, ctx);
    let width: number; let height: number; let steps: number; let cfg: number; let seed: number;
    let outputCount: number; let denoise: number; let reference: string | null;
    try {
      outputCount = Math.round(numberArg(args.outputCount, 1, 1, 4));
      denoise = numberArg(args.denoise, 0.6, 0.05, 1);
      reference = referenceFileName(args.referenceArtifactId);
      width = numberArg(args.width, 1024, 64, 4096);
      height = numberArg(args.height, 1024, 64, 4096);
      steps = numberArg(args.steps, 20, 1, 150);
      cfg = numberArg(args.cfg, 7, 1, 30);
      seed = numberArg(args.seed, -1, -1, 2 ** 32 - 1);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'invalid_arguments');
    }
    const checkpoint = typeof args.checkpoint === 'string' ? args.checkpoint.trim() : '';
    if (!checkpoint || checkpoint.length > 255) return failure('a live checkpoint selection is required', 'invalid_arguments');
    running = true;
    const generationAbort = new AbortController();
    const timeout = setTimeout(() => {
      generationAbort.abort(new Error('Image generation timed out'));
      void json('/api/interrupt', { method: 'POST' }).catch(() => undefined);
    }, GENERATION_TIMEOUT_MS);
    timeout.unref?.();
    const onAbort = () => {
      generationAbort.abort(ctx.signal?.reason);
      void json('/api/interrupt', { method: 'POST' }).catch(() => undefined);
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const health = await json('/api/status') as { comfyui?: boolean; ollama?: boolean };
      if (!health.comfyui) return failure('ComfyUI is not ready; image generation was not started', 'image_studio_comfyui_unavailable');
      const response = await json('/api/generate', {
        method: 'POST', signal: generationAbort.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, width, height, steps, cfg, seed, checkpoint, batch_size: outputCount, enhance: false, ...(reference ? { image_ref: reference, denoise } : {}) }),
      }) as StudioGenerateResponse;
      if (response.status !== 'completed' || !Array.isArray(response.images) || response.images.length < 1) {
        return failure(
          boundedProviderMessage(response.message, 'Image Studio did not return a completed image'),
          'image_studio_generation_failed',
        );
      }
      const conversationExists = ctx.correlationId
        ? options.db.get('SELECT id FROM conversations WHERE id = ?', [ctx.correlationId])
        : undefined;
      const artifactIds: string[] = [];
      for (const image of response.images.slice(0, outputCount)) {
        const fileName = path.basename(String(image.path ?? ''));
        const absolutePath = path.resolve(outputRoot, fileName);
        if (!fileName || !absolutePath.startsWith(`${outputRoot}${path.sep}`)) {
          return failure('Image Studio returned an invalid output path', 'image_studio_invalid_output');
        }
        const extension = path.extname(fileName).toLowerCase();
        if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
          return failure('Image Studio returned an unsupported image format', 'image_studio_invalid_output');
        }
        const artifact = registerArtifact(options.db, {
          conversationId: conversationExists ? ctx.correlationId : null,
          attemptId: ctx.attemptId ?? null,
          kind: 'image', title: prompt.slice(0, 120), mimeType: extension === '.png' ? 'image/png' : 'image/jpeg',
          absolutePath, source: 'image-generation-studio',
          metadata: { prompt, seed: image.seed ?? seed, checkpoint: response.used_checkpoint || checkpoint || null, width, height, steps, cfg, reference, denoise: reference ? denoise : null },
          actor: 'core:image-studio', clientId: null,
        });
        artifactIds.push(artifact.id);
      }
      return {
        status: 'succeeded', exitCode: 0,
        output: JSON.stringify({ artifactIds, message: `Generated ${artifactIds.length} verified image${artifactIds.length === 1 ? '' : 's'}${reference ? ' from your reference image' : ''}` }),
        resultCategory: 'image_artifact_created',
        normalizedArguments: { prompt, width, height, steps, cfg, seed, checkpoint, outputCount, ...(reference ? { referenceArtifactId: args.referenceArtifactId, denoise } : {}) },
        activity: { kind: 'image', title: prompt.slice(0, 120), artifactIds },
      };
    } catch (error) {
      const cancelled = ctx.signal?.aborted === true;
      const timedOut = generationAbort.signal.aborted && !cancelled;
      return failure(
        cancelled
          ? 'Image generation cancelled'
          : timedOut
            ? 'Image generation timed out after 12 minutes'
            : boundedProviderMessage(error instanceof Error ? error.message : String(error), 'Image Studio failed'),
        cancelled ? 'cancelled' : timedOut ? 'image_studio_timeout' : 'image_studio_error',
      );
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener('abort', onAbort);
      running = false;
    }
  }

  return {
    id: 'image-studio',
    definitions: () => [
      {
        name: 'image_list_checkpoints',
        description: 'List the image checkpoints actually installed and available right now in the local Image Generation Studio, each with its category (e.g. general, anime). Read-only, no approval needed. Call this before recommending a checkpoint to the user, or before calling image_generate, since only a checkpoint name from this live list is valid — never guess or invent one.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'comfyui_status',
        description: 'Report the local ComfyUI service: whether it answers, which image checkpoints it has on disk, and whether Pandesh still has an unfinished ComfyUI job on record. Read-only, no approval needed.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'comfyui_generate_image',
        description: 'Generate an image by driving the local ComfyUI service directly: Pandesh submits the workflow, keeps ComfyUI\'s prompt id, waits for the render, fetches the finished PNG and records it as a durable artifact. The prompt id survives a restart, so a finished render is never lost. Use comfyui_status first to get a checkpoint name that really exists. Consequential and approval-gated: it uses this PC\'s GPU.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            checkpoint: { type: 'string', description: 'A checkpoint file name from comfyui_status.' },
            width: { type: 'number' },
            height: { type: 'number' },
            steps: { type: 'number' },
            cfg: { type: 'number' },
            seed: { type: 'number' },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'comfyui_resume_jobs',
        description: 'Pick up ComfyUI jobs Pandesh submitted but never collected — for example a render that finished while Pandesh was restarting. Every finished job is fetched and recorded as an artifact; jobs that are still running are reported as such. Consequential (it writes artifacts).',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'image_generate',
        description: 'Generate 1-4 still images through the configured local Image Generation Studio, optionally from a reference image artifact (edit / variations, strength via denoise). Consequential and approval-gated. checkpoint must be a name from image_list_checkpoints.',
        parameters: { type: 'object', properties: { prompt: { type: 'string' }, checkpoint: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, steps: { type: 'number' }, cfg: { type: 'number' }, seed: { type: 'number' }, outputCount: { type: 'number' }, referenceArtifactId: { type: 'string' }, denoise: { type: 'number' } }, required: ['prompt', 'checkpoint'] },
      },
      {
        name: 'video_generate',
        description: 'Generate a short (1-8 s) local video with LTX-Video through Image Studio, from text or animating an existing image artifact (startArtifactId). Consequential and approval-gated.',
        parameters: { type: 'object', properties: { prompt: { type: 'string' }, seconds: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, startArtifactId: { type: 'string' } }, required: ['prompt'] },
      },
    ],
    classify: (toolName) => (toolName === 'image_list_checkpoints' || toolName === 'comfyui_status' ? 'read_only' : 'consequential'),
    health: () => fs.existsSync(path.join(studioRoot, 'app.py')) && fs.existsSync(outputRoot)
      ? { state: running ? 'degraded' : 'available', reason: running ? 'one image generation is already running' : undefined, checkedAt: new Date().toISOString() }
      : { state: 'degraded', reason: `the Image Studio app is not installed at ${studioRoot}; the direct ComfyUI tools still work when ComfyUI is running`, checkedAt: new Date().toISOString() },
    redactArguments: (_toolName, args) => ({ ...args, prompt: typeof args.prompt === 'string' ? args.prompt.slice(0, MAX_PROMPT_CHARS) : '' }),
    run,
  };
}
