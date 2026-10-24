#!/usr/bin/env node
// npm run test:dogfood:approval-cycle
//
// The authoritative end-to-end acceptance gate for the webview approval-card
// reconciliation logic (proposal -> mutation -> delivery gate handoff). This
// replaces the previous jsdom-only regression as the authoritative check:
// it packages the REAL production VSIX, launches it in an isolated,
// disposable VS Code Extension Development Host, opens the REAL KarkeDikha
// WebviewView (media/chat.html + every real media/*.js file it loads, in
// chat.html's own load order — no rewritten stand-ins), seeds/restores a
// durable autonomous task through waiting_for_proposal_approval ->
// waiting_for_mutation_approval -> waiting_for_delivery_approval using the
// real on-disk task schema and the real AgentPanel poll loop, and inspects
// the actual rendered DOM over the Chrome DevTools Protocol — connected
// directly to the webview's own CDP target (see uiDriver.mjs
// connectToWebviewHost). It then relaunches a second, fresh Extension Host
// against the same disposable workspace (task state already on disk) to
// prove the reconciliation survives a real webview reload, not just a
// simulated one.
//
// Exits non-zero on any failure and always cleans up every temporary
// directory and VS Code process it created.

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runTests } from '@vscode/test-electron';
import * as uiDriver from './uiDriver.mjs';
import { resolveVSCode, allocateDebugPort, spawnKillableExtensionHost, terminatePlainHost } from './plainVsCodeHost.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-webview-approval-dogfood-${runStamp}`);
const extractDir = path.join(workDir, 'extracted-vsix');
const workspaceDir = path.join(workDir, 'workspace');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'webview-approval-dogfood');

function log(message) {
  console.log(`[webview-approval-dogfood] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, windowsHide: true, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function extractVsix(vsixPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const tarBinary = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tarBinary, ['-xf', vsixPath, '-C', destination], { stdio: 'inherit' });
}

function readStatusFile(statusFile) {
  if (!fs.existsSync(statusFile)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    return undefined;
  }
}

async function pollUntil(conditionFn, { timeoutMs = 60000, intervalMs = 300, describe }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = conditionFn();
    if (last && last.done) return last.value;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe?.() ?? 'condition'}; last=${JSON.stringify(last?.value)}`);
}

async function waitForCompanionPhase(statusFile, phase, timeoutMs = 30000) {
  return pollUntil(
    () => {
      const status = readStatusFile(statusFile);
      const match = status?.events?.find(e => e.phase === phase);
      return match ? { done: true, value: match } : { done: false, value: status?.phase };
    },
    { timeoutMs, describe: () => `webviewApprovalDogfoodHost status file to reach phase "${phase}"` },
  );
}

/**
 * Asserts every DOM signal the reconciliation logic must produce once the
 * seeded/restored task has settled at waiting_for_delivery_approval:
 * proposal and mutation controls not actionable, delivery controls enabled,
 * the "waiting for delivery approval" status visible, and the idle "Ready
 * when you are." label gone.
 *
 * "Not actionable" for the proposal/mutation gates covers both real
 * scenarios the production reconciliation logic (chat-autonomous.js
 * reconcileApprovalGates) produces, matching the same two cases the jsdom
 * regression (webviewApprovalReconciliation.test.ts) already covers:
 *   - the card was surfaced THIS session (proposal/mutation approval
 *     requests arrived before the task reached delivery) -> the card stays
 *     visible but every control is force-disabled ("Historical —
 *     superseded").
 *   - the card was never surfaced this session (e.g. a fresh reload whose
 *     webview never received the proposal/mutation approval-request
 *     messages because the task had already moved past those gates) -> the
 *     card is simply never un-hidden, so its controls are never touched and
 *     stay at their pristine (non-disabled) default — which is exactly as
 *     inert to the user as a disabled one, since the card is not visible.
 */
