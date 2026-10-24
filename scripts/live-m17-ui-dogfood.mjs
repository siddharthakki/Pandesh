#!/usr/bin/env node
// A genuine, model-backed M17 dogfood attempt against the real Khakedikha
// checkout, driven through the packaged production VSIX's *real, visible*
// UI. This harness launches and keeps alive an isolated VS Code window and
// starts the real task via the companion driver; a human then approves or
// rejects the real proposal QuickPick and the real execution-approval modal
// directly in that window. This script never clicks Approve/Reject itself —
// CDP is used only for read-only detection/diagnostics (screenshots, DOM
// text) so evidence can be captured, never for Input.dispatch* on an
// approval surface.
//
// Root cause of the previous CDP-closure failure (see HANDOFF/session notes):
// the isolated VS Code window's own renderer sent an extension-host
// "terminate" message ~64s into the run (window1/exthost/exthost.log:
// "Extension host terminating: received terminate message from renderer"),
// killing the extension host (clean exit code 0) and, as a side effect,
// dropping the CDP page target the driver was polling — surfacing as a
// generic "WebSocket is not open" error with no indication of *why*. The
// previous harness (a) discarded all child-process stdout/stderr
// (`stdio: 'ignore'`), (b) used a single 30s companion-activation timeout
// that told the caller nothing once past that point, and (c) auto-clicked
// approvals via CDP input, which is no longer permitted. This version:
//   - captures full child stdout/stderr and every VS Code log directory;
//   - tracks the child process's own exit event directly (not inferred);
//   - on any CDP closure, classifies it via HarnessLifecycle.classifyCdpClosure
//     using the *observed* child state, and reconnects if the process is
//     still alive rather than failing immediately;
//   - never calls terminatePlainHost until a controlled shutdown decides
//     (via HarnessLifecycle.canAutoCleanup) that it is safe to do so —
//     never merely because a QuickPick/modal is pending;
//   - never deletes the task worktree (HarnessLifecycle.buildCleanupPlan
//     excludes it unconditionally);
//   - waits for the human to approve through the real UI with no fixed
//     overall timeout — only a per-stage *inactivity* bound that is reset by
//     any observed task/event-log progress, and is fully suspended while a
//     human approval gate is open.

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as uiDriver from './acceptance/uiDriver.mjs';
import {
  resolveVSCode,
  installExtension,
  allocateDebugPort,
  writeControlFile,
} from './acceptance/plainVsCodeHost.mjs';
import {
  canAutoCleanup,
  classifyCdpClosure,
  hasStalled,
  compareSourceCheckout,
  buildCleanupPlan,
  isTerminalTaskState,
} from '../out/acceptance/HarnessLifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const enabled = process.env.OLLAMA_AGENT_LIVE_M17_UI === '1' || process.argv.includes('--enabled');
if (!enabled) {
  console.log('SKIPPED: real UI M17 dogfood requires OLLAMA_AGENT_LIVE_M17_UI=1 or --enabled.');
  console.log('M17_UI_DOGFOOD_STATUS=skipped-safe-default');
  process.exit(0);
}

