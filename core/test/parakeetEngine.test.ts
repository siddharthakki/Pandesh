import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeLocalAudioTranscriptionCapability, runLocalTranscription } from '../attachments/audioProcessing';
import {
  PARAKEET_ENGINE_NAME,
  buildHotwords,
  chunkBoundaries,
  ensureVoiceVocabularyFile,
  parakeetAvailable,
  readVoiceVocabulary,
} from '../attachments/parakeetEngine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SPEECH_FIXTURE = path.join(__dirname, 'fixtures', 'audio', 'quarterly-report-speech.wav');
// Owner recordings stay local and git-ignored; tests that need them run only where they exist.
const LOCAL_RECORDINGS = path.join(repoRoot, '.tmp', 'asrbench', 'audio');
const PARAKEET_STAGED = parakeetAvailable({ ...process.env });
const WHISPER_STAGED = probeLocalAudioTranscriptionCapability({ ...process.env, KARKEDIKHA_LOCAL_ASR_COMMAND: '', KARKEDIKHA_ASR_ENGINE: 'whisper-base' }).capability === 'available';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => { while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

describe('engine selection', () => {
  it.runIf(PARAKEET_STAGED)('prefers Parakeet when its model and runtime are staged', () => {
    const probe = probeLocalAudioTranscriptionCapability({ ...process.env, KARKEDIKHA_LOCAL_ASR_COMMAND: '' });
    expect(probe).toEqual({ capability: 'available', engine: PARAKEET_ENGINE_NAME });
  });

  it('can be forced back to the Whisper fallback, and is not available without the model files', () => {
    expect(parakeetAvailable({ ...process.env, KARKEDIKHA_ASR_ENGINE: 'whisper-base' })).toBe(false);
    expect(parakeetAvailable({ ...process.env, KARKEDIKHA_PARAKEET_MODEL_DIR: path.join(tempDir(), 'empty') })).toBe(false);
  });
});

describe('voice vocabulary file', () => {
  it('is created once with a starter list the owner can edit, and never overwritten', () => {
    const file = path.join(tempDir(), 'data', 'voice-vocabulary.json');
    ensureVoiceVocabularyFile(file);
    const first = readVoiceVocabulary(file);
    expect(first.terms).toContain('Conficars');
    fs.writeFileSync(file, JSON.stringify({ score: 3, terms: ['Siddhartha'] }));
    ensureVoiceVocabularyFile(file);
    expect(readVoiceVocabulary(file)).toEqual({ terms: ['Siddhartha'], score: 3 });
  });

  it('treats a missing or damaged file as an empty list, and cleans what it reads', () => {
    const dir = tempDir();
    expect(readVoiceVocabulary(path.join(dir, 'nope.json')).terms).toEqual([]);
    expect(readVoiceVocabulary(undefined).terms).toEqual([]);
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ not json');
    expect(readVoiceVocabulary(broken).terms).toEqual([]);
    const messy = path.join(dir, 'messy.json');
    fs.writeFileSync(messy, JSON.stringify({
      score: 99,
      terms: ['  Conficars ', 'conficars', 7, '', 'a/b', 'x:y', 'Ummeldung', 'z'.repeat(80), 'Krishna  Murthy'],
    }));
    expect(readVoiceVocabulary(messy)).toEqual({ terms: ['Conficars', 'Ummeldung', 'Krishna Murthy'], score: 5 });
  });
});

describe('hotword construction', () => {
  const tokens = new Set(['▁Con', '▁Conf', '▁C', 'on', 'fi', 'ci', 'cars', 'car', 's', '▁Re', 'ch', 'nung', '▁Rech', '▁rech', '▁con', '▁conf']);

  it('splits a term into every known piece sequence, in several casings, each with the score', () => {
    const hot = buildHotwords({ terms: ['Conficars'], score: 2 }, tokens).split('/');
    expect(hot.some((h) => h === '▁Con fi cars :2')).toBe(true);
    expect(hot.some((h) => h.startsWith('▁con ') || h.startsWith('▁conf'))).toBe(true); // lower-case form
    expect(hot.every((h) => / :2$/.test(h))).toBe(true);
    expect(new Set(hot).size).toBe(hot.length);
  });

  it('is empty when there is nothing to favour or the strength is zero, and bounded for huge lists', () => {
    expect(buildHotwords({ terms: [], score: 2 }, tokens)).toBe('');
    expect(buildHotwords({ terms: ['Conficars'], score: 0 }, tokens)).toBe('');
    const many = Array.from({ length: 100 }, (_, i) => `Term${i}x`);
    expect(buildHotwords({ terms: many, score: 2 }, tokens).split('/').length).toBeLessThanOrEqual(800);
  });

  it('keeps multi-word names as one phrase', () => {
    const hot = buildHotwords({ terms: ['Rech nung'], score: 1.5 }, tokens).split('/');
    expect(hot.some((h) => h.includes('▁Rech') && h.includes('▁nung'.slice(0, 1)) && h.endsWith(':1.5'))).toBe(true);
  });
});

describe('long audio chunking', () => {
  const rate = 16000;

  it('keeps short audio in one piece', () => {
    expect(chunkBoundaries(new Float32Array(rate * 10), rate)).toEqual([[0, rate * 10]]);
  });

  it('cuts long audio into contiguous windows no longer than 30 s, preferring a quiet moment', () => {
    const seconds = 75;
    const samples = new Float32Array(rate * seconds).fill(0.3);
    const quietAt = 27.5; // inside the last 4 s of the first window
    samples.fill(0, Math.floor(quietAt * rate), Math.floor((quietAt + 0.3) * rate));
    const ranges = chunkBoundaries(samples, rate);
    expect(ranges[0][0]).toBe(0);
    expect(ranges.at(-1)![1]).toBe(samples.length);
    for (let i = 0; i < ranges.length; i += 1) {
      expect((ranges[i][1] - ranges[i][0]) / rate).toBeLessThanOrEqual(30);
      if (i > 0) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    }
    expect(ranges[0][1] / rate).toBeGreaterThan(27.4);
    expect(ranges[0][1] / rate).toBeLessThan(27.9);
  });
});

describe.runIf(PARAKEET_STAGED)('real Parakeet model and native runtime', () => {
  it('transcribes the speech fixture through the shipped engine with ordered, timed segments', async () => {
    if (!fs.existsSync(SPEECH_FIXTURE)) return; // audio fixtures are omitted from some checkouts
    const result = await runLocalTranscription(PARAKEET_ENGINE_NAME, SPEECH_FIXTURE, { ...process.env });
    expect(result.engine).toBe(PARAKEET_ENGINE_NAME);
    const text = result.segments.map((s) => s.text).join(' ').toLowerCase();
    expect(text).toContain('quarterly report');
    result.segments.forEach((segment, index) => {
      expect(segment.segmentOrdinal).toBe(index);
      expect(segment.endSeconds).toBeGreaterThan(segment.startSeconds);
    });
  }, 120_000);

  it.runIf(WHISPER_STAGED)('falls back to whisper-base.en when the Parakeet model files are damaged', async () => {
    if (!fs.existsSync(SPEECH_FIXTURE)) return;
    const broken = tempDir();
    for (const name of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) fs.writeFileSync(path.join(broken, name), 'not a model');
    const env = { ...process.env, KARKEDIKHA_PARAKEET_MODEL_DIR: broken };
    // A damaged model is never handed to the native runtime (it would exit the process); the probe already says Whisper.
    expect(probeLocalAudioTranscriptionCapability({ ...env, KARKEDIKHA_LOCAL_ASR_COMMAND: '' }).engine).toContain('whisper-base.en');
    // ...and a transcription already routed to Parakeet still ends on Whisper rather than failing or crashing.
    const result = await runLocalTranscription(PARAKEET_ENGINE_NAME, SPEECH_FIXTURE, env);
    expect(result.engine).toContain('whisper-base.en');
    expect(result.segments.map((s) => s.text).join(' ').toLowerCase()).toContain('quarterly report');
  }, 180_000);

  it('does not invent vocabulary terms that were not spoken', async () => {
    if (!fs.existsSync(SPEECH_FIXTURE)) return;
    const file = path.join(tempDir(), 'voice-vocabulary.json');
    ensureVoiceVocabularyFile(file);
    const result = await runLocalTranscription(PARAKEET_ENGINE_NAME, SPEECH_FIXTURE, { ...process.env, KARKEDIKHA_VOICE_VOCABULARY_FILE: file });
    const text = result.segments.map((s) => s.text).join(' ').toLowerCase();
    expect(text).toContain('quarterly report');
    for (const term of ['conficars', 'rechnung', 'pandesh', 'ummeldung']) expect(text).not.toContain(term);
  }, 120_000);

  // Uses the owner's own microphone recordings (never committed). en02 says "Conficars", en04 says "Pandesh".
  const recording = (id: string) => path.join(LOCAL_RECORDINGS, `real_${id}.wav`);
  const HAVE_RECORDINGS = fs.existsSync(recording('en02')) && fs.existsSync(recording('en04'));

  it.runIf(HAVE_RECORDINGS)('hotword vocabulary makes the shipped decoder write the owner\'s names correctly', async () => {
    const text = async (id: string, vocabularyFile?: string) => {
      const env = { ...process.env, ...(vocabularyFile ? { KARKEDIKHA_VOICE_VOCABULARY_FILE: vocabularyFile } : {}) };
      const result = await runLocalTranscription(PARAKEET_ENGINE_NAME, recording(id), env);
      return result.segments.map((s) => s.text).join(' ');
    };
    const file = path.join(tempDir(), 'voice-vocabulary.json');
    fs.writeFileSync(file, JSON.stringify({ score: 2, terms: ['Conficars', 'Pandesh', 'Rechnung'] }));
    const plain02 = await text('en02');
    const hot02 = await text('en02', file);
    const plain04 = await text('en04');
    const hot04 = await text('en04', file);
    expect(plain02).not.toMatch(/Conficars/);
    expect(hot02).toMatch(/Conficars/);
    expect(plain04).not.toMatch(/Pandesh/);
    expect(hot04).toMatch(/Pandesh/);
    // The rest of the sentence is unaffected.
    expect(hot02.toLowerCase()).toContain('search my gmail for the invoice from');
    expect(hot04.toLowerCase()).toContain('kubernetes cluster');
  }, 180_000);
});
