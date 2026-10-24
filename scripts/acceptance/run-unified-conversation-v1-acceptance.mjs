#!/usr/bin/env node
// npm run test:e2e:unified-conversation-v1
//
// Installed, local-only acceptance for the "Unified Conversation V1"
// milestone: ONE conversation, Auto mode left selected for the entire run,
// proving the internal execution-policy router (src/orchestration/
// ExecutionPolicyRouter.ts) drives real Baat Kar / Saath Kar / Karke Dikha
// submissions through their existing production paths — no manual mode
// switch is ever performed by this harness.
//
// Modeled directly on run-baat-core-readiness-acceptance.mjs's proven
// launch/profile/model-settings plumbing (same isolated KARKEDIKHA_DATA_DIR
// pattern, same real-model settings lookup) — Turn 1 here is verbatim that
// script's scenario. Turns 2-4 extend the SAME webview session (no reload,
// no restart) with a bounded edit (reject then a referential follow-up
// approve) and a full autonomous fix-and-validate request.
//
// Opt-in only: requires OLLAMA_AGENT_LIVE_UNIFIED_CONVERSATION=1 or --enabled.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
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
const enabled = process.env.OLLAMA_AGENT_LIVE_UNIFIED_CONVERSATION === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: Unified Conversation V1 acceptance requires OLLAMA_AGENT_LIVE_UNIFIED_CONVERSATION=1 or --enabled.');
  console.log('It launches a real packaged VS Code window with an isolated Core against this machine\'s real local Ollama. No cloud calls are made.');
  process.exit(0);
}

const TURN_1 = 'Where is user registration implemented, what does registerUser currently do, and which tests cover it?';
const TURN_2 = 'Okay, change getDisplayName so empty usernames show Unknown.';
const TURN_3 = 'Actually, do that.';
const TURN_4 = 'Now fix registerUser so it rejects an empty username, update the relevant tests, and run the relevant validation.';

const startedAt = Date.now();
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-unified-conv-v1-acceptance-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'unified-conversation-v1');
const userDataDir = path.join(workDir, 'user-data');
const extensionsDir = path.join(workDir, 'extensions');
const workspaceDir = path.join(workDir, 'workspace');
const coreDataDir = path.join(workDir, 'core-data');

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[unified-conv-v1-acceptance +${elapsed}s] ${message}`);
}

const evidence = { turns: [] };
function writeEvidence(name, data) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify({ capturedAt: new Date().toISOString(), ...data }, null, 2));
}

async function evaluateExpr(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(`CDP Runtime.evaluate threw: ${exceptionDetails.text}`);
  return result.value;
}

async function evalInWebviewContentDoc(client, docExpression) {
  const wrapped = `(() => {
    const inner = window.document.getElementById('active-frame');
    if (!inner) return { __noActiveFrame: true };
    const document = inner.contentDocument;
    if (!document) return { __noContentDocument: true };
    return (${docExpression});
  })()`;
  return evaluateExpr(client, wrapped);
}

async function waitForSetupWebview(port, excludeIds, { timeoutMs = 60000 } = {}) {
  const CDP = (await import('chrome-remote-interface')).default;
  const excluded = new Set(excludeIds);
  return pollUntil(
    async () => {
      const targets = await CDP.List({ port });
      const candidates = targets.filter(
        t => t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith('vscode-webview://') && t.url.includes('/index.html') && !excluded.has(t.id),
      );
      for (const candidate of candidates) {
        const client = await board.connectToTarget(port, candidate.id);
        const probe = await evalInWebviewContentDoc(client, `({ h1: document.querySelector('h1')?.textContent ?? null })`).catch(() => ({}));
        if (probe?.h1 === 'KarkeDikha Setup') return { done: true, value: { client, targetId: candidate.id } };
        await client.close();
      }
      return { done: false };
    },
    { timeoutMs, describe: () => 'the KarkeDikha Setup onboarding webview to open' },
  );
}

function readSetupSnapshot(client) {
  return evalInWebviewContentDoc(client, `({
    overallText: document.querySelector('.overall')?.textContent ?? null,
    bodyText: document.body.innerText,
  })`);
}

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
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe?.() ?? 'condition'}${lastError ? `; lastError=${lastError.message}` : ''}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function gitStatus() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: workspaceDir, encoding: 'utf8' });
  return result.stdout.trim();
}

function gitDiff() {
  const result = spawnSync('git', ['diff'], { cwd: workspaceDir, encoding: 'utf8' });
  return result.stdout;
}

function readFile(rel) {
  return fs.readFileSync(path.join(workspaceDir, rel), 'utf8');
}

/** Bounded but real fixture (disposable, this run's own workspace copy —
 * never the checked-in .acceptance-evidence/karke-benchmark-fixture): a
 * registerUser with no empty-username guard (Turn 4's real defect) and a
 * getDisplayName with no empty-username fallback (Turn 2/3's real target). */
function initScratchWorkspace() {
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Disposable Unified Conversation V1 acceptance workspace\n');
  fs.writeFileSync(
    path.join(workspaceDir, 'src', 'users.js'),
    [
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
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'src', 'users.test.js'),
    [
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
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'package.json'),
    // `node --test src` (a bare directory name) mis-resolves as a literal
    // module path on this Node/Windows combination ("Cannot find module
    // '...\workspace\src'") — point directly at the one test file instead.
    JSON.stringify({ name: 'unified-conversation-v1-fixture', private: true, scripts: { test: 'node --test src/users.test.js' } }, null, 2),
  );
  spawnSync('git', ['init', '-q'], { cwd: workspaceDir });
  spawnSync('git', ['config', 'user.email', 'acceptance@example.invalid'], { cwd: workspaceDir });
  spawnSync('git', ['config', 'user.name', 'Unified Conversation V1 Acceptance'], { cwd: workspaceDir });
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
    chipLabel: document.getElementById('everyday-reco-label')?.textContent ?? null,
    chipReason: document.getElementById('everyday-reco-reason')?.textContent ?? null,
    chipHidden: document.getElementById('everyday-reco-row')?.hidden ?? null,
    phaseText: document.getElementById('everyday-phase-sentence')?.textContent ?? null,
    sendBtnText: document.getElementById('send-btn')?.textContent ?? null,
    sendBtnDisabled: document.getElementById('send-btn')?.disabled ?? null,
  })`);
}

