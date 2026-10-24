#!/usr/bin/env node
// npm run test:e2e:durable-continuity
//
// Installed, local-only acceptance for the "Durable Conversational Continuity
// V1" milestone (Step 9): ONE conversation carried across TWO real VS Code
// restarts, in a real packaged window, against this machine's real local
// Ollama. No cloud calls are made.
//
// The whole point is the restart, so this harness deliberately does NOT reuse
// a single long-lived window like run-unified-conversation-v1-acceptance.mjs:
// it terminates the VS Code process outright between turns and relaunches the
// SAME profile (`userDataDir`/`extensionsDir`), the SAME workspace folder and
// the SAME isolated Core data dir, then reconnects to a brand-new webview.
// Everything the conversation still knows afterwards therefore came back from
// Core's database on disk.
//
// PASS requires that the user never restates the task:
//   Turn 1  "Why does registerUser accept an empty username?"   (read-only)
//   ── close VS Code completely, relaunch the same profile ──
//   Turn 2  "Fix it, but don't change the tests."               (collaborative)
//   ── close VS Code completely, relaunch the same profile ──
//   Turn 3  "Continue and run the relevant validation."         (autonomous)
//
// Opt-in only: requires OLLAMA_AGENT_LIVE_DURABLE_CONTINUITY=1 or --enabled.

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
const enabled = process.env.OLLAMA_AGENT_LIVE_DURABLE_CONTINUITY === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: Durable Conversational Continuity acceptance requires OLLAMA_AGENT_LIVE_DURABLE_CONTINUITY=1 or --enabled.');
  console.log('It launches real packaged VS Code windows (with two full restarts) against this machine\'s real local Ollama. No cloud calls are made.');
  process.exit(0);
}

const TURN_1 = 'Why does registerUser accept an empty username?';
const TURN_2 = "Fix it, but don't change the tests.";
const TURN_3 = 'Continue and run the relevant validation.';

const startedAt = Date.now();
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-durable-continuity-acceptance-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'durable-conversational-continuity-v1');
const userDataDir = path.join(workDir, 'user-data');
const extensionsDir = path.join(workDir, 'extensions');
const workspaceDir = path.join(workDir, 'workspace');
const coreDataDir = path.join(workDir, 'core-data');

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[durable-continuity-acceptance +${elapsed}s] ${message}`);
}

const evidence = { turns: [], restarts: [] };
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

function readFile(rel) { return fs.readFileSync(path.join(workspaceDir, rel), 'utf8'); }
function gitStatus() { return spawnSync('git', ['status', '--porcelain'], { cwd: workspaceDir, encoding: 'utf8' }).stdout.trim(); }
function gitDiff() { return spawnSync('git', ['diff'], { cwd: workspaceDir, encoding: 'utf8' }).stdout; }

/** The same disposable fixture shape the Unified Conversation acceptance uses:
 * a `registerUser` with no empty-username guard, plus real tests that the
 * Turn 2 constraint ("don't change the tests") must leave alone. */
function initScratchWorkspace() {
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Disposable Durable Continuity acceptance workspace\n');
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
    JSON.stringify({ name: 'durable-continuity-fixture', private: true, scripts: { test: 'node --test src/users.test.js' } }, null, 2));
  spawnSync('git', ['init', '-q'], { cwd: workspaceDir });
  spawnSync('git', ['config', 'user.email', 'acceptance@example.invalid'], { cwd: workspaceDir });
  spawnSync('git', ['config', 'user.name', 'Durable Continuity Acceptance'], { cwd: workspaceDir });
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
    continuityText: document.getElementById('everyday-continuity')?.textContent ?? null,
    continuityHidden: document.getElementById('everyday-continuity')?.hidden ?? null,
    sendBtnText: document.getElementById('send-btn')?.textContent ?? null,
    sendBtnDisabled: document.getElementById('send-btn')?.disabled ?? null,
  })`);
}

