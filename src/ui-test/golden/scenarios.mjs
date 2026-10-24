import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { JSDOM } from 'jsdom';
import { latestCoreTurn, taskEvidence } from '../support/runtimeEvidence.mjs';
import {
  GoldenSession, deliveredCheckout, externalDependencies, freshUserEnv, npmTest, probeDelete, probeDeleteConfirmation, runApp, sleep,
} from './goldenSupport.mjs';

const isBaat = turn => String(turn.route.resolved).startsWith('baat');
const isSaath = turn => String(turn.route.resolved).startsWith('saath');
const isKarke = turn => String(turn.route.resolved).startsWith('karke');

function sameConversation(session, turns) {
  const ids = new Set(turns.map(turn => turn.coreConversationId));
  const locals = new Set(turns.map(turn => turn.localConversationId));
  session.check('all turns share ONE Core conversation id', ids.size === 1 && !ids.has(null), [...ids]);
  session.check('all turns share ONE local conversation id', locals.size === 1, [...locals]);
}

async function readWorkspaceFiles(workspace, filter) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.ollama-agent'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else if (!filter || filter(full)) out.push(full);
    }
  };
  walk(workspace);
  return out;
}

// ── Workflow 1 ────────────────────────────────────────────────────────────────
async function talkBuildTalkBuild(s) {
  const t1 = await s.turn('How does the total spending work right now?', { label: 'talk' });
  s.check('T1 routed to Baat Kar', isBaat(t1), t1.route);
  s.check('T1 made no approval', t1.approvals.length === 0 && t1.coreApprovals.length === 0);
  s.check('T1 made no workspace change', !t1.changedWorkspace);
  s.check('T1 answer is grounded in the actual project (names its code: expenses.js/createStore/total()/reduce)', /expenses\.js|createStore|total\(\)|reduce|items\b/i.test(t1.assistantText), t1.assistantText.slice(0, 300));

  const t2 = await s.turn('Good. Now let me delete an expense.', { label: 'build' });
  s.check('T2 routed to Saath Kar', isSaath(t2), t2.route);
  s.check('T2 same conversation as T1', t2.coreConversationId === t1.coreConversationId);
  s.check('T2 changed the workspace', t2.changedWorkspace);
  const del = await probeDelete(s.workspace);
  s.check('T2 delete feature works when the app is used', del.ok, del.attempts.map(a => a.command));
  const test2 = npmTest(s.workspace);
  s.check('T2 project tests pass', test2.exitCode === 0, test2.output.slice(-500));
  const filesAfter2 = await readWorkspaceFiles(s.workspace, f => /\.(c|m)?js$/.test(f));
  s.check('T2 did not create a duplicate app architecture', filesAfter2.length <= 8, filesAfter2.map(f => path.relative(s.workspace, f)));

  const t3 = await s.turn('Why did you implement it that way?', { label: 'explain' });
  s.check('T3 routed to Baat Kar', isBaat(t3), t3.route);
  s.check('T3 zero additional workspace change', !t3.changedWorkspace, t3.gitAfter.diffStat);
  s.check('T3 no approval', t3.approvals.length === 0);
  s.check('T3 explains the change it made (mentions delete/remove)', /delet|remov/i.test(t3.assistantText), t3.assistantText.slice(0, 300));

  const t4 = await s.turn('Okay. Ask me before an expense is deleted.', { label: 'change-again' });
  s.check('T4 routed to Saath Kar', isSaath(t4), t4.route);
  s.check('T4 changed the workspace', t4.changedWorkspace);
  const gate = await probeDeleteConfirmation(s.workspace, del.command ?? undefined);
  s.check('T4 delete now asks first, "n" keeps, "y" deletes', gate.promptedBeforeDeleting && gate.declineKeepsExpense && gate.acceptDeletes, gate);
  const test4 = npmTest(s.workspace);
  s.check('T4 project tests pass', test4.exitCode === 0, test4.output.slice(-500));
  sameConversation(s, [t1, t2, t3, t4]);
}

