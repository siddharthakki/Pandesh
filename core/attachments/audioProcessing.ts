/**
 * M36 pass 2 — local audio transcription.
 *
 * Primary engine: a quantized `whisper-base.en` ONNX model run locally via
 * `@xenova/transformers` (WASM backend — no native binary, no compiled
 * dependency; the same "pure JS/WASM, esbuild-external, no native deps"
 * shape already used for document extraction's pdfjs-dist/mammoth). The
 * model files are fetched once at build time (`scripts/fetch-whisper-model.mjs`,
 * run as part of `npm run package:win32-x64`) into `models/whisper-base-en/`
 * and shipped inside the packaged VSIX — the packaged runtime never makes a
 * network call to transcribe audio. (Upgraded from whisper-tiny.en: tiny
 * produced meaningfully more misrecognitions on uncommon words; base is
 * still light enough to run locally without materially hurting latency.)
 *
 * `@xenova/transformers` and its `onnxruntime-web` dependency are NOT
 * bundled into `out-core/core.js` by esbuild (see `esbuild.core.js`'s
 * `external` list) — their WASM binaries are real files that must be loaded
 * from disk, which a single-file JS bundle cannot do. They are resolved at
 * runtime via the real `node_modules/@xenova` / `node_modules/onnxruntime-web`
 * directories shipped alongside `out-core/core.js` in the packaged VSIX
 * (`.vscodeignore` allowlist), the same pattern already used for
 * `@vscode/sqlite3`'s native binary.
 *
 * Secondary/override engine: an external command named by
 * `KARKEDIKHA_LOCAL_ASR_COMMAND`, for anyone who wants to point this at a
 * different local ASR engine instead of the bundled one. If neither the
 * bundled model files nor an external command are available, the honest,
 * typed answer is `unavailable_no_local_engine` — never a fabricated
 * transcript.
 */
import { spawn } from 'node:child_process';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { AudioTranscriptionResult, AudioTranscriptionSegment, LocalProcessingCapability } from '../shared/wireTypes';

export interface AudioCapabilityProbe {
  capability: LocalProcessingCapability;
  engine: string | null;
}

const BUILTIN_ENGINE_NAME = 'whisper-base.en (@xenova/transformers, quantized ONNX, local, WASM)';
const MODEL_ID = 'Xenova/whisper-base.en';

/** In the packaged/bundled runtime, `out-core/core.js` (this module's
 * bundled home) sits at `<extensionRoot>/out-core/core.js`, one hop from the
 * fetched model directory at `<extensionRoot>/models/whisper-base-en`. Under
 * plain `ts-node`/vitest (unbundled), this file instead runs from its real
 * source location `core/attachments/audioProcessing.ts`, two hops from
 * `<repoRoot>/models/whisper-base-en`. Both are the same physical directory
 * on disk (the packaged extension root IS the repo root) — only the hop
 * count from `__dirname` differs — so try both shapes and use whichever
 * actually exists, defaulting to the packaged shape if neither does yet
 * (the honest "unavailable" capability naturally follows from that).
 *
 * `KARKEDIKHA_ASR_MODEL_DIR`, if set, overrides this entirely — a legitimate
 * production configuration knob (point at a model fetched to a different
 * location) that also lets tests deterministically exercise the
 * unavailable-engine path (point at an empty/nonexistent directory) without
 * needing to actually remove the real bundled model from disk. */
function builtinModelDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KARKEDIKHA_ASR_MODEL_DIR?.trim();
  if (override) return override;
  const packagedShape = path.join(__dirname, '..', 'models', 'whisper-base-en');
  const devShape = path.join(__dirname, '..', '..', 'models', 'whisper-base-en');
  return fs.existsSync(devShape) ? devShape : packagedShape;
}

function builtinModelFilesPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = path.join(builtinModelDir(env), MODEL_ID);
  const required = [
    'config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    path.join('onnx', 'encoder_model_quantized.onnx'),
    path.join('onnx', 'decoder_model_merged_quantized.onnx'),
  ];
  return required.every((relPath) => fs.existsSync(path.join(dir, relPath)));
}

