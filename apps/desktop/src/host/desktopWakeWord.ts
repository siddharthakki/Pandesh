/**
 * openWakeWord “hey_jarvis” for Jarvis Desktop.
 * Inference runs in a Node child (wake-word-worker.mjs) so onnxruntime-node
 * is not loaded inside Electron (avoids ERR_WORKER_PATH blob workers).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { LocalProcessingCapability } from '../../../../core/shared/wireTypes';

export interface DesktopWakeWordStatus {
  capability: LocalProcessingCapability;
  engine: string | null;
  blocker: string;
  phrase: string;
  enabled: boolean;
  muted: boolean;
}

export interface WakeWordPredictResult {
  score: number;
  detected: boolean;
  at: string;
  detectMs?: number;
}

const PHRASE = 'Hey Jarvis';
const MODEL_FILES = [
  'hey_jarvis_v0.1.onnx',
  'melspectrogram.onnx',
  'embedding_model.onnx',
] as const;

const WAKE_BLOCKER = [
  'openWakeWord hey_jarvis models are not staged.',
  'Run: node scripts/fetch-openwakeword-models.mjs',
  'Expected files under models/openwakeword/.',
].join(' ');

export function openWakeWordModelDir(productRoot: string): string {
  return path.join(productRoot, 'models', 'openwakeword');
}

function resolveWorkerScript(productRoot: string): string {
  const candidates = [
    path.join(productRoot, 'runtime', 'wake-word-worker.mjs'),
    // Dev: apps/desktop/out → apps/desktop/scripts
    path.join(__dirname, '..', 'scripts', 'wake-word-worker.mjs'),
    // Repo checkout fallback
    path.join(productRoot, 'apps', 'desktop', 'scripts', 'wake-word-worker.mjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolveNodeBinary(productRoot: string): string {
  const bundled = path.join(productRoot, 'runtime', 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  const configured = process.env.KARKEDIKHA_DESKTOP_NODE?.trim();
  if (configured && fs.existsSync(configured)) return configured;
  // Electron's process.execPath is electron.exe — wake worker needs real Node.
  if (!/electron/i.test(process.execPath)) return process.execPath;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

export function probeDesktopWakeWord(
  productRoot: string,
  opts: { enabled?: boolean; muted?: boolean } = {},
): DesktopWakeWordStatus {
  const dir = openWakeWordModelDir(productRoot);
  const missing = MODEL_FILES.filter((name) => !fs.existsSync(path.join(dir, name)));
  if (missing.length > 0) {
    return {
      capability: 'unavailable_no_local_engine',
      engine: null,
      blocker: `${WAKE_BLOCKER} Missing: ${missing.join(', ')}.`,
      phrase: PHRASE,
      enabled: false,
      muted: Boolean(opts.muted),
    };
  }
  const worker = resolveWorkerScript(productRoot);
  if (!fs.existsSync(worker)) {
    return {
      capability: 'unavailable_no_local_engine',
      engine: null,
      blocker: `Wake worker script missing (expected under runtime/ or apps/desktop/scripts/).`,
      phrase: PHRASE,
      enabled: false,
      muted: Boolean(opts.muted),
    };
  }
  return {
    capability: 'available',
    engine: 'openWakeWord hey_jarvis_v0.1 (Node child ONNX)',
    blocker: '',
    phrase: PHRASE,
    enabled: Boolean(opts.enabled),
    muted: Boolean(opts.muted),
  };
}

export class OpenWakeWordEngine {
  private child: ReturnType<typeof spawn> | null = null;
  private buffer = '';
  private pending: Array<{
    resolve: (value: WakeWordPredictResult) => void;
    reject: (err: Error) => void;
  }> = [];
  private ready = false;
  private readonly productRoot: string;

  private constructor(productRoot: string) {
    this.productRoot = productRoot;
  }

  static async create(productRoot: string): Promise<OpenWakeWordEngine> {
    const probe = probeDesktopWakeWord(productRoot);
    if (probe.capability !== 'available') {
      throw new Error(probe.blocker || 'wake word unavailable');
    }
    const engine = new OpenWakeWordEngine(productRoot);
    await engine.start();
    return engine;
  }

  private start(): Promise<void> {
    const worker = resolveWorkerScript(this.productRoot);
    const nodePath = resolveNodeBinary(this.productRoot);

    // Isolate NODE_PATH so ASR's onnxruntime-node WASM shim cannot win.
    const env: NodeJS.ProcessEnv = { ...process.env, KARKEDIKHA_DESKTOP_PRODUCT_ROOT: this.productRoot };
    const wakeMods = path.join(this.productRoot, 'runtime', 'wake-node_modules');
    if (fs.existsSync(wakeMods)) {
      env.NODE_PATH = wakeMods;
    } else {
      delete env.NODE_PATH;
    }

    this.child = spawn(nodePath, [worker], {
      cwd: this.productRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    this.child.stdout?.on('data', (chunk) => {
      this.buffer += String(chunk);
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.ready) {
          this.ready = true;
          continue;
        }
        const waiter = this.pending.shift();
        if (!waiter) continue;
        if (msg.error) {
          waiter.reject(new Error(String(msg.error)));
          continue;
        }
        if (msg.reset) {
          waiter.resolve({ score: 0, detected: false, at: new Date().toISOString() });
          continue;
        }
        waiter.resolve({
          score: Number(msg.score ?? 0),
          detected: Boolean(msg.detected),
          at: String(msg.at ?? new Date().toISOString()),
          detectMs: typeof msg.detectMs === 'number' ? msg.detectMs : undefined,
        });
      }
    });

    this.child.on('exit', (code) => {
      this.ready = false;
      while (this.pending.length) {
        this.pending.shift()?.reject(new Error(`wake worker exited (${code})`));
      }
    });

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 90_000;
      const tick = () => {
        if (this.ready) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('wake worker failed to become ready'));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  reset(): void {
    this.request({ reset: true }).catch(() => undefined);
  }

  dispose(): void {
    try { this.child?.stdin?.end(); } catch { /* ignore */ }
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
    this.ready = false;
  }

  private request(payload: Record<string, unknown>): Promise<WakeWordPredictResult> {
    if (!this.child?.stdin) return Promise.reject(new Error('wake worker not running'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child!.stdin!.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async pushInt16(pcm: Int16Array): Promise<WakeWordPredictResult> {
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return this.request({ pcmBase64: bytes.toString('base64') });
  }
}
