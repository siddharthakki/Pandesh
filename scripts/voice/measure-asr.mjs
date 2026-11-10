#!/usr/bin/env node
// Measures Pandesh's local speech recognition on a fixed phrase set, through the product's own pipeline
// (core/attachments/audioProcessing.ts + the host's vocabulary correction), and records word error rate and
// whether the key words (names, mixed-language and technical terms) came through.
//
// Real speech: record each phrase in scripts/voice/phrases.tsv as <id>.wav (or .m4a/.mp3/.ogg; converted with
// ffmpeg when it is on PATH) in one folder, then
//   node scripts/voice/measure-asr.mjs --recordings <folder> --label "my voice" --model-dir <models/whisper-base-en>
// Synthetic speech (for regressions; not a substitute for real voices):
//   node scripts/voice/measure-asr.mjs --piper <piper.exe> --tts piper:<voice.onnx> --tts "sapi:Microsoft Zira Desktop"
//
// Writes <out>/results.json and prints a summary. Audio and results stay on this PC.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { tts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--tts') { out.tts.push(value); i += 1; } else if (key.startsWith('--')) { out[key.slice(2)] = value; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const phrasesPath = path.resolve(args.phrases ?? path.join(repoRoot, 'scripts', 'voice', 'phrases.tsv'));
const outDir = path.resolve(args.out ?? path.join(repoRoot, '.tmp', 'voice-measure'));
const modelDir = path.resolve(args['model-dir'] ?? process.env.KARKEDIKHA_ASR_MODEL_DIR ?? path.join(repoRoot, 'models', 'whisper-base-en'));
fs.mkdirSync(outDir, { recursive: true });

const phrases = fs.readFileSync(phrasesPath, 'utf8').split(/\r?\n/).slice(1).filter((l) => l.trim()).map((line) => {
  const [id, category, text, terms = ''] = line.split('\t');
  return { id, category, text, terms: terms.split('|').map((t) => t.trim()).filter(Boolean) };
});

// --- the product's own recognizer and correction, bundled from source ---------------------------------------------
async function loadPipeline() {
  const { build } = await import('esbuild');
  const entry = path.join(outDir, 'asr-entry.ts');
  const rel = (p) => path.relative(outDir, path.join(repoRoot, p)).split(path.sep).join('/');
  fs.writeFileSync(entry, [
    `import { probeLocalAudioTranscriptionCapability, runLocalTranscription } from '${rel('core/attachments/audioProcessing')}';`,
    `import { stripNonSpeechHallucinations } from '${rel('apps/desktop/src/host/desktopLocalSpeech')}';`,
    `import { voiceTranscriptReview } from '${rel('apps/desktop/src/host/voiceTranscript')}';`,
    'export async function transcribe(wavPath: string, modelDir: string) {',
    '  const env = { ...process.env, KARKEDIKHA_ASR_MODEL_DIR: modelDir };',
    '  const probe = probeLocalAudioTranscriptionCapability(env);',
    "  if (probe.capability !== 'available' || !probe.engine) throw new Error(`speech recognition unavailable: ${probe.capability}`);",
    '  const started = Date.now();',
    '  const result = await runLocalTranscription(probe.engine, wavPath, env);',
    "  const heard = stripNonSpeechHallucinations(result.segments.map((s) => s.text).join(' ').trim());",
    '  const review = voiceTranscriptReview(heard);',
    '  return { engine: result.engine, heard, corrected: review.text, corrections: review.corrections, ms: Date.now() - started };',
    '}',
  ].join('\n'));
  const bundle = path.join(outDir, 'asr.cjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: bundle, logLevel: 'warning' });
  return require(bundle);
}

// --- audio sources -------------------------------------------------------------------------------------------------
function synthesize(spec, phrase, dir) {
  const wav = path.join(dir, `${phrase.id}.wav`);
  if (spec.startsWith('piper:')) {
    if (!args.piper) throw new Error('--piper <piper.exe> is required for piper voices');
    const r = spawnSync(args.piper, ['--model', spec.slice(6), '--output_file', wav, '--quiet'], { input: phrase.text, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`piper failed: ${r.stderr}`);
  } else if (spec.startsWith('sapi:')) {
    const textFile = path.join(dir, `${phrase.id}.txt`);
    fs.writeFileSync(textFile, phrase.text, 'utf8');
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice(${q(spec.slice(5))}); $s.SetOutputToWaveFile(${q(wav)}); $s.Speak((Get-Content -Raw -Encoding UTF8 -LiteralPath ${q(textFile)})); $s.Dispose()`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`SAPI failed: ${r.stderr}`);
  } else {
    throw new Error(`unknown --tts ${spec} (use piper:<voice.onnx> or sapi:<voice name>)`);
  }
  return wav;
}

function recording(dir, phrase, convertedDir) {
  const found = fs.readdirSync(dir).find((f) => path.parse(f).name === phrase.id);
  if (!found) return null;
  const file = path.join(dir, found);
  if (/\.wav$/i.test(found)) return file;
  const wav = path.join(convertedDir, `${phrase.id}.wav`);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', wav], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg could not convert ${found}: ${r.stderr || r.error}`);
  return wav;
}

// --- scoring -------------------------------------------------------------------------------------------------------
const words = (s) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prev[j], prev[j - 1]);
      diag = saved;
    }
  }
  return prev[b.length];
}
function hasTerm(text, term) {
  const hay = words(text).join(' ');
  return ` ${hay} `.includes(` ${words(term).join(' ')} `);
}

