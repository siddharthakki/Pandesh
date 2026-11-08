import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export interface ImageStudioServiceStatus {
  studio: boolean;
  comfyui: boolean;
  /** Ollama itself answered /api/version (probed directly, not the Studio's opinion of it). */
  ollama: boolean;
  /** Ollama's own reported version, when it answered. */
  ollamaVersion?: string | null;
  detail: string;
  checkpoints: Array<{ name: string; category: string }>;
}

export interface ImageStudioServiceOptions {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  delay?: (ms: number) => Promise<void>;
  studioRoot?: string;
  studioPython?: string;
  comfyRoot?: string;
  comfyPython?: string;
  timeoutMs?: number;
}

const DEFAULT_STUDIO_ROOT = 'C:\\Projects\\ImageGeneration';
const DEFAULT_COMFY_ROOT = 'C:\\Users\\siddh\\ComfyUI-Installs\\ComfyUI\\ComfyUI';
/** The standalone Studio app's own browser UI (distinct from its :8989 JSON API also used above). */
export const IMAGE_STUDIO_APP_URL = 'http://127.0.0.1:8989/';

/**
 * Re-run M11 (user review): "a steaming plate of chicken biryani with raita" alone gave SDXL too little to go on —
 * pale roast drumsticks on plain rice, raita in the middle of the plate. The Studio's own local optimizer (local Ollama,
 * nothing leaves the PC) turns the request into a concrete visual description and a negative prompt. Pandesh asks for
 * it BEFORE the approval card, so the person approves the exact text that will be drawn. Falls back to the original
 * prompt on any failure.
 */
