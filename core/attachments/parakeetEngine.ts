/**
 * Local speech recognition with NVIDIA Parakeet TDT 0.6B v3 (int8) through the `sherpa-onnx-node` native runtime.
 *
 * Why this replaced whisper-base.en as the default (measured 2026-11-25 on 14 real microphone recordings of the
 * owner: English, German, mixed English/German, Indian names, company and technical terms): word error 42.1% ->
 * 17.4%, 1.1 s -> 0.6 s per clip, CPU only (no VRAM taken from the LLM). whisper-base.en is English-only, so German
 * speech and German words inside English sentences came out as nonsense. Parakeet v3 covers 25 European languages
 * with automatic language detection. whisper-base.en stays as the fallback (audioProcessing.ts).
 *
 * Vocabulary: a local, user-editable JSON file (`voice-vocabulary.json` in the desktop data directory) lists names
 * the recognizer should favour. It is passed to the decoder as per-stream hotwords (contextual biasing), so it only
 * nudges what the audio already sounds like; it never rewrites text afterwards. Nothing here leaves the machine.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { AudioTranscriptionSegment } from '../shared/wireTypes';

export const PARAKEET_ENGINE_NAME = 'parakeet-tdt-0.6b-v3 (sherpa-onnx, int8, local, CPU)';
export const PARAKEET_SAMPLE_RATE = 16000;

const MODEL_DIR_NAME = 'parakeet-tdt-v3-int8';
/**
 * Exact sizes of the shipped files (SHA-256 is pinned in scripts/fetch-parakeet-model.mjs and in the release manifest).
 * Checked before the native runtime touches them because it does not throw on a damaged model: a truncated
 * tokens.txt makes sherpa-onnx exit the whole process. A wrong size therefore means "not available", never a load.
 */
const MODEL_FILE_BYTES: Record<string, number> = {
  'encoder.int8.onnx': 652282294,
  'decoder.int8.onnx': 11845274,
  'joiner.int8.onnx': 6355277,
  'tokens.txt': 93939,
};
/** Parakeet decodes whole utterances; longer audio is cut into windows no longer than this. */
const MAX_CHUNK_SECONDS = 30;
/** Where to look for a quiet moment to cut, counted back from the end of a full window. */
const CUT_SEARCH_SECONDS = 4;

/** Same resolution rule as the Whisper model: an explicit override, else the packaged or repo-relative models folder. */
export function parakeetModelDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KARKEDIKHA_PARAKEET_MODEL_DIR?.trim();
  if (override) return override;
  const packagedShape = path.join(__dirname, '..', 'models', MODEL_DIR_NAME);
  const devShape = path.join(__dirname, '..', '..', 'models', MODEL_DIR_NAME);
  return fs.existsSync(devShape) ? devShape : packagedShape;
}

export function parakeetModelFilesPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = parakeetModelDir(env);
  return Object.entries(MODEL_FILE_BYTES).every(([name, bytes]) => {
    try { return fs.statSync(path.join(dir, name)).size === bytes; } catch { return false; }
  });
}

/** `runtime-assets/node_modules` candidates, mirroring how the Whisper runtime is found. */
function runtimeAssetRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const override = env.KARKEDIKHA_ASR_RUNTIME_DIR?.trim();
  if (override) roots.push(override);
  roots.push(path.join(__dirname, '..', 'runtime-assets', 'node_modules'));
  roots.push(path.join(__dirname, '..', '..', 'runtime-assets', 'node_modules'));
  return roots;
}

function findSherpaPackageRoot(env: NodeJS.ProcessEnv): string | null {
  for (const root of runtimeAssetRoots(env)) {
    const candidate = path.join(root, 'sherpa-onnx-node');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  // Development install (devDependency) and any NODE_PATH the host prepared.
  try {
    return path.dirname(createRequire(__filename).resolve('sherpa-onnx-node/package.json'));
  } catch {
    return null;
  }
}

/** Cheap, synchronous: the native runtime package is on disk. Does not load it. */
export function parakeetRuntimePresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return findSherpaPackageRoot(env) !== null;
}

export function parakeetAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KARKEDIKHA_ASR_ENGINE?.trim().toLowerCase() === 'whisper-base') return false;
  return parakeetModelFilesPresent(env) && parakeetRuntimePresent(env);
}

// ---------------------------------------------------------------------------
// Vocabulary (hotwords)
// ---------------------------------------------------------------------------

export interface VoiceVocabulary {
  /** Names and words to favour: "Conficars", "Rechnung", or a short phrase. */
  terms: string[];
  /** Bias strength, 0 (off) to 5. 2 was best on the owner's recordings; 4 started dropping real words. */
  score: number;
}

export const DEFAULT_VOICE_SCORE = 2;
const MAX_TERMS = 100;
const MAX_TERM_LENGTH = 48;
const MAX_HOTWORD_ENTRIES = 800;

