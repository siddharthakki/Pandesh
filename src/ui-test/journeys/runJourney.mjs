import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VSBrowser } from 'vscode-extension-tester';
import { EvidenceCollector } from '../evidence/EvidenceCollector.mjs';
import { KarkeDikhaView } from '../page-objects/KarkeDikhaView.mjs';
import { loadJourney } from '../support/contract.mjs';
import { coreEvidence, routeCounters, taskEvidence, waitForTask } from '../support/runtimeEvidence.mjs';
import { runP1LifecycleJourney } from './lifecycleDriver.mjs';

const terminalStates = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const requiredEnv = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required guardian environment variable ${name}`);
  return path.resolve(value);
};
const git = (workspace, args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();

async function driveVisibleApprovals(view, workspace, taskId) {
  const resolved = new Set();
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const { task } = taskEvidence(workspace, taskId);
    if (terminalStates.has(task.state)) return task;
    if (task.state === 'waiting_for_proposal_approval' && task.pendingProposal) {
      const key = `proposal:${task.pendingProposal.proposalId}`;
      if (!resolved.has(key)) {
        await view.clickVisibleApproval('proposal');
        resolved.add(key);
      }
    } else if (task.state === 'waiting_for_mutation_approval' && task.pendingMutationApproval) {
      const key = `mutation:${task.pendingMutationApproval.requestId}`;
      if (!resolved.has(key)) {
        await view.clickVisibleApproval('mutation');
        resolved.add(key);
      }
    } else if (task.state === 'waiting_for_delivery_approval') {
      const key = `delivery:${task.instructionRevision ?? 0}:${task.diffReview?.reviewedDiffFingerprint ?? 'pending'}`;
      if (!resolved.has(key)) {
        await view.clickVisibleApproval('delivery');
        resolved.add(key);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out driving visible approvals for ${taskId}`);
}

function assertAcknowledgement(snapshot, journey) {
  assert.equal(snapshot.userCount, 1, 'exactly one visible user message is required');
  assert.equal(snapshot.responseCount, 1, 'exactly one visible KarkeDikha task response is required');
  assert.equal(snapshot.requestBeforeResponse, true, 'user message must precede the task response');
  assert.equal(snapshot.responseVisible, true, 'task response must be visible');
  assert.equal(snapshot.detailsCount, 1, 'exactly one Details disclosure is required');
  assert.equal(snapshot.detailsOpen, false, 'Details must be collapsed by default');
  assert.equal(snapshot.pandaVisible, true, 'prominent panda must be visible');
  assert.equal(snapshot.pandaWidth, '72px', 'prominent task panda must render at 72px');
  assert.equal(snapshot.primaryAction, 'Stop', 'inline Stop must be visible after acknowledgement');
  assert.equal(snapshot.primaryTaskId, snapshot.taskId, 'inline Stop must carry the exact acknowledged task ID');
  assert.match(snapshot.requestText, new RegExp(journey.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(snapshot.responseIdentity, `kd-task-message-${snapshot.taskId}`);
  assert.doesNotMatch(snapshot.bodyText, /Stage 1\/5/);
  assert.doesNotMatch(snapshot.bodyText, /qwen3-coder:30b/);
}

function assertGitAndFiles(workspace, initialBranch, result) {
  if (result.file) {
    const target = path.join(workspace, result.file);
    assert.equal(fs.existsSync(target), true, `${result.file} must exist in the open repository`);
    assert.equal(fs.readFileSync(target, 'utf8'), result.content, `${result.file} raw content must match exactly`);
  }
  if (result.absentFile) {
    assert.equal(fs.existsSync(path.join(workspace, result.absentFile)), false, `${result.absentFile} must be absent`);
  }
  assert.equal(git(workspace, ['status', '--porcelain=v1']), '', 'workspace Git status must be clean');
  assert.equal(git(workspace, ['branch', '--show-current']), initialBranch, 'workspace branch must remain unchanged');
}

function collectFileListing(root) {
  const output = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(absolute);
      else output.push(relative);
    }
  };
  walk(root);
  return output.sort();
}

