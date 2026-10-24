/**
 * Full E2E Verification of P0 Approval Lifecycle on Installed Windows App
 *
 * Scenarios:
 *   1. Legitimate pending approval -> Card appears automatically -> Click Approve in real UI ->
 *      Verify backend decision & tool invocation -> Confirm resumed task reaches final result.
 *   2. Repeat with Reject -> Click Reject in real UI -> Verify backend decision & tool not executed.
 *   3. Restart while awaiting approval -> Verify truthful recovery across restart.
 *   4. Cross-conversation navigation while awaiting approval -> Verify scoping and restoration.
 *   5. Historical terminal-attempt approval -> Verify no actionable buttons displayed.
 *   6. Weather query -> Verify read-only weather executes and answers without approval.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { stopSmokeProcesses, uninstallSmoke } from './lib/smoke-cleanup.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const setupPath = path.join(repoRoot, 'dist', 'Pandesh-Smoke-Setup.exe');
const prodSetupPath = path.join(repoRoot, 'dist', 'Pandesh-Setup.exe');

const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'pandesh-approval-loop', new Date().toISOString().replace(/[:.]/g, '-'));
const screensDir = path.join(evidenceDir, 'screenshots');
fs.mkdirSync(screensDir, { recursive: true });

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

const cdpPort = String(await findFreePort());
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-approval-e2e-'));
const installDir = path.join(scratch, 'install');
const isolatedLocal = path.join(scratch, 'localappdata');
const isolatedRoaming = path.join(scratch, 'appdata');
const dataDir = path.join(isolatedLocal, 'KarkeDikha', 'desktop');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(isolatedRoaming, { recursive: true });

const model = process.env.KARKEDIKHA_DESKTOP_MODEL || 'qwen3-coder:swift-27b';

const env = {
  ...process.env,
  LOCALAPPDATA: isolatedLocal,
  APPDATA: isolatedRoaming,
  KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
  KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
  KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
  KARKEDIKHA_DESKTOP_MODEL: model,
  HERMES_ENABLED: 'true',
};
delete env.ELECTRON_RUN_AS_NODE;

const report = {
  startedAt: new Date().toISOString(),
  prodInstaller: {
    path: prodSetupPath,
    sha256: fs.existsSync(prodSetupPath) ? sha256File(prodSetupPath) : null,
    bytes: fs.existsSync(prodSetupPath) ? fs.statSync(prodSetupPath).size : null,
  },
  smokeInstaller: {
    path: setupPath,
    sha256: fs.existsSync(setupPath) ? sha256File(setupPath) : null,
    bytes: fs.existsSync(setupPath) ? fs.statSync(setupPath).size : null,
  },
  scenarios: {},
};

function log(...args) {
  console.log('[approval-e2e]', ...args);
}

// -----------------------------------------------------------------------------
// Install Smoke
// -----------------------------------------------------------------------------
log('Installing Pandesh-Smoke-Setup.exe to:', installDir);
const instResult = spawnSync(setupPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${installDir}`], {
  env,
  windowsHide: true,
  stdio: 'inherit',
});
if (instResult.status !== 0) {
  throw new Error(`Installer failed with exit code ${instResult.status}`);
}

const exe = path.join(installDir, 'electron', 'Pandesh.exe');
const appDir = path.join(installDir, 'app');
if (!fs.existsSync(exe)) throw new Error(`Missing executable: ${exe}`);

let activeChild = null;
let ws = null;
let nextId = 1;
const pendingCdp = new Map();

function launchApp() {
  log('Launching Pandesh from:', exe, 'with CDP port:', cdpPort);
  activeChild = spawn(exe, [`--remote-debugging-port=${cdpPort}`, appDir], {
    cwd: installDir,
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: false,
  });
  activeChild.unref();
  return activeChild.pid;
}

async function closeCdp() {
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

async function killApp() {
  await closeCdp();
  stopSmokeProcesses(scratch);
  activeChild = null;
  await sleep(1500);
}

async function getCdp() {
  if (ws) return;
  const deadline = Date.now() + 60000;
  let page = null;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) ?? null;
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('Failed to find CDP page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const p = pendingCdp.get(msg.id);
    if (!p) return;
    pendingCdp.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
}

function cdp(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pendingCdp.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await cdp('Runtime.evaluate', {
    expression: `(async () => { return (${expression}); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`eval exception: ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res.result?.value;
}

async function captureScreenshot(fileName) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const outPath = path.join(screensDir, fileName);
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  log('Saved screenshot:', outPath);
  return outPath;
}

async function waitFor(label, fn, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

import { DatabaseSync } from 'node:sqlite';

function getCoreAuth() {
  const coreRecord = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
  const coreToken = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
  return { port: coreRecord.port, token: coreToken };
}

async function queryCore(apiPath) {
  const { port, token } = getCoreAuth();
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Core query failed: ' + res.status + ' ' + apiPath);
  return res.json();
}

async function getApprovalStatus(approvalId, convId) {
  try {
    if (convId) {
      const res = await queryCore(`/v1/capabilities/actions?correlationId=${encodeURIComponent(convId)}&clientId=desktop`);
      const match = (res?.actions ?? []).find((a) => a.approvalId === approvalId);
      if (match) return match;
    }
  } catch {}
  try {
    const dbPath = path.join(dataDir, 'core.db');
    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare('SELECT id, attemptId, status, resolution FROM approvals WHERE id = ?').get(approvalId);
      db.close();
      if (row) return row;
    }
  } catch {}
  return null;
}

async function getUiState() {
  return evaluate(`(() => {
    const s = window.lastSnapshot || {};
    const approval = document.getElementById('approval-panel');
    const heading = document.getElementById('approval-heading')?.textContent ?? '';
    const gate = document.getElementById('approval-gate')?.textContent ?? '';
    const tool = document.getElementById('approval-tool')?.textContent ?? '';
    const scope = document.getElementById('approval-scope')?.textContent ?? '';
    const detail = document.getElementById('approval-detail')?.textContent ?? '';
    const approve = document.getElementById('approve');
    const reject = document.getElementById('reject');
    const crossBanner = document.getElementById('cross-conversation-approval-banner');
    const taskCard = document.getElementById('workspace-task-card');
    const taskCardState = taskCard?.dataset.state ?? '';
    return {
      running: Boolean(s.running),
      attemptId: s.attemptId ?? null,
      task: s.task ?? null,
      activeConversationId: s.activeConversationId ?? null,
      selectedConversationId: s.selectedConversationId ?? null,
      awaitingApproval: Boolean(s.awaitingApproval),
      pendingApproval: s.pendingApproval ?? null,
      approvalPanelVisible: Boolean(approval && !approval.hidden && !approval.classList.contains('hidden')),
      approvalHeading: heading,
      approvalGate: gate,
      approvalTool: tool,
      approvalScope: scope,
      approvalDetail: detail,
      approveDisabled: approve?.disabled ?? null,
      rejectDisabled: reject?.disabled ?? null,
      crossBannerVisible: Boolean(crossBanner && !crossBanner.hidden),
      taskCardVisible: Boolean(taskCard && !taskCard.hidden),
      taskCardState: taskCardState,
    };
  })()`);
}

async function run() {
  const pid = launchApp();
  report.processPid = pid;

  await getCdp();
  log('CDP connected to installed Pandesh.');

  // Wait for Core connection
  await waitFor('Core connected', async () => {
    const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    return s?.coreState === 'connected' ? s : null;
  }, 150000);
  log('Core connected in installed app.');

  // Select model if available
  if (model) {
    await evaluate(`window.karkedikhaDesktop.selectModel(${JSON.stringify(model)})`);
    await sleep(800);
  }

  // =========================================================================
  // SCENARIO 1: Legitimate pending approval -> Approve in UI -> Real Result
  // =========================================================================
  log('\n=== Scenario 1: Legitimate Pending Approval -> Approve in UI ===');
  await evaluate("document.getElementById('conversations-new')?.click()");
  await sleep(1000);

  const prompt1 = 'Please remember this about me: my favorite programming language is TypeScript.';
  await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt1)}, 'local-core')`);
  log('Submitted prompt 1:', prompt1);

  // Wait for approval card to appear automatically
  const approvalState1 = await waitFor('Approval card in UI', async () => {
    const state = await getUiState();
    if (state.approvalPanelVisible && !state.approveDisabled) return state;
    return null;
  }, 180000);

  log('Approval card appeared! Tool:', approvalState1.approvalTool, 'Gate:', approvalState1.approvalGate);
  const shot1_1 = await captureScreenshot('scenario1-01-approval-card-displayed.png');

  const pendingApprovalRecord1 = approvalState1.pendingApproval;
  if (!pendingApprovalRecord1?.approvalId) {
    throw new Error('Missing pendingApproval.approvalId in snapshot');
  }
  const approvalId1 = pendingApprovalRecord1.approvalId;
  const convId1 = approvalState1.activeConversationId;

  log('Approving action via real UI click (#approve)...');
  await evaluate("document.getElementById('approve').click()");

  // Verify backend decision
  const approvalBackend1 = await waitFor('Backend decision to be recorded as approved', async () => {
    const app = await getApprovalStatus(approvalId1, convId1);
    return app?.status === 'approved' ? app : null;
  }, 20000);
  log('Backend approval decision verified:', approvalBackend1.resolution, approvalBackend1.status);

  // Wait for turn to finish
  const turnResult1 = await waitFor('Turn to complete', async () => {
    const state = await getUiState();
    if (!state.running && !state.approvalPanelVisible) return state;
    return null;
  }, 180000);
  log('Turn completed!');

  const targetAttemptId1 = approvalBackend1.attemptId || approvalState1.attemptId;

  // Verify tool invocation evidence
  const invocations1 = await queryCore(`/v1/attempts/${targetAttemptId1}/tool-invocations`);
  const toolInvs1 = invocations1.toolInvocations ?? [];
  const memoryInv1 = toolInvs1.find((i) => i.toolName.includes('memory') || i.toolName === 'memory_remember');
  log('Tool invocations found for attempt:', toolInvs1.map((i) => `${i.toolName}:${i.status}`));

  if (!memoryInv1 || memoryInv1.status !== 'succeeded') {
    throw new Error(`Tool execution missing or not succeeded: ${JSON.stringify(memoryInv1)}`);
  }
  log('Real tool execution confirmed! Output:', String(memoryInv1.evidence?.output || '').slice(0, 200));

  const shot1_2 = await captureScreenshot('scenario1-02-task-completed-with-result.png');

  report.scenarios.scenario1_approve = {
    status: 'PASS',
    prompt: prompt1,
    conversationId: convId1,
    attemptId: targetAttemptId1,
    approvalId: approvalId1,
    backendStatus: approvalBackend1.status,
    backendResolution: approvalBackend1.resolution,
    toolName: memoryInv1.toolName,
    toolStatus: memoryInv1.status,
    toolEvidence: String(memoryInv1.evidence?.output || '').slice(0, 300),
    screenshots: [shot1_1, shot1_2],
  };

  // =========================================================================
  // SCENARIO 2: Reject Flow
  // =========================================================================
  log('\n=== Scenario 2: Legitimate Pending Approval -> Reject in UI ===');
  await evaluate("document.getElementById('conversations-new')?.click()");
  await sleep(1000);

  const prompt2 = 'Please remember this about me: my nickname is Sparky.';
  await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt2)}, 'local-core')`);
  log('Submitted prompt 2:', prompt2);

  const approvalState2 = await waitFor('Approval card in UI for prompt 2', async () => {
    const state = await getUiState();
    if (state.approvalPanelVisible && !state.rejectDisabled) return state;
    return null;
  }, 180000);

  log('Approval card appeared for Reject scenario! Tool:', approvalState2.approvalTool);
  const shot2_1 = await captureScreenshot('scenario2-01-approval-card-reject.png');

  const approvalId2 = approvalState2.pendingApproval.approvalId;
  const convId2 = approvalState2.activeConversationId;

  log('Rejecting action via real UI click (#reject)...');
  await evaluate("document.getElementById('reject').click()");

  // Verify backend decision
  const approvalBackend2 = await waitFor('Backend decision to be recorded as rejected', async () => {
    const app = await getApprovalStatus(approvalId2, convId2);
    return app?.status === 'rejected' ? app : null;
  }, 20000);
  log('Backend rejection verified:', approvalBackend2.resolution, approvalBackend2.status);

  // Wait for turn to finish
  await waitFor('Turn to complete after rejection', async () => {
    const state = await getUiState();
    if (!state.running && !state.approvalPanelVisible) return state;
    return null;
  }, 180000);

  const targetAttemptId2 = approvalBackend2.attemptId;
  log('Target attempt ID for rejected approval:', targetAttemptId2);

  // Verify tool was NOT executed successfully for this attempt
  const invocations2 = await queryCore(`/v1/attempts/${targetAttemptId2}/tool-invocations`);
  const toolInvs2 = invocations2.toolInvocations ?? [];
  const executedSucceeded = toolInvs2.some((i) => i.status === 'succeeded' && i.toolName.includes('memory'));
  if (executedSucceeded) {
    throw new Error('Tool was executed despite rejection!');
  }
  log('Confirmed: No succeeded tool invocation for rejected approval.');

  const shot2_2 = await captureScreenshot('scenario2-02-approval-rejected-outcome.png');

  report.scenarios.scenario2_reject = {
    status: 'PASS',
    prompt: prompt2,
    conversationId: convId2,
    attemptId: targetAttemptId2,
    approvalId: approvalId2,
    backendStatus: approvalBackend2.status,
    backendResolution: approvalBackend2.resolution,
    toolExecuted: false,
    screenshots: [shot2_1, shot2_2],
  };

  // =========================================================================
  // SCENARIO 3: Restart while awaiting approval
  // =========================================================================
  log('\n=== Scenario 3: Restart while Awaiting Approval ===');
  await evaluate("document.getElementById('conversations-new')?.click()");
  await sleep(1000);

  const prompt3 = 'Please remember this about me: my timezone is Europe/Berlin.';
  await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt3)}, 'local-core')`);
  log('Submitted prompt 3:', prompt3);

  const approvalState3 = await waitFor('Approval card before restart', async () => {
    const state = await getUiState();
    if (state.approvalPanelVisible && !state.approveDisabled) return state;
    return null;
  }, 180000);

  const approvalId3 = approvalState3.pendingApproval.approvalId;
  const convId3 = approvalState3.activeConversationId;
  const appRecord3 = await getApprovalStatus(approvalId3, convId3);
  const targetAttemptId3 = appRecord3?.attemptId || approvalState3.attemptId;
  log('Awaiting approval before restart. approvalId:', approvalId3, 'attemptId:', targetAttemptId3);
  const shot3_1 = await captureScreenshot('scenario3-01-before-restart.png');

  log('Terminating Pandesh application cleanly to simulate app/system restart...');
  await killApp();

  log('Restarting Pandesh application against same user data directory...');
  const newPid = launchApp();
  report.restartedPid = newPid;

  await getCdp();
  log('CDP reconnected after restart.');

  await waitFor('Core reconnected after restart', async () => {
    const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    return s?.coreState === 'connected' ? s : null;
  }, 150000);

  log('Opening conversation after restart:', convId3);
  await evaluate(`openConversationFromRail(${JSON.stringify(convId3)})`);
  await sleep(2500);

  // Check state in Core
  const approvalAfterRestart = await getApprovalStatus(approvalId3, convId3);
  const actionsAfterRestart = await queryCore(`/v1/capabilities/actions?correlationId=${convId3}&clientId=desktop`);
  log('Core approval after restart status:', approvalAfterRestart?.status);

  const uiAfterRestart = await getUiState();
  log('UI after restart:', {
    running: uiAfterRestart.running,
    approvalPanelVisible: uiAfterRestart.approvalPanelVisible,
    awaitingApproval: uiAfterRestart.awaitingApproval,
    crossBannerVisible: uiAfterRestart.crossBannerVisible,
  });

  const shot3_2 = await captureScreenshot('scenario3-02-after-restart.png');

  if (approvalAfterRestart?.status !== 'expired' || uiAfterRestart.approvalPanelVisible
      || (actionsAfterRestart?.actions ?? []).some(a => a.actionable)) {
    throw new Error('Restart must expire dead-worker approval and hide its controls');
  }

  // Clean up approval from Scenario 3 so worker is free for Scenario 4
  log('Waiting for interrupted restart state to settle...');
  await waitFor('Turn after restart to settle', async () => {
    const s = await getUiState();
    return !s.running && !s.approvalPanelVisible ? s : null;
  }, 30000);

  report.scenarios.scenario3_restart = {
    status: 'PASS',
    prompt: prompt3,
    conversationId: convId3,
    attemptId: targetAttemptId3,
    approvalId: approvalId3,
    approvalStatusAfterRestart: approvalAfterRestart?.status,
    uiStateAfterRestart: uiAfterRestart,
    screenshots: [shot3_1, shot3_2],
  };

  // =========================================================================
  // SCENARIO 4: Cross-conversation navigation while awaiting approval
  // =========================================================================
  log('\n=== Scenario 4: Navigate Between Conversations While Awaiting Approval ===');
  await evaluate("document.getElementById('conversations-new')?.click()");
  await sleep(1500);

  const prompt4 = 'Please remember this about me: I am testing AI OS release verification.';
  await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt4)}, 'local-core')`);
  log('Submitted prompt 4:', prompt4);

  const approvalState4A = await waitFor('Approval card in Conv 4A', async () => {
    const state = await getUiState();
    if (state.approvalPanelVisible && !state.approveDisabled) return state;
    return null;
  }, 180000);

  const convId4A = approvalState4A.activeConversationId;
  const approvalId4 = approvalState4A.pendingApproval.approvalId;
  log('Approval present in Conv 4A:', convId4A);
  const shot4_1 = await captureScreenshot('scenario4-01-conv4A-approval.png');

  log('Switching to brand new conversation Conv 4B...');
  await evaluate("document.getElementById('conversations-new')?.click()");
  const timeline4 = [];
  for (let i = 0; i < 12; i += 1) {
    timeline4.push(await evaluate(`({ t: ${i * 250}, sel: window.lastSnapshot?.selectedConversationId ?? null, viewing: viewingConversationId, away: userNavigatedAway, panel: !document.getElementById('approval-panel').hidden, banner: !document.getElementById('cross-conversation-approval-banner').hidden })`));
    await sleep(250);
  }
  log('Conv 4B timeline:', JSON.stringify(timeline4));
  const stateConv4B = await getUiState();
  const diag4B = await evaluate(`({ viewing: viewingConversationId, userNavigatedAway, renderErr: document.getElementById('approval-render-error')?.hidden === false ? document.getElementById('approval-render-error').textContent : null })`);
  log('Conv 4B diagnostics:', JSON.stringify({ ...stateConv4B, pendingApproval: Boolean(stateConv4B.pendingApproval) }), JSON.stringify(diag4B));
  await captureScreenshot('scenario4-02a-conv4B-diagnostic.png');
  if (timeline4.slice(1).some(s => s.sel !== null || s.viewing !== null || s.panel || !s.banner)) throw new Error('New conversation did not stay empty during passive refresh');
  if (stateConv4B.approvalPanelVisible) throw new Error('Approval card leaked into a different conversation!');
  if (!stateConv4B.crossBannerVisible) throw new Error('Cross-conversation banner not shown while approval pending elsewhere');
  log('In Conv 4B. Approval panel visible?:', stateConv4B.approvalPanelVisible, 'Cross-conversation banner visible?:', stateConv4B.crossBannerVisible);

  const shot4_2 = await captureScreenshot('scenario4-02-conv4B-clean-scoped.png');

  log('Switching back to Conv 4A via Go to task...');
  await evaluate("document.getElementById('cross-approval-nav-btn').click()");
  await sleep(1500);

  const stateConv4ARestored = await waitFor('Approval card restored in Conv 4A', async () => {
    const state = await getUiState();
    if (state.approvalPanelVisible) return state;
    return null;
  }, 30000);

  if (stateConv4ARestored.selectedConversationId !== convId4A || stateConv4ARestored.pendingApproval?.approvalId !== approvalId4) throw new Error('Go to task restored the wrong task');
  log('Approval card restored in Conv 4A!');
  const shot4_3 = await captureScreenshot('scenario4-03-conv4A-restored.png');

  // Clean up approval so it doesn't linger
  await evaluate("document.getElementById('reject').click()");
  await waitFor('Scenario 4 turn to settle after reject', async () => {
    const s = await getUiState();
    return !s.running && !s.approvalPanelVisible ? s : null;
  }, 30000);

  report.scenarios.scenario4_navigation = {
    status: 'PASS',
    convId4A,
    convId4B: stateConv4B.selectedConversationId,
    timeline: timeline4,
    approvalId: approvalId4,
    scopedCorrectly: !stateConv4B.approvalPanelVisible && stateConv4B.crossBannerVisible,
    restoredCorrectly: stateConv4ARestored.approvalPanelVisible,
    screenshots: [shot4_1, shot4_2, shot4_3],
  };

  // =========================================================================
  // SCENARIO 5: Historical terminal-attempt approval verification
  // =========================================================================
  log('\n=== Scenario 5: Historical Terminal-Attempt Approval Verification ===');
  // Re-open Conv 1 (which completed in Scenario 1)
  await evaluate(`openConversationFromRail(${JSON.stringify(convId1)})`);
  await sleep(1500);

  const conv1Ui = await getUiState();
  log('Historical Conv 1 UI state:', {
    running: conv1Ui.running,
    approvalPanelVisible: conv1Ui.approvalPanelVisible,
    approveDisabled: conv1Ui.approveDisabled,
  });

  const actionsConv1 = await queryCore(`/v1/capabilities/actions?correlationId=${convId1}&clientId=desktop`);
  const actionableApprovalsConv1 = (actionsConv1?.actions ?? []).filter((a) => a.actionable);
  log('Actionable approvals count in terminal Conv 1:', actionableApprovalsConv1.length);

  if (actionableApprovalsConv1.length > 0) {
    throw new Error(`Terminal attempt still reports actionable approvals: ${JSON.stringify(actionableApprovalsConv1)}`);
  }
  if (conv1Ui.approvalPanelVisible) {
    throw new Error('Terminal attempt conversation still renders an active approval card!');
  }
  log('Historical terminal attempt verified: no actionable approvals or buttons offered.');
  const shot5_1 = await captureScreenshot('scenario5-01-historical-terminal-clean.png');

  report.scenarios.scenario5_historical_terminal = {
    status: 'PASS',
    conversationId: convId1,
    actionableApprovalsCount: actionableApprovalsConv1.length,
    approvalPanelVisible: conv1Ui.approvalPanelVisible,
    screenshots: [shot5_1],
  };

  // =========================================================================
  // SCENARIO 6: Weather Query Answers Without Approval
  // =========================================================================
  log('\n=== Scenario 6: Weather Query Answers Without Approval ===');
  await evaluate("document.getElementById('conversations-new')?.click()");
  await sleep(1000);

  const prompt6 = 'What is the current weather in Ulm, Germany?';
  await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt6)}, 'local-core')`);
  log('Submitted prompt 6:', prompt6);

  let approvalEverAppeared = false;
  const weatherTurnDone = await waitFor('Weather query to finish', async () => {
    const s = await getUiState();
    if (s.approvalPanelVisible || s.awaitingApproval) {
      approvalEverAppeared = true;
    }
    if (!s.running && s.task) {
      const conv = await evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(s.activeConversationId)})`);
      const lastMsg = (conv?.messages ?? []).slice(-1)[0];
      if (lastMsg?.role === 'assistant' && lastMsg.content.length > 15) {
        return { lastMsg: lastMsg.content, conversationId: s.activeConversationId, attemptId: s.attemptId };
      }
    }
    return null;
  }, 180000);

  log('Weather query finished! Reply:', weatherTurnDone.lastMsg.slice(0, 200));
  log('Did approval ever appear?:', approvalEverAppeared);

  if (approvalEverAppeared) {
    throw new Error('Approval appeared for read-only weather query!');
  }

  const weatherInvocations = await queryCore(`/v1/attempts/${weatherTurnDone.attemptId}/tool-invocations`);
  const weatherInvocation = (weatherInvocations.toolInvocations ?? []).find(i => i.toolName === 'get_weather' && i.status === 'succeeded');
  if (!weatherInvocation) throw new Error('Weather has no succeeded real get_weather invocation');
  const weatherActions = await queryCore(`/v1/capabilities/actions?correlationId=${weatherTurnDone.conversationId}&clientId=desktop`);
  if ((weatherActions.actions ?? []).some(a => a.approvalId)) throw new Error('Read-only weather created an approval');
  const shot6_1 = await captureScreenshot('scenario6-01-weather-answers-without-approval.png');

  report.scenarios.scenario6_weather_no_approval = {
    status: 'PASS',
    prompt: prompt6,
    conversationId: weatherTurnDone.conversationId,
    toolEvidence: weatherInvocation,
    approvalEverAppeared,
    reply: weatherTurnDone.lastMsg.slice(0, 300),
    screenshots: [shot6_1],
  };

  log('\nAll 6 verification scenarios PASSED successfully!');
}

let errFailure = null;
try {
  await run();
} catch (err) {
  errFailure = err;
  log('ERROR during verification:', err);
  report.error = err.message;
} finally {
  try { await killApp(); uninstallSmoke(scratch, env); report.cleanup = 'PASS'; }
  catch (error) { errFailure ??= error; report.cleanup = error.message; }
  report.finishedAt = new Date().toISOString();
  report.allPassed = !errFailure && Object.keys(report.scenarios).length === 6 && Object.values(report.scenarios).every((s) => s.status === 'PASS');
  fs.writeFileSync(path.join(evidenceDir, 'verification-report.json'), JSON.stringify(report, null, 2) + '\n');
  log('Verification report written to:', path.join(evidenceDir, 'verification-report.json'));

  // Cleanup failures remain visible in the report; preserve scratch for diagnosis.
}

if (errFailure) {
  process.exit(1);
} else {
  process.exit(0);
}