// ── Workflow 2 ────────────────────────────────────────────────────────────────
const PERSISTENCE_REPORT = "I added a couple of expenses, but when I reopen the app they're gone. Make them stay.";
async function naturalBugReport(s, report = PERSISTENCE_REPORT) {
  const t = await s.turn(report, { label: 'bug-report' });
  s.check('a real change was made (not just an explanation)', t.changedWorkspace, t.route);
  // Judge the delivered change, not the task worktree: behaviour and tests each
  // run in their own pristine checkout of the delivered commit with a fresh
  // HOME, so data the model's validation runs left behind cannot sway the
  // verdict. That residue is preserved and reported on its own.
  const scratch = path.dirname(s.workspace);
  const delivered = deliveredCheckout(s.workspace, s.coreData, path.join(scratch, 'delivered-behaviour'));
  s.evidence.json('delivered-checkout.json', delivered);
  if (delivered.residue.length > 0) s.evidence.json('task-worktree-residue.json', delivered.residue);
  const env = freshUserEnv();
  await runApp(delivered.checkout, ['add coffee 4', 'add lunch 12', 'exit'], { env });
  const reopened = await runApp(delivered.checkout, ['list', 'total', 'exit'], { env });
  s.check('expenses survive closing and reopening the app', /coffee/i.test(reopened) && /lunch/i.test(reopened) && /16/.test(reopened), reopened.slice(-400));
  const still = await runApp(delivered.checkout, ['add tea 2', 'total', 'exit'], { env });
  s.check('existing add/total behaviour still works', /Total:\s*18/.test(still), still.slice(-300));
  const testCheckout = deliveredCheckout(s.workspace, s.coreData, path.join(scratch, 'delivered-tests'));
  const tests = npmTest(testCheckout.checkout, { env: freshUserEnv() });
  s.check('project tests pass', tests.exitCode === 0, tests.output.slice(-500));
}

// ── Workflow 3 ────────────────────────────────────────────────────────────────
async function queueNextWhileSaathWorks(s) {
  const second = 'Also keep this dependency-free.';
  let queuedText = null;
  let boundHeld = null;
  const t1 = await s.turn('I want to add categories to my expenses, and I want to see the total spent per category.', {
    label: 'long-saath',
    onRunning: async ({ session }) => {
      const snap = await session.view.snapshot();
      session.check('composer stays editable while work runs', !snap.composerDisabled);
      queuedText = await session.view.queueNext(second);
      await session.shot('queued-next-turn');
      // Bound: with one already queued, a second message cannot be queued.
      await session.view.typeComposer('a second queued message');
      boundHeld = await session.view.driver.executeScript("return document.getElementById('send-btn').disabled === true");
      await session.view.driver.executeScript("const t=document.getElementById('user-input'); t.value=''; t.dispatchEvent(new Event('input',{bubbles:true}));");
    },
  });
  s.check('first turn was a real Saath Kar operation (tools + approvals), not Baat/Karke', isSaath(t1) && t1.approvals.length > 0, [t1.route, t1.approvals.length]);
  s.check('queued text was shown as "Queued for next turn" (not Steer)', /Queued for next turn/i.test(queuedText ?? '') && !/Steer/i.test(queuedText ?? ''), queuedText);
  s.check('at most one message can be queued (bound holds)', boundHeld === true);
  // The queued message must now run as its OWN normal turn.
  const t2 = await s.drive(second, { label: 'queued-next-turn', timeout: 20 * 60_000 });
  s.check('queued message ran as a fresh turn in the same conversation', t2.coreConversationId === t1.coreConversationId, [t1.coreConversationId, t2.coreConversationId]);
  s.check('queued turn was routed fresh (has its own request)', t2.requestId && t2.requestId !== t1.requestId);
  const after = await s.view.snapshot();
  s.check('the queue strip cleared after dispatch', (await s.view.queueStripText()) === null);
  const deps = externalDependencies(s.workspace);
  s.check('application remains dependency-free', deps.imported.length === 0 && deps.declared.length === 0 && !deps.nodeModulesPresent, deps);
  const tests = npmTest(s.workspace);
  s.check('project tests pass', tests.exitCode === 0, tests.output.slice(-500));
  s.check('no lost text: queued message is present as a user bubble', after.userTexts.some(text => text.includes(second)), after.userTexts);
}

// ── Workflow 4 ────────────────────────────────────────────────────────────────
async function karkeSteering(s) {
  const steerText = "Actually, make it Excel. That's what I need.";
  const observed = {};
  const t = await s.turn('Add a way to export my expenses so I can use them elsewhere.', {
    mode: 'autonomous',
    label: 'karke-export',
    onRunning: async ({ session }) => {
      observed.ack = await session.view.waitForAcknowledgement(120_000);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try {
          const state = taskEvidence(session.workspace, observed.ack.taskId).task.state;
          if (['running', 'validating', 'waiting_for_proposal_approval', 'waiting_for_mutation_approval'].includes(state)) break;
        } catch { /* durable task file not yet written */ }
        await sleep(500);
      }
      observed.taskIdAtSteer = await session.view.steer(steerText);
      await session.shot('karke-steer-submitted');
      await sleep(2500);
      observed.afterSteerBody = (await session.view.snapshot()).bodyText;
    },
  });
  s.check('a Karke Dikha task ran', isKarke(t), t.route);
  s.check('steering targeted the acknowledged task', observed.taskIdAtSteer === observed.ack?.taskId, observed);
  s.check('UI truthfully reported the update as queued/received (not applied instantly)', /queued|received|safe step/i.test(observed.afterSteerBody ?? ''), (observed.afterSteerBody ?? '').slice(-400));
  const taskDirs = fs.readdirSync(path.join(s.workspace, '.ollama-agent', 'autonomous-tasks'));
  s.check('no unrelated second autonomous task was created', taskDirs.length === 1, taskDirs);
  const { task, events } = taskEvidence(s.workspace, t.taskId);
  s.check('durable task record holds the steering update', JSON.stringify({ task, events }).includes('Excel'), events.length);
  s.check('steering was applied at a safe boundary (follow_up_applied recorded)', events.some(event => event.type === 'follow_up_applied'), events.filter(event => /follow_up|steer/.test(event.type + JSON.stringify(event.payload))).map(event => event.type));
  s.check('the task did not end blocked/failed because of the steering update', t.taskState === 'completed', [t.taskState, task.failure?.classification]);
  const files = await readWorkspaceFiles(s.workspace, () => true);
  const blob = files.map(file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }).join('\n') + files.join('\n');
  s.check('final result satisfies the Excel request', /xlsx|excel|spreadsheetml|\.xls/i.test(blob));
}