function assertFinalDom(dom, label) {
  const failures = [];
  const expect = (actual, expected, name) => {
    if (actual !== expected) failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const expectNotActionable = (disabled, cardHidden, name) => {
    if (disabled !== true && cardHidden !== true) {
      failures.push(`${name}: expected disabled=true OR its card hidden=true (not actionable), got disabled=${JSON.stringify(disabled)} cardHidden=${JSON.stringify(cardHidden)}`);
    }
  };
  expectNotActionable(dom.proposalApproveDisabled, dom.proposalCardHidden, 'proposal-approve-btn');
  expectNotActionable(dom.proposalReviseDisabled, dom.proposalCardHidden, 'proposal-revise-btn');
  expectNotActionable(dom.proposalRejectDisabled, dom.proposalCardHidden, 'proposal-reject-btn');
  expectNotActionable(dom.proposalRevisionTextDisabled, dom.proposalCardHidden, 'proposal-revision-text');
  expectNotActionable(dom.mutationApproveDisabled, dom.mutationCardHidden, 'mutation-approve-btn');
  expectNotActionable(dom.mutationDenyDisabled, dom.mutationCardHidden, 'mutation-deny-btn');
  expect(dom.deliveryCardHidden, false, 'delivery-approval-card.hidden');
  expect(dom.deliveryReviewDisabled, false, 'delivery-review-btn.disabled');
  expect(dom.deliveryApproveDisabled, false, 'delivery-approve-btn.disabled');
  expect(dom.deliveryRejectDisabled, false, 'delivery-reject-btn.disabled');
  if (dom.pandaLabelText === 'Ready when you are.') failures.push(`pandaLabelText: "Ready when you are." must be absent, got ${JSON.stringify(dom.pandaLabelText)}`);
  if (!/wait/i.test(String(dom.pandaLabelText))) failures.push(`pandaLabelText: expected "Waiting for delivery approval"-shaped text, got ${JSON.stringify(dom.pandaLabelText)}`);
  if (failures.length > 0) {
    throw new Error(`[${label}] real webview DOM assertions failed:\n  - ${failures.join('\n  - ')}\nfull DOM snapshot: ${JSON.stringify(dom, null, 2)}`);
  }
  log(`[${label}] PASSED — proposal disabled, mutation disabled, delivery enabled, status="${dom.pandaLabelText}".`);
}

/**
 * Runs one Extension Development Host session (seed or reload) against the
 * real packaged VSIX, drives it via CDP connected directly to the real
 * KarkeDikha webview, and asserts the final reconciled DOM state.
 */
async function runHostSession({ mode, extensionDevelopmentPath, userDataDir, extensionsDir }) {
  const remoteDebuggingPort = allocateDebugPort();
  const scenarioEvidenceDir = path.join(evidenceDir, mode);
  fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
  const statusFile = path.join(scenarioEvidenceDir, 'host-status.json');
  const doneFlagFile = path.join(scenarioEvidenceDir, 'driver-done.flag');
  fs.rmSync(statusFile, { force: true });
  fs.rmSync(doneFlagFile, { force: true });

  const testsPromise = runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.join(__dirname, 'webviewApprovalDogfoodHost.js'),
    launchArgs: [
      workspaceDir,
      '--disable-workspace-trust',
      '--disable-updates',
      '--disable-telemetry',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir', userDataDir,
      '--extensions-dir', extensionsDir,
      `--remote-debugging-port=${remoteDebuggingPort}`,
    ],
    extensionTestsEnv: {
      ...process.env,
      OA_WEBVIEW_DOGFOOD_MODE: mode,
      OA_WEBVIEW_DOGFOOD_STATUS: statusFile,
      OA_WEBVIEW_DOGFOOD_DONE_FLAG: doneFlagFile,
    },
  });

  const driverPromise = (async () => {
    try {
      await waitForCompanionPhase(statusFile, 'activated', 30000);
      log(`[${mode}] production extension activated in a real Extension Development Host.`);
      await waitForCompanionPhase(statusFile, 'focused', 30000);
      log(`[${mode}] real KarkeDikha WebviewView focused (real ollama-agent.focus command).`);

      const client = await uiDriver.connectToWebviewHost(remoteDebuggingPort);
      try {
        await uiDriver.waitForWebviewContentMounted(client);
        log(`[${mode}] connected directly to the real webview CDP target; media/chat.html + every real media/*.js file has mounted.`);
        await uiDriver.clickAutonomousModeButton(client);

        await waitForCompanionPhase(statusFile, 'ready_for_assertions', 45000);
        log(`[${mode}] host signalled ready_for_assertions; reading the real rendered DOM.`);

        const dom = await uiDriver.readApprovalCycleDom(client);
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'dom-snapshot.json'), JSON.stringify(dom, null, 2));
        assertFinalDom(dom, mode);
      } finally {
        try {
          await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'final-state');
        } catch {
          // best-effort evidence capture only
        }
        await client.close();
      }
    } finally {
      // Always signal the host to stop parking, whether assertions passed or
      // threw, so the Extension Host process (and its window) exits promptly
      // instead of idling out its own internal timeout.
      fs.mkdirSync(path.dirname(doneFlagFile), { recursive: true });
      fs.writeFileSync(doneFlagFile, '1');
    }
  })();

  await Promise.all([testsPromise, driverPromise]);
}

