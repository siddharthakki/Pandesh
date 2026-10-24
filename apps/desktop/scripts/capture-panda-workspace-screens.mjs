/**
 * Capture the four approved Panda Workspace states from the real desktop app.
 *
 * Everything here runs against the real Electron host, the real KKD Core and
 * the real local model. Isolation is by directory only: a throwaway data dir, a
 * throwaway workspace and a throwaway HOME, so the user's live conversations,
 * workspace and data are never touched.
 *
 *   node apps/desktop/scripts/capture-panda-workspace-screens.mjs [outDir]
 *
 * Writes:
 *   01-home.png      idle Pandesh, suggestions, pinned composer
 *   02-working.png   a live task with real activity events, elapsed time, Stop
 *   03-approval.png  a live governed approval card inside the conversation
 *   04-result.png    a finished task with the delivered file and its controls
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist', 'panda-workspace-screens'));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log('[capture]', ...args);

/** A port the OS says is free right now (dead instances leave zombie listeners). */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-panda-screens-data-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-panda-screens-ws-'));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-panda-screens-home-'));
const cdpPort = Number(process.env.KARKEDIKHA_DESKTOP_CDP_PORT || 0) || (await findFreePort());

// A real file in the isolated workspace, so the agent has something to read.
fs.writeFileSync(path.join(workspace, 'notes.txt'),
  'Panda Workspace notes.\n\nThe launch plan has four states: home, working, result and approval.\nEvery state must be visible in the real application, not in a mock.\n');

fs.mkdirSync(path.join(dataDir, 'electron-profile'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'last-workspace.json'),
  JSON.stringify({ folder: workspace, updatedAt: new Date().toISOString() }));

const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const logPath = path.join(dataDir, 'desktop-host.log');

const child = spawn(electronBin, [
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${path.join(dataDir, 'electron-profile')}`,
  desktopRoot,
], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
    KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath,
    KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
    KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
    KARKEDIKHA_DESKTOP_CDP_PORT: String(cdpPort),
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
  },
});
child.stdout.on('data', (d) => process.stdout.write(`[desktop] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`[desktop-err] ${d}`));

const cleanup = () => {
  try { child.kill(); } catch { /* already gone */ }
  for (const dir of [dataDir, workspace, fakeHome]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};

async function connectCdp(port) {
  const deadline = Date.now() + 60000;
  let page;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && /renderer\/index\.html/.test(p.url ?? ''));
      if (page) break;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  if (!page) throw new Error('the renderer never appeared');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 1;
  const pending = new Map();
  const consoleErrors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const reqId = id++;
    pending.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  return { cdp, ws, consoleErrors };
}

const STATE = `(() => {
  const card = document.getElementById('workspace-task-card');
  const panel = document.getElementById('approval-panel');
  return {
    running: Boolean(window.lastSnapshot?.running),
    attemptId: window.lastSnapshot?.attemptId ?? null,
    outcome: window.lastSnapshot?.lastTurnOutcome ?? null,
    task: window.lastSnapshot?.task ?? null,
    model: window.lastSnapshot?.model ?? null,
    taskCardVisible: Boolean(card && !card.hidden),
    taskCardTitle: document.getElementById('task-card-title')?.textContent ?? '',
    taskCardElapsed: document.getElementById('task-card-elapsed')?.textContent ?? '',
    taskCardSteps: [...document.querySelectorAll('#task-card-steps li')].map((li) => li.textContent),
    approvalVisible: Boolean(panel && !panel.hidden),
    approvalHeading: document.getElementById('approval-heading')?.textContent ?? '',
    approvalTool: document.getElementById('approval-tool')?.textContent ?? '',
    approvalScope: document.getElementById('approval-scope')?.textContent ?? '',
    approvalDetail: (document.getElementById('approval-detail')?.textContent ?? '').slice(0, 220),
    resultCardVisible: !document.getElementById('conversation-results')?.hidden,
    resultCardTitle: document.getElementById('conversation-results-title')?.textContent ?? '',
    resultCardFiles: document.getElementById('conversation-results-files')?.textContent ?? '',
    resultCards: [...document.querySelectorAll('#conversation-results-list .result-card')].map((c) => c.textContent.trim().slice(0, 120)),
    transcript: [...document.querySelectorAll('#result .transcript-body')].map((b) => b.textContent.trim().slice(0, 160)),
    presence: document.getElementById('panda-presence')?.dataset.state ?? '',
    presenceLabel: document.getElementById('panda-presence-label')?.textContent ?? '',
  };
})()`;

