/**
 * Prove Pandesh's Personal Assistant experience in the real application.
 *
 * Everything here runs against the real Electron host, the real KKD Core and
 * the real local model. Isolation is by directory only: a throwaway data dir, a
 * throwaway workspace and a throwaway HOME, all under the repository's `.tmp/`
 * folder, so no personal path (and no user name) ever appears in a screenshot
 * and the user's live conversations are never touched.
 *
 *   node apps/desktop/scripts/capture-pandesh-assistant.mjs [outDir]
 *
 * Writes:
 *   01-calm-welcome.png          nothing needs you — the calm panda welcome
 *   02-home-needs-approval.png   a real pending approval on a Home card
 *   03-home-completed-result.png a finished task and its result
 *   04-today-briefing.png        "What's on my plate today?" answered from Core
 *   05-after-restart.png         the same work, still there after a restart
 *   06-daily-brief-routine.png   the daily routine delivered exactly once
 *
 * It verifies, on the way: the calm welcome, an approval completed from its
 * visible card, a real file really written, a truthful briefing, continuity
 * across a restart, and a routine that fires once per occurrence.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist', 'pandesh-assistant'));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log('[pandesh]', ...args);

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
const isolationRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'pandesh-'));
const dataDir = path.join(isolationRoot, 'data');
const workspace = path.join(isolationRoot, 'workspace');
const fakeHome = path.join(isolationRoot, 'home');
for (const dir of [dataDir, workspace, fakeHome]) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(workspace, 'notes.txt'),
  'Pandesh notes.\n\n'
  + 'The assistant opens knowing what matters, briefs the day truthfully,\n'
  + 'keeps the work discoverable, and runs one routine the operator chose.\n');

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

/** Everything the Home is showing, read from the DOM itself. */
const HOME_STATE = `(() => {
  const attention = document.getElementById('home-attention');
  const today = document.getElementById('home-today');
  const empty = document.getElementById('assistant-empty');
  return {
    attentionHidden: attention ? attention.hidden : null,
    attentionTitle: document.getElementById('home-attention-title')?.textContent ?? '',
    cards: [...document.querySelectorAll('#home-attention-list .ws-attention-card')].map((c) => ({
      kind: c.dataset.kind ?? '',
      state: c.dataset.state ?? '',
      text: c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 240),
    })),
    cardButtons: [...document.querySelectorAll('#home-attention-list .ws-chip')].map((b) => b.textContent.trim()),
    todayHidden: today ? today.hidden : null,
    todaySections: [...document.querySelectorAll('#home-today-list .ws-today-section')].map((s) => ({
      id: s.dataset.section ?? '',
      text: s.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220),
    })),
    pandaVisible: (() => {
      if (!empty) return false;
      const style = getComputedStyle(empty);
      return style.display !== 'none' && empty.getBoundingClientRect().height > 40;
    })(),
    presence: document.querySelector('.app')?.dataset.pandaPresence ?? '',
    presenceLabel: document.getElementById('panda-presence-label')?.textContent ?? '',
    assistantMode: document.getElementById('assistant-main')?.dataset.mode ?? '',
  };
})()`;

