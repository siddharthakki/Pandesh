/**
 * Media production: "create a promotional video from these pictures".
 *
 * One workflow across several real tools, each chosen from the live capability inventory:
 *   1. the inventory confirms FFmpeg/FFprobe work (and offers a vetted install when they do not),
 *   2. FFprobe inspects every input and drops anything that is not a readable picture,
 *   3. a local vision model (Ollama) writes a short caption per picture — locally; pictures never leave the PC,
 *   4. FFmpeg renders a title card and one captioned segment per picture, then joins them,
 *   5. FFprobe and a frame grab verify the result independently: codec, resolution, duration, a real frame, SHA-256.
 * The deliverable is reported with every tool that ran and what it proved.
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { DEFAULT_OLLAMA_URL } from './modelBackend';
import { probeCapabilityInventory, workingExecutable, type InventoryProbeDeps } from './capabilityInventory';
import { nowIso } from '../domain/ids';

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i;
const MAX_IMAGES = 40;

export interface ToolStep { tool: string; purpose: string; ok: boolean; detail: string; ms: number }

export interface VideoResult {
  output: string;
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  bytes: number;
  sha256: string;
  thumbnail: string;
  captions: Array<{ image: string; caption: string; source: 'vision_model' | 'given' | 'file_name' }>;
  skipped: Array<{ image: string; why: string }>;
  steps: ToolStep[];
  verified: boolean;
  verification: string[];
}

function run(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function timed<T>(steps: ToolStep[], tool: string, purpose: string, fn: () => Promise<{ ok: boolean; detail: string; value: T }>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  steps.push({ tool, purpose, ok: r.ok, detail: r.detail, ms: Date.now() - t });
  return r.value;
}

function findFont(): string | null {
  for (const f of ['C:\\Windows\\Fonts\\segoeuib.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']) if (fs.existsSync(f)) return f;
  return null;
}

/** Wraps a caption to at most two lines that fit the frame. */
function wrapCaption(text: string, maxChars = 34): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [''];
  for (const w of words) {
    if ((lines[lines.length - 1] + ' ' + w).trim().length > maxChars && lines.length < 2) lines.push(w);
    else lines[lines.length - 1] = `${lines[lines.length - 1]} ${w}`.trim();
  }
  return lines.join('\n');
}

export function cleanCaption(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^["'“”\s*#-]+|["'“”\s*]+$/g, '').split(/\r?\n/)[0].replace(/^caption:\s*/i, '').replace(/[^\p{L}\p{N}\s&!,.'’€-]/gu, '').trim().slice(0, 70);
}

async function captionWithVision(model: string, thumbJpeg: Buffer, brief: string, ollamaUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model, stream: false, think: false, options: { temperature: 0.4, num_predict: 40, num_ctx: 4096 },
        messages: [{ role: 'user', content: `You write captions for a short promotional video${brief ? ` about: ${brief}` : ''}. Look at this picture and reply with ONE appealing caption of at most 7 words describing what is shown. No quotes, no hashtags, no emojis.`, images: [thumbJpeg.toString('base64')] }],
      }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { message?: { content?: string } };
    const c = cleanCaption(body.message?.content ?? '');
    return c.length >= 3 ? c : null;
  } catch { return null; }
}

export interface CreateVideoInput {
  images: string[];
  output: string;
  title?: string;
  brief?: string;
  secondsPerImage?: number;
  captions?: 'auto' | 'none' | string[];
  width?: number;
  height?: number;
  visionModel?: string;
  /** 'contain' (default) letterboxes each picture; 'cover' fills the frame and crops the overflow (vertical reels). */
  fit?: 'contain' | 'cover';
  /** Called as each stage starts, for progress shown while it runs. */
  onStage?: (stage: string) => void;
  /** false: the first picture is visible from the very first frame (no fade in from black), so a paused player shows it. */
  fadeFromBlack?: boolean;
}

/** The pictures in a folder, or the given files, in name order. */
export function resolveImages(inputs: string[]): string[] {
  const out: string[] = [];
  for (const raw of inputs) {
    const p = path.resolve(raw.trim());
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) for (const f of fs.readdirSync(p).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) { if (IMAGE_EXT.test(f)) out.push(path.join(p, f)); }
      else if (st.isFile()) out.push(p);
    } catch { /* reported as skipped by the caller when nothing resolves */ }
  }
  return [...new Set(out)].slice(0, MAX_IMAGES);
}

