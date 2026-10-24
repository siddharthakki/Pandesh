#!/usr/bin/env node

import { spawnSync } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runTests } from '@vscode/test-electron';
import * as uiDriver from './acceptance/uiDriver.mjs';
import { allocateDebugPort } from './acceptance/plainVsCodeHost.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

function argValue(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function positiveNumberArg(name, fallback) {
  const value = Number(argValue(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

const issueNumber = Number(argValue('--issue', '39'));
const repository = argValue('--repo', 'siddharthakki/ollama-agent');
const expectedPath = argValue('--expected-path', 'docs/M18_M22_AUTONOMOUS_ENGINEERING_ORGANIZATION.md');
const evidenceBranch = argValue('--evidence-branch', 'evidence/m22-review');
const model = argValue('--model', 'devstral-small-2:latest');
const taskStallTimeoutMs = positiveNumberArg('--stall-timeout-ms', 10 * 60_000);
const taskTotalTimeoutMs = positiveNumberArg('--total-timeout-ms', 60 * 60_000);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm22-live-production', stamp);
const latestEvidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm22-live-production', 'latest');
const hostStatusFile = path.join(evidenceDir, 'host-status.json');
const doneFlagFile = path.join(evidenceDir, 'driver-done.flag');
const userDataDir = path.join(os.tmpdir(), `oa-m22-live-user-${stamp}-${process.pid}`);
const extensionsDir = path.join(os.tmpdir(), `oa-m22-live-ext-${stamp}-${process.pid}`);
const remoteDebuggingPort = allocateDebugPort();
const commandResults = [];
const flowEvents = [];
let discoveredTaskId;
let pullRequestUrl;
let lastReportedTaskSignature;

function redact(value) {
  return String(value ?? '')
    .replace(/authorization:\s*\S+/gi, 'authorization: [redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"']+/gi, '$1=[redacted]')
    .replace(/\bgh[opusr]_[A-Za-z0-9_]+\b/g, '[redacted-github-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[redacted-api-key]');
}

function eventMessage(event, details) {
  switch (event) {
    case 'preflight_started':
      return `Starting live M22 dogfood for issue #${details.issueNumber} with ${details.model}.`;
    case 'issue_ready':
      return `Issue #${details.issueNumber} is ready and is the only ai-ready story in this bounded run.`;
    case 'stale_worktree_archived':
      return `Archived the previous issue branch and worktree before starting clean: ${details.branch}.`;
    case 'stale_task_archived':
      return `Archived prior task ${details.taskId} (${details.state}) without discarding its evidence.`;
    case 'runtime_state_archived':
      return `Archived previous M22 runtime state: ${details.path}.`;
    case 'webview_connected':
      return 'KarkeDikha Extension Host is open and the Autonomous view is connected.';
    case 'task_discovered':
      return `M22 task ${details.taskId} was created. Watching live progress now.`;
    case 'task_progress':
      return details.message;
    case 'proposal_approved':
      return `Proposal gate approved after verifying the only target is ${details.expectedPath}.`;
    case 'mutation_approved':
      return `Mutation gate approved after re-checking the bounded target ${details.expectedPath}.`;
    case 'delivery_approved':
      return 'Delivery gate approved after compile/tests, quality gate, diff review, and actual-worktree scope checks passed.';
    case 'draft_pull_request_created':
      return `Draft pull request created: ${details.pullRequestUrl}`;
    case 'engineering_commands_completed':
      return 'Synchronize, Status, and Daily Scrum completed against the delivered draft PR.';
    case 'flow_failed':
      return `Flow stopped safely: ${details.error}. Evidence will still be published.`;
    default:
      return `${event}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`;
  }
}

function record(event, details = {}) {
  const item = { at: new Date().toISOString(), event, ...details };
  flowEvents.push(item);
  console.log(`[m22-live] ${eventMessage(event, details)}`);
}

function run(command, args, options = {}) {
  const started = Date.now();
  const shell = options.shell ?? (process.platform === 'win32' && ['npm', 'npx', 'gh', 'ollama'].includes(command));
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 30 * 1024 * 1024,
  });
  const execution = {
    command: [command, ...args].join(' '),
    exitCode: result.status ?? (result.error ? 1 : 0),
    durationMs: Date.now() - started,
    stdout: redact(result.stdout).slice(-100_000),
    stderr: redact(result.stderr).slice(-100_000),
    error: result.error ? redact(result.error.message) : undefined,
  };
  commandResults.push(execution);
  return execution;
}

function runRequired(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${result.command} failed with exit ${result.exitCode}: ${result.stderr || result.error || result.stdout}`);
  }
  return result;
}

function runStep(label, command, args, options = {}) {
  console.log(`[m22-live] ${label}...`);
  const result = runRequired(command, args, options);
  console.log(`[m22-live] ${label} completed in ${(result.durationMs / 1000).toFixed(1)}s.`);
  return result;
}

function parseJsonResult(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}\n${result.stdout}`);
  }
}