/** Never throws; a misconfigured/missing engine is itself an "unavailable"
 * result, not a Core-crashing error. An explicit external-command override
 * wins over the bundled WASM engine so an operator can point Jarvis at a
 * native faster-whisper/whisper.cpp wrapper without removing the packaged
 * fallback model. */
export function probeLocalAudioTranscriptionCapability(env: NodeJS.ProcessEnv = process.env): AudioCapabilityProbe {
  const command = env.KARKEDIKHA_LOCAL_ASR_COMMAND?.trim();
  if (command) {
    return { capability: 'available', engine: command };
  }
  if (builtinModelFilesPresent(env)) {
    return { capability: 'available', engine: BUILTIN_ENGINE_NAME };
  }
  return { capability: 'unavailable_no_local_engine', engine: null };
}

// ---------------------------------------------------------------------------
// WAV decoding + resampling (pure JS — Node has no AudioContext, and
// @xenova/transformers' own `read_audio` helper explicitly requires one and
// refuses to run under Node; see its source for the exact error message).
// ---------------------------------------------------------------------------

const WHISPER_SAMPLE_RATE = 16000;

interface DecodedPcm {
  samples: Float32Array;
  sampleRate: number;
}

/** Minimal PCM WAV reader: mono/stereo, 16-bit integer or 32-bit float
 * samples — enough for real microphone/TTS-recorded speech clips. Anything
 * else (compressed WAV, unusual bit depths) throws, which the caller records
 * as `localProcessingCapability: 'failed'` rather than silently producing
 * garbage. */
function decodeWav(buffer: Buffer): DecodedPcm {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt: { audioFormat: number; numChannels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        numChannels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataSize = chunkSize;
    }
    offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!fmt) throw new Error('WAV file has no fmt chunk');
  if (dataOffset < 0) throw new Error('WAV file has no data chunk');
  const isFloat = fmt.audioFormat === 3;
  const isPcm = fmt.audioFormat === 1;
  if (!isPcm && !isFloat) throw new Error(`unsupported WAV audio format code ${fmt.audioFormat} (only PCM/IEEE float are supported)`);
  if (isPcm && fmt.bitsPerSample !== 16) throw new Error(`unsupported PCM bit depth ${fmt.bitsPerSample} (only 16-bit PCM is supported)`);
  if (isFloat && fmt.bitsPerSample !== 32) throw new Error(`unsupported float bit depth ${fmt.bitsPerSample} (only 32-bit float is supported)`);

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (bytesPerSample * fmt.numChannels));
  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < fmt.numChannels; ch += 1) {
      const sampleOffset = dataOffset + (i * fmt.numChannels + ch) * bytesPerSample;
      const value = isFloat ? buffer.readFloatLE(sampleOffset) : buffer.readInt16LE(sampleOffset) / 32768;
      sum += value;
    }
    mono[i] = sum / fmt.numChannels;
  }
  return { samples: mono, sampleRate: fmt.sampleRate };
}

/** Simple linear-interpolation resampler — adequate fidelity for speech ASR
 * input (not intended for hi-fi audio work). Whisper requires exactly 16kHz
 * mono input; skipping this step (feeding samples at their native rate
 * directly) silently desyncs the reported segment timestamps from real
 * elapsed time even though the transcribed words often still come out
 * right, since Whisper is fairly robust to modest speed shifts — verified
 * live during development. */