const pipeline = await loadPipeline();
const sources = [];
if (args.recordings) sources.push({ label: args.label ?? 'recordings', kind: 'recorded', get: (p, d) => recording(path.resolve(args.recordings), p, d) });
for (const spec of args.tts) sources.push({ label: spec, kind: 'synthetic', get: (p, d) => synthesize(spec, p, d) });
if (sources.length === 0) { console.error('nothing to measure: pass --recordings <folder> and/or --tts <voice>'); process.exit(2); }

const rows = [];
for (const [index, source] of sources.entries()) {
  const dir = path.join(outDir, `source-${index + 1}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const phrase of phrases) {
    const wav = source.get(phrase, dir);
    if (!wav) { rows.push({ source: source.label, kind: source.kind, ...phrase, missing: true }); continue; }
    const r = await pipeline.transcribe(wav, modelDir);
    const ref = words(phrase.text);
    rows.push({
      source: source.label, kind: source.kind, ...phrase, heard: r.heard, corrected: r.corrected, corrections: r.corrections, asrMs: r.ms,
      refWords: ref.length, errors: editDistance(ref, words(r.heard)), errorsCorrected: editDistance(ref, words(r.corrected)),
      termHits: phrase.terms.map((t) => hasTerm(r.heard, t)), termHitsCorrected: phrase.terms.map((t) => hasTerm(r.corrected, t)),
    });
    process.stdout.write('.');
  }
}
process.stdout.write('\n');
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ measuredAt: new Date().toISOString(), model: path.basename(modelDir), rows }, null, 2));

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const lines = ['| source | category | WER | key words heard | after correction | controls changed |', '|---|---|---|---|---|---|'];
for (const source of sources) {
  for (const category of [...new Set(phrases.map((p) => p.category))]) {
    const rs = rows.filter((r) => r.source === source.label && r.category === category && !r.missing);
    if (rs.length === 0) continue;
    const refWords = rs.reduce((n, r) => n + r.refWords, 0);
    const errors = rs.reduce((n, r) => n + r.errors, 0);
    const terms = rs.flatMap((r) => r.termHits);
    const termsCorrected = rs.flatMap((r) => r.termHitsCorrected);
    const changed = category === 'control' ? `${rs.filter((r) => r.corrections.length).length}/${rs.length}` : '';
    lines.push(`| ${source.label} (${source.kind}) | ${category} | ${pct(errors, refWords)} | ${terms.filter(Boolean).length}/${terms.length} | ${termsCorrected.filter(Boolean).length}/${termsCorrected.length} | ${changed} |`);
  }
}
console.log(lines.join('\n'));
console.log(`\nPer-utterance results: ${path.join(outDir, 'results.json')}`);
