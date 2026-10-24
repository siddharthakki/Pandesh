#!/usr/bin/env node
// npm run test:e2e:progress-completion-ux
//
// Installed, local-only acceptance for the "Progress & Completion UX V1"
// milestone: ONE continuous conversation, ONE real packaged VS Code window,
// against this machine's real local Ollama. No cloud calls are made. This
// deliberately reuses the exact launch/drive primitives already proven by
// run-durable-continuity-acceptance.mjs, minus the restart machinery (this
// milestone's own scope is presentation truthfulness within a live session,
// not durability across restarts — that is covered separately).
//
// TURN 1  "Why does registerUser accept an empty username?"        (read-only)
// TURN 2  "Fix it."                                                (collaborative)
// TURN 3  "Now update the tests if needed, run the relevant
//          validation, and finish it."                             (autonomous)
//
// A legitimate deterministic host-review rejection on Turn 3 is an ACCEPTABLE
// PASS for this milestone: it tests UX truthfulness, not model success.
//
// Opt-in only: requires OLLAMA_AGENT_LIVE_PROGRESS_COMPLETION_UX=1 or --enabled.

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
const enabled = process.env.OLLAMA_AGENT_LIVE_PROGRESS_COMPLETION_UX === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: Progress & Completion UX acceptance requires OLLAMA_AGENT_LIVE_PROGRESS_COMPLETION_UX=1 or --enabled.');
  console.log('It launches a real packaged VS Code window against this machine\'s real local Ollama. No cloud calls are made.');
  process.exit(0);
}

const TURN_1 = 'Why does registerUser accept an empty username?';
const TURN_2 = 'Fix it.';
const TURN_3 = 'Now update the tests if needed, run the relevant validation, and finish it.';

const startedAt = Date.now();
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-progress-completion-ux-acceptance-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'progress-completion-ux-v1');
const userDataDir = path.join(workDir, 'user-data');
const extensionsDir = path.join(workDir, 'extensions');
const workspaceDir = path.join(workDir, 'workspace');
const coreDataDir = path.join(workDir, 'core-data');

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[progress-completion-ux-acceptance +${elapsed}s] ${message}`);
}

const evidence = { turns: [], screenshots: [] };
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
    const file = path.join(evidenceDir, `${label}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    evidence.screenshots.push(file);
    log(`screenshot: ${label}.png`);
  } catch (error) {
    log(`screenshot FAILED for ${label}: ${error.message}`);
  }
}

function readFile(rel) { return fs.readFileSync(path.join(workspaceDir, rel), 'utf8'); }
function gitStatus() { return spawnSync('git', ['status', '--porcelain'], { cwd: workspaceDir, encoding: 'utf8' }).stdout.trim(); }