function readTaskJson(workspaceDirPath, taskId) {
  const file = path.join(workspaceDirPath, '.ollama-agent', 'autonomous-tasks', taskId, 'task.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readTaskEvents(workspaceDirPath, taskId) {
  const file = path.join(workspaceDirPath, '.ollama-agent', 'autonomous-tasks', taskId, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/** Read-modify-write patch of a durable task record on disk (same fs-level
 * technique webviewApprovalDogfoodHost.js writeTaskState uses). */
function patchTaskJson(workspaceDirPath, taskId, patch) {
  const file = path.join(workspaceDirPath, '.ollama-agent', 'autonomous-tasks', taskId, 'task.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2));
}

/** Makes a disposable workspace a real Git repository so the restart-recovery
 * continuation can run the genuine post-approval pipeline (drain re-claim ->
 * preparing -> isolated worktree bind) instead of failing at the first Git
 * call. Mirrors the vitest suite's initGit helper. */
function gitInit(dir) {
  fs.writeFileSync(path.join(dir, '.gitignore'), '.ollama-agent/\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'dogfood@example.invalid'],
    ['config', 'user.name', 'Approval Dogfood'],
    ['add', '.'],
    ['commit', '-m', 'init'],
  ]) {
    run('git', args, { cwd: dir });
  }
}

/**
 * Scenario A / B — restart recovery for the proposal and mutation approval
 * gates. Seeds a task to the given waiting_for_*_approval state in a real
 * Extension Host, forcibly kills that Extension Host process tree WITHOUT
 * clicking anything (proving AutonomousTaskRuntime.dispose()/teardown never
 * fabricates a user rejection/denial), relaunches a genuinely fresh
 * Extension Host against the same on-disk task, and drives a real CDP click
 * on the restored Approve button to prove the runtime re-armed a real,
 * working gate (rearmPendingGates()) rather than merely re-rendering a dead
 * card.
 */
async function runRestartRecoveryScenario({ gate, extensionDevelopmentPath, resolvedVSCode, label }) {
  const scenarioEvidenceDir = path.join(evidenceDir, `restart-${gate}`);
  fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
  const scenarioWorkspaceDir = path.join(workDir, `restart-${gate}-workspace`);
  fs.mkdirSync(scenarioWorkspaceDir, { recursive: true });
  fs.writeFileSync(path.join(scenarioWorkspaceDir, 'README.md'), `# Disposable ${gate} restart-recovery dogfood workspace\n`);
  gitInit(scenarioWorkspaceDir);
  const userDataDir = path.join(workDir, `restart-${gate}-user-data`);
  const extensionsDir = path.join(workDir, `restart-${gate}-extensions`);
  const taskId = `m15_restart_${gate}_${Date.now().toString(36)}`;

  // --- Session 1: seed to the gate, kill without clicking anything ---
  const killStatusFile = path.join(scenarioEvidenceDir, 'kill-session-status.json');
  const killDoneFlag = path.join(scenarioEvidenceDir, 'kill-session-done.flag');
  fs.rmSync(killStatusFile, { force: true });
  fs.rmSync(killDoneFlag, { force: true });
  const killPort = allocateDebugPort();

  const seedMode = gate === 'proposal' ? 'seed-to-proposal' : 'seed-to-mutation';
  const child = spawnKillableExtensionHost(resolvedVSCode.vscodeExecutablePath, {
    extensionDevelopmentPath,
    extensionTestsPath: path.join(__dirname, 'restartApprovalDogfoodHost.js'),
    userDataDir,
    extensionsDir,
    workspacePath: scenarioWorkspaceDir,
    remoteDebuggingPort: killPort,
    env: {
      OA_RESTART_DOGFOOD_MODE: seedMode,
      OA_RESTART_DOGFOOD_STATUS: killStatusFile,
      OA_RESTART_DOGFOOD_DONE_FLAG: killDoneFlag,
      OA_RESTART_DOGFOOD_TASK_ID: taskId,
    },
  });

  await waitForCompanionPhase(killStatusFile, 'ready_for_kill', 45000);
  log(`[${label}] seeded task ${taskId} to waiting_for_${gate}_approval in a real Extension Host; terminating it WITHOUT clicking anything.`);

  // Terminate the Extension Host WITHOUT clicking anything in the UI. This
  // must go through the real "close the window" path (window.close() on the
  // main workbench renderer, over CDP — not a synthetic message to the
  // extension) so VS Code runs its real, ordinary extension-deactivation
  // sequence, which is what actually invokes AutonomousTaskRuntime.dispose()
  // (registered via context.subscriptions.push(runtime) in
  // M15AutonomousCommands.ts) — exactly the "runtime teardown" this fix
  // targets. A raw taskkill would skip that sequence entirely and prove
  // nothing about dispose()'s behavior, so it is only the fallback below if
  // the graceful close does not exit in time.
  try {
    const mainPageClient = await uiDriver.connect(killPort, { attempts: 10, delayMs: 300 });
    await mainPageClient.Runtime.evaluate({ expression: 'window.close()' });
    await mainPageClient.close();
  } catch (error) {
    log(`[${label}] graceful window.close() over CDP failed (${error.message}); falling back to process-tree kill.`);
  }
  await new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 8000);
  });
  if (child.exitCode === null && !child.killed) {
    log(`[${label}] Extension Host did not exit from the graceful close within the timeout; force-terminating the process tree as cleanup.`);
    terminatePlainHost(child);
  }

  const taskAfterKill = readTaskJson(scenarioWorkspaceDir, taskId);
  if (taskAfterKill.state !== `waiting_for_${gate}_approval`) {
    throw new Error(`[${label}] task state after kill was "${taskAfterKill.state}", expected it to remain "waiting_for_${gate}_approval" (task must not be cancelled by teardown)`);
  }
  const eventsAfterKill = readTaskEvents(scenarioWorkspaceDir, taskId);
  const fabricatedUserOutcome = eventsAfterKill.some(event => {
    const progress = String(event.payload?.progress ?? '');
    return progress.includes('actor=user') && (progress.includes('rejected') || progress.includes('denied')) && progress.includes(`gate=${gate}`);
  });
  if (fabricatedUserOutcome) {
    throw new Error(`[${label}] found a fabricated actor=user rejection/denial recorded for gate=${gate} after a forced Extension Host kill — teardown must never synthesize a user decision`);
  }
  log(`[${label}] confirmed: no actor=user rejection/denial was fabricated, and the task was not cancelled by the forced kill.`);

  // --- Session 2: fresh Extension Host against the SAME on-disk task ---
  const restorePort = allocateDebugPort();
  const restoreStatusFile = path.join(scenarioEvidenceDir, 'restore-session-status.json');
  const restoreDoneFlag = path.join(scenarioEvidenceDir, 'restore-session-done.flag');
  fs.rmSync(restoreStatusFile, { force: true });
  fs.rmSync(restoreDoneFlag, { force: true });

  const testsPromise = runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.join(__dirname, 'restartApprovalDogfoodHost.js'),
    launchArgs: [
      scenarioWorkspaceDir,
      '--disable-workspace-trust',
      '--disable-updates',
      '--disable-telemetry',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir', userDataDir,
      '--extensions-dir', extensionsDir,
      `--remote-debugging-port=${restorePort}`,
    ],
    extensionTestsEnv: {
      ...process.env,
      OA_RESTART_DOGFOOD_MODE: 'restore',
      OA_RESTART_DOGFOOD_STATUS: restoreStatusFile,
      OA_RESTART_DOGFOOD_DONE_FLAG: restoreDoneFlag,
    },
  });

  const driverPromise = (async () => {
    let client;
    try {
      await waitForCompanionPhase(restoreStatusFile, 'ready_for_assertions', 45000);
      log(`[${label}] fresh Extension Host relaunched against the same on-disk task; connecting to the real webview.`);
      client = await uiDriver.connectToWebviewHost(restorePort);
      await uiDriver.waitForWebviewContentMounted(client);
      await uiDriver.clickAutonomousModeButton(client);
      await new Promise(r => setTimeout(r, 500));

      const dom = await uiDriver.readApprovalCycleDom(client);
      fs.writeFileSync(path.join(scenarioEvidenceDir, 'restored-dom-snapshot.json'), JSON.stringify(dom, null, 2));
      // Exactly one authoritative gate may be actionable in the restored DOM,
      // and the idle "Ready when you are." footer must be absent while the
      // restored task is non-terminal.
      const restoredFailures = [];
      const expectNotActionable = (disabled, cardHidden, name) => {
        if (disabled !== true && cardHidden !== true) {
          restoredFailures.push(`${name}: expected disabled=true OR its card hidden=true, got disabled=${JSON.stringify(disabled)} cardHidden=${JSON.stringify(cardHidden)}`);
        }
      };
      if (gate === 'proposal') {
        if (dom.proposalCardHidden !== false) restoredFailures.push('restored proposal card is hidden — restart recovery did not re-surface the real card');
        if (dom.proposalApproveDisabled !== false) restoredFailures.push('restored proposal-approve-btn is disabled — gate was not re-armed as actionable');
        expectNotActionable(dom.mutationApproveDisabled, dom.mutationCardHidden, 'mutation-approve-btn');
        expectNotActionable(dom.deliveryApproveDisabled, dom.deliveryCardHidden, 'delivery-approve-btn');
      } else {
        if (dom.mutationCardHidden !== false) restoredFailures.push('restored mutation card is hidden — restart recovery did not re-surface the real card');
        if (dom.mutationApproveDisabled !== false) restoredFailures.push('restored mutation-approve-btn is disabled — gate was not re-armed as actionable');
        expectNotActionable(dom.proposalApproveDisabled, dom.proposalCardHidden, 'proposal-approve-btn');
        expectNotActionable(dom.deliveryApproveDisabled, dom.deliveryCardHidden, 'delivery-approve-btn');
      }
      if (dom.pandaLabelText === 'Ready when you are.') {
        restoredFailures.push(`status footer shows the idle "Ready when you are." label while the restored task is waiting for ${gate} approval`);
      }
      if (restoredFailures.length > 0) {
        throw new Error(`[${label}] restored-DOM assertions failed:\n  - ${restoredFailures.join('\n  - ')}\nfull DOM snapshot: ${JSON.stringify(dom, null, 2)}`);
      }
      if (gate === 'proposal') {
        await uiDriver.clickProposalApproveButton(client);
      } else {
        await uiDriver.clickMutationApproveButton(client);
      }
      log(`[${label}] restored DOM verified (exactly one actionable gate, no idle footer); clicked the real, restored Approve button via CDP.`);

      // The original in-flight governed run died with the killed Extension
      // Host, so the restored gate's continuation (completeProposalGate /
      // completeMutationGate) requeues the task for a fresh drain-claimable
      // run after recording the genuine actor=user decision against the exact
      // restored proposalId/requestId and clearing the pending field. Three
      // things are asserted, in order: (1) the task leaves the exact
      // waiting_for_<gate>_approval state, (2) the pending field is cleared,
      // (3) the SAME runtime's drain loop genuinely re-claims the requeued
      // task (a real task_claimed event after the approval) — i.e. the
      // restored control continued execution rather than parking the record
      // in a state no drain loop can ever pick up. Pre-fix, assertion (1)
      // already fails: with an empty in-memory gate map after restart, the
      // click's resolveProposalGate/resolveMutationGate call throws
      // "stale_or_unknown_*_approval" and the task is stuck waiting forever.
      const waitingState = `waiting_for_${gate}_approval`;
      const deadline = Date.now() + 20000;
      let finalTask = readTaskJson(scenarioWorkspaceDir, taskId);
      while (finalTask.state === waitingState && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 300));
        finalTask = readTaskJson(scenarioWorkspaceDir, taskId);
      }
      if (finalTask.state === waitingState) {
        throw new Error(`[${label}] task did not progress past the ${gate} gate after the real CDP-driven approval click; still stuck at "${finalTask.state}" (gate was not re-armed as a working, resolvable Promise)`);
      }
      const pendingFieldStillSet = gate === 'proposal' ? finalTask.pendingProposal : finalTask.pendingMutationApproval;
      if (pendingFieldStillSet) {
        throw new Error(`[${label}] task left ${waitingState} but its pending${gate === 'proposal' ? 'Proposal' : 'MutationApproval'} field was never cleared`);
      }
      const events = readTaskEvents(scenarioWorkspaceDir, taskId);
      const approvalEvent = events.find(event => {
        const progress = String(event.payload?.progress ?? '');
        return progress.includes(`gate=${gate}`) && progress.includes('actor=user') && progress.includes('approved');
      });
      if (!approvalEvent) {
        throw new Error(`[${label}] no actor=user approved event was recorded for gate=${gate} after the real CDP click`);
      }
      const claimDeadline = Date.now() + 20000;
      let claimedAfterApproval = false;
      while (!claimedAfterApproval && Date.now() < claimDeadline) {
        claimedAfterApproval = readTaskEvents(scenarioWorkspaceDir, taskId)
          .some(event => event.type === 'task_claimed' && event.seq > approvalEvent.seq);
        if (!claimedAfterApproval) await new Promise(r => setTimeout(r, 300));
      }
      if (!claimedAfterApproval) {
        throw new Error(`[${label}] the requeued task was never re-claimed by the drain loop after the restored ${gate} approval — restored controls did not actually continue execution`);
      }
      log(`[${label}] PASSED — task genuinely progressed past ${waitingState} (now "${finalTask.state}") via a real, restart-recovered, CDP-clicked approval bound to the exact restored ${gate === 'proposal' ? 'proposalId' : 'requestId'}, and the drain loop re-claimed the requeued task (execution continued).`);
    } finally {
      if (client) {
        try {
          await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'restore-final-state');
        } catch {
          // best-effort
        }
        await client.close();
      }
      fs.mkdirSync(path.dirname(restoreDoneFlag), { recursive: true });
      fs.writeFileSync(restoreDoneFlag, '1');
    }
  })();

  await Promise.all([testsPromise, driverPromise]);
}