export async function createPromoVideo(input: CreateVideoInput, deps: InventoryProbeDeps = {}): Promise<VideoResult> {
  const steps: ToolStep[] = [];
  const timedStage = <T>(list: ToolStep[], tool: string, purpose: string, fn: () => Promise<{ ok: boolean; detail: string; value: T }>): Promise<T> => {
    input.onStage?.(purpose.charAt(0).toUpperCase() + purpose.slice(1));
    return timed(list, tool, purpose, fn);
  };
  const inv = await timedStage(steps, 'capability inventory', 'find working video tools and a local vision model', async () => {
    const i = await probeCapabilityInventory(deps);
    const ffmpeg = workingExecutable(i, 'ffmpeg');
    const ffprobe = workingExecutable(i, 'ffprobe');
    const vision = i.items.filter((m) => m.id.startsWith('ollama:') && m.provides.includes('vision_model')).map((m) => m.label);
    return { ok: Boolean(ffmpeg && ffprobe), detail: `ffmpeg ${ffmpeg ? 'working' : 'missing'}, ffprobe ${ffprobe ? 'working' : 'missing'}, vision models: ${vision.join(', ') || 'none'}`, value: { ffmpeg, ffprobe, vision } };
  });
  if (!inv.ffmpeg || !inv.ffprobe) throw new Error('FFmpeg/FFprobe are not working on this PC. Pandesh can install FFmpeg (winget Gyan.FFmpeg) with your approval: pc_install_utility utility="ffmpeg".');
  const W = Math.min(3840, Math.max(320, Math.trunc(input.width ?? 1280))) & ~1;
  const H = Math.min(2160, Math.max(240, Math.trunc(input.height ?? 720))) & ~1;
  const seconds = Math.min(10, Math.max(1.5, Number(input.secondsPerImage ?? 3)));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-video-'));
  const font = findFont();
  if (font) fs.copyFileSync(font, path.join(work, 'font.ttf'));
  const skipped: VideoResult['skipped'] = [];

  const usable = await timedStage(steps, 'ffprobe', 'inspect each input and keep only readable pictures', async () => {
    const keep: Array<{ image: string; w: number; h: number }> = [];
    for (const img of input.images) {
      const r = await run(inv.ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', img], { timeoutMs: 20_000 });
      const s = (() => { try { return (JSON.parse(r.stdout) as { streams?: Array<{ width?: number; height?: number; codec_name?: string }> }).streams?.[0]; } catch { return undefined; } })();
      if (r.code === 0 && s?.width && s?.height) keep.push({ image: img, w: s.width, h: s.height });
      else skipped.push({ image: img, why: 'not a readable picture' });
    }
    return { ok: keep.length > 0, detail: `${keep.length} usable picture(s), ${skipped.length} skipped`, value: keep };
  });
  if (!usable.length) throw new Error('none of the inputs is a readable picture');

  const model = input.visionModel ?? inv.vision.find((m) => /qwen2\.5vl|llava|vision|gemma3/i.test(m)) ?? inv.vision[0] ?? null;
  const ollamaUrl = deps.ollamaUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  const captions = await timedStage(steps, model && input.captions === 'auto' ? `ollama:${model}` : 'captions', 'write one caption per picture locally', async () => {
    const out: VideoResult['captions'] = [];
    for (const [i, u] of usable.entries()) {
      const given = Array.isArray(input.captions) ? input.captions[i] : undefined;
      if (given) { out.push({ image: u.image, caption: cleanCaption(given), source: 'given' }); continue; }
      if (input.captions === 'none') { out.push({ image: u.image, caption: '', source: 'given' }); continue; }
      let caption: string | null = null;
      if (model && input.captions !== undefined && input.captions === 'auto') {
        const thumb = path.join(work, `thumb${i}.jpg`);
        const t = await run(inv.ffmpeg!, ['-y', '-v', 'error', '-i', u.image, '-vf', 'scale=512:-2', '-frames:v', '1', thumb], { timeoutMs: 30_000 });
        if (t.code === 0 && fs.existsSync(thumb)) caption = await captionWithVision(model, fs.readFileSync(thumb), input.brief ?? input.title ?? '', ollamaUrl);
      }
      out.push(caption ? { image: u.image, caption, source: 'vision_model' } : { image: u.image, caption: path.basename(u.image, path.extname(u.image)).replace(/[_-]+/g, ' ').replace(/\b\d+\b/g, '').trim().slice(0, 50), source: 'file_name' });
    }
    const byModel = out.filter((c) => c.source === 'vision_model').length;
    return { ok: true, detail: model && input.captions === 'auto' ? `${byModel}/${out.length} captions written by ${model} (locally); ${out.length - byModel} from file names` : 'captions given or disabled', value: out };
  });

  const segments: string[] = [];
  await timedStage(steps, 'ffmpeg', `render a title card and ${usable.length} captioned ${seconds}s segment(s) at ${W}x${H}`, async () => {
    const text = (file: string, value: string) => { fs.writeFileSync(path.join(work, file), value, 'utf8'); return file; };
    const draw = (file: string, size: number, y: string) => font ? `,drawtext=fontfile=font.ttf:textfile=${file}:fontcolor=white:fontsize=${size}:line_spacing=10:box=1:boxcolor=black@0.5:boxborderw=22:x=(w-text_w)/2:y=${y}` : '';
    const fade = (d: number, fadeIn = true) => `${fadeIn ? ',fade=t=in:st=0:d=0.4' : ''},fade=t=out:st=${(d - 0.4).toFixed(2)}:d=0.4`;
    const enc = ['-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an'];
    const errors: string[] = [];
    if (input.title) {
      const t = await run(inv.ffmpeg!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x1d2b3a:s=${W}x${H}:d=2.5`, '-vf', `format=yuv420p${draw(text('title.txt', wrapCaption(input.title, 28)), Math.round(H / 9), '(h-text_h)/2')}${fade(2.5)}`, '-t', '2.5', ...enc, 'seg_title.mp4'], { cwd: work });
      if (t.code === 0) segments.push('seg_title.mp4'); else errors.push(`title card: ${t.stderr.trim().split('\n').pop()}`);
    }
    for (const [i, u] of usable.entries()) {
      const cap = captions[i]?.caption ? draw(text(`cap${i}.txt`, wrapCaption(captions[i].caption)), Math.round(H / 15), `h-text_h-${Math.round(H / 12)}`) : '';
      const frame = input.fit === 'cover'
        ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
        : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
      const vf = `${frame},setsar=1,format=yuv420p${cap}${fade(seconds, !(i === 0 && !input.title && input.fadeFromBlack === false))}`;
      const r = await run(inv.ffmpeg!, ['-y', '-v', 'error', '-loop', '1', '-t', String(seconds), '-i', u.image, '-vf', vf, '-t', String(seconds), ...enc, `seg${i}.mp4`], { cwd: work });
      if (r.code === 0) segments.push(`seg${i}.mp4`); else { errors.push(`${path.basename(u.image)}: ${r.stderr.trim().split('\n').pop()}`); skipped.push({ image: u.image, why: 'FFmpeg could not render it' }); }
    }
    fs.writeFileSync(path.join(work, 'list.txt'), segments.map((s) => `file '${s}'`).join('\n'), 'utf8');
    fs.mkdirSync(path.dirname(input.output), { recursive: true });
    const tmpOut = path.join(work, 'out.mp4');
    const c = segments.length ? await run(inv.ffmpeg!, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', tmpOut], { cwd: work }) : { code: 1, stderr: 'no segments', stdout: '' };
    if (c.code === 0) fs.copyFileSync(tmpOut, input.output, fs.constants.COPYFILE_EXCL);
    return { ok: c.code === 0, detail: `${segments.length} segment(s) joined into ${path.basename(input.output)}${errors.length ? `; errors: ${errors.join('; ')}` : ''}`, value: null };
  });
  if (!fs.existsSync(input.output)) throw new Error(`FFmpeg did not produce the video: ${steps[steps.length - 1].detail}`);

  const expected = (input.title ? 2.5 : 0) + segments.filter((s) => s !== 'seg_title.mp4').length * seconds;
  const thumbnail = input.output.replace(/\.mp4$/i, '') + '.preview.png';
  const verify = await timedStage(steps, 'ffprobe + ffmpeg frame grab', 'verify codec, resolution, duration and a real frame independently', async () => {
    const r = await run(inv.ffprobe!, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,nb_frames', '-select_streams', 'v:0', '-of', 'json', input.output], { timeoutMs: 30_000 });
    const j = (() => { try { return JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_name?: string; width?: number; height?: number; nb_frames?: string }> }; } catch { return {}; } })();
    const s = j.streams?.[0];
    const duration = Number(j.format?.duration ?? 0);
    const mid = Math.max(0.5, duration / 2);
    const g = await run(inv.ffmpeg!, ['-y', '-v', 'error', '-ss', mid.toFixed(2), '-i', input.output, '-frames:v', '1', thumbnail], { timeoutMs: 30_000 });
    const checks = [
      { ok: s?.codec_name === 'h264', text: `codec ${s?.codec_name ?? 'unknown'} (expected h264)` },
      { ok: s?.width === W && s?.height === H, text: `resolution ${s?.width}x${s?.height} (expected ${W}x${H})` },
      { ok: Math.abs(duration - expected) <= 1.0, text: `duration ${duration.toFixed(1)} s (expected ${expected.toFixed(1)} s)` },
      { ok: g.code === 0 && fs.existsSync(thumbnail) && fs.statSync(thumbnail).size > 1000, text: `frame at ${mid.toFixed(1)} s extracted to ${path.basename(thumbnail)}` },
    ];
    return { ok: checks.every((c) => c.ok), detail: checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.text}`).join('; '), value: { checks, duration, s } };
  });
  const bytes = fs.statSync(input.output).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(input.output)).digest('hex');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
  return {
    output: input.output, durationSec: verify.duration, width: verify.s?.width ?? 0, height: verify.s?.height ?? 0, codec: verify.s?.codec_name ?? 'unknown', bytes, sha256,
    thumbnail, captions, skipped, steps, verified: verify.checks.every((c) => c.ok), verification: verify.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.text}`),
  };
}

export function renderVideoResult(r: VideoResult): string {
  return [
    `${r.verified ? 'Video created and verified' : 'Video created but NOT fully verified'}: ${r.output}`,
    `${r.width}x${r.height} ${r.codec}, ${r.durationSec.toFixed(1)} s, ${(r.bytes / 1e6).toFixed(1)} MB, SHA-256 ${r.sha256.slice(0, 16)}…; preview frame ${r.thumbnail}`,
    'Tools that ran:',
    ...r.steps.map((s) => `- ${s.tool} — ${s.purpose}: ${s.ok ? 'ok' : 'FAILED'} (${(s.ms / 1000).toFixed(1)} s) — ${s.detail}`),
    'Captions:', ...r.captions.map((c) => `- ${path.basename(c.image)}: "${c.caption}" (${c.source.replace('_', ' ')})`),
    ...(r.skipped.length ? ['Skipped:', ...r.skipped.map((s) => `- ${path.basename(s.image)}: ${s.why}`)] : []),
    'Verification:', ...r.verification.map((v) => `- ${v}`),
  ].join('\n');
}

export function defaultVideoOutput(images: string[]): string {
  const dir = images.length ? path.dirname(images[0]) : path.join(os.homedir(), 'Videos');
  return path.join(dir, `promo-${nowIso().slice(0, 19).replace(/[:T]/g, '-')}.mp4`);
}

export function createMediaProductionAdapter(deps: InventoryProbeDeps = {}): GovernedCapabilityAdapter {
  const list = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? [v] : [];
  return {
    id: 'media-production',
    definitions: () => [{
      name: 'media_create_video',
      description: 'Create a promotional video from pictures: checks the installed tools, inspects the pictures (FFprobe), captions each one with a local vision model (pictures never leave the PC), renders a title card and captioned segments (FFmpeg), and verifies the result (codec, resolution, duration, a real frame, SHA-256). Writes one new .mp4 (never overwrites); needs approval showing the output path.',
      parameters: {
        type: 'object',
        properties: {
          images: { type: 'array', items: { type: 'string' }, description: 'A folder of pictures or picture files.' },
          output: { type: 'string', description: 'Where to write the .mp4 (default: next to the pictures).' },
          title: { type: 'string' }, brief: { type: 'string', description: 'What the video promotes, for the captions.' },
          secondsPerImage: { type: 'number' }, captions: { description: '"auto" (local vision model), "none", or a list of captions.' },
          width: { type: 'number' }, height: { type: 'number' },
        },
        required: ['images'],
      },
    }],
    classify: () => 'consequential',
    health: () => ({ state: 'available', checkedAt: nowIso() }),
    async prepare(_toolName, args) {
      const images = resolveImages(list(args.images));
      const output = typeof args.output === 'string' && args.output.trim() ? path.resolve(args.output) : defaultVideoOutput(images);
      return { ...args, output, pictures: images.length, firstPictures: images.slice(0, 4).map((i) => path.basename(i)), captions: args.captions ?? 'auto', localOnly: 'pictures are processed on this PC only' };
    },
    async run(call: ModelToolCall): Promise<ToolExecutionResult> {
      const a = call.arguments ?? {};
      const images = resolveImages(list(a.images));
      if (!images.length) return { status: 'failed', exitCode: null, output: 'No pictures found at the given paths.', resultCategory: 'media_no_inputs' };
      const output = typeof a.output === 'string' && a.output.trim() ? path.resolve(a.output) : defaultVideoOutput(images);
      if (fs.existsSync(output)) return { status: 'failed', exitCode: null, output: `${output} already exists; Pandesh never overwrites a file. Choose another output name.`, resultCategory: 'media_output_exists' };
      try {
        const r = await createPromoVideo({
          images, output, title: typeof a.title === 'string' ? a.title : undefined, brief: typeof a.brief === 'string' ? a.brief : undefined,
          secondsPerImage: Number(a.secondsPerImage) || undefined, captions: Array.isArray(a.captions) ? a.captions.map(String) : a.captions === 'none' ? 'none' : 'auto',
          width: Number(a.width) || undefined, height: Number(a.height) || undefined,
        }, deps);
        return { status: r.verified ? 'succeeded' : 'failed', exitCode: r.verified ? 0 : 1, output: renderVideoResult(r), resultCategory: r.verified ? 'media_video_verified' : 'media_video_unverified' };
      } catch (err) {
        return { status: 'failed', exitCode: null, output: err instanceof Error ? err.message : String(err), resultCategory: 'media_failed' };
      }
    },
  };
}
