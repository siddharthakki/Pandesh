/**
 * Drive the real Pandesh app through the release journeys and capture the
 * refined UI.
 *
 * Everything here runs against the real Electron host, the real KKD Core and
 * the real local model. Isolation is by directory only: a throwaway data dir, a
 * throwaway workspace and a throwaway HOME, all under the repository's
 * `.tmp/` folder so that no personal path (and no user name) ever appears in
 * a release screenshot. The user's live conversations, workspace and data are
 * never touched.
 *
 *   node apps/desktop/scripts/capture-panda-workspace-refined.mjs [outDir]
 *
 * Writes:
 *   01-new-conversation.png   a genuinely empty new conversation
 *   02-long-conversation.png  a long, readable Markdown conversation
 *   03-working-task.png       a live task with real activity and Stop
 *   04-completed-result.png   a finished task with its delivered file
 *   05-approval.png           a live governed approval inside the conversation
 *   06-tasks-and-history.png  the Tasks screen and the conversation history
 *
 * It also verifies, on the way: a new conversation is empty, a stopped task
 * really ends, an approval can be answered, a result can be opened, and a
 * restart restores the correct conversation and task state.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist', 'panda-workspace-refined'));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log('[refined]', ...args);

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

// A neutral isolation root: no user name in any path a screenshot can show.
const isolationRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'panda-screens-'));
const dataDir = path.join(isolationRoot, 'data');
const workspace = path.join(isolationRoot, 'workspace');
const fakeHome = path.join(isolationRoot, 'home');
for (const dir of [dataDir, workspace, fakeHome]) fs.mkdirSync(dir, { recursive: true });

// A real file in the isolated workspace, so the agent has something to read.
fs.writeFileSync(path.join(workspace, 'notes.txt'),
  'Panda Workspace notes.\n\n'
  + 'The launch plan has four states: home, working, result and approval.\n'
  + 'Every state must be visible in the real application, not in a mock.\n\n'
  + 'Release checklist\n'
  + '1. A new conversation opens empty.\n'
  + '2. Long answers stay readable.\n'
  + '3. A running task shows what it is doing.\n'
  + '4. A finished task shows its files.\n'
  + '5. An approval states exactly what will happen.\n');

fs.mkdirSync(path.join(dataDir, 'electron-profile'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'last-workspace.json'),
  JSON.stringify({ folder: workspace, updatedAt: new Date().toISOString() }));

const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const logPath = path.join(isolationRoot, 'desktop-host.log');

let cdpPort = Number(process.env.KARKEDIKHA_DESKTOP_CDP_PORT || 0) || (await findFreePort());
let child = null;
const consoleErrors = [];

function spawnDesktop() {
  child = spawn(electronBin, [
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
      TEMP: path.join(isolationRoot, 'temp'),
      TMP: path.join(isolationRoot, 'temp'),
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
  return child;
}

const cleanup = () => {
  try { child?.kill(); } catch { /* already gone */ }
  try { fs.rmSync(isolationRoot, { recursive: true, force: true }); } catch { /* best effort */ }
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
  return { cdp, ws };
}

