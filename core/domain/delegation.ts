/**
 * Alpha closure — one delegation path for both the host API (`/v1/agents/delegate`) and the Chief's
 * `delegate_to_agent` tool. Limits (depth ≤ 2, ≤ 3 active children, dedupe, untrusted-brief rule) are
 * enforced by `proposeHandoff`; the child's scope is (child definition ∩ every parent layer ∩ grant), frozen
 * at submission, so nothing here can widen authorization.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { agentScopeForAttempt, assignAgentRun, chiefDelegationScope, getAgentDefinition, getHandoff, markHandoff, proposeHandoff, reconcileHandoffs, type Grant, type HandoffRecord } from './agents';
import { submitRequest } from './submission';
import { frozenWorkspaceAccess } from './permissionModes';
import { createConversation, listMessages } from './conversations';

export interface DelegationDefaults { selectedProvider?: string | null; selectedModel?: string | null }

export interface StartedDelegation { handoff: HandoffRecord; attemptId: string | null; requestId: string | null; conversationId: string | null; duplicate: boolean }

export function startDelegation(db: CoreDatabase, input: {
  parentAttemptId: string; toAgentId: string; brief: string; grant?: Grant | null; clientId: string;
  defaults?: DelegationDefaults; workspaceRoot?: string | null;
  /** `own` = the child gets its own conversation (its transcript is the result record); `parent` = the parent's conversation. */
  conversation: 'own' | 'parent';
}): StartedDelegation {
  const parent = db.get<{ requestId: string; conversationId: string | null }>('SELECT a.requestId AS requestId, q.conversationId AS conversationId FROM attempts a JOIN requests q ON q.id = a.requestId WHERE a.id = ?', [input.parentAttemptId]);
  if (!parent) throw new CoreError('not_found', `parent task '${input.parentAttemptId}' does not exist`);
  const handoff = proposeHandoff(db, { parentAttemptId: input.parentAttemptId, toAgentId: input.toAgentId, brief: input.brief, grant: input.grant ?? null });
  if (handoff.existing && handoff.childRequestId) {
    const child = db.get<{ id: string; conversationId: string | null }>('SELECT a.id AS id, q.conversationId AS conversationId FROM attempts a JOIN requests q ON q.id = a.requestId WHERE a.requestId = ? ORDER BY a.createdAt DESC LIMIT 1', [handoff.childRequestId]);
    return { handoff, attemptId: child?.id ?? null, requestId: handoff.childRequestId, conversationId: child?.conversationId ?? null, duplicate: true };
  }
  const parentScope = agentScopeForAttempt(db, input.parentAttemptId);
  const workspaceRoot = parentScope?.conversationRoot ?? input.workspaceRoot ?? null;
  const target = getAgentDefinition(db, input.toAgentId);
  const brief = input.brief.trim();
  return db.transaction(() => {
    const conversationId = input.conversation === 'parent'
      ? parent.conversationId
      : createConversation(db, { mode: 'baat_kar', title: `${target.name} · ${brief.slice(0, 60)}`, actor: 'core:delegation', clientId: input.clientId }).id;
    const submitted = submitRequest(db, {
      clientId: input.clientId,
      currentMessage: brief,
      requestedMode: 'baat_kar',
      conversationId,
      requestedProvider: input.defaults?.selectedProvider ?? null,
      requestedModel: input.defaults?.selectedModel ?? null,
      selectedProvider: input.defaults?.selectedProvider ?? null,
      selectedModel: input.defaults?.selectedModel ?? null,
      workspaceRoot,
      effectiveAllowedTools: [],
      // A folder the person opened read-only stays read-only for every agent the turn delegates to.
      toolPermissionPolicy: frozenWorkspaceAccess(db, [input.parentAttemptId]) === 'read' ? { workspaceAccess: 'read' } : {},
      capability: { hasWorkspace: Boolean(workspaceRoot), gitCapable: false },
      correlationId: `delegation:${handoff.id}`,
      idempotencyKey: `delegation:${handoff.id}`,
    } as Parameters<typeof submitRequest>[1]);
    // A parent without its own agent scope is an ordinary Pandesh turn: it delegates within the user's turn
    // (the conversation's folder; internet only with the user's OK).
    const parentEffective = parentScope ?? chiefDelegationScope(workspaceRoot);
    assignAgentRun(db, { requestId: submitted.request.id, agentId: target.id, conversationRoot: workspaceRoot, parent: parentEffective, grant: input.grant ?? null, handoffId: handoff.id });
    markHandoff(db, handoff.id, { status: 'running', childRequestId: submitted.request.id });
    return { handoff: getHandoff(db, handoff.id), attemptId: submitted.attempt.id, requestId: submitted.request.id, conversationId, duplicate: false };
  });
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export interface DelegationOutcome { status: string; answer: string | null; attemptId: string | null; handoffStatus: string }

/** The child's latest attempt state and final answer (from its own conversation). */
export function delegationOutcome(db: CoreDatabase, handoffId: string): DelegationOutcome {
  reconcileHandoffs(db);
  const h = getHandoff(db, handoffId);
  if (!h.childRequestId) return { status: h.status, answer: null, attemptId: null, handoffStatus: h.status };
  const a = db.get<{ id: string; status: string; conversationId: string | null; requestId: string }>('SELECT a.id AS id, a.status AS status, q.conversationId AS conversationId, a.requestId AS requestId FROM attempts a JOIN requests q ON q.id = a.requestId WHERE a.requestId = ? ORDER BY a.createdAt DESC LIMIT 1', [h.childRequestId]);
  if (!a) return { status: 'unknown', answer: null, attemptId: null, handoffStatus: h.status };
  let answer: string | null = null;
  if (a.conversationId && TERMINAL.has(a.status)) {
    const msgs = listMessages(db, a.conversationId, { limit: 2000 });
    const last = [...msgs].reverse().find((m) => m.role === 'assistant');
    answer = last ? String(last.content) : null;
  }
  return { status: a.status, answer, attemptId: a.id, handoffStatus: h.status };
}

export function isTerminalAttemptStatus(status: string): boolean { return TERMINAL.has(status); }