function initScratchWorkspace() {
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Disposable Progress & Completion UX acceptance workspace\n');
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
    JSON.stringify({ name: 'progress-completion-ux-fixture', private: true, scripts: { test: 'node --test src/users.test.js' } }, null, 2));
  spawnSync('git', ['init', '-q'], { cwd: workspaceDir });
  spawnSync('git', ['config', 'user.email', 'acceptance@example.invalid'], { cwd: workspaceDir });
  spawnSync('git', ['config', 'user.name', 'Progress Completion UX Acceptance'], { cwd: workspaceDir });
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
    modeSelectValue: document.getElementById('mode-select')?.value ?? null,
    sendBtnText: document.getElementById('send-btn')?.textContent ?? null,
    sendBtnDisabled: document.getElementById('send-btn')?.disabled ?? null,
    thinkingText: document.getElementById('thinking-indicator')?.textContent ?? null,
    everydayPhaseLabel: document.getElementById('everyday-phase-label')?.textContent ?? null,
    everydayPhaseHidden: document.getElementById('everyday-phase')?.hidden ?? null,
  })`);
}

async function readTranscript(client) {
  return evalInWebviewContentDoc(client, `Array.from(document.querySelectorAll('.bubble')).map(node => ({
    role: node.classList.contains('user') ? 'user' : node.classList.contains('error') ? 'error' : 'assistant',
    text: (node.textContent || '').slice(0, 4000),
  }))`);
}

async function readProgressUxEvidence(client) {
  return evalInWebviewContentDoc(client, `(() => {
    const objectiveCard = document.getElementById('task-request-entry');
    const proposal = document.getElementById('proposal-approval-card');
    const mutation = document.getElementById('mutation-approval-card');
    const outcome = document.getElementById('everyday-outcome-card');
    return {
      objectiveCardClass: objectiveCard ? objectiveCard.className : null,
      objectiveCardIsUserBubble: objectiveCard ? objectiveCard.classList.contains('user') : null,
      objectiveText: objectiveCard ? objectiveCard.textContent : null,
      literalUserBubbleCount: document.querySelectorAll('.bubble.user').length,
      literalUserBubbleTexts: Array.from(document.querySelectorAll('.bubble.user')).map(n => (n.textContent || '').trim()),
      proposalDhadkanState: proposal ? proposal.dataset.dhadkanState : null,
      proposalHidden: proposal ? proposal.hidden : null,
      mutationDhadkanState: mutation ? mutation.dataset.dhadkanState : null,
      outcomeCardClass: outcome ? outcome.className : null,
      outcomeHeadline: outcome ? (outcome.querySelector('.everyday-outcome-headline')?.textContent ?? null) : null,
      outcomeText: outcome ? outcome.textContent : null,
      taskLine: document.getElementById('kd-task-line')?.textContent ?? null,
    };
  })()`);
}

async function sendChatMessage(client, text) {
  await ui.evalInWebviewDoc(client, `(() => {
    const input = document.getElementById('user-input');
    const btn = document.getElementById('send-btn');
    if (!input || !btn) throw new Error('chat composer not found');
    if (btn.disabled) throw new Error('send-btn is disabled — composer was not ready for this turn');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    return true;
  })()`);
}

async function waitForComposerReady(client, { timeoutMs = 320000 } = {}) {
  return pollUntil(
    async () => {
      const state = await readAutoState(client);
      return state.sendBtnText === 'Send' && state.sendBtnDisabled === false ? { done: true, value: state } : { done: false };
    },
    { timeoutMs, intervalMs: 1500, describe: () => 'the composer to return to a ready Send state' },
  );
}

async function readLatestUnresolvedCapabilityCard(client) {
  return evalInWebviewContentDoc(client, `(() => {
    const el = Array.from(document.querySelectorAll('.capability-approval-card:not(.resolved)')).pop();
    if (!el) return null;
    return {
      id: el.id,
      titleText: el.querySelector('strong')?.textContent ?? null,
      diffPath: el.querySelector('.proposal-diff')?.getAttribute('data-path') ?? null,
      approveDisabled: el.querySelector('button[data-approval-response="approved"]')?.disabled ?? null,
    };
  })()`);
}

async function clickLatestCapabilityCardButton(client, response) {
  await ui.evalInWebviewDoc(client, `(() => {
    const cards = Array.from(document.querySelectorAll('.capability-approval-card:not(.resolved)'));
    const card = cards[cards.length - 1];
    if (!card) throw new Error('no unresolved .capability-approval-card found');
    const btn = card.querySelector('button[data-approval-response="${response}"]');
    if (!btn) throw new Error('capability approval button not found');
    if (btn.disabled) throw new Error('capability approval button is disabled');
    btn.click();
    return true;
  })()`);
}

async function approveThroughAllGates(client, { timeoutMs = 300000, onFirstActionable } = {}) {
  const deadline = Date.now() + timeoutMs;
  const clicked = [];
  let announced = false;
  while (Date.now() < deadline) {
    const capabilityCard = await readLatestUnresolvedCapabilityCard(client);
    if (capabilityCard && capabilityCard.approveDisabled === false) {
      if (!announced && onFirstActionable) { await onFirstActionable(); announced = true; }
      await clickLatestCapabilityCardButton(client, 'approved');
      clicked.push(`capability:${capabilityCard.diffPath ?? capabilityCard.titleText ?? capabilityCard.id}`);
      await sleep(2500);
      continue;
    }
    const dom = await ui.readApprovalCycleDom(client);
    if (dom.proposalCardHidden === false && dom.proposalApproveDisabled === false) {
      if (!announced && onFirstActionable) { await onFirstActionable(); announced = true; }
      await ui.clickProposalApproveButton(client); clicked.push('proposal'); await sleep(2000); continue;
    }
    if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) {
      if (!announced && onFirstActionable) { await onFirstActionable(); announced = true; }
      await ui.clickMutationApproveButton(client); clicked.push('mutation'); await sleep(2000); continue;
    }
    if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) {
      if (!announced && onFirstActionable) { await onFirstActionable(); announced = true; }
      await ui.clickDeliveryApproveButton(client); clicked.push('delivery'); await sleep(2000); continue;
    }
    const state = await readAutoState(client);
    if (state.sendBtnText === 'Send' && state.sendBtnDisabled === false) {
      return { clicked, state };
    }
    await sleep(1500);
  }
  throw new Error(`timed out waiting through approval gates; clicked so far=${JSON.stringify(clicked)}`);
}

let host;
let remoteDebuggingPort;

function inspectProfileProcesses() {
  const script = `
    $rows = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" |
      Where-Object { $_.CommandLine -like '*${path.basename(workDir)}*' } |
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