// ── Workflow 5 ────────────────────────────────────────────────────────────────
async function newChatHardReset(s) {
  const t1 = await s.turn('create note.txt containing Hello', { mode: 'autonomous', label: 'completed-karke' });
  s.check('first Karke task reached a terminal state', ['completed', 'failed', 'cancelled', 'blocked'].includes(t1.taskState), t1.taskState);
  // First reset: after a COMPLETED task. (A short follow-up in the SAME conversation
  // triggers the continuity clarifier, so the next task starts in a fresh chat.)
  const completedConversation = (await s.view.snapshot()).conversationId;
  const afterCompleted = await s.view.newChat();
  s.check('New Chat after a completed task: fresh empty conversation', afterCompleted.conversationId !== completedConversation && afterCompleted.userCount === 0 && afterCompleted.responseCount === 0 && (!afterCompleted.taskId || afterCompleted.taskId === '—'));
  // A second, longer task is left RUNNING in the background while New Chat happens.
  await s.view.submitInMode('autonomous', 'Add a way to export my expenses to a file.');
  const bg = await s.view.waitForAcknowledgement(120_000);
  const priorConversation = (await s.view.snapshot()).conversationId;
  const fresh = await s.view.newChat();
  await s.shot('after-new-chat');
  const assertClean = (snap, phase) => {
    s.check(`${phase}: fresh conversation id`, snap.conversationId && snap.conversationId !== priorConversation, [snap.conversationId, priorConversation]);
    s.check(`${phase}: empty transcript`, snap.userCount === 0 && snap.assistantCount === 0 && snap.responseCount === 0);
    s.check(`${phase}: idle composer (Send, no Stop)`, snap.primaryAction === 'Send' && !snap.compactStopVisible, snap.primaryAction);
    s.check(`${phase}: no old task/attempt id`, (!snap.taskId || snap.taskId === '—') && (!snap.attemptId || snap.attemptId === '—'), [snap.taskId, snap.attemptId]);
    s.check(`${phase}: no old approval`, snap.actionableApprovals === 0 && snap.approvalCards.every(card => !card.visible));
    s.check(`${phase}: no Completed/Investigating/old stage text`, !/Completed|Investigating|Task completed/i.test(snap.bodyText.replace(/History[\s\S]*$/i, '')), snap.bodyText.slice(0, 400));
    s.check(`${phase}: no old task panel`, snap.responseVisible === false && snap.pandaVisible === false, [snap.responseVisible, snap.pandaVisible]);
  };
  assertClean(fresh, 'immediately after New Chat');
  // Give the still-running background task time to emit events into the old surface.
  await sleep(8000);
  assertClean(await s.view.snapshot(), 'after background task activity');
  await s.view.reloadWindow();
  await sleep(4000);
  const reloaded = await s.view.snapshot();
  await s.shot('after-reload');
  assertClean(reloaded, 'after webview/host reload');
  s.check('background task was not lost (durable record exists)', fs.existsSync(path.join(s.workspace, '.ollama-agent', 'autonomous-tasks', bg.taskId)), bg.taskId);
  const t2 = await s.turn('Help me make a Pomodoro timer.', { label: 'fresh-chat-turn', approve: false });
  s.check('fresh turn is a new Core conversation', t2.coreConversationId && t2.coreConversationId !== t1.coreConversationId, [t1.coreConversationId, t2.coreConversationId]);
  s.check('answer is about the Pomodoro request, not the old task', /pomodoro/i.test(t2.assistantText) && !/note\.txt/i.test(t2.assistantText), t2.assistantText.slice(0, 300));
}

