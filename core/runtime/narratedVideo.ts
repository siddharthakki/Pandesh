/**
 * Narrated video: a script in, a finished, checked video package out.
 *
 * "Make a short narrated video about X" is one workflow across tools this PC already has, each found through the live
 * capability inventory rather than assumed:
 *   1. the inventory confirms FFmpeg/FFprobe; Piper (the voice Pandesh already speaks with) is located next to Core;
 *   2. Piper speaks each scene's narration to a WAV (local, CPU), FFprobe measures it: the audio sets the timing;
 *   3. each scene gets a picture: ComfyUI renders the scene's visual prompt when it is running (models already
 *      installed, loopback only), otherwise FFmpeg draws a plain backdrop card. Which one happened is reported per scene;
 *   4. FFmpeg turns each picture into a slow-moving segment, joins them, burns in subtitles timed from the narration,
 *      mixes the voice over a quiet synthesized bed (optional) and normalises loudness;
 *   5. the package is written to one new folder: the MP4, an .srt, a thumbnail, the script, YouTube metadata, every
 *      source asset and a production record;
 *   6. FFprobe and FFmpeg check the result independently (streams, size, duration, audible audio, a real frame, cues).
 *
 * Nothing is uploaded or published, nothing is downloaded, and no file is overwritten. The same call serves any
 * subject: the caller supplies the scenes; nothing here knows what the story is about.
 */
import { execFile, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeCapabilityInventory, workingExecutable, type InventoryProbeDeps } from './capabilityInventory';
import { buildTextToImageWorkflow, comfyUiBaseUrl, fetchComfyImage, listComfyCheckpoints, submitComfyWorkflow, waitForComfyJob } from './comfyUiClient';
import type { ToolStep } from './mediaProduction';

export interface SceneInput { narration: string; visual: string }

export interface NarratedVideoInput {
  title: string;
  scenes: SceneInput[];
  /** Visual style added to every scene prompt, so the pictures belong together. */
  style?: string;
  music?: boolean;
  subtitles?: boolean;
  orientation?: 'landscape' | 'portrait';
  /** The new folder to create. Must not exist. */
  outputDir: string;
  youtube?: { title?: string; description?: string; tags?: string[] };
  /** Wanted length in seconds [min, max]; reported against the real length, never forced. */
  targetSeconds?: [number, number];
  /** 'auto' uses ComfyUI when it answers, 'cards' never asks it. */
  visuals?: 'auto' | 'cards';
  onStage?: (stage: string) => void;
  signal?: AbortSignal;
}

export interface NarratedScene { index: number; narration: string; visual: string; seconds: number; narrationFile: string; imageFile: string; imageSource: 'comfyui' | 'backdrop_card'; imageNote?: string }

export interface NarratedVideoResult {
  folder: string;
  video: string;
  subtitles: string | null;
  thumbnail: string;
  script: string;
  metadata: string;
  record: string;
  durationSec: number;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  scenes: NarratedScene[];
  voice: string;
  music: string | null;
  visualsBy: { comfyui: number; backdrop_card: number; checkpoint: string | null; note: string };
  steps: ToolStep[];
  verified: boolean;
  verification: string[];
  withinTarget: boolean | null;
  /** Parts of the package that were asked for by the tool's own contract and are missing. */
  incomplete: string[];
}

export interface NarratedVideoDeps extends InventoryProbeDeps {
  /** Test seam: where Piper lives ({ exe, model }). */
  piper?: { exe: string; model: string } | null;
  /** Test seam: starts the local ComfyUI and resolves true once it answers. Default: wakeComfyUi. */
  wakeComfy?: (signal?: AbortSignal) => Promise<{ started: boolean; ready: boolean; detail: string }>;
}

/**
 * Starts the ComfyUI already installed on this PC when it is not running, the way the app's Image Studio does
 * (python main.py on loopback), and waits for it to answer. Nothing is downloaded or installed: without a local
 * install at KARKEDIKHA_COMFYUI_ROOT (default: ComfyUI-Installs/ComfyUI/ComfyUI in the user's folder) it does nothing.
 * The server keeps running afterwards, as it does when the Image Studio starts it.
 */
export async function wakeComfyUi(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<{ started: boolean; ready: boolean; detail: string }> {
  const base = (env.KARKEDIKHA_COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
  const answers = async () => { try { return (await fetchFn(`${base}/system_stats`, { signal: AbortSignal.timeout(2_500) })).ok; } catch { return false; } };
  if (await answers()) return { started: false, ready: true, detail: 'ComfyUI was already running' };
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):8188$/.test(base)) return { started: false, ready: false, detail: 'ComfyUI is not answering at its configured address' };
  const comfyRoot = path.resolve(env.KARKEDIKHA_COMFYUI_ROOT ?? path.join(os.homedir(), 'ComfyUI-Installs', 'ComfyUI', 'ComfyUI'));
  const python = env.KARKEDIKHA_COMFYUI_PYTHON ?? path.join(comfyRoot, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python) || !fs.existsSync(path.join(comfyRoot, 'main.py'))) return { started: false, ready: false, detail: 'no local ComfyUI install was found to start' };
  try {
    const child = spawn(python, ['main.py', '--listen', '127.0.0.1', '--port', '8188'], { cwd: comfyRoot, windowsHide: true, detached: true, stdio: 'ignore', env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    child.on('error', () => { /* reported below as not ready */ });
    child.unref();
  } catch (err) {
    return { started: false, ready: false, detail: `ComfyUI could not be started (${err instanceof Error ? err.message : String(err)})` };
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { started: true, ready: false, detail: 'cancelled while ComfyUI was starting' };
    if (await answers()) return { started: true, ready: true, detail: 'ComfyUI was started for this video and is still running' };
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return { started: true, ready: false, detail: 'ComfyUI was started but did not answer within 2 minutes' };
}

interface RunResult { code: number | null; stdout: string; stderr: string }

function run(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; signal?: AbortSignal } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', signal: opts.signal }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    if (opts.input !== undefined) { child.stdin?.on('error', () => { /* the process ended first */ }); child.stdin?.end(opts.input, 'utf8'); }
  });
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? '';