/**
 * Scenario C — cross-task stale-card isolation, reproducing the exact
 * real-device defect shape: Task A is walked through proposal -> mutation ->
 * delivery inside ONE webview session (the existing "seed" host mode), so all
 * three approval cards exist in the DOM simultaneously — the screenshot that
 * motivated this fix showed exactly that state with multiple gates left
 * actionable and a "Ready" footer. Task A is then resolved to a terminal
 * state and a new Task B is seeded as the only non-terminal task (mirroring
 * the real production sequence: a prior task finishes/cancels and a new one
 * starts), and the real production reconnectAutonomousTask() path is forced
 * to run again within the SAME webview session via the real
 * webviewModeChanged message a mode-button toggle produces — no synthetic
 * messages posted. Asserts, from the real DOM over CDP:
 *   - Task A's stale proposal/mutation cards are hidden, cleared of Task A's
 *     binding, and inert (probe clicks emit ZERO outbound gate/task messages,
 *     observed by instrumenting the real vscode.postMessage at runtime);
 *   - exactly one authoritative gate (Task B's delivery) is actionable and a
 *     real click on it emits exactly one message bound to Task B, which the
 *     extension host processes end-to-end (Task B -> committing on disk);
 *   - the idle "Ready when you are." footer is absent throughout.
 */
