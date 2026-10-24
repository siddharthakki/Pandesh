'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const EXTENSION_ID = 'ollama-agent.ollama-agent';
const LIVE_TASK_WALL_CLOCK_MS = 60 * 60_000;
const LIVE_REQUIRED_VALIDATION_COMMANDS = 2;
const LIVE_VALIDATION_COMMAND_TIMEOUT_MS = Math.floor(
  LIVE_TASK_WALL_CLOCK_MS / (LIVE_REQUIRED_VALIDATION_COMMANDS + 1),
);
const COMMANDS = {
  provision: 'ollama-agent.provisionEngineeringOrganization',
  sprint: 'ollama-agent.runEngineeringSprint',
  sync: 'ollama-agent.syncEngineeringOrganization',
  status: 'ollama-agent.showEngineeringOrganizationStatus',
  daily: 'ollama-agent.showDailyScrum',
  focus: 'ollama-agent.focus',
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 500);
}

function writeStatus(file, patch) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = { events: [] };
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First write.
  }
  const event = { at: new Date().toISOString(), ...patch };
  const events = [...(existing.events || []), event].slice(-300);
  fs.writeFileSync(file, JSON.stringify({ ...existing, ...patch, events }, null, 2));
}

function findIssueTask(workspaceRoot, issueNumber) {
  const root = path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks');
  if (!fs.existsSync(root)) return undefined;
  const matches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const file = path.join(root, entry.name, 'task.json');
    try {
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (task.sourceIssue?.issueNumber === issueNumber && task.evidence?.includes('organization:m22')) {
        matches.push(task);
      }
    } catch {
      // Ignore incomplete/foreign records while the queue is writing atomically.
    }
  }
  return matches.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
}

async function waitForDoneFlag(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for driver completion flag: ${file}`);
}

async function configureExtension(model) {
  const configuration = vscode.workspace.getConfiguration('ollama-agent');
  const target = vscode.ConfigurationTarget.Global;
  const settings = {
    providerType: 'ollama',
    apiBase: 'http://localhost:11434',
    model,
    agentModel: model,
    codingModel: model,
    contextWindow: 16384,
    requestTimeout: 900000,
    // The live task has two required validation commands (compile + full tests).
    // Give each one an equal bounded share while reserving one share for model,
    // approval, review, and delivery work. This remains inside the configured
    // one-hour task budget instead of relying on the generic two-minute command
    // default that killed a healthy full-suite run.
    commandTimeout: LIVE_VALIDATION_COMMAND_TIMEOUT_MS,
    maxTaskWallClock: LIVE_TASK_WALL_CLOCK_MS,
    requireApprovalForWrites: true,
    requireApprovalForCommands: true,
    trustedAutonomyEnabled: false,
    sequentialRolesEnabled: false,
  };
  for (const [key, value] of Object.entries(settings)) {
    await configuration.update(key, value, target);
  }
  return settings;
}

async function run() {
  const statusFile = requiredEnv('OA_M22_LIVE_STATUS');
  const doneFlagFile = requiredEnv('OA_M22_LIVE_DONE_FLAG');
  const issueNumber = Number(requiredEnv('OA_M22_LIVE_ISSUE'));
  const model = process.env.OA_M22_LIVE_MODEL || 'devstral-small-2:latest';
  const indexRoot = path.join(os.tmpdir(), `oa-m22-live-index-${process.pid}`);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('OA_M22_LIVE_ISSUE must be a positive integer');

  fs.rmSync(indexRoot, { recursive: true, force: true });
  fs.mkdirSync(indexRoot, { recursive: true });
  process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT = indexRoot;

  let taskId;
  try {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (!extension) throw new Error(`Extension ${EXTENSION_ID} was not found in the Extension Host`);
    await extension.activate();
    writeStatus(statusFile, { phase: 'activated', indexIsolation: 'enabled' });

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) throw new Error('No workspace folder is open in the Extension Host');
    const settings = await configureExtension(model);
    writeStatus(statusFile, {
      phase: 'configured',
      workspaceRoot,
      model,
      indexIsolation: 'enabled',
      commandTimeoutMs: settings.commandTimeout,
      maxTaskWallClockMs: settings.maxTaskWallClock,
    });

    await vscode.commands.executeCommand(COMMANDS.focus);
    writeStatus(statusFile, { phase: 'focused' });

    const provision = await vscode.commands.executeCommand(COMMANDS.provision);
    writeStatus(statusFile, { phase: 'provisioned', result: provision });

    const sprint = await vscode.commands.executeCommand(COMMANDS.sprint);
    writeStatus(statusFile, { phase: 'sprint_started', result: sprint });

    let postDeliveryCommandsRun = false;
    let lastObservationSignature;
    const deadline = Date.now() + 90 * 60_000;
    while (Date.now() < deadline && !fs.existsSync(doneFlagFile)) {
      const task = findIssueTask(workspaceRoot, issueNumber);
      if (task && task.taskId !== taskId) {
        taskId = task.taskId;
        writeStatus(statusFile, {
          phase: 'task_discovered',
          taskId,
          taskState: task.state,
          latestProgress: task.latestProgress,
        });
      }
      if (task) {
        const observationSignature = JSON.stringify({
          taskId: task.taskId,
          taskState: task.state,
          latestProgress: task.latestProgress,
          pullRequestUrl: task.githubDelivery?.pullRequestUrl,
          ciState: task.githubDelivery?.ci?.state,
        });
        if (observationSignature !== lastObservationSignature) {
          lastObservationSignature = observationSignature;
          writeStatus(statusFile, {
            phase: 'task_observed',
            taskId: task.taskId,
            taskState: task.state,
            latestProgress: task.latestProgress,
            pullRequestUrl: task.githubDelivery?.pullRequestUrl,
            ciState: task.githubDelivery?.ci?.state,
          });
        }
        if (task.githubDelivery?.pullRequestUrl && !postDeliveryCommandsRun) {
          const sync = await vscode.commands.executeCommand(COMMANDS.sync);
          const status = await vscode.commands.executeCommand(COMMANDS.status);
          const daily = await vscode.commands.executeCommand(COMMANDS.daily);
          postDeliveryCommandsRun = true;
          writeStatus(statusFile, {
            phase: 'post_delivery_commands_completed',
            taskId: task.taskId,
            pullRequestUrl: task.githubDelivery.pullRequestUrl,
            sync,
            status,
            daily,
          });
        } else if (task.githubDelivery?.pullRequestUrl && postDeliveryCommandsRun) {
          await vscode.commands.executeCommand(COMMANDS.sync).catch(() => undefined);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!fs.existsSync(doneFlagFile)) {
      throw new Error('Live M22 host exceeded its 90-minute safety limit before the external driver completed');
    }
    await waitForDoneFlag(doneFlagFile, 1000);
    writeStatus(statusFile, { phase: 'host_completed', taskId });
  } catch (error) {
    writeStatus(statusFile, { phase: 'host_failed', taskId, error: safeError(error) });
    throw error;
  } finally {
    delete process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT;
    try {
      fs.rmSync(indexRoot, { recursive: true, force: true });
    } catch {
      // Best effort: the OS temp directory may retain the isolated index if a
      // late SQLite handle is still closing during Extension Host shutdown.
    }
  }
}

module.exports = { run };
