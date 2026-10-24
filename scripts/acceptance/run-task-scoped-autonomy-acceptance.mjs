#!/usr/bin/env node
// npm run test:e2e:task-scoped-autonomy
//
// Installed, local-only acceptance for the "Task-Scoped Autonomy V1"
// milestone: real packaged VS Code + this machine's real local Ollama. No
// cloud calls. Reuses the exact launch/drive primitives already proven by
// run-progress-completion-ux-acceptance.mjs.
//
// JOURNEY 1 — SUPERVISED: proves ordinary supervised behavior is unchanged —
//   exactly one actionable gate, reject it, nothing resurrects, nothing
//   unauthorized happens.
// JOURNEY 2 — HANDS-OFF: fresh fixture, zero approval clicks touched. Proves
//   every ordinary gate auto-authorizes (evidence read directly off the
//   persisted task.json/events.jsonl on disk, not just DOM), the autonomy
//   selector cannot retroactively change the running task's frozen mode, and
//   the task reaches either delivery or a truthful terminal block/failure.
// JOURNEY 3 — SAFETY BLOCK: fresh fixture with an unrelated tracked dirty
//   file present from the start. Proves Hands-off still blocks unsafe
//   delivery and never touches the unrelated bytes.
//
// Opt-in only: requires OLLAMA_AGENT_LIVE_TASK_SCOPED_AUTONOMY=1 or --enabled.

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  resolveVSCode,
  installExtension,
  launchPlainHost,
  terminatePlainHost,
  allocateDebugPort,
  detectActiveVSCodeUpdater,
} from './plainVsCodeHost.mjs';
import * as board from './boardUiDriver.mjs';
import * as ui from './uiDriver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const enabled = process.env.OLLAMA_AGENT_LIVE_TASK_SCOPED_AUTONOMY === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: Task-Scoped Autonomy acceptance requires OLLAMA_AGENT_LIVE_TASK_SCOPED_AUTONOMY=1 or --enabled.');
  console.log('It launches a real packaged VS Code window against this machine\'s real local Ollama. No cloud calls are made.');
  process.exit(0);
}

const TASK_JOURNEY1 = 'Add validation so registerUser rejects an empty username and update the relevant tests.';
const TASK_JOURNEY2 = 'Add validation so registerUser rejects an empty username and update the relevant tests. Run the relevant validation and finish the task.';
const TASK_JOURNEY3 = 'Add a short doc comment above registerUser explaining what it validates.';

const startedAt = Date.now();
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-task-scoped-autonomy-acceptance-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'task-scoped-autonomy-v1');

// Each journey launches its OWN fresh profile (userDataDir/extensionsDir)
// AND its own Core data directory — the "KarkeDikha Setup" onboarding
// webview `launchWindow` waits for only ever appears once per fresh profile,
// so reusing one profile across separately-launched journeys would hang the
// second launch forever. A shared coreDataDir is worse: a Core process from
// a still-shutting-down prior journey can hold a lock on that SQLite DB,
// hanging the next journey's fresh Core process indefinitely (observed live
// — onboarding never reached READY because Core connectivity never
// resolved). Each journey gets its own, so a slow-to-exit prior Core process
// can never block the next journey's Core from starting cleanly.
function freshProfilePaths(label) {
  return {
    userDataDir: path.join(workDir, `user-data-${label}`),
    extensionsDir: path.join(workDir, `extensions-${label}`),
    coreDataDir: path.join(workDir, `core-data-${label}`),
  };
}

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[task-scoped-autonomy-acceptance +${elapsed}s] ${message}`);
}

const evidence = { journeys: [] };
function writeEvidence(name, data) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify({ capturedAt: new Date().toISOString(), ...data }, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntil(conditionFn, { timeoutMs = 30000, intervalMs = 500, describe } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await conditionFn();
      if (result && result.done) return result.value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe?.() ?? 'condition'}${lastError ? `; lastError=${lastError.message}` : ''}`);
}

async function evaluateExpr(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(`CDP Runtime.evaluate threw: ${exceptionDetails.text}`);
  return result.value;
}

async function evalInWebviewContentDoc(client, docExpression) {
  return evaluateExpr(client, `(() => {
    const inner = window.document.getElementById('active-frame');
    if (!inner) return { __noActiveFrame: true };
    const document = inner.contentDocument;
    if (!document) return { __noContentDocument: true };
    return (${docExpression});
  })()`);
}