/** Starter list written once into the owner's own editable file; nothing reads these from code at decode time. */
export const STARTER_VOICE_TERMS = ['Pandesh', 'Conficars', 'Rechnung', 'Rechnungen', 'Ummeldung'] as const;

function cleanTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const term = value.trim().replace(/\s+/g, ' ');
    if (!term || term.length > MAX_TERM_LENGTH || /[/:|]/.test(term) || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/** Never throws: a missing or damaged file means "no vocabulary", not a failed transcription. */
export function readVoiceVocabulary(file: string | undefined): VoiceVocabulary {
  if (!file) return { terms: [], score: DEFAULT_VOICE_SCORE };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { terms?: unknown; score?: unknown };
    const rawScore = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : DEFAULT_VOICE_SCORE;
    return { terms: cleanTerms(parsed.terms), score: Math.min(5, Math.max(0, rawScore)) };
  } catch {
    return { terms: [], score: DEFAULT_VOICE_SCORE };
  }
}

/** Creates the owner's vocabulary file on first run; never overwrites an existing one. */
export function ensureVoiceVocabularyFile(file: string): void {
  try {
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      note: 'Words and names the local speech recognizer should favour. Edit freely; stays on this PC. score: 0 = off, 2 = default, max 5.',
      score: DEFAULT_VOICE_SCORE,
      terms: [...STARTER_VOICE_TERMS],
    }, null, 2)}\n`, 'utf8');
  } catch { /* an unwritable data folder must never stop speech recognition */ }
}

export function readTokenVocabulary(tokensFile: string): Set<string> {
  const tokens = new Set<string>();
  for (const line of fs.readFileSync(tokensFile, 'utf8').split(/\r?\n/)) {
    const token = line.replace(/ \d+$/, '');
    if (token) tokens.add(token);
  }
  return tokens;
}

function greedyFront(word: string, vocab: Set<string>): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < word.length) {
    let j = word.length;
    let piece: string | null = null;
    while (j > i) { const candidate = word.slice(i, j); if (vocab.has(candidate)) { piece = candidate; break; } j -= 1; }
    if (!piece) piece = word[i];
    out.push(piece);
    i += piece.length;
  }
  return out;
}

function greedyBack(word: string, vocab: Set<string>): string[] {
  const out: string[] = [];
  let j = word.length;
  while (j > 0) {
    let i = 0;
    let piece: string | null = null;
    while (i < j) { const candidate = word.slice(i, j); if (vocab.has(candidate)) { piece = candidate; break; } i += 1; }
    if (!piece) piece = word[j - 1];
    out.unshift(piece);
    j -= piece.length;
  }
  return out;
}

/** Every way to split the word into known pieces (bounded). The decoder matches whichever split it actually emits. */
function allSplits(word: string, vocab: Set<string>, limit: number): string[][] {
  const results: string[][] = [];
  const walk = (start: number, current: string[]): void => {
    if (results.length >= limit) return;
    if (start === word.length) { results.push(current.slice()); return; }
    for (let end = word.length; end > start; end -= 1) {
      const piece = word.slice(start, end);
      if (vocab.has(piece)) { current.push(piece); walk(end, current); current.pop(); }
    }
  };
  walk(0, []);
  return results;
}

/**
 * The sentencepiece vocabulary shipped with the model has no tokenizer model file, so each term is split into known
 * pieces here, in several plausible ways and three casings, because the decoder only matches the exact piece
 * sequence it would emit. Measured: one split per term helped little; all splits gave 17.4% -> 12.6% word error.
 */
export function buildHotwords(vocabulary: VoiceVocabulary, tokens: Set<string>): string {
  if (vocabulary.score <= 0 || vocabulary.terms.length === 0) return '';
  const entries = new Set<string>();
  for (const term of vocabulary.terms) {
    const words = term.split(' ');
    const casings = new Set([term, term.toLowerCase(), words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ')]);
    for (const casing of casings) {
      const parts = casing.split(' ').map((w) => `▁${w}`);
      if (parts.length === 1) {
        for (const split of [greedyFront(parts[0], tokens), greedyBack(parts[0], tokens), ...allSplits(parts[0], tokens, 40)]) entries.add(split.join(' '));
      } else {
        entries.add(parts.flatMap((w) => greedyFront(w, tokens)).join(' '));
        entries.add(parts.flatMap((w) => greedyBack(w, tokens)).join(' '));
      }
    }
    if (entries.size >= MAX_HOTWORD_ENTRIES) break;
  }
  return [...entries].slice(0, MAX_HOTWORD_ENTRIES).map((entry) => `${entry} :${vocabulary.score}`).join('/');
}

// ---------------------------------------------------------------------------
// Long audio: cut into windows at quiet moments
// ---------------------------------------------------------------------------

/** [start, end) sample ranges, each at most `maxSeconds`, cut where the signal is quietest near the end of a window. */
export function chunkBoundaries(
  samples: Float32Array,
  sampleRate = PARAKEET_SAMPLE_RATE,
  maxSeconds = MAX_CHUNK_SECONDS,
  searchSeconds = CUT_SEARCH_SECONDS,
): Array<[number, number]> {
  const max = Math.floor(maxSeconds * sampleRate);
  if (samples.length <= max) return [[0, samples.length]];
  const frame = Math.floor(sampleRate * 0.05);
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (samples.length - start > max) {
    const windowEnd = start + max;
    const searchStart = Math.max(start + frame, windowEnd - Math.floor(searchSeconds * sampleRate));
    let bestCut = windowEnd;
    let bestEnergy = Number.POSITIVE_INFINITY;
    for (let pos = searchStart; pos + frame <= windowEnd; pos += frame) {
      let energy = 0;
      for (let i = pos; i < pos + frame; i += 1) energy += samples[i] * samples[i];
      if (energy < bestEnergy) { bestEnergy = energy; bestCut = pos + Math.floor(frame / 2); }
    }
    ranges.push([start, bestCut]);
    start = bestCut;
  }
  ranges.push([start, samples.length]);
  return ranges;
}

// ---------------------------------------------------------------------------
// Recognizer
// ---------------------------------------------------------------------------

interface SherpaStream { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void }
interface SherpaRecognizer {
  createStream(hotwords?: string): SherpaStream;
  decodeAsync(stream: SherpaStream): Promise<unknown>;
  getResult(stream: SherpaStream): { text?: string };
}
interface LoadedRecognizer { recognizer: SherpaRecognizer; tokens: Set<string> }

const loaded = new Map<string, Promise<LoadedRecognizer>>();
/** One recognizer instance, one decode at a time. */
let decodeQueue: Promise<unknown> = Promise.resolve();

function loadRecognizer(env: NodeJS.ProcessEnv): Promise<LoadedRecognizer> {
  const modelDir = path.resolve(parakeetModelDir(env));
  const existing = loaded.get(modelDir);
  if (existing) return existing;
  const pending = (async (): Promise<LoadedRecognizer> => {
    if (!parakeetModelFilesPresent(env)) throw new Error(`Parakeet model files are missing or damaged under ${modelDir}`);
    const packageRoot = findSherpaPackageRoot(env);
    if (!packageRoot) throw new Error('sherpa-onnx-node is not installed (runtime-assets/node_modules/sherpa-onnx-node)');
    const sherpa = createRequire(path.join(packageRoot, 'package.json'))(packageRoot) as {
      OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
    };
    const file = (name: string) => path.join(modelDir, name);
    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: PARAKEET_SAMPLE_RATE, featureDim: 80 },
      // Beam search is what lets hotwords take effect; it was also more accurate than greedy (15.3% vs 17.4%).
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 4,
      hotwordsScore: DEFAULT_VOICE_SCORE,
      modelConfig: {
        transducer: { encoder: file('encoder.int8.onnx'), decoder: file('decoder.int8.onnx'), joiner: file('joiner.int8.onnx') },
        tokens: file('tokens.txt'),
        numThreads: Math.max(1, Math.min(4, os.cpus().length)),
        provider: 'cpu',
        modelType: 'nemo_transducer',
        debug: 0,
      },
    });
    return { recognizer, tokens: readTokenVocabulary(file('tokens.txt')) };
  })();
  loaded.set(modelDir, pending);
  // A failed load is not cached: a repaired install must work without restarting the app.
  pending.catch(() => { if (loaded.get(modelDir) === pending) loaded.delete(modelDir); });
  return pending;
}

/** Transcribes 16 kHz mono samples. Throws when the model or native runtime cannot load; the caller falls back. */
export async function transcribeWithParakeet(
  samples: Float32Array,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AudioTranscriptionSegment[]> {
  const { recognizer, tokens } = await loadRecognizer(env);
  const hotwords = buildHotwords(readVoiceVocabulary(env.KARKEDIKHA_VOICE_VOCABULARY_FILE?.trim()), tokens);
  const run = decodeQueue.then(async () => {
    const segments: AudioTranscriptionSegment[] = [];
    for (const [start, end] of chunkBoundaries(samples)) {
      const stream = hotwords ? recognizer.createStream(hotwords) : recognizer.createStream();
      stream.acceptWaveform({ samples: samples.subarray(start, end), sampleRate: PARAKEET_SAMPLE_RATE });
      await recognizer.decodeAsync(stream);
      const text = String(recognizer.getResult(stream).text ?? '').trim();
      if (!text) continue;
      segments.push({ segmentOrdinal: segments.length, startSeconds: start / PARAKEET_SAMPLE_RATE, endSeconds: end / PARAKEET_SAMPLE_RATE, text });
    }
    return segments;
  });
  decodeQueue = run.catch(() => undefined);
  return run;
}
