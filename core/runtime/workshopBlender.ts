/**
 * Rendering a Workshop 3D scene in Blender with real assets, on this PC.
 *
 * The scene exports its own geometry from the sandboxed preview; here Core finds Blender and the asset library, writes a
 * job file, runs the fixed script (workshopBlenderScript.ts) and reads back result.json. No model writes anything that
 * runs: the job is data, the script is ours, and Blender starts with factory settings (no add-ons, no user scripts).
 *
 * The asset library is a folder the owner filled (CC0 assets with a manifest.json and a roles.json saying which asset
 * plays a tree, a bush, grass, a rock…). Nothing is downloaded here.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RENDER_SCENE_PY } from './workshopBlenderScript';

/** The stand-in kinds a library role can replace: role name in roles.json → the scene runtime's stand-in kind. */
const ROLE_FOR_KIND: Record<string, string> = { tree: 'tree', shrub: 'bush', hedge: 'bush', rock: 'rock', lamp: 'lamp', tableset: 'tableset' };

export interface AssetLibrary { root: string; roles: Record<string, unknown>; assets: number; licence: string; replaces: string[] }
export interface BlenderRenderResult {
  ok: boolean; error?: string; pictures: Array<{ view: string; path: string }>; blend: string | null; used: Record<string, number>;
  warnings: string[]; seconds: number; device?: string; log?: string;
}
export interface BlenderDeps { exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv; spawnImpl?: typeof spawn }

/** Where Blender is on this PC, or null. PANDESH_BLENDER wins; otherwise the usual install folders. */
export function findBlender(deps: BlenderDeps = {}): string | null {
  const exists = deps.exists ?? ((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const env = deps.env ?? process.env;
  const exe = process.platform === 'win32' ? 'blender.exe' : 'blender';
  const candidates: string[] = [];
  if (env.PANDESH_BLENDER) candidates.push(env.PANDESH_BLENDER);
  if (process.platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      const home = path.join(base, 'Blender Foundation');
      try { for (const d of fs.readdirSync(home).sort().reverse()) candidates.push(path.join(home, d, exe)); } catch { /* not installed there */ }
    }
    candidates.push('D:\\ai_tools\\Blender\\blender.exe');
  } else candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender');
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(dir, exe));
  return candidates.find((c) => exists(c)) ?? null;
}

/** The asset library on this PC, or why there is none. PANDESH_ASSET_LIBRARY wins, then <data>/asset-library, then D:\PandeshAssets\polyhaven. */
export function findAssetLibrary(dataDir: string, deps: BlenderDeps = {}): { ok: true; library: AssetLibrary } | { ok: false; reason: string } {
  const env = deps.env ?? process.env;
  const roots = [env.PANDESH_ASSET_LIBRARY, path.join(dataDir, 'asset-library'), 'D:\\PandeshAssets\\polyhaven'].filter(Boolean) as string[];
  for (const root of roots) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { licence?: unknown; assets?: Array<{ id?: unknown }> };
      const roles = JSON.parse(fs.readFileSync(path.join(root, 'roles.json'), 'utf8')) as Record<string, unknown>;
      const ids = new Set((manifest.assets ?? []).map((a) => String(a.id ?? '')));
      const has = (role: string) => (Array.isArray(roles[role]) ? (roles[role] as unknown[]) : []).some((id) => ids.has(String(id)));
      return { ok: true, library: { root, roles, assets: ids.size, licence: String(manifest.licence ?? 'see manifest.json').slice(0, 120), replaces: Object.keys(ROLE_FOR_KIND).filter((kind) => has(ROLE_FOR_KIND[kind])) } };
    } catch { /* not a library: try the next place */ }
  }
  return { ok: false, reason: `no asset library was found (looked in ${roots.join(', ')}; a library is a folder with manifest.json and roles.json)` };
}

export interface RenderJob {
  blender: string; library: AssetLibrary; glb: string; scene: unknown; outDir: string;
  views?: string[]; samples?: number; width?: number; signal?: AbortSignal; timeoutMs?: number;
}