const TURN_STATE = `(() => {
  const s = window.lastSnapshot;
  return {
    running: Boolean(s?.running),
    outcome: s?.lastTurnOutcome ?? null,
    task: s?.task ?? null,
    approvalVisible: Boolean(document.getElementById('approval-panel') && !document.getElementById('approval-panel').hidden),
    transcript: [...document.querySelectorAll('#result .transcript-body')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400)),
    resultCards: [...document.querySelectorAll('#conversation-results-list .result-card')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)),
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
  const waitFor = async (predicate, timeoutMs, label, reader = async () => evaluate('null')) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await reader();
      if (await predicate(last)) return last;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
      await sleep(500);
    }
  };

  // Count the routine's deliveries exactly as the renderer receives them.
  await evaluate(`(() => {
    window.__dailyBriefEvents = 0;
    window.karkedikhaDesktop.onEvent((e) => {
      if (e && e.eventType === 'daily_brief_delivered') window.__dailyBriefEvents += 1;
    });
    return true;
  })()`);

  // ── 0. The Core and the local model must be live ─────────────────────
  await waitFor(() => evaluate(`(async () => (await window.karkedikhaDesktop.getSnapshot())?.coreState === 'connected')()`),
    120000, 'the Core to connect', () => evaluate('true'));
  await waitFor(() => evaluate(`(async () => Boolean((await window.karkedikhaDesktop.getSnapshot())?.model))()`),
    120000, 'the local model to resolve', () => evaluate('true'));
  await sleep(4000);

  // ── 1. B: THE CALM WELCOME ───────────────────────────────────────────
  // Nothing needs the operator yet, so the panda welcome stays exactly as
  // approved — no invented cards, no empty placeholders.
  const calm = await evaluate(HOME_STATE);
  log('calm home:', JSON.stringify(calm));
  if (calm.attentionHidden !== true) throw new Error('the Home showed attention cards when nothing needed the operator');
  if (calm.pandaVisible !== true) throw new Error('the calm panda welcome is not visible');
  await shot('01-calm-welcome.png');

  // ── 2. A + F: A REAL APPROVAL, COMPLETED FROM ITS VISIBLE CARD ──────
  // The composer is read back before sending: another driver must never be
  // able to put a different message in this run's mouth.
  const sent = await evaluate(`(() => {
    const input = document.getElementById('task-input');
    const wanted = ${JSON.stringify('Search the web for the latest Ollama release notes and give me a one-paragraph summary with the source URL.')};
    input.value = wanted;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (input.value !== wanted) return { sent: false, value: input.value };
    document.getElementById('submit').click();
    return { sent: true, value: input.value };
  })()`);
  if (!sent.sent) throw new Error(`the composer did not hold the request: ${JSON.stringify(sent.value)}`);
  log('sent: the web-research request');
  const approving = await waitFor(
    (t) => t.approvalVisible || (t.running && String(t.task ?? '').startsWith('Search the web')),
    300000,
    'the research request to reach its approval',
    () => evaluate(TURN_STATE),
  );
  log('the request reached:', JSON.stringify(approving));

  const homeWithApproval = await waitFor(
    (h) => h.cards.some((c) => c.kind === 'approval'),
    180000,
    'the approval to appear on a Home card',
    () => evaluate(HOME_STATE),
  );
  log('home with an approval:', JSON.stringify(homeWithApproval));
  const approveCard = homeWithApproval.cards.find((c) => c.kind === 'approval');
  if (!approveCard) throw new Error('the pending approval did not reach the Home');
  if (!homeWithApproval.cardButtons.includes('Approve') || !homeWithApproval.cardButtons.includes('Reject')) {
    throw new Error(`the Home approval card has no working controls: ${JSON.stringify(homeWithApproval.cardButtons)}`);
  }
  await shot('02-home-needs-approval.png');

  // Answer it from the card the operator can actually see.
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('#home-attention-list .ws-chip')].find((b) => b.textContent.trim() === 'Approve');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  log('approved from the Home card');

  const settled = await waitFor((t) => !t.running, 420000, 'the approved task to finish', () => evaluate(TURN_STATE));
  log('after the approval:', JSON.stringify(settled));

  // The approval must really be resolved — nothing pending afterwards.
  const stillPending = await evaluate(`(async () => {
    const brief = await window.karkedikhaDesktop.getAssistantBrief({ external: false });
    return brief.home.filter((item) => item.kind === 'approval').length;
  })()`);
  if (stillPending > 0) throw new Error('the approval is still pending after it was answered');

  // ── 3. A: THE FINISHED WORK IS ON THE HOME ───────────────────────────
  const homeAfter = await waitFor(
    (h) => h.cards.some((c) => c.kind === 'task_completed') || h.cards.some((c) => c.kind === 'task_running'),
    90000,
    'the finished work to reach the Home',
    () => evaluate(HOME_STATE),
  );
  log('home after the work:', JSON.stringify(homeAfter));
  await shot('03-home-completed-result.png');

  // ── 4. C: "WHAT'S ON MY PLATE TODAY?" ────────────────────────────────
  const briefSent = await evaluate(`(() => {
    const input = document.getElementById('task-input');
    const wanted = "What's on my plate today?";
    input.value = wanted;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (input.value !== wanted) return { sent: false, value: input.value };
    document.getElementById('submit').click();
    return { sent: true, value: input.value };
  })()`);
  if (!briefSent.sent) throw new Error(`the composer did not hold the request: ${JSON.stringify(briefSent.value)}`);
  log('sent: what is on my plate today');
  const briefed = await waitFor(
    (t) => t.transcript.some((line) => /your brief/i.test(line)),
    120000,
    'the briefing to arrive',
    () => evaluate(TURN_STATE),
  );
  log('the briefing:', JSON.stringify(briefed.transcript.slice(-2)));
  const briefingText = briefed.transcript.join(' ');
  if (!/Calendar commitments/i.test(briefingText)) throw new Error('the briefing does not mention the calendar');
  if (!/Email worth knowing/i.test(briefingText)) throw new Error('the briefing does not mention the email');
  if (!/Waiting for your approval|Pending work|Follow-ups/i.test(briefingText)) throw new Error('the briefing does not mention the work');
  if (!/Facts come from the source/i.test(briefingText)) throw new Error('the briefing does not separate facts from suggestions');
  await shot('04-today-briefing.png');

  // ── 5. D: CONTINUITY ACROSS A RESTART ────────────────────────────────
  const before = await evaluate(`(async () => {
    const s = await window.karkedikhaDesktop.getSnapshot();
    return { selectedConversationId: s?.selectedConversationId ?? null, running: s?.running ?? null };
  })()`);
  log('before the restart:', JSON.stringify(before));
  ws.close();
  child.kill();
  await sleep(5000);
  cdpPort = await findFreePort();
  spawnDesktop();
  ({ cdp, ws } = await connectCdp(cdpPort));
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate(`(async () => (await window.karkedikhaDesktop.getSnapshot())?.coreState === 'connected')()`),
    120000, 'the Core to connect after the restart', () => evaluate('true'));
  await sleep(7000);
  // The page was reloaded: count the routine's deliveries again from here.
  await evaluate(`(() => {
    window.__dailyBriefEvents = 0;
    window.karkedikhaDesktop.onEvent((e) => {
      if (e && e.eventType === 'daily_brief_delivered') window.__dailyBriefEvents += 1;
    });
    return true;
  })()`);
  const after = await evaluate(`(async () => {
    const s = await window.karkedikhaDesktop.getSnapshot();
    const overview = await window.karkedikhaDesktop.getTaskOverview();
    return {
      selectedConversationId: s?.selectedConversationId ?? null,
      running: s?.running ?? null,
      transcript: [...document.querySelectorAll('#result .transcript-body')].length,
      tasks: (overview?.tasks ?? []).map((t) => ({ title: t.title, status: t.status, live: t.live, interrupted: t.interrupted })),
    };
  })()`);
  log('after the restart:', JSON.stringify(after));
  if (after.running) throw new Error('a task is still marked running after the restart');
  if (!after.tasks.length) throw new Error('the finished task is not discoverable after the restart');
  if (after.tasks.some((t) => t.live)) throw new Error('a finished task is still reported as live after the restart');
  await shot('05-after-restart.png');

  // ── 6. E: THE DAILY ROUTINE, EXACTLY ONCE ────────────────────────────
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const runAt = new Date(Date.now() + 2 * 60_000);
  const dailyTime = `${String(runAt.getHours()).padStart(2, '0')}:${String(runAt.getMinutes()).padStart(2, '0')}`;
  log('the daily brief is configured for', dailyTime, timezone);
  const routine = await evaluate(`(async () => {
    const r = await window.karkedikhaDesktop.configureDailyBriefRoutine({ dailyTime: ${JSON.stringify(dailyTime)}, timezone: ${JSON.stringify(timezone)}, enabled: true });
    return r;
  })()`);
  log('the routine:', JSON.stringify(routine));
  if (!routine || routine.enabled !== true) throw new Error('the daily brief routine was not configured');

  const delivered = await waitFor(
    () => evaluate('window.__dailyBriefEvents ?? 0'),
    300000,
    'the daily brief to be delivered',
    () => evaluate('window.__dailyBriefEvents ?? 0'),
  );
  log('daily brief deliveries:', delivered);
  await sleep(60000);
  const deliveries = await evaluate('window.__dailyBriefEvents ?? 0');
  log('daily brief deliveries after a minute:', deliveries);
  if (deliveries !== 1) throw new Error(`the daily brief was delivered ${deliveries} times, not once`);

  // The delivered brief is a real message in a real conversation.
  const routineState = await evaluate(`(async () => {
    const routine = await window.karkedikhaDesktop.getDailyBriefRoutine();
    const list = await window.karkedikhaDesktop.listConversations(false);
    const entry = (list ?? []).find((c) => c.id === routine?.conversationId);
    let messages = [];
    if (entry) {
      const opened = await window.karkedikhaDesktop.openConversation(entry.id);
      messages = (opened?.messages ?? []).map((m) => m.content.slice(0, 200));
    }
    return { routine, entryTitle: entry?.title ?? null, messages };
  })()`);
  log('the routine conversation:', JSON.stringify(routineState));
  if (!routineState.messages.some((m) => /your brief/i.test(m))) {
    throw new Error('the delivered brief is not a message in the routine conversation');
  }
  await shot('06-daily-brief-routine.png');

  if (consoleErrors.length) log('renderer console errors:', consoleErrors.slice(0, 10));
  ws.close();
}

try {
  await main();
  log('done');
} catch (err) {
  console.error('[pandesh] FAILED:', err.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