// ── Workflow 6 ────────────────────────────────────────────────────────────────
async function pomodoroProbe(workspace) {
  const files = await readWorkspaceFiles(workspace, f => /\.html?$/i.test(f));
  if (!files.length) return { level: 'none', reason: 'no html file produced', checks: {} };
  const file = files.find(f => /index\.html?$/i.test(f)) ?? files[0];
  const dom = await JSDOM.fromFile(file, { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
  await sleep(800);
  const doc = dom.window.document;
  const time = () => (doc.body.textContent.match(/\b\d{1,2}:\d{2}\b/) ?? [null])[0];
  const buttons = () => [...doc.querySelectorAll('button, [role=button], input[type=button], input[type=submit]')];
  const find = re => buttons().find(b => re.test((b.textContent || b.value || b.getAttribute('aria-label') || '').trim()));
  const click = el => el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const checks = {};
  checks.initial25 = time() === '25:00';
  const start = find(/start|play|begin/i);
  const pause = find(/pause|stop/i) ?? start;
  const reset = find(/reset|restart|clear/i);
  const breakBtn = find(/break/i);
  const focusBtn = find(/focus|work|pomodoro|25/i);
  checks.hasControls = Boolean(start && pause && reset && breakBtn);
  click(start); await sleep(2300);
  const running = time();
  checks.startsCounting = running !== null && running !== '25:00';
  click(pause); await sleep(300);
  const paused = time(); await sleep(1600);
  checks.pausesCounting = time() === paused;
  click(reset); await sleep(300);
  checks.resetsTo25 = time() === '25:00';
  click(breakBtn); await sleep(300);
  checks.breakIs05 = time() === '05:00';
  click(focusBtn); await sleep(300);
  checks.backToFocus25 = time() === '25:00';
  dom.window.close();
  return { level: 'rendered-dom', file: path.relative(workspace, file), checks };
}

async function pomodoroBuild(s) {
  const t = await s.turn('Build me a simple Pomodoro timer. I want to start and pause it, reset it, and switch between 25-minute focus sessions and 5-minute breaks.', {
    mode: 'autonomous', label: 'karke-build',
  });
  s.check('Karke Dikha completed the task', t.taskState === 'completed', [t.taskState, t.route]);
  s.check('proposal/mutation/delivery approvals were surfaced and coherent', t.approvals.length >= 1, t.approvals);
  s.check('real files were produced in the workspace', t.changedWorkspace || t.gitAfter.head !== t.gitBefore.head, t.gitAfter);
  const probe = await pomodoroProbe(s.workspace);
  s.evidence.json('pomodoro-probe.json', probe);
  s.check('rendered app supports the requested behaviour', probe.level === 'rendered-dom' && Object.values(probe.checks).every(Boolean), probe);
}

// ── Workflow 7 ────────────────────────────────────────────────────────────────
// The exact visible sequence that exposed the read-only mutation defect: a
// Saath Kar coding turn (approved) followed by an explicit read-only inspection
// in the same conversation. B must create zero mutation proposals, receive no
// "modification required" nudge, and reuse nothing from A.
const READ_ONLY_OBJECTIVE = 'Inspect this workspace and explain what this project does, its main components, and how it is run. Do not modify any files.';
const sha16 = file => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16) : null);

function attemptPolicyEvidence(coreDataDir, attemptId) {
  const db = new DatabaseSync(path.join(coreDataDir, 'core.db'), { readOnly: true });
  try {
    const events = type => db.prepare('SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = ? ORDER BY sequence').all(attemptId, type).map(row => JSON.parse(row.metadata));
    const approvals = db.prepare(`SELECT id, json_extract(summary, '$.toolName') AS tool, status FROM approvals WHERE attemptId = ? OR json_extract(summary, '$.scopeIdentity') = ?`).all(attemptId, attemptId);
    const proposals = approvals.filter(item => ['propose_file_change', 'propose_text_edit'].includes(item.tool));
    const selection = db.prepare('SELECT modelSelection FROM attempt_contexts WHERE attemptId = ?').get(attemptId);
    return {
      policy: events('mutation_policy_decided'),
      corrections: events('mutation_proposal_correction_started'),
      denied: events('mutation_denied_by_policy'),
      approvals,
      proposals,
      fileModificationRecorded: selection?.modelSelection ? JSON.parse(selection.modelSelection).requiredCapabilities?.fileModification ?? null : null,
    };
  } finally {
    db.close();
  }
}