async function runCrossTaskIsolationScenario({ extensionDevelopmentPath }) {
  const scenarioEvidenceDir = path.join(evidenceDir, 'cross-task-isolation');
  fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
  const scenarioWorkspaceDir = path.join(workDir, 'cross-task-workspace');
  fs.mkdirSync(scenarioWorkspaceDir, { recursive: true });
  fs.writeFileSync(path.join(scenarioWorkspaceDir, 'README.md'), '# Disposable cross-task isolation dogfood workspace\n');

  const statusFile = path.join(scenarioEvidenceDir, 'host-status.json');
  const doneFlagFile = path.join(scenarioEvidenceDir, 'driver-done.flag');
  fs.rmSync(statusFile, { force: true });
  fs.rmSync(doneFlagFile, { force: true });
  const port = allocateDebugPort();

  const taskIdB = `m15_crosstask_b_${Date.now().toString(36)}`;
  // Every message type an approval-gate or task control can emit; the
  // instrumented outbound log is filtered to these so unrelated event-driven
  // webview traffic (e.g. getOperationsSnapshot refreshes) cannot mask or
  // pollute the gate assertions.
  const GATE_MESSAGE_TYPES = new Set([
    'approveProposal', 'rejectProposal', 'requestProposalRevision',
    'approveMutation', 'denyMutation',
    'approveAutonomousDelivery', 'rejectAutonomousDelivery', 'reviewAutonomousChanges',
    'startAutonomousTask',
  ]);

  function taskDir(taskId) {
    return path.join(scenarioWorkspaceDir, '.ollama-agent', 'autonomous-tasks', taskId);
  }
  function writeTask(taskId, state, extra = {}) {
    const repositoryId = 'dogfood-repo';
    const task = {
      schemaVersion: 1,
      taskId,
      attemptId: `attempt_${taskId}`,
      origin: 'local-request',
      taskKind: 'mutating',
      repositoryRoot: scenarioWorkspaceDir,
      repositoryId,
      goal: `cross-task isolation dogfood ${taskId}`,
      instructions: `cross-task isolation dogfood ${taskId}`,
      priority: 'normal',
      createdAt: new Date().toISOString(),
      state,
      attempt: 1,
      maxRetries: 2,
      providerModelRoutingSnapshot: { provider: 'configured', model: 'configured' },
      permissionProfile: 'normal',
      validationRequirements: [],
      deliveryPolicy: {
        requireApprovalBeforeCommit: true,
        requireApprovalBeforePullRequest: true,
        createDraftPullRequest: true,
        monitorCi: true,
        allowPrComments: false,
        retainSuccessfulWorktree: false,
      },
      notificationPolicy: { enabled: true, persisted: true },
      githubDelivery: { transport: 'fake' },
      followUps: [],
      evidence: [],
      ...extra,
    };
    fs.mkdirSync(taskDir(taskId), { recursive: true });
    fs.writeFileSync(path.join(taskDir(taskId), 'task.json'), JSON.stringify(task, null, 2));
    return task;
  }

  const testsPromise = runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.join(__dirname, 'webviewApprovalDogfoodHost.js'),
    launchArgs: [
      scenarioWorkspaceDir,
      '--disable-workspace-trust',
      '--disable-updates',
      '--disable-telemetry',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir', path.join(workDir, 'cross-task-user-data'),
      '--extensions-dir', path.join(workDir, 'cross-task-extensions'),
      `--remote-debugging-port=${port}`,
    ],
    extensionTestsEnv: {
      ...process.env,
      // "seed" mode creates its own Task A and walks it through
      // waiting_for_proposal_approval -> waiting_for_mutation_approval ->
      // waiting_for_delivery_approval via the real AgentPanel poll loop, so
      // all three approval cards genuinely surface in this one webview
      // session — the exact precondition of the real-device screenshot
      // defect this scenario protects against. Task A's id is read back from
      // the host's status file.
      OA_WEBVIEW_DOGFOOD_MODE: 'seed',
      OA_WEBVIEW_DOGFOOD_STATUS: statusFile,
      OA_WEBVIEW_DOGFOOD_DONE_FLAG: doneFlagFile,
    },
  });

  const driverPromise = (async () => {
    let client;
    try {
      await waitForCompanionPhase(statusFile, 'focused', 60000);
      client = await uiDriver.connectToWebviewHost(port);
      await uiDriver.waitForWebviewContentMounted(client);
      await uiDriver.clickAutonomousModeButton(client);
      await waitForCompanionPhase(statusFile, 'ready_for_assertions', 60000);
      const taskIdA = readStatusFile(statusFile)?.taskId;
      if (!taskIdA) throw new Error('[cross-task-isolation] seed host never recorded Task A\'s id in the status file');

      // Precondition = the real-device screenshot shape, correctly reconciled:
      // all three cards exist in this one session, exactly one (delivery)
      // actionable, proposal/mutation force-disabled historical.
      const beforeSwitch = await uiDriver.readCardOwnership(client);
      fs.writeFileSync(path.join(scenarioEvidenceDir, 'before-switch-dom.json'), JSON.stringify(beforeSwitch, null, 2));
      const preFailures = [];
      if (beforeSwitch.deliveryCardTaskId !== taskIdA) preFailures.push(`delivery card bound to ${JSON.stringify(beforeSwitch.deliveryCardTaskId)}, expected Task A ("${taskIdA}")`);
      if (beforeSwitch.deliveryCardHidden !== false) preFailures.push('Task A delivery card should be visible');
      if (beforeSwitch.deliveryApproveDisabled !== false) preFailures.push('Task A delivery-approve-btn should be enabled');
      if (beforeSwitch.proposalCardHidden !== false) preFailures.push('Task A proposal card should still be visible as historical');
      if (beforeSwitch.proposalApproveDisabled !== true) preFailures.push('Task A historical proposal-approve-btn should be force-disabled');
      if (beforeSwitch.mutationCardHidden !== false) preFailures.push('Task A mutation card should still be visible as historical');
      if (beforeSwitch.mutationApproveDisabled !== true) preFailures.push('Task A historical mutation-approve-btn should be force-disabled');
      if (preFailures.length > 0) {
        throw new Error(`[cross-task-isolation] Task A three-card precondition failed:\n  - ${preFailures.join('\n  - ')}\nDOM: ${JSON.stringify(beforeSwitch, null, 2)}`);
      }
      log('[cross-task-isolation] Task A precondition verified: three cards present, only delivery actionable.');

      // Mirror the real production sequence: Task A resolves to a terminal
      // state, a new Task B starts as the only non-terminal task.
      patchTaskJson(scenarioWorkspaceDir, taskIdA, { state: 'cancelled', terminalResult: { status: 'cancelled', summary: 'dogfood: superseded by Task B' } });
      writeTask(taskIdB, 'waiting_for_delivery_approval');

      // Force the real production reconnectAutonomousTask() path to run again
      // within this SAME webview session via the real webviewModeChanged
      // message a mode-button toggle produces (chat-sidebar-ui.js posts
      // `{type:'webviewModeChanged', mode}` on every mode-button click; the
      // extension host's onDidReceiveMessage re-runs reconnectAutonomousTask()
      // whenever mode === 'autonomous' — see AgentPanel.ts). No synthetic
      // message is posted directly; only real button clicks.
      await uiDriver.clickModeButton(client, 'chat');
      await new Promise(r => setTimeout(r, 300));
      await uiDriver.clickModeButton(client, 'autonomous');

      // reconnectAutonomousTask() posts autonomousTaskActive for Task B (which
      // clears Task A's stale cards), and the next poll cycle (<=2s) surfaces
      // Task B's own delivery card as the one actionable gate.
      const deadline = Date.now() + 20000;
      let afterSwitch = await uiDriver.readCardOwnership(client);
      while (
        (afterSwitch.deliveryCardTaskId !== taskIdB || afterSwitch.deliveryCardHidden !== false || afterSwitch.deliveryApproveDisabled !== false) &&
        Date.now() < deadline
      ) {
        await new Promise(r => setTimeout(r, 300));
        afterSwitch = await uiDriver.readCardOwnership(client);
      }
      const fullDom = await uiDriver.readApprovalCycleDom(client);
      fs.writeFileSync(path.join(scenarioEvidenceDir, 'after-switch-dom.json'), JSON.stringify({ afterSwitch, fullDom }, null, 2));

      const failures = [];
      if (afterSwitch.deliveryCardTaskId !== taskIdB) failures.push(`deliveryCardTaskId: expected Task B ("${taskIdB}"), got ${JSON.stringify(afterSwitch.deliveryCardTaskId)}`);
      if (afterSwitch.deliveryCardHidden !== false) failures.push(`Task B's delivery card should be visible, hidden=${JSON.stringify(afterSwitch.deliveryCardHidden)}`);
      if (afterSwitch.deliveryApproveDisabled !== false) failures.push(`Task B's delivery-approve-btn should be enabled, disabled=${JSON.stringify(afterSwitch.deliveryApproveDisabled)}`);
      // The critical isolation assertions: Task A's stale proposal/mutation
      // cards (fully rendered earlier this session) must be hidden and no
      // card may still carry Task A's binding; and no idle "Ready" footer
      // while non-terminal Task B exists.
      if (afterSwitch.proposalCardHidden !== true) failures.push(`Task A's stale proposal card should be hidden after the switch, hidden=${JSON.stringify(afterSwitch.proposalCardHidden)}`);
      if (afterSwitch.mutationCardHidden !== true) failures.push(`Task A's stale mutation card should be hidden after the switch, hidden=${JSON.stringify(afterSwitch.mutationCardHidden)}`);
      if (afterSwitch.proposalCardTaskId === taskIdA) failures.push('stale proposal card is still bound to Task A after the switch');
      if (afterSwitch.mutationCardTaskId === taskIdA) failures.push('stale mutation card is still bound to Task A after the switch');
      if (afterSwitch.deliveryCardTaskId === taskIdA) failures.push('Task A\'s delivery card is still the bound/active card after switching to Task B');
      if (fullDom.pandaLabelText === 'Ready when you are.') failures.push('status footer shows the idle "Ready when you are." label while non-terminal Task B exists');
      if (failures.length > 0) {
        throw new Error(`[cross-task-isolation] real webview DOM assertions failed:\n  - ${failures.join('\n  - ')}`);
      }

      // Stale controls must emit ZERO outbound gate/task messages. The real
      // vscode.postMessage is instrumented at runtime (recorded AND forwarded
      // unmodified), then every proposal/mutation control is probe-clicked:
      // a disabled control swallows the click exactly as for a real user, and
      // any non-disabled one still has to be stopped by the production guard
      // chain (pendingProposal/pendingMutation cleared + activeTaskId binding).
      await uiDriver.instrumentWebviewPostMessage(client);
      const staleProbes = {};
      for (const buttonId of ['proposal-approve-btn', 'proposal-revise-btn', 'proposal-reject-btn', 'proposal-revision-submit-btn', 'mutation-approve-btn', 'mutation-deny-btn']) {
        staleProbes[buttonId] = await uiDriver.probeClickButton(client, buttonId);
      }
      const afterStaleProbes = (await uiDriver.readInstrumentedPostedMessages(client)) ?? [];
      const staleGateMessages = afterStaleProbes.filter(message => GATE_MESSAGE_TYPES.has(String(message?.type)));
      fs.writeFileSync(path.join(scenarioEvidenceDir, 'stale-control-probes.json'), JSON.stringify({ staleProbes, outbound: afterStaleProbes }, null, 2));
      if (staleGateMessages.length !== 0) {
        throw new Error(`[cross-task-isolation] stale controls emitted ${staleGateMessages.length} outbound gate message(s): ${JSON.stringify(staleGateMessages)}`);
      }
      log('[cross-task-isolation] stale-control probes emitted zero outbound gate messages.');

      // The one actionable gate must genuinely act on Task B only: a real
      // click on delivery-approve emits exactly one gate message bound to
      // Task B, and the extension host processes it end-to-end (Task B's
      // durable record transitions waiting_for_delivery_approval -> committing).
      await uiDriver.probeClickButton(client, 'delivery-approve-btn');
      const afterDeliveryClick = (await uiDriver.readInstrumentedPostedMessages(client)) ?? [];
      const deliveryGateMessages = afterDeliveryClick.filter(message => GATE_MESSAGE_TYPES.has(String(message?.type)));
      fs.writeFileSync(path.join(scenarioEvidenceDir, 'delivery-click-messages.json'), JSON.stringify(afterDeliveryClick, null, 2));
      if (deliveryGateMessages.length !== 1 || deliveryGateMessages[0].type !== 'approveAutonomousDelivery' || deliveryGateMessages[0].taskId !== taskIdB) {
        throw new Error(`[cross-task-isolation] expected exactly one approveAutonomousDelivery message bound to Task B ("${taskIdB}"), got: ${JSON.stringify(deliveryGateMessages)}`);
      }
      log("[cross-task-isolation] PASSED — Task A's stale cards cleared and inert, and only Task B's delivery control emitted one correctly bound approval message.");
    } finally {
      if (client) {
        try {
          await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'final-state');
        } catch {
          // best-effort
        }
        await client.close();
      }
      fs.mkdirSync(path.dirname(doneFlagFile), { recursive: true });
      fs.writeFileSync(doneFlagFile, '1');
    }
  })();

  await Promise.all([testsPromise, driverPromise]);
}