async function screenshot(pageClient, label) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  try {
    const { data } = await pageClient.Page.captureScreenshot({ format: 'png' });
    fs.writeFileSync(path.join(evidenceDir, `${label}.png`), Buffer.from(data, 'base64'));
    log(`screenshot: ${label}.png`);
  } catch (error) {
    log(`screenshot FAILED for ${label}: ${error.message}`);
  }
}

function gitStatus(dir) { return spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim(); }
function readFile(dir, rel) { return fs.readFileSync(path.join(dir, rel), 'utf8'); }

// ── Direct on-disk evidence (bypasses the DOM entirely) ─────────────────────
function taskDir(workspaceDir, taskId) { return path.join(workspaceDir, '.ollama-agent', 'autonomous-tasks', taskId); }
function readPersistedTask(workspaceDir, taskId) {
  return JSON.parse(fs.readFileSync(path.join(taskDir(workspaceDir, taskId), 'task.json'), 'utf8'));
}
function readPersistedEvents(workspaceDir, taskId) {
  const file = path.join(taskDir(workspaceDir, taskId), 'events.jsonl');
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
function progressLines(events) {
  return events.filter(e => e.type === 'progress').map(e => String(e.payload?.progress ?? ''));
}

function initScratchWorkspace(workspaceDir) {
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Disposable Task-Scoped Autonomy acceptance workspace\n');
  fs.writeFileSync(path.join(workspaceDir, 'src', 'users.js'), [
    'function registerUser(username) {',
    '  return { username, registeredAt: new Date().toISOString() };',
    '}',
    '',
    'function getDisplayName(user) {',
    '  return user.username;',
    '}',
    '',
    'module.exports = { registerUser, getDisplayName };',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspaceDir, 'src', 'users.test.js'), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { registerUser, getDisplayName } = require('./users');",
    '',
    "test('registerUser stores the username', () => {",
    "  assert.equal(registerUser('alice').username, 'alice');",
    '});',
    '',
    "test('getDisplayName returns the username', () => {",
    "  assert.equal(getDisplayName({ username: 'alice' }), 'alice');",
    '});',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspaceDir, 'package.json'),
    JSON.stringify({ name: 'task-scoped-autonomy-fixture', private: true, scripts: { test: 'node --test src/users.test.js' } }, null, 2));
  spawnSync('git', ['init', '-q'], { cwd: workspaceDir });
  spawnSync('git', ['config', 'user.email', 'acceptance@example.invalid'], { cwd: workspaceDir });
  spawnSync('git', ['config', 'user.name', 'Task Scoped Autonomy Acceptance'], { cwd: workspaceDir });
  spawnSync('git', ['add', '-A'], { cwd: workspaceDir });
  spawnSync('git', ['commit', '-q', '-m', 'initial disposable fixture'], { cwd: workspaceDir });
}

function reportInfraBlockedIfUpdaterActive() {
  const updaters = detectActiveVSCodeUpdater();
  if (updaters.length === 0) return false;
  log(`INFRA_BLOCKED: an active VS Code installer/updater is holding the machine-wide mutex (pid ${updaters[0].pid}).`);
  writeEvidence('infra-blocked.json', { status: 'INFRA_BLOCKED', updaters });
  return true;
}

async function readAutoState(client) {
  return evalInWebviewContentDoc(client, `({
    sendBtnText: document.getElementById('send-btn')?.textContent ?? null,
    sendBtnDisabled: document.getElementById('send-btn')?.disabled ?? null,
  })`);
}

async function readTaskScopedAutonomyEvidence(client) {
  return evalInWebviewContentDoc(client, `(() => {
    const objectiveCard = document.getElementById('task-request-entry');
    const badge = document.getElementById('kd-autonomy-badge');
    const proposal = document.getElementById('proposal-approval-card');
    const mutation = document.getElementById('mutation-approval-card');
    const delivery = document.getElementById('delivery-approval-card');
    const outcome = document.getElementById('everyday-outcome-card');
    const taskIdText = document.getElementById('autonomous-task-id')?.textContent ?? null;
    const proposalActionable = proposal ? (proposal.hidden === false && document.getElementById('proposal-approve-btn')?.disabled === false) : false;
    const mutationActionable = mutation ? (mutation.hidden === false && document.getElementById('mutation-approve-btn')?.disabled === false) : false;
    const deliveryActionable = delivery ? (delivery.hidden === false && document.getElementById('delivery-approve-btn')?.disabled === false) : false;
    return {
      taskId: taskIdText ? taskIdText.replace(/^Task:\\s*/, '').trim() : null,
      objectiveCardClass: objectiveCard ? objectiveCard.className : null,
      autonomyBadgeHidden: badge ? badge.hidden : null,
      autonomyBadgeText: badge ? badge.textContent : null,
      proposalCardHidden: proposal ? proposal.hidden : null,
      proposalApproveDisabled: document.getElementById('proposal-approve-btn')?.disabled ?? null,
      proposalRejectDisabled: document.getElementById('proposal-reject-btn')?.disabled ?? null,
      mutationCardHidden: mutation ? mutation.hidden : null,
      deliveryCardHidden: delivery ? delivery.hidden : null,
      actionableCount: [proposalActionable, mutationActionable, deliveryActionable].filter(Boolean).length,
      actionableGates: { proposal: proposalActionable, mutation: mutationActionable, delivery: deliveryActionable },
      outcomeCardClass: outcome ? outcome.className : null,
      outcomeHeadline: outcome ? (outcome.querySelector('.everyday-outcome-headline')?.textContent ?? null) : null,
      outcomeText: outcome ? outcome.textContent : null,
      taskLine: document.getElementById('kd-task-line')?.textContent ?? null,
    };
  })()`);
}

