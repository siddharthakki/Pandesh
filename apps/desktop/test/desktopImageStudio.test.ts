import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureImageStudioServices, probeImageStudioServices } from '../src/host/desktopImageStudio';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function roots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-image-services-'));
  dirs.push(root);
  const studioRoot = path.join(root, 'studio');
  const comfyRoot = path.join(root, 'comfy');
  fs.mkdirSync(path.join(comfyRoot, '.venv', 'Scripts'), { recursive: true });
  fs.mkdirSync(studioRoot, { recursive: true });
  fs.writeFileSync(path.join(studioRoot, 'app.py'), '# fixture');
  fs.writeFileSync(path.join(comfyRoot, 'main.py'), '# fixture');
  fs.writeFileSync(path.join(comfyRoot, '.venv', 'Scripts', 'python.exe'), 'fixture');
  return { studioRoot, comfyRoot };
}

describe('Desktop Image Studio service manager', () => {
  it('reports an already-running Studio and ComfyUI without starting anything', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/status')) return new Response(JSON.stringify({ comfyui: true, ollama: true }), { status: 200 });
      return new Response(JSON.stringify({ checkpoints: [
        { name: 'anime.safetensors', category: 'anime' },
        { name: 'general.safetensors', category: 'general' },
      ] }), { status: 200 });
    });
    expect(await probeImageStudioServices(fetchImpl as typeof fetch)).toMatchObject({
      studio: true, comfyui: true,
      checkpoints: [
        { name: 'general.safetensors', category: 'general' },
        { name: 'anime.safetensors', category: 'anime' },
      ],
    });
  });

  it('starts only the two configured no-install entry points, in ComfyUI then Studio order', async () => {
    const { studioRoot, comfyRoot } = roots();
    const starts: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawnImpl = vi.fn((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      starts.push({ command, args, env: options.env });
      return { unref() {} };
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const comfyStarted = starts.some((item) => item.args[0] === 'main.py');
      const studioStarted = starts.some((item) => item.args[0] === 'app.py');
      if (url.includes('/api/status')) {
        if (!studioStarted) throw new Error('down');
        return new Response(JSON.stringify({ comfyui: comfyStarted, ollama: true }), { status: 200 });
      }
      return new Response('{}', { status: comfyStarted ? 200 : 503 });
    });
    const messages: string[] = [];
    const result = await ensureImageStudioServices({
      studioRoot, comfyRoot, studioPython: 'studio-python',
      fetchImpl: fetchImpl as typeof fetch, spawnImpl: spawnImpl as never,
      delay: async () => undefined, timeoutMs: 1_000,
    }, (message) => messages.push(message));
    expect(result).toMatchObject({ studio: true, comfyui: true });
    expect(starts.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: path.join(comfyRoot, '.venv', 'Scripts', 'python.exe'), args: ['main.py', '--listen', '127.0.0.1', '--port', '8188'] },
      { command: 'studio-python', args: ['app.py'] },
    ]);
    expect(starts.every(({ env }) => env.PYTHONUTF8 === '1' && env.PYTHONIOENCODING === 'utf-8')).toBe(true);
    expect(messages).toEqual(['Waking up ComfyUI…', 'Waking up Image Generation Studio…']);
  });

  it('fails honestly after the bounded wait when services never become ready', async () => {
    const { studioRoot, comfyRoot } = roots();
    const fetchImpl = vi.fn(async () => { throw new Error('down'); });
    await expect(ensureImageStudioServices({
      studioRoot, comfyRoot, fetchImpl: fetchImpl as typeof fetch,
      spawnImpl: vi.fn(() => ({ unref() {} })) as never,
      delay: async () => undefined, timeoutMs: 0,
    })).rejects.toThrow(/did not become ready/);
  });
});
