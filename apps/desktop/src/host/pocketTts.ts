/**
 * Kyutai Pocket TTS as a managed, on-demand local speech engine.
 *
 * Assets are staged under productRoot/runtime/pocket-tts/ by scripts/fetch-pocket-tts.mjs
 * (pinned + sha256-verified). Generated config and logs live under dataDir/pocket-tts/.
 * The engine runs CPU-only on a loopback port, started on first use, stopped when idle.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PocketTtsManifest {
  engine: { file: string; sha256: string; version: string; licenseFile: string; licenseSha256: string };
  language: string;
  voice: string;
  assets: Array<{ path: string; sha256: string; size: number }>;
}

export interface PocketTtsResult {
  /** Complete PCM16 mono WAV with corrected RIFF sizes. */
  wav: Buffer;
  /** Engine start time paid by this request (0 when already warm). */
  startMs: number;
  /** Request sent -> first audio bytes received. */
  firstAudioMs: number;
  totalMs: number;
}

export class PocketTtsCancelled extends Error {
  constructor() {
    super('speech cancelled');
    this.name = 'PocketTtsCancelled';
  }
}

export interface PocketTtsOptions {
  productRoot: string;
  dataDir: string;
  log?: (line: string) => void;
  /** Stop the engine after this much idle time (default 10 min). */
  idleStopMs?: number;
  startTimeoutMs?: number;
  /** Test seam: override the executable and its argv builder. */
  exeOverride?: { exe: string; args: (port: number, configPath: string, voicePath: string) => string[] };
}

const MAX_TEXT_CHARS = 4000;
const WAV_HEADER_BYTES = 44;

export function pocketTtsRoot(productRoot: string): string {
  return path.join(productRoot, 'runtime', 'pocket-tts');
}

export function readPocketTtsManifest(productRoot: string): PocketTtsManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(pocketTtsRoot(productRoot), 'manifest.json'), 'utf8')) as PocketTtsManifest;
  } catch {
    return null;
  }
}

/** Cheap presence/size probe — safe to call on every snapshot. Hashes are checked at engine start. */
export function probePocketTts(productRoot: string): { ready: boolean; voice: string; blocker: string } {
  const root = pocketTtsRoot(productRoot);
  const manifest = readPocketTtsManifest(productRoot);
  const blocker = 'Pocket TTS is not staged. Run: node scripts/fetch-pocket-tts.mjs --exe-dir <folder with pocket-tts.exe>';
  if (!manifest) return { ready: false, voice: '', blocker };
  const files: Array<[string, number | null]> = [
    [path.join(root, manifest.engine.file), null],
    [path.join(root, manifest.engine.licenseFile), null],
    [path.join(root, 'NOTICE.md'), null],
    [path.join(root, 'english_18m_refl_2026-10.config.template.yaml'), null],
    ...manifest.assets.map((a): [string, number | null] => [path.join(root, manifest.language, a.path), a.size]),
  ];
  for (const [file, size] of files) {
    try {
      const stat = fs.statSync(file);
      if (size !== null && stat.size !== size) return { ready: false, voice: '', blocker: `${path.basename(file)} has the wrong size; re-run fetch-pocket-tts.mjs.` };
    } catch {
      return { ready: false, voice: '', blocker };
    }
  }
  return { ready: true, voice: manifest.voice, blocker: '' };
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Streamed WAV carries placeholder sizes; make the buffer a well-formed file. */
export function finalizeStreamedWav(buf: Buffer): Buffer {
  if (buf.length < WAV_HEADER_BYTES || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 36, 40) !== 'data') {
    throw new Error('Pocket TTS returned a response that is not a WAV stream');
  }
  const out = Buffer.from(buf);
  const dataBytes = (out.length - WAV_HEADER_BYTES) & ~1;
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(dataBytes, 40);
  return dataBytes === out.length - WAV_HEADER_BYTES ? out : out.subarray(0, WAV_HEADER_BYTES + dataBytes);
}