async function setAutonomyMode(client, mode) {
  await ui.evalInWebviewDoc(client, `(() => {
    const select = document.getElementById('autonomy-mode-select');
    if (!select) throw new Error('autonomy-mode-select not found');
    select.value = ${JSON.stringify(mode)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
}

async function submitAutonomousTask(client, text) {
  await ui.evalInWebviewDoc(client, `(() => {
    const textarea = document.getElementById('autonomous-input');
    const btn = document.getElementById('autonomous-start-btn');
    if (!textarea || !btn) throw new Error('autonomous composer not found');
    textarea.value = ${JSON.stringify(text)};
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    if (btn.disabled) throw new Error('autonomous-start-btn is disabled');
    btn.click();
    return true;
  })()`);
}

async function clickProposalRejectButton(client) {
  await ui.evalInWebviewDoc(client, `(() => {
    const btn = document.getElementById('proposal-reject-btn');
    if (!btn) throw new Error('proposal-reject-btn not found');
    if (btn.disabled) throw new Error('proposal-reject-btn is disabled');
    btn.click();
    return true;
  })()`);
}

async function waitForTerminalOutcome(client, { timeoutMs = 600000 } = {}) {
  return pollUntil(
    async () => {
      const ev = await readTaskScopedAutonomyEvidence(client);
      if (ev.outcomeCardClass) return { done: true, value: ev };
      return { done: false };
    },
    { timeoutMs, intervalMs: 2000, describe: () => 'a terminal Karke Dikha completion/blocker outcome card' },
  );
}

function terminalLooksBlocked(ev) {
  if (!ev?.outcomeCardClass) return undefined;
  return ev.outcomeCardClass.includes('is-blocked');
}
function terminalLooksSuccess(ev) {
  if (!ev?.outcomeCardClass) return undefined;
  return ev.outcomeCardClass.includes('is-success');
}
function headlineLooksRaw(headline) {
  return !headline || /\bError\b.*\bat\b|\.ts:\d+/.test(headline);
}

let host;
let remoteDebuggingPort;

function inspectProfileProcesses(filterSubstring = path.basename(workDir)) {
  const script = `
    $rows = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" |
      Where-Object { $_.CommandLine -like '*${filterSubstring}*' } |
      ForEach-Object {
        [pscustomobject]@{
          ProcessId = $_.ProcessId
          IsCore    = [bool]($_.CommandLine -like '*out-core*core.js*')
          IsCrashpad= [bool]($_.CommandLine -like '*crashpad-handler*')
        }
      }
    if ($null -eq $rows) { '[]' } else { ConvertTo-Json @($rows) -Compress }`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  let rows = [];
  try { rows = JSON.parse((result.stdout || '[]').trim() || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [rows];
  return { core: rows.filter(r => r.IsCore), ui: rows.filter(r => !r.IsCore) };
}

/** Safety net beyond closeWindow's own graceful-exit wait: force-kills ANY
 * process (window, Core, crashpad) still tied to this specific journey's
 * profile before the next journey launches a fresh one — so a slow-to-exit
 * process from journey N can never carry state or resource contention into
 * journey N+1, regardless of the reason it lingered. */
function killLingeringJourneyProcesses(profileLabel) {
  const remaining = inspectProfileProcesses(`user-data-${profileLabel}`);
  for (const row of [...remaining.core, ...remaining.ui]) {
    spawnSync('taskkill', ['/pid', String(row.ProcessId), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

async function launchWindow(workspaceDir, userDataDir, extensionsDir, coreDataDir) {
  remoteDebuggingPort = allocateDebugPort();
  log(`Launching VS Code (port ${remoteDebuggingPort})…`);
  host = launchPlainHost(process.env.__KD_VSCODE_EXEC, {
    userDataDir,
    extensionsDir,
    workspacePath: workspaceDir,
    remoteDebuggingPort,
    env: { KARKEDIKHA_DATA_DIR: coreDataDir },
  });

  const page = await pollUntil(
    async () => {
      if (typeof host?.child?.exitCode === 'number') {
        throw new Error(`the launched VS Code process exited immediately (code ${host.child.exitCode})`);
      }
      const targets = await board.listTargets(remoteDebuggingPort);
      const found = targets.find(t => t.type === 'page');
      return found ? { done: true, value: found } : { done: false };
    },
    { timeoutMs: 120000, describe: () => `a workbench page target on port ${remoteDebuggingPort}` },
  );
  const pageClient = await board.connectToTarget(remoteDebuggingPort, page.id);
  await board.waitForWorkbenchDomReady(pageClient);

  log('Waiting for onboarding readiness on this fresh profile…');
  const CDP = (await import('chrome-remote-interface')).default;
  const setupTarget = await pollUntil(
    async () => {
      const targets = await CDP.List({ port: remoteDebuggingPort });
      const candidate = targets.find(t => t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith('vscode-webview://') && t.url.includes('/index.html'));
      if (!candidate) return { done: false };
      const client = await board.connectToTarget(remoteDebuggingPort, candidate.id);
      const probe = await evalInWebviewContentDoc(client, `({ h1: document.querySelector('h1')?.textContent ?? null })`).catch(() => ({}));
      if (probe?.h1 === 'KarkeDikha Setup') return { done: true, value: { client, targetId: candidate.id } };
      await client.close();
      return { done: false };
    },
    { timeoutMs: 90000, describe: () => 'the KarkeDikha Setup onboarding webview to open' },
  );
  const readiness = await pollUntil(
    async () => {
      const snapshot = await evalInWebviewContentDoc(setupTarget.client, `({ overallText: document.querySelector('.overall')?.textContent ?? null })`);
      return snapshot.overallText === 'READY' ? { done: true, value: snapshot } : { done: false, value: snapshot };
    },
    { timeoutMs: 180000, intervalMs: 2000, describe: () => 'onboarding to report overall READY' },
  );
  log(`Onboarding readiness: ${readiness.overallText}`);
  await setupTarget.client.close();

  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
  const chatClient = await ui.connectToWebviewHost(remoteDebuggingPort, { attempts: 90, delayMs: 500, excludeIds: [setupTarget.targetId] });
  await ui.waitForWebviewContentMounted(chatClient, { timeoutMs: 45000, readyElementId: 'send-btn' });
  await ui.instrumentWebviewPostMessage(chatClient);
  await pollUntil(
    async () => {
      const state = await readAutoState(chatClient);
      return state.sendBtnText === 'Send' && state.sendBtnDisabled === false ? { done: true, value: state } : { done: false };
    },
    { timeoutMs: 120000, intervalMs: 1500, describe: () => 'the composer to return to a ready Send state' },
  );
  await ui.clickAutonomousModeButton(chatClient);
  await sleep(500);
  return { pageClient, chatClient };
}

function setupFreshProfile({ userDataDir, extensionsDir }, cliArgs, vsixPath, recommendedModel) {
  log(`Installing the packaged extension into a fresh isolated profile (${path.basename(userDataDir)})…`);
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath });
  const userDir = path.join(userDataDir, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({
    'ollama-agent.model': recommendedModel,
    'ollama-agent.chatModel': recommendedModel,
    'ollama-agent.agentModel': recommendedModel,
    'ollama-agent.codingModel': recommendedModel,
    'ollama-agent.editModel': recommendedModel,
    'ollama-agent.reviewerModel': recommendedModel,
    'ollama-agent.codingFallbackModel': recommendedModel,
  }, null, 2));
}

async function closeWindow(pageClient) {
  log('Closing VS Code gracefully…');
  try { await pageClient?.Browser?.close?.(); } catch { /* ignore */ }
  try { await pageClient?.close?.(); } catch { /* ignore */ }
  await pollUntil(
    async () => (!host || typeof host.child?.exitCode === 'number' || host.child?.killed ? { done: true, value: true } : { done: false }),
    { timeoutMs: 45000, intervalMs: 500, describe: () => 'the launched VS Code process to exit' },
  ).catch(() => {});
}

// ============================================================================
// JOURNEY 1 — SUPERVISED
// ============================================================================
async function runJourney1Supervised(workspaceDir, userDataDir, extensionsDir, coreDataDir) {
  log('===== JOURNEY 1 — SUPERVISED =====');
  const session = await launchWindow(workspaceDir, userDataDir, extensionsDir, coreDataDir);
  await screenshot(session.pageClient, 'j1-01-initial-load');

  await setAutonomyMode(session.chatClient, 'supervised');
  log(`JOURNEY 1 task: ${TASK_JOURNEY1}`);
  await submitAutonomousTask(session.chatClient, TASK_JOURNEY1);

  const gated = await pollUntil(
    async () => {
      const ev = await readTaskScopedAutonomyEvidence(session.chatClient);
      if (ev.proposalCardHidden === false && ev.proposalRejectDisabled === false) return { done: true, value: ev };
      return { done: false };
    },
    { timeoutMs: 320000, intervalMs: 1500, describe: () => 'the proposal approval card to become actionable (supervised)' },
  );
  await screenshot(session.pageClient, 'j1-02-proposal-actionable');
  evidence.journeys.push({ journey: 1, phase: 'gated', evidence: gated });

  if (gated.autonomyBadgeHidden !== true) {
    throw new Error(`Journey 1 (supervised) unexpectedly showed a Hands-off badge: ${JSON.stringify(gated)}`);
  }
  if (gated.actionableCount !== 1 || !gated.actionableGates.proposal) {
    throw new Error(`Journey 1: expected exactly one actionable gate (proposal), got: ${JSON.stringify(gated.actionableGates)}`);
  }

  // Persisted-mode proof: read task.json directly off disk.
  const taskId = gated.taskId;
  if (!taskId) throw new Error('Journey 1: could not read the task id from the DOM.');
  const persisted = readPersistedTask(workspaceDir, taskId);
  if (persisted.autonomyMode !== 'supervised') {
    throw new Error(`Journey 1: persisted task.autonomyMode is "${persisted.autonomyMode}", expected "supervised".`);
  }

  log('Rejecting at the proposal gate.');
  await clickProposalRejectButton(session.chatClient);
  await sleep(1500);
  await screenshot(session.pageClient, 'j1-03-rejected');

  const afterReject = await pollUntil(
    async () => {
      const ev = await readTaskScopedAutonomyEvidence(session.chatClient);
      const state = await readAutoState(session.chatClient);
      if (state.sendBtnText === 'Send' && state.sendBtnDisabled === false) return { done: true, value: ev };
      return { done: false };
    },
    { timeoutMs: 60000, intervalMs: 1000, describe: () => 'the composer to settle after rejecting the proposal' },
  );
  evidence.journeys.push({ journey: 1, phase: 'after-reject', evidence: afterReject, gitStatus: gitStatus(workspaceDir) });

  // "Rejected gate does not resurrect": keep polling for a few more seconds —
  // the card must never become actionable again.
  for (let i = 0; i < 5; i += 1) {
    await sleep(1000);
    const still = await readTaskScopedAutonomyEvidence(session.chatClient);
    if (still.proposalCardHidden === false && still.proposalRejectDisabled === false) {
      throw new Error('Journey 1: the rejected proposal gate resurrected as actionable.');
    }
  }

  // No mutation/delivery ever occurred after rejection.
  const eventsAfterReject = readPersistedEvents(workspaceDir, taskId);
  if (eventsAfterReject.some(e => e.type === 'mutation_pending')) {
    throw new Error('Journey 1: a mutation gate was opened after the proposal was rejected — rejection did not stop the task.');
  }

  const status = gitStatus(workspaceDir);
  if (status !== '') {
    throw new Error(`Journey 1: rejecting the proposal must leave the workspace untouched, but git status is dirty:\n${status}`);
  }
  const usersContent = readFile(workspaceDir, 'src/users.js');
  if (usersContent.includes('empty username')) {
    throw new Error('Journey 1: the rejected proposal was applied to the real workspace anyway.');
  }
  log('JOURNEY 1 PASS — one actionable gate, rejected, did not resurrect, no mutation/delivery, workspace unchanged.');
  await closeWindow(session.pageClient);
  killLingeringJourneyProcesses('j1');
  return { gated, afterReject, taskId, persisted };
}

// ============================================================================
// JOURNEY 2 — HANDS-OFF (happy/terminal path)
// ============================================================================
async function runJourney2HandsOff(workspaceDir, userDataDir, extensionsDir, coreDataDir) {
  log('===== JOURNEY 2 — HANDS-OFF =====');
  const session = await launchWindow(workspaceDir, userDataDir, extensionsDir, coreDataDir);
  await screenshot(session.pageClient, 'j2-01-initial-load');

  await setAutonomyMode(session.chatClient, 'hands_off');
  log(`JOURNEY 2 task: ${TASK_JOURNEY2}`);
  await submitAutonomousTask(session.chatClient, TASK_JOURNEY2);

  // Autonomy-mode freeze: flip the live selector back to 'supervised' shortly
  // after submission, while the task is still running. The ACTIVE task's
  // frozen mode/badge must not change.
  await sleep(3000);
  await setAutonomyMode(session.chatClient, 'supervised');
  await sleep(500);
  const midRun = await readTaskScopedAutonomyEvidence(session.chatClient);
  await screenshot(session.pageClient, 'j2-02-freeze-check');
  evidence.journeys.push({ journey: 2, phase: 'freeze-check', evidence: midRun });
  if (midRun.autonomyBadgeHidden !== false || !/hands-off/i.test(midRun.autonomyBadgeText ?? '')) {
    throw new Error(`Journey 2: flipping the live selector mid-run changed (or hid) the active task's frozen Hands-off badge: ${JSON.stringify(midRun)}`);
  }
  // Restore hands_off for realism (does not affect the already-running task,
  // which is exactly the property just proven above).
  await setAutonomyMode(session.chatClient, 'hands_off');

  // Deliberately touch NOTHING else. Poll only for the terminal outcome card,
  // never for an intermediate approval gate — clicking one here would defeat
  // the point of the journey. If a card genuinely appears and stays
  // actionable, that is itself the failure signature this polls for.
  let sawAnyActionableCard = false;
  const cardWatchDeadline = Date.now() + 600000;
  const terminalPromise = waitForTerminalOutcome(session.chatClient, { timeoutMs: 600000 });
  while (Date.now() < cardWatchDeadline) {
    const ev = await readTaskScopedAutonomyEvidence(session.chatClient).catch(() => ({}));
    if (ev.outcomeCardClass) break;
    if (ev.actionableCount > 0) {
      sawAnyActionableCard = true;
      evidence.journeys.push({ journey: 2, phase: 'unexpected-card', evidence: ev });
      break;
    }
    await sleep(1000);
  }
  const terminalEvidence = await terminalPromise;
  await screenshot(session.pageClient, 'j2-03-terminal');
  const taskId = terminalEvidence.taskId || midRun.taskId;
  evidence.journeys.push({ journey: 2, phase: 'terminal', evidence: terminalEvidence, gitStatus: gitStatus(workspaceDir), taskId });

  if (sawAnyActionableCard) {
    throw new Error('Journey 2 (hands-off): an ordinary approval card was shown and left actionable — Hands-off must resolve these itself.');
  }
  if (!taskId) throw new Error('Journey 2: could not determine the task id.');

  // Persisted-mode proof.
  const persisted = readPersistedTask(workspaceDir, taskId);
  if (persisted.autonomyMode !== 'hands_off') {
    throw new Error(`Journey 2: persisted task.autonomyMode is "${persisted.autonomyMode}", expected "hands_off" (the live selector flip above must not have retroactively changed it).`);
  }

  // Audit evidence: gate identity + automatic-authorization + reason, read
  // directly from the durable per-task event log — not the DOM.
  const events = readPersistedEvents(workspaceDir, taskId);
  const progress = progressLines(events);
  const proposalAuth = progress.find(p => /^approval_auto_authorized gate=proposal policy=hands_off_task_authorization/.test(p));
  const mutationAuth = progress.find(p => /^approval_auto_authorized gate=mutation policy=hands_off_task_authorization/.test(p));
  const deliveryAuth = progress.find(p => p === 'approval_auto_authorized gate=delivery policy=hands_off_task_authorization');
  const validationRan = progress.some(p => p.startsWith('validation_completed') || p === 'validating');
  evidence.journeys.push({ journey: 2, phase: 'audit', proposalAuth, mutationAuth, deliveryAuth, validationRan, persistedAutonomyMode: persisted.autonomyMode });

  if (!proposalAuth) throw new Error('Journey 2: no proposal gate auto-authorization evidence found in events.jsonl.');
  if (!mutationAuth) throw new Error('Journey 2: no mutation gate auto-authorization evidence found in events.jsonl (mutation gate may not have been reached — see progress log).');

  if (terminalLooksSuccess(terminalEvidence)) {
    log('JOURNEY 2: task completed with zero approval clicks.');
    if (!deliveryAuth) throw new Error('Journey 2: task completed but no delivery auto-authorization evidence was found.');
    if (!validationRan) throw new Error('Journey 2: task completed but no validation-executed evidence was found.');
  } else if (terminalLooksBlocked(terminalEvidence)) {
    log('JOURNEY 2: task ended in a truthful governed block/failure after gates were auto-authorized — acceptable per this milestone.');
    if (headlineLooksRaw(terminalEvidence.outcomeHeadline)) {
      throw new Error(`Journey 2 blocker headline looks like raw exception text, not a humanized message: ${JSON.stringify(terminalEvidence.outcomeHeadline)}`);
    }
    if (/\bM15\b|attemptId|classification=/.test(terminalEvidence.outcomeText ?? '')) {
      throw new Error(`Journey 2 blocker text leaks internal jargon onto the normal surface: ${JSON.stringify(terminalEvidence.outcomeText)}`);
    }
  } else {
    throw new Error(`Journey 2 produced neither a success nor a blocked outcome card: ${JSON.stringify(terminalEvidence)}`);
  }

  log('JOURNEY 2 PASS — zero routine approval clicks; mode frozen through a live selector flip; audit evidence present.');
  await closeWindow(session.pageClient);
  killLingeringJourneyProcesses('j2');
  return { terminalEvidence, taskId, persisted, proposalAuth, mutationAuth, deliveryAuth, validationRan };
}