async function readJson(file) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function taskRoot() {
  return path.join(repoRoot, '.ollama-agent', 'autonomous-tasks');
}

async function listIssueTasks() {
  let entries = [];
  try {
    entries = await fsp.readdir(taskRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const file = path.join(taskRoot(), entry.name, 'task.json');
    try {
      const task = await readJson(file);
      if (task.sourceIssue?.issueNumber === issueNumber && task.evidence?.includes('organization:m22')) tasks.push(task);
    } catch {
      // Ignore a record being atomically rewritten.
    }
  }
  return tasks.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

async function newestIssueTask() {
  const tasks = await listIssueTasks();
  return tasks[tasks.length - 1];
}

async function pollUntil(fn, { timeoutMs, intervalMs = 500, description }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last?.done) return last.value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}; last=${JSON.stringify(last?.value)}`);
}

function taskSignature(task) {
  return JSON.stringify({
    taskId: task?.taskId,
    state: task?.state,
    latestProgress: task?.latestProgress,
    proposalId: task?.pendingProposal?.proposalId,
    mutationRequestId: task?.pendingMutationApproval?.requestId,
    qualityGate: task?.qualityGate?.status,
    diffReview: task?.diffReview?.verdict,
    pullRequestUrl: task?.githubDelivery?.pullRequestUrl,
    ciState: task?.githubDelivery?.ci?.state,
    failure: task?.failure?.classification,
  });
}

function humanizeProgress(progress, state) {
  const value = String(progress || '');
  let match;
  if (value === 'preparing') return 'Preparing an isolated Git worktree and checking task integrity.';
  if (value.startsWith('approval_auto_approved gate=graph_dispatch')) return 'Governance dispatch check passed; starting the autonomous workflow.';
  if (value === 'running') return 'The governed autonomous workflow is running.';
  if (value === 'readiness_check') return 'Checking repository state, permissions, and execution readiness.';
  if (value === 'graph_execution') return 'Starting repository analysis, planning, implementation, review, and validation.';
  if ((match = /^graph_stage_started stage=(\S+) index=(\d+)\/(\d+) model=(\S+) provider=(\S+)$/.exec(value))) {
    const activities = {
      'repository-analyst': 'reading the repository and selecting relevant context',
      planner: 'designing the smallest safe implementation plan',
      implementer: 'drafting the exact repository change',
      reviewer: 'checking scope, correctness, and risk',
      validator: 'producing the final structured proposal',
    };
    return `Stage ${match[2]}/${match[3]} — ${match[1]} is ${activities[match[1]] || 'working'} using ${match[4]}.`;
  }
  if ((match = /^graph_stage_completed stage=(\S+) index=(\d+)\/(\d+) durationMs=(\d+)$/.exec(value))) {
    return `Stage ${match[2]}/${match[3]} — ${match[1]} completed in ${(Number(match[4]) / 1000).toFixed(1)}s.`;
  }
  if (value === 'proposal_generated') return 'A structured proposal was generated; the host is validating its shape and repository snapshot.';
  if ((match = /^proposal_operation_count operations=(\d+)$/.exec(value))) {
    return `The proposal contains ${match[1]} file operation${match[1] === '1' ? '' : 's'}.`;
  }
  if (value === 'proposal_ready') return 'The proposal is verified against the current Git snapshot and the approval gate is being prepared.';
  if (value.startsWith('approval_requested gate=proposal')) return 'The coding proposal is ready for approval in KarkeDikha.';
  if (value.startsWith('approval_requested gate=mutation')) return 'The repository mutation is ready for approval in KarkeDikha.';
  if (value === 'mutating') return 'Applying the approved change inside the isolated worktree.';
  if ((match = /^mutation_completed created=(\d+) modified=(\d+) deleted=(\d+)$/.exec(value))) {
    return `Repository change applied: ${match[1]} created, ${match[2]} modified, ${match[3]} deleted.`;
  }
  if (value === 'validating') return 'Running the approved compile and test commands.';
  if ((match = /^validation_completed commands=(\d+) failed=(\d+)$/.exec(value))) {
    return `Validation finished: ${match[1]} command${match[1] === '1' ? '' : 's'}, ${match[2]} failed.`;
  }
  if ((match = /^m16_gate_result status=(\S+) findings=(\d+)$/.exec(value))) {
    return `M16 quality gate ${match[1]} with ${match[2]} finding${match[2] === '1' ? '' : 's'}.`;
  }
  if (value === 'waiting_for_delivery_approval') return 'Validation and diff review passed; delivery approval is ready.';
  if (value) return value;
  return `Task state changed to ${state || 'unknown'}.`;
}

function reportTaskProgress(task) {
  const signature = taskSignature(task);
  if (signature === lastReportedTaskSignature) return false;
  lastReportedTaskSignature = signature;
  record('task_progress', {
    taskId: task.taskId,
    state: task.state,
    progress: task.latestProgress,
    message: humanizeProgress(task.latestProgress, task.state),
  });
  return true;
}

async function waitForTaskCondition({ description, isDone, intervalMs = 1000, stallTimeoutMs = taskStallTimeoutMs, totalTimeoutMs = taskTotalTimeoutMs }) {
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastNoticeAt = 0;
  let lastTask;
  while (Date.now() - startedAt < totalTimeoutMs) {
    const current = await newestIssueTask();
    if (current) {
      lastTask = current;
      if (reportTaskProgress(current)) lastProgressAt = Date.now();
      if (['blocked', 'failed', 'cancelled'].includes(current.state)) {
        const detail = current.validationFailure?.stdoutStderrTail || current.failure?.message || current.latestProgress;
        throw new Error(`Task ${current.state} while waiting for ${description}: ${current.failure?.classification || 'unknown'}: ${detail || 'no detail'}`);
      }
      if (isDone(current)) return current;
    }

    const idleMs = Date.now() - lastProgressAt;
    if (idleMs >= stallTimeoutMs) {
      throw new Error(
        `No meaningful task progress for ${Math.round(idleMs / 1000)}s while waiting for ${description}. ` +
        `Last state=${lastTask?.state || 'unknown'}, latestProgress=${JSON.stringify(lastTask?.latestProgress || '')}`,
      );
    }
    if (idleMs >= 60_000 && Date.now() - lastNoticeAt >= 60_000) {
      lastNoticeAt = Date.now();
      console.log(
        `[m22-live] Still waiting for ${description}. Last meaningful activity ${Math.round(idleMs / 1000)}s ago: ` +
        `${humanizeProgress(lastTask?.latestProgress, lastTask?.state)}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Exceeded the ${Math.round(totalTimeoutMs / 60_000)}-minute safety limit while waiting for ${description}. ` +
    `Last state=${lastTask?.state || 'unknown'}, latestProgress=${JSON.stringify(lastTask?.latestProgress || '')}`,
  );
}

function parseWorktrees(text) {
  const records = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  if (current) records.push(current);
  return records;
}

async function backupAndResetRuntime() {
  const backupRoot = path.join(repoRoot, '.ollama-agent', 'live-dogfood-backup', stamp);
  await fsp.mkdir(backupRoot, { recursive: true });

  const staleWorktrees = parseWorktrees(runRequired('git', ['worktree', 'list', '--porcelain']).stdout)
    .filter(record => record.branch?.startsWith(`refs/heads/forge/issue-${issueNumber}-`));
  for (const worktree of staleWorktrees) {
    const branch = worktree.branch.replace('refs/heads/', '');
    const openPr = parseJsonResult(runRequired('gh', ['pr', 'list', '--repo', repository, '--state', 'open', '--head', branch, '--json', 'number,url']), `open PR lookup for ${branch}`);
    if (openPr.length > 0) throw new Error(`Refusing to remove ${branch}; it has an open pull request: ${openPr[0].url}`);
    const diff = run('git', ['-C', worktree.path, 'diff', '--binary', 'HEAD']);
    await fsp.writeFile(path.join(backupRoot, `${branch.replace(/[^a-z0-9.-]+/gi, '_')}.patch`), diff.stdout, 'utf8');
    runRequired('git', ['worktree', 'remove', '--force', worktree.path]);
    run('git', ['branch', '-D', branch]);
    record('stale_worktree_archived', { branch, worktree: worktree.path });
  }
  run('git', ['worktree', 'prune']);

  let taskEntries = [];
  try {
    taskEntries = await fsp.readdir(taskRoot(), { withFileTypes: true });
  } catch {
    taskEntries = [];
  }
  for (const entry of taskEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const source = path.join(taskRoot(), entry.name);
    try {
      const task = await readJson(path.join(source, 'task.json'));
      const stale = task.sourceIssue?.issueNumber === issueNumber || String(task.goal || '').startsWith('Disposable packaged GitHub delivery');
      if (!stale) continue;
      const destination = path.join(backupRoot, 'autonomous-tasks', entry.name);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.rename(source, destination);
      record('stale_task_archived', { taskId: entry.name, state: task.state });
    } catch {
      // Leave unreadable foreign records untouched.
    }
  }

  const runtimePaths = [
    path.join(repoRoot, '.ollama-agent', 'engineering-organization'),
    path.join(repoRoot, '.ollama-agent', 'sprints'),
    path.join(repoRoot, '.ollama-agent', 'scrum'),
  ];
  for (const source of runtimePaths) {
    try {
      await fsp.stat(source);
    } catch {
      continue;
    }
    const destination = path.join(backupRoot, 'runtime', path.basename(source));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(source, destination);
    record('runtime_state_archived', { path: path.relative(repoRoot, source) });
  }
  return backupRoot;
}

function resetIssueToReady() {
  const issue = parseJsonResult(
    runRequired('gh', ['issue', 'view', String(issueNumber), '--repo', repository, '--json', 'number,title,state,labels,milestone']),
    'issue view',
  );
  if (issue.state !== 'OPEN') throw new Error(`Issue #${issueNumber} must be open`);
  const labels = issue.labels.map(label => label.name);
  const workflowLabels = ['ai-in-progress', 'ai-review', 'ai-blocked', 'ai-done'];
  const editArgs = ['issue', 'edit', String(issueNumber), '--repo', repository];
  for (const label of workflowLabels.filter(label => labels.includes(label))) editArgs.push('--remove-label', label);
  if (!labels.includes('ai-ready')) editArgs.push('--add-label', 'ai-ready');
  editArgs.push('--milestone', 'Current Sprint');
  runRequired('gh', editArgs);

  const ready = parseJsonResult(
    runRequired('gh', ['issue', 'list', '--repo', repository, '--state', 'open', '--label', 'ai-ready', '--json', 'number,title']),
    'ready issue list',
  );
  const unexpected = ready.filter(item => item.number !== issueNumber);
  if (unexpected.length > 0) {
    throw new Error(`Only issue #${issueNumber} may be ai-ready for this bounded run; also ready: ${unexpected.map(item => `#${item.number}`).join(', ')}`);
  }
  record('issue_ready', { issueNumber, title: issue.title });
}

function validateProposal(task) {
  const operations = task.pendingProposal?.operations ?? [];
  if (operations.length !== 1 || operations[0].path !== expectedPath) {
    throw new Error(`Proposal scope mismatch: ${JSON.stringify(operations)}`);
  }
}

function validateMutation(task) {
  const targets = task.pendingMutationApproval?.targets ?? [];
  if (targets.length !== 1 || targets[0] !== expectedPath) {
    throw new Error(`Mutation scope mismatch: ${JSON.stringify(targets)}`);
  }
}

function validateDelivery(task) {
  if (task.validationFailure) throw new Error(`Validation failed: ${task.validationFailure.stdoutStderrTail}`);
  if (task.qualityGate?.status !== 'passed') throw new Error(`Quality gate is not passed: ${JSON.stringify(task.qualityGate)}`);
  if (task.diffReview?.verdict !== 'pass') throw new Error(`Diff review is not passed: ${JSON.stringify(task.diffReview)}`);
  const approved = task.diffReview.approvedScopePaths ?? [];
  if (approved.length !== 1 || approved[0] !== expectedPath) throw new Error(`Delivery review scope mismatch: ${JSON.stringify(approved)}`);
  if (!task.worktreeLocation) throw new Error('Delivery task has no worktree location');
  const changed = runRequired('git', ['-C', task.worktreeLocation, 'status', '--porcelain=v1']).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.slice(3).trim());
  if (changed.length !== 1 || changed[0] !== expectedPath) throw new Error(`Actual worktree scope mismatch: ${JSON.stringify(changed)}`);
}

