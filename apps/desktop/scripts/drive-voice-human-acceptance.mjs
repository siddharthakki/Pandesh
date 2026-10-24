/**
 * Human Local Voice acceptance harness.
 *
 * Launches ONE portable Desktop on a dedicated CDP port. Does not kill
 * unrelated processes. Refuses to start if the chosen port is already bound
 * (harness failure ≠ product failure).
 *
 * Records product diagnostics from the snapshot (frames, scores, crossings,
 * wakeDetectMs). Never invents wakeDetectMs=0.
 *
 * Human audible confirmation is separate from synthesis/speaking UI:
 *   type HEARD or NOT_HEARD then Enter in this terminal.
 *
 *   node apps/desktop/scripts/drive-voice-human-acceptance.mjs
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const portableRoot = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');
/** Dedicated acceptance port — do not share with screenshot/repro scripts. */
const cdpPort = String(process.env.KARKEDIKHA_VOICE_ACCEPT_CDP_PORT || '9540');
const scratch = process.env.KARKEDIKHA_VOICE_ACCEPT_SCRATCH
  ?? path.join(os.tmpdir(), `karkedikha-voice-accept-${Date.now()}`);
const dataDir = path.join(scratch, 'desktop-data');
const evidencePath = path.join(scratch, 'voice-human-acceptance.json');
const electronExe = path.join(portableRoot, 'electron', 'electron.exe');
const appDir = path.join(portableRoot, 'app');

const evidence = {
  startedAt: new Date().toISOString(),
  portableRoot,
  build: {
    kind: 'portable',
    path: portableRoot,
    version: null,
    productName: null,
    commitHint: null,
  },
  harness: {
    cdpPort,
    note: 'Harness failures (port busy, CDP timeout) are not product voice failures.',
  },
  preservedEvidence: {
    noFolderChat: 'Prior typed no-folder Hello + follow-up completed as chat; mission without folder blocked.',
  },
  checklist: [
    'wake_frames_flowing',
    'wake_phrase_human',
    'ordinary_question_no_folder',
    'audible_answer_human',
    'contextual_follow_up',
    'stop_speaking_button',
  ],
  steps: [],
  timings: {
    wakeDetectMs: null,
    wakeDetectMsSource: null,
    lastInferenceMs: null,
    endOfSpeechToTranscriptMs: null,
    synthesizeMs: null,
    timeToFirstAudibleMs: null,
    audiblePlaybackVerified: false,
    audibleHumanConfirmed: null,
  },
  wakeDiagnosticsSample: null,
  observations: [],
  failures: [],
  harnessFailures: [],
  productFailures: [],
  readyForHuman: false,
  ok: false,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function note(msg, extra = {}) {
  const row = { at: new Date().toISOString(), msg, ...extra };
  evidence.observations.push(row);
  console.log(`[voice-accept] ${msg}`);
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

function harnessFail(msg) {
  evidence.harnessFailures.push({ at: new Date().toISOString(), msg });
  note(`HARNESS FAILURE: ${msg}`);
}

function productFail(msg) {
  evidence.productFailures.push({ at: new Date().toISOString(), msg });
  note(`PRODUCT FAILURE: ${msg}`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(Number(port), '127.0.0.1');
  });
}

async function waitFor(label, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function cdp(method, params = {}) {
  const page = await waitFor('cdp list', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const pages = await res.json();
      return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
    } catch {
      return null;
    }
  }, 120_000);

  if (!cdp.ws) {
    cdp.ws = new WebSocket(page.webSocketDebuggerUrl);
    cdp.nextId = 1;
    cdp.pending = new Map();
    cdp.console = [];
    await new Promise((resolve, reject) => {
      cdp.ws.once('open', resolve);
      cdp.ws.once('error', reject);
    });
    cdp.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params?.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        cdp.console.push({ at: new Date().toISOString(), text });
        const wake = text.match(/wake_detected.*?wakeDetectMs=(\d+|null)/i);
        if (wake && wake[1] !== 'null' && evidence.timings.wakeDetectMs == null) {
          evidence.timings.wakeDetectMs = Number(wake[1]);
          evidence.timings.wakeDetectMsSource = 'console';
        }
        const infer = text.match(/inferenceMs=(\d+)/i);
        if (infer) evidence.timings.lastInferenceMs = Number(infer[1]);
        const synth = text.match(/synthesizeMs=(\d+)/i);
        if (synth) evidence.timings.synthesizeMs = Number(synth[1]);
        const eos = text.match(/Transcript \((\d+) ms\)/i);
        if (eos) evidence.timings.endOfSpeechToTranscriptMs = Number(eos[1]);
        fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      }
      const pending = cdp.pending.get(msg.id);
      if (!pending) return;
      cdp.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
    await cdp('Runtime.enable');
    await cdp('Console.enable').catch(() => undefined);
  }

  const id = cdp.nextId++;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'evaluate failed');
  }
  return result.result?.value;
}

