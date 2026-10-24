/**
 * Verified recovery scenario: the local Core disappears, and the operator
 * gets one honest status and one working "Retry".
 *
 * What it proves, against the REAL desktop app and the REAL Core:
 *
 *   1. The app starts, reaches a connected Core, and says so.
 *   2. The Core process is killed — the way a crash or a rebuild kills it.
 *   3. The UI stops claiming to be "Ready", says the Core is not answering
 *      in plain words, and offers a Retry. It never shows a raw retry
 *      counter.
 *   4. Pressing Retry brings the Core back, and the app returns to
 *      "connected".
 *
 * Isolation: this runs against a scratch data directory, a scratch
 * Electron profile and its own CDP port. The operator's running app, its
 * Core, its conversations and its credentials are never touched.
 *
 * Usage:
 *   node apps/desktop/scripts/verify-core-recovery.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const scratch = path.join(repoRoot, '.tmp', `pandesh-core-recovery-${runId}`);
const dataDir = path.join(scratch, 'data');
const cdpPort = process.env.PANDESH_RECOVERY_CDP_PORT || '9542';
const evidenceDir = path.join(repoRoot, 'dist', 'pandesh-acceptance');
const steps = [];

function record(step, detail) {
  steps.push({ at: new Date().toISOString(), step, ...detail });
  console.log(`[${step}] ${detail.summary ?? ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 120_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = { error: err instanceof Error ? err.message : String(err) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

let cdpSocket;
let cdpId = 1;
const cdpPending = new Map();

async function cdp(method, params = {}) {
  const id = cdpId++;
  return new Promise((resolve, reject) => {
    cdpPending.set(id, { resolve, reject });
    cdpSocket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
  return result.result?.value;
}

function readCorePid() {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
    return typeof record.pid === 'number' ? record.pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function main() {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) throw new Error(`electron missing at ${electronBin}`);

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...childEnv,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
      KARKEDIKHA_DESKTOP_NODE: process.execPath,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
      KARKEDIKHA_DESKTOP_HOST_LOG: path.join(scratch, 'host.log'),
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
  });
  child.unref();
  record('app-launched', { summary: `the isolated app started (pid ${child.pid}), CDP ${cdpPort}`, pid: child.pid });

  try {
    // ── 1. the app reaches a connected Core ──────────────────────────────
    const page = await waitFor('the renderer', async () => {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const pages = await res.json();
      return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
    });
    cdpSocket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdpSocket.once('open', resolve);
      cdpSocket.once('error', reject);
    });
    cdpSocket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      const pending = cdpPending.get(message.id);
      if (!pending) return;
      cdpPending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    await cdp('Runtime.enable');

    const connected = await waitFor('the Core to connect', async () => {
      const snapshot = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      return snapshot?.coreState === 'connected' ? snapshot : null;
    });
    const firstCorePid = readCorePid();
    record('core-connected', { summary: `Core connected (pid ${firstCorePid})`, corePid: firstCorePid, model: connected.model });

    // ── 2. the Core disappears ──────────────────────────────────────────
    if (!firstCorePid) throw new Error('could not read the Core pid from the discovery record');
    spawnSync('taskkill', ['/PID', String(firstCorePid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1500);
    record('core-killed', { summary: `Core ${firstCorePid} was killed, as a crash or a rebuild would kill it`, corePid: firstCorePid });

    // ── 3. the UI tells the truth and offers a Retry ────────────────────
    const honest = await waitFor('the UI to report the lost Core', async () => {
      const state = await evaluate(`(() => ({
        snapshot: window.karkedikhaDesktop.getSnapshot(),
        badge: document.getElementById('core-reactor-badge')?.textContent ?? '',
        desc: document.getElementById('core-reactor-desc')?.textContent ?? '',
        header: document.getElementById('brand-status-text')?.textContent ?? '',
        presence: document.getElementById('panda-presence-label')?.textContent ?? '',
        retryVisible: document.getElementById('core-retry') ? !document.getElementById('core-retry').hidden : false,
      }))()`);
      if (state?.snapshot?.coreState === 'connected') return null;
      return state;
    }, 120_000);
    const detail = String(honest.snapshot?.coreDetail ?? '');
    record('ui-truthful', {
      summary: `the UI says: "${honest.header}" / "${honest.badge}" / "${honest.desc}"`,
      header: honest.header,
      badge: honest.badge,
      desc: honest.desc,
      presence: honest.presence,
      coreState: honest.snapshot?.coreState,
      coreDetail: detail,
      retryVisible: honest.retryVisible,
    });
    if (/\battempt \d+/i.test(detail) || /\d+ms/.test(detail)) {
      throw new Error(`the raw retry counter is still user-visible: "${detail}"`);
    }
    if (!honest.retryVisible) throw new Error('no Retry action was offered');
    if (/ready/i.test(String(honest.presence))) {
      throw new Error(`the panda still claims to be ready: "${honest.presence}"`);
    }

    // ── 4. Retry brings the Core back ───────────────────────────────────
    await evaluate(`document.getElementById('core-retry').click()`);
    const recovered = await waitFor('the Core to come back', async () => {
      const snapshot = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      return snapshot?.coreState === 'connected' ? snapshot : null;
    }, 180_000);
    const secondCorePid = readCorePid();
    record('core-recovered', {
      summary: `Retry re-launched the Core (pid ${secondCorePid}) and the app is connected again`,
      corePid: secondCorePid,
      previousCorePid: firstCorePid,
    });
    if (!secondCorePid || secondCorePid === firstCorePid) {
      throw new Error(`the Core was not re-launched (was ${firstCorePid}, now ${secondCorePid})`);
    }
    if (recovered.coreState !== 'connected') throw new Error('the app did not return to connected');

    const evidence = {
      startedAt: steps[0]?.at,
      finishedAt: new Date().toISOString(),
      cdpPort,
      dataDir: path.relative(repoRoot, dataDir),
      steps,
      passed: true,
    };
    const evidencePath = path.join(evidenceDir, `core-recovery-${runId}.json`);
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\nEvidence: ${path.relative(repoRoot, evidencePath)}`);
    console.log('RECOVERY: PASS');
    return true;
  } finally {
    try { cdpSocket?.close(); } catch { /* ignore */ }
    if (child.pid) {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    // The isolated Core is a child of the app; the tree kill above takes it.
    await sleep(500);
  }
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
  console.error(`\nRECOVERY: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  const evidencePath = path.join(evidenceDir, `core-recovery-${runId}-FAILED.json`);
  fs.writeFileSync(evidencePath, `${JSON.stringify({
    startedAt: steps[0]?.at,
    finishedAt: new Date().toISOString(),
    steps,
    error: err instanceof Error ? err.message : String(err),
    passed: false,
  }, null, 2)}\n`);
  console.error(`Evidence: ${path.relative(repoRoot, evidencePath)}`);
}
process.exit(failure ? 1 : 0);