async function waitForCard(client, gate, taskId) {
  return pollUntil(async () => {
    const cards = await uiDriver.readCardOwnership(client);
    const prefix = gate === 'proposal' ? 'proposal' : gate === 'mutation' ? 'mutation' : 'delivery';
    const id = cards[`${prefix}CardTaskId`];
    const hidden = cards[`${prefix}CardHidden`];
    const disabled = cards[`${prefix}ApproveDisabled`];
    return id === taskId && hidden === false && disabled === false
      ? { done: true, value: cards }
      : { done: false, value: cards };
  }, { timeoutMs: 90_000, intervalMs: 500, description: `${gate} card for ${taskId}` });
}

async function clickDeliveryApprove(client) {
  await uiDriver.evalInWebviewDoc(client, `(() => {
    const btn = document.getElementById('delivery-approve-btn');
    if (!btn) throw new Error('delivery-approve-btn not found');
    if (btn.disabled) throw new Error('delivery-approve-btn disabled');
    btn.click();
    return true;
  })()`);
}

async function driveRealFlow() {
  await pollUntil(async () => {
    try {
      const status = await readJson(hostStatusFile);
      return status.phase === 'focused' || status.events?.some(event => event.phase === 'focused')
        ? { done: true, value: status }
        : { done: false, value: status.phase };
    } catch {
      return { done: false, value: undefined };
    }
  }, { timeoutMs: 90_000, description: 'Extension Host activation and KarkeDikha focus' });

  const client = await uiDriver.connectToWebviewHost(remoteDebuggingPort, { attempts: 180, delayMs: 500 });
  try {
    await uiDriver.waitForWebviewContentMounted(client, { timeoutMs: 90_000 });
    await uiDriver.clickAutonomousModeButton(client);
    record('webview_connected');

    const task = await pollUntil(async () => {
      const candidate = await newestIssueTask();
      return candidate ? { done: true, value: candidate } : { done: false, value: undefined };
    }, { timeoutMs: 180_000, description: `new M22 task for issue #${issueNumber}` });
    discoveredTaskId = task.taskId;
    record('task_discovered', { taskId: discoveredTaskId });
    reportTaskProgress(task);

    const proposalTask = await waitForTaskCondition({
      description: 'the coding-proposal approval gate',
      isDone: current => current.state === 'waiting_for_proposal_approval' && Boolean(current.pendingProposal),
    });
    validateProposal(proposalTask);
    await waitForCard(client, 'proposal', discoveredTaskId);
    await uiDriver.clickProposalApproveButton(client);
    record('proposal_approved', { taskId: discoveredTaskId, expectedPath });

    const mutationTask = await waitForTaskCondition({
      description: 'the repository-mutation approval gate',
      isDone: current => current.state === 'waiting_for_mutation_approval' && Boolean(current.pendingMutationApproval),
    });
    validateMutation(mutationTask);
    await waitForCard(client, 'mutation', discoveredTaskId);
    await uiDriver.clickMutationApproveButton(client);
    record('mutation_approved', { taskId: discoveredTaskId, expectedPath });

    const deliveryTask = await waitForTaskCondition({
      description: 'validated delivery approval',
      stallTimeoutMs: Math.max(taskStallTimeoutMs, 15 * 60_000),
      isDone: current => current.state === 'waiting_for_delivery_approval',
    });
    validateDelivery(deliveryTask);
    await waitForCard(client, 'delivery', discoveredTaskId);
    await clickDeliveryApprove(client);
    record('delivery_approved', { taskId: discoveredTaskId, expectedPath });

    const delivered = await waitForTaskCondition({
      description: 'draft pull request creation',
      isDone: current => Boolean(current.githubDelivery?.pullRequestUrl),
    });
    pullRequestUrl = delivered.githubDelivery.pullRequestUrl;
    if (delivered.githubDelivery.draft !== true) throw new Error(`Created pull request is not draft: ${pullRequestUrl}`);
    record('draft_pull_request_created', { pullRequestUrl, taskId: discoveredTaskId });

    await pollUntil(async () => {
      try {
        const status = await readJson(hostStatusFile);
        const event = status.events?.find(item => item.phase === 'post_delivery_commands_completed');
        return event ? { done: true, value: event } : { done: false, value: status.phase };
      } catch {
        return { done: false };
      }
    }, { timeoutMs: 10 * 60_000, description: 'Synchronize, Status, and Daily Scrum commands' });
    record('engineering_commands_completed', { pullRequestUrl });

    await uiDriver.captureFailureDiagnostics(client, evidenceDir, 'final-ui').catch(() => undefined);
    await fsp.writeFile(path.join(evidenceDir, 'final-card-ownership.json'), JSON.stringify(await uiDriver.readCardOwnership(client), null, 2));
    return delivered;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function collectEvidence(error) {
  const sourceBranch = run('git', ['branch', '--show-current']).stdout.trim();
  const sourceCommit = run('git', ['rev-parse', 'HEAD']).stdout.trim();

  await fsp.mkdir(path.join(evidenceDir, 'logs'), { recursive: true });
  for (let index = 0; index < commandResults.length; index += 1) {
    const result = commandResults[index];
    const content = [
      `$ ${result.command}`,
      `exitCode=${result.exitCode}`,
      `durationMs=${result.durationMs}`,
      '',
      '--- stdout ---',
      result.stdout,
      '',
      '--- stderr ---',
      result.stderr,
      result.error ? `\n--- error ---\n${result.error}` : '',
    ].join('\n');
    await fsp.writeFile(path.join(evidenceDir, 'logs', `${String(index + 1).padStart(2, '0')}.log`), content, 'utf8');
  }

  const tasks = await listIssueTasks();
  for (const task of tasks) {
    const source = path.join(taskRoot(), task.taskId);
    const target = path.join(evidenceDir, 'tasks', task.taskId);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.cp(source, target, { recursive: true }).catch(() => undefined);
  }
  for (const [name, source] of [
    ['organization.json', path.join(repoRoot, '.ollama-agent', 'engineering-organization', 'state.json')],
    ['sprint.json', path.join(repoRoot, '.ollama-agent', 'sprints', 'state.json')],
  ]) {
    await fsp.copyFile(source, path.join(evidenceDir, name)).catch(() => undefined);
  }

  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    status: error ? 'failed' : 'passed',
    issueNumber,
    repository,
    expectedPath,
    model,
    taskId: discoveredTaskId,
    pullRequestUrl,
    sourceBranch,
    sourceCommit,
    taskStallTimeoutMs,
    taskTotalTimeoutMs,
    flowEvents,
    commands: commandResults.map((result, index) => ({
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      log: `logs/${String(index + 1).padStart(2, '0')}.log`,
    })),
    error: error ? redact(error.stack || error.message || String(error)) : undefined,
    automaticMerge: false,
    humanMergeRequired: true,
  };
  await fsp.writeFile(path.join(evidenceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.writeFile(path.join(evidenceDir, 'summary.md'), [
    '# M22 live production dogfood',
    '',
    `- Result: **${manifest.status.toUpperCase()}**`,
    `- Issue: #${issueNumber}`,
    `- Task: ${discoveredTaskId ?? 'not created'}`,
    `- Draft PR: ${pullRequestUrl ?? 'not created'}`,
    `- Source commit: ${manifest.sourceCommit}`,
    error ? `- Failure: ${manifest.error}` : '- Proposal, mutation, validation, diff review, delivery, and draft-PR creation completed.',
    '- Human merge remains required.',
    '',
  ].join('\n'), 'utf8');
  await fsp.rm(latestEvidenceDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(latestEvidenceDir), { recursive: true });
  await fsp.cp(evidenceDir, latestEvidenceDir, { recursive: true });
  return manifest;
}

async function publishEvidence() {
  const publishRoot = path.join(os.tmpdir(), `oa-m22-live-publish-${stamp}-${process.pid}`);
  const remoteRef = `refs/heads/${evidenceBranch}`;
  const probe = run('git', ['ls-remote', '--exit-code', '--heads', 'origin', remoteRef]);
  let baseRef;
  if (probe.exitCode === 0) {
    runRequired('git', ['fetch', 'origin', `${remoteRef}:refs/remotes/origin/${evidenceBranch}`]);
    baseRef = `refs/remotes/origin/${evidenceBranch}`;
  } else {
    baseRef = runRequired('git', ['rev-parse', 'HEAD']).stdout.trim();
  }
  runRequired('git', ['worktree', 'add', '--detach', publishRoot, baseRef]);
  try {
    const root = path.join(publishRoot, 'evidence', 'm22-live-production');
    const runTarget = path.join(root, 'runs', stamp);
    const latestTarget = path.join(root, 'latest');
    await fsp.mkdir(path.dirname(runTarget), { recursive: true });
    await fsp.cp(evidenceDir, runTarget, { recursive: true });
    await fsp.rm(latestTarget, { recursive: true, force: true });
    await fsp.cp(evidenceDir, latestTarget, { recursive: true });
    runRequired('git', ['add', '-A', '--', 'evidence/m22-live-production'], { cwd: publishRoot });
    runRequired('git', ['-c', 'user.name=KarkeDikha Evidence Bot', '-c', 'user.email=karkedikha-evidence@example.invalid', 'commit', '-m', `chore(evidence): publish live M22 dogfood ${stamp}`], { cwd: publishRoot });
    runRequired('git', ['push', 'origin', `HEAD:${remoteRef}`], { cwd: publishRoot });
    return runRequired('git', ['rev-parse', 'HEAD'], { cwd: publishRoot }).stdout.trim();
  } finally {
    run('git', ['worktree', 'remove', '--force', publishRoot]);
    await fsp.rm(publishRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('--issue must be a positive integer');
  await fsp.mkdir(evidenceDir, { recursive: true });
  fs.rmSync(doneFlagFile, { force: true });

  let flowError;
  let hostPromise;
  try {
    record('preflight_started', { issueNumber, repository, expectedPath, model });
    runStep('Checking GitHub authentication', 'gh', ['auth', 'status']);
    runStep('Checking local Ollama models', 'ollama', ['list']);
    runStep('Compiling the extension', 'npm', ['run', 'compile']);
    runStep('Running the isolated-worktree dependency regression', 'npx', ['vitest', 'run', 'src/test/suite/codingValidationWorktreeDependencies.test.ts']);
    runStep('Running the M18–M22 headless acceptance suite', 'npm', ['run', 'test:e2e:m18-m22']);
    console.log('[m22-live] Archiving any previous issue-39 runtime state without deleting its evidence...');
    await backupAndResetRuntime();
    resetIssueToReady();

    console.log('[m22-live] Opening the real VS Code Extension Development Host...');
    hostPromise = runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(repoRoot, 'scripts', 'acceptance', 'm22LiveProductionDogfoodHost.js'),
      launchArgs: [
        repoRoot,
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
        OA_M22_LIVE_STATUS: hostStatusFile,
        OA_M22_LIVE_DONE_FLAG: doneFlagFile,
        OA_M22_LIVE_ISSUE: String(issueNumber),
        OA_M22_LIVE_EXPECTED_PATH: expectedPath,
        OA_M22_LIVE_MODEL: model,
      },
    });

    await driveRealFlow();
  } catch (error) {
    flowError = error instanceof Error ? error : new Error(String(error));
    record('flow_failed', { error: redact(flowError.message) });
  } finally {
    await fsp.mkdir(path.dirname(doneFlagFile), { recursive: true });
    await fsp.writeFile(doneFlagFile, '1', 'utf8');
    if (hostPromise) {
      try {
        await hostPromise;
      } catch (error) {
        if (!flowError) flowError = error instanceof Error ? error : new Error(String(error));
      }
    }
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(extensionsDir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log('[m22-live] Collecting and publishing privacy-safe evidence...');
  const manifest = await collectEvidence(flowError);
  const evidenceCommit = await publishEvidence();
  console.log(`\n[m22-live] Evidence branch: ${evidenceBranch}`);
  console.log(`[m22-live] Evidence commit: ${evidenceCommit}`);
  console.log('[m22-live] Latest manifest: evidence/m22-live-production/latest/manifest.json');
  if (manifest.pullRequestUrl) console.log(`[m22-live] Draft PR: ${manifest.pullRequestUrl}`);
  if (flowError) throw flowError;
  console.log('[m22-live] Live dogfood completed. The draft PR is ready for human review; nothing was merged automatically.');
}

main().catch(error => {
  console.error(`[m22-live] ${redact(error.stack || error.message || String(error))}`);
  process.exitCode = 1;
});