async function readOnlyAfterBuild(s) {
  const a = await s.turn('lets build an html with login page', { mode: 'agent', label: 'build-login' });
  s.check('A routed to Saath Kar', isSaath(a), a.route);
  // The model names the page (login.html, index.html, ...); what matters is that A governed-created an HTML page.
  const createdHtml = fs.readdirSync(s.workspace).filter(name => /\.html?$/i.test(name));
  const loginFile = createdHtml.find(name => /login/i.test(name)) ?? createdHtml[0] ?? 'login.html';
  s.check('A created an HTML login page through the governed approval path', createdHtml.length > 0 && a.changedWorkspace, [createdHtml, a.gitAfter]);
  const loginHashAfterA = sha16(path.join(s.workspace, loginFile));

  // B may need a reviewed read-only command (e.g. a directory listing); answer only those, never a mutation card.
  const bOptions = { mode: 'agent', label: 'read-only-inspect', approve: 'tools', timeout: 8 * 60_000 };
  let b;
  try {
    b = await s.turn(READ_ONLY_OBJECTIVE, bOptions);
  } catch (error) {
    // Objective arbitration may show "Should I treat it as a new task?" and the
    // UI-level dead-end detector keeps seeing that bubble. What matters is Core's
    // own record of B, so wait for B's attempt to reach a terminal state there.
    if (!/treat it as a new task|PRODUCT_DEAD_END/i.test(String(error))) throw error;
    const deadline = Date.now() + 8 * 60_000;
    let core = latestCoreTurn(s.coreData, READ_ONLY_OBJECTIVE);
    while (Date.now() < deadline && !['completed', 'failed', 'cancelled', 'waiting_for_approval'].includes(core?.attempt?.status)) {
      await sleep(2000);
      core = latestCoreTurn(s.coreData, READ_ONLY_OBJECTIVE);
    }
    const snap = await s.view.snapshot();
    b = {
      route: { requested: core?.request?.requestedMode ?? null, resolved: core?.request?.resolvedMode ?? null },
      coreConversationId: core?.request?.conversationId ?? null,
      attemptId: core?.attempt?.id ?? null,
      attemptStatus: core?.attempt?.status ?? null,
      approvals: [],
      changedWorkspace: false,
      gitAfter: null,
      assistantText: core?.messages?.filter(m => m.role === 'assistant').at(-1)?.content ?? snap.assistantTexts.at(-1) ?? '',
    };
  }
  s.check('B routed to Saath Kar in the same conversation', isSaath(b) && b.coreConversationId === a.coreConversationId, [b.route, a.coreConversationId, b.coreConversationId]);
  s.check('B completed', b.attemptStatus === 'completed', b.attemptStatus);
  const evidence = attemptPolicyEvidence(s.coreData, b.attemptId);
  s.evidence.json('read-only-policy-evidence.json', evidence);
  s.check('B recorded mutationPolicy=denied for its own objective hash', evidence.policy.length === 1 && evidence.policy[0].mutationPolicy === 'denied'
    && evidence.policy[0].objectiveHash === crypto.createHash('sha256').update(READ_ONLY_OBJECTIVE).digest('hex').slice(0, 16), evidence.policy);
  s.check('B did not require file modification', evidence.fileModificationRecorded === false && evidence.policy[0]?.fileModificationRequired === false, evidence.fileModificationRecorded);
  s.check('B exposed no mutating tool', !evidence.policy[0]?.exposedTools?.some(name => /propose|write|delete|rename|apply|commit|patch/i.test(name)), evidence.policy[0]?.exposedTools);
  s.check('B produced ZERO mutation proposals', evidence.proposals.length === 0, evidence.proposals);
  s.check('B created no mutation approval card of any kind', b.approvals.filter(item => item.kind !== 'tool').length === 0 && evidence.proposals.length === 0, [b.approvals, evidence.approvals]);
  s.check('B received no mutation-correction nudge', evidence.corrections.length === 0, evidence.corrections);
  s.check('B workspace bytes unchanged (login page identical to after A)', sha16(path.join(s.workspace, loginFile)) === loginHashAfterA && !b.changedWorkspace, [loginHashAfterA, b.gitAfter]);
  const body = (await s.view.snapshot()).bodyText;
  s.check('B never showed Making the change / Ready to apply', !/Making the change|Ready to apply/i.test(body.split(READ_ONLY_OBJECTIVE).at(-1) ?? ''), body.slice(-600));
  s.check('B answered directly (non-empty explanation)', (b.assistantText ?? '').trim().length > 40, b.assistantText.slice(0, 200));
}