function argValue(flag, fallback) {
  const prefix = `--${flag}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const targetRepo = path.resolve(argValue('repo', process.env.OLLAMA_AGENT_LIVE_M17_REPO || 'C:\\Projects\\apps\\khakedikha'));
const goal = [
  'Add an EventStaff-scoped mobile-first live-sales vertical slice on top of',
  'the existing events app, backend-only (no new templates/UI beyond what is',
  'strictly needed to exercise the endpoint): an EventStaffAssignment model',
  'linking User to Event, a server-side view that atomically decrements',
  'EventMenuItem.units_remaining via F() inside transaction.atomic() and',
  'writes a per-event on-site-sale audit record, and a test asserting that',
  'two near-simultaneous sells against units_remaining=1 do not both succeed.',
  'Do not touch payment, PWA, finance, or tax code. Do not commit or push.',
].join(' ');

const INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes of zero observed progress outside a human-approval wait
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-m17-ui-dogfood-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm17-ui-dogfood', runStamp);
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(evidenceDir, { recursive: true });

function log(message) {
  const line = `[m17-ui-dogfood] ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(evidenceDir, 'harness.log'), `${new Date().toISOString()} ${line}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
}

function gitSnapshot(root) {
  const status = spawnSync('git', ['status', '--porcelain', '-b'], { cwd: root, encoding: 'utf8' }).stdout;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  return { status, head, branch };
}

function writeIsolatedUserSettings(userDataDir, apiBase) {
  const userDir = path.join(userDataDir, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, 'settings.json'),
    JSON.stringify(
      {
        'window.dialogStyle': 'custom',
        'ollama-agent.providerType': 'ollama',
        'ollama-agent.apiBase': apiBase,
        'ollama-agent.codingModel': 'qwen3-coder:30b',
        'ollama-agent.chatModel': 'qwen2.5-coder:1.5b',
      },
      null,
      2,
    ),
  );
}

function listAutonomousTaskIds(workspaceRoot) {
  const dir = path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
}

function readTask(workspaceRoot, taskId) {
  const file = path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks', taskId, 'task.json');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readTaskEvents(workspaceRoot, taskId) {
  const file = path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks', taskId, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function readWorktreeLease(workspaceRoot, taskId) {
  const manifestPath = path.join(workspaceRoot, '.ollama-agent', 'tasks', '_worktrees', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return (manifest.leases || []).find(l => l.taskId === taskId);
}

function readStatusFile(statusFile) {
  if (!fs.existsSync(statusFile)) return undefined;
  try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return undefined; }
}

/** Wraps a launched VS Code process: keeps a strong reference, records its own exit (never inferred), and captures stdout/stderr instead of discarding it. */
function launchTrackedVsCodeProcess(vscodeExecutablePath, { userDataDir, extensionsDir, workspacePath, remoteDebuggingPort, env }) {
  const args = [
    '--user-data-dir', userDataDir,
    '--extensions-dir', extensionsDir,
    '--new-window',
    '--disable-updates',
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--remote-debugging-port=${remoteDebuggingPort}`,
    workspacePath,
  ];
  const stdoutChunks = [];
  const stderrChunks = [];
  const state = { exited: false, exitCode: null, signal: null };

  const child = spawn(vscodeExecutablePath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    detached: false,
  });
  child.stdout.on('data', chunk => stdoutChunks.push(chunk));
  child.stderr.on('data', chunk => stderrChunks.push(chunk));
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.signal = signal;
    log(`VS Code process (pid=${child.pid}) exited: code=${code} signal=${signal ?? 'none'}`);
  });
  child.on('error', error => {
    log(`VS Code process (pid=${child.pid}) emitted error event: ${error.message}`);
  });

  return {
    child,
    state,
    writeIoTail(destDir, label) {
      fs.writeFileSync(path.join(destDir, `${label}-vscode-stdout.log`), Buffer.concat(stdoutChunks).toString('utf8'));
      fs.writeFileSync(path.join(destDir, `${label}-vscode-stderr.log`), Buffer.concat(stderrChunks).toString('utf8'));
    },
  };
}

function copyVsCodeLogs(userDataDir, destDir) {
  const logsDir = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logsDir)) return;
  const dest = path.join(destDir, 'vscode-logs');
  fs.cpSync(logsDir, dest, { recursive: true });
}