function collectFileManifest(root) {
  return collectFileListing(root).map(relative => {
    const bytes = fs.readFileSync(path.join(root, relative));
    return {
      path: relative,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

function changedPaths(workspace) {
  return git(workspace, ['status', '--porcelain=v1'])
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.slice(3).trim().replace(/^"|"$/g, ''))
    .sort();
}

async function runP0Lifecycle({ journey, workspace, evidenceDir, coreDataDir, initialBranch, view, evidence }) {
  const phase = process.env.GUARDIAN_PHASE || 'primary';
  const phaseStatePath = path.join(evidenceDir, 'p0-phase-state.json');
  await view.open();
  await evidence.screenshot(`${phase}-open`);

  if (phase === 'restore') {
    if (!fs.existsSync(phaseStatePath)) throw new Error('P0 restore phase is missing primary phase evidence');
    const beforeClose = JSON.parse(fs.readFileSync(phaseStatePath, 'utf8'));
    const restored = await view.snapshot();
    assert.equal(restored.userCount, beforeClose.userCount, 'completed user messages must restore exactly once');
    assert.equal(restored.assistantCount, beforeClose.assistantCount, 'completed ordinary answers must restore exactly once');
    assert.equal(restored.responseCount, beforeClose.responseCount, 'completed task response must restore exactly once');
    assert.equal(restored.primaryAction, 'Send', 'reopened composer must be usable');
    assert.equal(restored.primaryTaskId, null, 'completed task must not resurrect');
    assert.equal(restored.actionableApprovals, 0, 'completed approvals must not become actionable again');
    assertGitAndFiles(workspace, initialBranch, { files: journey.result.files });
    for (const expected of journey.result.files) {
      assert.equal(fs.readFileSync(path.join(workspace, expected.path), 'utf8'), expected.content);
    }
    evidence.json('dom-reopened.json', restored);
    evidence.text('git-status.txt', git(workspace, ['status', '--porcelain=v1', '--branch']) + '\n');
    evidence.text('git-log.txt', git(workspace, ['log', '--oneline', '--decorate', '-20']) + '\n');
    evidence.text('file-listing.txt', collectFileListing(workspace).join('\n') + '\n');
    evidence.json('file-manifest.json', collectFileManifest(workspace));
    await evidence.screenshot('restore-complete');
    evidence.json('journey-result.json', {
      id: journey.id,
      phase,
      status: 'passed',
      taskId: beforeClose.taskId,
      attemptId: beforeClose.attemptId,
      terminalState: 'completed',
    });
    return;
  }

  const firstLaunch = await view.snapshot();
  assert.deepEqual(
    ['chat', 'agent', 'autonomous'].filter(mode => firstLaunch.modeValues.includes(mode)),
    ['chat', 'agent', 'autonomous'],
    'all three explicit modes must be available',
  );
  assert.equal(firstLaunch.userCount, 0, 'fresh profile must not restore a stale user message');
  assert.equal(firstLaunch.assistantCount, 0, 'fresh profile must not restore a stale answer');
  assert.equal(firstLaunch.responseCount, 0, 'fresh profile must not restore a stale task');
  assert.equal(firstLaunch.actionableApprovals, 0, 'fresh profile must not restore a stale approval');
  assert.equal(firstLaunch.primaryAction, 'Send');
  assert.equal(firstLaunch.composerDisabled, false);
  assert.ok(firstLaunch.providerModelText.length > 0, 'provider/model/approval configuration must be displayed');
  evidence.json('dom-first-launch.json', firstLaunch);

  const chatBefore = await view.snapshot();
  await view.submitInMode('chat', 'Explain what this repository contains.');
  const chatDone = await view.waitForOrdinaryResponse(chatBefore.assistantCount);
  assert.equal(chatDone.selectedMode, 'chat', 'Baat Kar must own the request');
  assert.equal(chatDone.userCount, chatBefore.userCount + 1);
  assert.equal(chatDone.assistantCount, chatBefore.assistantCount + 1);
  assert.equal(chatDone.responseCount, 0, 'Baat Kar must not create an autonomous task response');
  assert.equal(chatDone.actionableApprovals, 0, 'Baat Kar must not create an approval');
  assert.equal(git(workspace, ['status', '--porcelain=v1']), '', 'Baat Kar must leave Git clean');
  evidence.json('dom-baat-kar.json', chatDone);
  await evidence.screenshot('baat-kar-complete');

  const saathPrompt = 'Create note-saath.txt containing Hello from Saath Kar';
  await view.submitInMode('agent', saathPrompt);
  const rejectedApprovalDeadline = Date.now() + 120_000;
  let rejectedApproval;
  while (Date.now() < rejectedApprovalDeadline) {
    if (fs.existsSync(path.join(workspace, 'note-saath.txt'))) {
      throw new Error('SAATH_KAR_MUTATED_WITHOUT_VISIBLE_APPROVAL: note-saath.txt appeared before rejection was possible');
    }
    rejectedApproval = await view.actionableToolApproval('rejected');
    if (rejectedApproval) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!rejectedApproval) throw new Error('Visible Saath Kar rejection control did not become actionable');
  await rejectedApproval.click();
  await view.driver.wait(async () => (await view.snapshot()).primaryAction === 'Send', 60_000);
  assert.equal(fs.existsSync(path.join(workspace, 'note-saath.txt')), false, 'rejected Saath Kar mutation must not create a file');
  assert.equal(git(workspace, ['status', '--porcelain=v1']), '', 'rejected Saath Kar mutation must leave Git unchanged');

  await view.submitInMode('agent', saathPrompt);
  const saathDeadline = Date.now() + 4 * 60_000;
  let approvedCount = 0;
  while (Date.now() < saathDeadline && !fs.existsSync(path.join(workspace, 'note-saath.txt'))) {
    try {
      await view.clickToolApproval('approved', 5_000);
      approvedCount += 1;
    } catch {
      // The agent may still be producing the next visible approval.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (fs.existsSync(path.join(workspace, 'note-saath.txt')) && approvedCount === 0) {
    throw new Error('SAATH_KAR_MUTATED_WITHOUT_VISIBLE_APPROVAL: approved delivery appeared without one visible approval');
  }
  assert.equal(fs.existsSync(path.join(workspace, 'note-saath.txt')), true, 'approved Saath Kar mutation must create note-saath.txt');
  assert.equal(fs.readFileSync(path.join(workspace, 'note-saath.txt'), 'utf8'), 'Hello from Saath Kar');
  assert.deepEqual(changedPaths(workspace), ['note-saath.txt'], 'Saath Kar may change only note-saath.txt');
  evidence.json('dom-saath-kar.json', await view.snapshot());
  await evidence.screenshot('saath-kar-complete');

  git(workspace, ['add', '--', 'note-saath.txt']);
  git(workspace, ['commit', '-m', 'Record approved Saath Kar result']);

  await view.submitInMode('autonomous', 'create note-auto.txt containing Hello');
  const acknowledged = await view.waitForAcknowledgement();
  assert.equal(acknowledged.responseCount, 1, 'Karke Dikha must create exactly one task response');
  assert.equal(acknowledged.responseVisible, true);
  assert.equal(acknowledged.primaryAction, 'Stop');
  assert.equal(acknowledged.primaryTaskId, acknowledged.taskId);
  assert.match(acknowledged.requestText, /create note-auto\.txt containing Hello/);
  assert.doesNotMatch(acknowledged.bodyText, /Stage 1\/5|qwen3-coder:30b/);
  const taskId = acknowledged.taskId;
  const attemptId = acknowledged.attemptId || taskId;
  let terminalTask = await driveVisibleApprovals(view, workspace, taskId);
  if (!terminalStates.has(terminalTask.state)) {
    terminalTask = (await waitForTask(workspace, taskId, task => terminalStates.has(task.state))).task;
  }
  assert.equal(terminalTask.state, 'completed');
  const durable = taskEvidence(workspace, taskId);
  const core = coreEvidence(coreDataDir, attemptId);
  const counters = routeCounters(durable.task, durable.events, core);
  assert.equal(counters.executionProfile, 'trivial');
  assert.equal(durable.task.executionProfile?.maxStages ?? 0, 0);
  assert.equal(counters.modelCalls, 0);
  assert.equal(counters.graphExecutions, 0);
  assert.equal(counters.graphStageEvents, 0);
  assert.equal(counters.qwen30bSelected, false);
  assert.equal(fs.readFileSync(path.join(workspace, 'note-auto.txt'), 'utf8'), 'Hello');
  assert.equal(git(workspace, ['status', '--porcelain=v1']), '', 'Karke Dikha completion must leave Git clean');
  const completed = await view.snapshot();
  assert.equal(completed.primaryAction, 'Send');
  assert.equal(completed.primaryTaskId, null);
  assert.equal(completed.responseCount, 1);
  evidence.json('task.json', durable.task);
  evidence.text('task-events.jsonl', durable.events.map(event => JSON.stringify(event)).join('\n') + '\n');
  evidence.json('runtime-route.json', { attemptId, counters, core });
  evidence.json('dom-completed.json', completed);
  evidence.text('git-status.txt', git(workspace, ['status', '--porcelain=v1', '--branch']) + '\n');
  evidence.text('git-log.txt', git(workspace, ['log', '--oneline', '--decorate', '-20']) + '\n');
  evidence.text('file-listing.txt', collectFileListing(workspace).join('\n') + '\n');
  evidence.json('file-manifest.json', collectFileManifest(workspace));
  await evidence.screenshot('karke-dikha-complete');
  fs.writeFileSync(phaseStatePath, `${JSON.stringify({
    taskId,
    attemptId,
    userCount: completed.userCount,
    assistantCount: completed.assistantCount,
    responseCount: completed.responseCount,
    completedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  evidence.json('journey-result.json', {
    id: journey.id,
    phase,
    status: 'passed',
    taskId,
    attemptId,
    terminalState: terminalTask.state,
  });
}

export async function runJourney(id) {
  const journey = loadJourney(id);
  const workspace = requiredEnv('GUARDIAN_WORKSPACE');
  const evidenceDir = requiredEnv('GUARDIAN_JOURNEY_EVIDENCE');
  const coreDataDir = requiredEnv('GUARDIAN_CORE_DATA');
  const initialBranch = process.env.GUARDIAN_INITIAL_BRANCH || git(workspace, ['branch', '--show-current']);
  const view = new KarkeDikhaView();
  const evidence = new EvidenceCollector(VSBrowser.instance.driver, evidenceDir);
  let taskId;
  let attemptId;
  let terminalTask;

  try {
    if (journey.driver === 'catalogue-contract') {
      throw new Error(`GUARDIAN_DRIVER_MISSING: ${id} has an authoritative lifecycle contract but no reviewed installed-product driver yet`);
    }
    if (journey.driver === 'workspace-leakage-negative') {
      await view.open();
      await view.driver.executeScript(`
        const marker = document.createElement('div');
        marker.id = 'guardian-deliberate-workspace-a-leak';
        marker.textContent = 'GUARDIAN_WORKSPACE_A_LEAK_MARKER';
        document.body.appendChild(marker);
      `);
      const leaked = await view.snapshot();
      evidence.json('dom-negative-control.json', leaked);
      assert.doesNotMatch(
        leaked.bodyText,
        /GUARDIAN_WORKSPACE_A_LEAK_MARKER/,
        'CROSS_WORKSPACE_LEAKAGE_DETECTED',
      );
    }
    if (journey.driver === 'p0-lifecycle') {
      await runP0Lifecycle({ journey, workspace, evidenceDir, coreDataDir, initialBranch, view, evidence });
      return;
    }
    if (journey.driver === 'p1-lifecycle') {
      const phase = process.env.GUARDIAN_PHASE || 'single';
      await runP1LifecycleJourney({
        journey,
        phase,
        workspace,
        evidenceDir,
        coreDataDir,
        initialBranch,
        view,
        evidence,
      });
      const result = { id, phase, status: 'passed' };
      evidence.json(`journey-result-${phase}.json`, result);
      evidence.json('journey-result.json', result);
      return;
    }

    await view.open();
    await evidence.screenshot('before');
    await view.submit(journey.prompt);

    const acknowledged = await view.waitForAcknowledgement();
    assertAcknowledgement(acknowledged, journey);
    taskId = acknowledged.taskId;
    attemptId = acknowledged.attemptId || taskId;
    await waitForTask(workspace, taskId, () => true, 30_000);

    if (id === 'cancellation') {
      const stoppedId = await view.stop();
      assert.equal(stoppedId, taskId);
      terminalTask = (await waitForTask(workspace, taskId, task => task.state === 'cancelled')).task;
      await view.driver.wait(async () => {
        const terminal = await view.snapshot();
        return terminal.primaryAction === 'Send' && /cancel|stopp/i.test(terminal.bodyText);
      }, 30_000, 'cancelled terminal state did not appear in the original task response');
      const cancelledDom = await view.snapshot();
      assert.equal(cancelledDom.responseIdentity, `kd-task-message-${taskId}`);
      assert.equal(cancelledDom.responseVisible, true);
      assert.equal(cancelledDom.userCount, 1);
      assert.equal(cancelledDom.responseCount, 1);
      await view.reloadWindow();
      const afterReload = await view.snapshot();
      assert.equal(afterReload.primaryAction, 'Send', 'reload must not resurrect the cancelled task');
      assert.equal(afterReload.primaryTaskId, null, 'reload must not bind controls to a cancelled task');
      assert.ok(afterReload.userCount <= 1, 'reload must not duplicate the cancelled request');
      assert.ok(afterReload.responseCount <= 1, 'reload must not duplicate the cancelled response');
      assert.notEqual(afterReload.responseIdentity, `kd-task-message-${taskId}`, 'reload must not resurrect the cancelled response as active');
    } else {
      if (id === 'steering') {
        const boundId = await view.steer(journey.steering);
        assert.equal(boundId, taskId, 'steering must remain bound to the same durable task');
        const revised = await waitForTask(workspace, taskId, task => (task.instructionRevision ?? 0) >= 1);
        assert.equal(revised.task.taskId, taskId);
      } else if (id === 'restart') {
        await view.reloadWindow();
        const restored = await view.waitForAcknowledgement(60_000);
        assert.equal(restored.taskId, taskId, 'reload must preserve the durable task ID');
        assert.equal(restored.userCount, 1);
        assert.equal(restored.responseCount, 1);
      }
      terminalTask = await driveVisibleApprovals(view, workspace, taskId);
      if (!terminalStates.has(terminalTask.state)) {
        terminalTask = (await waitForTask(workspace, taskId, task => terminalStates.has(task.state))).task;
      }
      assert.equal(terminalTask.state, journey.result.terminalState, `task must end in ${journey.result.terminalState}`);
    }

    const durable = taskEvidence(workspace, taskId);
    const core = coreEvidence(coreDataDir, attemptId);
    const counters = routeCounters(durable.task, durable.events, core);
    evidence.json('task.json', durable.task);
    evidence.text('task-events.jsonl', durable.events.map(event => JSON.stringify(event)).join('\n') + '\n');
    evidence.json('runtime-route.json', { attemptId, counters, core });

    if (journey.driver === 'deterministic-autonomous') {
      assert.equal(counters.executionProfile, 'trivial');
      assert.equal(counters.deterministicProposalSelected, true);
      assert.equal(counters.modelCalls, 0);
      assert.equal(counters.graphExecutions, 0);
      assert.equal(counters.graphStageEvents, 0);
      assert.equal(counters.qwen30bSelected, false);
    }
    if (id === 'steering') {
      assert.ok((durable.task.instructionRevision ?? 0) >= 1);
      assert.equal(durable.task.mutationEvidence?.instructionRevision, durable.task.instructionRevision);
      assert.equal(durable.task.diffReview?.instructionRevision, durable.task.instructionRevision);
      assert.deepEqual(durable.task.mutationEvidence?.expectedPaths, ['greeting.txt']);
      assert.deepEqual(durable.task.diffReview?.approvedScopePaths, ['greeting.txt']);
    }
    if (id === 'cancellation') {
      assert.equal(core.attempt?.status, 'cancelled', 'Core attempt with the acknowledged ID must be cancelled');
      assert.equal(fs.existsSync(path.join(workspace, 'note.txt')), false, 'cancelled task must not deliver note.txt');
    }

    assertGitAndFiles(workspace, initialBranch, journey.result);
    const terminalDom = await view.snapshot();
    if (id === 'cancellation') {
      assert.ok(terminalDom.userCount <= 1);
      assert.ok(terminalDom.responseCount <= 1);
      assert.equal(terminalDom.primaryAction, 'Send');
      assert.notEqual(terminalDom.responseIdentity, `kd-task-message-${taskId}`);
    } else {
      assert.equal(terminalDom.userCount, 1);
      assert.equal(terminalDom.responseCount, 1);
      assert.equal(terminalDom.responseIdentity, `kd-task-message-${taskId}`);
    }
    assert.equal(terminalDom.workbenchControls, 0);
    assert.doesNotMatch(terminalDom.bodyText, /Stage 1\/5/);
    assert.doesNotMatch(terminalDom.bodyText, /qwen3-coder:30b/);
    const sourceControlText = await view.sourceControlText();
    assert.doesNotMatch(sourceControlText, /\.ollama-agent/i, '.ollama-agent must not appear in Source Control');

    evidence.json('dom-final.json', terminalDom);
    evidence.text('git-status.txt', git(workspace, ['status', '--porcelain=v1', '--branch']) + '\n');
    evidence.text('git-log.txt', git(workspace, ['log', '--oneline', '--decorate', '-20']) + '\n');
    evidence.text('file-listing.txt', collectFileListing(workspace).join('\n') + '\n');
    evidence.json('file-manifest.json', collectFileManifest(workspace));
    await evidence.screenshot('after');
    evidence.json('journey-result.json', { id, status: 'passed', taskId, attemptId, terminalState: terminalTask.state });
  } catch (error) {
    const rawMessage = error?.message ?? String(error);
    const classified = /GUARDIAN_(?:PRODUCT_FAILURE|DRIVER_MISSING|INFRASTRUCTURE_FAILURE|ASSERTION_FAILURE|EXPECTED_NEGATIVE)/.test(rawMessage)
      ? error
      : error?.name === 'AssertionError'
        ? new Error(`GUARDIAN_PRODUCT_FAILURE: ${rawMessage}`, { cause: error })
        : /selenium|webdriver|chromedriver|frame did not become|workbench|timed out.*visible|no such (?:element|window)/i.test(rawMessage)
          ? new Error(`GUARDIAN_INFRASTRUCTURE_FAILURE: ${rawMessage}`, { cause: error })
          : new Error(`GUARDIAN_ASSERTION_FAILURE: ${rawMessage}`, { cause: error });
    try {
      await evidence.screenshot('failure');
      await view.switchIntoView();
      evidence.json('dom-failure.json', await view.snapshot());
    } catch {
      // Preserve the original product/test failure.
    }
    evidence.text('failure-summary.txt', `${classified?.stack ?? classified}\n`);
    evidence.text('git-status.txt', git(workspace, ['status', '--porcelain=v1', '--branch']) + '\n');
    evidence.text('git-log.txt', git(workspace, ['log', '--oneline', '--decorate', '-20']) + '\n');
    evidence.text('file-listing.txt', collectFileListing(workspace).join('\n') + '\n');
    evidence.json('file-manifest.json', collectFileManifest(workspace));
    evidence.json('journey-result.json', { id, status: 'failed', taskId, attemptId, error: classified.message });
    throw classified;
  }
}