async function readTranscript(client) {
  return evalInWebviewContentDoc(client, `Array.from(document.querySelectorAll('.bubble')).map(node => ({
    role: node.classList.contains('user') ? 'user' : node.classList.contains('error') ? 'error' : 'assistant',
    text: (node.textContent || '').slice(0, 4000),
  }))`);
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

/**
 * A Saath Kar file edit is gated by M38's generic governed-capability approval,
 * which renders as an inline `.capability-approval-card` chat bubble — NOT the
 * Karke-Dikha-only proposal/mutation/delivery sections. Both kinds are driven
 * below, capability card first, exactly as run-unified-conversation-v1 does.
 */
async function readLatestUnresolvedCapabilityCard(client) {
  return evalInWebviewContentDoc(client, `(() => {
    const el = Array.from(document.querySelectorAll('.capability-approval-card:not(.resolved)')).pop();
    if (!el) return null;
    return {
      id: el.id,
      titleText: el.querySelector('strong')?.textContent ?? null,
      diffPath: el.querySelector('.proposal-diff')?.getAttribute('data-path') ?? null,
      diffBody: el.querySelector('.proposal-diff-body')?.textContent ?? null,
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

/** Clicks whichever approval gate is currently actionable until the composer
 * settles. Governance is unchanged by this milestone, so this is the same
 * normal approval path every other packaged acceptance drives. */
async function approveThroughAllGates(client, { timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const clicked = [];
  const approvedPaths = [];
  while (Date.now() < deadline) {
    const capabilityCard = await readLatestUnresolvedCapabilityCard(client);
    if (capabilityCard && capabilityCard.approveDisabled === false) {
      await clickLatestCapabilityCardButton(client, 'approved');
      clicked.push(`capability:${capabilityCard.diffPath ?? capabilityCard.titleText ?? capabilityCard.id}`);
      approvedPaths.push(capabilityCard.diffPath ?? null);
      await sleep(2500);
      continue;
    }
    const dom = await ui.readApprovalCycleDom(client);
    if (dom.proposalCardHidden === false && dom.proposalApproveDisabled === false) {
      await ui.clickProposalApproveButton(client); clicked.push('proposal'); await sleep(2000); continue;
    }
    if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) {
      await ui.clickMutationApproveButton(client); clicked.push('mutation'); await sleep(2000); continue;
    }
    if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) {
      await ui.clickDeliveryApproveButton(client); clicked.push('delivery'); await sleep(2000); continue;
    }
    const state = await readAutoState(client);
    if (state.sendBtnText === 'Send' && state.sendBtnDisabled === false) {
      return { clicked, approvedPaths, state };
    }
    await sleep(1500);
  }
  throw new Error(`timed out waiting through approval gates; clicked so far=${JSON.stringify(clicked)}`);
}

let host;
let remoteDebuggingPort;

/**
 * Every Code.exe process whose command line binds it to THIS run's profile,
 * split into the UI/profile processes that must be gone before a relaunch and
 * the KarkeDikha Core daemon, which must NOT be killed.
 *
 * Core surviving a VS Code restart is the product's design (it is discovered
 * through core.json/core.lock and reused by the next window), and the previous
 * harness failure was caused by treating "make restart work" as licence to
 * kill everything. So Core is identified and deliberately left alone.
 */
function inspectProfileProcesses() {
  const script = `
    $rows = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" |
      Where-Object { $_.CommandLine -like '*${path.basename(workDir)}*' } |
      ForEach-Object {
        [pscustomobject]@{
          ProcessId = $_.ProcessId
          IsCore    = [bool]($_.CommandLine -like '*out-core*core.js*')
          IsCrashpad= [bool]($_.CommandLine -like '*crashpad-handler*')
          Cmd       = $_.CommandLine.Substring(0, [Math]::Min(220, $_.CommandLine.Length))
        }
      }
    if ($null -eq $rows) { '[]' } else { ConvertTo-Json @($rows) -Compress }`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  let rows = [];
  try { rows = JSON.parse((result.stdout || '[]').trim() || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [rows];
  return {
    core: rows.filter(r => r.IsCore),
    ui: rows.filter(r => !r.IsCore),
    all: rows,
  };
}

function profileLockState() {
  const lockPath = path.join(userDataDir, 'code.lock');
  const portPath = path.join(userDataDir, 'DevToolsActivePort');
  const readMaybe = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
  return { codeLock: readMaybe(lockPath), devToolsActivePort: readMaybe(portPath) };
}

function describeShutdownState(label) {
  const processes = inspectProfileProcesses();
  return {
    label,
    lock: profileLockState(),
    corePids: processes.core.map(r => r.ProcessId),
    uiPids: processes.ui.map(r => r.ProcessId),
    uiCommandLines: processes.ui.map(r => r.Cmd),
  };
}

/**
 * Launches (or relaunches) the SAME profile, workspace and Core data dir, then
 * returns a client bound to a freshly created chat webview. `firstLaunch`
 * additionally waits through onboarding, which only runs on a fresh profile.
 */
async function launchWindow({ firstLaunch }) {
  remoteDebuggingPort = allocateDebugPort();
  log(`Launching VS Code (port ${remoteDebuggingPort})${firstLaunch ? '' : ' — RELAUNCH of the same profile/workspace/Core data dir'}…`);
  host = launchPlainHost(process.env.__KD_VSCODE_EXEC, {
    userDataDir,
    extensionsDir,
    workspacePath: workspaceDir,
    remoteDebuggingPort,
    env: { KARKEDIKHA_DATA_DIR: coreDataDir },
  });

  // Attach only once THIS launch owns THIS port. DevToolsActivePort is written
  // by whichever instance actually took the port, so a mismatch means we are
  // looking at a handed-off or leftover instance rather than the one just launched.
  const page = await pollUntil(
    async () => {
      // `exitCode` is null while running and a NUMBER once exited; anything
      // else (undefined) means "no information", not "dead".
      if (typeof host?.child?.exitCode === 'number') {
        throw new Error(`the launched VS Code process exited immediately (code ${host.child.exitCode}); ${JSON.stringify(describeShutdownState('launch-failed'))}`);
      }
      const targets = await board.listTargets(remoteDebuggingPort);
      const found = targets.find(t => t.type === 'page');
      return found ? { done: true, value: found } : { done: false };
    },
    {
      timeoutMs: 120000,
      describe: () => `a workbench page target on port ${remoteDebuggingPort}; ${JSON.stringify(describeShutdownState('launch-diagnostics'))}`,
    },
  );
  const pageClient = await board.connectToTarget(remoteDebuggingPort, page.id);
  await board.waitForWorkbenchDomReady(pageClient);

  const excludeIds = [];
  if (firstLaunch) {
    log('Waiting for onboarding readiness on this fresh profile…');
    const { client: setupClient, targetId } = await waitForSetupWebview(remoteDebuggingPort, [], { timeoutMs: 90000 });
    excludeIds.push(targetId);
    const readiness = await pollUntil(
      async () => {
        const snapshot = await evalInWebviewContentDoc(setupClient, `({ overallText: document.querySelector('.overall')?.textContent ?? null })`);
        return snapshot.overallText === 'READY' ? { done: true, value: snapshot } : { done: false, value: snapshot };
      },
      { timeoutMs: 180000, intervalMs: 2000, describe: () => 'onboarding to report overall READY' },
    );
    log(`Onboarding readiness: ${readiness.overallText}`);
    writeEvidence('readiness-snapshot.json', readiness);
    await setupClient.close();
  }

  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
  const chatClient = await ui.connectToWebviewHost(remoteDebuggingPort, { attempts: 90, delayMs: 500, excludeIds });
  await ui.waitForWebviewContentMounted(chatClient, { timeoutMs: 45000, readyElementId: 'send-btn' });
  await ui.instrumentWebviewPostMessage(chatClient);
  // CoreManager's connection and the workspace-restoration handshake can lag a
  // freshly-mounted webview; the composer stays disabled until restoration
  // resolves, which is exactly what we then wait for.
  await waitForComposerReady(chatClient, { timeoutMs: 120000 });
  return { pageClient, chatClient };
}

/**
 * Closes the VS Code UI completely and PROVES the profile is free before the
 * caller relaunches, while deliberately leaving the KarkeDikha Core daemon
 * running.
 *
 *   1. graceful `Browser.close` over CDP (the supported Electron shutdown seam);
 *   2. wait for the launched process to exit;
 *   3. wait until no non-Core Code.exe process is bound to this profile and the
 *      profile lock is released;
 *   4. narrowest possible fallback — terminate ONLY the UI/crashpad pids whose
 *      command line names THIS run's directory, never Core, never an unrelated
 *      VS Code the developer has open.
 *
 * The previous version force-killed the launcher tree and slept 8s. That left
 * a crashpad handler holding the profile, so the relaunched instance saw the
 * profile as in use, handed off and exited — the acceptance then timed out
 * waiting for a CDP target that never appeared.
 */
async function closeWindow(label, pageClient) {
  log(`Closing VS Code gracefully (${label})…`);
  const startedAt = Date.now();
  let method = 'browser_close';
  try {
    await pageClient?.Browser?.close?.();
  } catch (error) {
    method = `browser_close_failed:${error.message}`;
  }
  try { await pageClient?.close?.(); } catch { /* transport already gone */ }

  // 2 — the launched process itself must exit.
  await pollUntil(
    async () => (!host || typeof host.child?.exitCode === 'number' || host.child?.killed
      ? { done: true, value: true }
      : { done: false }),
    { timeoutMs: 45000, intervalMs: 500, describe: () => 'the launched VS Code process to exit' },
  ).catch(() => {
    method += '+launcher_did_not_exit';
  });

  // 3 — the profile must actually be free (Core excluded by design).
  let state = describeShutdownState(`${label}:after-graceful`);
  try {
    state = await pollUntil(
      async () => {
        const current = describeShutdownState(`${label}:waiting`);
        return current.uiPids.length === 0 ? { done: true, value: current } : { done: false, value: current };
      },
      { timeoutMs: 45000, intervalMs: 1000, describe: () => 'all non-Core VS Code processes for this profile to exit' },
    );
  } catch {
    // 4 — narrow fallback, scoped to this run's own directory only.
    const stuck = describeShutdownState(`${label}:fallback`);
    method += `+narrow_fallback(${stuck.uiPids.join(',')})`;
    log(`Graceful close left ${stuck.uiPids.length} profile process(es); terminating only those: ${stuck.uiPids.join(', ')}`);
    for (const pid of stuck.uiPids) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    state = await pollUntil(
      async () => {
        const current = describeShutdownState(`${label}:post-fallback`);
        return current.uiPids.length === 0 ? { done: true, value: current } : { done: false, value: current };
      },
      { timeoutMs: 30000, intervalMs: 1000, describe: () => 'the narrowly-terminated profile processes to disappear' },
    );
  }
  host = undefined;

  const record = {
    label,
    at: new Date().toISOString(),
    method,
    elapsedMs: Date.now() - startedAt,
    corePidsStillRunning: state.corePids,
    coreSurvived: state.corePids.length > 0,
    uiPidsRemaining: state.uiPids,
    lock: state.lock,
  };
  evidence.restarts.push(record);
  log(`Closed (${label}) via ${method}; Core still running: ${JSON.stringify(state.corePids)}; UI remaining: ${JSON.stringify(state.uiPids)}`);
  return record;
}

/**
 * Sends one turn and waits for the turn to PRODUCE something: an assistant
 * answer, an approval gate, or an error.
 *
 * It deliberately does NOT wait for the composer to return to "Send" here.
 * While a governed approval is pending the composer is disabled BY DESIGN, so
 * waiting for it before the gate is answered deadlocks the harness against the
 * product's own governance — which is exactly how run 3 failed. The caller
 * drives the gates (`approveThroughAllGates`), and that helper is what waits
 * for the composer to settle afterwards.
 */
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
  // A read-only turn raises no gate, so it is safe to settle the composer here.
  if (!expectGate && outcome.kind === 'assistant') await waitForComposerReady(client, { timeoutMs });
  return outcome;
}

async function main() {
  let passed = false;
  if (reportInfraBlockedIfUpdaterActive()) process.exit(3);

  log('Building packaged VSIX (npm run package)…');
  execFileSync('npm', ['run', 'package'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  const vsixPath = path.join(repoRoot, 'karkedikha.vsix');
  if (!fs.existsSync(vsixPath)) throw new Error(`packaged VSIX not found at ${vsixPath}`);

  initScratchWorkspace();
  const testsBefore = readFile('src/users.test.js');

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

  try {
    // ===== LAUNCH 1 — the investigation turn ==============================
    let session = await launchWindow({ firstLaunch: true });

    log(`TURN 1 (launch 1): ${TURN_1}`);
    await sendTurnAndWait(session.chatClient, TURN_1);
    const turn1Transcript = await readTranscript(session.chatClient);
    const turn1State = await readAutoState(session.chatClient);
    evidence.turns.push({ turn: 1, launch: 1, text: TURN_1, state: turn1State, transcript: turn1Transcript });
    const turn1Answer = turn1Transcript.filter(b => b.role === 'assistant').at(-1)?.text ?? '';
    if (!/registerUser/i.test(turn1Answer)) {
      throw new Error(`Turn 1 did not produce a grounded answer about registerUser: ${turn1Answer.slice(0, 400)}`);
    }
    if (gitStatus() !== '') throw new Error(`Turn 1 was expected to be read-only but the workspace is dirty:\n${gitStatus()}`);

    // ===== RESTART 1 ======================================================
    await session.chatClient.close().catch(() => undefined);
    const restart1 = await closeWindow('after turn 1', session.pageClient);
    if (!restart1.coreSurvived) {
      throw new Error('the KarkeDikha Core daemon did not survive the VS Code restart; this harness must never terminate it');
    }
    session = await launchWindow({ firstLaunch: false });

    const restoredState = await readAutoState(session.chatClient);
    const restoredTranscript = await readTranscript(session.chatClient);
    evidence.turns.push({ turn: 'restore-1', launch: 2, state: restoredState, transcript: restoredTranscript });
    if (restoredTranscript.length === 0) throw new Error('the restored window showed an empty transcript — conversation identity did not survive the restart');
    if (restoredState.continuityHidden !== false || !/^Continuing:/.test((restoredState.continuityText || '').trim())) {
      throw new Error(`expected a "Continuing: …" cue after the restart, got ${JSON.stringify(restoredState.continuityText)}`);
    }

    // ===== TURN 2 — the referential follow-up WITH a constraint ===========
    log(`TURN 2 (launch 2, no restatement of the task): ${TURN_2}`);
    const turn2Outcome = await sendTurnAndWait(session.chatClient, TURN_2, { expectGate: true });
    log(`TURN 2 produced: ${turn2Outcome.kind}${turn2Outcome.card?.diffPath ? ` (${turn2Outcome.card.diffPath})` : ''}`);
    const gates2 = await approveThroughAllGates(session.chatClient);
    log(`TURN 2 gates: ${JSON.stringify(gates2.clicked)}`);
    const turn2Transcript = await readTranscript(session.chatClient);
    evidence.turns.push({ turn: 2, launch: 2, text: TURN_2, gates: gates2, transcript: turn2Transcript, gitStatus: gitStatus(), gitDiff: gitDiff() });
    // The referent must have resolved to registerUser without being restated,
    // and the constraint must have been respected.
    const usersAfterTurn2 = readFile('src/users.js');
    if (!/registerUser/.test(usersAfterTurn2)) throw new Error('src/users.js lost registerUser');
    if (readFile('src/users.test.js') !== testsBefore) {
      throw new Error(`the "don't change the tests" constraint was violated:\n${gitDiff()}`);
    }

    // ===== RESTART 2 ======================================================
    await session.chatClient.close().catch(() => undefined);
    const restart2 = await closeWindow('after turn 2', session.pageClient);
    if (!restart2.coreSurvived) {
      throw new Error('the KarkeDikha Core daemon did not survive the second VS Code restart');
    }
    session = await launchWindow({ firstLaunch: false });

    const restored2State = await readAutoState(session.chatClient);
    evidence.turns.push({ turn: 'restore-2', launch: 3, state: restored2State, transcript: await readTranscript(session.chatClient) });

    // ===== TURN 3 — continue and validate ================================
    log(`TURN 3 (launch 3, no restatement of the task): ${TURN_3}`);
    const turn3Outcome = await sendTurnAndWait(session.chatClient, TURN_3, { timeoutMs: 600000, expectGate: true });
    log(`TURN 3 produced: ${turn3Outcome.kind}`);
    const gates3 = await approveThroughAllGates(session.chatClient, { timeoutMs: 600000 });
    log(`TURN 3 gates: ${JSON.stringify(gates3.clicked)}`);
    const turn3Transcript = await readTranscript(session.chatClient);
    evidence.turns.push({ turn: 3, launch: 3, text: TURN_3, gates: gates3, transcript: turn3Transcript, gitStatus: gitStatus(), gitDiff: gitDiff() });

    if (readFile('src/users.test.js') !== testsBefore) {
      throw new Error(`the carried-forward constraint was violated by the autonomous turn:\n${gitDiff()}`);
    }

    writeEvidence('run.json', { status: 'PASS', model: recommendedModel, workspaceDir, coreDataDir, evidence });
    log('PASS — one conversation survived two complete VS Code restarts with no manual reconstruction of the task.');
    passed = true;
  } catch (error) {
    writeEvidence('run.json', { status: 'FAIL', error: error.message, stack: error.stack, evidence });
    log(`FAIL: ${error.message}`);
  } finally {
    // Leave Core alone here too: the run's Core data dir is disposable, and the
    // daemon exits on its own idle timeout. Only this run's UI processes are
    // cleaned up, and only by their own pids.
    terminatePlainHost(host?.child);
    const remaining = describeShutdownState('final-cleanup');
    for (const pid of remaining.uiPids) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    writeEvidence('shutdown-state.json', { finalState: describeShutdownState('final'), restarts: evidence.restarts });
  }
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  writeEvidence('run.json', { status: 'FAIL', error: error.message, stack: error.stack, evidence });
  console.error(error);
  process.exit(1);
});
