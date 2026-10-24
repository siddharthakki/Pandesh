/**
 * Packaged Jarvis Command Queue acceptance proof.
 *
 * Launches dist/pandesh-win32-x64 Electron, drives preload APIs via CDP:
 * - Queue three everyday commands; confirm+finish first; edit+confirm second; skip third
 * - Silence/expiry leaves a command waiting (short confirm via env)
 * - Restart same dataDir preserves outcomes without duplicate note execution
 * - Reminder due soon fires while window is hidden to tray (window.close)
 *
 * Usage:
 *   node apps/desktop/scripts/package-portable.mjs
 *   node apps/desktop/scripts/proof-command-queue-packaged.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const portableRoot = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9461';
const scratch = process.env.KARKEDIKHA_CMDQ_PROOF_SCRATCH
  ?? path.join(os.tmpdir(), 'karkedikha-cmdq-packaged-proof');
const dataDir = path.join(scratch, 'desktop-data');
const evidencePath = path.join(scratch, 'command-queue-packaged-proof.json');
const confirmMs = Number(process.env.KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS || '2500');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return result.result?.value;
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // ignore
  }
}

function closeCdp() {
  try {
    cdp.ws?.close();
  } catch {
    // ignore
  }
  cdp.ws = undefined;
}

function launchPortable() {
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
      KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
      KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS: String(confirmMs),
    },
    windowsHide: false,
  });
  child.unref();
  return { pid: child.pid, logPath };
}

async function waitCoreConnected() {
  await waitFor('desktop api', async () => evaluate('Boolean(window.karkedikhaDesktop)'));
  return waitFor('core connected', async () => {
    const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    return snap?.coreState === 'connected' ? snap : null;
  }, 120_000);
}

async function queueSnapshot() {
  const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
  return snap?.commandQueue ?? null;
}

async function refreshQueue() {
  return evaluate('window.karkedikhaDesktop.refreshCommandQueue()');
}

async function offerNext() {
  return evaluate('window.karkedikhaDesktop.offerNextCommand()');
}

async function waitConfirming(label) {
  return waitFor(label, async () => {
    await offerNext();
    const q = await queueSnapshot();
    return q?.confirming?.confirmationToken ? q.confirming : null;
  }, 60_000);
}

async function confirmRun(item) {
  const expr = `window.karkedikhaDesktop.confirmCommandRun(${JSON.stringify(item.id)}, ${JSON.stringify(item.confirmationToken)}, ${Number(item.revision)})`;
  return evaluate(expr);
}

async function main() {
  if (!fs.existsSync(path.join(portableRoot, 'Launch-Pandesh.cmd'))) {
    throw new Error(`Portable build not found at ${portableRoot}. Run: node apps/desktop/scripts/package-portable.mjs`);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  const evidence = {
    startedAt: new Date().toISOString(),
    portableRoot,
    dataDir,
    confirmMs,
    steps: [],
    ok: false,
  };

  let pid;
  try {
    const launch = launchPortable();
    pid = launch.pid;
    evidence.pid = pid;
    evidence.logPath = launch.logPath;
    evidence.steps.push({ at: new Date().toISOString(), step: 'launched' });

    await waitCoreConnected();
    evidence.steps.push({ at: new Date().toISOString(), step: 'core-connected' });

    const aText = 'Remember that my printer uses A4';
    const bText = 'Remind me in two minutes to check the oven';
    const cText = 'Remember that the gate code is 1234';

    await evaluate(`window.karkedikhaDesktop.enqueueCommand(${JSON.stringify(aText)})`);
    await evaluate(`window.karkedikhaDesktop.enqueueCommand(${JSON.stringify(bText)})`);
    await evaluate(`window.karkedikhaDesktop.enqueueCommand(${JSON.stringify(cText)})`);
    evidence.steps.push({ at: new Date().toISOString(), step: 'enqueued-three' });

    const confirmA = await waitConfirming('confirm A');
    if (!String(confirmA.instruction).includes('printer')) {
      throw new Error(`expected first confirming to be A, got ${confirmA.instruction}`);
    }
    await confirmRun(confirmA);
    evidence.steps.push({ at: new Date().toISOString(), step: 'completed-first', id: confirmA.id });

    let q = await queueSnapshot();
    const waitingB = (q.confirming && String(q.confirming.instruction).includes('oven'))
      ? q.confirming
      : (q.waiting || []).find((item) => String(item.instruction).includes('oven'));
    if (!waitingB) throw new Error(`second command missing after first completed: ${JSON.stringify(q)}`);
    await evaluate(
      `window.karkedikhaDesktop.editQueuedCommand(${JSON.stringify(waitingB.id)}, ${JSON.stringify('Remind me in three minutes to check the oven')})`,
    );
    evidence.steps.push({ at: new Date().toISOString(), step: 'edited-second', id: waitingB.id });

    const confirmB = await waitConfirming('confirm B');
    if (!String(confirmB.instruction).includes('three minutes')) {
      throw new Error(`expected edited B confirming, got ${confirmB.instruction}`);
    }
    await confirmRun(confirmB);
    evidence.steps.push({ at: new Date().toISOString(), step: 'completed-second', id: confirmB.id });

    q = await queueSnapshot();
    const waitingC = (q.confirming && String(q.confirming.instruction).includes('gate code'))
      ? q.confirming
      : (q.waiting || []).find((item) => String(item.instruction).includes('gate code'));
    if (!waitingC || !String(waitingC.instruction).includes('gate code')) {
      throw new Error(`third command not found to skip: ${JSON.stringify(q)}`);
    }
    await evaluate(`window.karkedikhaDesktop.skipCommand(${JSON.stringify(waitingC.id)})`);
    evidence.steps.push({ at: new Date().toISOString(), step: 'skipped-third', id: waitingC.id });

    q = await refreshQueue().then(() => queueSnapshot());
    const terminal = (q.recentTerminal || []).map((t) => t.status).sort();
    if (!terminal.includes('completed') || !terminal.includes('skipped')) {
      throw new Error(`unexpected terminal statuses: ${JSON.stringify(terminal)}`);
    }

    // Silence: offer confirm, wait past expiry, must return to waiting (no execute).
    const silentText = 'Remember that silence must not run';
    await evaluate(`window.karkedikhaDesktop.enqueueCommand(${JSON.stringify(silentText)})`);
    const silentConfirm = await waitConfirming('confirm silent');
    evidence.steps.push({
      at: new Date().toISOString(),
      step: 'silence-confirming',
      id: silentConfirm.id,
      expiresAt: silentConfirm.confirmationExpiresAt,
    });
    await sleep(confirmMs + 1_500);
    await refreshQueue();
    q = await queueSnapshot();
    if (q.confirming?.id === silentConfirm.id) {
      throw new Error('silence confirmation did not expire');
    }
    const silentWaiting = (q.waiting || []).find((item) => item.id === silentConfirm.id);
    if (!silentWaiting || silentWaiting.status !== 'waiting') {
      throw new Error(`silence item not waiting after expiry: ${JSON.stringify(q)}`);
    }
    evidence.steps.push({ at: new Date().toISOString(), step: 'silence-left-waiting', id: silentConfirm.id });

    const notesBeforeRestart = await evaluate(`(() => {
      const snap = window.__lastSnap || null;
      return window.karkedikhaDesktop.getSnapshot().then((s) => (s.everydayTools?.notes || []).map((n) => n.body));
    })()`);
    const printerNotes = (notesBeforeRestart || []).filter((b) => String(b).includes('printer uses A4'));
    if (printerNotes.length !== 1) {
      throw new Error(`expected exactly one printer note before restart, got ${printerNotes.length}`);
    }
    evidence.notesBeforeRestart = printerNotes.length;

    // Restart: kill Electron, relaunch same dataDir.
    closeCdp();
    killPid(pid);
    await sleep(2_000);
    pid = undefined;

    const relaunch = launchPortable();
    pid = relaunch.pid;
    evidence.relaunchPid = pid;
    await waitCoreConnected();
    evidence.steps.push({ at: new Date().toISOString(), step: 'restarted-core-connected' });

    q = await refreshQueue().then(() => queueSnapshot());
    const silentAfter = (q.waiting || []).find((item) => String(item.instruction).includes('silence must not run'));
    if (!silentAfter) throw new Error('silence waiting item missing after restart');
    const completedAfter = (q.recentTerminal || []).filter((t) => t.status === 'completed');
    if (completedAfter.length < 2) {
      throw new Error(`expected >=2 completed after restart, got ${completedAfter.length}`);
    }
    const notesAfter = await evaluate(
      'window.karkedikhaDesktop.getSnapshot().then((s) => (s.everydayTools?.notes || []).filter((n) => String(n.body).includes("printer uses A4")).length)',
    );
    if (notesAfter !== 1) {
      throw new Error(`duplicate note execution after restart: printer notes=${notesAfter}`);
    }
    evidence.steps.push({
      at: new Date().toISOString(),
      step: 'restart-preserved',
      waitingSilent: true,
      printerNotes: notesAfter,
      completed: completedAfter.length,
    });

    // Reminder while window hidden.
    const dueAt = new Date(Date.now() + 4_000).toISOString();
    const afterReminder = await evaluate(
      `window.karkedikhaDesktop.createReminder(${JSON.stringify({ title: 'packaged queue proof oven check', dueAt })})`,
    );
    const reminderId = (afterReminder?.everydayTools?.reminders || [])
      .find((r) => String(r.title).includes('packaged queue proof'))?.id
      ?? null;
    evidence.steps.push({ at: new Date().toISOString(), step: 'reminder-scheduled', dueAt, reminderId });

    // Hide to tray via window close (main prevents quit). CDP page goes away.
    await evaluate('window.close()');
    evidence.steps.push({ at: new Date().toISOString(), step: 'window-hidden-to-tray' });
    closeCdp();

    const notifiedLine = await waitFor('reminder host-log while hidden', async () => {
      if (!fs.existsSync(launch.logPath) && !fs.existsSync(relaunch.logPath)) return null;
      const logText = [
        fs.existsSync(relaunch.logPath) ? fs.readFileSync(relaunch.logPath, 'utf8') : '',
        fs.existsSync(launch.logPath) ? fs.readFileSync(launch.logPath, 'utf8') : '',
      ].join('\n');
      const hit = logText.split(/\r?\n/).reverse().find((line) => {
        if (!/everyday reminder notified/i.test(line)) return false;
        if (reminderId && line.includes(reminderId)) return true;
        return /everyday reminder notified/i.test(line);
      });
      return hit || null;
    }, 30_000);
    evidence.steps.push({
      at: new Date().toISOString(),
      step: 'reminder-fired-while-hidden',
      logLine: notifiedLine,
      reminderId,
    });

    evidence.ok = true;
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, evidencePath, steps: evidence.steps.map((s) => s.step) }, null, 2));
  } catch (err) {
    evidence.ok = false;
    evidence.error = err instanceof Error ? err.message : String(err);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.error(evidence.error);
    process.exitCode = 1;
  } finally {
    closeCdp();
    killPid(pid);
  }
}

await main();