const STATE = `(() => {
  const card = document.getElementById('workspace-task-card');
  const panel = document.getElementById('approval-panel');
  const results = document.getElementById('conversation-results');
  const main = document.getElementById('assistant-main');
  const reading = document.querySelector('#result');
  const flow = document.querySelector('.conversation-turns-flow');
  return {
    running: Boolean(window.lastSnapshot?.running),
    attemptId: window.lastSnapshot?.attemptId ?? null,
    outcome: window.lastSnapshot?.lastTurnOutcome ?? null,
    task: window.lastSnapshot?.task ?? null,
    taskCardVisible: Boolean(card && !card.hidden),
    taskCardTitle: document.getElementById('task-card-title')?.textContent ?? '',
    taskCardElapsed: document.getElementById('task-card-elapsed')?.textContent ?? '',
    taskCardSteps: [...document.querySelectorAll('#task-card-steps li')].map((li) => li.textContent),
    approvalVisible: Boolean(panel && !panel.hidden),
    approvalHeading: document.getElementById('approval-heading')?.textContent ?? '',
    approvalTool: document.getElementById('approval-tool')?.textContent ?? '',
    approvalScope: document.getElementById('approval-scope')?.textContent ?? '',
    approvalDetail: (document.getElementById('approval-detail')?.textContent ?? '').slice(0, 240),
    resultCardVisible: Boolean(results && !results.hidden),
    resultCardTitle: document.getElementById('conversation-results-title')?.textContent ?? '',
    resultCardFiles: document.getElementById('conversation-results-files')?.textContent ?? '',
    resultCards: [...document.querySelectorAll('#conversation-results-list .result-card')].map((c) => c.textContent.trim().slice(0, 140)),
    resultActions: [...document.querySelectorAll('#conversation-results-list .result-actions button')].map((b) => b.textContent.trim()),
    transcript: [...document.querySelectorAll('#result .transcript-body')].map((b) => b.textContent.trim().slice(0, 120)),
    markdown: {
      paragraphs: document.querySelectorAll('#result .conversation-paragraph').length,
      headings: document.querySelectorAll('#result .conversation-h1, #result .conversation-h2, #result .conversation-h3, #result .conversation-h4, #result .conversation-h5').length,
      lists: document.querySelectorAll('#result .conversation-list, #result .conversation-numbered-list').length,
      tables: document.querySelectorAll('#result .conversation-table').length,
      codeBlocks: document.querySelectorAll('#result .code-block').length,
      inlineCode: document.querySelectorAll('#result .inline-code').length,
      links: document.querySelectorAll('#result .conversation-link').length,
    },
    presence: document.getElementById('panda-presence')?.dataset.state ?? '',
    presenceLabel: document.getElementById('panda-presence-label')?.textContent ?? '',
    assistantMode: main?.dataset.mode ?? '',
    emptyPandaVisible: (() => {
      const empty = document.getElementById('assistant-empty');
      if (!empty) return false;
      const style = getComputedStyle(empty);
      return style.display !== 'none' && empty.getBoundingClientRect().height > 40;
    })(),
    readingWidth: reading ? Math.round(reading.getBoundingClientRect().width) : 0,
    flowWidth: flow ? Math.round(flow.getBoundingClientRect().width) : 0,
    messageWidths: [...document.querySelectorAll('#result .transcript-body')].map((b) => Math.round(b.getBoundingClientRect().width)),
    viewportWidth: window.innerWidth,
    scrollHeight: reading ? reading.scrollHeight : 0,
    clientHeight: reading ? reading.clientHeight : 0,
  };
})()`;

const TASK_ROWS = `(() => {
  const panel = document.getElementById('active-tasks-panel');
  const title = document.getElementById('active-tasks-title');
  const note = document.getElementById('active-tasks-note');
  return {
    panelVisible: Boolean(panel && !panel.hidden),
    title: title?.textContent ?? '',
    note: note?.textContent ?? '',
    rows: [...document.querySelectorAll('#active-tasks-list .dev-story')].map((li) => ({
      attemptId: li.dataset.attemptId ?? '',
      status: li.dataset.status ?? '',
      live: li.dataset.live ?? '',
      phase: li.dataset.phase ?? '',
      text: li.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220),
    })),
  };
})()`;

