import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  capabilityAnchorAttempt,
  conversationLedgerEntry,
  coreEvidence,
  latestCoreTurn,
  routeCounters,
  taskApprovalIdentity,
  taskEvidence,
  waitForTask,
} from '../support/runtimeEvidence.mjs';

// selectConversation() (KarkeDikhaView.mjs) drives the DOM by
// .conversation-item[data-conv-id], which only ever carries the webview's
// local conversation id (AgentPanel.ts DEFAULT_CONVERSATION_ID / generated
// taskIds) — never Core's durable conversationId. Lifecycle state that
// crosses the primary/restore boundary must keep the two identities
// explicitly separate; asserting the M35 workspace_conversations ledger maps
// one to the other proves they name the same conversation, rather than just
// avoiding a naming collision.
function assertConversationIdentity(coreDataDir, localConversationId, coreConversationId) {
  assert.ok(localConversationId, 'webview-local conversation identity must be visible');
  assert.ok(coreConversationId, 'Core conversation identity must be durable');
  const ledgerEntry = conversationLedgerEntry(coreDataDir, localConversationId);
  assert.ok(ledgerEntry, `workspace_conversations ledger must have an entry for local conversation ${localConversationId}`);
  assert.equal(ledgerEntry.conversationId, coreConversationId, 'ledger must map the local conversation id to this exact Core conversation id');
}

const terminalStates = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const approvalStates = {
  proposal: 'waiting_for_proposal_approval',
  mutation: 'waiting_for_mutation_approval',
  delivery: 'waiting_for_delivery_approval',
};

const phasePlans = new Map([
  ['baat-kar-complete-history', ['primary', 'restore']],
  ['saath-kar-rejected-restoration', ['primary', 'restore']],
  ['saath-kar-approved-restoration', ['primary', 'restore']],
  ['deterministic-complete', ['primary', 'restore']],
  ['proposal-pending-close', ['primary', 'restore']],
  ['mutation-pending-close', ['primary', 'restore']],
  ['delivery-pending-close', ['primary', 'restore']],
  ['reload-approval-states', ['single']],
  ['steering-before-approval', ['single']],
  ['steering-after-reload', ['single']],
  ['steering-after-close', ['primary', 'restore']],
  ['stop-before-approval', ['single']],
  ['stop-during-execution', ['single']],
  ['stop-before-delivery', ['single']],
  ['new-chat-after-completion', ['single']],
  ['return-completed-history', ['single']],
]);

export function lifecyclePhases(id) {
  return phasePlans.get(id) ?? ['single'];
}