async function pollUntil(conditionFn, { inactivityTimeoutMs, intervalMs = 500, isAwaitingHuman, describe, onHeartbeat }) {
  const start = Date.now();
  let lastProgressAtMs = start;
  let lastHeartbeatAtMs = start;
  let last;
  while (true) {
    last = conditionFn();
    if (last && last.done) return last.value;
    if (last && last.progressed) lastProgressAtMs = Date.now();
    const nowMs = Date.now();
    if (hasStalled({ awaitingHumanApproval: isAwaitingHuman(), lastProgressAtMs, nowMs, inactivityTimeoutMs })) {
      throw new Error(`stalled: no progress for over ${inactivityTimeoutMs}ms waiting for: ${describe?.() ?? 'condition'}; last=${JSON.stringify(last?.value)}`);
    }
    if (onHeartbeat && nowMs - lastHeartbeatAtMs > HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAtMs = nowMs;
      onHeartbeat({ elapsedMs: nowMs - start, awaitingHuman: isAwaitingHuman() });
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

async function waitForNewTaskId(workspaceRoot, baselineIds, tracked) {
  return pollUntil(
    () => {
      const current = listAutonomousTaskIds(workspaceRoot);
      const created = current.find(id => !baselineIds.includes(id));
      return created ? { done: true, value: created, progressed: true } : { done: false, value: current };
    },
    {
      inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
      isAwaitingHuman: () => false,
      describe: () => 'a new autonomous task directory to be created by startAutonomousTask',
      onHeartbeat: ({ elapsedMs }) => log(`heartbeat: still waiting for task creation (${Math.round(elapsedMs / 1000)}s elapsed); VS Code alive=${!tracked.state.exited}`),
    },
  );
}

async function waitForCompanionPhase(statusFile, phase, tracked) {
  return pollUntil(
    () => {
      const status = readStatusFile(statusFile);
      const match = status?.events?.find(e => e.phase === phase);
      return match ? { done: true, value: match, progressed: true } : { done: false, value: status?.phase, progressed: Boolean(status) };
    },
    {
      inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
      isAwaitingHuman: () => false,
      describe: () => `companion driver status file to reach phase "${phase}"`,
      onHeartbeat: ({ elapsedMs }) => log(`heartbeat: still waiting for companion phase "${phase}" (${Math.round(elapsedMs / 1000)}s elapsed); VS Code alive=${!tracked.state.exited}`),
    },
  );
}

/**
 * Read-only CDP wait with reconnect-on-transport-closure. Never dispatches
 * input. On a WebSocket closure it classifies the closure using the actual
 * observed child-process state (HarnessLifecycle.classifyCdpClosure): if VS
 * Code is still alive, it reconnects and keeps waiting (the closure was a
 * transport blip, e.g. a devtools target re-attach); if VS Code actually
 * exited, it fails immediately with the exact exit code/signal rather than a
 * generic transport error.
 */
async function detectWithReconnect(getClient, tracked, detectFn, describe) {
  let client = getClient();
  for (;;) {
    try {
      return await detectFn(client);
    } catch (error) {
      const isTransportError = /WebSocket is not open|socket hang up|ECONNRESET/i.test(String(error?.message ?? error));
      if (!isTransportError) throw error;
      const classification = classifyCdpClosure({
        childExited: tracked.state.exited,
        childExitCode: tracked.state.exitCode,
        childSignal: tracked.state.signal,
      });
      log(`CDP transport closed while ${describe}: ${classification.kind} — ${classification.detail}`);
      if (!classification.recoverable) {
        throw new Error(`vscode_process_exited while ${describe}: ${classification.detail}`);
      }
      log('VS Code process is still alive; reconnecting CDP and retrying detection...');
      try { await client.close(); } catch { /* already closed */ }
      client = await uiDriver.connect(await tracked.currentDebugPort(), { attempts: 10, delayMs: 500 });
    }
  }
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;

  let explicitCancel = false;
  process.on('SIGINT', () => {
    log('SIGINT received: explicit human cancel. Will stop waiting and shut down cleanly without approving/mutating/delivering anything.');
    explicitCancel = true;
  });

  if (!fs.existsSync(path.join(targetRepo, '.git'))) {
    throw new Error(`target repo ${targetRepo} is not a git checkout`);
  }
  const before = gitSnapshot(targetRepo);
  log(`target repo: ${targetRepo}`);
  log(`before: branch=${before.branch} head=${before.head}`);
  fs.writeFileSync(path.join(evidenceDir, 'source-checkout-before.json'), JSON.stringify(before, null, 2));

  const baselineTaskIds = listAutonomousTaskIds(targetRepo);

  log('Compiling extension (also compiles HarnessLifecycle for this script)...');
  run('npm', ['run', 'compile'], { cwd: repoRoot });

  log('Packaging production VSIX...');
  const vsceBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
  const productionVsixPath = path.join(workDir, 'production.vsix');
  run(vsceBin, ['package', '--out', productionVsixPath], { cwd: repoRoot });

  log('Packaging companion-driver VSIX...');
  const companionDir = path.join(__dirname, 'acceptance', 'companion-driver');
  const companionVsixPath = path.join(workDir, 'companion-driver.vsix');
  run(vsceBin, ['package', '--out', companionVsixPath, '--allow-missing-repository', '--no-dependencies'], { cwd: companionDir });

  log('Resolving VS Code...');
  const { vscodeExecutablePath, cliArgs } = await resolveVSCode();

  const userDataDir = path.join(workDir, 'user-data');
  const extensionsDir = path.join(workDir, 'extensions');
  writeIsolatedUserSettings(userDataDir, process.env.OLLAMA_AGENT_LIVE_M17_APIBASE || 'http://localhost:11434');

  log('Installing production VSIX...');
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath: productionVsixPath });
  log('Installing companion-driver VSIX...');
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath: companionVsixPath });

  const statusFile = path.join(evidenceDir, 'companion-status.json');
  const controlFilePath = path.join(workDir, 'control.json');
  writeControlFile(controlFilePath, {
    runId: runStamp,
    scenario: 'success',
    goal,
    statusFile,
    evidenceDirectory: evidenceDir,
  });

  const remoteDebuggingPort = allocateDebugPort();
  log(`Launching isolated VS Code window on the real target repo, CDP port ${remoteDebuggingPort}. This window is VISIBLE — approve/reject the proposal and mutation yourself in it.`);
  const tracked = launchTrackedVsCodeProcess(vscodeExecutablePath, {
    userDataDir,
    extensionsDir,
    workspacePath: targetRepo,
    remoteDebuggingPort,
    env: { OLLAMA_AGENT_ACCEPTANCE_CONTROL_FILE: controlFilePath },
  });
  tracked.currentDebugPort = async () => remoteDebuggingPort;

  let finalTask;
  let taskId;
  let awaitingHuman = false;
  let client;
  let outcome = { kind: 'unknown' };

  try {
    await waitForCompanionPhase(statusFile, 'companion_activated', tracked);
    log('companion driver activated in the real Khakedikha window.');
    const commandChecked = await waitForCompanionPhase(statusFile, 'command_registration_checked', tracked);
    if (!commandChecked.commandRegistered) {
      throw new Error(`ollama-agent.startAutonomousTask was not registered: ${JSON.stringify(commandChecked)}`);
    }

    client = await uiDriver.connect(remoteDebuggingPort);

    taskId = await waitForNewTaskId(targetRepo, baselineTaskIds, tracked);
    log(`task created: ${taskId}`);

    log('waiting (read-only detection only) for the real proposal-review QuickPick to appear...');
    awaitingHuman = false;
    await detectWithReconnect(
      () => client,
      tracked,
      c => uiDriver.waitForQuickPick(c, 'Review Autonomous Proposal', { timeoutMs: INACTIVITY_TIMEOUT_MS }),
      'waiting for the proposal QuickPick',
    );
    log('*** Proposal QuickPick is visible in the VS Code window. Please review and Approve/Reject it yourself. This harness will not click anything. ***');
    awaitingHuman = true;
    await uiDriver.captureFailureDiagnostics(client, evidenceDir, 'proposal-quickpick-visible');

    // Human approves the proposal in the real window. Detect the follow-on
    // execution-approval modal (this also proves the QuickPick was actually
    // approved, since the modal only appears on the approve path).
    await detectWithReconnect(
      () => client,
      tracked,
      c => uiDriver.waitForModalDialog(c, 'Apply autonomous task', { timeoutMs: INACTIVITY_TIMEOUT_MS }),
      'waiting for the human to approve the proposal and reach the execution-approval modal',
    );
    log('*** Execution-approval modal is visible. Please click "Approve Execution" (or reject) yourself. This harness will not click anything. ***');
    await uiDriver.captureFailureDiagnostics(client, evidenceDir, 'execution-approval-modal-visible');
    awaitingHuman = true; // remains true until the task record shows the human's decision took effect
  } catch (error) {
    outcome = { kind: 'setup_or_detection_failed', error: String(error?.stack ?? error) };
    tracked.writeIoTail(evidenceDir, 'failure');
    copyVsCodeLogs(userDataDir, evidenceDir);
    if (client) {
      try { await uiDriver.captureFailureDiagnostics(client, evidenceDir, 'ui-driver-failure'); } catch { /* best effort */ }
      try { await client.close(); } catch { /* best effort */ }
    }
    fs.writeFileSync(path.join(evidenceDir, 'outcome.json'), JSON.stringify(outcome, null, 2));
    throw error;
  }

  try {
    finalTask = await pollUntil(
      () => {
        if (explicitCancel) return { done: true, value: readTask(targetRepo, taskId) };
        const task = readTask(targetRepo, taskId);
        const terminal = task && isTerminalTaskState(task.state);
        // Once the task record shows any state, the human's action in the
        // real UI has taken effect (approved or rejected); after that point
        // we're only waiting on real model/validation work, not the human.
        awaitingHuman = !task || task.state === 'queued' || task.state === 'running';
        return terminal ? { done: true, value: task, progressed: true } : { done: false, value: task?.state, progressed: Boolean(task) };
      },
      {
        inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
        isAwaitingHuman: () => awaitingHuman && !explicitCancel,
        describe: () => {
          const events = readTaskEvents(targetRepo, taskId);
          return `task ${taskId} to reach a terminal state; lastEvents=${JSON.stringify(events.slice(-8))}`;
        },
        onHeartbeat: ({ elapsedMs, awaitingHuman: waiting }) =>
          log(`heartbeat: ${Math.round(elapsedMs / 1000)}s elapsed, awaitingHuman=${waiting}, VS Code alive=${!tracked.state.exited}`),
      },
    );
    outcome = explicitCancel ? { kind: 'explicit_cancel' } : { kind: 'terminal_state_reached', state: finalTask?.state };
  } catch (error) {
    outcome = { kind: 'wait_failed', error: String(error?.stack ?? error) };
    finalTask = readTask(targetRepo, taskId);
  } finally {
    tracked.writeIoTail(evidenceDir, 'final');
    copyVsCodeLogs(userDataDir, evidenceDir);
    if (client) {
      try { await client.close(); } catch { /* best effort */ }
    }
  }

  const after = gitSnapshot(targetRepo);
  const comparison = compareSourceCheckout(before, after);
  fs.writeFileSync(path.join(evidenceDir, 'source-checkout-after.json'), JSON.stringify(after, null, 2));

  const lease = taskId ? readWorktreeLease(targetRepo, taskId) : undefined;
  const worktreeStatus = finalTask?.worktreeLocation && fs.existsSync(finalTask.worktreeLocation)
    ? spawnSync('git', ['status', '--porcelain'], { cwd: finalTask.worktreeLocation, encoding: 'utf8' }).stdout
    : undefined;

  const evidence = {
    status: outcome.kind === 'terminal_state_reached' && finalTask?.state === 'waiting_for_delivery_approval'
      ? 'model-backed-ui-success'
      : `model-backed-ui-non-success:${outcome.kind}`,
    modelBacked: true,
    targetRepo,
    taskId,
    attemptId: finalTask?.attemptId,
    finalState: finalTask?.state,
    outcome,
    providerModelRoutingSnapshot: finalTask?.providerModelRoutingSnapshot,
    worktreeLocation: finalTask?.worktreeLocation,
    worktreeBranch: finalTask?.branchName,
    worktreeBaseCommit: finalTask?.worktreeBaseCommit,
    worktreeLeaseStatus: lease ? lease.status : 'no-lease',
    worktreeGitStatus: worktreeStatus,
    qualityGate: finalTask?.qualityGate,
    validationResult: finalTask?.evidence?.some(item => item.includes('validation:passed')) ? 'passed' : (finalTask?.evidence ?? 'unknown'),
    sourceCheckoutBefore: before,
    sourceCheckoutAfter: after,
    sourceCheckoutComparison: comparison,
    noDeliveryApprovalIssued: true,
    noCommitOrPushIssued: true,
    noAutomaticProposalOrMutationApproval: true,
    worktreeRetained: true,
  };

  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  log(`Evidence written to ${evidenceDir}`);
  log(JSON.stringify(evidence, null, 2));

  if (!comparison.unchanged) {
    throw new Error(`ORIGINAL KHAKEDIKHA CHECKOUT WAS MUTATED — before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }

  const safeToCleanup = canAutoCleanup({
    awaitingHumanApproval: false, // by this point the wait loop above has already exited (terminal state or explicit cancel)
    taskState: finalTask?.state,
    explicitCancel,
  });
  if (safeToCleanup) {
    for (const target of buildCleanupPlan({ isolatedUserDataDir: userDataDir, isolatedExtensionsDir: extensionsDir, worktreeLocation: finalTask?.worktreeLocation })) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    log('Cleaned up isolated VS Code scratch directories (user-data, extensions). Worktree retained, never deleted.');
  } else {
    log(`Not safe to auto-cleanup yet (finalState=${finalTask?.state}); leaving isolated dirs at ${workDir} for inspection.`);
  }

  if (explicitCancel) {
    console.log('M17_UI_DOGFOOD_STATUS=explicit-cancel');
    process.exit(1);
  }
  if (finalTask?.state !== 'waiting_for_delivery_approval') {
    console.log(`M17_UI_DOGFOOD_STATUS=non-success state=${finalTask?.state} outcome=${outcome.kind}`);
    process.exit(1);
  }
  console.log('M17_UI_DOGFOOD_STATUS=reached-waiting-for-delivery-approval');
  process.exit(0);
}

main().catch(error => {
  console.error('[m17-ui-dogfood] FAILED');
  console.error(error);
  console.log(`work directory retained for inspection: ${workDir}`);
  process.exit(1);
});