export class PocketTtsEngine {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private verifiedKey = '';
  private queueTail: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail: string[] = [];
  private disposed = false;
  private generation = 0;
  /** Aborts the in-flight HTTP request when a newer request or stop supersedes it. */
  private activeAbort: AbortController | null = null;
  starts = 0;

  constructor(private readonly options: PocketTtsOptions) {}

  private log(line: string): void {
    this.options.log?.(`[pocket-tts] ${line}`);
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Cancel in-flight and queued speech. Does not stop the engine. */
  cancel(): void {
    this.generation += 1;
    this.activeAbort?.abort();
  }

  /**
   * Speak sequentially: a new request supersedes anything still queued or running.
   * Rejects with PocketTtsCancelled if superseded before audio is complete.
   */
  synthesize(text: string, signal?: AbortSignal): Promise<PocketTtsResult> {
    this.cancel();
    const generation = this.generation;
    const run = async (): Promise<PocketTtsResult> => {
      if (generation !== this.generation || signal?.aborted || this.disposed) throw new PocketTtsCancelled();
      const abort = new AbortController();
      this.activeAbort = abort;
      const onExternalAbort = () => abort.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        return await this.synthesizeOnce(text, abort.signal, generation, true);
      } finally {
        signal?.removeEventListener('abort', onExternalAbort);
        if (this.activeAbort === abort) this.activeAbort = null;
      }
    };
    const result = this.queueTail.then(run, run);
    this.queueTail = result.catch(() => undefined);
    return result;
  }