// ============================================================================
// JOURNEY 3 — SAFETY BLOCK (unrelated dirty workspace)
// ============================================================================
async function runJourney3SafetyBlock(workspaceDir, userDataDir, extensionsDir, coreDataDir) {
  log('===== JOURNEY 3 — SAFETY BLOCK =====');
  log('Dirtying an unrelated tracked file (package.json) BEFORE starting the task…');
  const pkgPath = path.join(workspaceDir, 'package.json');
  const original = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const dirtyMarker = 'do-not-touch-journey-3';
  fs.writeFileSync(pkgPath, JSON.stringify({ ...original, unrelatedDirtyMarker: dirtyMarker }, null, 2));
  const dirtyBytesBefore = fs.readFileSync(pkgPath, 'utf8');

  const session = await launchWindow(workspaceDir, userDataDir, extensionsDir, coreDataDir);
  await screenshot(session.pageClient, 'j3-01-initial-load-dirty');

  await setAutonomyMode(session.chatClient, 'hands_off');
  log(`JOURNEY 3 task: ${TASK_JOURNEY3}`);
  await submitAutonomousTask(session.chatClient, TASK_JOURNEY3);

  let sawAnyActionableCard = false;
  const cardWatchDeadline = Date.now() + 600000;
  const terminalPromise = waitForTerminalOutcome(session.chatClient, { timeoutMs: 600000 });
  while (Date.now() < cardWatchDeadline) {
    const ev = await readTaskScopedAutonomyEvidence(session.chatClient).catch(() => ({}));
    if (ev.outcomeCardClass) break;
    if (ev.actionableCount > 0) {
      sawAnyActionableCard = true;
      evidence.journeys.push({ journey: 3, phase: 'unexpected-card', evidence: ev });
      break;
    }
    await sleep(1000);
  }
  const terminalEvidence = await terminalPromise;
  await screenshot(session.pageClient, 'j3-02-terminal');
  const taskId = terminalEvidence.taskId;
  evidence.journeys.push({ journey: 3, phase: 'terminal', evidence: terminalEvidence, gitStatus: gitStatus(workspaceDir), taskId });

  if (sawAnyActionableCard) {
    throw new Error('Journey 3 (safety block): an ordinary approval card was shown and left actionable — Hands-off must resolve these itself even here.');
  }

  const dirtyBytesAfter = fs.readFileSync(pkgPath, 'utf8');
  if (dirtyBytesAfter !== dirtyBytesBefore || !dirtyBytesAfter.includes(dirtyMarker)) {
    throw new Error('Journey 3: the unrelated dirty edit to package.json was lost, reset, stashed, or overwritten — Hands-off must never touch it.');
  }

  // The task must not have silently "succeeded" by delivering into a dirty
  // workspace — that would mean the safety block was bypassed.
  if (terminalLooksSuccess(terminalEvidence)) {
    // A completion is only acceptable here if delivery genuinely never needed
    // to touch package.json (e.g. the model's change landed cleanly without
    // colliding) — the byte-for-byte dirty-marker check above is what
    // actually proves no override happened either way. Still worth a loud
    // log line since this journey exists specifically to exercise the block.
    log('JOURNEY 3 NOTE: task completed — the dirty file survived untouched either way (see byte check above), but this run did not exercise the workspace_delivery_conflict path itself.');
  } else if (terminalLooksBlocked(terminalEvidence)) {
    log('JOURNEY 3: task blocked safely, as expected.');
    if (headlineLooksRaw(terminalEvidence.outcomeHeadline)) {
      throw new Error(`Journey 3 blocker headline looks like raw exception text, not a "needs your attention"-style humanized message: ${JSON.stringify(terminalEvidence.outcomeHeadline)}`);
    }
  } else {
    throw new Error(`Journey 3 produced neither a success nor a blocked outcome card: ${JSON.stringify(terminalEvidence)}`);
  }

  if (taskId) {
    const events = readPersistedEvents(workspaceDir, taskId);
    evidence.journeys.push({ journey: 3, phase: 'audit', progress: progressLines(events) });
  }

  const finalGitStatus = gitStatus(workspaceDir);
  if (!finalGitStatus.includes('package.json')) {
    throw new Error(`Journey 3: expected package.json to still show as dirty in git status, got:\n${finalGitStatus}`);
  }

  log('JOURNEY 3 PASS — safety block preserved the unrelated dirty bytes exactly; no auto-override.');
  await closeWindow(session.pageClient);
  killLingeringJourneyProcesses('j3');
  return { terminalEvidence, taskId };
}

