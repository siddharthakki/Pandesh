'use strict';

// Runs INSIDE a real, packaged-VSIX Extension Development Host
// (@vscode/test-electron `runTests()` with `extensionTestsPath` pointed at
// this file). It never touches the rendered webview DOM itself — the
// Extension Host process has no browser/DOM, only `vscode` APIs and Node —
// it only seeds/restores durable autonomous-task state on disk (the same
// on-disk schema DurableTaskQueue itself reads and writes) and reveals the
// real KarkeDikha WebviewView via the real `ollama-agent.focus` command.
// The actual DOM assertions are made by the external orchestrator
// (run-webview-approval-dogfood.mjs) over CDP, connected directly to the
// webview's own CDP target (see uiDriver.mjs connectToWebviewHost).
//
// Two modes, selected by OA_WEBVIEW_DOGFOOD_MODE:
//   - "seed":   creates a fresh durable task and walks it through
//               waiting_for_proposal_approval -> waiting_for_mutation_approval
//               -> waiting_for_delivery_approval, using the real
//               AgentPanel poll loop (2s interval) to pick up each disk
//               state change and post the real proposalApprovalRequest /
//               mutationApprovalRequest / deliveryApprovalRequest /
//               autonomousTaskStatus messages into the real webview.
//   - "reload": opens a fresh Extension Host window against the SAME
//               workspace/task directory left by "seed" (no re-seeding) and
//               calls `ollama-agent.focus`, exercising the real
//               reconnectAutonomousTask() "panel (re)open" restore path.
//
// Both modes park at the end, polling for an external "done" flag file
// (written by the CDP driver once its DOM assertions have completed) before
// letting `run()` resolve — otherwise VS Code would exit and tear down the
// webview before the external driver could inspect it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const EXTENSION_ID = 'ollama-agent.ollama-agent';
// The production VSIX is esbuild-bundled into a single out/extension.js for
// packaging (see esbuild.js --production / vscode:prepublish), so
// individual compiled modules like DurableTaskQueue are not requireable
// from the packaged extension's out/ directory. Task state is seeded by
// writing the same on-disk schema (M15AutonomousWork.ts AutonomousTask,
// schemaVersion 1) directly with plain fs, matching exactly what
// DurableTaskQueue.enqueue() itself would write for these fields — the
// production code never distinguishes how a task.json file was produced,
// only reads/validates it (DurableTaskQueue.get()/list() just JSON.parse +
// check schemaVersion === 1).
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

/** Directly rewrites the durable task's on-disk state, bypassing DurableTaskQueue's
 * transition validator — the same fs-level technique the packaged-acceptance
 * harness already uses to inspect task state (see run-packaged-acceptance.mjs
 * readTask()), used here in reverse to *seed* it. */
function writeTaskState(workspaceRoot, taskId, patch) {
  const file = taskFilePath(workspaceRoot, taskId);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

function safeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Writes a fresh AutonomousTask (schemaVersion 1) directly to disk, mirroring
 * DurableTaskQueue.enqueue()/createDefaultAutonomousTask()'s exact shape. */
function createTask(workspaceRoot, goal) {
  const taskId = safeId('m15');
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
  const mode = process.env.OA_WEBVIEW_DOGFOOD_MODE;
  const statusFile = process.env.OA_WEBVIEW_DOGFOOD_STATUS;
  const doneFlagFile = process.env.OA_WEBVIEW_DOGFOOD_DONE_FLAG;
  if (!mode || !statusFile || !doneFlagFile) {
    throw new Error('OA_WEBVIEW_DOGFOOD_MODE, OA_WEBVIEW_DOGFOOD_STATUS and OA_WEBVIEW_DOGFOOD_DONE_FLAG must all be set');
  }

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) throw new Error(`packaged extension "${EXTENSION_ID}" was not found by the Extension Development Host`);
  await extension.activate();
  writeStatus(statusFile, { phase: 'activated' });

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) throw new Error('no disposable workspace folder was opened');
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  try {
    if (mode === 'seed') {
      const task = createTask(workspaceRoot, 'webview approval-cycle dogfood: exercise the real proposal/mutation/delivery gate reconciliation');
      writeStatus(statusFile, { phase: 'task_created', taskId: task.taskId });

      writeTaskState(workspaceRoot, task.taskId, {
        state: 'waiting_for_proposal_approval',
        pendingProposal: {
          proposalId: 'dogfood-proposal-1',
          version: 1,
          taskSummary: 'Webview approval-cycle dogfood proposal.',
          operations: [{ type: 'create', path: 'dogfood.txt', reason: 'acceptance-only, never applied' }],
          validationCommands: [],
          warnings: [],
        },
      });
      writeStatus(statusFile, { phase: 'stage:proposal_seeded', taskId: task.taskId });

      await vscode.commands.executeCommand('ollama-agent.focus');
      writeStatus(statusFile, { phase: 'focused', taskId: task.taskId });

      // The real AgentPanel poll loop runs every 2s (AUTONOMOUS_POLL_INTERVAL_MS);
      // reconnectAutonomousTask()'s first poll fires immediately on focus, so
      // this only needs to clear one full interval to guarantee the
      // proposalApprovalRequest round-trip has landed in the real webview.
      await new Promise(r => setTimeout(r, 2500));

      writeTaskState(workspaceRoot, task.taskId, {
        state: 'waiting_for_mutation_approval',
        pendingProposal: undefined,
        pendingMutationApproval: {
          requestId: 'dogfood-mutation-1',
          proposalId: 'dogfood-proposal-1',
          operationCount: 1,
          targets: ['dogfood.txt'],
          elevatedConfirmationRequired: false,
        },
      });
      writeStatus(statusFile, { phase: 'stage:mutation_seeded', taskId: task.taskId });
      await new Promise(r => setTimeout(r, 2500));

      writeTaskState(workspaceRoot, task.taskId, {
        state: 'waiting_for_delivery_approval',
        pendingMutationApproval: undefined,
      });
      writeStatus(statusFile, { phase: 'stage:delivery_seeded', taskId: task.taskId });
      await new Promise(r => setTimeout(r, 2500));

      writeStatus(statusFile, { phase: 'ready_for_assertions', taskId: task.taskId });
    } else if (mode === 'reload') {
      // Restore path: the task directory already exists on disk (left by a
      // prior "seed" run against the same workspace/user-data/extensions
      // dirs) in state waiting_for_delivery_approval. This is a genuinely
      // fresh Extension Host / fresh webview — exercising
      // AgentPanel.reconnectAutonomousTask()'s real "panel (re)open" restore
      // path, not a simulated reload.
      await vscode.commands.executeCommand('ollama-agent.focus');
      writeStatus(statusFile, { phase: 'focused' });
      await new Promise(r => setTimeout(r, 2500));
      writeStatus(statusFile, { phase: 'ready_for_assertions' });
    } else {
      throw new Error(`unknown OA_WEBVIEW_DOGFOOD_MODE "${mode}"`);
    }
  } catch (error) {
    writeStatus(statusFile, { phase: 'failed', error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
    // Still park for the done flag so the external driver can capture
    // failure diagnostics before this process (and the webview with it) exits.
    await waitForDoneFlag(doneFlagFile, 15000);
    throw error;
  }

  const signalled = await waitForDoneFlag(doneFlagFile, 60000);
  if (!signalled) {
    throw new Error('timed out waiting for the external CDP driver to signal completion (done flag never appeared)');
  }
}

module.exports = { run };
