/**
 * Node child for openWakeWord inference (avoids Electron worker/blob limits).
 * Protocol: one JSON line in { "pcmBase64": "..." } → one JSON line out.
 *
 * Must use the real native onnxruntime-node — never the ASR WASM shim under
 * runtime-assets/node_modules/onnxruntime-node (that re-exports onnxruntime-web
 * and blows up with ERR_WORKER_PATH on blob workers).
 *
 * Streaming math mirrors openWakeWord AudioFeatures._streaming_features
 * (Python negative-index mel slices). A prior JS bug used
 * `melBuf.length - 76 + ndx` when ndx === length, which never yielded 76
 * frames — featureBuf stayed empty and every score was 0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WAKE_SCORE_THRESHOLD } from './wakeThreshold.mjs';

const require = createRequire(import.meta.url);
const productRoot = process.env.KARKEDIKHA_DESKTOP_PRODUCT_ROOT || process.cwd();
const modelDir = path.join(productRoot, 'models', 'openwakeword');

function isNativeOrtPackage(pkgDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (String(meta.version || '').includes('wasm-shim')) return false;
    return fs.existsSync(path.join(pkgDir, 'bin', 'napi-v3'));
  } catch {
    return false;
  }
}

function resolveOrt() {
  const candidates = [
    path.join(productRoot, 'runtime', 'wake-node_modules', 'onnxruntime-node'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../node_modules/onnxruntime-node'),
    path.join(productRoot, 'node_modules', 'onnxruntime-node'),
  ];
  const errors = [];
  for (const c of candidates) {
    if (!isNativeOrtPackage(c)) continue;
    try {
      return require(c);
    } catch (err) {
      errors.push(`${c}: ${err?.message || err}`);
    }
  }
  throw new Error(
    `native onnxruntime-node not found for wake worker. Tried: ${candidates.join('; ')}. ${errors.join(' | ')}`,
  );
}

const FRAME = 1280;
/** Tuned for desktop mic consistency; was 0.5 (openWakeWord default). */
const THRESHOLD = WAKE_SCORE_THRESHOLD;

/**
 * Python-style slice of mel frames: buffer[-76+ndx : ndx] with ndx possibly negative,
 * or ndx === length for the "0 → len" openWakeWord case.
 */
export function sliceMelWindow(melFrames, ndx) {
  const len = melFrames.length;
  let end = ndx === 0 ? len : ndx;
  if (end === 0) end = len;
  const start = end - 76;
  const s = start < 0 ? len + start : start;
  const e = end < 0 ? len + end : end;
  if (e - s !== 76 || s < 0 || e > len) return null;
  return melFrames.slice(s, e);
}

const ort = resolveOrt();
const mel = await ort.InferenceSession.create(path.join(modelDir, 'melspectrogram.onnx'));
const emb = await ort.InferenceSession.create(path.join(modelDir, 'embedding_model.onnx'));
const wake = await ort.InferenceSession.create(path.join(modelDir, 'hey_jarvis_v0.1.onnx'));

let raw = [];
let remainder = [];
let accumulated = 0;
let melBuf = [];
let featureBuf = [];

function reset() {
  raw = [];
  remainder = [];
  accumulated = 0;
  melBuf = [];
  featureBuf = [];
}

async function pushInt16(pcm) {
  const floats = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) floats[i] = pcm[i] / 32768;
  let x = Array.from(floats);
  if (remainder.length) {
    x = remainder.concat(x);
    remainder = [];
  }
  const rem = x.length % FRAME;
  if (rem !== 0) {
    remainder = x.slice(x.length - rem);
    x = x.slice(0, x.length - rem);
  }
  if (x.length === 0) {
    return {
      score: 0,
      detected: false,
      threshold: THRESHOLD,
      melFrames: melBuf.length,
      featureFrames: featureBuf.length,
      wakeRan: false,
      at: new Date().toISOString(),
    };
  }
  raw.push(...x);
  accumulated += x.length;
  if (raw.length > 160_000) raw = raw.slice(-160_000);

  let best = 0;
  let wakeRan = false;
  let embeddingsAdded = 0;
  if (accumulated >= FRAME && accumulated % FRAME === 0) {
    const nSamples = accumulated;
    // Match openWakeWord: last n_samples + 160*3 context samples.
    const window = raw.slice(-(nSamples + 480));
    const melTensor = new ort.Tensor('float32', Float32Array.from(window), [1, window.length]);
    const melOut = await mel.run({ input: melTensor });
    const melData = Array.from(melOut.output.data).map((v) => v / 10 + 2);
    const nFrames = melOut.output.dims[2];
    for (let f = 0; f < nFrames; f += 1) {
      melBuf.push(melData.slice(f * 32, (f + 1) * 32));
    }
    if (melBuf.length > 970) melBuf = melBuf.slice(-970);

    const steps = nSamples / FRAME;
    for (let i = steps - 1; i >= 0; i -= 1) {
      let ndx = -8 * i;
      if (ndx === 0) ndx = melBuf.length;
      const take = sliceMelWindow(melBuf, ndx);
      if (!take) continue;
      const flat = new Float32Array(76 * 32);
      for (let r = 0; r < 76; r += 1) flat.set(take[r], r * 32);
      const embIn = new ort.Tensor('float32', flat, [1, 76, 32, 1]);
      const embOut = await emb.run({ input_1: embIn });
      featureBuf.push(Array.from(embOut.conv2d_19.data));
      embeddingsAdded += 1;
    }
    if (featureBuf.length > 120) featureBuf = featureBuf.slice(-120);
    accumulated = 0;

    if (featureBuf.length >= 16 && embeddingsAdded > 0) {
      // Score each new embedding window in this chunk (max), so coalesced
      // multi-frame pushes cannot bury a peak in a non-final window.
      const firstNew = featureBuf.length - embeddingsAdded;
      for (let end = Math.max(16, firstNew + 1); end <= featureBuf.length; end += 1) {
        const last16 = featureBuf.slice(end - 16, end);
        const wflat = new Float32Array(16 * 96);
        for (let i = 0; i < 16; i += 1) wflat.set(last16[i], i * 96);
        const win = new ort.Tensor('float32', wflat, [1, 16, 96]);
        const wout = await wake.run({ 'x.1': win });
        const score = Number(wout['53'].data[0] ?? 0);
        if (score > best) best = score;
        wakeRan = true;
      }
    }
  }

  return {
    score: best,
    detected: best >= THRESHOLD,
    threshold: THRESHOLD,
    melFrames: melBuf.length,
    featureFrames: featureBuf.length,
    embeddingsAdded,
    wakeRan,
    at: new Date().toISOString(),
  };
}

process.stdout.write(`${JSON.stringify({ ready: true, threshold: THRESHOLD })}\n`);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.reset) {
      reset();
      process.stdout.write(`${JSON.stringify({ ok: true, reset: true })}\n`);
      continue;
    }
    const buf = Buffer.from(String(msg.pcmBase64 || ''), 'base64');
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    const started = Date.now();
    const result = await pushInt16(pcm);
    if (result.detected) reset();
    process.stdout.write(`${JSON.stringify({ ...result, detectMs: Date.now() - started })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: String(err?.message || err) })}\n`);
  }
}
