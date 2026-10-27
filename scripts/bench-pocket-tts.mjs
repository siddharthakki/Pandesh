/**
 * Live Pocket TTS benchmark against the staged runtime/pocket-tts (never touches the real Pandesh data dir).
 *   node scripts/bench-pocket-tts.mjs [--qwen qwen3.8:27b-mtp-q4_K_M] [--out result.json]
 * Measures: cold start, short-response latency, repeated conversation, cancel, crash recovery,
 * and TTS latency + Qwen throughput while Qwen is generating on the GPU.
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const qwenModel = arg('--qwen', 'qwen3.8:27b-mtp-q4_K_M');
const outFile = arg('--out', '');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-bench-'));
const bundle = path.join(work, 'pocketTts.cjs');
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'apps', 'desktop', 'src', 'host', 'pocketTts.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
});
const { PocketTtsEngine, PocketTtsCancelled } = (await import(pathToFileURL(bundle).href)).default;

const dataDir = path.join(work, 'data');
const logs = [];
const engine = new PocketTtsEngine({ productRoot: repoRoot, dataDir, log: (l) => logs.push(l) });

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stats = (xs) => ({ n: xs.length, min: Math.min(...xs), p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: Math.max(...xs) });
const audioSec = (wav) => (wav.length - 44) / 48000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout.trim();
const rssMb = (pid) => Number(ps(`(Get-Process -Id ${pid}).WorkingSet64/1MB`)).valueOf();
const cpuSec = (pid) => Number(ps(`(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`));
const gpu = () => {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).stdout.trim().split(',').map(Number);
  const apps = spawnSync('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).stdout;
  return { memMiB: r[0], utilPct: r[1], computeApps: apps.trim().split(/\r?\n/).filter(Boolean) };
};

const SHORT = ['Sure, done.', 'Okay, I will do that now.', 'Your meeting is at three o clock.', 'I found two files that match.',
  'The build passed and all tests are green.', 'Sorry, I could not reach the server.', 'Good morning. What would you like to do first?', 'Reminder set for tomorrow at nine.'];
const LONG = 'Here is a longer answer. '.repeat(14);

const result = {};
try {
  // 1. Cold start + first short utterance (provisioning verify included).
  const t0 = Date.now();
  const first = await engine.synthesize(SHORT[0]);
  result.cold = { requestToAudioMs: Date.now() - t0, startMs: first.startMs, firstAudioMs: first.firstAudioMs, totalMs: first.totalMs, audioSec: audioSec(first.wav) };
  const pid = engine.pid;
  result.engineRssMbAfterColdStart = rssMb(pid);

  // 2. Warm short responses.
  const warm = [];
  for (let r = 0; r < 3; r += 1) for (const s of SHORT) {
    const x = await engine.synthesize(s);
    warm.push({ firstAudioMs: x.firstAudioMs, totalMs: x.totalMs, audioSec: audioSec(x.wav) });
  }
  result.warmShort = { firstAudioMs: stats(warm.map((w) => w.firstAudioMs)), totalMs: stats(warm.map((w) => w.totalMs)),
    realtimeFactor: stats(warm.map((w) => w.totalMs / 1000 / w.audioSec)), audioSec: stats(warm.map((w) => w.audioSec)) };

  // 3. Repeated conversation: 60 sequential turns of mixed length, watching memory.
  const rssBefore = rssMb(pid);
  const turns = [];
  for (let i = 0; i < 60; i += 1) {
    const text = i % 6 === 5 ? LONG : SHORT[i % SHORT.length];
    const x = await engine.synthesize(text);
    turns.push({ long: text === LONG, totalMs: x.totalMs, firstAudioMs: x.firstAudioMs });
  }
  result.repeated = { turns: turns.length, startsDuringRun: engine.starts, rssMbBefore: rssBefore, rssMbAfter: rssMb(pid),
    shortFirstAudioMs: stats(turns.filter((t) => !t.long).map((t) => t.firstAudioMs)),
    longTotalMs: stats(turns.filter((t) => t.long).map((t) => t.totalMs)) };

  // 4. Cancel: interrupt a long reply, then speak immediately.
  const cancelRuns = [];
  for (let i = 0; i < 5; i += 1) {
    const p = engine.synthesize(LONG).then(() => 'completed', (e) => (e instanceof PocketTtsCancelled ? 'cancelled' : `error:${e.message}`));
    await sleep(150);
    const c0 = Date.now();
    engine.cancel();
    const outcome = await p;
    const cancelMs = Date.now() - c0;
    const cpuA = cpuSec(engine.pid); await sleep(1000); const cpuB = cpuSec(engine.pid);
    const next = await engine.synthesize(SHORT[1]);
    cancelRuns.push({ outcome, cancelMs, engineCpuSecIdleAfterCancel: +(cpuB - cpuA).toFixed(2), nextFirstAudioMs: next.firstAudioMs, nextTotalMs: next.totalMs });
  }
  result.cancel = cancelRuns;

  // 5. Crash/restart: kill while idle, then kill mid-synthesis.
  const crash = [];
  const killedPid = engine.pid;
  spawnSync('taskkill', ['/PID', String(killedPid), '/T', '/F'], { windowsHide: true });
  await sleep(300);
  let c0 = Date.now();
  let x = await engine.synthesize(SHORT[2]);
  crash.push({ scenario: 'killed while idle', recoveredInMs: Date.now() - c0, newPid: engine.pid !== killedPid, audioSec: audioSec(x.wav) });
  const p2 = engine.synthesize(LONG);
  await sleep(150);
  c0 = Date.now();
  spawnSync('taskkill', ['/PID', String(engine.pid), '/T', '/F'], { windowsHide: true });
  x = await p2;
  crash.push({ scenario: 'killed mid-synthesis', recoveredInMs: Date.now() - c0, audioSec: audioSec(x.wav), starts: engine.starts });
  result.crash = crash;

  // 6. Concurrent Qwen inference: baseline vs. with TTS, GPU residency.
  const qwen = async () => {
    const t = Date.now();
    const res = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({
      model: qwenModel, prompt: 'Write a detailed explanation of how a hash map handles collisions, with examples.', stream: false,
      options: { num_predict: 400, temperature: 0 }, keep_alive: '10m', think: false }) });
    const j = await res.json();
    return { wallMs: Date.now() - t, tokens: j.eval_count, tokPerSec: +(j.eval_count / (j.eval_duration / 1e9)).toFixed(1), loadMs: Math.round((j.load_duration ?? 0) / 1e6) };
  };
  const ollamaUp = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (!ollamaUp) { result.qwen = { skipped: 'ollama not reachable' }; }
  else {
    await qwen(); // load model into VRAM
    const baseline = await qwen();
    const gpuIdle = gpu();
    const ttsDuring = [];
    let stop = false;
    const loop = (async () => { let i = 0; while (!stop) { const y = await engine.synthesize(SHORT[i++ % SHORT.length]); ttsDuring.push(y.firstAudioMs); ttsDuring.total = (ttsDuring.total ?? []); ttsDuring.total.push(y.totalMs); await sleep(300); } })();
    await sleep(500);
    const gpuSamples = [];
    const sampler = (async () => { while (!stop) { gpuSamples.push(gpu()); await sleep(1000); } })();
    const withTts = await qwen();
    stop = true; await Promise.all([loop, sampler]);
    result.qwen = { model: qwenModel, baseline, withConcurrentTts: withTts,
      qwenSlowdownPct: +(((baseline.tokPerSec - withTts.tokPerSec) / baseline.tokPerSec) * 100).toFixed(1),
      ttsFirstAudioMsDuringQwen: stats(ttsDuring.slice()), ttsTotalMsDuringQwen: stats(ttsDuring.total),
      gpuMemMiBIdleAfterQwenLoad: gpuIdle.memMiB, gpuMemMiBMaxDuringRun: Math.max(...gpuSamples.map((g) => g.memMiB)),
      pocketPidOnGpu: gpuSamples.some((g) => g.computeApps.some((a) => a.startsWith(`${engine.pid},`))) };
  }
} finally {
  await engine.dispose();
}
result.log = logs;
const json = JSON.stringify(result, null, 2);
if (outFile) fs.writeFileSync(outFile, json);
console.log(json);
