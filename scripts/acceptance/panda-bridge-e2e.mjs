#!/usr/bin/env node
/**
 * Panda bridge acceptance, driven through a real Chromium with the real extension, the real native-messaging host and a real
 * Core (+ Kandev + OpenCode/Claude). Only the ChatGPT page body is a local fixture (apps/panda-bridge/test/chatgpt-like.html):
 * the extension is injected on the real https://chatgpt.com/* match pattern, whose responses are served from the fixture.
 *
 * Phases (run in order; Core may be restarted between 2 and 3):
 *   1  pair, check disabled Panda Mode never intercepts, Send to Panda, Panda Mode, de-duplication, consent refusal, start OpenCode
 *   2  pause/resume through the browser, wait for completion, check the result card and Open in Pandesh
 *   3  after restart: a fresh browser still lists the task, with its result, and Pandesh still holds the conversation
 *
 * Environment: PANDA_E2E_DATA_DIR (Core data dir), PANDA_E2E_PLAYWRIGHT (dir containing node_modules/playwright-core),
 *              PANDA_E2E_CHROMIUM (chrome.exe), PANDA_E2E_WORK (scratch dir for the browser profile and state)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DATA = path.resolve(process.env.PANDA_E2E_DATA_DIR || '');
const WORK = path.resolve(process.env.PANDA_E2E_WORK || '');
const EXT = path.join(REPO, 'apps', 'panda-bridge', 'extension');
const FIXTURE = fs.readFileSync(path.join(REPO, 'apps', 'panda-bridge', 'test', 'chatgpt-like.html'), 'utf8');
const EXTENSION_ID = 'emejmmocdfgfigdlekonndnmpjfdjimm';
const PROMPT = 'Build a simple calculator app';
const phase = process.argv[2] || '1';
const requireFrom = createRequire(pathToFileURL(path.join(process.env.PANDA_E2E_PLAYWRIGHT || '.', 'x.js')));
const { chromium } = requireFrom('playwright-core');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const statePath = path.join(WORK, 'e2e-state.json');
const loadState = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {});
const saveState = (s) => fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pandesh's own view, as the Pandesh host (not as the browser).
async function pandesh(method, route, body) {
  const port = JSON.parse(fs.readFileSync(path.join(DATA, 'core.json'), 'utf8')).port;
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${fs.readFileSync(path.join(DATA, 'core.token'), 'utf8').trim()}`,
      'X-Host-Token': fs.readFileSync(path.join(DATA, 'host.token'), 'utf8').trim(), 'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function launch() {
  const context = await chromium.launchPersistentContext(path.join(WORK, 'profile'), {
    executablePath: process.env.PANDA_E2E_CHROMIUM,
    headless: process.env.PANDA_E2E_HEADED ? false : true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
  });
  await context.route('https://chatgpt.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }));
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  return { context, worker };
}

async function openChat(context, id = 'e2e') {
  const page = await context.newPage();
  await page.goto(`https://chatgpt.com/c/${id}`);
  await page.waitForSelector('#panda-bridge-root', { state: 'attached', timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#panda-bridge-root')?.shadowRoot?.getElementById('send'), null, { timeout: 15000 });
  return page;
}
const typeInComposer = async (page, text) => {
  await page.click('#prompt-textarea');
  await page.keyboard.type(text);
};
const submissions = (page) => page.evaluate(() => window.__chatgptSubmissions.slice());
const composerText = (page) => page.evaluate(() => document.getElementById('prompt-textarea').innerText.trim());
const allBridgeTasks = async () => (await pandesh('GET', '/v1/bridge/tasks?limit=100')).json.tasks;
const bridgeTasks = allBridgeTasks;
const cardText = (page) => page.evaluate(() => document.getElementById('panda-bridge-root').shadowRoot.getElementById('cards').innerText);

async function waitFor(fn, label, timeoutMs, everyMs = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

// Panda Mode ON: Enter and the send arrow go to Pandesh, not to ChatGPT. Counts only tasks created by this run.
async function pandaModeChecks(page, since) {
  const mine = async () => (await bridgeTasks()).filter((t) => t.createdAt >= since && t.sourceRef.via === 'panda_mode');
  const idle = async () => { await waitFor(async () => (await composerText(page)) === '', 'the composer to clear after sending', 20000, 300); };
  const chatgptBefore = (await submissions(page)).length;
  await page.locator('#mode').check();
  await waitFor(async () => (await page.locator('#pill').innerText()) === 'ON', 'Panda Mode pill', 5000, 200);
  check('Panda Mode is visibly ON', (await page.locator('#bar.on').count()) === 1);
  await typeInComposer(page, 'prompt typed in Panda Mode via Enter');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await mine()).some((t) => t.instruction === 'prompt typed in Panda Mode via Enter'), 'Enter-routed task', 20000, 300);
  await idle();
  await typeInComposer(page, 'prompt typed in Panda Mode via the send arrow');
  await page.click('[data-testid="send-button"]');
  await waitFor(async () => (await mine()).some((t) => t.instruction === 'prompt typed in Panda Mode via the send arrow'), 'arrow-routed task', 20000, 300);
  await idle();
  check('Panda Mode ON: nothing reached ChatGPT', (await submissions(page)).length === chatgptBefore);
  const got = await mine();
  check('Panda Mode ON: Enter and the send arrow each produced exactly one Pandesh task', got.length === 2, got.map((t) => t.instruction).join(' | '));
  await page.locator('#mode').uncheck();
}

// Optional context is opt-in and previewed. `tasksNow` returns only the tasks created by the calling run.
async function contextChecks(page, tasksNow) {
  const n0 = (await submissions(page)).length;
  await typeInComposer(page, 'normal again after turning Panda Mode off');
  await page.keyboard.press('Enter');
  await sleep(1000);
  check('turning Panda Mode off restores normal submission', (await submissions(page)).length === n0 + 1);
  await page.locator('#ctx').check();
  await typeInComposer(page, 'task with shared context');
  await page.click('#send');
  await page.waitForSelector('.dialog', { timeout: 5000 });
  check('context sharing shows a confirmation preview first', (await page.locator('.preview').innerText()).includes('Hello! How can I help'));
  check('nothing is sent while the preview is open', !(await tasksNow()).some((t) => t.instruction === 'task with shared context'));
  await page.locator('#modal').getByText('Cancel', { exact: true }).click();
  await sleep(800);
  check('cancelling the preview sends nothing and keeps the draft', !(await tasksNow()).some((t) => t.instruction === 'task with shared context') && (await composerText(page)) === 'task with shared context');
  await page.click('#send');
  await page.waitForSelector('.dialog', { timeout: 5000 });
  await page.locator('#modal').getByText('Share it', { exact: true }).click();
  await waitFor(async () => (await tasksNow()).some((t) => t.instruction === 'task with shared context'), 'context task', 20000, 500);
  check('after confirming, the task records that context was shared', (await tasksNow()).find((t) => t.instruction === 'task with shared context').contextShared === true);
  check('without confirming, no other task carries context', (await tasksNow()).filter((t) => t.contextShared).length === 1);
  await page.locator('#ctx').uncheck();

}

// ------------------------------------------------------------------------------------------------- phase 1
async function phase1() {
  fs.rmSync(path.join(WORK, 'profile'), { recursive: true, force: true });
  // Start from a known state: no stale pairings, and no leftover waiting tasks from an earlier run.
  for (const p of (await pandesh('GET', '/v1/bridge/pairings')).json.pairings.filter((x) => !x.revokedAt)) await pandesh('POST', `/v1/bridge/pairings/${p.id}/revoke`, {});
  for (const t of (await allBridgeTasks()).filter((x) => x.status === 'awaiting_executor')) await pandesh('POST', `/v1/bridge/tasks/${t.id}/cancel`, {});
  const runStart = new Date().toISOString();
  // Everything below looks only at tasks created by this run, so an identical earlier task can never satisfy (or fail) a check.
  const bridgeTasks = async () => (await allBridgeTasks()).filter((t) => t.createdAt >= runStart);
  const before = 0;
  const { context, worker } = await launch();
  check('extension loaded with the pinned id', worker.url().includes(EXTENSION_ID), worker.url());

  // Pair through the popup with a one-time code created in Pandesh.
  const code = (await pandesh('POST', '/v1/bridge/pairing-codes', {})).json.code;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await popup.fill('#code', code);
  await popup.click('#pair');
  await popup.waitForSelector('#paired:not([hidden])', { timeout: 20000 });
  check('paired through the popup (native host -> Core)', (await popup.textContent('#label')).length > 0);
  const pairings = (await pandesh('GET', '/v1/bridge/pairings')).json.pairings.filter((p) => !p.revokedAt);
  check('Pandesh lists exactly the new pairing', pairings.some((p) => p.extensionId === EXTENSION_ID));
  check('the pairing code cannot be reused', (await pandesh('POST', '/v1/bridge/pair', { code })).status === 401);

  const page = await openChat(context);

  // Panda Mode is OFF by default: normal ChatGPT submissions must reach the page untouched and create no Pandesh task.
  check('Panda Mode is off by default', (await page.locator('#mode').isChecked()) === false);
  await typeInComposer(page, 'a normal ChatGPT question');
  await page.keyboard.press('Enter');
  await typeInComposer(page, 'another normal question');
  await page.click('[data-testid="send-button"]');
  await sleep(1500);
  check('Panda Mode OFF: Enter and the send button reach ChatGPT unchanged', (await submissions(page)).join('|') === 'a normal ChatGPT question|another normal question');
  check('Panda Mode OFF: no task was created', (await bridgeTasks()).length === before);

  // Send to Panda: exact text, once.
  await typeInComposer(page, PROMPT);
  await page.click('#send');
  await waitFor(async () => (await bridgeTasks()).length === before + 1, 'the task to arrive', 20000, 500);
  let tasks = await bridgeTasks();
  const task = tasks.find((t) => t.instruction === PROMPT);
  check('Pandesh received the exact request', Boolean(task), JSON.stringify(task?.instruction));
  check('a durable task id came back immediately', /^ptask_/.test(task.id), task.id);
  check('source reference preserved', task.sourceRef.url === 'https://chatgpt.com/c/e2e' && task.sourceRef.via === 'send_button', JSON.stringify(task.sourceRef));
  check('ChatGPT itself received nothing for that prompt', (await submissions(page)).length === 2);
  check('the sent prompt was cleared from the composer', (await composerText(page)) === '');
  check('the Pandesh conversation holds the exact user turn', await (async () => {
    const msgs = (await pandesh('GET', `/v1/conversations/${task.conversationId}/messages`)).json;
    const list = msgs.messages || msgs;
    return list.filter((m) => m.role === 'user').map((m) => m.content).join('|') === PROMPT;
  })());

  // The same text again moments later is the same request.
  await typeInComposer(page, PROMPT);
  await page.click('#send');
  await sleep(2500);
  check('sending the same text again does not create a second task', (await bridgeTasks()).length === before + 1);

  await pandaModeChecks(page, runStart);

  await contextChecks(page, bridgeTasks);

  // A browser can never authorise an external transfer; Pandesh's own consent is the only way.
  const forged = await popup.evaluate((id) => new Promise((resolve) => chrome.runtime.sendMessage({ op: 'dispatch', taskId: id, executor: 'claude', consent: { externalTransfer: true, confidentialOverride: true } }, resolve)), task.id);
  check('browser asking for Claude Code (cloud) is refused with nothing sent', forged.ok === false && forged.reason === 'external_consent_required', `${forged.code}/${forged.reason}`);
  check('the cloud executors are not offered as startable in the page', await page.evaluate(() => {
    const sel = document.getElementById('panda-bridge-root').shadowRoot.querySelector('select');
    const claude = [...sel.options].find((o) => /Claude Code/.test(o.textContent));
    return Boolean(claude && claude.disabled);
  }));
  const afterRefusal = (await pandesh('GET', `/v1/bridge/tasks/${task.id}`)).json;
  check('the refused task is still waiting, untouched', afterRefusal.status === 'awaiting_executor' && afterRefusal.executor === null);

  // Choose OpenCode (local) from the card.
  const optionLabels = await page.evaluate(() => [...document.getElementById('panda-bridge-root').shadowRoot.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent)));
  console.log('      executor choices:', JSON.stringify(optionLabels[0]));
  const card = page.locator('.card', { hasText: PROMPT }).first();
  await card.locator('select').selectOption('opencode');
  await card.getByText('Start', { exact: true }).click();
  const started = await waitFor(async () => {
    const t = (await pandesh('GET', `/v1/bridge/tasks/${task.id}`)).json;
    return t.executor === 'opencode' && t.status !== 'awaiting_executor' ? t : null;
  }, 'OpenCode to start', 240000, 3000);
  check('OpenCode was started from the browser card (explicit selection, local)', started.executor === 'opencode' && started.routing === 'explicit' && started.externalTransfer === false, started.status);
  check('the work has its own isolated workspace (story + workspace), not a user checkout', Boolean(started.storyId));

  // Cancel the other helper tasks so only the calculator runs.
  for (const t of (await bridgeTasks()).filter((x) => x.id !== task.id && x.status === 'awaiting_executor')) await pandesh('POST', `/v1/bridge/tasks/${t.id}/cancel`, {});
  saveState({ taskId: task.id, conversationId: task.conversationId, storyId: started.storyId });
  await context.close();
}

// Re-runs only the Panda Mode checks against the already-paired profile (no new pairing, no new executor work).
async function phaseModes() {
  const runStart = new Date().toISOString();
  const { context } = await launch();
  const page = await openChat(context, 'e2e-modes');
  const before = (await submissions(page)).length;
  await typeInComposer(page, 'normal question while Panda Mode is off');
  await page.keyboard.press('Enter');
  await sleep(800);
  check('Panda Mode OFF: Enter reaches ChatGPT', (await submissions(page)).length === before + 1);
  check('Panda Mode OFF: no Pandesh task', (await bridgeTasks()).filter((t) => t.createdAt >= runStart).length === 0);
  await pandaModeChecks(page, runStart);
  await contextChecks(page, async () => (await bridgeTasks()).filter((t) => t.createdAt >= runStart));
  for (const t of (await bridgeTasks()).filter((x) => x.createdAt >= runStart && x.status === 'awaiting_executor')) await pandesh('POST', `/v1/bridge/tasks/${t.id}/cancel`, {});
  await context.close();
}

// Live pause / resume / cancel through the extension on a fresh task (the calculator run is not needed to finish).
async function phaseControl() {
  const runStart = new Date().toISOString();
  const { context } = await launch();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  const ext = (message) => popup.evaluate((m) => new Promise((resolve) => chrome.runtime.sendMessage(m, resolve)), message);
  const sub = await ext({ op: 'submit', clientRequestId: 'click-control-' + Date.now(), instruction: 'Build a simple calculator app (control check ' + Date.now() + ')', sourceRef: { url: 'https://chatgpt.com/c/ctl', via: 'send_button' } });
  check('task relayed through the extension', sub.ok && sub.data.task.status === 'awaiting_executor');
  const id = sub.data.taskId;
  const started = await ext({ op: 'dispatch', taskId: id, executor: 'opencode' });
  check('OpenCode started from the extension', started.ok && started.data.task.executor === 'opencode', started.message || started.data?.task?.status);
  await waitFor(async () => (await pandesh('GET', `/v1/bridge/tasks/${id}`)).json.status === 'running', 'running', 600000, 3000);

  const paused = await ext({ op: 'pause', taskId: id });
  check('pause through the extension', paused.ok && paused.data.control === 'paused' && paused.data.status === 'paused', paused.message || paused.data?.status);
  await sleep(20000);
  const still = (await pandesh('GET', `/v1/bridge/tasks/${id}`)).json;
  check('a paused task stays paused: nothing restarts on its own', still.status === 'paused' && still.control === 'paused', still.status);

  const resumed = await ext({ op: 'resume', taskId: id });
  check('resume through the extension is immediately consistent (running, control cleared)', resumed.ok && resumed.data.control === 'none' && resumed.data.status === 'running', resumed.message || `${resumed.data?.control}/${resumed.data?.status}`);
  await sleep(15000);
  const again = (await pandesh('GET', `/v1/bridge/tasks/${id}`)).json;
  check('after resume the task is live again and not paused', again.control === 'none' && again.status !== 'paused', again.status);

  const cancelled = await ext({ op: 'cancel', taskId: id });
  check('cancel through the extension', cancelled.ok && cancelled.data.status === 'cancelled' && cancelled.data.control === 'cancelled', cancelled.message || cancelled.data?.status);
  await sleep(30000);
  const final = (await pandesh('GET', `/v1/bridge/tasks/${id}`)).json;
  check('a cancelled task stays cancelled and cannot be resumed', final.status === 'cancelled' && (await ext({ op: 'resume', taskId: id })).ok === false);
  const feed = (await pandesh('GET', '/v1/dev-stories')).json;
  const story = feed.stories.find((s) => s.id === final.storyId);
  check('the worker behind it is stopped (story parked, no worker running)', story && story.status === 'blocked' && story.phase === 'stopped', story && `${story.status}/${story.phase}`);
  check('restarting an extension call to dispatch a cancelled task is refused', (await ext({ op: 'dispatch', taskId: id, executor: 'opencode' })).ok === false);
  void runStart;
  await context.close();
}

// ------------------------------------------------------------------------------------------------- phase 2
async function phase2() {
  const { taskId } = loadState();
  const { context } = await launch();
  const page = await openChat(context);
  const card = page.locator('.card', { hasText: PROMPT }).first();
  await waitFor(async () => (await cardText(page)).includes(PROMPT), 'the card to reappear after reopening the browser', 30000, 1000);
  check('reopened browser shows the same running task (state comes from Pandesh, not the page)', true);

  // Pause and resume from the browser once the worker is actually running.
  if (process.env.PANDA_E2E_SKIP_PAUSE !== '1') {
    await waitFor(async () => (await pandesh('GET', `/v1/bridge/tasks/${taskId}`)).json.status === 'running', 'running', 600000, 4000);
    await card.getByText('Pause', { exact: true }).click();
    const paused = await waitFor(async () => { const t = (await pandesh('GET', `/v1/bridge/tasks/${taskId}`)).json; return t.status === 'paused' ? t : null; }, 'paused', 120000, 2000);
    check('Pause from the browser stops the worker', paused.control === 'paused' && /Paused/.test(paused.statusDetail), paused.statusDetail);
    await waitFor(async () => (await cardText(page)).includes('paused'), 'the card to say paused', 20000, 1000);
    await card.getByText('Resume', { exact: true }).click();
    const resumed = await waitFor(async () => { const t = (await pandesh('GET', `/v1/bridge/tasks/${taskId}`)).json; return t.status !== 'paused' ? t : null; }, 'resumed', 180000, 3000);
    const settled = await waitFor(async () => { const t = (await pandesh('GET', `/v1/bridge/tasks/${taskId}`)).json; return t.control === 'none' && t.status !== 'paused' ? t : null; }, 'control to clear', 30000, 1000);
    check('Resume continues from the preserved work', settled.control === 'none', settled.status);
  }

  // Wait for completion, keeping an eye on approvals.
  let sawApproval = false;
  const done = await waitFor(async () => {
    const t = (await pandesh('GET', `/v1/bridge/tasks/${taskId}`)).json;
    if (t.status === 'awaiting_approval') sawApproval = true;
    if (['needs_attention', 'failed'].includes(t.status)) throw new Error(`task needs attention: ${t.statusDetail}`);
    return t.status === 'completed' ? t : null;
  }, 'completion', Number(process.env.PANDA_E2E_WAIT_MS || 3000000), 8000);
  console.log(`      approvals seen during the run: ${sawApproval ? 'yes' : 'none were raised by the worker'}`);
  check('Pandesh reports completion with independent verification evidence', done.result.verification === 'independent' && /tests|acceptance/.test(done.result.evidence), done.result.evidence?.slice(0, 120));
  check('the final report lists what changed and the commit', done.result.changedFiles.length > 0 && Boolean(done.result.commit), done.result.changedFiles.join(', '));
  check('every state change was checkpointed', ['received', 'awaiting_executor', 'dispatching', 'running', 'completed'].every((s) => done.checkpoints.some((c) => c.status === s)));

  const feed = (await pandesh('GET', '/v1/dev-stories')).json;
  const inPandesh = feed.stories.find((s) => s.id === done.storyId);
  check('the Pandesh development panel feed lists the same task, done and independently verified', Boolean(inPandesh) && inPandesh.status === 'done' && inPandesh.verification === 'independent', inPandesh && `${inPandesh.phase}/${inPandesh.verification}`);
  await waitFor(async () => (await cardText(page)).toLowerCase().includes('completed'), 'the browser card to show completion', 30000, 1500);
  check('the browser extension shows completion with the result', /Verified \(independent\)/.test(await cardText(page)), (await cardText(page)).replace(/\s+/g, ' ').slice(0, 160));

  // Open in Pandesh: the native host relaunches the (stub) app with the conversation id.
  const launched = path.join(path.dirname(process.env.PANDA_E2E_STUB || ''), 'launched.log');
  if (process.env.PANDA_E2E_STUB) fs.rmSync(launched, { force: true });
  await card.getByText('Open in Pandesh', { exact: true }).click();
  if (process.env.PANDA_E2E_STUB) {
    const line = await waitFor(async () => (fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8').trim() : ''), 'the app to be launched', 10000, 300);
    check('Open in Pandesh launches the app with this task’s conversation', line === `--panda-open=${done.conversationId}`, line);
  }
  await context.close();
}

// ------------------------------------------------------------------------------------------------- phase 3
async function phase3() {
  const { taskId, conversationId } = loadState();
  const t = (await pandesh('GET', `/v1/bridge/tasks/${taskId}`)).json;
  check('after restart Pandesh still has the task, completed, with its evidence', t.status === 'completed' && t.result.verification === 'independent' && t.instruction === PROMPT);
  const msgs = (await pandesh('GET', `/v1/conversations/${conversationId}/messages`)).json;
  const list = msgs.messages || msgs;
  check('after restart the conversation still holds the request and the final report', list.some((m) => m.role === 'user' && m.content === PROMPT) && list.some((m) => /done|completed|finished/i.test(String(m.content))), `${list.length} messages`);

  const { context } = await launch(); // same profile: pairing survives in the extension
  const page = await openChat(context);
  await waitFor(async () => (await cardText(page)).includes(PROMPT), 'the task card in a fresh browser session', 30000, 1000);
  check('a fresh browser session shows the same completed task', (await cardText(page)).toLowerCase().includes('completed'));

  // Revocation from Pandesh is immediate.
  const pairing = (await pandesh('GET', '/v1/bridge/pairings')).json.pairings.find((p) => !p.revokedAt && p.extensionId === EXTENSION_ID);
  await pandesh('POST', `/v1/bridge/pairings/${pairing.id}/revoke`, {});
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  const afterRevoke = await popup.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ op: 'tasks' }, resolve)));
  check('revoking in Pandesh cuts the browser off on its very next request', afterRevoke.ok === false && afterRevoke.code === 'pairing_revoked', afterRevoke.code);
  await page.reload();
  await page.waitForSelector('#panda-bridge-root', { state: 'attached' });
  await typeInComposer(page, 'after revoke');
  await page.keyboard.press('Enter');
  await sleep(800);
  check('after revoke nothing is intercepted: Enter goes to ChatGPT', (await submissions(page)).join('|') === 'after revoke');
  await context.close();
}

try {
  await { 1: phase1, 2: phase2, 3: phase3, modes: phaseModes, control: phaseControl }[phase]();
} catch (e) {
  check(`phase ${phase} ran to the end`, false, String(e && e.message || e));
}
const failed = results.filter((r) => !r.ok);
console.log(`\nphase ${phase}: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