/** Piper next to Core (the installed app stages it under runtime/piper), or where PANDESH_PIPER_DIR points. */
export function findPiper(env: NodeJS.ProcessEnv = process.env): { exe: string; model: string } | null {
  const coreDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : process.cwd();
  const dirs = [env.PANDESH_PIPER_DIR, path.join(coreDir, 'piper'), path.join(coreDir, '..', 'runtime', 'piper'), env.KARKEDIKHA_DESKTOP_PRODUCT_ROOT ? path.join(env.KARKEDIKHA_DESKTOP_PRODUCT_ROOT, 'runtime', 'piper') : undefined]
    .filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    const exe = path.join(dir, process.platform === 'win32' ? 'piper.exe' : 'piper');
    const voices = path.join(dir, 'voices');
    try {
      if (!fs.existsSync(exe)) continue;
      const model = fs.readdirSync(voices).filter((f) => f.endsWith('.onnx')).sort()[0];
      if (model) return { exe, model: path.join(voices, model) };
    } catch { /* next candidate */ }
  }
  return null;
}

/** What Piper is given: plain sentences, no markup, no symbols it would read aloud. */
export function speakable(text: string): string {
  return text.replace(/[*_#`>|]/g, ' ').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim();
}

export function slugify(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'video';
}

const srtTime = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** Splits narration into subtitle cues of at most two short lines, breaking at punctuation where it can. */
export function cueTexts(narration: string, maxChars = 76): string[] {
  const pieces = narration.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+|(?<=[,;:—])\s+/).filter(Boolean);
  const cues: string[] = [];
  let current = '';
  const push = () => { if (current.trim()) cues.push(current.trim()); current = ''; };
  for (const piece of pieces) {
    if (piece.length > maxChars) {
      push();
      let line = '';
      for (const word of piece.split(' ')) {
        if ((line + ' ' + word).trim().length > maxChars) { cues.push(line.trim()); line = word; } else line = `${line} ${word}`.trim();
      }
      current = line;
      continue;
    }
    if ((current + ' ' + piece).trim().length > maxChars) push();
    current = `${current} ${piece}`.trim();
    if (/[.!?…]$/.test(piece) && current.length > maxChars * 0.5) push();
  }
  push();
  return cues;
}

/** Two balanced lines for one cue. */
export function twoLines(text: string, maxLine = 42): string {
  if (text.length <= maxLine) return text;
  const words = text.split(' ');
  let best = text;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) { bestDiff = diff; best = `${a}\n${b}`; }
  }
  return best;
}

export interface Cue { start: number; end: number; text: string }

/** Cues for one scene, spread over its narration by text length. `offset` is where the voice starts in the video. */
export function sceneCues(narration: string, offset: number, voiceSeconds: number): Cue[] {
  const texts = cueTexts(narration);
  const total = texts.reduce((n, t) => n + t.length, 0) || 1;
  let t = offset;
  return texts.map((text) => {
    const d = voiceSeconds * (text.length / total);
    const cue = { start: t, end: t + d, text: twoLines(text) };
    t += d;
    return cue;
  });
}

