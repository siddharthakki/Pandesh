import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { registerArtifact } from '../domain/artifacts';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from './toolRunner';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8989';
const MAX_PROMPT_CHARS = 4_000;
const MAX_PROVIDER_MESSAGE_CHARS = 500;
const GENERATION_TIMEOUT_MS = 12 * 60_000;

export interface ImageStudioCapabilityOptions {
  db: CoreDatabase;
  studioRoot: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
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
export function createImageStudioCapabilityAdapter(options: ImageStudioCapabilityOptions): GovernedCapabilityAdapter {
  const baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
  if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) {
    throw new Error('Image Studio endpoint must be loopback HTTP');
  }
  const studioRoot = path.resolve(options.studioRoot);
  const outputRoot = path.resolve(studioRoot, 'output');
  const fetcher = options.fetchImpl ?? fetch;
  let running = false;

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
    if (artifactId === undefined || artifactId === null || artifactId === '') return null;
    const row = options.db.get<{ absolutePath: string; kind: string }>('SELECT absolutePath, kind FROM artifacts WHERE id = ?', [String(artifactId)]);
    if (!row || row.kind !== 'image') throw new Error('reference must be an existing image artifact');
    const resolved = path.resolve(row.absolutePath);
    if (path.dirname(resolved) !== outputRoot || !fs.existsSync(resolved)) throw new Error('reference image is not in the Image Studio output folder');
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
    classify: (toolName) => (toolName === 'image_list_checkpoints' ? 'read_only' : 'consequential'),
    health: () => fs.existsSync(path.join(studioRoot, 'app.py')) && fs.existsSync(outputRoot)
      ? { state: running ? 'degraded' : 'available', reason: running ? 'one image generation is already running' : undefined, checkedAt: new Date().toISOString() }
      : { state: 'unavailable', reason: `Image Studio is not installed at ${studioRoot}`, checkedAt: new Date().toISOString() },
    redactArguments: (_toolName, args) => ({ ...args, prompt: typeof args.prompt === 'string' ? args.prompt.slice(0, MAX_PROMPT_CHARS) : '' }),
    run,
  };
}
