/**
 * Pandesh driving ComfyUI directly.
 *
 * ComfyUI has a documented HTTP API: submit a workflow with `POST /prompt`,
 * poll the job with `GET /history/{prompt_id}`, and fetch the rendered image
 * with `GET /view`. Driving it directly - instead of through an out-of-repo
 * helper application - is what makes a generation resumable: the prompt id
 * is durable, so a Core that was restarted can keep asking for the result
 * instead of losing the picture that was already computed.
 *
 * Everything here is loopback-only. The base URL must resolve to 127.0.0.1 or
 * localhost, so a model-provided URL can never point the renderer at some
 * other host.
 */
import * as crypto from 'node:crypto';

export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

export interface ComfyUiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The ComfyUI endpoint, refused unless it is loopback HTTP. */
export function comfyUiBaseUrl(raw?: string): string {
  const candidate = raw ?? process.env.KARKEDIKHA_COMFYUI_URL ?? DEFAULT_COMFYUI_URL;
  const url = new URL(candidate);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('the ComfyUI endpoint must be loopback HTTP');
  }
  return url.origin;
}

export class ComfyUiError extends Error {
  constructor(message: string, readonly reason: 'unreachable' | 'rejected' | 'timeout' | 'cancelled' | 'failed') {
    super(message);
    this.name = 'ComfyUiError';
  }
}

interface ComfyRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  method?: string;
  body?: unknown;
  /** Test seam: the HTTP client. */
  fetchImpl?: typeof fetch;
}

async function request(url: URL, options: ComfyRequestOptions = {}): Promise<Response> {
  const fetcher = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('ComfyUI did not answer in time')), options.timeoutMs ?? 20_000);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetcher(url, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ComfyUiError(`ComfyUI ${url.pathname} answered ${response.status}: ${text.slice(0, 200)}`, 'rejected');
    }
    return response;
  } catch (error) {
    if (error instanceof ComfyUiError) throw error;
    if (options.signal?.aborted) throw new ComfyUiError('the ComfyUI job was cancelled', 'cancelled');
    const message = error instanceof Error ? error.message : String(error);
    throw new ComfyUiError(`ComfyUI at ${url.origin} did not answer: ${message}`, 'unreachable');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** The checkpoints ComfyUI actually has on disk right now. */
export async function listComfyCheckpoints(options: ComfyRequestOptions & { baseUrl?: string } = {}): Promise<string[]> {
  const base = comfyUiBaseUrl(options.baseUrl);
  const url = new URL('/models/checkpoints', base);
  const response = await request(url, { ...options, timeoutMs: options.timeoutMs ?? 10_000 });
  const body = await response.json() as unknown;
  if (!Array.isArray(body)) return [];
  return body.filter((entry): entry is string => typeof entry === 'string');
}

export interface ImageWorkflowInput {
  prompt: string;
  negativePrompt?: string;
  checkpoint: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  batchSize?: number;
  sampler?: string;
  scheduler?: string;
}

/**
 * The standard text-to-image graph: checkpoint -> two CLIP encoders -> empty
 * latent -> sampler -> decode -> save. It is the same graph the local Studio
 * uses, expressed directly so Pandesh owns the prompt id.
 */
export function buildTextToImageWorkflow(input: ImageWorkflowInput): Record<string, unknown> {
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 32);
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: input.checkpoint } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: input.prompt } },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: input.negativePrompt ?? 'blurry, low quality, watermark, text' } },
    '7': { class_type: 'EmptyLatentImage', inputs: { batch_size: input.batchSize ?? 1, height: input.height ?? 1024, width: input.width ?? 1024 } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        cfg: input.cfg ?? 7,
        denoise: 1,
        latent_image: ['7', 0],
        model: ['4', 0],
        negative: ['6', 0],
        positive: ['5', 0],
        sampler_name: input.sampler ?? 'euler',
        scheduler: input.scheduler ?? 'normal',
        seed,
        steps: input.steps ?? 20,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pandesh' } },
  };
}