function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const newLength = Math.max(1, Math.round(samples.length / ratio));
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcIndex - i0;
    result[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

// @xenova/transformers exposes mutable process-global runtime configuration.
// Keep every cached pipeline bound to the complete Core-owned model location
// that created it; an unavailable or alternate server configuration must
// never affect a later server using the bundled model. Initialisation itself
// is serialised because configuring a second pipeline mutates that library's
// shared `env` object while it is being constructed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cachedPipelines = new Map<string, Promise<any>>();
let pipelineInitialisation: Promise<void> = Promise.resolve();

/** @xenova/transformers (and its onnxruntime-web dependency) are esbuild
 * `external` — this must be a real runtime `require`/`import`, never
 * inlined into the bundle (its WASM binaries can't be). In the packaged
 * runtime, it's resolved against `runtime-assets/node_modules/@xenova/
 * transformers` — a hand-picked, trimmed subset staged at package time by
 * scripts/stage-asr-runtime-assets.mjs, deliberately NOT the repo's real
 * top-level `node_modules/` (see that script's header for why: `vsce
 * package`'s automatic production-dependency walking pulled in 370MB+ of
 * unrelated platform binaries/docs/types regardless of .vscodeignore
 * scoping). In dev/vitest, where that staging step hasn't necessarily run,
 * falls back to the ordinary `node_modules/@xenova/transformers` (a
 * devDependency, present after any `npm install`). */
/** Resolves the staged (or dev node_modules) `runtime-assets/node_modules`
 * directory itself, alongside the `@xenova/transformers` entry point it
 * contains — needed separately because @xenova/transformers' own
 * `env.js` computes its WASM binary search path (`wasmPaths`) as
 * `<transformers-package-dir>/dist/`, which is where THEIR OWN prebuilt
 * package ships copies of onnxruntime's `.wasm` files when installed
 * normally from npm. We deliberately stage only `@xenova/transformers`'
 * `src/` (not its `dist/`, which we never fetch — see
 * `stage-asr-runtime-assets.mjs`), so that default path is wrong for us;
 * it must be pointed at the real onnxruntime-web `dist/` we do stage. */
async function importTransformers(): Promise<{ module: any; runtimeAssetsNodeModules: string | null }> {
  const packagedRuntimeAssets = path.join(__dirname, '..', 'runtime-assets', 'node_modules');
  const devRuntimeAssets = path.join(__dirname, '..', '..', 'runtime-assets', 'node_modules');
  for (const runtimeAssetsNodeModules of [packagedRuntimeAssets, devRuntimeAssets]) {
    const candidate = path.join(runtimeAssetsNodeModules, '@xenova', 'transformers', 'src', 'transformers.js');
    if (fs.existsSync(candidate)) {
      const { pathToFileURL } = await import('node:url');
      const module = await import(pathToFileURL(candidate).href);
      return { module, runtimeAssetsNodeModules };
    }
  }
  return { module: await import('@xenova/transformers'), runtimeAssetsNodeModules: null };
}

async function getBuiltinPipeline(processingEnv: NodeJS.ProcessEnv): Promise<any> {
  const modelDir = path.resolve(builtinModelDir(processingEnv));
  const existing = cachedPipelines.get(modelDir);
  if (existing) return existing;

  const initialise = async () => {
    const { module, runtimeAssetsNodeModules } = await importTransformers();
    const { pipeline, env } = module;
    env.allowLocalModels = true;
    env.allowRemoteModels = false; // packaged runtime: never fetch over the network
    env.localModelPath = modelDir;
    env.useBrowserCache = false;
    if (env.backends?.onnx?.logLevel !== undefined) env.backends.onnx.logLevel = 'error';
    if (env.backends?.onnx?.wasm && runtimeAssetsNodeModules) {
      // Point WASM binary loading at the real onnxruntime-web dist/ we stage,
      // not @xenova/transformers' own (unstaged) dist/ that its default
      // wasmPaths computation assumes exists.
      env.backends.onnx.wasm.wasmPaths = path.join(runtimeAssetsNodeModules, 'onnxruntime-web', 'dist') + path.sep;
      // Force the single-threaded, non-SIMD-threaded WASM binary. The
      // multi-threaded variant spins up worker_threads whose worker script
      // resolution hung indefinitely under this staged/packaged layout (never
      // erroring, never completing) rather than failing fast — unacceptable
      // for an "honest available/failed" capability contract. Single-threaded
      // WASM is slower but bounded and reliable; correctness over speed here.
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.simd = true;
      env.backends.onnx.wasm.proxy = false;
    }
    return pipeline('automatic-speech-recognition', MODEL_ID, { quantized: true });
  };

  // Only the configuration/creation phase needs exclusive access to the
  // library-global environment. A settled pipeline remains tied to its own
  // local model files and can subsequently serve normal requests.
  const pending = pipelineInitialisation.then(initialise);
  pipelineInitialisation = pending.then(() => undefined, () => undefined);
  cachedPipelines.set(modelDir, pending);
  try {
    return await pending;
  } catch (error) {
    // A failed initialisation is evidence for this upload only. Do not retain
    // it as a poison cache entry for a repaired or independently configured
    // Core server.
    if (cachedPipelines.get(modelDir) === pending) cachedPipelines.delete(modelDir);
    throw error;
  }
}

interface RawChunk {
  text: string;
  timestamp: [number, number | null];
}

async function transcribeWithBuiltinEngine(filePath: string, processingEnv: NodeJS.ProcessEnv): Promise<AudioTranscriptionResult> {
  const buffer = await fsPromises.readFile(filePath);
  const decoded = decodeWav(buffer);
  const resampled = resampleLinear(decoded.samples, decoded.sampleRate, WHISPER_SAMPLE_RATE);

  const transcriber = await getBuiltinPipeline(processingEnv);
  // Whisper decodes a 30 s window; without chunking, anything longer (a
  // spoken request can run to the 45 s capture cap) is silently truncated.
  const result = await transcriber(resampled, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
  const rawChunks: RawChunk[] = Array.isArray(result?.chunks) ? result.chunks : [];

  const segments: AudioTranscriptionSegment[] = rawChunks.map((chunk, index) => ({
    segmentOrdinal: index,
    startSeconds: chunk.timestamp[0] ?? 0,
    // A trailing chunk can have a null end timestamp (Whisper didn't emit a
    // closing token before the audio ended) — clamp to the audio's own
    // duration rather than propagate `null` into durable evidence.
    endSeconds: chunk.timestamp[1] ?? resampled.length / WHISPER_SAMPLE_RATE,
    text: String(chunk.text ?? '').trim(),
  })).filter((segment) => segment.text.length > 0);

  return { engine: BUILTIN_ENGINE_NAME, segments, transcribedAt: new Date().toISOString() };
}

const EXTERNAL_TRANSCRIBE_TIMEOUT_MS = 120_000;
const EXTERNAL_SEGMENT_LINE = /^(\d+(?:\.\d+)?)\t(\d+(?:\.\d+)?)\t(.*)$/;

/** External-command engine contract: reads the file path given as argv[1],
 * writes newline-delimited `start_seconds\tend_seconds\ttext` segments to
 * stdout. Only used when the bundled built-in engine's model files are
 * absent and this override is explicitly configured. */
function runExternalTranscription(engine: string, filePath: string): Promise<AudioTranscriptionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, [filePath], { windowsHide: true, shell: false, env: createSanitizedChildEnvironment() });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`local ASR command timed out after ${EXTERNAL_TRANSCRIBE_TIMEOUT_MS}ms`));
    }, EXTERNAL_TRANSCRIBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`local ASR command exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      const segments = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          const match = EXTERNAL_SEGMENT_LINE.exec(line);
          if (!match) return null;
          return { segmentOrdinal: index, startSeconds: Number(match[1]), endSeconds: Number(match[2]), text: match[3] };
        })
        .filter((segment): segment is AudioTranscriptionSegment => segment !== null);
      resolve({ engine, segments, transcribedAt: new Date().toISOString() });
    });
  });
}

/** Only called when `probeLocalAudioTranscriptionCapability` already
 * returned `available` with a concrete `engine`. Bounded and fails closed —
 * a misbehaving engine (built-in or external) throws, which the caller
 * records as `localProcessingCapability: 'failed'`, never fabricating
 * segments. */
export async function runLocalTranscription(
  engine: string,
  filePath: string,
  processingEnv: NodeJS.ProcessEnv = process.env,
): Promise<AudioTranscriptionResult> {
  if (engine === BUILTIN_ENGINE_NAME) return transcribeWithBuiltinEngine(filePath, processingEnv);
  return runExternalTranscription(engine, filePath);
}