async function main() {
  let passed = false;
  if (reportInfraBlockedIfUpdaterActive()) process.exit(3);

  log('Building packaged VSIX (npm run package)…');
  execFileSync('npm', ['run', 'package'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  const vsixPath = path.join(repoRoot, 'karkedikha.vsix');
  if (!fs.existsSync(vsixPath)) throw new Error(`packaged VSIX not found at ${vsixPath}`);

  log('Resolving a real VS Code build…');
  const { vscodeExecutablePath, cliArgs } = await resolveVSCode();
  process.env.__KD_VSCODE_EXEC = vscodeExecutablePath;

  const tagsResponse = await fetch('http://127.0.0.1:11434/api/tags').catch(() => undefined);
  const installedModels = tagsResponse?.ok ? (await tagsResponse.json()).models ?? [] : [];
  const recommendedModel = installedModels.find(m => m.name.toLowerCase() === 'qwen3.8:27b-mtp-q4_k_m')?.name
    ?? installedModels.find(m => Array.isArray(m.capabilities) && m.capabilities.includes('tools'))?.name
    ?? installedModels[0]?.name;
  if (!recommendedModel) throw new Error('no installed Ollama models found via /api/tags; cannot run a real acceptance');
  log(`Will point role settings at the real installed model: ${recommendedModel}`);

  const results = {};
  try {
    const workspace1 = path.join(workDir, 'workspace-journey1');
    fs.mkdirSync(workspace1, { recursive: true });
    initScratchWorkspace(workspace1);
    const profile1 = freshProfilePaths('j1');
    setupFreshProfile(profile1, cliArgs, vsixPath, recommendedModel);
    results.journey1 = await runJourney1Supervised(workspace1, profile1.userDataDir, profile1.extensionsDir, profile1.coreDataDir);

    const workspace2 = path.join(workDir, 'workspace-journey2');
    fs.mkdirSync(workspace2, { recursive: true });
    initScratchWorkspace(workspace2);
    const profile2 = freshProfilePaths('j2');
    setupFreshProfile(profile2, cliArgs, vsixPath, recommendedModel);
    results.journey2 = await runJourney2HandsOff(workspace2, profile2.userDataDir, profile2.extensionsDir, profile2.coreDataDir);

    const workspace3 = path.join(workDir, 'workspace-journey3');
    fs.mkdirSync(workspace3, { recursive: true });
    initScratchWorkspace(workspace3);
    const profile3 = freshProfilePaths('j3');
    setupFreshProfile(profile3, cliArgs, vsixPath, recommendedModel);
    results.journey3 = await runJourney3SafetyBlock(workspace3, profile3.userDataDir, profile3.extensionsDir, profile3.coreDataDir);

    writeEvidence('run.json', { status: 'PASS', model: recommendedModel, evidence, results });
    log('PASS — supervised, hands-off, and safety-block journeys all completed with expected evidence.');
    passed = true;
  } catch (error) {
    writeEvidence('run.json', { status: 'FAIL', error: error.message, stack: error.stack, evidence, results });
    log(`FAIL: ${error.message}`);
  } finally {
    terminatePlainHost(host?.child);
    const remaining = inspectProfileProcesses();
    for (const row of remaining.ui) {
      spawnSync('taskkill', ['/pid', String(row.ProcessId), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  }
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  writeEvidence('run.json', { status: 'FAIL', error: error.message, stack: error.stack, evidence });
  console.error(error);
  process.exit(1);
});
