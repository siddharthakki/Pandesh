#!/usr/bin/env node
import process from 'process';

const mode = process.argv[2] ?? 'run';
if (!['run', 'sync', 'status'].includes(mode)) {
  console.error('Usage: node scripts/m18-scrum-team.mjs [run|sync|status]');
  process.exit(2);
}
if (mode !== 'status' && process.env.OA_M18_SCRUM_TEAM !== '1') {
  console.error('Refusing GitHub board mutation without OA_M18_SCRUM_TEAM=1.');
  process.exit(2);
}

const root = process.cwd();
const autonomous = await import('../out/autonomous/M15AutonomousWork.js');
const scrum = await import('../out/scrum/M18AutonomousScrum.js');
const scrumCliConfig = await import('../out/scrum/M18ScrumCliConfig.js');

function env(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parseValidationCommands() {
  const raw = env('OA_M18_VALIDATION_COMMANDS');
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
    throw new Error('OA_M18_VALIDATION_COMMANDS must be a JSON array of command strings.');
  }
  return parsed;
}

const queue = new autonomous.DurableTaskQueue(root);
const board = new scrum.GhCliScrumBoardTransport(root);
const coordinator = new scrum.AutonomousScrumCoordinator({
  repositoryRoot: root,
  queue,
  board,
  runtime: {
    wake() {
      // A running extension host polls the durable queue every 45 seconds. If it is
      // not running, normal activation recovery will claim the queued story later.
    },
  },
  repository: env('OA_M18_SCRUM_REPOSITORY'),
  baseBranch: env('OA_M18_SCRUM_BASE_BRANCH'),
  labels: scrumCliConfig.resolveM18ScrumLabelOverrides(process.env),
  validationCommands: parseValidationCommands(),
});

let result;
if (mode === 'run') result = await coordinator.runNextReadyStory();
else if (mode === 'sync') result = await coordinator.syncBoard();
else {
  result = (await coordinator.status()).map(task => ({
    taskId: task.taskId,
    state: task.state,
    goal: task.goal,
    issue: task.sourceIssue ? `${task.sourceIssue.owner}/${task.sourceIssue.repo}#${task.sourceIssue.issueNumber}` : undefined,
    branch: task.branchName,
    pullRequestUrl: task.githubDelivery.pullRequestUrl,
    failure: task.failure,
  }));
}

console.log(JSON.stringify(result, null, 2));