async function readOutcomeText(client) {
  return evalInWebviewContentDoc(client, `document.getElementById('everyday-outcome-card')?.textContent ?? null`);
}

/** Clicks whichever approval gate is currently actionable (proposal, then
 * mutation, then delivery) until the composer returns to a terminal 'Send'
 * state, or times out. Returns which gates were clicked, in order. */
async function approveThroughAllGates(client, { timeoutMs = 240000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const clicked = [];
  while (Date.now() < deadline) {
    // A bare Saath-style file-edit tool call raises a `.capability-approval-card`
    // inline chat bubble (see readLatestUnresolvedCapabilityCard's header
    // comment) rather than the Karke-specific proposal/mutation/delivery
    // sections — check for it first since Turn 4's Karke Dikha lifecycle can
    // raise either kind of gate depending on which tool the model used.
    const capabilityCard = await readLatestUnresolvedCapabilityCard(client);
    if (capabilityCard && capabilityCard.approveDisabled === false) {
      await clickLatestCapabilityCardButton(client, 'approved');
      clicked.push(`capability:${capabilityCard.titleText ?? capabilityCard.id}`);
      await sleep(2000);
      continue;
    }
    const dom = await ui.readApprovalCycleDom(client);
    if (dom.proposalCardHidden === false && dom.proposalApproveDisabled === false) {
      await ui.clickProposalApproveButton(client);
      clicked.push('proposal');
      await sleep(2000);
      continue;
    }
    if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) {
      await ui.clickMutationApproveButton(client);
      clicked.push('mutation');
      await sleep(2000);
      continue;
    }
    if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) {
      await ui.clickDeliveryApproveButton(client);
      clicked.push('delivery');
      await sleep(2000);
      continue;
    }
    const state = await readAutoState(client);
    if (state.sendBtnText === 'Send') {
      return { clicked, state };
    }
    await sleep(1500);
  }
  throw new Error(`timed out waiting through approval gates; clicked so far=${JSON.stringify(clicked)}`);
}

async function sendChatMessage(client, text) {
  await ui.evalInWebviewDoc(
    client,
    `(() => {
      const input = document.getElementById('user-input');
      const btn = document.getElementById('send-btn');
      if (!input || !btn) throw new Error('chat composer not found');
      if (btn.disabled) throw new Error('send-btn is disabled — composer was not ready for this turn');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return true;
    })()`,
  );
}

/** Sends a turn, then immediately (not after a long DOM-wait timeout)
 * confirms the click actually posted a real submission message to the
 * extension host — turns a silent stuck-composer failure into an instant,
 * legible one instead of a multi-minute blind timeout. */