const git = (workspace, args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
const phaseStatePath = evidenceDir => path.join(evidenceDir, 'lifecycle-state.json');
const readState = evidenceDir => JSON.parse(fs.readFileSync(phaseStatePath(evidenceDir), 'utf8'));
const writeState = (evidenceDir, state) => {
  fs.writeFileSync(phaseStatePath(evidenceDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
};

function assertRepository(workspace, initialBranch, expected = {}) {
  assert.equal(git(workspace, ['branch', '--show-current']), initialBranch, 'workspace branch changed unexpectedly');
  if (expected.file) {
    const target = path.join(workspace, expected.file);
    assert.equal(fs.existsSync(target), true, `${expected.file} must exist`);
    assert.equal(fs.readFileSync(target, 'utf8'), expected.content, `${expected.file} content must match exactly`);
  }
  if (expected.absentFile) {
    assert.equal(fs.existsSync(path.join(workspace, expected.absentFile)), false, `${expected.absentFile} must remain absent`);
  }
  assert.equal(git(workspace, ['status', '--porcelain=v1']), '', 'workspace Git status must be clean');
}

function commitTestOwnedResult(workspace, file, message) {
  git(workspace, ['add', '--', file]);
  git(workspace, ['commit', '-m', message]);
}

async function capture(ctx, label, taskId, attemptId) {
  const snapshot = await ctx.view.snapshot();
  ctx.evidence.json(`dom-${label}.json`, snapshot);
  await ctx.evidence.screenshot(label);
  ctx.evidence.text(`git-${label}.txt`, `${git(ctx.workspace, ['status', '--porcelain=v1', '--branch'])}\n`);
  if (taskId) {
    const durable = taskEvidence(ctx.workspace, taskId);
    ctx.evidence.json(`task-${label}.json`, durable.task);
    ctx.evidence.text(`task-events-${label}.jsonl`, `${durable.events.map(event => JSON.stringify(event)).join('\n')}\n`);
    if (attemptId) ctx.evidence.json(`core-${label}.json`, coreEvidence(ctx.coreDataDir, attemptId));
  }
  return snapshot;
}

async function waitForState(ctx, taskId, state, timeout = 180_000) {
  return waitForTask(ctx.workspace, taskId, task => task.state === state, timeout);
}

async function startAutonomous(ctx, prompt = ctx.journey.prompt) {
  await ctx.view.submitInMode('autonomous', prompt);
  const acknowledged = await ctx.view.waitForAcknowledgement();
  assert.equal(acknowledged.selectedMode, 'autonomous');
  assert.equal(acknowledged.responseCount, 1);
  assert.equal(acknowledged.primaryAction, 'Stop');
  assert.ok(acknowledged.taskId && acknowledged.taskId !== '—');
  await waitForTask(ctx.workspace, acknowledged.taskId, () => true, 30_000);
  return {
    taskId: acknowledged.taskId,
    attemptId: acknowledged.attemptId || acknowledged.taskId,
    conversationId: acknowledged.conversationId,
  };
}

async function waitApproval(ctx, taskId, kind) {
  const durable = await waitForState(ctx, taskId, approvalStates[kind]);
  const identity = taskApprovalIdentity(durable.task, kind);
  assert.ok(identity?.id, `${kind} approval must have a durable identity`);
  const visible = await ctx.view.waitForApproval(kind);
  assert.equal(visible.taskId, taskId, `${kind} approval must own the exact task`);
  assert.equal(visible.attemptId, durable.task.attemptId, `${kind} approval must own the exact attempt`);
  assert.equal(visible.actionable, true, `${kind} approval must be actionable`);
  return { durable, identity, visible };
}

async function advanceTo(ctx, taskId, targetKind) {
  const order = ['proposal', 'mutation', 'delivery'];
  for (const kind of order) {
    const boundary = await waitApproval(ctx, taskId, kind);
    if (kind === targetKind) return boundary;
    await ctx.view.resolveVisibleApproval(kind, 'approved');
  }
  throw new Error(`Unknown target approval ${targetKind}`);
}

async function completeTask(ctx, taskId) {
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const durable = taskEvidence(ctx.workspace, taskId);
    if (terminalStates.has(durable.task.state)) return durable;
    const kind = Object.entries(approvalStates).find(([, state]) => state === durable.task.state)?.[0];
    if (kind) {
      await waitApproval(ctx, taskId, kind);
      await ctx.view.resolveVisibleApproval(kind, 'approved');
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out completing task ${taskId}`);
}

function assertTerminalUi(snapshot, taskId, counts = { user: 1, response: 1 }) {
  assert.equal(snapshot.userCount, counts.user, 'user messages must project exactly once');
  assert.equal(snapshot.responseCount, counts.response, 'task responses must project exactly once');
  assert.equal(snapshot.primaryAction, 'Send');
  assert.equal(snapshot.primaryTaskId, null);
  assert.equal(snapshot.actionableApprovals, 0);
  assert.equal(snapshot.compactStopVisible, false);
  assert.doesNotMatch(snapshot.bodyText, /Still working\s*[·-]\s*checked/i, 'terminal task must not retain a live heartbeat');
  if (taskId && counts.response === 1) assert.equal(snapshot.responseIdentity, `kd-task-message-${taskId}`);
}

function assertTrivialRoute(ctx, taskId, attemptId) {
  const durable = taskEvidence(ctx.workspace, taskId);
  const core = coreEvidence(ctx.coreDataDir, attemptId);
  const counters = routeCounters(durable.task, durable.events, core);
  assert.equal(counters.executionProfile, 'trivial');
  assert.equal(durable.task.executionProfile?.maxStages ?? 0, 0);
  assert.equal(counters.modelCalls, 0);
  assert.equal(counters.graphExecutions, 0);
  assert.equal(counters.graphStageEvents, 0);
  assert.equal(counters.qwen30bSelected, false);
  return counters;
}

function assertSameBoundary(current, expected) {
  assert.equal(current.durable.task.taskId, expected.taskId);
  assert.equal(current.durable.task.attemptId, expected.attemptId);
  assert.equal(current.identity.id, expected.approvalId);
  assert.equal(current.visible.taskId, expected.taskId);
  assert.equal(current.visible.attemptId, expected.attemptId);
}

async function runBaatKar(ctx) {
  const phase = ctx.phase;
  if (phase === 'primary') {
    const before = await ctx.view.snapshot();
    await ctx.view.submitInMode('chat', ctx.journey.prompt);
    const done = await ctx.view.waitForOrdinaryResponse(before.assistantCount);
    assert.equal(done.selectedMode, 'chat');
    assert.equal(done.userCount, 1);
    assert.equal(done.assistantCount, 1);
    assert.equal(done.responseCount, 0);
    assert.equal(done.actionableApprovals, 0);
    assert.equal(done.primaryAction, 'Send');
    const turn = latestCoreTurn(ctx.coreDataDir, ctx.journey.prompt);
    assert.ok(turn?.request?.conversationId, 'Baat Kar conversation identity must be durable');
    // Core's ResolvedMode vocabulary ('baat_kar'/'saath_kar'/'karke_dikha') is
    // distinct from the webview's engine-mode vocabulary ('chat'/'agent'/
    // 'autonomous') asserted above via done.selectedMode. Comparing the
    // backend-persisted field against the DOM vocabulary was a test-oracle
    // bug — Core has never stored 'chat' here (see core/domain/routing.ts and
    // core/shared/wireTypes.ts:ResolvedMode).
    assert.equal(turn.request.resolvedMode, 'baat_kar');
    assert.equal(turn.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(turn.messages.filter(message => message.role === 'assistant').length, 1);
    assert.equal(turn.approvals.length, 0);
    assertRepository(ctx.workspace, ctx.initialBranch);
    assertConversationIdentity(ctx.coreDataDir, done.conversationId, turn.request.conversationId);
    writeState(ctx.evidenceDir, {
      localConversationId: done.conversationId,
      coreConversationId: turn.request.conversationId,
      requestId: turn.request.id,
    });
    await capture(ctx, 'baat-primary');
    return;
  }
  const state = readState(ctx.evidenceDir);
  const restored = await ctx.view.selectConversation(state.localConversationId);
  assert.equal(restored.userCount, 1);
  assert.equal(restored.assistantCount, 1);
  assert.equal(restored.responseCount, 0);
  assert.equal(restored.actionableApprovals, 0);
  assert.equal(restored.primaryAction, 'Send');
  assert.equal(restored.composerDisabled, false);
  assertRepository(ctx.workspace, ctx.initialBranch);
  await capture(ctx, 'baat-restored');
}

async function waitForSaathApproval(ctx, decision) {
  const deadline = Date.now() + 180_000;
  let button;
  while (Date.now() < deadline) {
    button = await ctx.view.actionableToolApproval(decision);
    if (button) return button;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Visible Saath Kar ${decision} control did not become actionable`);
}

async function runSaathRejected(ctx) {
  if (ctx.phase === 'primary') {
    await ctx.view.submitInMode('agent', ctx.journey.prompt);
    const button = await waitForSaathApproval(ctx, 'rejected');
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'note-saath.txt')), false);
    const pending = latestCoreTurn(ctx.coreDataDir, ctx.journey.prompt);
    assert.ok(pending?.attempt?.id);
    // The visible attempt owns none of the M38 capability-approval identity —
    // see capabilityAnchorAttempt() in runtimeEvidence.mjs. Resolving via the
    // visible turn's conversationId is not a race to wait out; the anchor
    // attempt/approval are durably committed before the DOM control becomes
    // actionable, just under a different attemptId.
    const pendingAnchor = capabilityAnchorAttempt(ctx.coreDataDir, pending.request.conversationId);
    assert.ok(pendingAnchor?.attempt?.id, 'capability dispatch anchor attempt must be durable');
    assert.equal(pendingAnchor.approvals.length, 1);
    const approvalId = pendingAnchor.approvals[0].id;
    await button.click();
    await ctx.view.driver.wait(async () => (await ctx.view.snapshot()).primaryAction === 'Send', 60_000);
    const afterReject = await ctx.view.snapshot();
    const rejected = latestCoreTurn(ctx.coreDataDir, ctx.journey.prompt);
    assert.equal(rejected.attempt.status, 'cancelled');
    const rejectedAnchor = capabilityAnchorAttempt(ctx.coreDataDir, rejected.request.conversationId);
    assert.equal(rejectedAnchor.approvals.length, 1);
    assert.equal(rejectedAnchor.approvals[0].id, approvalId);
    assert.equal(rejectedAnchor.approvals[0].status, 'rejected');
    assert.equal(rejectedAnchor.toolInvocations.length, 0);
    assertRepository(ctx.workspace, ctx.initialBranch, { absentFile: 'note-saath.txt' });
    assertConversationIdentity(ctx.coreDataDir, afterReject.conversationId, rejected.request.conversationId);
    writeState(ctx.evidenceDir, {
      localConversationId: afterReject.conversationId,
      coreConversationId: rejected.request.conversationId,
      attemptId: rejected.attempt.id,
      approvalId,
    });
    await capture(ctx, 'saath-rejected');
    return;
  }
  const state = readState(ctx.evidenceDir);
  const restored = await ctx.view.selectConversation(state.localConversationId);
  assert.equal(restored.actionableApprovals, 0);
  assert.equal(restored.primaryAction, 'Send');
  assertRepository(ctx.workspace, ctx.initialBranch, { absentFile: 'note-saath.txt' });
  await ctx.view.submitInMode('agent', ctx.journey.prompt);
  const freshButton = await waitForSaathApproval(ctx, 'rejected');
  const fresh = latestCoreTurn(ctx.coreDataDir, ctx.journey.prompt);
  assert.notEqual(fresh.attempt.id, state.attemptId, 'fresh attempt must have a fresh attempt identity');
  // ensureCapabilityAttempt() is idempotent per conversation — the same
  // anchor attempt persists across the whole conversation's lifetime, so a
  // resubmission appends a new approval row rather than minting a new anchor
  // attempt. The freshest approval is the last one requested, not the first.
  const freshAnchor = capabilityAnchorAttempt(ctx.coreDataDir, fresh.request.conversationId);
  const freshApproval = freshAnchor.approvals[freshAnchor.approvals.length - 1];
  assert.notEqual(freshApproval.id, state.approvalId, 'fresh attempt must have a fresh approval identity');
  await freshButton.click();
  await ctx.view.driver.wait(async () => (await ctx.view.snapshot()).primaryAction === 'Send', 60_000);
  assertRepository(ctx.workspace, ctx.initialBranch, { absentFile: 'note-saath.txt' });
  await capture(ctx, 'saath-rejected-restored');
}

