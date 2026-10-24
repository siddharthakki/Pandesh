import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export interface ImageStudioServiceStatus {
  studio: boolean;
  comfyui: boolean;
  ollama: boolean;
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

async function reachable(fetcher: typeof fetch, url: string): Promise<boolean> {
  try { return (await fetcher(url, { signal: AbortSignal.timeout(3_000) })).ok; } catch { return false; }
}

export async function probeImageStudioServices(fetcher: typeof fetch = fetch): Promise<ImageStudioServiceStatus> {
  let studio = false; let comfyui = false; let ollama = false;
  let checkpoints: Array<{ name: string; category: string }> = [];
  try {
    const response = await fetcher('http://127.0.0.1:8989/api/status', { signal: AbortSignal.timeout(3_000) });
    if (response.ok) {
      const body = await response.json() as { comfyui?: boolean; ollama?: boolean };
      studio = true; comfyui = body.comfyui === true; ollama = body.ollama === true;
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
  return { studio, comfyui, ollama, detail, checkpoints };
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