// ── UAT: Duplicate Event on the user's real event_forms.html (observe KKD; never implements the feature itself) ──
const DUPLICATE_EVENT_TASK = `Add a Duplicate Event feature to this existing Turnout Event Form Studio.

Add a Duplicate action for an existing event.

When used, create a new independent event with:
- a new unique ID
- title: <original title> — Copy

Copy the original event's:
- form blocks/questions
- theme/design
- background configuration
- event settings
- ticket tier definitions and prices

Do NOT copy runtime/user data.

The duplicated event must:
- start unpublished/as a draft
- contain no responses
- have fresh/reset analytics and stats
- reset every ticket tier's sold count to 0
- not mutate the original event in any way

Persist the duplicate using the application's existing persistence mechanism.

After duplication, automatically open the new duplicate in Studio.

Reuse the existing architecture, data model and visual style.

Do not:
- introduce a framework
- redesign the application
- refactor unrelated code
- add a backend
- change unrelated behavior

Validate the implementation sufficiently to demonstrate:
1. the duplicate receives a different ID
2. configuration/content was copied
3. runtime data was reset
4. ticket sold counts were reset
5. modifying the duplicate does not mutate the original
6. persistence still works`;
const DUPLICATE_EVENT_FOLLOW_UP = 'Briefly summarize what you changed and how I can manually test Duplicate Event.';

async function duplicateEventUat(s) {
  const t = await s.turn(DUPLICATE_EVENT_TASK, { mode: 'autonomous', label: 'uat-duplicate-event', timeout: 75 * 60_000 });
  s.check('UAT: Karke Dikha completed the task', t.taskState === 'completed', [t.taskState, t.route]);
  s.check('UAT: approvals surfaced', t.approvals.length >= 1, t.approvals.map(item => item.kind));
  s.check('UAT: event_forms.html changed in the workspace', t.changedWorkspace, t.gitAfter);
  const html = fs.readFileSync(path.join(s.workspace, 'event_forms.html'), 'utf8');
  s.check('UAT: Duplicate feature present in the file', /duplicat/i.test(html), html.length);
  const f = await s.turn(DUPLICATE_EVENT_FOLLOW_UP, { mode: 'autonomous', label: 'uat-follow-up', timeout: 15 * 60_000 });
  s.check('UAT: follow-up answered in the same conversation', f.coreConversationId === t.coreConversationId, [t.coreConversationId, f.coreConversationId]);
  s.check('UAT: follow-up did not start/resume another autonomous task', !f.approvals.some(item => ['proposal', 'mutation', 'delivery'].includes(item.kind)) && !f.changedWorkspace, [f.route, f.approvals.map(item => item.kind), f.changedWorkspace]);
  s.check('UAT: follow-up produced an explanation', (f.assistantText ?? '').trim().length > 40, (f.assistantText ?? '').slice(0, 200));
}

