#!/usr/bin/env node

import { spawnSync } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const issueNumber = Number(argValue('--issue', '39'));
const evidenceBranch = argValue('--branch', 'evidence/m22-review');
const quick = args.includes('--quick');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const localRunDir = path.join(repoRoot, '.acceptance-evidence', 'm22-review', stamp);
const latestLocalDir = path.join(repoRoot, '.acceptance-evidence', 'm22-review', 'latest');
const maxLogChars = 60_000;

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(command, commandArgs, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return {
    command: [command, ...commandArgs].join(' '),
    exitCode: result.status ?? (result.error ? 1 : 0),
    durationMs: Date.now() - started,
    stdout: redactText(stdout).slice(-maxLogChars),
    stderr: redactText(stderr).slice(-maxLogChars),
    error: result.error ? redactText(result.error.message) : undefined,
  };
}

function git(commandArgs, options = {}) {
  return run('git', commandArgs, options);
}

function redactText(value) {
  return String(value)
    .replace(/authorization:\s*\S+/gi, 'authorization: [redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"']+/gi, '$1=[redacted]')
    .replace(/\bgh[opusr]_[A-Za-z0-9_]+\b/g, '[redacted-github-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[redacted-api-key]');
}

function redactObject(value, key = '') {
  if (/token|secret|password|authorization|api[_-]?key/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redactObject(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactObject(child, childKey)]));
  }
  return typeof value === 'string' ? redactText(value) : value;
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function collectTasks() {
  const root = path.join(repoRoot, '.ollama-agent', 'autonomous-tasks');
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const taskDir = path.join(root, entry.name);
    const task = await readJsonIfPresent(path.join(taskDir, 'task.json'));
    if (!task) continue;
    if (Number.isFinite(issueNumber) && task.sourceIssue?.issueNumber !== issueNumber) continue;
    let events = [];
    try {
      events = (await fsp.readFile(path.join(taskDir, 'events.jsonl'), 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
    } catch {
      events = [];
    }
    tasks.push({ task: redactObject(task), events: redactObject(events) });
  }
  return tasks.sort((a, b) => String(a.task.createdAt).localeCompare(String(b.task.createdAt)));
}

function testPlan() {
  const npm = executable('npm');
  const npx = executable('npx');
  const focused = [
    {
      name: 'compile',
      command: npm,
      args: ['run', 'compile'],
    },
    {
      name: 'worktree dependency projection regression',
      command: npx,
      args: ['vitest', 'run', 'src/test/suite/codingValidationWorktreeDependencies.test.ts'],
    },
    {
      name: 'M18-M22 headless end-to-end',
      command: npm,
      args: ['run', 'test:e2e:m18-m22'],
    },
  ];
  if (quick) return focused;
  return [
    ...focused,
    {
      name: 'full unit and integration suite',
      command: npm,
      args: ['test'],
    },
    {
      name: 'packaged production webview approval cycle',
      command: npm,
      args: ['run', 'test:dogfood:approval-cycle'],
    },
  ];
}

async function writeEvidence(results, snapshot) {
  await fsp.rm(localRunDir, { recursive: true, force: true });
  await fsp.mkdir(path.join(localRunDir, 'logs'), { recursive: true });

  for (const result of results) {
    const safeName = result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const body = [
      `$ ${result.execution.command}`,
      `exitCode=${result.execution.exitCode}`,
      `durationMs=${result.execution.durationMs}`,
      '',
      '--- stdout ---',
      result.execution.stdout,
      '',
      '--- stderr ---',
      result.execution.stderr,
      result.execution.error ? `\n--- spawn error ---\n${result.execution.error}` : '',
      '',
    ].join('\n');
    await fsp.writeFile(path.join(localRunDir, 'logs', `${safeName}.log`), body, 'utf8');
  }

  const passed = results.every(item => item.execution.exitCode === 0);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: passed ? 'passed' : 'failed',
    issueNumber,
    source: snapshot.source,
    tests: results.map(item => ({
      name: item.name,
      command: item.execution.command,
      exitCode: item.execution.exitCode,
      durationMs: item.execution.durationMs,
      log: `logs/${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.log`,
    })),
    tasks: snapshot.tasks,
    organization: snapshot.organization,
    sprint: snapshot.sprint,
    worktrees: snapshot.worktrees,
    issueBranches: snapshot.issueBranches,
  };
  await fsp.writeFile(path.join(localRunDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const taskLines = snapshot.tasks.length
    ? snapshot.tasks.map(({ task }) => `- ${task.taskId}: ${task.state}${task.failure ? ` — ${task.failure.classification}: ${task.failure.message}` : ''}`)
    : ['- No matching durable tasks found.'];
  const summary = [
    '# M22 review-loop evidence',
    '',
    `- Generated: ${manifest.generatedAt}`,
    `- Result: **${manifest.status.toUpperCase()}**`,
    `- Issue: #${issueNumber}`,
    `- Source branch: ${snapshot.source.branch}`,
    `- Source commit: ${snapshot.source.head}`,
    `- Published branch: ${evidenceBranch}`,
    '',
    '## Tests',
    '',
    ...manifest.tests.map(test => `- ${test.exitCode === 0 ? 'PASS' : 'FAIL'} — ${test.name} (${test.durationMs} ms)`),
    '',
    '## Matching autonomous tasks',
    '',
    ...taskLines,
    '',
    '## Safety',
    '',
    '- No merge is performed.',
    '- No approval gate is bypassed.',
    '- Evidence is redacted and bounded before publication.',
    '',
  ].join('\n');
  await fsp.writeFile(path.join(localRunDir, 'summary.md'), summary, 'utf8');

  await fsp.rm(latestLocalDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(latestLocalDir), { recursive: true });
  await fsp.cp(localRunDir, latestLocalDir, { recursive: true });
  return manifest;
}

async function publishEvidence() {
  const publishRoot = path.join(os.tmpdir(), `karkedikha-m22-evidence-${Date.now()}-${process.pid}`);
  const remoteRef = `refs/heads/${evidenceBranch}`;
  const remoteProbe = git(['ls-remote', '--exit-code', '--heads', 'origin', remoteRef]);
  let baseRef;
  if (remoteProbe.exitCode === 0) {
    const fetched = git(['fetch', 'origin', `${remoteRef}:refs/remotes/origin/${evidenceBranch}`]);
    if (fetched.exitCode !== 0) throw new Error(`Unable to fetch ${evidenceBranch}: ${fetched.stderr}`);
    baseRef = `refs/remotes/origin/${evidenceBranch}`;
  } else {
    const head = git(['rev-parse', 'HEAD']);
    if (head.exitCode !== 0) throw new Error(`Unable to resolve source HEAD: ${head.stderr}`);
    baseRef = head.stdout.trim();
  }

  const added = git(['worktree', 'add', '--detach', publishRoot, baseRef]);
  if (added.exitCode !== 0) throw new Error(`Unable to create evidence worktree: ${added.stderr}`);
  try {
    const targetRoot = path.join(publishRoot, 'evidence', 'm22-review');
    const runTarget = path.join(targetRoot, 'runs', stamp);
    const latestTarget = path.join(targetRoot, 'latest');
    await fsp.mkdir(path.dirname(runTarget), { recursive: true });
    await fsp.cp(localRunDir, runTarget, { recursive: true });
    await fsp.rm(latestTarget, { recursive: true, force: true });
    await fsp.cp(localRunDir, latestTarget, { recursive: true });

    const add = git(['add', '-A', '--', 'evidence/m22-review'], { cwd: publishRoot });
    if (add.exitCode !== 0) throw new Error(`Unable to stage evidence: ${add.stderr}`);
    const commit = git([
      '-c', 'user.name=KarkeDikha Evidence Bot',
      '-c', 'user.email=karkedikha-evidence@example.invalid',
      'commit', '-m', `chore(evidence): publish M22 review ${stamp}`,
    ], { cwd: publishRoot });
    if (commit.exitCode !== 0) throw new Error(`Unable to commit evidence: ${commit.stderr}`);
    const push = git(['push', 'origin', `HEAD:${remoteRef}`], { cwd: publishRoot });
    if (push.exitCode !== 0) throw new Error(`Unable to publish evidence: ${push.stderr}`);
    return git(['rev-parse', 'HEAD'], { cwd: publishRoot }).stdout.trim();
  } finally {
    git(['worktree', 'remove', '--force', publishRoot]);
    await fsp.rm(publishRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('--issue must be a positive integer.');
  await fsp.mkdir(localRunDir, { recursive: true });

  const sourceBranch = git(['branch', '--show-current']);
  const sourceHead = git(['rev-parse', 'HEAD']);
  const sourceStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const worktrees = git(['worktree', 'list', '--porcelain']);
  const issueBranches = git(['branch', '--list', `forge/issue-${issueNumber}-*`]);

  const results = [];
  for (const test of testPlan()) {
    console.log(`\n[m22-review-loop] Running: ${test.name}`);
    const execution = run(test.command, test.args);
    results.push({ name: test.name, execution });
    console.log(`[m22-review-loop] ${execution.exitCode === 0 ? 'PASS' : 'FAIL'}: ${test.name}`);
  }

  const snapshot = {
    source: {
      branch: sourceBranch.stdout.trim(),
      head: sourceHead.stdout.trim(),
      status: sourceStatus.stdout.split(/\r?\n/).filter(Boolean).map(redactText),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    tasks: await collectTasks(),
    organization: redactObject(await readJsonIfPresent(path.join(repoRoot, '.ollama-agent', 'engineering-organization', 'state.json'))),
    sprint: redactObject(await readJsonIfPresent(path.join(repoRoot, '.ollama-agent', 'sprints', 'state.json'))),
    worktrees: redactText(worktrees.stdout),
    issueBranches: redactText(issueBranches.stdout),
  };

  const manifest = await writeEvidence(results, snapshot);
  const commit = await publishEvidence();
  console.log(`\n[m22-review-loop] Evidence published.`);
  console.log(`[m22-review-loop] Branch: ${evidenceBranch}`);
  console.log(`[m22-review-loop] Commit: ${commit}`);
  console.log(`[m22-review-loop] Latest manifest: evidence/m22-review/latest/manifest.json`);
  process.exitCode = manifest.status === 'passed' ? 0 : 1;
}

main().catch(error => {
  console.error(`[m22-review-loop] ${redactText(error instanceof Error ? error.stack ?? error.message : String(error))}`);
  process.exitCode = 1;
});