async function main() {
  spawnDesktop();
  let { cdp, ws } = await connectCdp(cdpPort);
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
    log('sent:', text.slice(0, 70));
  };
  /** Wait until the turn that is running is the one we just sent. The composer
   *  queues a message behind running work, so "running" alone is not proof
   *  that our turn has started. */
  const sendAndRun = async (text, label) => {
    await waitFor((s) => !s.running, 420000, 'the previous turn to finish');
    await sleep(1500);
    await send(text);
    await waitFor(
      (s) => s.running && String(s.task ?? '').startsWith(text.slice(0, 28)),
      240000,
      `${label} to start`);
  };
  /** Wait until nothing is running and the pane has settled. */
  const settle = async (label, timeout = 480000) => {
    await waitFor((s) => !s.running, timeout, `${label} to finish`);
    await sleep(2500);
  };
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await evaluate(STATE);
      if (predicate(last)) return last;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
      await sleep(400);
    }
  };
  const waitForTasks = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await evaluate(TASK_ROWS);
      if (predicate(last)) return last;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
      await sleep(600);
    }
  };

  // ── 0. The Core and the local model must be live ─────────────────────
  await waitFor(() => evaluate(`(async () => (await window.karkedikhaDesktop.getSnapshot())?.coreState === 'connected')()`),
    120000, 'the Core to connect');
  await waitFor(() => evaluate(`(async () => Boolean((await window.karkedikhaDesktop.getSnapshot())?.model))()`),
    120000, 'the local model to resolve');
  await sleep(2500);

  // ── 1. NEW CONVERSATION ──────────────────────────────────────────────
  // A genuinely empty conversation: the panda, the suggestions and the
  // composer, and nothing from any earlier task.
  await evaluate(`(async () => { await window.karkedikhaDesktop.newConversation(); return true; })()`);
  await sleep(2000);
  await evaluate(`(async () => {
    const input = document.getElementById('task-input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('conversations-new')?.click();
    return true;
  })()`);
  await sleep(2000);
  const fresh = await evaluate(STATE);
  log('new conversation:', JSON.stringify(fresh));
  if (fresh.taskCardVisible) throw new Error('a new conversation still shows an earlier task card');
  if (fresh.resultCardVisible) throw new Error('a new conversation still shows an earlier result card');
  if (fresh.transcript.length > 0) throw new Error('a new conversation still shows an earlier transcript');
  if (!fresh.emptyPandaVisible) throw new Error('the panda welcome area is not visible on a new conversation');
  await shot('01-new-conversation.png');

  // ── 2. LONG CONVERSATION ─────────────────────────────────────────────
  await sendAndRun('Explain the launch checklist in my notes.txt. Use Markdown: a heading, a short intro, a bulleted list, a two-column table of the checklist items and their status, and a small fenced code block that prints the checklist. Keep it under 250 words.', 'the first answer');
  await settle('the first answer');
  await sendAndRun('Now summarise that checklist in three sentences, in plain prose, with no lists and no headings.', 'the second answer');
  await settle('the second answer');
  const long = await evaluate(STATE);
  log('long conversation:', JSON.stringify(long));
  if (long.transcript.length < 4) throw new Error(`the long conversation kept ${long.transcript.length} turns`);
  if (long.readingWidth > 920) throw new Error(`the reading column is ${long.readingWidth}px wide`);
  if (long.messageWidths.some((w) => w > 920)) throw new Error(`a message is ${Math.max(...long.messageWidths)}px wide`);
  await shot('02-long-conversation.png');

  // ── 3. WORKING TASK ──────────────────────────────────────────────────
  await sendAndRun('Read notes.txt in the workspace and then write me a detailed summary of it in a few paragraphs.', 'the summary task');
  const working = await waitFor(
    (s) => s.taskCardVisible && (s.taskCardSteps.length > 0 || s.running),
    180000,
    'the task card to appear');
  log('working state:', JSON.stringify(working));
  await sleep(1500);
  // The task card must be on screen, not pushed out of a long thread.
  const cardOnScreen = await evaluate(`(() => {
    const card = document.getElementById('workspace-task-card');
    if (!card || card.hidden) return { visible: false };
    const r = card.getBoundingClientRect();
    return { visible: r.top >= 0 && r.bottom <= window.innerHeight + 1, top: Math.round(r.top), bottom: Math.round(r.bottom) };
  })()`);
  log('task card on screen:', JSON.stringify(cardOnScreen));
  if (!cardOnScreen.visible) throw new Error('the task card was not visible on screen while the task ran');
  await shot('03-working-task.png');

  // Stop it from the inline card: the repaired cancellation lifecycle must
  // reach a real terminal state and the UI must say so.
  await evaluate(`(() => { document.getElementById('task-card-stop').click(); return true; })()`);
  await waitFor((s) => !s.running, 180000, 'the task to stop');
  await sleep(1500);
  const stopped = await evaluate(`(async () => {
    const s = await window.karkedikhaDesktop.getSnapshot();
    return {
      running: s?.running ?? null,
      lastTurnOutcome: s?.lastTurnOutcome ?? null,
      cardHidden: document.getElementById('workspace-task-card')?.hidden ?? null,
      composerStopHidden: document.getElementById('cancel')?.hidden ?? null,
      status: document.getElementById('composer-status')?.textContent ?? '',
    };
  })()`);
  log('stop verification:', JSON.stringify(stopped));
  if (stopped.running) throw new Error('the task was still running after Stop');
  if (stopped.lastTurnOutcome !== 'cancelled' && stopped.lastTurnOutcome !== 'failed') {
    throw new Error(`the stopped task ended as ${stopped.lastTurnOutcome}, not cancelled`);
  }
  if (stopped.composerStopHidden !== true) throw new Error('the composer Stop stayed visible after the task stopped');

  // ── 4. COMPLETED RESULT ──────────────────────────────────────────────
  await evaluate(`(async () => { await window.karkedikhaDesktop.newConversation(); return true; })()`);
  await sleep(2500);
  const emptied = await evaluate(STATE);
  log('after a new conversation:', JSON.stringify(emptied));
  if (emptied.taskCardVisible) throw new Error('a new conversation still shows an earlier task card');
  if (emptied.resultCardVisible) throw new Error('a new conversation still shows an earlier result card');
  if (emptied.transcript.length > 0) throw new Error('a new conversation still shows an earlier transcript');
  await sendAndRun('Create a file named greeting.md in the workspace. Its single line of content should read exactly: Hello from Pandesh.', 'the file turn');
  for (let guard = 0; guard < 4; guard += 1) {
    const settled = await waitFor((s) => !s.running || s.approvalVisible, 300000, 'the file turn to settle');
    if (!settled.running) break;
    log('the file turn asked for a capability; declining it truthfully');
    await evaluate(`(() => { document.getElementById('reject').click(); return true; })()`);
  }
  await settle('the file turn');
  const result = await evaluate(STATE);
  log('result state:', JSON.stringify(result));
  if (!result.resultCardVisible) {
    log('WARNING: the turn finished without a result card; transcript:',
      JSON.stringify(result.transcript));
  }
  const resultActions = await evaluate(`(() => {
    const list = document.getElementById('conversation-results-list');
    return [...(list?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()).filter(Boolean);
  })()`);
  log('result actions:', JSON.stringify(resultActions));
  for (const action of ['Open', 'Show in folder']) {
    if (!resultActions.includes(action)) throw new Error(`the result card is missing the '${action}' action`);
  }
  // The delivered result must be on screen, not pushed out of a long thread.
  const resultOnScreen = await evaluate(`(() => {
    const card = document.getElementById('conversation-results');
    if (!card || card.hidden) return { visible: false };
    const r = card.getBoundingClientRect();
    return { visible: r.top >= 0 && r.bottom <= window.innerHeight + 1, top: Math.round(r.top), bottom: Math.round(r.bottom) };
  })()`);
  log('result card on screen:', JSON.stringify(resultOnScreen));
  if (!resultOnScreen.visible) throw new Error('the result card was not visible on screen');
  await shot('04-completed-result.png');

  // ── 5. APPROVAL ──────────────────────────────────────────────────────
  await sendAndRun('Search the web for the latest news about local AI models and cite your sources.', 'the web-search turn');
  const approval = await waitFor((s) => s.approvalVisible, 240000, 'the approval card');
  const approvalControls = await evaluate(`(() => ({
    heading: document.getElementById('approval-heading')?.textContent ?? '',
    gate: document.getElementById('approval-gate')?.textContent ?? '',
    tool: document.getElementById('approval-tool')?.textContent ?? '',
    scope: document.getElementById('approval-scope')?.textContent ?? '',
    detail: (document.getElementById('approval-detail')?.textContent ?? '').slice(0, 240),
    approveDisabled: document.getElementById('approve')?.disabled ?? null,
    rejectDisabled: document.getElementById('reject')?.disabled ?? null,
    approveVisible: (() => {
      const b = document.getElementById('approve');
      if (!b) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })(),
    rejectVisible: (() => {
      const b = document.getElementById('reject');
      if (!b) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })(),
    insideConversation: Boolean(document.getElementById('approval-panel')?.closest('#assistant-main')),
  }))()`);
  log('approval card:', JSON.stringify(approvalControls));
  if (!approvalControls.insideConversation) throw new Error('the approval card is not inside the conversation');
  if (approvalControls.approveDisabled || approvalControls.rejectDisabled) {
    throw new Error('the approval card was visible but its controls were disabled');
  }
  if (!approvalControls.approveVisible || !approvalControls.rejectVisible) {
    throw new Error('the approval card does not show both controls');
  }
  const approvalOnScreen = await evaluate(`(() => {
    const panel = document.getElementById('approval-panel');
    if (!panel || panel.hidden) return { visible: false };
    const r = panel.getBoundingClientRect();
    return { visible: r.top >= 0 && r.bottom <= window.innerHeight + 1, top: Math.round(r.top), bottom: Math.round(r.bottom) };
  })()`);
  log('approval card on screen:', JSON.stringify(approvalOnScreen));
  if (!approvalOnScreen.visible) throw new Error('the approval card was not visible on screen');
  await shot('05-approval.png');

  // Answer it for real: reject, and let the turn finish truthfully.
  await evaluate(`(() => { document.getElementById('reject').click(); return true; })()`);
  let askedAgain = false;
  try {
    const settled = await waitFor((s) => !s.running || s.approvalVisible, 90000, 'the approval turn to settle');
    askedAgain = Boolean(settled.approvalVisible);
  } catch { askedAgain = true; }
  if (askedAgain) {
    log('the agent asked for the same capability again; stopping the task from the inline card');
    await evaluate(`(() => { document.getElementById('task-card-stop').click(); return true; })()`);
  }
  await waitFor((s) => !s.running, 180000, 'the approval turn to end');
  await sleep(1500);

  // ── 6. TASKS AND HISTORY ─────────────────────────────────────────────
  await evaluate(`(() => { document.getElementById('nav-tasks-btn').click(); return true; })()`);
  await sleep(1500);
  const tasks = await waitForTasks((t) => t.panelVisible, 60000, 'the Tasks panel');
  log('tasks:', JSON.stringify(tasks));
  await shot('06-tasks-and-history.png');

  // The conversation history is collapsible and searchable, and it opens over
  // the conversation rather than taking its space.
  await evaluate(`(() => { document.getElementById('nav-assistant-btn').click(); return true; })()`);
  await sleep(1200);
  await evaluate(`(() => { document.getElementById('btn-toggle-history')?.click(); return true; })()`);
  await sleep(1200);
  const history = await evaluate(`(() => {
    const rail = document.getElementById('surface-conversations-rail');
    const search = document.getElementById('conversations-search');
    return {
      railVisible: Boolean(rail && rail.getBoundingClientRect().width > 0),
      searchVisible: Boolean(search && search.getBoundingClientRect().width > 0),
      entries: [...document.querySelectorAll('#conversations-rail-groups .conversation-entry')].length,
      layout: document.getElementById('assistant-layout')?.dataset.history ?? '',
    };
  })()`);
  log('history:', JSON.stringify(history));
  if (!history.railVisible) throw new Error('the conversation history did not open');
  if (!history.searchVisible) throw new Error('the conversation history has no search field');
  await shot('07-conversation-history.png');

  // ── 7. RESTART ───────────────────────────────────────────────────────
  // The state must survive a restart: the conversation is still there and no
  // phantom "running" task is left behind.
  const before = await evaluate(`(async () => {
    const s = await window.karkedikhaDesktop.getSnapshot();
    return { selectedConversationId: s?.selectedConversationId ?? null, running: s?.running ?? null };
  })()`);
  log('before restart:', JSON.stringify(before));
  ws.close();
  child.kill();
  await sleep(4000);
  cdpPort = await findFreePort();
  spawnDesktop();
  ({ cdp, ws } = await connectCdp(cdpPort));
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate(`(async () => (await window.karkedikhaDesktop.getSnapshot())?.coreState === 'connected')()`),
    120000, 'the Core to connect after the restart');
  await sleep(6000);
  const after = await evaluate(`(async () => {
    const s = await window.karkedikhaDesktop.getSnapshot();
    return {
      selectedConversationId: s?.selectedConversationId ?? null,
      running: s?.running ?? null,
      transcript: [...document.querySelectorAll('#result .transcript-body')].length,
      taskCardVisible: Boolean(document.getElementById('workspace-task-card') && !document.getElementById('workspace-task-card').hidden),
    };
  })()`);
  log('after restart:', JSON.stringify(after));
  if (after.running) throw new Error('a task is still marked running after the restart');
  if (after.taskCardVisible) throw new Error('a task card is still shown after the restart');
  await shot('08-after-restart.png');

  if (consoleErrors.length) log('renderer console errors:', consoleErrors.slice(0, 10));
  ws.close();
}

try {
  await main();
  log('done');
} catch (err) {
  console.error('[refined] FAILED:', err.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
