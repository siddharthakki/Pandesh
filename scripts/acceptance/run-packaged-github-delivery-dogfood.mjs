#!/usr/bin/env node
import { execFile, execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { runTests } from '@vscode/test-electron';
import * as ui from './uiDriver.mjs';
import { allocateDebugPort } from './plainVsCodeHost.mjs';

const OPT_IN = 'OA_M17_PACKAGED_GITHUB_DELIVERY_DOGFOOD';
const FAKE_OPT_IN = 'OA_M17_PACKAGED_FAKE_DELIVERY_DOGFOOD';
const REPOSITORY = 'siddharthakki/ollama-agent';
const BASE = 'dogfood/m17';
const fakeTransport = process.env[FAKE_OPT_IN] === '1';
const realTransport = process.env[OPT_IN] === '1';
if (fakeTransport === realTransport) {
  console.error(`Select exactly one packaged delivery mode: ${FAKE_OPT_IN}=1 (safe boundary proof) or ${OPT_IN}=1 (real GitHub).`);
  process.exit(2);
}

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const runId = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
const branch = `dogfood/m17-packaged-${runId}`;
const marker = `m17-packaged-github-delivery-${runId}.txt`;
const temp = path.join(os.tmpdir(), `oa-m17-packaged-github-${runId}`);
const sandboxRepository = path.join(temp, 'repository');
const evidenceDir = path.join(root, '.acceptance-evidence', fakeTransport ? 'm17-packaged-delivery-boundary' : 'm17-packaged-github-delivery', runId);
const statusFile = path.join(evidenceDir, 'host-status.json');
const doneFile = path.join(temp, 'driver-done');
const evidence = { runId, taskId: undefined, transport: fakeTransport ? 'fake' : 'gh-cli', sourceRepository: REPOSITORY, baseBranch: BASE, branch, markerPath: marker, final: 'failed', cleanupErrors: [] };
let queue, worktrees, task, client, prNumber, prUrl, commitSha, hostPromise, hostError, acceptance;

async function command(binary, args, cwd = root) {
  const result = await exec(binary, args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
const git = (args, cwd = root) => command('git', args, cwd);
const gh = args => command('gh', args, root);
function writeEvidence() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
function packageVsix(out) {
  const vsce = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
  const result = spawnSync(vsce, ['package', '--out', out], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
  if (result.status !== 0) throw new Error(`VSIX packaging failed (${result.status})`);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  fs.mkdirSync(path.join(temp, 'extracted'), { recursive: true });
  execFileSync(tar, ['-xf', out, '-C', path.join(temp, 'extracted')], { stdio: 'inherit' });
}
function compileExtension() {
  const result = spawnSync('npm', ['run', 'compile'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`TypeScript compilation failed (${result.status})`);
}
async function readPr(number) {
  return JSON.parse(await gh(['pr', 'view', String(number), '--repo', REPOSITORY, '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergedAt']));
}
async function poll(fn, description, timeout = 120000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    if (hostError) throw hostError;
    try { last = await fn(); if (last) return last; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(last)}`);
}

try {
  delete process.env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const remote = (await git(['remote', 'get-url', 'origin'])).replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  if (remote !== `https://github.com/${REPOSITORY}`) throw new Error('Origin is outside the exact repository allowlist.');
  const configuredBase = BASE;
  if (configuredBase !== 'dogfood/m17') throw new Error(`Refusing unexpected base branch: ${configuredBase}`);
  if (realTransport) await command('gh', ['auth', 'status'], root);
  const baseRef = realTransport ? `refs/remotes/origin/${BASE}` : `refs/heads/${BASE}`;
  await git(['show-ref', '--verify', '--quiet', baseRef]);
  const baseSha = await git(['rev-parse', baseRef]);
  compileExtension();
  acceptance = await import('../../out/acceptance/M17GitHubDeliveryDogfood.js');
  await command('git', ['clone', '--no-checkout', '--local', root, sandboxRepository], root);
  await git(['checkout', '--detach', baseSha], sandboxRepository);
  await git(['remote', 'set-url', 'origin', `https://github.com/${REPOSITORY}.git`], sandboxRepository);
  await git(['config', 'user.email', 'm17-packaged-dogfood@example.invalid'], sandboxRepository);
  await git(['config', 'user.name', 'M17 Packaged Dogfood'], sandboxRepository);

  const autonomous = await import('../../out/autonomous/M15AutonomousWork.js');
  const fingerprinting = await import('../../out/coding/ChangeScopeReconciliation.js');
  queue = new autonomous.DurableTaskQueue(sandboxRepository);
  worktrees = new autonomous.IsolatedWorktreeManager(sandboxRepository);
  task = await queue.enqueue({
    ...autonomous.createDefaultAutonomousTask(sandboxRepository, `Disposable packaged GitHub delivery ${runId}`),
    taskId: `m17_packaged_${runId}`,
    origin: 'github-issue', repositoryId: REPOSITORY,
    sourceIssue: { owner: 'siddharthakki', repo: 'ollama-agent', issueNumber: 0 },
    validationRequirements: [{ command: 'marker-content-check', required: true }],
    githubDelivery: fakeTransport ? { transport: 'fake' } : { transport: 'gh-cli', remote: 'origin', baseBranch: BASE },
  });
  evidence.taskId = task.taskId;
  ({ task } = await worktrees.bind(task, branch));
  await fsp.writeFile(path.join(task.worktreeLocation, marker), `Disposable M17 packaged delivery marker ${runId}\n`, 'utf8');
  const diff = await git(['diff', 'HEAD'], task.worktreeLocation);
  const reviewedDiffFingerprint = await fingerprinting.computeReviewedContentFingerprint(task.worktreeLocation, diff, [marker]);
  task = await queue.update({
    ...task, state: 'waiting_for_delivery_approval', evidence: [...task.evidence, 'validation:passed'],
    qualityGate: { gateId: 'm15-autonomous-delivery-quality-gate', runId, status: 'passed', findingsCount: 0, decidedAt: new Date().toISOString() },
    diffReview: { verdict: 'pass', requirementFindings: [], changedFileFindings: [], validationFindings: [], securityFindings: [], explanation: 'Disposable marker reviewed.', reviewerProvider: 'deterministic-host', reviewerModel: 'deterministic', decidedAt: new Date().toISOString(), approvedScopePaths: [marker], reviewedDiffFingerprint },
  }, 'm17_packaged_delivery_ready', { runId, branch, marker });
  await worktrees.assertBinding(task);
  evidence.disposableWorktree = task.worktreeLocation;
  writeEvidence();

  const vsix = path.join(temp, 'karkedikha-m17-packaged.vsix');
  packageVsix(vsix);
  const extracted = path.join(temp, 'extracted', 'extension');
  const port = allocateDebugPort();
  hostPromise = runTests({
    extensionDevelopmentPath: extracted,
    extensionTestsPath: path.join(here, 'packagedGitHubDeliveryDogfoodHost.js'),
    launchArgs: [sandboxRepository, '--disable-workspace-trust', '--disable-updates', '--disable-telemetry', '--skip-welcome', '--skip-release-notes', '--user-data-dir', path.join(temp, 'profile'), '--extensions-dir', path.join(temp, 'extensions'), `--remote-debugging-port=${port}`],
    extensionTestsEnv: { ...process.env, OA_M17_PACKAGED_TASK_ID: task.taskId, OA_M17_PACKAGED_STATUS: statusFile, OA_M17_PACKAGED_DONE: doneFile },
  }).catch(error => {
    hostError = error;
    evidence.hostException = { name: error?.name, message: error?.message ?? String(error), stack: error?.stack };
  });
  await poll(() => fs.existsSync(statusFile) && JSON.parse(fs.readFileSync(statusFile, 'utf8')).phase === 'focused', 'packaged host focus', 45000);
  client = await ui.connectToWebviewHost(port);
  await ui.waitForWebviewContentMounted(client);
  await ui.clickAutonomousModeButton(client);
  const ownership = await poll(async () => {
    const value = await ui.readCardOwnership(client);
    return value.deliveryCardTaskId === task.taskId ? value : undefined;
  }, 'delivery card ownership', 30000);
  const dom = await ui.readApprovalCycleDom(client);
  if (dom.deliveryCardHidden !== false || dom.deliveryApproveDisabled !== false) throw new Error('Real delivery approval card was not visible and enabled.');
  if ((!dom.proposalCardHidden && !dom.proposalApproveDisabled) || (!dom.mutationCardHidden && !dom.mutationApproveDisabled)) throw new Error('A stale proposal or mutation control remained actionable.');
  evidence.webview = { ownership, dom };
  await ui.instrumentWebviewPostMessage(client);
  await ui.probeClickButton(client, 'delivery-approve-btn');
  const approvalMessages = await poll(async () => {
    evidence.webview.outboundAfterClick = await ui.readInstrumentedPostedMessages(client);
    const messages = evidence.webview.outboundAfterClick.filter(message => message?.type === 'approveAutonomousDelivery');
    return messages.length ? messages : undefined;
  }, 'outbound delivery approval message', 5000);
  if (approvalMessages.length !== 1 || approvalMessages[0].taskId !== task.taskId) {
    throw new Error(`Expected one real approveAutonomousDelivery message for ${task.taskId}.`);
  }
  const stateAfterClick = await poll(async () => {
    const current = await queue.get(task.taskId);
    return current && current.state !== 'waiting_for_delivery_approval' ? current : undefined;
  }, 'persisted task to leave delivery approval', 30000);
  evidence.persistedStateAfterClick = stateAfterClick.state;
  task = await poll(async () => { const current = await queue.get(task.taskId); return current?.state === 'completed' ? current : undefined; }, 'runtime delivery completion', 120000);
  commitSha = task.githubDelivery.commitSha; prNumber = task.githubDelivery.pullRequestNumber; prUrl = task.githubDelivery.pullRequestUrl;
  if (fakeTransport) {
    if (!commitSha) throw new Error('Fake delivery did not persist the commit SHA.');
    evidence.commitSha = commitSha;
    evidence.final = 'passed';
  } else {
  if (!commitSha || !prNumber || !prUrl) throw new Error('Persisted delivery metadata is incomplete.');
  evidence.commitSha = commitSha; evidence.pullRequestNumber = prNumber; evidence.pullRequestUrl = prUrl;
  const open = await readPr(prNumber);
  acceptance.assertAuthoritativePullRequest(open, { number: prNumber, url: prUrl, baseBranch: BASE, headBranch: branch, commitSha });
  evidence.authoritativeOpen = open;
  await gh(['pr', 'close', String(prNumber), '--repo', REPOSITORY]);
  const closed = await readPr(prNumber);
  acceptance.assertAuthoritativePullRequest(closed, { number: prNumber, url: prUrl, baseBranch: BASE, headBranch: branch, commitSha, closed: true });
  evidence.authoritativeClosed = closed;
  await git(['push', 'origin', '--delete', branch]);
  evidence.remoteBranchDeletion = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])) === '';
  if (!evidence.remoteBranchDeletion) throw new Error('Disposable remote branch still exists.');
  evidence.final = 'passed';
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  if (client) {
    try { evidence.webviewTransportMessages = await ui.readInstrumentedPortMessages(client); } catch (captureError) {
      evidence.cleanupErrors.push(`capture-webview-transport: ${captureError instanceof Error ? captureError.message : String(captureError)}`);
    }
    try { evidence.webviewInboundMessages = await ui.readInstrumentedInboundMessages(client); } catch (captureError) {
      evidence.cleanupErrors.push(`capture-webview-inbound: ${captureError instanceof Error ? captureError.message : String(captureError)}`);
    }
  }
  if (task && queue) {
    try { evidence.persistedTaskAtFailure = await queue.get(task.taskId); } catch (captureError) {
      evidence.cleanupErrors.push(`capture-task-failure: ${captureError instanceof Error ? captureError.message : String(captureError)}`);
    }
  }
  process.exitCode = 1;
} finally {
  const cleanup = async (label, action) => { try { await action(); } catch (error) { evidence.cleanupErrors.push(`${label}: ${error.message}`); } };
  let cleanupAuthorized = true;
  if (acceptance) {
    try {
      acceptance.assertRunOwnedCleanupTargets(
        { runId, branch, worktree: task?.worktreeLocation },
        { runId: evidence.runId, branch: evidence.branch, worktree: evidence.disposableWorktree },
      );
    } catch (error) {
      cleanupAuthorized = false;
      evidence.cleanupErrors.push(`authorize-cleanup: ${error.message}`);
    }
  }
  if (cleanupAuthorized && prNumber) await cleanup('close-pr', async () => { const pr = await readPr(prNumber); if (pr.state === 'OPEN') await gh(['pr', 'close', String(prNumber), '--repo', REPOSITORY]); });
  if (cleanupAuthorized && realTransport) await cleanup('delete-remote-branch', async () => { if ((await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])) !== '') await git(['push', 'origin', '--delete', branch]); });
  if (cleanupAuthorized && task) await cleanup('remove-worktree', async () => {
    await worktrees.finalize(task, 'failed', { dispose: true });
    if (fs.existsSync(task.worktreeLocation)) await git(['worktree', 'remove', '--force', task.worktreeLocation], sandboxRepository);
  });
  if (cleanupAuthorized) await cleanup('remove-local-branch', async () => { if (fs.existsSync(sandboxRepository) && (await git(['branch', '--list', branch], sandboxRepository)) !== '') await git(['branch', '-D', branch], sandboxRepository); });
  evidence.worktreeCleanup = !task?.worktreeLocation || !fs.existsSync(task.worktreeLocation);
  evidence.localBranchDeletion = !fs.existsSync(sandboxRepository) || (await git(['branch', '--list', branch], sandboxRepository).catch(() => branch)) === '';
  evidence.remoteBranchDeletion = fakeTransport || (await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).catch(() => branch)) === '';
  if (client) await cleanup('close-cdp', () => client.close());
  fs.mkdirSync(path.dirname(doneFile), { recursive: true }); fs.writeFileSync(doneFile, '1');
  if (hostPromise) await cleanup('host-exit', () => hostPromise);
  if (fs.existsSync(statusFile)) {
    await cleanup('read-host-status', async () => { evidence.hostStatus = JSON.parse(await fsp.readFile(statusFile, 'utf8')); });
  }
  writeEvidence();
  await cleanup('remove-temp', () => fsp.rm(temp, { recursive: true, force: true, maxRetries: 3 }));
}

if (evidence.final === 'passed' && evidence.cleanupErrors.length === 0 && evidence.worktreeCleanup && evidence.localBranchDeletion && evidence.remoteBranchDeletion) {
  console.log(JSON.stringify(evidence, null, 2));
} else {
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
}