/** Submits the graph and returns the prompt id ComfyUI assigned it. */
export async function submitComfyWorkflow(
  workflow: Record<string, unknown>,
  options: ComfyRequestOptions & { baseUrl?: string } = {},
): Promise<string> {
  const base = comfyUiBaseUrl(options.baseUrl);
  const url = new URL('/prompt', base);
  const response = await request(url, {
    ...options,
    method: 'POST',
    body: { prompt: workflow, client_id: crypto.randomUUID() },
  });
  const body = await response.json() as { prompt_id?: string; node_errors?: Record<string, unknown> };
  if (!body.prompt_id) {
    const errors = body.node_errors ? Object.keys(body.node_errors).join(', ') : 'none reported';
    throw new ComfyUiError(`ComfyUI did not accept the workflow (node errors: ${errors})`, 'rejected');
  }
  return body.prompt_id;
}

export interface ComfyImageOutput {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyJobState {
  /** 'running' | 'completed' | 'failed' */
  state: 'running' | 'completed' | 'failed';
  outputs: ComfyImageOutput[];
  /** The failure ComfyUI reported, when it failed. */
  error?: string;
}

/** Reads the job state from ComfyUI's history. */
export async function readComfyJob(promptId: string, options: ComfyRequestOptions & { baseUrl?: string } = {}): Promise<ComfyJobState> {
  const base = comfyUiBaseUrl(options.baseUrl);
  const url = new URL(`/history/${encodeURIComponent(promptId)}`, base);
  const response = await request(url, { ...options, timeoutMs: options.timeoutMs ?? 15_000 });
  const body = await response.json() as Record<string, {
    outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }>;
    status?: { status_str?: string; completed?: boolean; messages?: unknown[][] };
  }>;
  const record = body[promptId];
  if (!record) return { state: 'running', outputs: [] };
  const outputs: ComfyImageOutput[] = [];
  for (const node of Object.values(record.outputs ?? {})) {
    for (const image of node.images ?? []) {
      if (!image.filename) continue;
      outputs.push({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
    }
  }
  const status = record.status?.status_str ?? '';
  if (record.status?.completed === true) return { state: 'completed', outputs };
  if (status === 'error' || status === 'failed') {
    return { state: 'failed', outputs, error: `ComfyUI reported '${status}' for this job` };
  }
  return { state: 'running', outputs };
}

/**
 * Waits for the job to finish by polling ComfyUI's history.
 *
 * Polling (rather than a WebSocket) is deliberate: the prompt id is durable,
 * so the wait survives a Core restart - a new Core can keep asking the same
 * question and still get the picture.
 */
export async function waitForComfyJob(
  promptId: string,
  options: ComfyRequestOptions & { baseUrl?: string; pollMs?: number; timeoutMs?: number; onPoll?: (elapsedMs: number) => void } = {},
): Promise<ComfyJobState> {
  const pollMs = options.pollMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const started = Date.now();
  for (;;) {
    if (options.signal?.aborted) throw new ComfyUiError('the ComfyUI job was cancelled', 'cancelled');
    const state = await readComfyJob(promptId, options);
    options.onPoll?.(Date.now() - started);
    if (state.state !== 'running') return state;
    if (Date.now() - started > timeoutMs) {
      throw new ComfyUiError(`the ComfyUI job did not finish within ${Math.round(timeoutMs / 1000)}s (prompt id ${promptId})`, 'timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Fetches the rendered image bytes from ComfyUI's output. */
export async function fetchComfyImage(output: ComfyImageOutput, options: ComfyRequestOptions & { baseUrl?: string } = {}): Promise<Buffer> {
  const base = comfyUiBaseUrl(options.baseUrl);
  const url = new URL('/view', base);
  url.searchParams.set('filename', output.filename);
  url.searchParams.set('subfolder', output.subfolder);
  url.searchParams.set('type', output.type);
  const response = await request(url, { ...options, timeoutMs: options.timeoutMs ?? 60_000 });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new ComfyUiError('ComfyUI returned an empty image', 'failed');
  return bytes;
}

/** Removes a queued (not yet running) job. */
export async function cancelComfyQueueItem(promptId: string, options: ComfyRequestOptions & { baseUrl?: string } = {}): Promise<void> {
  const base = comfyUiBaseUrl(options.baseUrl);
  const url = new URL('/queue', base);
  await request(url, { ...options, method: 'POST', body: { delete: [promptId] } });
}