export async function optimizeImagePrompt(prompt: string, fetcher: typeof fetch = fetch): Promise<{ prompt: string; negativePrompt: string | null; optimized: boolean }> {
  try {
    const response = await fetcher('http://127.0.0.1:8989/api/optimize-prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) return { prompt, negativePrompt: null, optimized: false };
    const body = await response.json() as { enhanced_prompt?: unknown; negative_prompt?: unknown };
    const enhanced = typeof body.enhanced_prompt === 'string' ? body.enhanced_prompt.replace(/\s+/g, ' ').trim() : '';
    const negative = typeof body.negative_prompt === 'string' ? body.negative_prompt.replace(/\s+/g, ' ').trim() : '';
    if (!enhanced || enhanced.length > 3_500) return { prompt, negativePrompt: negative || null, optimized: false };
    return { prompt: enhanced, negativePrompt: negative ? negative.slice(0, 1_500) : null, optimized: true };
  } catch {
    return { prompt, negativePrompt: null, optimized: false };
  }
}

async function reachable(fetcher: typeof fetch, url: string): Promise<boolean> {
  try { return (await fetcher(url, { signal: AbortSignal.timeout(3_000) })).ok; } catch { return false; }
}

/** Probes Ollama directly. The Studio's own `ollama` flag is not used: with the Studio down it is always false. */
async function probeOllama(fetcher: typeof fetch, base: string): Promise<{ ok: boolean; version: string | null }> {
  try {
    const response = await fetcher(new URL('/api/version', base).toString(), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return { ok: false, version: null };
    const body = await response.json().catch(() => ({})) as { version?: unknown };
    return { ok: true, version: typeof body.version === 'string' ? body.version : null };
  } catch { return { ok: false, version: null }; }
}

export async function probeImageStudioServices(fetcher: typeof fetch = fetch, ollamaBase = process.env.KARKEDIKHA_OLLAMA_URL || 'http://127.0.0.1:11434'): Promise<ImageStudioServiceStatus> {
  let studio = false; let comfyui = false;
  const ollamaProbe = probeOllama(fetcher, ollamaBase);
  let checkpoints: Array<{ name: string; category: string }> = [];
  try {
    const response = await fetcher('http://127.0.0.1:8989/api/status', { signal: AbortSignal.timeout(3_000) });
    if (response.ok) {
      const body = await response.json() as { comfyui?: boolean };
      studio = true; comfyui = body.comfyui === true;
    }
  } catch { /* honest down state */ }
  if (!comfyui) comfyui = await reachable(fetcher, 'http://127.0.0.1:8188/system_stats');
  if (studio && comfyui) {
    try {
      const response = await fetcher('http://127.0.0.1:8989/api/models', { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = await response.json() as { checkpoints?: Array<{ name?: unknown; category?: unknown }> };
        checkpoints = (body.checkpoints ?? []).flatMap((item) => typeof item.name === 'string'
          ? [{ name: item.name, category: typeof item.category === 'string' ? item.category : 'other' }]
          : []).sort((left, right) => {
            const leftRank = left.category.toLowerCase() === 'general' ? 0 : 1;
            const rightRank = right.category.toLowerCase() === 'general' ? 0 : 1;
            return leftRank - rightRank || left.name.localeCompare(right.name);
          });
      }
    } catch { /* health remains truthful; model list is separately empty */ }
  }
  const detail = studio && comfyui
    ? checkpoints.length > 0 ? 'Image Generation Studio and ComfyUI are ready' : 'Services are ready, but no checkpoint is available'
    : !comfyui ? 'ComfyUI is not running' : 'Image Generation Studio is not running';
  const o = await ollamaProbe;
  return { studio, comfyui, ollama: o.ok, ollamaVersion: o.version, detail, checkpoints };
}

let ensureInFlight: Promise<ImageStudioServiceStatus> | null = null;

export function ensureImageStudioServices(options: ImageStudioServiceOptions = {}, onStatus?: (text: string) => void): Promise<ImageStudioServiceStatus> {
  if (ensureInFlight) return ensureInFlight;
  const fetcher = options.fetchImpl ?? fetch;
  const spawnProcess = options.spawnImpl ?? spawn;
  const wait = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const studioRoot = path.resolve(options.studioRoot ?? process.env.KARKEDIKHA_IMAGE_STUDIO_ROOT ?? DEFAULT_STUDIO_ROOT);
  const comfyRoot = path.resolve(options.comfyRoot ?? process.env.KARKEDIKHA_COMFYUI_ROOT ?? DEFAULT_COMFY_ROOT);
  const studioPython = options.studioPython ?? process.env.KARKEDIKHA_IMAGE_STUDIO_PYTHON ?? 'python';
  const comfyPython = options.comfyPython ?? process.env.KARKEDIKHA_COMFYUI_PYTHON ?? path.join(comfyRoot, '.venv', 'Scripts', 'python.exe');
  const timeoutMs = options.timeoutMs ?? 120_000;

  const start = (command: string, args: string[], cwd: string): ChildProcess => {
    const child = spawnProcess(command, args, {
      cwd, windowsHide: true, detached: true, stdio: 'ignore',
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    child.unref();
    return child;
  };

  ensureInFlight = (async () => {
    let status = await probeImageStudioServices(fetcher);
    if (!status.comfyui) {
      if (!fs.existsSync(comfyPython) || !fs.existsSync(path.join(comfyRoot, 'main.py'))) throw new Error('ComfyUI local runtime is not configured');
      onStatus?.('Waking up ComfyUI…');
      start(comfyPython, ['main.py', '--listen', '127.0.0.1', '--port', '8188'], comfyRoot);
    }
    if (!status.studio) {
      if (!fs.existsSync(path.join(studioRoot, 'app.py'))) throw new Error('Image Generation Studio is not configured');
      onStatus?.('Waking up Image Generation Studio…');
      start(studioPython, ['app.py'], studioRoot);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      status = await probeImageStudioServices(fetcher);
      if (status.studio && status.comfyui) return status;
      await wait(1_000);
    }
    throw new Error(`Image generation services did not become ready within ${Math.round(timeoutMs / 1000)} seconds`);
  })().finally(() => { ensureInFlight = null; });
  return ensureInFlight;
}