function listenForHumanAudibleConfirm() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    const t = String(line || '').trim().toUpperCase();
    if (t === 'HEARD') {
      evidence.timings.audibleHumanConfirmed = true;
      evidence.timings.audiblePlaybackVerified = true;
      evidence.steps.push({ at: new Date().toISOString(), step: 'audible_human_confirmed', value: true });
      note('Human confirmed audible playback (HEARD).');
    } else if (t === 'NOT_HEARD') {
      evidence.timings.audibleHumanConfirmed = false;
      evidence.timings.audiblePlaybackVerified = false;
      evidence.steps.push({ at: new Date().toISOString(), step: 'audible_human_confirmed', value: false });
      productFail('Human reported NOT_HEARD for spoken reply.');
    }
  });
  return rl;
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  spawnSync(process.execPath, [path.join(desktopRoot, 'scripts', 'voice-human-acceptance-checklist.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (!fs.existsSync(electronExe) || !fs.existsSync(appDir)) {
    harnessFail(`Portable Desktop missing at ${portableRoot}. Rebuild first.`);
    throw new Error(`Portable Desktop missing at ${portableRoot}`);
  }
  if (!(await portFree(cdpPort))) {
    harnessFail(`CDP port ${cdpPort} is busy. Free it or set KARKEDIKHA_VOICE_ACCEPT_CDP_PORT. Not killing other processes.`);
    throw new Error(`CDP port ${cdpPort} busy`);
  }

  const wakeModel = path.join(portableRoot, 'models', 'openwakeword', 'hey_jarvis_v0.1.onnx');
  const piperExe = path.join(portableRoot, 'runtime', 'piper', 'piper.exe');
  if (!fs.existsSync(wakeModel)) throw new Error(`Wake model missing in portable: ${wakeModel}`);
  if (!fs.existsSync(piperExe)) throw new Error(`Piper missing in portable: ${piperExe}`);

  const pkgPath = path.join(appDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    evidence.build.version = pkg.version || null;
    evidence.build.productName = pkg.productName || pkg.name || null;
  }

  note('Launching portable Jarvis Desktop…', { cdpPort, version: evidence.build.version });
  const child = spawn(electronExe, [
    `--remote-debugging-port=${cdpPort}`,
    appDir,
  ], {
    cwd: portableRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: portableRoot,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
      KARKEDIKHA_DESKTOP_MODEL: process.env.KARKEDIKHA_DESKTOP_MODEL || 'qwen2.5-coder:1.5b',
    },
    windowsHide: false,
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    if (/DevTools listening|Electron ready|Error/i.test(text)) process.stderr.write(text);
  });
  evidence.pid = child.pid;

  await waitFor('api', async () => evaluate('Boolean(window.karkedikhaDesktop)'));
  const meta = await evaluate(`window.karkedikhaDesktop.getAppMetadata?.() ?? null`);
  if (meta?.version) evidence.build.version = meta.version;
  if (meta?.productName) evidence.build.productName = meta.productName;

  const snap0 = await waitFor('core connected', async () => {
    const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    return s?.coreState === 'connected' ? s : null;
  }, 120_000);
  note('Core connected', {
    model: snap0.model,
    wake: snap0.wakeWord?.capability,
    tts: snap0.localSpeechResponse?.capability,
    version: evidence.build.version,
  });

  if (snap0.wakeWord?.capability !== 'available') {
    productFail(`Wake word unavailable: ${snap0.wakeWord?.blocker || 'unknown'}`);
    throw new Error(`Wake word unavailable: ${snap0.wakeWord?.blocker || 'unknown'}`);
  }
  if (snap0.localSpeechResponse?.capability !== 'available') {
    productFail(`TTS unavailable: ${snap0.localSpeechResponse?.blocker || 'unknown'}`);
    throw new Error(`TTS unavailable: ${snap0.localSpeechResponse?.blocker || 'unknown'}`);
  }

  // Enable via UI path so renderer starts mic frames (change event).
  await evaluate(`(async () => {
    await window.karkedikhaDesktop.setVoiceMode(true);
    const voiceMode = document.getElementById('voice-mode');
    if (voiceMode) voiceMode.checked = true;
    const wakeEnable = document.getElementById('wake-enable');
    if (!wakeEnable) throw new Error('wake-enable missing');
    if (!wakeEnable.checked) {
      wakeEnable.checked = true;
      wakeEnable.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      await window.karkedikhaDesktop.setWakeWordEnabled(true);
    }
    await new Promise((r) => setTimeout(r, 800));
    return window.karkedikhaDesktop.getSnapshot();
  })()`);

  const snapFrames = await waitFor('mic frames to detector', async () => {
    const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    const frames = s?.wakeDiagnostics?.framesReceived ?? 0;
    const ready = Boolean(s?.wakeDiagnostics?.engineReady);
    const capture = Boolean(s?.wakeDiagnostics?.captureActive);
    if (s?.wakeWord?.enabled && ready && capture && frames > 0) return s;
    return null;
  }, 45_000);

  evidence.wakeDiagnosticsSample = snapFrames.wakeDiagnostics;
  evidence.steps.push({
    at: new Date().toISOString(),
    step: 'wake_frames_flowing',
    framesReceived: snapFrames.wakeDiagnostics?.framesReceived,
    engineReady: snapFrames.wakeDiagnostics?.engineReady,
    captureActive: snapFrames.wakeDiagnostics?.captureActive,
    contextSampleRate: snapFrames.wakeDiagnostics?.contextSampleRate,
    micRms: snapFrames.wakeDiagnostics?.micRms,
  });
  note('Mic frames reaching detector', {
    frames: snapFrames.wakeDiagnostics?.framesReceived,
    rate: snapFrames.wakeDiagnostics?.contextSampleRate,
    micRms: snapFrames.wakeDiagnostics?.micRms,
  });

  const indicator = await evaluate(`document.getElementById('wake-indicator')?.textContent || ''`);
  evidence.readyForHuman = true;
  evidence.evidencePath = evidencePath;
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const rl = listenForHumanAudibleConfirm();

  console.log('\n============================================================');
  console.log('READY FOR HUMAN VOICE ACCEPTANCE');
  console.log('============================================================');
  console.log(`Build: ${evidence.build.productName || 'Jarvis'} v${evidence.build.version || 'unknown'}`);
  console.log(`Portable: ${portableRoot}`);
  console.log(`CDP: ${cdpPort}  |  Evidence: ${evidencePath}`);
  console.log('Wake mic frames are flowing. Voice replies ON. No folder required for chat.');
  console.log('');
  console.log('Do these in order:');
  console.log('  1) Say:  Hey Jarvis');
  console.log('     → UI should show “Hey Jarvis heard” / Wake acknowledged');
  console.log('  2) Ask (no folder):  What is two plus two?');
  console.log('  3) When Jarvis speaks, type HEARD or NOT_HEARD here, then Enter');
  console.log('  4) Follow-up:  And what is that times three?');
  console.log('  5) During the next spoken answer, click Stop speaking');
  console.log('');
  console.log('wakeDetectMs stays null until a real detection (never forced to 0).');
  console.log('============================================================\n');

  const humanDeadline = Date.now() + 12 * 60_000;
  let sawWake = false;
  let sawTranscript = false;
  let sawSpeaking = false;
  let sawNoFolderChat = false;

  while (Date.now() < humanDeadline) {
    const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    const diag = snap?.wakeDiagnostics || null;
    evidence.wakeDiagnosticsSample = diag;
    const transcript = await evaluate(`document.getElementById('voice-transcript')?.textContent || ''`);
    const stopVisible = await evaluate(`!document.getElementById('stop-speaking')?.hidden`);
    const indicatorNow = await evaluate(`document.getElementById('wake-indicator')?.textContent || ''`);
    const ack = await evaluate(`document.querySelector('.app')?.dataset?.wakeAck === '1'`);

    if (diag?.wakeDetectMs != null && evidence.timings.wakeDetectMs == null) {
      evidence.timings.wakeDetectMs = diag.wakeDetectMs;
      evidence.timings.wakeDetectMsSource = 'snapshot.wakeDiagnostics';
    }
    if (diag?.lastInferenceMs != null) evidence.timings.lastInferenceMs = diag.lastInferenceMs;

    if (!sawWake && (diag?.lastDetectedAt || diag?.thresholdCrossings > 0 || ack || /heard/i.test(indicatorNow))) {
      sawWake = true;
      evidence.steps.push({
        at: new Date().toISOString(),
        step: 'wake_phrase_observed',
        indicator: indicatorNow,
        wakeDetectMs: evidence.timings.wakeDetectMs,
        wakeDetectMsSource: evidence.timings.wakeDetectMsSource,
        score: diag?.lastDetectedScore,
        threshold: diag?.threshold,
        framesReceived: diag?.framesReceived,
        peakScore: diag?.peakScore,
        approachCount: diag?.approachCount,
        thresholdCrossings: diag?.thresholdCrossings,
      });
      note('Wake detection observed', {
        wakeDetectMs: evidence.timings.wakeDetectMs,
        score: diag?.lastDetectedScore,
        frames: diag?.framesReceived,
        peak: diag?.peakScore,
      });
    }

    if (!sawTranscript && transcript && /transcript/i.test(transcript)) {
      sawTranscript = true;
      evidence.steps.push({ at: new Date().toISOString(), step: 'transcript_observed', transcript: transcript.slice(0, 240) });
      note('Transcript observed', { transcript: transcript.slice(0, 120) });
    }

    if (!sawNoFolderChat && snap?.interactionMode === 'chat' && !snap?.folder && snap?.lastTurnOutcome === 'completed') {
      sawNoFolderChat = true;
      evidence.steps.push({ at: new Date().toISOString(), step: 'no_folder_chat_completed' });
      note('No-folder chat turn completed');
    }

    if (!sawSpeaking && (snap?.speaking || stopVisible)) {
      sawSpeaking = true;
      evidence.steps.push({
        at: new Date().toISOString(),
        step: 'speaking_ui_observed',
        speaking: Boolean(snap?.speaking),
        stopVisible,
        spokenBargeIn: snap?.speechInterrupt?.spokenBargeIn === true,
        note: 'speaking UI ≠ human-audible confirmation',
      });
      note('Speaking UI observed (not yet human-audible confirmation). Type HEARD or NOT_HEARD.');
      if (snap?.speechInterrupt?.spokenBargeIn === true) {
        productFail('spokenBargeIn claimed true while mic should be suppressed');
      }
    }

    if (sawSpeaking && snap && !snap.speaking && stopVisible === false) {
      const already = evidence.steps.some((s) => s.step === 'stop_playback_observed');
      if (!already) {
        evidence.steps.push({ at: new Date().toISOString(), step: 'stop_playback_observed' });
        note('Playback stopped (speaking cleared). Confirm if that was the Stop button.');
      }
    }

    // If frames die after READY, that is a product regression (not a brief re-arm).
    if (
      snap?.wakeWord?.enabled
      && !snap?.speaking
      && !snap?.running
      && (diag?.framesReceived || 0) === 0
      && diag?.captureActive
      && diag?.monitorStartedAt
    ) {
      const armedAgo = Date.now() - Date.parse(diag.monitorStartedAt);
      if (Number.isFinite(armedAgo) && armedAgo > 8_000) {
        const already = evidence.productFailures.some((f) => /no microphone frames/i.test(f.msg));
        if (!already) {
          productFail('Wake enabled but framesReceived is 0 for >8s after arming.');
        }
      }
    }

    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await sleep(800);
  }

  rl.close();
  note('Human observation window ended. Writing final evidence.');
  if (evidence.timings.wakeDetectMs == null) {
    const peak = evidence.wakeDiagnosticsSample?.peakScore;
    const frames = evidence.wakeDiagnosticsSample?.framesReceived;
    const crosses = evidence.wakeDiagnosticsSample?.thresholdCrossings;
    if ((frames || 0) === 0) {
      productFail('wakeDetectMs null: no mic frames reached detector (detection could not run).');
    } else if ((crosses || 0) === 0) {
      productFail(`wakeDetectMs null: frames flowed (frames=${frames}, peakScore=${peak}) but threshold never crossed — detection failed, not instrumentation miss.`);
    } else {
      harnessFail('wakeDetectMs null despite thresholdCrossings>0 — instrumentation miss.');
    }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = Boolean(
    evidence.timings.wakeDetectMs != null
    && evidence.timings.audibleHumanConfirmed === true
    && evidence.productFailures.length === 0
    && evidence.harnessFailures.length === 0,
  );
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    evidencePath,
    build: evidence.build,
    timings: evidence.timings,
    steps: evidence.steps.map((s) => s.step),
    productFailures: evidence.productFailures,
    harnessFailures: evidence.harnessFailures,
    ok: evidence.ok,
  }, null, 2));

  // Leave the Desktop running for continued human use; do not kill.
  console.log('\nDesktop left running for continued testing. Close the window when finished.');
}

main().catch((err) => {
  harnessFail(String(err?.stack || err));
  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(err);
  process.exit(1);
});