/**
 * Saath Kar's real coding-proposal/diff approval is NOT the Karke-Dikha-only
 * `#proposal-approval-card` section (that one only ever receives a
 * `proposalApprovalRequest` message, and every production call site of that
 * message is keyed on a Karke Dikha `taskId` — see
 * src/ui/AgentPanel.ts:1546/1742 and every test that asserts it).
 *
 * A bare Saath Kar attempt's file-edit instead goes through M38's generic
 * governed-capability-dispatch approval (core/domain/capabilityDispatch.ts),
 * which the extension host relays as a `restoreCapabilityApprovalCard`
 * message (src/ui/AgentPanel.ts:701) and the webview renders as an INLINE
 * CHAT BUBBLE — `.capability-approval-card` inside #messages, with a dynamic
 * `capability-approval-<approvalId>` id (media/chat.js:536-611) — carrying
 * the real frozen proposal diff (`.proposal-diff-body`) and Approve/Reject
 * buttons keyed by `data-approval-response`. Discovered by this harness: the
 * first attempt at this script watched `#proposal-approval-card` and never
 * saw it change, even though Core's own DB proved the real attempt reached
 * `waiting_for_approval` in under 20 seconds — the card was there the whole
 * time, just not where a Karke-only assumption expected it.
 */
async function readLatestUnresolvedCapabilityCard(client) {
  return evalInWebviewContentDoc(
    client,
    `(() => {
      const el = Array.from(document.querySelectorAll('.capability-approval-card:not(.resolved)')).pop();
      if (!el) return null;
      return {
        id: el.id,
        titleText: el.querySelector('strong')?.textContent ?? null,
        detailText: el.querySelector('p')?.textContent ?? null,
        diffHeading: el.querySelector('.proposal-diff-heading')?.textContent ?? null,
        diffPath: el.querySelector('.proposal-diff')?.getAttribute('data-path') ?? null,
        diffBody: el.querySelector('.proposal-diff-body')?.textContent ?? null,
        approveDisabled: el.querySelector('button[data-approval-response="approved"]')?.disabled ?? null,
        rejectDisabled: el.querySelector('button[data-approval-response="rejected"]')?.disabled ?? null,
      };
    })()`,
  );
}

/** Waits for a fresh (unresolved) capability-approval card to appear, or an
 * error bubble. On timeout, captures diagnostics for evidence. */
async function waitForCapabilityCardOrError(client, label, { timeoutMs = 320000 } = {}) {
  try {
    return await pollUntil(
      async () => {
        const card = await readLatestUnresolvedCapabilityCard(client);
        if (card) return { done: true, value: { kind: 'card', card } };
        const errorText = await evalInWebviewContentDoc(client, `document.querySelector('.bubble.error')?.textContent ?? null`);
        if (errorText) return { done: true, value: { kind: 'error', errorText } };
        return { done: false };
      },
      { timeoutMs, intervalMs: 1000, describe: () => `${label} capability approval card (proposal diff) or an error bubble` },
    );
  } catch (error) {
    await ui.captureFailureDiagnostics(client, evidenceDir, label).catch(() => {});
    const posted = await ui.readInstrumentedPostedMessages(client).catch(() => null);
    writeEvidence(`${label}-timeout-posted-messages.json`, { posted });
    throw error;
  }
}

async function clickLatestCapabilityCardButton(client, response) {
  await ui.evalInWebviewDoc(
    client,
    `(() => {
      const cards = Array.from(document.querySelectorAll('.capability-approval-card:not(.resolved)'));
      const card = cards[cards.length - 1];
      if (!card) throw new Error('no unresolved .capability-approval-card found');
      const btn = card.querySelector('button[data-approval-response="${response}"]');
      if (!btn) throw new Error('capability approval button not found (data-approval-response="${response}")');
      if (btn.disabled) throw new Error('capability approval button is disabled');
      btn.click();
      return true;
    })()`,
  );
}

/** Polls until #send-btn is enabled again (post-completion bookkeeping can
 * briefly hold it disabled after a turn finishes) rather than guessing a
 * fixed settle delay. */
async function waitForComposerReady(client, { timeoutMs = 30000 } = {}) {
  return pollUntil(
    async () => {
      const state = await readAutoState(client);
      return state.sendBtnDisabled === false ? { done: true, value: state } : { done: false, value: state };
    },
    { timeoutMs, intervalMs: 500, describe: () => 'composer send button to re-enable after the previous turn' },
  );
}

async function sendChatMessageAndVerifyPosted(client, text, { timeoutMs = 15000 } = {}) {
  const before = (await ui.readInstrumentedPostedMessages(client)) ?? [];
  await sendChatMessage(client, text);
  const posted = await pollUntil(
    async () => {
      const after = (await ui.readInstrumentedPostedMessages(client)) ?? [];
      const fresh = after.slice(before.length);
      const match = fresh.find(m => (m.type === 'sendMessage' || m.type === 'startAutonomousTask') && m.text === text);
      return match ? { done: true, value: { match, fresh } } : { done: false, value: fresh };
    },
    { timeoutMs, intervalMs: 300, describe: () => `send click for "${text.slice(0, 40)}…" to post a real sendMessage/startAutonomousTask` },
  );
  return posted;
}