async function runSaathApproved(ctx) {
  if (ctx.phase === 'primary') {
    await ctx.view.submitInMode('agent', ctx.journey.prompt);
    let approvalCount = 0;
    const deadline = Date.now() + 4 * 60_000;
    while (Date.now() < deadline && !fs.existsSync(path.join(ctx.workspace, 'note-saath.txt'))) {
      try {
        await ctx.view.clickToolApproval('approved', 5_000);
        approvalCount += 1;
      } catch {
        // The installed product may still be generating the governed request.
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(approvalCount >= 1, 'Saath Kar must require a visible approval');
    assert.equal(fs.readFileSync(path.join(ctx.workspace, 'note-saath.txt'), 'utf8'), 'Hello from Saath Kar');
    assert.deepEqual(
      git(ctx.workspace, ['status', '--porcelain=v1']).split(/\r?\n/).filter(Boolean).map(line => line.slice(3)),
      ['note-saath.txt'],
    );
    const approved = latestCoreTurn(ctx.coreDataDir, ctx.journey.prompt);
    assert.ok(approved?.attempt?.id);
    // See capabilityAnchorAttempt() in runtimeEvidence.mjs — the approval
    // this Saath Kar turn produced lives on the M38 capability-dispatch
    // anchor attempt for this conversation, not on the visible chat attempt.
    const approvedAnchor = capabilityAnchorAttempt(ctx.coreDataDir, approved.request.conversationId);
    assert.ok(approvedAnchor?.attempt?.id, 'capability dispatch anchor attempt must be durable');
    assert.equal(approvedAnchor.approvals.length, 1);
    assert.equal(approvedAnchor.approvals[0].status, 'approved');
    commitTestOwnedResult(ctx.workspace, 'note-saath.txt', 'Record approved Saath Kar lifecycle result');
    assertRepository(ctx.workspace, ctx.initialBranch, { file: 'note-saath.txt', content: 'Hello from Saath Kar' });
    const afterApprove = await ctx.view.snapshot();
    assertConversationIdentity(ctx.coreDataDir, afterApprove.conversationId, approved.request.conversationId);
    writeState(ctx.evidenceDir, {
      localConversationId: afterApprove.conversationId,
      coreConversationId: approved.request.conversationId,
      attemptId: approved.attempt.id,
      approvalId: approvedAnchor.approvals[0].id,
    });
    await capture(ctx, 'saath-approved');
    return;
  }
  const state = readState(ctx.evidenceDir);
  const restored = await ctx.view.selectConversation(state.localConversationId);
  assert.equal(restored.userCount, 1);
  assert.equal(restored.actionableApprovals, 0);
  assert.equal(restored.primaryAction, 'Send');
  const durable = latestCoreTurn(ctx.coreDataDir, ctx.journey.prompt);
  assert.equal(durable.attempt.id, state.attemptId);
  const durableAnchor = capabilityAnchorAttempt(ctx.coreDataDir, durable.request.conversationId);
  assert.equal(durableAnchor.approvals.length, 1);
  assert.equal(durableAnchor.approvals[0].id, state.approvalId);
  assertRepository(ctx.workspace, ctx.initialBranch, { file: 'note-saath.txt', content: 'Hello from Saath Kar' });
  await capture(ctx, 'saath-approved-restored');
}

async function runDeterministicComplete(ctx) {
  if (ctx.phase === 'primary') {
    const identity = await startAutonomous(ctx);
    const terminal = await completeTask(ctx, identity.taskId);
    assert.equal(terminal.task.state, 'completed');
    assertTrivialRoute(ctx, identity.taskId, identity.attemptId);
    assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
    const completed = await ctx.view.snapshot();
    assertTerminalUi(completed, identity.taskId);
    writeState(ctx.evidenceDir, identity);
    await capture(ctx, 'deterministic-complete', identity.taskId, identity.attemptId);
    return;
  }
  const state = readState(ctx.evidenceDir);
  const restored = await ctx.view.snapshot();
  assertTerminalUi(restored, state.taskId);
  assert.equal(taskEvidence(ctx.workspace, state.taskId).task.state, 'completed');
  assertTrivialRoute(ctx, state.taskId, state.attemptId);
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  await capture(ctx, 'deterministic-restored', state.taskId, state.attemptId);
}

async function runPendingClose(ctx, kind) {
  const pendingAbsentFile = kind === 'delivery' ? ctx.journey.result.file : ctx.journey.result.absentFile;
  if (ctx.phase === 'primary') {
    const identity = await startAutonomous(ctx);
    const boundary = await advanceTo(ctx, identity.taskId, kind);
    assert.equal(fs.existsSync(path.join(ctx.workspace, pendingAbsentFile)), false);
    writeState(ctx.evidenceDir, {
      ...identity,
      kind,
      approvalId: boundary.identity.id,
      instructionRevision: boundary.identity.instructionRevision,
    });
    await capture(ctx, `${kind}-pending-before-close`, identity.taskId, identity.attemptId);
    return;
  }
  const state = readState(ctx.evidenceDir);
  const boundary = await waitApproval(ctx, state.taskId, kind);
  assertSameBoundary(boundary, state);
  assert.equal(boundary.durable.task.instructionRevision ?? 0, state.instructionRevision);
  assert.equal((await ctx.view.snapshot()).actionableApprovals, 1);
  assert.equal(fs.existsSync(path.join(ctx.workspace, pendingAbsentFile)), false);
  if (kind === 'delivery') {
    await ctx.view.resolveVisibleApproval(kind, 'approved');
    const terminal = await waitForState(ctx, state.taskId, 'completed');
    assert.equal(terminal.task.state, 'completed');
    assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  } else {
    await ctx.view.resolveVisibleApproval(kind, 'rejected');
    const terminal = await waitForTask(ctx.workspace, state.taskId, task => terminalStates.has(task.state));
    assert.equal(terminal.task.state, 'cancelled');
    assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  }
  const final = await ctx.view.snapshot();
  assertTerminalUi(final, state.taskId);
  await capture(ctx, `${kind}-pending-restored`, state.taskId, state.attemptId);
}

async function runReloadApprovalStates(ctx) {
  const identity = await startAutonomous(ctx);
  for (const kind of ['proposal', 'mutation', 'delivery']) {
    const before = await waitApproval(ctx, identity.taskId, kind);
    const expected = {
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      approvalId: before.identity.id,
    };
    await capture(ctx, `reload-${kind}-before`, identity.taskId, identity.attemptId);
    await ctx.view.reloadWindow();
    const after = await waitApproval(ctx, identity.taskId, kind);
    assertSameBoundary(after, expected);
    assert.equal((await ctx.view.snapshot()).actionableApprovals, 1);
    await capture(ctx, `reload-${kind}-after`, identity.taskId, identity.attemptId);
    await ctx.view.resolveVisibleApproval(kind, 'approved');
  }
  const completed = await waitForState(ctx, identity.taskId, 'completed');
  assert.equal(completed.task.state, 'completed');
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  assertTerminalUi(await ctx.view.snapshot(), identity.taskId);
}

async function steerAndComplete(ctx, { reload = false } = {}) {
  const identity = await startAutonomous(ctx);
  const original = await waitApproval(ctx, identity.taskId, 'proposal');
  if (reload) {
    await ctx.view.reloadWindow();
    const restored = await waitApproval(ctx, identity.taskId, 'proposal');
    assertSameBoundary(restored, {
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      approvalId: original.identity.id,
    });
  }
  const boundId = await ctx.view.steer('Use greeting.txt instead');
  assert.equal(boundId, identity.taskId);
  const revised = await waitForTask(ctx.workspace, identity.taskId, task =>
    (task.instructionRevision ?? 0) === 1 && task.state === 'waiting_for_proposal_approval');
  assert.equal(revised.task.taskId, identity.taskId);
  assert.equal(revised.task.attemptId, identity.attemptId);
  assert.notEqual(revised.task.pendingProposal?.proposalId, original.identity.id);
  const terminal = await completeTask(ctx, identity.taskId);
  assert.equal(terminal.task.state, 'completed');
  assert.equal(terminal.task.instructionRevision, 1);
  assert.deepEqual(terminal.task.mutationEvidence?.expectedPaths, ['greeting.txt']);
  assert.deepEqual(terminal.task.diffReview?.approvedScopePaths, ['greeting.txt']);
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  const snapshot = await ctx.view.snapshot();
  assertTerminalUi(snapshot, identity.taskId);
  assert.equal(snapshot.assistantCount, 0, 'steering must not create a Baat Kar answer');
  assert.equal(snapshot.workbenchControls, 0, 'task conversation must not expose Branch/Regenerate/Answer controls');
  await capture(ctx, reload ? 'steering-after-reload' : 'steering-before-approval', identity.taskId, identity.attemptId);
}

async function runSteeringAfterClose(ctx) {
  if (ctx.phase === 'primary') {
    const identity = await startAutonomous(ctx);
    const boundary = await waitApproval(ctx, identity.taskId, 'proposal');
    writeState(ctx.evidenceDir, {
      ...identity,
      approvalId: boundary.identity.id,
    });
    await capture(ctx, 'steering-close-before', identity.taskId, identity.attemptId);
    return;
  }
  const state = readState(ctx.evidenceDir);
  const restored = await waitApproval(ctx, state.taskId, 'proposal');
  assertSameBoundary(restored, state);
  const boundId = await ctx.view.steer('Use greeting.txt instead');
  assert.equal(boundId, state.taskId);
  const revised = await waitForTask(ctx.workspace, state.taskId, task => (task.instructionRevision ?? 0) === 1);
  assert.equal(revised.task.attemptId, state.attemptId);
  const terminal = await completeTask(ctx, state.taskId);
  assert.equal(terminal.task.state, 'completed');
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  assertTerminalUi(await ctx.view.snapshot(), state.taskId);
  await capture(ctx, 'steering-close-restored', state.taskId, state.attemptId);
}

async function runStop(ctx, boundary) {
  const identity = await startAutonomous(ctx);
  if (boundary === 'proposal') {
    await waitApproval(ctx, identity.taskId, 'proposal');
  } else if (boundary === 'execution') {
    await advanceTo(ctx, identity.taskId, 'mutation');
    await ctx.view.resolveVisibleApproval('mutation', 'approved');
  } else {
    await advanceTo(ctx, identity.taskId, 'delivery');
  }
  const stoppedId = await ctx.view.stop();
  assert.equal(stoppedId, identity.taskId);
  const cancelled = await waitForState(ctx, identity.taskId, 'cancelled');
  assert.equal(cancelled.task.terminalResult?.status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 2_000));
  assert.equal(taskEvidence(ctx.workspace, identity.taskId).task.state, 'cancelled', 'late output must not escape cancellation');
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  const snapshot = await ctx.view.snapshot();
  assertTerminalUi(snapshot, identity.taskId);
  await ctx.view.reloadWindow();
  const restored = await ctx.view.snapshot();
  assert.equal(restored.primaryAction, 'Send');
  assert.equal(restored.primaryTaskId, null);
  assert.equal(restored.actionableApprovals, 0);
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  await capture(ctx, `stop-${boundary}`, identity.taskId, identity.attemptId);
}

async function completeForConversation(ctx) {
  const identity = await startAutonomous(ctx);
  const terminal = await completeTask(ctx, identity.taskId);
  assert.equal(terminal.task.state, 'completed');
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  const snapshot = await ctx.view.snapshot();
  assertTerminalUi(snapshot, identity.taskId);
  return { ...identity, conversationId: snapshot.conversationId || identity.conversationId };
}

async function runNewChat(ctx) {
  const identity = await completeForConversation(ctx);
  assert.ok(identity.conversationId, 'completed task conversation must have a visible conversation identity');
  const empty = await ctx.view.newChat();
  assert.equal(empty.userCount, 0);
  assert.equal(empty.assistantCount, 0);
  assert.equal(empty.responseCount, 0);
  assert.equal(empty.actionableApprovals, 0);
  assert.equal(empty.primaryAction, 'Send');
  assert.notEqual(empty.conversationId, identity.conversationId);
  await ctx.view.openHistory();
  const history = await ctx.view.snapshot();
  assert.ok(history.conversationItems.some(item => item.id === identity.conversationId));
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  await capture(ctx, 'new-chat-after-completion', identity.taskId, identity.attemptId);
}

async function runReturnHistory(ctx) {
  const identity = await completeForConversation(ctx);
  assert.ok(identity.conversationId, 'completed task conversation must have a visible conversation identity');
  await ctx.view.newChat();
  const historical = await ctx.view.selectConversation(identity.conversationId);
  assertTerminalUi(historical, identity.taskId);
  assert.equal(historical.conversationId, identity.conversationId);
  assert.equal(taskEvidence(ctx.workspace, identity.taskId).task.state, 'completed');
  assertRepository(ctx.workspace, ctx.initialBranch, ctx.journey.result);
  await capture(ctx, 'return-completed-history', identity.taskId, identity.attemptId);
}

export async function runP1LifecycleJourney(ctx) {
  await ctx.view.open();
  switch (ctx.journey.id) {
    case 'baat-kar-complete-history': return runBaatKar(ctx);
    case 'saath-kar-rejected-restoration': return runSaathRejected(ctx);
    case 'saath-kar-approved-restoration': return runSaathApproved(ctx);
    case 'deterministic-complete': return runDeterministicComplete(ctx);
    case 'proposal-pending-close': return runPendingClose(ctx, 'proposal');
    case 'mutation-pending-close': return runPendingClose(ctx, 'mutation');
    case 'delivery-pending-close': return runPendingClose(ctx, 'delivery');
    case 'reload-approval-states': return runReloadApprovalStates(ctx);
    case 'steering-before-approval': return steerAndComplete(ctx);
    case 'steering-after-reload': return steerAndComplete(ctx, { reload: true });
    case 'steering-after-close': return runSteeringAfterClose(ctx);
    case 'stop-before-approval': return runStop(ctx, 'proposal');
    case 'stop-during-execution': return runStop(ctx, 'execution');
    case 'stop-before-delivery': return runStop(ctx, 'delivery');
    case 'new-chat-after-completion': return runNewChat(ctx);
    case 'return-completed-history': return runReturnHistory(ctx);
    default: throw new Error(`GUARDIAN_DRIVER_MISSING: no P1 lifecycle driver for ${ctx.journey.id}`);
  }
}
