'use strict';

// Runs INSIDE a real, packaged-VSIX Extension Development Host, used by
// scripts/acceptance/run-restart-approval-dogfood.mjs (Scenarios A and B:
// proposal/mutation restart recovery). Mirrors webviewApprovalDogfoodHost.js's
// fs-level task seeding technique (writes the exact on-disk AutonomousTask
// schema DurableTaskQueue itself reads/writes), but adds two crash-recovery
// modes:
//
//   - "seed-to-proposal" / "seed-to-mutation": seed a durable task directly
//     into waiting_for_proposal_approval / waiting_for_mutation_approval,
//     focus the real webview so the real AgentPanel poll loop surfaces the
//     approval card, then signal "ready_for_kill" and park. The external
//     orchestrator forcibly kills this Extension Host process tree at that
//     point — never lets it exit cleanly, never clicks anything — to prove
//     dispose()/teardown never fabricates a user rejection/denial.
//
//   - "restore": a genuinely fresh Extension Host, opened against the SAME
//     on-disk workspace/task directory left behind by the killed session.
//     Extension activation runs the real AutonomousTaskRuntime.start() ->
//     rearmPendingGates() recovery path with no scripted seeding here at
//     all. Focuses the webview and parks for the external CDP driver to
//     click the real, restored Approve button and observe the task progress.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const EXTENSION_ID = 'ollama-agent.ollama-agent';
const TASK_SCHEMA_VERSION = 1;

function writeStatus(statusFile, patch) {
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  const existing = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : { events: [] };
  const events = existing.events || [];
  events.push({ at: new Date().toISOString(), ...patch });
  fs.writeFileSync(statusFile, JSON.stringify({ ...existing, ...patch, events }, null, 2));
}

function taskFilePath(workspaceRoot, taskId) {
  return path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks', taskId, 'task.json');
}

function writeTaskState(workspaceRoot, taskId, patch) {
  const file = taskFilePath(workspaceRoot, taskId);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

function safeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function createTask(workspaceRoot, goal, taskIdOverride) {
  const taskId = taskIdOverride || safeId('m15');
  const repositoryId = crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 16);
  const task = {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId,
    attemptId: safeId('attempt'),
    origin: 'local-request',
    taskKind: 'mutating',
    repositoryRoot: workspaceRoot,
    repositoryId,
    goal,
    instructions: goal,
    priority: 'normal',
    createdAt: new Date().toISOString(),
    state: 'queued',
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
  };
  const file = taskFilePath(workspaceRoot, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(task, null, 2));
  return task;
}

async function waitForDoneFlag(doneFlagFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(doneFlagFile)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function run() {
  const mode = process.env.OA_RESTART_DOGFOOD_MODE;
  const statusFile = process.env.OA_RESTART_DOGFOOD_STATUS;
  const doneFlagFile = process.env.OA_RESTART_DOGFOOD_DONE_FLAG;
  const taskIdEnv = process.env.OA_RESTART_DOGFOOD_TASK_ID;
  if (!mode || !statusFile || !doneFlagFile) {
    throw new Error('OA_RESTART_DOGFOOD_MODE, OA_RESTART_DOGFOOD_STATUS and OA_RESTART_DOGFOOD_DONE_FLAG must all be set');
  }

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) throw new Error(`packaged extension "${EXTENSION_ID}" was not found by the Extension Development Host`);
  await extension.activate();
  writeStatus(statusFile, { phase: 'activated' });

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) throw new Error('no disposable workspace folder was opened');
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  if (mode === 'seed-to-proposal') {
    const task = createTask(workspaceRoot, 'restart dogfood: proposal gate', taskIdEnv);
    writeTaskState(workspaceRoot, task.taskId, {
      state: 'waiting_for_proposal_approval',
      pendingProposal: {
        proposalId: 'restart-dogfood-proposal-1',
        version: 1,
        taskSummary: 'Restart dogfood proposal.',
        operations: [{ type: 'create', path: 'restart-dogfood.txt', reason: 'acceptance-only, never applied' }],
        validationCommands: [],
        warnings: [],
      },
    });
    writeStatus(statusFile, { phase: 'task_seeded', taskId: task.taskId });

    await vscode.commands.executeCommand('ollama-agent.focus');
    writeStatus(statusFile, { phase: 'focused', taskId: task.taskId });
    // One full poll interval so the real AgentPanel poll loop round-trips the
    // proposalApprovalRequest message into the real webview before this
    // process is forcibly killed out from under it.
    await new Promise(r => setTimeout(r, 2500));
    writeStatus(statusFile, { phase: 'ready_for_kill', taskId: task.taskId });
    // Park indefinitely — the external orchestrator kills this process tree
    // directly (taskkill /T /F) rather than waiting for the done flag.
    await waitForDoneFlag(doneFlagFile, 10 * 60 * 1000);
    return;
  }

  if (mode === 'seed-to-mutation') {
    const task = createTask(workspaceRoot, 'restart dogfood: mutation gate', taskIdEnv);
    writeTaskState(workspaceRoot, task.taskId, {
      state: 'waiting_for_mutation_approval',
      pendingMutationApproval: {
        requestId: 'restart-dogfood-mutation-1',
        proposalId: 'restart-dogfood-proposal-1',
        operationCount: 1,
        targets: ['restart-dogfood.txt'],
        elevatedConfirmationRequired: false,
      },
    });
    writeStatus(statusFile, { phase: 'task_seeded', taskId: task.taskId });

    await vscode.commands.executeCommand('ollama-agent.focus');
    writeStatus(statusFile, { phase: 'focused', taskId: task.taskId });
    await new Promise(r => setTimeout(r, 2500));
    writeStatus(statusFile, { phase: 'ready_for_kill', taskId: task.taskId });
    await waitForDoneFlag(doneFlagFile, 10 * 60 * 1000);
    return;
  }

  if (mode === 'restore') {
    // No seeding here at all — the task directory already exists on disk
    // (left by a killed "seed-to-*" session against the SAME
    // workspace/user-data/extensions dirs), still parked at whichever
    // waiting_for_*_approval state it was in when killed. This exercises the
    // real AutonomousTaskRuntime.start() -> rearmPendingGates() recovery path
    // that runs during ordinary extension activation, and the real
    // AgentPanel.reconnectAutonomousTask() restore path — no test-only code
    // runs in between.
    await vscode.commands.executeCommand('ollama-agent.focus');
    writeStatus(statusFile, { phase: 'focused' });
    await new Promise(r => setTimeout(r, 2500));
    writeStatus(statusFile, { phase: 'ready_for_assertions' });
    await waitForDoneFlag(doneFlagFile, 60000);
    return;
  }

  throw new Error(`unknown OA_RESTART_DOGFOOD_MODE "${mode}"`);
}

module.exports = { run };