async function main() {
  // If this harness itself runs inside an Electron-hosted Node (e.g. a VS
  // Code extension host), this leaks into every spawned child and makes
  // Electron binaries run as plain Node instead of launching the app.
  delete process.env.ELECTRON_RUN_AS_NODE;

  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Disposable webview approval-cycle dogfood workspace\n');

  let exitCode = 1;
  try {
    log('Compiling extension...');
    run('npm', ['run', 'compile'], { cwd: repoRoot, shell: process.platform === 'win32' });

    log('Packaging the real production VSIX...');
    const vsceBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
    const productionVsixPath = path.join(workDir, 'webview-approval-dogfood.vsix');
    run(vsceBin, ['package', '--out', productionVsixPath], { cwd: repoRoot, shell: process.platform === 'win32' });
    if (!fs.existsSync(productionVsixPath)) throw new Error(`vsce did not produce a VSIX at ${productionVsixPath}`);

    log('Extracting the packaged VSIX (no manual installation)...');
    extractVsix(productionVsixPath, extractDir);
    const extensionDevelopmentPath = path.join(extractDir, 'extension');
    if (!fs.existsSync(path.join(extensionDevelopmentPath, 'package.json'))) {
      throw new Error(`extracted VSIX did not contain extension/package.json under ${extractDir}`);
    }
    if (!fs.existsSync(path.join(extensionDevelopmentPath, 'out', 'extension.js'))) {
      throw new Error(`extracted VSIX did not contain the bundled out/extension.js under ${extractDir}`);
    }

    log('Resolving VS Code (downloaded, cached after the first run)...');
    const resolvedVSCode = await resolveVSCode();

    const userDataDir = path.join(workDir, 'user-data');
    const extensionsDir = path.join(workDir, 'extensions');

    log('=== Session 1/2: seed a task through proposal -> mutation -> delivery in a fresh Extension Host ===');
    await runHostSession({ mode: 'seed', extensionDevelopmentPath, userDataDir, extensionsDir });

    log('=== Session 2/2: fresh Extension Host + fresh webview against the SAME disposable workspace (real reload/restore path) ===');
    await runHostSession({ mode: 'reload', extensionDevelopmentPath, userDataDir, extensionsDir });

    log('=== Scenario A: proposal-gate restart recovery (kill Extension Host without clicking, relaunch, real CDP click) ===');
    await runRestartRecoveryScenario({ gate: 'proposal', extensionDevelopmentPath, resolvedVSCode, label: 'scenario-a-proposal-restart' });

    log('=== Scenario B: mutation-gate restart recovery (kill Extension Host without clicking, relaunch, real CDP click) ===');
    await runRestartRecoveryScenario({ gate: 'mutation', extensionDevelopmentPath, resolvedVSCode, label: 'scenario-b-mutation-restart' });

    log('=== Scenario C: cross-task stale-card isolation (three-card session, task switch, zero-outbound stale probes) ===');
    await runCrossTaskIsolationScenario({ extensionDevelopmentPath });

    log(`PASSED. Evidence written to ${evidenceDir}`);
    exitCode = 0;
  } catch (error) {
    console.error('[webview-approval-dogfood] FAILED');
    console.error(error);
    log(`Work directory retained for inspection: ${workDir}`);
    exitCode = 1;
  } finally {
    if (exitCode === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      log('Cleaned up all temporary directories.');
    }
  }

  process.exit(exitCode);
}

main().catch(error => {
  console.error('[webview-approval-dogfood] FAILED');
  console.error(error);
  process.exit(1);
});
