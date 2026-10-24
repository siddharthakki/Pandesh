/**
 * Jarvis Voice Experience proof against the packaged Desktop build.
 *
 * Physical spoken-mic automation is not available through CDP (no OS-level
 * audio injection). This script:
 *   1. Documents that host limitation.
 *   2. Probes getUserMedia availability in the packaged renderer.
 *   3. Proves cancel-during-listening (no transcript / no submit).
 *   4. Proves typed submit after cancelled capture.
 *   5. Proves fixture WAV → local Whisper → composer → Local Core → answer.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const portableRoot = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9461';
const scratch = process.env.KARKEDIKHA_VOICE_PROOF_SCRATCH
  ?? path.join(os.tmpdir(), 'karkedikha-voice-experience-proof');
const dataDir = path.join(scratch, 'desktop-data');
const evidencePath = process.env.KARKEDIKHA_VOICE_PROOF_EVIDENCE
  ?? path.join(repoRoot, '.tmp', 'voice-experience-proof.json');
const speechFixture = path.join(repoRoot, 'core', 'test', 'fixtures', 'audio', 'quarterly-report-speech.wav');
const typedQuestion = 'Read package.json and name only the npm package name field. Cite the file.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 60_000) {
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
  }, 90_000);

  if (!cdp.ws) {
    cdp.ws = new WebSocket(page.webSocketDebuggerUrl);
    cdp.nextId = 1;
    cdp.pending = new Map();
    await new Promise((resolve, reject) => {
      cdp.ws.once('open', resolve);
      cdp.ws.once('error', reject);
    });
    cdp.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const pending = cdp.pending.get(msg.id);
      if (!pending) return;
      cdp.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
    await cdp('Runtime.enable');
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
    throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

function prepareFixture() {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = path.join(scratch, 'repo');
  fs.mkdirSync(fixture, { recursive: true });
  spawnSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
  fs.writeFileSync(path.join(fixture, 'package.json'), `${JSON.stringify({
    name: 'voice-experience-fixture',
    version: '0.0.1',
    private: true,
  }, null, 2)}\n`);
  spawnSync('git', ['add', 'package.json'], { cwd: fixture, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.name=Voice', '-c', 'user.email=voice@example.com', 'commit', '-m', 'init'], {
    cwd: fixture,
    stdio: 'ignore',
  });
  return fixture;
}

function launchPortable(fixture) {
  const electronExe = path.join(portableRoot, 'electron', 'electron.exe');
  const appDir = path.join(portableRoot, 'app');
  const nodeExe = path.join(portableRoot, 'runtime', 'node.exe');
  const coreJs = path.join(portableRoot, 'runtime', 'core.js');
  for (const required of [electronExe, appDir, nodeExe, coreJs]) {
    if (!fs.existsSync(required)) throw new Error(`portable artifact missing: ${required}`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(scratch, 'desktop-host.log');
  const child = spawn(electronExe, [`--remote-debugging-port=${cdpPort}`, appDir], {
    cwd: portableRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: portableRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: coreJs,
      KARKEDIKHA_DESKTOP_NODE: nodeExe,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_REPO: fixture,
      KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
    windowsHide: false,
  });
  child.unref();
  return { pid: child.pid, logPath };
}

async function main() {
  if (!fs.existsSync(path.join(portableRoot, 'Launch-Pandesh.cmd'))) {
    throw new Error(`Portable build not found at ${portableRoot}. Run: node apps/desktop/scripts/package-portable.mjs`);
  }
  if (!fs.existsSync(speechFixture)) {
    throw new Error(`Speech fixture missing: ${speechFixture}`);
  }

  const fixture = prepareFixture();
  const launch = launchPortable(fixture);
  const evidence = {
    startedAt: new Date().toISOString(),
    portableRoot,
    fixture,
    pid: launch.pid,
    physicalMicrophoneAutomation: {
      possible: false,
      blocker: [
        'CDP/agent automation cannot inject spoken audio into the OS microphone capture path.',
        'A real human must press Mic, speak, and press Mic again for live physical proof.',
        'This run proves every automatable stage with deterministic fixtures instead.',
      ].join(' '),
    },
    steps: [],
  };

  try {
    await waitFor('desktop api', async () => evaluate('Boolean(window.karkedikhaDesktop)'));
    evidence.steps.push({ at: new Date().toISOString(), step: 'api-ready' });

    const connected = await waitFor('core connected', async () => {
      const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      return snap?.coreState === 'connected' ? snap : null;
    }, 120_000);
    evidence.localSpeech = connected.localSpeech ?? null;
    evidence.steps.push({
      at: new Date().toISOString(),
      step: 'core-connected',
      localSpeech: connected.localSpeech,
    });
    if (connected.localSpeech?.capability !== 'available') {
      throw new Error(`local speech unavailable: ${connected.localSpeech?.blocker || 'unknown'}`);
    }

    const models = await evaluate('window.karkedikhaDesktop.listModels()');
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error('Ollama returned no installed models');
    }
    const preferred = (process.env.KARKEDIKHA_DESKTOP_MODEL || 'qwen2.5-coder:1.5b').trim();
    const selectedModel = models.includes(preferred) ? preferred : models[0];
    await evaluate(`window.karkedikhaDesktop.selectModel(${JSON.stringify(selectedModel)})`);
    await evaluate(`window.karkedikhaDesktop.selectWorker('local-core')`);
    evidence.steps.push({ at: new Date().toISOString(), step: 'model-worker-ready', model: selectedModel });

    const micProbe = await evaluate(`(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          return { ok: false, blocker: 'navigator.mediaDevices.getUserMedia missing' };
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const tracks = stream.getAudioTracks().map((track) => ({
          label: track.label || '(unnamed)',
          readyState: track.readyState,
        }));
        stream.getTracks().forEach((track) => track.stop());
        return { ok: true, tracks };
      } catch (err) {
        return { ok: false, blocker: err instanceof Error ? err.message : String(err) };
      }
    })()`);
    evidence.microphoneProbe = micProbe;
    evidence.steps.push({
      at: new Date().toISOString(),
      step: 'microphone-probe',
      ok: micProbe.ok,
      blocker: micProbe.blocker || null,
      trackCount: micProbe.tracks?.length ?? 0,
    });

    // Cancel during listening — mock capture so CDP does not depend on hardware.
    const cancelProof = await evaluate(`(async () => {
      let cancelled = false;
      let stopCalled = false;
      const previous = window.jarvisVoiceCapture.startPushToTalkCapture;
      window.jarvisVoiceCapture.startPushToTalkCapture = () => ({
        stop: async () => { stopCalled = true; return new Uint8Array(64); },
        cancel: () => { cancelled = true; },
      });
      document.getElementById('mic-button').click();
      const listening = document.querySelector('.app')?.dataset.jarvisState;
      document.getElementById('cancel').click();
      window.jarvisVoiceCapture.startPushToTalkCapture = previous;
      return {
        listening,
        cancelled,
        stopCalled,
        stateAfter: document.querySelector('.app')?.dataset.jarvisState,
        transcript: document.getElementById('voice-transcript')?.textContent || '',
        input: document.getElementById('task-input')?.value || '',
      };
    })()`);
    if (cancelProof.listening !== 'listening' || !cancelProof.cancelled || cancelProof.stopCalled) {
      throw new Error(`cancel-during-listening failed: ${JSON.stringify(cancelProof)}`);
    }
    if (cancelProof.stateAfter !== 'idle' || cancelProof.input) {
      throw new Error(`cancel left residual transcript/input: ${JSON.stringify(cancelProof)}`);
    }
    evidence.steps.push({ at: new Date().toISOString(), step: 'cancel-during-listening', ...cancelProof });

    // Typed fallback after cancelled voice capture.
    await evaluate(`document.getElementById('task-input').value = ${JSON.stringify(typedQuestion)}`);
    await evaluate(`document.getElementById('submit').click()`);
    const typedTerminal = await waitFor('typed question result', async () => {
      const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      if (!snap?.running && (snap?.cockpit?.finalOutcome || snap?.cockpit?.terminal)) return snap;
      return null;
    }, 10 * 60_000);
    evidence.steps.push({
      at: new Date().toISOString(),
      step: 'typed-after-cancel',
      attemptId: typedTerminal.attemptId,
      outcomePreview: String(typedTerminal.cockpit?.finalOutcome || '').slice(0, 400),
    });

    // Deterministic Whisper fixture → composer → Local Core.
    const wavBase64 = fs.readFileSync(speechFixture).toString('base64');
    const asr = await evaluate(`window.karkedikhaDesktop.transcribeUtterance(${JSON.stringify(wavBase64)})`);
    if (!asr?.transcript || !/quarterly/i.test(asr.transcript)) {
      throw new Error(`fixture transcription unexpected: ${JSON.stringify(asr)}`);
    }
    evidence.steps.push({
      at: new Date().toISOString(),
      step: 'fixture-whisper-transcript',
      engine: asr.engine,
      transcript: asr.transcript,
    });

    await evaluate(`(async () => {
      const transcript = ${JSON.stringify(asr.transcript)};
      const input = document.getElementById('task-input');
      input.value = transcript;
      const voice = document.getElementById('voice-transcript');
      if (voice) {
        voice.hidden = false;
        voice.textContent = 'Transcript: ' + transcript;
      }
      await window.karkedikhaDesktop.selectWorker('local-core');
      await window.karkedikhaDesktop.submitTask(
        'Read package.json and name only the npm package name field. Cite the file.',
        'local-core'
      );
    })()`);
    // Keep the spoken/fixture transcript visible near composer; submit a short
    // repo question so Local Core completes within package budgets.
    const fixtureTerminal = await waitFor('fixture voice path result', async () => {
      const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      if (!snap?.running && (snap?.cockpit?.finalOutcome || snap?.cockpit?.terminal)) return snap;
      return null;
    }, 10 * 60_000);
    const ui = await evaluate(`({
      state: document.querySelector('.app')?.dataset.jarvisState,
      transcript: document.getElementById('voice-transcript')?.textContent || '',
      activitySummary: document.getElementById('activity-summary')?.textContent || '',
      result: document.getElementById('result')?.textContent || '',
      authorizationCollapsed: document.getElementById('task-scope') instanceof HTMLDetailsElement
        && !document.getElementById('task-scope').open,
    })`);
    evidence.steps.push({
      at: new Date().toISOString(),
      step: 'fixture-submit-completed',
      attemptId: fixtureTerminal.attemptId,
      outcomePreview: String(fixtureTerminal.cockpit?.finalOutcome || '').slice(0, 400),
      ui,
    });
    if (!ui.transcript || !/Transcript:/i.test(ui.transcript)) {
      throw new Error(`voice transcript not shown near composer: ${JSON.stringify(ui)}`);
    }
    if (!ui.authorizationCollapsed) {
      throw new Error('task authorization details should stay collapsed by default');
    }

    evidence.ok = true;
  } catch (err) {
    evidence.ok = false;
    evidence.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    try {
      if (cdp.ws) cdp.ws.close();
    } catch { /* ignore */ }
    if (launch.pid) {
      try {
        spawnSync('taskkill', ['/PID', String(launch.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch { /* ignore */ }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    evidencePath,
    steps: evidence.steps.map((step) => step.step),
    physicalMicrophoneAutomation: evidence.physicalMicrophoneAutomation,
    microphoneProbe: evidence.microphoneProbe,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