/** Runs the fixed render script in Blender and reads back what it did. Never throws: a failure is a result with a reason. */
export async function renderSceneInBlender(job: RenderJob, deps: BlenderDeps = {}): Promise<BlenderRenderResult> {
  const failed = (error: string, log = ''): BlenderRenderResult => ({ ok: false, error, pictures: [], blend: null, used: {}, warnings: [], seconds: 0, log: log.slice(-1_500) });
  try {
    fs.mkdirSync(job.outDir, { recursive: true });
    const script = path.join(job.outDir, 'render_scene.py'); const jobFile = path.join(job.outDir, 'job.json');
    fs.writeFileSync(script, RENDER_SCENE_PY);
    fs.writeFileSync(jobFile, JSON.stringify({
      glb: job.glb, scene: job.scene, library: job.library.root, roles: job.library.roles, out: job.outDir,
      views: job.views ?? ['hero', 'aerial', 'front'], samples: job.samples ?? 128, width: job.width ?? 1600, saveBlend: true,
    }));
    const resultFile = path.join(job.outDir, 'result.json');
    try { fs.rmSync(resultFile, { force: true }); } catch { /* none yet */ }
    const log = await new Promise<{ code: number | null; text: string; why?: string }>((resolve) => {
      // A clean Blender: factory settings, no add-ons or startup scripts from the user's profile, no automatic scripts in files.
      const child = (deps.spawnImpl ?? spawn)(job.blender, ['-b', '--factory-startup', '--disable-autoexec', '--python-exit-code', '3', '--python', script, '--', jobFile], { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; const keep = (b: Buffer) => { text = (text + b.toString('utf8')).slice(-6_000); };
      child.stdout?.on('data', keep); child.stderr?.on('data', keep);
      let why: string | undefined;
      const stop = (reason: string) => { why = reason; try { child.kill(); } catch { /* already gone */ } };
      const timer = setTimeout(() => stop('it took longer than allowed'), job.timeoutMs ?? 15 * 60_000);
      const onAbort = () => stop('cancelled');
      job.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, text, why: `Blender could not be started: ${err.message}` }); });
      child.on('close', (code) => { clearTimeout(timer); job.signal?.removeEventListener('abort', onAbort); resolve({ code, text, why }); });
    });
    if (log.why) return failed(log.why, log.text);
    let result: BlenderRenderResult;
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as BlenderRenderResult; } catch { return failed(`Blender ended (exit ${log.code}) without reporting a result`, log.text); }
    // Only pictures that are really in this job's folder count.
    const pictures = (Array.isArray(result.pictures) ? result.pictures : [])
      .map((p) => ({ view: String(p?.view ?? '').slice(0, 20), path: path.resolve(String(p?.path ?? '')) }))
      .filter((p) => path.dirname(p.path) === path.resolve(job.outDir) && /\.jpg$/.test(p.path) && (() => { try { return fs.statSync(p.path).size > 2_000; } catch { return false; } })());
    const blend = typeof result.blend === 'string' && path.dirname(path.resolve(result.blend)) === path.resolve(job.outDir) && fs.existsSync(result.blend) ? path.resolve(result.blend) : null;
    const used: Record<string, number> = {};
    for (const [k, v] of Object.entries(result.used ?? {})) if (/^[\w.-]{1,80}$/.test(k) && Number.isFinite(Number(v))) used[k] = Number(v);
    return {
      ok: result.ok === true && pictures.length > 0, error: result.ok === true && pictures.length ? undefined : String(result.error ?? 'no picture was rendered').slice(0, 400),
      pictures, blend, used, warnings: (Array.isArray(result.warnings) ? result.warnings : []).map((w) => String(w).slice(0, 200)).slice(0, 8),
      seconds: Number(result.seconds) || 0, device: typeof result.device === 'string' ? result.device.slice(0, 120) : undefined, log: result.ok === true ? undefined : log.text.slice(-1_500),
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** Asks the local model server to let go of loaded models, so the render has the graphics memory. Best effort. */
export async function releaseLocalModels(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const host = process.env.KARKEDIKHA_OLLAMA_URL?.replace(/\/v1\/?$/, '') ?? (process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith('http') ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://127.0.0.1:11434');
  try {
    const root = new URL(host);
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(root.hostname)) return [];
    const ps = await (await fetchImpl(new URL('/api/ps', root), { signal: AbortSignal.timeout(3_000) })).json() as { models?: Array<{ name?: string }> };
    const names = (ps.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
    await Promise.all(names.map((model) => fetchImpl(new URL('/api/generate', root), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined)));
    return names;
  } catch { return []; }
}