async function main() {
  const { cdp, ws, consoleErrors } = await connectCdp(cdpPort);
  log('cdp connected on', cdpPort);
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(`EVAL: ${res.exceptionDetails.text}`);
    return res.result.value;
  };
  const shot = async (name) => {
    const res = await cdp('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    log('saved', file);
  };
  const send = async (text) => {
    await evaluate(`(() => {
      const input = document.getElementById('task-input');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('submit').click();
      return true;
    })()`);
    log('sent:', text.slice(0, 60));
  };
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await evaluate(STATE);
      if (predicate(last)) return last;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
      await sleep(300);
    }
  };

  // The Core and the local model must be live before anything is captured.
  await waitFor(() => evaluate(`(async () => (await window.karkedikhaDesktop.getSnapshot())?.coreState === 'connected')()`),
    90000, 'the Core to connect');
  await waitFor(() => evaluate(`(async () => Boolean((await window.karkedikhaDesktop.getSnapshot())?.model))()`),
    90000, 'the local model to resolve');
  await sleep(2500);

  // ── 1. HOME ──────────────────────────────────────────────────────────
  await shot('01-home.png');
  log('home state:', JSON.stringify(await evaluate(STATE)));

  // ── 2. WORKING ───────────────────────────────────────────────────────
  await send('Read notes.txt in the workspace and then write me a detailed summary of it in a few paragraphs.');
  const working = await waitFor(
    (s) => s.taskCardVisible && (s.taskCardSteps.length > 0 || s.running),
    120000,
    'the task card to appear');
  log('working state:', JSON.stringify(working));
  await shot('02-working.png');

  await waitFor((s) => !s.running, 240000, 'the first turn to finish');
  await sleep(1200);

  // ── 3. APPROVAL ──────────────────────────────────────────────────────
  await send('Search the web for the latest news about local AI models and cite your sources.');
  const approval = await waitFor((s) => s.approvalVisible, 180000, 'the approval card');
  if (!approval.approvalVisible) throw new Error('the approval card was not visible in the conversation');
  const approvalControls = await evaluate(`(() => ({
    heading: document.getElementById('approval-heading')?.textContent ?? '',
    gate: document.getElementById('approval-gate')?.textContent ?? '',
    tool: document.getElementById('approval-tool')?.textContent ?? '',
    scope: document.getElementById('approval-scope')?.textContent ?? '',
    approveDisabled: document.getElementById('approve')?.disabled ?? null,
    rejectDisabled: document.getElementById('reject')?.disabled ?? null,
    insideConversation: Boolean(document.getElementById('approval-panel')?.closest('#assistant-main')),
  }))()`);
  log('approval card is visible and actionable:', JSON.stringify(approvalControls));
  if (approvalControls.approveDisabled || approvalControls.rejectDisabled) {
    throw new Error('the approval card was visible but its controls were disabled');
  }
  if (!approvalControls.insideConversation) throw new Error('the approval card is not inside the conversation');
  log('approval state:', JSON.stringify(approval));
  await shot('03-approval.png');

  // Reject it once (truthfully — the agent is told the request was declined).
  // If the agent asks for the same capability again, stop the task from the
  // inline task card: that ends the turn and exercises the real Stop path.
  await evaluate(`(() => { document.getElementById('reject').click(); return true; })()`);
  let askedAgain = false;
  try {
    const settled = await waitFor((s) => !s.running || s.approvalVisible, 60000, 'the approval turn to settle');
    askedAgain = Boolean(settled.approvalVisible);
  } catch {
    askedAgain = true;
  }
  if (askedAgain) {
    log('the agent asked for the same capability again; stopping the task from the inline task card');
    await evaluate(`(() => { document.getElementById('task-card-stop').click(); return true; })()`);
  }
  await waitFor((s) => !s.running, 120000, 'the approval turn to end');
  await sleep(1200);

  // ── 4. RESULT ────────────────────────────────────────────────────────
  // A fresh conversation keeps this turn independent of the earlier
  // web-research context.
  await evaluate(`(async () => { await window.karkedikhaDesktop.newConversation(); return true; })()`);
  await sleep(1500);
  await send('Create a file named greeting.md in the workspace. Its single line of content should read exactly: Hello from Pandesh.');
  await waitFor((s) => s.running, 60000, 'the file turn to start');
  for (let guard = 0; guard < 4; guard += 1) {
    const settled = await waitFor(
      (s) => !s.running || s.approvalVisible,
      180000,
      'the file turn to settle');
    if (!settled.running) break;
    // The agent asked for a capability again: decline it truthfully and let
    // the turn finish.
    log('the file turn asked for a capability; declining it');
    await evaluate(`(() => { document.getElementById('reject').click(); return true; })()`);
  }
  await waitFor((s) => !s.running, 120000, 'the file turn to finish');
  await sleep(2000);
  try {
    await waitFor((s) => s.resultCardVisible, 30000, 'the result card');
  } catch {
    // The card is reported by the warning below; the screenshot is still taken.
  }
  const result = await evaluate(STATE);
  log('result state:', JSON.stringify(result));
  if (!result.resultCardVisible) {
    log('WARNING: the turn finished without a result card; the transcript was:',
      JSON.stringify(result.transcript));
  }
  await shot('04-result.png');

  // ── 5. STOP VERIFICATION (same isolated instance) ────────────────────
  await send('List every file in the workspace and describe each one in detail, one paragraph each.');
  await waitFor((s) => s.running && s.taskCardVisible, 90000, 'the task to run');
  await evaluate(`(() => { document.getElementById('task-card-stop').click(); return true; })()`);
  await waitFor((s) => !s.running, 120000, 'the task to stop');
  const stopEvidence = await evaluate(`(async () => {
    const s = await window.karkedikhaDesktop.getSnapshot();
    const card = document.getElementById('workspace-task-card');
    return {
      running: s?.running ?? null,
      lastTurnOutcome: s?.lastTurnOutcome ?? null,
      attemptId: s?.attemptId ?? null,
      stopLabel: document.getElementById('task-card-stop')?.querySelector('span')?.textContent ?? '',
      cardHidden: card?.hidden ?? null,
      composerStopHidden: document.getElementById('cancel')?.hidden ?? null,
      error: (document.getElementById('operation-error')?.textContent ?? '').trim(),
    };
  })()`);
  log('stop verification:', JSON.stringify(stopEvidence));
  if (stopEvidence.running) throw new Error('the task was still running after Stop');
  if (stopEvidence.lastTurnOutcome !== 'cancelled' && stopEvidence.lastTurnOutcome !== 'failed') {
    throw new Error(`the stopped task ended as ${stopEvidence.lastTurnOutcome}, not cancelled`);
  }
  if (stopEvidence.composerStopHidden !== true) {
    throw new Error('the composer Stop stayed visible after the task stopped');
  }

  if (consoleErrors.length) log('renderer console errors:', consoleErrors.slice(0, 10));
  ws.close();
}

try {
  await main();
  log('done');
} catch (err) {
  console.error('[capture] FAILED:', err.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