async function launchWindow() {
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
  await waitForComposerReady(chatClient, { timeoutMs: 120000 });
  return { pageClient, chatClient };
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

async function sendTurnAndWait(client, text, { timeoutMs = 320000, expectGate = false } = {}) {
  const before = await ui.countBubbles(client);
  await sendChatMessage(client, text);
  const outcome = await pollUntil(
    async () => {
      const errorText = await evalInWebviewContentDoc(client, `document.querySelector('.bubble.error')?.textContent ?? null`);
      if (errorText) return { done: true, value: { kind: 'error', errorText } };
      const card = await readLatestUnresolvedCapabilityCard(client);
      if (card) return { done: true, value: { kind: 'capability_gate', card } };
      const dom = await ui.readApprovalCycleDom(client).catch(() => ({}));
      if (dom.proposalCardHidden === false || dom.mutationCardHidden === false || dom.deliveryCardHidden === false) {
        return { done: true, value: { kind: 'task_gate', dom } };
      }
      const bubbles = await ui.countBubbles(client);
      if (bubbles.assistant > before.assistant) return { done: true, value: { kind: 'assistant', bubbles } };
      return { done: false };
    },
    { timeoutMs, intervalMs: 1000, describe: () => `a response or approval gate for "${text.slice(0, 40)}…"` },
  );
  if (outcome.kind === 'error') throw new Error(`turn "${text.slice(0, 40)}…" returned an error bubble: ${outcome.errorText}`);
  if (!expectGate && outcome.kind === 'assistant') await waitForComposerReady(client, { timeoutMs });
  return outcome;
}

async function waitForTerminalKarkeState(client, { timeoutMs = 600000 } = {}) {
  return pollUntil(
    async () => {
      const evidenceNow = await readProgressUxEvidence(client);
      if (evidenceNow.outcomeCardClass) return { done: true, value: evidenceNow };
      return { done: false };
    },
    { timeoutMs, intervalMs: 2000, describe: () => 'a terminal Karke Dikha completion/blocker outcome card' },
  );
}

async function main() {
  let passed = false;
  if (reportInfraBlockedIfUpdaterActive()) process.exit(3);

  log('Building packaged VSIX (npm run package)…');
  execFileSync('npm', ['run', 'package'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  const vsixPath = path.join(repoRoot, 'karkedikha.vsix');
  if (!fs.existsSync(vsixPath)) throw new Error(`packaged VSIX not found at ${vsixPath}`);

  initScratchWorkspace();

  log('Resolving a real VS Code build…');
  const { vscodeExecutablePath, cliArgs } = await resolveVSCode();
  process.env.__KD_VSCODE_EXEC = vscodeExecutablePath;

  log('Installing the packaged extension into an isolated profile…');
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath });

  const tagsResponse = await fetch('http://127.0.0.1:11434/api/tags').catch(() => undefined);
  const installedModels = tagsResponse?.ok ? (await tagsResponse.json()).models ?? [] : [];
  const recommendedModel = installedModels.find(m => m.name.toLowerCase() === 'qwen3.8:27b-mtp-q4_k_m')?.name
    ?? installedModels.find(m => Array.isArray(m.capabilities) && m.capabilities.includes('tools'))?.name
    ?? installedModels[0]?.name;
  if (!recommendedModel) throw new Error('no installed Ollama models found via /api/tags; cannot run a real acceptance');
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
  log(`Pointed role settings at the real installed model: ${recommendedModel}`);

  try {
    const session = await launchWindow();
    await screenshot(session.pageClient, '01-initial-load');

    // ===== TURN 1 — the investigation turn =================================
    log(`TURN 1: ${TURN_1}`);
    await sendChatMessage(session.chatClient, TURN_1);
    // Grab a mid-wait snapshot shortly after sending, before the answer lands
    // — this is where truthful elapsed-wait wording (Step 4) would appear if
    // the local model takes long enough.
    await sleep(9000);
    const midTurn1 = await readAutoState(session.chatClient);
    await screenshot(session.pageClient, '02-turn1-mid-wait');
    evidence.turns.push({ turn: 1, phase: 'mid-wait', text: TURN_1, state: midTurn1 });

    await pollUntil(
      async () => {
        const bubbles = await ui.countBubbles(session.chatClient);
        return bubbles.assistant > 0 ? { done: true, value: bubbles } : { done: false };
      },
      { timeoutMs: 320000, intervalMs: 1500, describe: () => 'Turn 1 assistant answer' },
    );
    await waitForComposerReady(session.chatClient, { timeoutMs: 320000 });
    const turn1Transcript = await readTranscript(session.chatClient);
    await screenshot(session.pageClient, '03-turn1-answer');
    evidence.turns.push({ turn: 1, phase: 'answer', text: TURN_1, transcript: turn1Transcript });
    const turn1Answer = turn1Transcript.filter(b => b.role === 'assistant').at(-1)?.text ?? '';
    if (!/registerUser/i.test(turn1Answer)) {
      throw new Error(`Turn 1 did not produce a grounded answer about registerUser: ${turn1Answer.slice(0, 400)}`);
    }
    if (gitStatus() !== '') throw new Error(`Turn 1 was expected to be read-only but the workspace is dirty:\n${gitStatus()}`);

    // ===== TURN 2 — "Fix it." ===============================================
    log(`TURN 2: ${TURN_2}`);
    const turn2Outcome = await sendTurnAndWait(session.chatClient, TURN_2, { expectGate: true, timeoutMs: 320000 });
    log(`TURN 2 produced: ${turn2Outcome.kind}`);
    const turn2ProgressEvidence = await readProgressUxEvidence(session.chatClient);
    await screenshot(session.pageClient, '04-turn2-ready-for-review');
    evidence.turns.push({ turn: 2, phase: 'ready-for-review', outcome: turn2Outcome, progressEvidence: turn2ProgressEvidence });

    const gates2 = await approveThroughAllGates(session.chatClient, {
      timeoutMs: 300000,
      onFirstActionable: async () => { await screenshot(session.pageClient, '05-turn2-approving'); },
    });
    log(`TURN 2 gates: ${JSON.stringify(gates2.clicked)}`);
    const turn2Transcript = await readTranscript(session.chatClient);
    await screenshot(session.pageClient, '06-turn2-applied-result');
    evidence.turns.push({ turn: 2, phase: 'applied', gates: gates2, transcript: turn2Transcript, gitStatus: gitStatus() });
    const usersAfterTurn2 = readFile('src/users.js');
    if (!/registerUser/.test(usersAfterTurn2)) throw new Error('src/users.js lost registerUser');

    // ===== TURN 3 — "Now update the tests..., finish it." ==================
    log(`TURN 3: ${TURN_3}`);
    const turn3Outcome = await sendTurnAndWait(session.chatClient, TURN_3, { timeoutMs: 600000, expectGate: true });
    log(`TURN 3 produced: ${turn3Outcome.kind}`);
    const turn3InProgressEvidence = await readProgressUxEvidence(session.chatClient);
    await screenshot(session.pageClient, '07-turn3-in-progress');
    evidence.turns.push({ turn: 3, phase: 'in-progress', outcome: turn3Outcome, progressEvidence: turn3InProgressEvidence });

    const gates3 = await approveThroughAllGates(session.chatClient, { timeoutMs: 600000 });
    log(`TURN 3 gates: ${JSON.stringify(gates3.clicked)}`);

    const terminalEvidence = await waitForTerminalKarkeState(session.chatClient, { timeoutMs: 600000 });
    await screenshot(session.pageClient, '08-turn3-final-outcome');
    evidence.turns.push({ turn: 3, phase: 'final', gates: gates3, progressEvidence: terminalEvidence, gitStatus: gitStatus() });

    // ===== Progress & Completion UX assertions ==============================
    if (turn2ProgressEvidence.objectiveCardIsUserBubble !== false) {
      throw new Error(`Karke Dikha's objective card was classed as a user bubble: ${JSON.stringify(turn2ProgressEvidence)}`);
    }
    if (terminalEvidence.outcomeCardClass?.includes('is-success')) {
      log('TURN 3 completed successfully — checking evidence-backed completion card.');
      if (!terminalEvidence.outcomeText || !/file/i.test(terminalEvidence.outcomeText)) {
        throw new Error(`completion card missing changed-file evidence: ${JSON.stringify(terminalEvidence)}`);
      }
    } else if (terminalEvidence.outcomeCardClass?.includes('is-blocked')) {
      log('TURN 3 ended in a governed block/failure — acceptable per this milestone (truthfulness, not model success).');
      if (!terminalEvidence.outcomeHeadline || /\bError\b.*\bat\b|\.ts:\d+/.test(terminalEvidence.outcomeHeadline)) {
        throw new Error(`blocker headline looks like raw exception text, not a humanized message: ${JSON.stringify(terminalEvidence.outcomeHeadline)}`);
      }
    } else {
      throw new Error(`TURN 3 produced neither a success nor a blocked outcome card: ${JSON.stringify(terminalEvidence)}`);
    }

    writeEvidence('run.json', {
      status: 'PASS',
      model: recommendedModel,
      workspaceDir,
      turn2ProgressEvidence,
      turn3InProgressEvidence,
      terminalEvidence,
      evidence,
    });
    log('PASS — 3-turn journey completed with truthful progress/completion UX evidence captured.');
    passed = true;
    await closeWindow(session.pageClient);
  } catch (error) {
    writeEvidence('run.json', { status: 'FAIL', error: error.message, stack: error.stack, evidence });
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
