import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function taskEvidence(workspace, taskId) {
  const dir = path.join(workspace, '.ollama-agent', 'autonomous-tasks', taskId);
  const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return { dir, task, events };
}

export function waitForTask(workspace, taskId, predicate, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const evidence = taskEvidence(workspace, taskId);
        if (predicate(evidence.task, evidence.events)) return resolve(evidence);
      } catch {
        // The durable files are created just after acknowledgement; retry.
      }
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for durable task ${taskId}`));
      setTimeout(poll, 250);
    };
    poll();
  });
}

export function coreEvidence(coreDataDir, attemptId) {
  const databasePath = path.join(coreDataDir, 'core.db');
  if (!fs.existsSync(databasePath)) {
    return { databasePath, attempt: null, modelInvocations: [], runtimeEvents: [] };
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) ?? null;
    const modelInvocations = db.prepare('SELECT * FROM model_invocations WHERE attemptId = ? ORDER BY startedAt').all(attemptId);
    const runtimeEvents = db.prepare(`
      SELECT * FROM runtime_events
      WHERE entityId = ?
         OR (domain = 'model_invocation' AND entityId IN (SELECT id FROM model_invocations WHERE attemptId = ?))
      ORDER BY sequence
    `).all(attemptId, attemptId);
    return { databasePath, attempt, modelInvocations, runtimeEvents };
  } finally {
    db.close();
  }
}

export function latestCoreTurn(coreDataDir, prompt) {
  const databasePath = path.join(coreDataDir, 'core.db');
  if (!fs.existsSync(databasePath)) return null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const request = db.prepare(`
      SELECT * FROM requests
      WHERE currentMessage = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(prompt);
    if (!request) return null;
    const attempt = db.prepare(`
      SELECT * FROM attempts
      WHERE requestId = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(request.id) ?? null;
    const approvals = attempt
      ? db.prepare('SELECT * FROM approvals WHERE attemptId = ? ORDER BY requestedAt').all(attempt.id)
      : [];
    const messages = request.conversationId
      ? db.prepare('SELECT * FROM conversation_messages WHERE conversationId = ? ORDER BY seq').all(request.conversationId)
      : [];
    const toolInvocations = attempt
      ? db.prepare('SELECT * FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt').all(attempt.id)
      : [];
    return { databasePath, request, attempt, approvals, messages, toolInvocations };
  } finally {
    db.close();
  }
}

/**
 * M38 governed Saath Kar capability approvals (and their tool invocations)
 * are NOT attached to the user-visible chat attempt that latestCoreTurn()
 * returns. ensureCapabilityAttempt() (core/domain/capabilityDispatch.ts)
 * creates a separate, idempotent "capability dispatch anchor" attempt per
 * conversation — a synthetic request whose currentMessage is
 * 'M38 governed capability dispatch anchor for <conversationId>' and whose
 * correlationId is set to that same durable Core conversationId — and every
 * approval/tool_invocation for that conversation's Saath Kar turns hangs off
 * the anchor attempt's id, not the visible attempt's id. Querying
 * `approvals WHERE attemptId = <visible attempt id>` always returns zero
 * rows for Saath Kar, no matter how long you wait — this is not a timing
 * race, it's the wrong key. Guardian assertions about Saath Kar approval/
 * tool-invocation identity must resolve the anchor attempt via the visible
 * turn's conversationId first.
 */
export function capabilityAnchorAttempt(coreDataDir, conversationId) {
  const databasePath = path.join(coreDataDir, 'core.db');
  if (!fs.existsSync(databasePath)) return null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const request = db.prepare(`
      SELECT * FROM requests
      WHERE correlationId = ? AND currentMessage = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(conversationId, `M38 governed capability dispatch anchor for ${conversationId}`);
    if (!request) return null;
    const attempt = db.prepare(`
      SELECT * FROM attempts WHERE requestId = ? ORDER BY createdAt DESC LIMIT 1
    `).get(request.id) ?? null;
    const approvals = attempt
      ? db.prepare('SELECT * FROM approvals WHERE attemptId = ? ORDER BY requestedAt').all(attempt.id)
      : [];
    const toolInvocations = attempt
      ? db.prepare('SELECT * FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt').all(attempt.id)
      : [];
    return { databasePath, request, attempt, approvals, toolInvocations };
  } finally {
    db.close();
  }
}

/**
 * The webview's local conversation id ('default', or a generated taskId — see
 * AgentPanel.ts DEFAULT_CONVERSATION_ID) is a distinct identity from Core's
 * durable conversationId (conversations.id / requests.conversationId). Core's
 * M35 workspace_conversations ledger (core/db/migrations.ts) is the durable,
 * queryable proof that a given localConversationId and coreConversationId
 * name the same conversation. Guardian assertions that need to prove
 * correspondence — rather than merely avoid comparing across the wrong
 * vocabulary — should use this lookup instead of assuming the two ids match.
 */
export function conversationLedgerEntry(coreDataDir, localConversationId) {
  const databasePath = path.join(coreDataDir, 'core.db');
  if (!fs.existsSync(databasePath)) return null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT * FROM workspace_conversations
      WHERE localConversationId = ?
      ORDER BY updatedAt DESC
      LIMIT 1
    `).get(localConversationId) ?? null;
  } finally {
    db.close();
  }
}

export function taskApprovalIdentity(task, kind) {
  if (kind === 'proposal') {
    return task.pendingProposal ? {
      kind,
      id: task.pendingProposal.proposalId,
      instructionRevision: task.pendingProposal.instructionRevision ?? 0,
    } : null;
  }
  if (kind === 'mutation') {
    return task.pendingMutationApproval ? {
      kind,
      id: task.pendingMutationApproval.requestId,
      proposalId: task.pendingMutationApproval.proposalId,
      instructionRevision: task.pendingMutationApproval.instructionRevision ?? 0,
    } : null;
  }
  if (kind === 'delivery' && task.state === 'waiting_for_delivery_approval') {
    return {
      kind,
      id: `${task.attemptId}:delivery:r${task.instructionRevision ?? 0}:${task.diffReview?.reviewedDiffFingerprint ?? 'pending'}`,
      instructionRevision: task.instructionRevision ?? 0,
    };
  }
  return null;
}

export function routeCounters(task, events, core) {
  const autonomousText = JSON.stringify({ task, events });
  const deterministicProposalSelected = autonomousText.includes('deterministic_proposal_generated');
  const graphExecutions = (autonomousText.match(/graph_execution/g) ?? []).length;
  const graphStageEvents = (autonomousText.match(/graph_stage/g) ?? []).length
    + core.runtimeEvents.filter(event => String(event.eventType).includes('graph_stage')).length;
  return {
    executionProfile: deterministicProposalSelected && graphExecutions === 0 ? 'trivial' : 'nontrivial-or-unproven',
    deterministicProposalSelected,
    modelCalls: core.modelInvocations.length,
    graphExecutions,
    graphStageEvents,
    qwen30bSelected: core.runtimeEvents.some(event => {
      let metadata = {};
      try { metadata = JSON.parse(event.metadata || '{}'); } catch { /* malformed evidence fails other gates */ }
      return [metadata.selectedModel, metadata.requestedModel, metadata.actualModel, metadata.policyModel]
        .some(model => model === 'qwen3-coder:30b');
    }) || core.modelInvocations.some(invocation =>
      [invocation.requestedModel, invocation.actualModel, invocation.policyModel]
        .some(model => model === 'qwen3-coder:30b'),
    ) || Object.values(task.stageRouting ?? {}).some(route => route?.model === 'qwen3-coder:30b'),
  };
}