async function main() {
  let passed = false;
  if (reportInfraBlockedIfUpdaterActive()) process.exit(3);

  log('Building packaged VSIX (npm run package)…');
  execFileSync('npm', ['run', 'package'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  const vsixPath = path.join(repoRoot, 'karkedikha.vsix');
  if (!fs.existsSync(vsixPath)) throw new Error(`packaged VSIX not found at ${vsixPath}`);

  initScratchWorkspace();
  const usersJsBefore = readFile('src/users.js');

  log('Resolving a real VS Code build…');
  const { vscodeExecutablePath, cliArgs } = await resolveVSCode();

  log('Installing the packaged extension into an isolated profile…');
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath });

  const tagsResponse = await fetch('http://127.0.0.1:11434/api/tags').catch(() => undefined);
  const installedModels = tagsResponse?.ok ? (await tagsResponse.json()).models ?? [] : [];
  // Karke Dikha needs tool-calling capability — a loose 'qwen3.8' substring
  // match can land on a completion/vision-only build with the same family
  // name (discovered by this harness: hf.co/unsloth/Qwen3.8-27B-GGUF has no
  // 'tools' capability). Prefer the exact model this codebase's own
  // acceptance history already proved live (see
  // run-baat-core-readiness-acceptance.mjs), then any installed model that
  // actually advertises 'tools'.
  const recommendedModel = installedModels.find(m => m.name.toLowerCase() === 'qwen3.8:27b-mtp-q4_k_m')?.name
    ?? installedModels.find(m => Array.isArray(m.capabilities) && m.capabilities.includes('tools'))?.name
    ?? installedModels[0]?.name;
  if (!recommendedModel) {
    throw new Error('no installed Ollama models found via /api/tags; cannot run a real acceptance');
  }
  const userDir = path.join(userDataDir, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  const settingsPath = path.join(userDir, 'settings.json');
  const existing = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...existing,
    'ollama-agent.model': recommendedModel,
    'ollama-agent.chatModel': recommendedModel,
    'ollama-agent.agentModel': recommendedModel,
    'ollama-agent.codingModel': recommendedModel,
    'ollama-agent.editModel': recommendedModel,
    'ollama-agent.reviewerModel': recommendedModel,
    'ollama-agent.codingFallbackModel': recommendedModel,
  }, null, 2));
  log(`Pointed role settings at the real installed model: ${recommendedModel}`);

  const remoteDebuggingPort = allocateDebugPort();
  log(`Launching an isolated VS Code window (port ${remoteDebuggingPort}) with an isolated Core data dir…`);
  const host = launchPlainHost(vscodeExecutablePath, {
    userDataDir,
    extensionsDir,
    workspacePath: workspaceDir,
    remoteDebuggingPort,
    env: { KARKEDIKHA_DATA_DIR: coreDataDir },
  });

  try {
    const page = await pollUntil(
      async () => {
        const targets = await board.listTargets(remoteDebuggingPort);
        const found = targets.find(t => t.type === 'page');
        return found ? { done: true, value: found } : { done: false };
      },
      { timeoutMs: 90000, describe: () => 'a workbench page target' },
    );
    const pageClient = await board.connectToTarget(remoteDebuggingPort, page.id);
    await board.waitForWorkbenchDomReady(pageClient);

    log('Waiting for the onboarding Setup panel to auto-open on this fresh profile…');
    const { client: setupClient, targetId: setupTargetId } = await waitForSetupWebview(remoteDebuggingPort, [], { timeoutMs: 60000 });
    log('Waiting for onboarding readiness to resolve overall READY (Ollama + model + Core all connected)…');
    const readiness = await pollUntil(
      async () => {
        const snapshot = await readSetupSnapshot(setupClient);
        if (snapshot.overallText === 'READY') return { done: true, value: snapshot };
        return { done: false, value: snapshot };
      },
      { timeoutMs: 120000, intervalMs: 2000, describe: () => 'onboarding to report overall READY' },
    ).catch(async (error) => {
      const finalSnapshot = await readSetupSnapshot(setupClient).catch(() => undefined);
      writeEvidence('readiness-timeout.json', { error: error.message, finalSnapshot });
      throw error;
    });
    log(`Onboarding readiness: ${readiness.overallText}`);
    writeEvidence('readiness-snapshot.json', readiness);
    await setupClient.close();

    log('Opening the KarkeDikha chat sidebar via the real Command Palette…');
    await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
    const chatClient = await ui.connectToWebviewHost(remoteDebuggingPort, { attempts: 60, delayMs: 500, excludeIds: [setupTargetId] });
    await ui.waitForWebviewContentMounted(chatClient, { timeoutMs: 30000, readyElementId: 'send-btn' });
    await ui.instrumentWebviewPostMessage(chatClient);
    // Same settle rationale as run-m32-packaged-dogfood.mjs's openChatPanel:
    // CoreManager's async connection can lag a freshly-mounted webview.
    await sleep(8000);

    // ── Governance invariant this whole run rests on: NEVER click a mode
    // button. Auto (the default-selected composer state) must drive every
    // one of the four turns below on its own.

    // ===== TURN 1 — READ_ONLY / Baat =====================================
    log('TURN 1: sending the read-only investigation question (Auto selected, no manual mode switch)…');
    const beforeBubbles1 = await ui.countBubbles(chatClient);
    await sendChatMessage(chatClient, TURN_1);
    const outcome1 = await pollUntil(
      async () => {
        const bubbles = await ui.countBubbles(chatClient);
        const errorText = await evalInWebviewContentDoc(chatClient, `document.querySelector('.bubble.error')?.textContent ?? null`);
        if (errorText) return { done: true, value: { kind: 'error', errorText } };
        if (bubbles.assistant > beforeBubbles1.assistant) return { done: true, value: { kind: 'assistant', bubbles } };
        return { done: false };
      },
      { timeoutMs: 320000, intervalMs: 1000, describe: () => 'Turn 1 assistant response' },
    );
    if (outcome1.kind === 'error') throw new Error(`Turn 1 (expected READ_ONLY) returned an error: ${outcome1.errorText}`);
    // A bubble appearing only means the FIRST token streamed in — wait for
    // streaming to actually finish (composer re-enabled) before reading the
    // final text, or this reads a half-streamed answer.
    await waitForComposerReady(chatClient, { timeoutMs: 320000 });
    const turn1State = await readAutoState(chatClient);
    const turn1Approval = await ui.readApprovalCycleDom(chatClient);
    const turn1CapabilityCard = await readLatestUnresolvedCapabilityCard(chatClient);
    const turn1AssistantText = await evalInWebviewContentDoc(chatClient, `Array.from(document.querySelectorAll('.bubble.assistant')).pop()?.textContent ?? null`);
    const turn1GitStatus = gitStatus();
    const turn1AnyApprovalVisible = turn1Approval.proposalCardHidden === false || turn1Approval.mutationCardHidden === false || turn1Approval.deliveryCardHidden === false || turn1CapabilityCard !== null;
    const turn1Record = {
      turn: 1,
      sentText: TURN_1,
      modeSelectValue: turn1State.modeSelectValue,
      chipLabel: turn1State.chipLabel,
      chipReason: turn1State.chipReason,
      anyApprovalCardVisible: turn1AnyApprovalVisible,
      gitStatusAfter: turn1GitStatus,
      mentionsRegisterUser: /registerUser/i.test(turn1AssistantText ?? ''),
      mentionsTest: /test/i.test(turn1AssistantText ?? ''),
      assistantTextLength: turn1AssistantText?.length ?? 0,
      assistantText: turn1AssistantText,
    };
    evidence.turns.push(turn1Record);
    writeEvidence('turn-1.json', turn1Record);
    log(`TURN 1 result: modeSelectValue=${turn1State.modeSelectValue} chip="${turn1State.chipLabel}" anyApprovalVisible=${turn1AnyApprovalVisible} gitStatusAfter="${turn1GitStatus || '(clean)'}"`);
    if (turn1State.modeSelectValue !== 'chat') throw new Error(`POLICY-ROUTING DEFECT (A): Turn 1 expected READ_ONLY (modeSelectValue 'chat'), got '${turn1State.modeSelectValue}'`);
    if (turn1AnyApprovalVisible) throw new Error(`GOVERNANCE DEFECT: an approval card appeared for a read-only Turn 1 question`);
    if (turn1GitStatus) throw new Error(`GOVERNANCE DEFECT: Turn 1 (read-only) mutated the workspace: ${turn1GitStatus}`);
    if (readFile('src/users.js') !== usersJsBefore) throw new Error('GOVERNANCE DEFECT: users.js changed after a read-only Turn 1');
    if (!turn1Record.mentionsRegisterUser) throw new Error(`Turn 1 answer never named registerUser: ${turn1AssistantText}`);

    // ===== TURN 2 — COLLABORATIVE_EDIT / Saath, then REJECT ==============
    log('TURN 2: sending the bounded edit request (Auto still selected)…');
    await waitForComposerReady(chatClient); // let the composer/steering guard fully settle after Turn 1's completion
    const posted2 = await sendChatMessageAndVerifyPosted(chatClient, TURN_2);
    log(`TURN 2 click posted: ${JSON.stringify(posted2.match)}`);
    const wait2 = await waitForCapabilityCardOrError(chatClient, 'turn-2');
    if (wait2.kind === 'error') throw new Error(`Turn 2 (expected COLLABORATIVE_EDIT) returned an error instead of a proposal: ${wait2.errorText}`);
    const turn2State = await readAutoState(chatClient);
    const turn2ProposalCard = wait2.card;
    const turn2GitStatusBeforeGate = gitStatus();
    const turn2UsersJsBeforeGate = readFile('src/users.js');
    const turn2Record = {
      turn: 2,
      sentText: TURN_2,
      modeSelectValue: turn2State.modeSelectValue,
      chipLabel: turn2State.chipLabel,
      proposalCard: turn2ProposalCard,
      gitStatusBeforeApprovalDecision: turn2GitStatusBeforeGate,
      bytesUnchangedBeforeApproval: turn2UsersJsBeforeGate === usersJsBefore,
    };
    log(`TURN 2 proposal shown: modeSelectValue=${turn2State.modeSelectValue} chip="${turn2State.chipLabel}" gitStatus="${turn2GitStatusBeforeGate || '(clean)'}" diffPath=${turn2ProposalCard.diffPath} diffHeading="${turn2ProposalCard.diffHeading}"`);
    if (turn2State.modeSelectValue !== 'agent') throw new Error(`POLICY-ROUTING DEFECT (A): Turn 2 expected COLLABORATIVE_EDIT (modeSelectValue 'agent'), got '${turn2State.modeSelectValue}'`);
    if (turn2GitStatusBeforeGate) throw new Error(`GOVERNANCE DEFECT: workspace already mutated before Turn 2's proposal was approved: ${turn2GitStatusBeforeGate}`);
    if (!turn2Record.bytesUnchangedBeforeApproval) throw new Error('GOVERNANCE DEFECT: users.js bytes changed before Turn 2 approval decision');

    log('TURN 2: rejecting the proposal…');
    await clickLatestCapabilityCardButton(chatClient, 'rejected');
    await pollUntil(
      async () => {
        const card = await readLatestUnresolvedCapabilityCard(chatClient);
        return card === null ? { done: true, value: true } : { done: false };
      },
      { timeoutMs: 30000, intervalMs: 500, describe: () => 'Turn 2 capability approval card to resolve after reject' },
    );
    const turn2GitStatusAfterReject = gitStatus();
    const turn2UsersJsAfterReject = readFile('src/users.js');
    turn2Record.gitStatusAfterReject = turn2GitStatusAfterReject;
    turn2Record.bytesUnchangedAfterReject = turn2UsersJsAfterReject === usersJsBefore;
    evidence.turns.push(turn2Record);
    writeEvidence('turn-2.json', turn2Record);
    log(`TURN 2 rejected. gitStatusAfterReject="${turn2GitStatusAfterReject || '(clean)'}" bytesUnchanged=${turn2Record.bytesUnchangedAfterReject}`);
    if (turn2GitStatusAfterReject) throw new Error(`GOVERNANCE DEFECT: workspace mutated after Turn 2's proposal was rejected: ${turn2GitStatusAfterReject}`);
    if (!turn2Record.bytesUnchangedAfterReject) throw new Error('GOVERNANCE DEFECT: users.js bytes changed after rejection');

    // ===== TURN 3 — referential follow-up, COLLABORATIVE_EDIT, APPROVE ===
    log('TURN 3: sending the bare referential follow-up "Actually, do that." (Auto still selected)…');
    await waitForComposerReady(chatClient);
    const posted3 = await sendChatMessageAndVerifyPosted(chatClient, TURN_3);
    log(`TURN 3 click posted: ${JSON.stringify(posted3.match)}`);
    const wait3 = await waitForCapabilityCardOrError(chatClient, 'turn-3');
    if (wait3.kind === 'error') throw new Error(`Turn 3 ("Actually, do that.") returned an error instead of a fresh proposal: ${wait3.errorText}`);
    const turn3State = await readAutoState(chatClient);
    const turn3ProposalCard = wait3.card;
    // A genuinely fresh attempt/proposal, not the rejected Turn 2 one
    // resurrected: distinct Core-side approval id (embedded in the card's
    // dynamic DOM id `capability-approval-<approvalId>`).
    const turn3IsFreshProposal = turn3ProposalCard.id !== turn2ProposalCard.id;
    const turn3Record = {
      turn: 3,
      sentText: TURN_3,
      modeSelectValue: turn3State.modeSelectValue,
      chipLabel: turn3State.chipLabel,
      proposalCard: turn3ProposalCard,
      isFreshProposal: turn3IsFreshProposal,
      turn2ApprovalCardId: turn2ProposalCard.id,
      gitStatusBeforeApproval: gitStatus(),
    };
    log(`TURN 3 fresh proposal shown: modeSelectValue=${turn3State.modeSelectValue} chip="${turn3State.chipLabel}" cardId=${turn3ProposalCard.id} isFreshProposal=${turn3IsFreshProposal} diffPath=${turn3ProposalCard.diffPath}`);
    if (!turn3IsFreshProposal) throw new Error(`B DEFECT: Turn 3 shows the SAME rejected approval card from Turn 2 (id ${turn2ProposalCard.id}) instead of a fresh proposal`);
    if (turn3State.modeSelectValue !== 'agent') throw new Error(`FOLLOW-UP CONTINUITY DEFECT (B): Turn 3 ("Actually, do that.") expected COLLABORATIVE_EDIT (modeSelectValue 'agent'), got '${turn3State.modeSelectValue}'`);
    if (turn3Record.gitStatusBeforeApproval) throw new Error(`GOVERNANCE DEFECT: workspace already mutated before Turn 3's fresh proposal was approved: ${turn3Record.gitStatusBeforeApproval}`);

    log('TURN 3: approving the fresh proposal…');
    const gateResult3 = await approveThroughAllGates(chatClient, { timeoutMs: 240000 });
    const turn3GitStatusAfter = gitStatus();
    const turn3Diff = gitDiff();
    const turn3UsersJsAfter = readFile('src/users.js');
    turn3Record.gatesClicked = gateResult3.clicked;
    turn3Record.gitStatusAfterApproval = turn3GitStatusAfter;
    turn3Record.diffAfterApproval = turn3Diff;
    // The request was scoped to getDisplayName's empty-username behavior —
    // touching its own covering test file (users.test.js) alongside
    // users.js is a reasonable, bounded part of that same edit, not scope
    // creep. What must NOT happen is anything outside those two files.
    turn3Record.onlyUsersJsChanged = turn3GitStatusAfter.split('\n').filter(Boolean).every(line => /users\.(js|test\.js)$/.test(line.trim().split(/\s+/).pop() ?? ''));
    turn3Record.getDisplayNameFixed = /Unknown/.test(turn3UsersJsAfter);
    evidence.turns.push(turn3Record);
    writeEvidence('turn-3.json', turn3Record);
    log(`TURN 3 approved. gatesClicked=${JSON.stringify(gateResult3.clicked)} gitStatusAfter="${turn3GitStatusAfter}" onlyUsersJsChanged=${turn3Record.onlyUsersJsChanged} getDisplayNameFixed=${turn3Record.getDisplayNameFixed}`);
    if (!turn3GitStatusAfter) throw new Error('C/D/E DEFECT: Turn 3 approval produced zero workspace mutation');
    if (!turn3Record.onlyUsersJsChanged) throw new Error(`GOVERNANCE DEFECT: Turn 3 approval touched files beyond users.js: ${turn3GitStatusAfter}`);
    if (!turn3Record.getDisplayNameFixed) throw new Error(`E DEFECT: Turn 3's approved change did not make getDisplayName return "Unknown" for an empty username: ${turn3UsersJsAfter}`);

    log('Running the fixture\'s own test suite after Turn 3 (npm test in the disposable workspace)…');
    const turn3Test = spawnSync('npm', ['test'], { cwd: workspaceDir, encoding: 'utf8', shell: process.platform === 'win32' });
    turn3Record.npmTestAfter = { status: turn3Test.status, stdout: turn3Test.stdout, stderr: turn3Test.stderr };
    writeEvidence('turn-3.json', turn3Record);
    if (turn3Test.status !== 0) throw new Error(`Turn 3's approved change left the fixture test suite failing (exit ${turn3Test.status}): ${turn3Test.stdout}\n${turn3Test.stderr}`);

    // No manual commit here (deliberately — see docs referenced in the final
    // report): Turn 3's approved Saath edit is left exactly as the real
    // product leaves it, uncommitted. Karke Dikha's own trusted-dirty
    // provenance mechanism (src/orchestration/TrustedDirtyProvenance.ts) is
    // what must now let Turn 4 build on top of it.
    turn3Record.leftUncommittedForTurn4 = gitStatus();
    writeEvidence('turn-3.json', turn3Record);

    // ===== TURN 4 — AUTONOMOUS_EXECUTION / Karke ==========================
    log('TURN 4: sending the fix+update-tests+validate request (Auto still selected, same conversation)…');
    await waitForComposerReady(chatClient);
    const posted4 = await sendChatMessageAndVerifyPosted(chatClient, TURN_4);
    log(`TURN 4 click posted: ${JSON.stringify(posted4.match)}`);
    // Karke Dikha renders through #autonomous-status / #autonomous-task-id
    // rather than the plain chat bubble stream Baat/Saath use.
    await pollUntil(
      async () => {
        const state = await readAutoState(chatClient);
        const dom = await ui.readApprovalCycleDom(chatClient);
        const autonomousStatus = await ui.readAutonomousStatusDom(chatClient);
        if (state.modeSelectValue === 'autonomous' || autonomousStatus.statusHidden === false || dom.proposalCardHidden === false) {
          return { done: true, value: { state, autonomousStatus } };
        }
        return { done: false };
      },
      { timeoutMs: 320000, intervalMs: 1000, describe: () => 'Turn 4 to enter the Karke Dikha lifecycle' },
    );
    const turn4RouteState = await readAutoState(chatClient);
    const turn4Record = { turn: 4, sentText: TURN_4, modeSelectValue: turn4RouteState.modeSelectValue, chipLabel: turn4RouteState.chipLabel };
    log(`TURN 4 routed: modeSelectValue=${turn4RouteState.modeSelectValue} chip="${turn4RouteState.chipLabel}"`);
    if (turn4RouteState.modeSelectValue !== 'autonomous') throw new Error(`POLICY-ROUTING DEFECT (A): Turn 4 expected AUTONOMOUS_EXECUTION (modeSelectValue 'autonomous'), got '${turn4RouteState.modeSelectValue}'`);

    log('TURN 4: approving through every governed gate the Karke Dikha lifecycle raises…');
    const gateResult4 = await approveThroughAllGates(chatClient, { timeoutMs: 480000 });
    const outcomeText4 = await readOutcomeText(chatClient);
    const finalState4 = await readAutoState(chatClient);
    const turn4GitStatus = gitStatus();
    const turn4Diff = gitDiff();
    const turn4UsersJsAfter = readFile('src/users.js');
    turn4Record.gatesClicked = gateResult4.clicked;
    turn4Record.outcomeText = outcomeText4;
    turn4Record.finalSendBtnText = finalState4.sendBtnText;
    turn4Record.gitStatusAfter = turn4GitStatus;
    turn4Record.diffAfter = turn4Diff;
    turn4Record.registerUserRejectsEmpty = /if\s*\(\s*!\s*username\s*\)|throw/.test(turn4UsersJsAfter);
    evidence.turns.push(turn4Record);
    writeEvidence('turn-4.json', turn4Record);
    log(`TURN 4 outcome: ${outcomeText4}. gatesClicked=${JSON.stringify(gateResult4.clicked)} gitStatusAfter="${turn4GitStatus}" registerUserRejectsEmpty=${turn4Record.registerUserRejectsEmpty}`);
    if (!/completed|delivered|success/i.test(outcomeText4 ?? '') && finalState4.sendBtnText !== 'Send') {
      throw new Error(`F DEFECT: Turn 4 did not reach a truthful completion state; outcomeText=${outcomeText4}`);
    }

    log('Running git status/diff/npm test after Turn 4 completion…');
    const finalGitStatus = spawnSync('git', ['status', '--short'], { cwd: workspaceDir, encoding: 'utf8' }).stdout;
    const finalGitDiff = spawnSync('git', ['diff'], { cwd: workspaceDir, encoding: 'utf8' }).stdout;
    const finalNpmTest = spawnSync('npm', ['test'], { cwd: workspaceDir, encoding: 'utf8', shell: process.platform === 'win32' });
    writeEvidence('final-gates.json', { finalGitStatus, finalGitDiff, npmTest: { status: finalNpmTest.status, stdout: finalNpmTest.stdout, stderr: finalNpmTest.stderr } });
    log(`Final git status:\n${finalGitStatus}`);
    log(`Final npm test exit code: ${finalNpmTest.status}`);
    if (finalNpmTest.status !== 0) throw new Error(`Turn 4's delivered change left the fixture test suite failing (exit ${finalNpmTest.status}): ${finalNpmTest.stdout}\n${finalNpmTest.stderr}`);
    if (!turn4Record.registerUserRejectsEmpty) throw new Error(`F DEFECT: registerUser still does not reject an empty username after Turn 4: ${turn4UsersJsAfter}`);
    const onlyExpectedFilesChanged = finalGitStatus.split('\n').filter(Boolean).every(line => /users\.(js|test\.js)$/.test(line.trim().split(/\s+/).pop() ?? ''));
    if (!onlyExpectedFilesChanged) throw new Error(`GOVERNANCE DEFECT: Turn 4 touched unrelated files: ${finalGitStatus}`);

    log('PASSED: all four turns routed correctly under Auto, with no manual mode switch, in one conversation.');
    writeEvidence('result.json', { status: 'PASSED', crossRestartConversationalContinuity: 'DEFERRED_NOT_PROVEN', evidence });
    passed = true;
  } finally {
    terminatePlainHost(host.child);
    try {
      const recordPath = path.join(coreDataDir, 'core.json');
      if (fs.existsSync(recordPath)) {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (record.pid) {
          spawnSync('taskkill', ['/pid', String(record.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        }
      }
    } catch { /* best effort */ }
    if (passed) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      log(`Preserving isolated profile/workspace for inspection: ${workDir}`);
    }
  }
}

main().catch(error => {
  log(`FAILED: ${error.message}`);
  writeEvidence('result.json', { status: 'FAILED', error: error.message, evidence });
  process.exitCode = 1;
});