// ── Daily model-qualification scenarios (scripts/model-bench) ────────────────
// Short, real-repo tasks with external consequence oracles. Not release acceptance.
async function dailySmallBug(s) {
  const t = await s.turn('In my expense app, adding an expense with a negative amount gets accepted and my total goes down. Please fix it so negative or zero amounts are rejected like other bad input.', { label: 'small-bug' });
  s.check('a real change was made (not just an explanation)', t.changedWorkspace, t.route);
  const scratch = path.dirname(s.workspace);
  const delivered = deliveredCheckout(s.workspace, s.coreData, path.join(scratch, 'delivered-behaviour'));
  s.evidence.json('delivered-checkout.json', delivered);
  const rejected = await runApp(delivered.checkout, ['add coffee -4', 'add tea 0', 'total', 'exit'], { env: freshUserEnv() });
  s.check('negative and zero amounts are rejected', /error|invalid/i.test(rejected) && /Total:\s*0(\.00)?/.test(rejected) && !/Added #/.test(rejected), rejected.slice(-300));
  const still = await runApp(delivered.checkout, ['add lunch 12', 'add tea 2.5', 'list', 'total', 'exit'], { env: freshUserEnv() });
  s.check('existing add/list/total behaviour still works', /Total:\s*14\.50/.test(still) && /lunch/.test(still), still.slice(-300));
  const changed = execFileSync('git', ['diff', '--name-only', delivered.baseCommit, delivered.deliveredCommit], { cwd: delivered.checkout, encoding: 'utf8' }).split('\n').map(line => line.trim()).filter(Boolean);
  s.check('no unrelated files changed', changed.every(file => ['expenses.js', 'cli.js'].includes(file) || file.startsWith('test/')), changed);
  const tests = npmTest(deliveredCheckout(s.workspace, s.coreData, path.join(scratch, 'delivered-tests')).checkout, { env: freshUserEnv() });
  s.check('project tests pass', tests.exitCode === 0, tests.output.slice(-500));
}

async function dailyNaturalReport(s) {
  return naturalBugReport(s, 'The saved value is gone after I reopen the app. Please fix it without changing the rest.');
}

async function dailyFollowUp(s) {
  const t1 = await s.turn('Add a "count" command that prints how many expenses have been added, like "Count: 2".', { label: 'change' });
  s.check('T1 changed the workspace', t1.changedWorkspace, t1.route);
  const out = await runApp(s.workspace, ['add lunch 12', 'add tea 2', 'count', 'total', 'exit'], { env: freshUserEnv() });
  s.check('count command works and total still works', /Count:\s*2/i.test(out) && /Total:\s*14/.test(out), out.slice(-300));
  const t2 = await s.turn('Now briefly tell me what changed and how I can check it.', { label: 'follow-up' });
  s.check('T2 same conversation', t2.coreConversationId === t1.coreConversationId, [t1.coreConversationId, t2.coreConversationId]);
  s.check('T2 stayed conversational (no Karke route)', !isKarke(t2), t2.route);
  s.check('T2 no new task/approval and no duplicate mutation', !t2.changedWorkspace && !t2.approvals.some(item => ['proposal', 'mutation', 'delivery'].includes(item.kind)), [t2.approvals.map(item => item.kind), t2.changedWorkspace]);
  s.check('T2 explains the change (mentions count)', /count/i.test(t2.assistantText) && t2.assistantText.trim().length > 40 && !/no change/i.test(t2.assistantText), t2.assistantText.slice(0, 300));
}

// Bounded post-M50 qualification scenarios (investigate / multi-file edit / validation recovery). Named d* so the
// default Golden set stays unchanged; each has a deterministic oracle and no model judging.
const INVESTIGATE_OBJECTIVE = "In my expense app, the expenses I add are gone every time I close and reopen it. Investigate why this happens: which file and which part of the code is responsible? Just explain what you find. Do not modify any files.";
async function dailyInvestigate(s) {
  const t = await s.turn(INVESTIGATE_OBJECTIVE, { mode: 'agent', label: 'investigate', approve: 'tools', timeout: 10 * 60_000 });
  s.check('turn completed', t.attemptStatus === 'completed', t.attemptStatus);
  s.check('workspace bytes unchanged (no mutation)', !t.changedWorkspace, t.gitAfter.diffStat);
  const evidence = attemptPolicyEvidence(s.coreData, t.attemptId);
  s.evidence.json('investigate-policy-evidence.json', evidence);
  s.check('zero mutation proposals', evidence.proposals.length === 0, evidence.proposals);
  s.check('no mutation/proposal/delivery approval surfaced', t.approvals.every(item => item.kind === 'tool'), t.approvals.map(item => item.kind));
  const answer = t.assistantText ?? '';
  s.check('answer names the responsible file/code (expenses.js / createStore / items)', /expenses\.js|createStore|\bitems\b/i.test(answer), answer.slice(0, 300));
  s.check('answer reaches the correct conclusion (in-memory only, never persisted)', /in[- ]memory|not (?:persist|saved|stored|written)|never (?:persist|saved|stored|written)|no (?:persist|file|storage|saving)|lost (?:when|on)|does(?:n't| not) (?:persist|save|store)|volatile/i.test(answer), answer.slice(0, 300));
}

async function dailyMultiFileEdit(s) {
  const t = await s.turn('Add a "remove <id>" command to my expense app that deletes the expense with that id and prints a confirmation. Removing an id that does not exist should print an error and change nothing. Please add a test for it too.', { label: 'multi-file-edit' });
  s.check('a real change was made', t.changedWorkspace, t.route);
  const scratch = path.dirname(s.workspace);
  const delivered = deliveredCheckout(s.workspace, s.coreData, path.join(scratch, 'delivered-behaviour'));
  s.evidence.json('delivered-checkout.json', delivered);
  const removed = await runApp(delivered.checkout, ['add lunch 12', 'add coffee 4', 'remove 1', 'list', 'total', 'exit'], { env: freshUserEnv() });
  s.check('remove <id> deletes only that expense and the total follows', !/^\s*1\.\s.*lunch/im.test(removed) && /^\s*2\.\s.*coffee/im.test(removed) && /Total:\s*4(\.00)?\b/.test(removed), removed.slice(-400));
  const missing = await runApp(delivered.checkout, ['add lunch 12', 'remove 99', 'list', 'total', 'exit'], { env: freshUserEnv() });
  s.check('removing an unknown id reports an error and changes nothing', /error|not found|no such|unknown|invalid|does not exist/i.test(missing.split(/Total:/)[0]) && /lunch/.test(missing) && /Total:\s*12(\.00)?\b/.test(missing), missing.slice(-400));
  const still = await runApp(delivered.checkout, ['add tea 2.5', 'add lunch 12', 'total', 'exit'], { env: freshUserEnv() });
  s.check('existing add/total behaviour still works', /Total:\s*14\.50/.test(still), still.slice(-300));
  const changed = execFileSync('git', ['diff', '--name-only', delivered.baseCommit, delivered.deliveredCommit], { cwd: delivered.checkout, encoding: 'utf8' }).split('\n').map(line => line.trim()).filter(Boolean);
  s.evidence.json('delivered-changed-files.json', changed);
  s.check('coordinated change: store (expenses.js) and command (cli.js) both changed', changed.includes('expenses.js') && changed.includes('cli.js'), changed);
  s.check('a test was added or extended', changed.some(file => file.startsWith('test/')), changed);
  const tests = npmTest(deliveredCheckout(s.workspace, s.coreData, path.join(scratch, 'delivered-tests')).checkout, { env: freshUserEnv() });
  s.check('project tests pass', tests.exitCode === 0, tests.output.slice(-500));
}

async function dailyValidationRecovery(s) {
  const t = await s.turn('Add a "clear" command to my expense app that removes all expenses and prints "Cleared". After clear, "total" should print 0.00.', { label: 'validation-recovery' });
  s.check('a real change was made', t.changedWorkspace, t.route);
  const scratch = path.dirname(s.workspace);
  const delivered = deliveredCheckout(s.workspace, s.coreData, path.join(scratch, 'delivered-behaviour'));
  s.evidence.json('delivered-checkout.json', delivered);
  const cleared = await runApp(delivered.checkout, ['add lunch 12', 'add coffee 4', 'clear', 'total', 'list', 'add tea 2', 'total', 'exit'], { env: freshUserEnv() });
  s.check('clear empties the store and prints Cleared', /Cleared/i.test(cleared) && /Total:\s*0(\.00)?\b/.test(cleared) && !/lunch|coffee/i.test(cleared.split(/Cleared/i)[1] ?? ''), cleared.slice(-400));
  s.check('the store still works after clear', /Total:\s*2(\.00)?\b/.test(cleared.split(/Cleared/i)[1] ?? ''), cleared.slice(-300));
  const readme = fs.readFileSync(path.join(delivered.checkout, 'README.md'), 'utf8');
  s.check('README documents the clear command (project convention enforced by test/readme.test.js)', readme.includes('`clear'), readme.slice(-300));
  const tests = npmTest(deliveredCheckout(s.workspace, s.coreData, path.join(scratch, 'delivered-tests')).checkout, { env: freshUserEnv() });
  s.check('project tests pass (including the README convention test)', tests.exitCode === 0, tests.output.slice(-500));
}

export const SCENARIOS = {
  'd7-investigate': { title: 'Daily: read-only investigation (why do expenses vanish on reopen)', fixture: 'expense', run: dailyInvestigate },
  'd8-multi-file-edit': { title: 'Daily: coordinated multi-file edit (remove <id> command + test)', fixture: 'expense', run: dailyMultiFileEdit },
  'd9-validation-recovery': { title: 'Daily: add clear command under a README-convention test (validation/recovery)', fixture: 'expense-documented', run: dailyValidationRecovery },
  'd1-small-bug': { title: 'Daily: small bug (negative amounts accepted)', fixture: 'expense', run: dailySmallBug },
  'd4-natural-report': { title: 'Daily: natural vague bug report (data lost on reopen)', fixture: 'expense', run: dailyNaturalReport },
  'd6-follow-up': { title: 'Daily: change then conversational follow-up', fixture: 'expense', run: dailyFollowUp },
  'uat-duplicate-event': { title: 'UAT: Duplicate Event on real event_forms.html', fixture: 'eventforms', run: duplicateEventUat },
  'g1-talk-build-talk-build': { title: 'Talk → build → talk → build (one conversation)', fixture: 'expense', run: talkBuildTalkBuild },
  'g2-natural-bug-report': { title: 'Natural bug report → diagnosis → fix', fixture: 'expense', run: naturalBugReport },
  'g3-queue-next-during-saath': { title: 'Queue next message while Saath works', fixture: 'expense', run: queueNextWhileSaathWorks },
  'g4-karke-steering': { title: 'Karke Dikha task steering', fixture: 'expense', run: karkeSteering },
  'g5-new-chat-hard-reset': { title: 'New Chat + reload isolation', fixture: 'expense', run: newChatHardReset },
  'g6-full-karke-build': { title: 'Full autonomous Pomodoro build', fixture: 'blank', run: pomodoroBuild },
  'g7-readonly-after-build': { title: 'Saath build → explicit read-only inspection (mutationPolicy=denied)', fixture: 'blank', run: readOnlyAfterBuild },
};

export async function runGolden(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown golden scenario ${name}`);
  const session = new GoldenSession(name);
  try {
    await session.open();
    await scenario.run(session);
    session.assertAll();
    session.finish('passed');
  } catch (error) {
    await session.shot('failure');
    try { session.evidence.text(`${name}-failure-body.txt`, (await session.view.snapshot()).bodyText); } catch { /* best effort */ }
    session.finish('failed', error);
    throw error;
  }
}