export function renderSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(Math.max(c.start + 0.4, c.end - 0.05))}\n${c.text}\n`).join('\n');
}

type Palette = { sky: [number, number, number]; skyLow: [number, number, number]; orb: [number, number, number]; hill: [number, number, number]; stars: boolean };
const PALETTES: Record<'night' | 'dusk' | 'day', Palette> = {
  night: { sky: [11, 16, 38], skyLow: [59, 46, 108], orb: [250, 244, 214], hill: [14, 40, 30], stars: true },
  dusk: { sky: [56, 44, 110], skyLow: [236, 140, 98], orb: [255, 214, 150], hill: [38, 52, 44], stars: false },
  day: { sky: [108, 178, 236], skyLow: [206, 234, 250], orb: [255, 240, 170], hill: [74, 148, 82], stars: false },
};

export function paletteFor(visual: string): keyof typeof PALETTES {
  if (/\b(?:night|moon|stars?|sleep\w*|dream\w*|bed\w*|midnight|dark)\b/i.test(visual)) return 'night';
  if (/\b(?:sunset|evening|dusk|twilight|sunrise|dawn|golden)\b/i.test(visual)) return 'dusk';
  return 'day';
}

/** FFmpeg `geq` expressions for a plain backdrop: a sky gradient, a sun or moon with a glow, stars at night, hills. */
export function backdropFilter(visual: string, W: number, H: number, variant: number): string {
  const p = PALETTES[paletteFor(visual)];
  const ox = Math.round(W * (variant % 2 === 0 ? 0.78 : 0.22));
  const oy = Math.round(H * 0.21);
  const orbR = Math.round(H * 0.088);
  const hillY = Math.round(H * 0.78);
  const amp = Math.round(H * 0.046);
  const phase = (variant * 1.7).toFixed(2);
  const chan = (i: 0 | 1 | 2) => {
    const sky = `${p.sky[i]}+${p.skyLow[i] - p.sky[i]}*Y/${H}+${Math.round(70 - i * 12)}*exp(-hypot(X-${ox},Y-${oy})/${Math.round(H * 0.15)})`;
    const star = p.stars ? `if(lt(mod(X*X*3+Y*Y*7+X*Y*13+${variant * 101},4999),2)*lt(Y,${Math.round(H * 0.7)}),${i === 2 ? 255 : 236},${sky})` : sky;
    return `if(lt(hypot(X-${ox},Y-${oy}),${orbR}),${p.orb[i]},if(gt(Y,${hillY}+${amp}*sin(X/${Math.round(W / 8)}+${phase})+${Math.round(amp / 2)}*sin(X/${Math.round(W / 20)})),${p.hill[i]},${star}))`;
  };
  return `format=rgb24,geq=r='${chan(0)}':g='${chan(1)}':b='${chan(2)}'`;
}

const NEGATIVE_PROMPT = 'text, letters, watermark, signature, logo, frame, border, scary, frightening, creepy, blood, weapon, violence, deformed, extra limbs, blurry, low quality';

function pickCheckpoint(names: string[]): string | null {
  const usable = names.filter((n) => !/ltx|video|pose|inpaint|refiner|upscal|svd/i.test(n));
  return usable.find((n) => /realvis|juggernaut|dreamshaper|sdxl|xl/i.test(n)) ?? usable[0] ?? null;
}

function findFont(): string | null {
  for (const f of ['C:\\Windows\\Fonts\\segoeuib.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']) if (fs.existsSync(f)) return f;
  return null;
}

function wrapTitle(text: string, maxChars: number): string {
  const lines: string[] = [''];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if ((lines[lines.length - 1] + ' ' + w).trim().length > maxChars && lines.length < 3) lines.push(w);
    else lines[lines.length - 1] = `${lines[lines.length - 1]} ${w}`.trim();
  }
  return lines.join('\n');
}

export async function produceNarratedVideo(input: NarratedVideoInput, deps: NarratedVideoDeps = {}): Promise<NarratedVideoResult> {
  const steps: ToolStep[] = [];
  const stage = async <T>(tool: string, purpose: string, fn: () => Promise<{ ok: boolean; detail: string; value: T }>): Promise<T> => {
    if (input.signal?.aborted) throw new Error('cancelled');
    input.onStage?.(purpose.charAt(0).toUpperCase() + purpose.slice(1));
    const t = Date.now();
    const r = await fn();
    steps.push({ tool, purpose, ok: r.ok, detail: r.detail, ms: Date.now() - t });
    return r.value;
  };
  const scenesIn = input.scenes.map((s) => ({ narration: speakable(String(s.narration ?? '')), visual: String(s.visual ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) })).filter((s) => s.narration.length > 0);
  if (scenesIn.length < 1) throw new Error('the video needs at least one scene with narration');
  if (scenesIn.length > 16) throw new Error('at most 16 scenes');
  if (fs.existsSync(input.outputDir)) throw new Error(`${input.outputDir} already exists; Pandesh never overwrites. Choose another folder.`);

  const tools = await stage('capability inventory', 'find the video tools, the voice and an image generator on this PC', async () => {
    const inv = await probeCapabilityInventory(deps);
    const ffmpeg = workingExecutable(inv, 'ffmpeg');
    const ffprobe = workingExecutable(inv, 'ffprobe');
    const piper = deps.piper !== undefined ? deps.piper : findPiper(deps.env ?? process.env);
    const comfy = inv.items.find((i) => i.id === 'comfyui');
    const comfyUp = input.visuals !== 'cards' && comfy?.status === 'working';
    return {
      ok: Boolean(ffmpeg && ffprobe && piper),
      detail: `ffmpeg ${ffmpeg ? 'working' : 'missing'}, ffprobe ${ffprobe ? 'working' : 'missing'}, Piper voice ${piper ? path.basename(piper.model, '.onnx') : 'not found'}, ComfyUI ${comfy?.status === 'working' ? 'answering' : 'not running'}`,
      value: { ffmpeg, ffprobe, piper, comfyUp, comfyUrl: comfy?.location ?? undefined },
    };
  });
  if (!tools.ffmpeg || !tools.ffprobe) throw new Error('FFmpeg/FFprobe are not working on this PC. Pandesh can install FFmpeg (winget Gyan.FFmpeg) with your approval: pc_install_utility utility="ffmpeg".');
  if (!tools.piper) throw new Error('No local voice was found: Piper is not staged next to Pandesh (runtime/piper). Narration cannot be produced on this PC yet; nothing was created.');
  const ffmpeg = tools.ffmpeg;
  const ffprobe = tools.ffprobe;
  const piper = tools.piper;

  const portrait = input.orientation === 'portrait';
  const W = portrait ? 1080 : 1920;
  const H = portrait ? 1920 : 1080;
  const slug = slugify(input.title);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-narrated-'));
  const assets = path.join(input.outputDir, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const pad2 = (n: number) => String(n + 1).padStart(2, '0');
  const duration = async (file: string) => {
    const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 20_000 });
    return Number(r.stdout.trim()) || 0;
  };

  try {
    // 2. Narration: the voice decides how long each scene lasts.
    const voiced = await stage(`piper:${path.basename(piper.model, '.onnx')}`, `narrate ${scenesIn.length} scene(s) with the local voice`, async () => {
      const out: Array<{ file: string; seconds: number }> = [];
      const errors: string[] = [];
      for (const [i, s] of scenesIn.entries()) {
        const file = path.join(assets, `narration-${pad2(i)}.wav`);
        const r = await run(piper.exe, ['--model', piper.model, '--length_scale', '1.12', '--sentence_silence', '0.45', '--output_file', file], { input: `${s.narration}\n`, timeoutMs: 120_000, signal: input.signal });
        const seconds = fs.existsSync(file) ? await duration(file) : 0;
        if (r.code !== 0 || seconds < 0.3) errors.push(`scene ${i + 1}: ${lastLine(r.stderr) || 'no audio written'}`);
        out.push({ file, seconds });
      }
      const total = out.reduce((n, o) => n + o.seconds, 0);
      return { ok: errors.length === 0, detail: errors.length ? errors.join('; ') : `${out.length} narration file(s), ${total.toFixed(1)} s of speech`, value: { out, errors } };
    });
    if (voiced.errors.length) throw new Error(`Piper could not narrate: ${voiced.errors.join('; ')}`);

    // 3. Pictures: ComfyUI when it answers, a drawn backdrop otherwise. Every scene says which.
    const style = (input.style ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    let checkpoint: string | null = null;
    let comfyUp = tools.comfyUp;
    let comfyNote = input.visuals === 'cards' ? 'backdrop cards were requested' : '';
    if (!comfyUp && input.visuals !== 'cards') {
      const woke = await stage('comfyui', 'start the local ComfyUI for the pictures', async () => {
        const w = await (deps.wakeComfy ?? ((signal) => wakeComfyUi(signal, deps.env ?? process.env)))(input.signal);
        return { ok: w.ready, detail: w.detail, value: w };
      });
      comfyUp = woke.ready;
      comfyNote = woke.ready ? woke.detail : `${woke.detail}, so FFmpeg drew plain backdrop cards`;
    }
    const pictures = await stage(comfyUp ? 'comfyui + ffmpeg' : 'ffmpeg', `make one picture per scene (${comfyUp ? 'ComfyUI, local models' : 'drawn backdrop cards'})`, async () => {
      const out: Array<{ file: string; source: 'comfyui' | 'backdrop_card'; note?: string }> = [];
      if (comfyUp) {
        try {
          checkpoint = pickCheckpoint(await listComfyCheckpoints({ baseUrl: tools.comfyUrl, signal: input.signal }));
          if (!checkpoint) comfyNote = 'ComfyUI is running but lists no image checkpoint, so FFmpeg drew plain backdrop cards';
        } catch (err) { comfyNote = `ComfyUI did not list its models (${err instanceof Error ? err.message : String(err)}), so FFmpeg drew plain backdrop cards`; }
      }
      const seedBase = crypto.randomInt(1, 2 ** 31);
      for (const [i, s] of scenesIn.entries()) {
        const file = path.join(assets, `scene-${pad2(i)}.png`);
        let note: string | undefined;
        if (checkpoint) {
          try {
            const base = comfyUiBaseUrl(tools.comfyUrl);
            const workflow = buildTextToImageWorkflow({ prompt: [s.visual || s.narration.slice(0, 200), style].filter(Boolean).join(', '), negativePrompt: NEGATIVE_PROMPT, checkpoint, width: portrait ? 768 : 1344, height: portrait ? 1344 : 768, steps: 24, cfg: 6, seed: seedBase + i });
            const id = await submitComfyWorkflow(workflow, { baseUrl: base, signal: input.signal });
            const job = await waitForComfyJob(id, { baseUrl: base, signal: input.signal, timeoutMs: 5 * 60_000 });
            if (job.state !== 'completed' || !job.outputs[0]) throw new Error(job.error ?? 'no image returned');
            fs.writeFileSync(file, await fetchComfyImage(job.outputs[0], { baseUrl: base, signal: input.signal }));
            out.push({ file, source: 'comfyui' });
            continue;
          } catch (err) {
            if (input.signal?.aborted) throw err;
            note = `ComfyUI failed for this scene (${err instanceof Error ? err.message.slice(0, 160) : String(err)}); a backdrop card was drawn instead`;
          }
        }
        const r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1`, '-frames:v', '1', '-vf', backdropFilter(`${s.visual} ${s.narration}`, W, H, i), file], { timeoutMs: 60_000, signal: input.signal });
        if (r.code !== 0 || !fs.existsSync(file)) throw new Error(`FFmpeg could not draw the backdrop for scene ${i + 1}: ${lastLine(r.stderr)}`);
        out.push({ file, source: 'backdrop_card', ...(note ? { note } : {}) });
      }
      const byComfy = out.filter((o) => o.source === 'comfyui').length;
      return { ok: true, detail: `${byComfy} picture(s) generated by ComfyUI${checkpoint ? ` (${checkpoint})` : ''}, ${out.length - byComfy} drawn backdrop card(s)${comfyNote ? `; ${comfyNote}` : ''}`, value: out };
    });

    // 4. Timing, subtitles, segments.
    const LEAD = 0.5;
    const GAP = 0.7;
    const TAIL = 1.4;
    const timeline = scenesIn.map((s, i) => {
      const lead = i === 0 ? LEAD + 0.3 : LEAD;
      const seconds = lead + voiced.out[i].seconds + (i === scenesIn.length - 1 ? TAIL : GAP);
      return { ...s, lead, seconds: Math.round(seconds * 30) / 30 };
    });
    let cursor = 0;
    const cues: Cue[] = [];
    for (const [i, t] of timeline.entries()) { cues.push(...sceneCues(t.narration, cursor + t.lead, voiced.out[i].seconds)); cursor += t.seconds; }
    const total = cursor;
    const wantSubs = input.subtitles !== false;
    fs.writeFileSync(path.join(work, 'subs.srt'), renderSrt(cues), 'utf8');

    await stage('ffmpeg', `render ${timeline.length} moving segment(s) at ${W}x${H} and join them`, async () => {
      const errors: string[] = [];
      const list: string[] = [];
      for (const [i, t] of timeline.entries()) {
        const frames = Math.round(t.seconds * 30);
        const zoom = i % 2 === 0 ? `1+0.07*on/${frames}` : `1.07-0.07*on/${frames}`;
        const vf = `scale=${Math.round(W * 1.2)}:${Math.round(H * 1.2)}:force_original_aspect_ratio=increase,crop=${Math.round(W * 1.2)}:${Math.round(H * 1.2)},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${(t.seconds - 0.5).toFixed(2)}:d=0.5`;
        const seg = `seg${i}.mp4`;
        const r = await run(ffmpeg, ['-y', '-v', 'error', '-loop', '1', '-framerate', '30', '-t', t.seconds.toFixed(3), '-i', pictures[i].file, '-vf', vf, '-t', t.seconds.toFixed(3), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-an', seg], { cwd: work, timeoutMs: 300_000, signal: input.signal });
        if (r.code !== 0) errors.push(`scene ${i + 1}: ${lastLine(r.stderr)}`); else list.push(`file '${seg}'`);
        // The voice, placed inside its segment so the join stays in step with the picture.
        const a = await run(ffmpeg, ['-y', '-v', 'error', '-i', voiced.out[i].file, '-af', `adelay=${Math.round(t.lead * 1000)}:all=1,apad=whole_dur=${t.seconds.toFixed(3)}`, '-t', t.seconds.toFixed(3), '-ar', '48000', '-ac', '2', `voice${i}.wav`], { cwd: work, timeoutMs: 60_000, signal: input.signal });
        if (a.code !== 0) errors.push(`scene ${i + 1} audio: ${lastLine(a.stderr)}`);
      }
      fs.writeFileSync(path.join(work, 'video.txt'), list.join('\n'), 'utf8');
      fs.writeFileSync(path.join(work, 'voice.txt'), timeline.map((_, i) => `file 'voice${i}.wav'`).join('\n'), 'utf8');
      const v = errors.length ? { code: 1, stderr: '', stdout: '' } : await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'video.txt', '-c', 'copy', 'video.mp4'], { cwd: work, signal: input.signal });
      const n = errors.length ? { code: 1, stderr: '', stdout: '' } : await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'voice.txt', '-c', 'copy', 'voice.wav'], { cwd: work, signal: input.signal });
      if (v.code !== 0 && !errors.length) errors.push(`join: ${lastLine(v.stderr)}`);
      if (n.code !== 0 && !errors.length) errors.push(`voice join: ${lastLine(n.stderr)}`);
      return { ok: errors.length === 0, detail: errors.length ? errors.join('; ') : `${timeline.length} segment(s), ${total.toFixed(1)} s`, value: errors };
    }).then((errors) => { if (errors.length) throw new Error(`FFmpeg could not render the video: ${errors.join('; ')}`); });

    // 5. Music bed (synthesized here, nothing licensed or downloaded), mix, subtitles, loudness.
    const wantMusic = input.music !== false;
    let musicNote: string | null = null;
    if (wantMusic) {
      await stage('ffmpeg (synthesis)', 'synthesize a quiet ambient bed under the narration', async () => {
        const d = (total + 1).toFixed(2);
        const tone = (f: number) => ['-f', 'lavfi', '-i', `sine=f=${f}:d=${d}:r=48000`];
        const r = await run(ffmpeg, ['-y', '-v', 'error', ...tone(130.81), ...tone(196.0), ...tone(261.63), ...tone(329.63), ...tone(392.0),
          '-filter_complex', `[0][1][2][3][4]amix=inputs=5:normalize=0,tremolo=f=0.12:d=0.45,lowpass=f=1100,aecho=0.8:0.7:900|1400:0.35|0.25,afade=t=in:d=2.5,afade=t=out:st=${Math.max(0, total - 2.5).toFixed(2)}:d=2.5,volume=0.10,aformat=channel_layouts=stereo`, '-t', total.toFixed(3), 'bed.wav'], { cwd: work, timeoutMs: 120_000, signal: input.signal });
        const ok = r.code === 0 && fs.existsSync(path.join(work, 'bed.wav'));
        if (ok) { fs.copyFileSync(path.join(work, 'bed.wav'), path.join(assets, 'music-bed.wav')); musicNote = 'a soft ambient pad synthesized by FFmpeg on this PC (sine tones, no samples, nothing licensed); replace it with a composed track if you want a melody'; }
        return { ok, detail: ok ? 'C major pad, mixed well below the voice' : `skipped: ${lastLine(r.stderr)}`, value: null };
      });
    }
    const videoFile = path.join(input.outputDir, `${slug}.mp4`);
    await stage('ffmpeg', `mix the voice${musicNote ? ' over the bed' : ''}${wantSubs ? ', burn in the subtitles' : ''} and normalise loudness`, async () => {
      const subs = wantSubs ? "subtitles=subs.srt:force_style='FontName=Segoe UI Semibold,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00241A12,BorderStyle=1,Outline=2,Shadow=0,MarginV=44'" : 'null';
      const audio = musicNote ? '[1:a][2:a]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]' : '[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]';
      const r = await run(ffmpeg, ['-y', '-v', 'error', '-i', 'video.mp4', '-i', 'voice.wav', ...(musicNote ? ['-i', 'bed.wav'] : []), '-filter_complex', `[0:v]${subs}[v];${audio}`, '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-t', total.toFixed(3), 'final.mp4'], { cwd: work, timeoutMs: 600_000, signal: input.signal });
      const ok = r.code === 0 && fs.existsSync(path.join(work, 'final.mp4'));
      if (ok) fs.copyFileSync(path.join(work, 'final.mp4'), videoFile, fs.constants.COPYFILE_EXCL);
      return { ok, detail: ok ? `${path.basename(videoFile)} written` : lastLine(r.stderr), value: ok };
    }).then((ok) => { if (!ok) throw new Error(`FFmpeg did not produce the video: ${steps[steps.length - 1].detail}`); });

    // 6. The rest of the package.
    const srtFile = wantSubs ? path.join(input.outputDir, `${slug}.srt`) : null;
    if (srtFile) fs.copyFileSync(path.join(work, 'subs.srt'), srtFile);
    const thumbnail = path.join(input.outputDir, 'thumbnail.png');
    await stage('ffmpeg', 'make a 1280x720 thumbnail from the first picture with the title on it', async () => {
      const font = findFont();
      if (font) fs.copyFileSync(font, path.join(work, 'font.ttf'));
      fs.writeFileSync(path.join(work, 'title.txt'), wrapTitle(input.title, 22), 'utf8');
      const text = font ? ',drawtext=fontfile=font.ttf:textfile=title.txt:fontcolor=white:fontsize=84:line_spacing=14:borderw=5:bordercolor=0x1a1430:x=(w-text_w)/2:y=h-text_h-70' : '';
      const r = await run(ffmpeg, ['-y', '-v', 'error', '-i', pictures[0].file, '-vf', `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720${text}`, '-frames:v', '1', 'thumb.png'], { cwd: work, timeoutMs: 60_000 });
      const ok = r.code === 0 && fs.existsSync(path.join(work, 'thumb.png'));
      if (ok) fs.copyFileSync(path.join(work, 'thumb.png'), thumbnail);
      return { ok, detail: ok ? 'thumbnail.png written' : lastLine(r.stderr), value: null };
    });
    const script = path.join(input.outputDir, 'script.md');
    fs.writeFileSync(script, [`# ${input.title}`, '', ...timeline.flatMap((t, i) => [`## Scene ${i + 1} (${t.seconds.toFixed(1)} s)`, '', t.narration, '', `*Picture:* ${t.visual || '(none given)'}`, ''])].join('\n'), 'utf8');
    const yt = input.youtube ?? {};
    const tags = (yt.tags ?? []).map((t) => String(t).replace(/[#,]/g, '').trim()).filter(Boolean).slice(0, 20);
    const metadata = path.join(input.outputDir, 'youtube-metadata.md');
    fs.writeFileSync(metadata, [
      '# YouTube upload sheet (prepared, NOT published)', '',
      `**Title:** ${(yt.title ?? input.title).slice(0, 100)}`, '',
      '**Description:**', '', (yt.description ?? '').trim() || 'INCOMPLETE: no description was written for this upload sheet', '',
      tags.length ? `**Tags:** ${tags.join(', ')}` : '**Tags:**\nINCOMPLETE: no tags were written for this upload sheet', '',
      `**Video file:** ${path.basename(videoFile)}`, `**Thumbnail:** thumbnail.png`, srtFile ? `**Subtitles:** ${path.basename(srtFile)} (also burned into the picture)` : '**Subtitles:** none', '',
      '**Before you upload, decide yourself:** audience setting ("made for kids" where it applies), visibility, and the AI/synthetic-content disclosure: the narration is a synthetic voice (Piper) and the pictures are ' + (pictures.some((p) => p.source === 'comfyui') ? 'AI-generated (ComfyUI)' : 'drawn backdrops (FFmpeg)') + '.', '',
      'Pandesh did not upload or publish anything.',
    ].join('\n'), 'utf8');

    // 7. Independent checks on the finished file.
    const check = await stage('ffprobe + ffmpeg', 'check the finished file: streams, size, length, audible audio, a real frame, subtitle timing', async () => {
      const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', videoFile], { timeoutMs: 30_000 });
      const j = (() => { try { return JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> }; } catch { return {}; } })();
      const v = j.streams?.find((s) => s.codec_type === 'video');
      const a = j.streams?.find((s) => s.codec_type === 'audio');
      const dur = Number(j.format?.duration ?? 0);
      const vol = await run(ffmpeg, ['-v', 'info', '-i', videoFile, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 120_000 });
      const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(vol.stderr)?.[1] ?? NaN);
      const frame = path.join(work, 'check.png');
      const g = await run(ffmpeg, ['-y', '-v', 'error', '-ss', (dur / 2).toFixed(2), '-i', videoFile, '-frames:v', '1', frame], { timeoutMs: 60_000 });
      const lastCue = cues[cues.length - 1];
      const checks = [
        { ok: v?.codec_name === 'h264', text: `video stream ${v?.codec_name ?? 'missing'} (expected h264)` },
        { ok: a?.codec_name === 'aac', text: `audio stream ${a?.codec_name ?? 'missing'} (expected aac)` },
        { ok: v?.width === W && v?.height === H, text: `picture ${v?.width}x${v?.height} (expected ${W}x${H})` },
        { ok: Math.abs(dur - total) <= 1.0, text: `length ${dur.toFixed(1)} s (planned ${total.toFixed(1)} s)` },
        { ok: Number.isFinite(mean) && mean > -45, text: `audio is audible (mean ${Number.isFinite(mean) ? mean.toFixed(1) : '?'} dB)` },
        { ok: g.code === 0 && fs.existsSync(frame) && fs.statSync(frame).size > 2000, text: `a frame at ${(dur / 2).toFixed(1)} s decodes` },
        ...(wantSubs ? [{ ok: cues.length > 0 && lastCue.end <= dur + 0.5, text: `${cues.length} subtitle cue(s), the last ends at ${lastCue?.end.toFixed(1)} s` }] : []),
      ];
      return { ok: checks.every((c) => c.ok), detail: checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.text}`).join('; '), value: { checks, dur, v } };
    });

    const bytes = fs.statSync(videoFile).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(videoFile)).digest('hex');
    const scenes: NarratedScene[] = timeline.map((t, i) => ({ index: i + 1, narration: t.narration, visual: t.visual, seconds: t.seconds, narrationFile: voiced.out[i].file, imageFile: pictures[i].file, imageSource: pictures[i].source, ...(pictures[i].note ? { imageNote: pictures[i].note } : {}) }));
    const byComfy = scenes.filter((s) => s.imageSource === 'comfyui').length;
    const withinTarget = input.targetSeconds ? check.dur >= input.targetSeconds[0] && check.dur <= input.targetSeconds[1] : null;
    const record = path.join(input.outputDir, 'production-record.json');
    const result: NarratedVideoResult = {
      folder: input.outputDir, video: videoFile, subtitles: srtFile, thumbnail, script, metadata, record,
      durationSec: check.dur, width: check.v?.width ?? 0, height: check.v?.height ?? 0, bytes, sha256, scenes,
      voice: `Piper ${path.basename(piper.model, '.onnx')} (local, synthetic)`, music: musicNote,
      visualsBy: { comfyui: byComfy, backdrop_card: scenes.length - byComfy, checkpoint, note: comfyNote },
      steps, verified: check.checks.every((c) => c.ok), verification: check.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.text}`), withinTarget,
      incomplete: [
        ...(!(yt.description ?? '').trim() ? ['the upload sheet has no description'] : []),
        ...(!tags.length ? ['the upload sheet has no tags'] : []),
        ...(byComfy < scenes.length ? [`${scenes.length - byComfy} of ${scenes.length} pictures are plain backdrops, not the scene`] : []),
      ],
    };
    fs.writeFileSync(record, JSON.stringify({ title: input.title, createdAt: new Date().toISOString(), published: false, ...result }, null, 2), 'utf8');
    return result;
  } catch (err) {
    // A failed run leaves no half-made package behind.
    try { fs.rmSync(input.outputDir, { recursive: true, force: true }); } catch { /* reported by the caller */ }
    throw err;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

export function renderNarratedVideoResult(r: NarratedVideoResult, target?: [number, number]): string {
  return [
    `${r.verified ? 'Video package created and checked' : 'Video package created but NOT fully verified'}: ${r.folder}`,
    // Read back by Core (missionRunner.toolCaveats): first and short, because only the start of a result is kept as evidence.
    ...r.incomplete.map((line) => `INCOMPLETE: ${line}`),
    'NOT VERIFIED: what the pictures show (technical checks only).',
    `Video: ${r.video} (${r.width}x${r.height}, ${r.durationSec.toFixed(1)} s, ${(r.bytes / 1e6).toFixed(1)} MB, SHA-256 ${r.sha256.slice(0, 16)}…)`,
    target ? `Length against the brief (${target[0]}-${target[1]} s): ${r.withinTarget ? 'inside the range' : `OUTSIDE the range (${r.durationSec.toFixed(1)} s); change the narration length and produce it again in a new folder`}` : null,
    r.subtitles ? `Subtitles: ${r.subtitles} (also burned in)` : 'Subtitles: none',
    `Thumbnail: ${r.thumbnail}`, `Script: ${r.script}`, `YouTube sheet (not published): ${r.metadata}`, `Production record: ${r.record}`,
    `Voice: ${r.voice}`,
    `Music: ${r.music ?? 'none'}`,
    `Pictures: ${r.visualsBy.comfyui} generated by ComfyUI${r.visualsBy.checkpoint ? ` (${r.visualsBy.checkpoint})` : ''}, ${r.visualsBy.backdrop_card} drawn backdrop card(s)${r.visualsBy.note ? `. ${r.visualsBy.note}` : ''}`,
    'Tools that ran:',
    ...r.steps.map((s) => `- ${s.tool} — ${s.purpose}: ${s.ok ? 'ok' : 'FAILED'} (${(s.ms / 1000).toFixed(1)} s) — ${s.detail}`),
    'Checks on the finished file:', ...r.verification.map((v) => `- ${v}`),
    'The checks are technical (streams, length, sound, timing): nobody has looked at whether each picture matches its scene.',
    'Nothing was uploaded or published.',
  ].filter(Boolean).join('\n');
}

export interface MediaInspection { file: string; kind: 'video' | 'audio' | 'image' | 'unknown'; facts: string[]; problems: string[]; frames: string[] }

/** Read-only facts about a media file, from FFprobe/FFmpeg: what a reviewer needs instead of the maker's word. */
export async function inspectMedia(file: string, deps: InventoryProbeDeps = {}, opts: { frames?: number; framesDir?: string } = {}): Promise<MediaInspection> {
  const inv = await probeCapabilityInventory(deps);
  const ffmpeg = workingExecutable(inv, 'ffmpeg');
  const ffprobe = workingExecutable(inv, 'ffprobe');
  if (!ffmpeg || !ffprobe) throw new Error('FFmpeg/FFprobe are not working on this PC, so the file cannot be inspected.');
  const st = fs.statSync(file);
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,format_name,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels', '-of', 'json', file], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`FFprobe cannot read ${file}: ${lastLine(r.stderr)}`);
  const j = JSON.parse(r.stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<Record<string, unknown>> };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const dur = Number(j.format?.duration ?? 0);
  const still = Boolean(v) && !a && (dur === 0 || /image2|png_pipe|jpeg_pipe|webp/.test(String(j.format?.format_name ?? '')));
  const kind: MediaInspection['kind'] = still ? 'image' : v ? 'video' : a ? 'audio' : 'unknown';
  const facts: string[] = [`${path.basename(file)}: ${kind}, ${(st.size / 1e6).toFixed(2)} MB, SHA-256 ${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)}…`];
  const problems: string[] = [];
  if (v) facts.push(`picture: ${v.codec_name} ${v.width}x${v.height}${kind === 'video' ? ` at ${String(v.r_frame_rate)} fps` : ''}`);
  if (kind !== 'image') facts.push(`length: ${dur.toFixed(1)} s`);
  if (a) {
    facts.push(`sound: ${a.codec_name}, ${a.sample_rate} Hz, ${a.channels} channel(s)`);
    const vol = await run(ffmpeg, ['-v', 'info', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 180_000 });
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(vol.stderr)?.[1] ?? NaN);
    const max = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(vol.stderr)?.[1] ?? NaN);
    if (Number.isFinite(mean)) facts.push(`loudness: mean ${mean.toFixed(1)} dB, peak ${max.toFixed(1)} dB`);
    if (!Number.isFinite(mean) || mean < -45) problems.push('the sound is silent or nearly silent');
    if (Number.isFinite(max) && max > -0.1) problems.push('the sound peaks at 0 dB and may clip');
    const sil = await run(ffmpeg, ['-v', 'info', '-i', file, '-vn', '-af', 'silencedetect=noise=-45dB:d=3', '-f', 'null', '-'], { timeoutMs: 180_000 });
    const gaps = [...sil.stderr.matchAll(/silence_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    if (gaps.length) problems.push(`${gaps.length} stretch(es) of silence longer than 3 s (longest ${Math.max(...gaps).toFixed(1)} s)`);
    else facts.push('no silent stretch longer than 3 s');
  } else if (kind === 'video') problems.push('the video has no sound stream');
  const frames: string[] = [];
  if (kind === 'video') {
    const black = await run(ffmpeg, ['-v', 'info', '-i', file, '-an', '-vf', 'blackdetect=d=1.5:pic_th=0.98', '-f', 'null', '-'], { timeoutMs: 300_000 });
    const blacks = [...black.stderr.matchAll(/black_duration:([\d.]+)/g)].map((m) => Number(m[1]));
    if (blacks.length) problems.push(`${blacks.length} black stretch(es) longer than 1.5 s (longest ${Math.max(...blacks).toFixed(1)} s)`);
    else facts.push('no black stretch longer than 1.5 s');
    const n = Math.min(4, Math.max(0, opts.frames ?? 0));
    if (n && opts.framesDir) {
      fs.mkdirSync(opts.framesDir, { recursive: true });
      for (let i = 0; i < n; i += 1) {
        const at = dur * (i + 0.5) / n;
        const out = path.join(opts.framesDir, `${path.basename(file, path.extname(file))}-frame-${i + 1}.png`);
        const g = await run(ffmpeg, ['-y', '-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=960:-2', out], { timeoutMs: 60_000 });
        if (g.code === 0 && fs.existsSync(out)) frames.push(out);
      }
      if (frames.length) facts.push(`${frames.length} frame(s) decoded at even intervals`);
      else problems.push('no frame could be decoded');
    }
  }
  return { file, kind, facts, problems, frames };
}