  private async synthesizeOnce(
    rawText: string,
    signal: AbortSignal,
    generation: number,
    allowRestart: boolean,
  ): Promise<PocketTtsResult> {
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
    if (!text) throw new Error('speech text is required');
    this.clearIdleTimer();
    const requestStart = Date.now();
    try {
      await this.ensureRunning(signal);
      const startMs = Date.now() - requestStart;
      const sentAt = Date.now();
      const form = new FormData();
      form.append('text', text);
      const res = await fetch(`http://127.0.0.1:${this.port}/tts`, { method: 'POST', body: form, signal });
      if (!res.ok || !res.body) throw new Error(`Pocket TTS /tts returned HTTP ${res.status}`);
      const chunks: Buffer[] = [];
      let firstAudioMs = -1;
      let received = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
        // The server flushes the WAV header immediately; first audio is the first PCM byte after it.
        if (firstAudioMs < 0 && received > WAV_HEADER_BYTES) firstAudioMs = Date.now() - sentAt;
        chunks.push(Buffer.from(chunk));
      }
      if (generation !== this.generation) throw new PocketTtsCancelled();
      return { wav: finalizeStreamedWav(Buffer.concat(chunks)), startMs, firstAudioMs, totalMs: Date.now() - sentAt };
    } catch (err) {
      if (signal.aborted || generation !== this.generation || err instanceof PocketTtsCancelled) throw new PocketTtsCancelled();
      // Engine died or hung up mid-request: recover once with a fresh process.
      if (allowRestart) {
        this.log(`request failed (${(err as Error).message}); restarting engine`);
        await this.stop();
        return this.synthesizeOnce(rawText, signal, generation, false);
      }
      throw err;
    } finally {
      this.armIdleTimer();
    }
  }

  private async ensureRunning(signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('Pocket TTS engine is disposed');
    if (this.running && !this.starting) return;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    await this.starting;
    if (signal.aborted) throw new PocketTtsCancelled();
  }

  private async verifyAssets(): Promise<{ exe: string; config: string; voice: string }> {
    const { productRoot, dataDir } = this.options;
    const root = pocketTtsRoot(productRoot);
    const manifest = readPocketTtsManifest(productRoot);
    if (!manifest) throw new Error(probePocketTts(productRoot).blocker);
    const exe = path.join(root, manifest.engine.file);
    const assetsDir = path.join(root, manifest.language);
    const targets: Array<[string, string]> = [
      [exe, manifest.engine.sha256],
      [path.join(root, manifest.engine.licenseFile), manifest.engine.licenseSha256],
      ...manifest.assets.map((a): [string, string] => [path.join(assetsDir, a.path), a.sha256]),
    ];
    // Hash each file once per (path,size,mtime) so restarts stay fast.
    const key = targets.map(([f]) => { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');
    if (key !== this.verifiedKey) {
      for (const [file, sha] of targets) {
        if ((await sha256File(file)) !== sha) throw new Error(`Pocket TTS asset failed checksum: ${path.basename(file)}`);
      }
      this.verifiedKey = key;
    }
    const outDir = path.join(dataDir, 'pocket-tts');
    fs.mkdirSync(outDir, { recursive: true });
    const template = fs.readFileSync(path.join(root, 'english_18m_refl_2026-10.config.template.yaml'), 'utf8');
    const config = path.join(outDir, 'config.yaml');
    fs.writeFileSync(config, template.replaceAll('{{ASSETS}}', assetsDir.replaceAll('\\', '/')), 'utf8');
    return { exe, config, voice: path.join(assetsDir, `${manifest.voice}.safetensors`) };
  }

  private async start(): Promise<void> {
    const timeoutMs = this.options.startTimeoutMs ?? 45_000;
    const begin = Date.now();
    const assets = this.options.exeOverride ? { exe: this.options.exeOverride.exe, config: '', voice: '' } : await this.verifyAssets();
    let lastErr: Error = new Error('Pocket TTS failed to start');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const port = await freeLoopbackPort();
      const args = this.options.exeOverride
        ? this.options.exeOverride.args(port, assets.config, assets.voice)
        : ['serve', '--host', '127.0.0.1', '--port', String(port), '--config', assets.config.replaceAll('\\', '/'), '--default-voice', assets.voice.replaceAll('\\', '/')];
      this.stderrTail = [];
      const child = spawn(assets.exe, args, {
        cwd: path.join(this.options.dataDir, 'pocket-tts'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Offline + CPU-only: never touch the network or a GPU, so Qwen keeps the card.
        env: { ...process.env, HF_HUB_OFFLINE: '1', CUDA_VISIBLE_DEVICES: '' },
      });
      this.child = child;
      this.port = port;
      const onLine = (buf: Buffer) => {
        for (const line of buf.toString('utf8').split(/\r?\n/).filter(Boolean)) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        }
      };
      child.stdout?.on('data', onLine);
      child.stderr?.on('data', onLine);
      child.once('exit', (code) => {
        if (this.child === child) {
          this.log(`engine exited code=${code}`);
          this.child = null;
        }
      });
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch { /* best effort */ }
      try {
        await this.waitReady(child, port, begin + timeoutMs);
        this.starts += 1;
        this.log(`ready pid=${child.pid} port=${port} in ${Date.now() - begin}ms`);
        return;
      } catch (err) {
        lastErr = err as Error;
        this.log(`start attempt ${attempt} failed: ${lastErr.message}`);
        await this.stop();
        if (Date.now() > begin + timeoutMs) break;
      }
    }
    throw lastErr;
  }

  private async waitReady(child: ChildProcess, port: number, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Pocket TTS exited during startup (code ${child.exitCode}): ${this.stderrTail.slice(-3).join(' | ')}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch { /* not listening yet */ }
      await sleep(100);
    }
    throw new Error('Pocket TTS did not become ready in time');
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || !child.pid) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
    await Promise.race([exited, sleep(3000)]);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await this.stop();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const idle = this.options.idleStopMs ?? 10 * 60_000;
    this.idleTimer = setTimeout(() => {
      this.log('idle; stopping engine');
      void this.stop();
    }, idle);
    this.idleTimer.unref();
  }
}
