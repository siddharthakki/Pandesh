/**
 * M38 — Core-owned governed capability dispatch.
 *
 * The single entry point external-service capability calls (GitHub, governed
 * research, and future adapters) go through when reached from any caller —
 * the extension-host Forge/agent tool-calling path included. Core owns the
 * whole decision: capability health, risk classification, the
 * allow/approval-required/denied decision, the approval envelope and record,
 * redaction, `tool_invocations` evidence, idempotency, adapter dispatch, and
 * the terminal result. A caller (e.g. `src/tools/ToolExecutor.ts`) may only
 * relay a human decision to a *specific* approval id returned here — it must
 * never decide, execute, or record evidence on its own (ADR-7).
 *
 * No new attempt/approval mechanism is introduced: one lightweight anchor
 * attempt is created (or reused, idempotently) per external `correlationId`
 * — e.g. a Forge task id, which today has no Core attempt of its own — and
 * every consequential call on it reuses the exact same
 * `core/domain/approvals.ts` 'mutation' gate and `core/domain/toolInvocations.ts`
 * evidence trail that Saath Kar attempts already use.
 */
import type { CoreDatabase } from '../db/connection';
import { createRequest } from './requests';
import { createAttempt, getAttempt, transitionAttempt, requestCancelAttempt, settleOwnedCapabilityAttempts, setCapabilityExecutionAbort } from './attempts';
import { isTerminalAttemptStatus } from './attemptTransitions';
import { createApproval, resolveApproval as resolveApprovalRecord, listApprovalsForAttempt, getApproval, getApprovalActionArguments, expirePendingApprovalsForAttempt } from './approvals';
import {
  canonicalArgumentsDigest,
  canonicalJson,
  hasProjectedBulkValue,
  projectApprovalArguments,
} from './approvalArguments';
import { startToolInvocation, completeToolInvocation, listToolInvocationsForAttempt } from './toolInvocations';
import { withIdempotency, lookupIdempotencyResult } from './idempotency';
import { CoreError } from './errors';
import { getAttemptContext } from './attemptContext';
import { evaluateMachineControlAuthorization, isUnattendedClientId } from './processTerminationPolicy';
import type {
  ApprovalRecord,
  AttemptRecord,
  ToolInvocationRecord,
  CapabilityDispatchResult,
  CapabilityActionRestoreEntry,
  CapabilityActionsSnapshot,
} from '../shared/wireTypes';
import type { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import type { ExecutionGrant } from '../security/types';
import { parseBaselineIdentity, type WriteBaselineIdentity, type WriteProposalPresentation } from '../runtime/writeProposal';
import {
  CORE_POLICY_ACTOR,
  defaultCommandPolicyEnvelope,
  envelopeFromApprovalSummary,
  evaluateGovernedAction,
  type CommandPolicyEnvelope,
  type GovernedActionPolicyResult,
} from '../runtime/commandPolicy';
import {
  AUTHORIZE_MISSION_TOOL,
  evaluateAuthorizedDispatch,
  markMissionAuthorized,
  markMissionRejected,
  recordAuthorizedAction,
} from '../runtime/missionAuthorization';

/**
 * In-process registry of the `AbortController` driving each attempt's
 * currently-executing capability call. Keyed by attemptId so a concurrent
 * `cancelCapabilityAction` call (a separate HTTP request) can abort an
 * adapter call already in flight from another request — cancellation is real
 * process-level abort, not a status flag, matching the existing
 * `toolRunner.ts`/`researchRunner.ts` pattern.
 */
const activeExecutions = new Map<string, AbortController>();
setCapabilityExecutionAbort((attemptId) => {
  activeExecutions.get(attemptId)?.abort();
});

/** Identity/comparison view of an action: bulk arguments projected to their
 * byte length and SHA-256, so a legacy row that stored raw content and a new
 * projected row of the same action compare equal, and the hash still binds
 * the full bytes. */
function actionSummary(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  return { toolName, arguments: projectApprovalArguments(toolName, args).projected };
}

function approvalActionSummary(summary: Record<string, unknown>): Record<string, unknown> {
  return actionSummary(
    String(summary.toolName ?? ''),
    (summary.arguments ?? {}) as Record<string, unknown>,
  );
}

/** Finds the durable invocation belonging to one exact approved action. Before
 * this correction repeated dispatch of an already-approved action always
 * created a new invocation and called the adapter again. Prefer terminal
 * evidence when old data already contains duplicates; otherwise return the
 * single pending invocation so a restarted Core can resume that row rather
 * than minting another one. */
function findMatchingInvocation(
  invocations: ToolInvocationRecord[],
  approval: ApprovalRecord,
): ToolInvocationRecord | undefined {
  const exact = invocations.find((invocation) => invocation.approvalId === approval.id);
  if (exact) return exact;
  const target = canonicalJson(approvalActionSummary(approval.summary));
  const candidates = invocations.filter(
    (invocation) => !invocation.approvalId
      && canonicalJson(actionSummary(invocation.toolName, invocation.argsSummary)) === target
      && invocation.startedAt >= approval.requestedAt,
  );
  return candidates.find((invocation) => invocation.status === 'succeeded')
    ?? candidates.find((invocation) => invocation.status === 'failed' || invocation.status === 'cancelled')
    ?? candidates[0];
}

/** Ensures exactly one Core attempt anchors this correlationId (idempotent —
 * a second call with the same correlationId/clientId never creates a second
 * attempt), then makes sure it is running so approvals can be requested on it.
 *
 * `ownerAttemptId` marks the anchor as belonging to exactly one owning attempt
 * and is written once, at creation. Only such an anchor is ever settled by
 * `settleCapabilityAttempt`; an anchor reused across callers stays open. A
 * settled anchor is never reopened: a replayed dispatch after the owner
 * terminated is refused here rather than mutating the workspace a second
 * time. */
export function ensureCapabilityAttempt(
  db: CoreDatabase,
  input: { correlationId: string; actor: string; clientId: string; ownerAttemptId?: string },
): string {
  const attemptId = withIdempotency(
    db,
    { key: input.correlationId, clientId: input.clientId, routeId: 'm38.capabilityAttempt.ensure' },
    { correlationId: input.correlationId },
    () => {
      const request = createRequest(db, {
        clientId: input.clientId,
        currentMessage: `M38 governed capability dispatch anchor for ${input.correlationId}`,
        requestedMode: 'saath_kar',
        resolvedMode: 'saath_kar',
        routeReason: 'm38_capability_dispatch',
        contextPolicy: {
          includeConversationHistory: false,
          includeProjectContext: false,
          includeRepositoryContext: false,
          includeGlobalStoryContext: false,
        },
        correlationId: input.correlationId,
      });
      const attempt = createAttempt(db, {
        requestId: request.id,
        kind: 'saath_kar',
        actor: input.actor,
        clientId: input.clientId,
        parentAttemptId: input.ownerAttemptId ?? null,
      });
      return attempt.id;
    },
  );
  const attempt = getAttempt(db, attemptId);
  if (isTerminalAttemptStatus(attempt.status)) {
    throw new CoreError(
      'invalid_transition',
      `capability anchor attempt '${attemptId}' is ${attempt.status}; a settled anchor is never reopened`,
    );
  }
  if (attempt.status === 'created') {
    transitionAttempt(db, attemptId, { toStatus: 'running', actor: input.actor, clientId: input.clientId });
  }
  return attemptId;
}

export type { CapabilityAttemptOutcome } from './attempts';

/**
 * Settles the capability anchor attempts an owning attempt created, so a
 * finished owner never leaves its mutation attempt running.
 *
 * Aborts any in-flight adapter on those anchors first, then delegates to the
 * attempt lifecycle, which is also invoked automatically when the owner
 * itself becomes terminal. Shared anchors have no parent and are not
 * selected. Idempotent.
 */
export function settleCapabilityAttempt(
  db: CoreDatabase,
  input: {
    ownerAttemptId: string;
    outcome: import('./attempts').CapabilityAttemptOutcome;
    reason?: string;
    actor: string;
    clientId?: string | null;
  },
): AttemptRecord[] {
  return settleOwnedCapabilityAttempts(db, input);
}

/** Read-only counterpart to `ensureCapabilityAttempt`: finds the anchor
 * attempt already created for this correlationId, if any, WITHOUT ever
 * creating one — a restoration query must never mint a new attempt/approval/
 * idempotency row just by asking whether one exists. */
function findExistingCapabilityAttemptId(db: CoreDatabase, correlationId: string, clientId: string): string | undefined {
  return lookupIdempotencyResult<string>(db, { key: correlationId, clientId, routeId: 'm38.capabilityAttempt.ensure' });
}

/**
 * Every anchor whose cards belong to this correlationId.
 *
 * A caller discovers cards by the identity it knows — a conversation id or a
 * Forge task id. A mission anchors on its own attempt instead, so that Core
 * can settle it when the mission ends, which would otherwise hide its
 * authorization card from that same caller. Owned anchors are therefore
 * resolved through their owning attempt's conversation, keeping discovery
 * unchanged for the caller while ownership stays per mission.
 */
function findCapabilityAttemptIds(db: CoreDatabase, correlationId: string, clientId: string): string[] {
  const direct = findExistingCapabilityAttemptId(db, correlationId, clientId);
  const owned = db.all<{ id: string }>(
    `SELECT anchor.id AS id
       FROM attempts anchor
       JOIN attempts owner ON owner.id = anchor.parentAttemptId
       JOIN requests request ON request.id = owner.requestId
      WHERE request.conversationId = ?
      ORDER BY anchor.createdAt`,
    [correlationId],
  ).map((row) => row.id);
  const directAttempts = db.all<{ id: string }>(
    `SELECT a.id AS id
       FROM attempts a
       JOIN requests r ON r.id = a.requestId
      WHERE r.conversationId = ?
      ORDER BY a.createdAt`,
    [correlationId],
  ).map((row) => row.id);
  return [...new Set([...(direct ? [direct] : []), ...owned, ...directAttempts])];
}

/**
 * M38 restart restoration: lists the restorable capability actions (mutation
 * approvals, joined with their tool-invocation evidence) anchored on this
 * correlationId's Core attempt, if one exists. Purely a read — never creates
 * an attempt, approval, or idempotency row. This is how a webview recreated
 * after a webview reload or a full Extension Host restart re-derives which
 * approval card(s) to show, from Core's own durable state, without
 * resubmitting the task or creating any new approval/idempotency key.
 */
export function listCapabilityActions(
  db: CoreDatabase,
  input: { correlationId: string; clientId: string },
): CapabilityActionsSnapshot {
  const attemptIds = findCapabilityAttemptIds(db, input.correlationId, input.clientId);
  if (attemptIds.length === 0) return { attemptId: null, actions: [] };

  const approvals = attemptIds.flatMap((id) => listApprovalsForAttempt(db, id).filter((a) => a.kind === 'mutation'));
  const invocations = attemptIds.flatMap((id) => listToolInvocationsForAttempt(db, id));

  const actions: CapabilityActionRestoreEntry[] = approvals.map((approval) => {
    const matchedInvocation = findMatchingInvocation(invocations, approval);
    const toolName = String((approval.summary as Record<string, unknown>).toolName ?? '');
    const args = ((approval.summary as Record<string, unknown>).arguments ?? {}) as Record<string, unknown>;

    const attempt = db.get<{ status: import('../shared/wireTypes').AttemptStatus }>('SELECT status FROM attempts WHERE id = ?', [approval.attemptId]);
    const attemptTerminal = !attempt || isTerminalAttemptStatus(attempt.status);
    if (attemptTerminal && approval.status === 'pending') {
      try {
        expirePendingApprovalsForAttempt(db, approval.attemptId, { actor: 'system:reconcile', reason: 'terminal attempt reconciliation' });
        approval.status = 'expired';
      } catch {}
    }

    let outcome: CapabilityActionRestoreEntry['outcome'];
    if (matchedInvocation) {
      outcome = matchedInvocation.status === 'pending' ? 'approved' : matchedInvocation.status;
    } else if (approval.status === 'pending' && !attemptTerminal) {
      outcome = 'pending';
    } else if (approval.status === 'approved') {
      outcome = 'approved';
    } else {
      outcome = 'rejected';
    }

    const actionable = approval.status === 'pending' && !matchedInvocation && !attemptTerminal;

    return {
      approvalId: approval.id,
      attemptId: approval.attemptId,
      kind: approval.kind,
      status: approval.status,
      actionable,
      toolName,
      arguments: args,
      requestedAt: approval.requestedAt,
      resolvedAt: approval.resolvedAt,
      resolution: approval.resolution,
      expectedAttemptRevision: approval.expectedAttemptRevision,
      expectedAttemptStatus: approval.expectedAttemptStatus,
      requestedActionDigest: approval.requestedActionDigest,
      frozenContextHash: approval.frozenContextHash,
      revision: approval.revision,
      presentation: approval.presentation,
      outcome,
      invocation: matchedInvocation
        ? { id: matchedInvocation.id, status: matchedInvocation.status, evidence: matchedInvocation.evidence, exitCode: matchedInvocation.exitCode }
        : null,
    };
  });

  return { attemptId: attemptIds[0], actions };
}

export interface DispatchCapabilityInput {
  correlationId: string;
  /** Marks the anchor attempt as owned by exactly this attempt, so Core can
   * settle it when that attempt terminates. Core's own loops set it; HTTP
   * callers never supply it, and their anchors stay shared and unsettled. */
  ownerAttemptId?: string;
  /** Core-owned identity of the real request/attempt authorizing this action.
   * Keeps rejection sticky inside one Saath turn without allowing a rejected
   * action to suppress a later explicit user resubmission. HTTP callers never
   * supply this field. */
  scopeIdentity?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  cwd: string;
  actor: string;
  clientId: string;
  signal?: AbortSignal;
  /**
   * Core-computed, proposal-time identity for a consequential mutation (today:
   * `write_file` — see `core/runtime/writeProposal.ts`). Set only by Core's own
   * Saath Kar loop before the approval checkpoint exists; HTTP callers never
   * supply it. `expectedBaseline` is frozen into the approval summary (so the
   * requested-action digest binds it and it survives restart);
   * `presentation` is stored beside the approval as the immutable rendering
   * the human was shown, and is never part of the digest.
   */
  proposal?: {
    expectedBaseline: WriteBaselineIdentity;
    presentation: WriteProposalPresentation;
  };
  /**
   * Draft-bound Gmail send safety, set only by `connectorDispatch.ts` for
   * `gmail_send_draft` (never by an HTTP caller): the digest recorded when the
   * draft being sent was created, and the exact recipients/subject/body
   * rendering to show on the send-confirmation approval. `expectedDigest` is
   * frozen into the approval summary and handed back to the adapter as
   * `ToolExecutionContext.gmailDraftExpectedDigest`, which re-verifies it
   * against a fresh read of the live draft immediately before sending — the
   * same freeze-then-reverify shape `proposal.expectedBaseline` uses for
   * `write_file`, parallel rather than merged because the two domains' baseline
   * shapes are unrelated.
   */
  gmailDraftProposal?: {
    expectedDigest: string;
    presentation: Record<string, unknown>;
  };
  /**
   * Plain-language rendering of a connector action (e.g. the exact calendar
   * event), built by the connector's `prepare` hook in `connectorDispatch.ts`.
   * Stored beside the approval like the other presentations; never part of the digest.
   */
  connectorPresentation?: Record<string, unknown>;
}

export type DispatchCapabilityResult = CapabilityDispatchResult;

/**
 * The identity of a consequential action: what the human is deciding about.
 * Deliberately excludes `expectedBaseline` — that is a *precondition* frozen
 * onto the approval, enforced immediately before the mutation, not part of
 * what makes two dispatch attempts the same action. Excluding it keeps an
 * already-approved action re-dispatchable (the restored-card path in
 * `AgentPanel.resolveRestoredCapabilityApproval` re-sends only
 * {toolName, arguments}), while a workspace that moved on is still refused —
 * by the baseline check, with an honest stale-proposal result, rather than by
 * silently asking for a second approval.
 */
function actionIdentity(summary: Record<string, unknown>): string {
  return canonicalJson({
    toolName: summary.toolName,
    arguments: approvalActionSummary(summary).arguments,
    scopeIdentity: summary.scopeIdentity,
  });
}

/** Finds a prior approval on this attempt for the exact same (toolName, arguments)
 * action, most recent first — this is what makes a denial sticky (a retry of the
 * identical action does not get asked again) and an approval reusable (a retried
 * dispatch after approval executes rather than asking a second time). */
function findMatchingApproval(db: CoreDatabase, attemptId: string, summary: Record<string, unknown>): ApprovalRecord | undefined {
  const target = actionIdentity(summary);
  const candidates = listApprovalsForAttempt(db, attemptId).filter((a) => a.kind === 'mutation' && actionIdentity(a.summary) === target);
  // `listApprovalsForAttempt` orders by (requestedAt, insertion order), so the
  // last candidate is the newest even when two share a millisecond.
  return candidates[candidates.length - 1];
}

function resolveDispatchEnvelope(db: CoreDatabase, input: DispatchCapabilityInput, attemptId: string): CommandPolicyEnvelope {
  let workspaceRoot = input.cwd;
  const flags = defaultCommandPolicyEnvelope(workspaceRoot);
  const identities = [input.scopeIdentity, attemptId].filter((value): value is string => Boolean(value));
  for (const identity of identities) {
    try {
      const context = getAttemptContext(db, identity);
      if (context.workspaceRoot) workspaceRoot = context.workspaceRoot;
      flags.pushAuthorized = context.approvalPolicy?.pushAuthorized === true;
      flags.networkAuthorized = context.approvalPolicy?.networkAuthorized === true;
      flags.installAuthorized = context.approvalPolicy?.installAuthorized === true;
      flags.browserInstallAuthorized = context.approvalPolicy?.browserInstallAuthorized === true;
      if (context.workspaceRoot) break;
    } catch {
      // Capability-anchor attempts may lack a real workspace; keep looking.
    }
  }
  return { ...flags, workspaceRoot };
}

function policySummaryFields(
  envelope: CommandPolicyEnvelope,
  policy: GovernedActionPolicyResult,
  decision: 'denied' | 'review_required',
): Record<string, unknown> {
  return {
    workspaceRoot: envelope.workspaceRoot,
    pushAuthorized: envelope.pushAuthorized,
    networkAuthorized: envelope.networkAuthorized,
    installAuthorized: envelope.installAuthorized,
    browserInstallAuthorized: envelope.browserInstallAuthorized === true,
    requestedCommand: policy.requestedCommand ?? null,
    requestedPath: policy.requestedPath ?? null,
    policyDecision: decision,
    policyReason: policy.reason,
  };
}

function evaluateInputPolicy(
  input: DispatchCapabilityInput,
  envelope: CommandPolicyEnvelope,
): GovernedActionPolicyResult {
  return evaluateGovernedAction({
    toolName: input.toolName,
    arguments: input.arguments,
    envelope,
  });
}

/**
 * Machine control (terminating a process, stopping a service, killing what
 * the port manager believes is orphaned) needs an authorization a plain
 * task does not have. An unattended scheduled task has no human who could
 * approve it, so the action is refused rather than performed without a
 * decision. Attended tasks are unaffected: they still need the ordinary
 * human approval, and the ownership boundary still verifies the target at
 * execution time.
 *
 * This narrows the TOOL SURFACE by authorization. It never disables the
 * scheduler, the daily brief, reminders, or previously authorized
 * Gmail/Calendar actions.
 */
function machineControlDecision(
  db: CoreDatabase,
  input: DispatchCapabilityInput,
  attemptId: string,
): GovernedActionPolicyResult | null {
  const machineControlAuthorized = readMachineControlAuthorization(db, input, attemptId);
  const authorization = evaluateMachineControlAuthorization({
    toolName: input.toolName,
    arguments: input.arguments,
    unattended: isUnattendedClientId(input.clientId),
    machineControlAuthorized,
  });
  if (authorization.decision === 'allow') return null;
  return {
    decision: 'deny',
    reason: authorization.reason,
    normalizedArguments: input.arguments,
  };
}

/** Machine control can also be authorized explicitly by the frozen task envelope. */
function readMachineControlAuthorization(
  db: CoreDatabase,
  input: DispatchCapabilityInput,
  attemptId: string,
): boolean {
  const identities = [input.scopeIdentity, attemptId].filter((value): value is string => Boolean(value));
  for (const identity of identities) {
    try {
      const context = getAttemptContext(db, identity);
      const policy = context.approvalPolicy as Record<string, unknown> | undefined;
      if (policy?.machineControlAuthorized === true) return true;
    } catch {
      // No frozen context for this identity: fall through to the next one.
    }
  }
  return false;
}

function recordPolicyDenial(
  db: CoreDatabase,
  input: DispatchCapabilityInput,
  attemptId: string,
  summary: Record<string, unknown>,
  envelope: CommandPolicyEnvelope,
  policy: GovernedActionPolicyResult,
  actionArguments?: Record<string, unknown>,
): ApprovalRecord {
  return createApproval(db, {
    attemptId,
    kind: 'mutation',
    summary: {
      ...summary,
      ...policySummaryFields(envelope, policy, 'denied'),
    },
    ...(actionArguments ? { actionArguments } : {}),
    actor: input.actor,
    clientId: input.clientId,
    initialResolution: 'rejected',
    resolvedBy: CORE_POLICY_ACTOR,
  });
}

function forceRejectForbiddenApproval(
  db: CoreDatabase,
  approval: ApprovalRecord,
  input: { actor: string; clientId: string },
  policy: GovernedActionPolicyResult,
): ApprovalRecord {
  return resolveApprovalRecord(db, approval.id, {
    resolution: 'rejected',
    attemptId: approval.attemptId,
    gate: 'mutation',
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    actor: CORE_POLICY_ACTOR,
    clientId: input.clientId,
    requestedActor: input.actor,
    policyDecision: 'denied',
    policyReason: policy.reason,
  });
}

async function executeAndRecord(
  db: CoreDatabase,
  registry: GovernedCapabilityRegistry,
  attemptId: string,
  input: DispatchCapabilityInput,
  existingPending?: ToolInvocationRecord,
  approvalId?: string,
  expectedBaseline?: WriteBaselineIdentity,
  envelope?: CommandPolicyEnvelope,
  gmailDraftExpectedDigest?: string,
): Promise<ToolInvocationRecord> {
  const kernel = LocalAutonomySecurityKernel.getInstance(db);
  const isConsequential = input.toolName === 'run_command'
    || input.toolName === 'propose_file_change'
    || input.toolName === 'propose_text_edit';
  let securityGrant: ExecutionGrant | undefined;

  if (isConsequential) {
    const policyEnvelopeForGrant = envelope ?? resolveDispatchEnvelope(db, input, attemptId);
    const req = kernel.normalizeRequest({
      attemptId,
      executor: 'core:capability_dispatch',
      capability: input.toolName === 'run_command' ? 'process' : 'filesystem',
      workspaceRoot: policyEnvelopeForGrant.workspaceRoot,
      targetResource: String(input.arguments['path'] ?? policyEnvelopeForGrant.workspaceRoot),
      command: input.toolName === 'run_command' ? String(input.arguments['command'] ?? '') : null,
      arguments: input.arguments,
      origin: { actor: input.actor, isModelGenerated: true },
      riskLevel: 'consequential',
    });
    const decision = kernel.authorize(req, approvalId ? { approvalId } : undefined);
    if (decision.decision !== 'ALLOW' || !decision.grant) {
      throw new CoreError('invalid_request', `SecurityKernel rejected dispatch: ${decision.reason}`);
    }
    securityGrant = decision.grant;
  }
  const evidenceArguments = registry.redactArguments(input.toolName, input.arguments);
  const policyEnvelope = envelope ?? resolveDispatchEnvelope(db, input, attemptId);
  const policy = evaluateInputPolicy(input, policyEnvelope);
  if (policy.decision === 'deny') {
    throw new CoreError('invalid_request', `Core denied this action: ${policy.reason}`, {
      policyDecision: 'denied',
      policyReason: policy.reason,
      actor: CORE_POLICY_ACTOR,
    });
  }
  const started = existingPending ?? startToolInvocation(db, {
    attemptId,
    approvalId: approvalId ?? null,
    toolName: input.toolName,
    // The started event copies argsSummary into 8 KiB-bounded metadata, so the
    // invocation records the same hash-bound projection as the approval
    // summary; the full bytes stay in the approval's digest-bound payload.
    argsSummary: projectApprovalArguments(input.toolName, evidenceArguments).projected,
    actor: input.actor,
    clientId: input.clientId,
  });

  // A local controller Core itself owns (so cancelCapabilityAction can abort
  // it from a concurrent request), linked to any caller-supplied signal.
  const controller = new AbortController();
  // M39 correction: cancellation requested BEFORE this dispatch must fence the
  // adapter call itself, not merely the terminal evidence write. Without this
  // the adapter still ran to completion (and, for a domain adapter like
  // memory, still committed its transaction) while the invocation was recorded
  // as 'cancelled' — a durable write with no user-visible action behind it.
  if (getAttempt(db, attemptId).cancelRequestedAt) controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  activeExecutions.set(attemptId, controller);

  let result: Awaited<ReturnType<typeof registry.run>>;
  try {
    result = await registry.run({ name: input.toolName, arguments: input.arguments }, {
      cwd: policyEnvelope.workspaceRoot,
      signal: controller.signal,
      // M39: the governed identities this call already has. Core sets them —
      // a caller can never fabricate or widen them.
      correlationId: input.correlationId,
      attemptId,
      approvalId,
      invocationId: started.id,
      // Read out of the FROZEN approval by the caller below, never from the
      // dispatch input — this is what makes stale-proposal protection survive
      // a restart and a re-dispatch of an already-approved action.
      expectedBaseline,
      gmailDraftExpectedDigest,
      commandPolicy: policyEnvelope,
      securityGrant,
    });
  } finally {
    if (activeExecutions.get(attemptId) === controller) activeExecutions.delete(attemptId);
  }

  // Late completion after cancellation is ignored: if the attempt was asked
  // to cancel while this call was in flight, the terminal write is fenced to
  // 'cancelled' regardless of what the adapter itself returned.
  const attemptAfter = getAttempt(db, attemptId);
  const cancelled = Boolean(attemptAfter.cancelRequestedAt);
  return completeToolInvocation(db, started.id, {
    status: cancelled ? 'cancelled' : result.status === 'succeeded' ? 'succeeded' : 'failed',
    exitCode: cancelled ? null : result.exitCode,
    evidence: cancelled
      ? { cancelled: true }
      : { output: result.output, resultCategory: result.resultCategory ?? null, normalizedArguments: result.normalizedArguments ?? evidenceArguments },
    actor: input.actor,
    clientId: input.clientId,
  });
}

/** Aborts any in-flight adapter call for this attempt and marks cancellation
 * requested (idempotent — a second call is a no-op once already cancelling
 * or terminal), reusing `core/domain/attempts.ts`'s existing cancellation
 * primitive rather than a new one. */
export function cancelCapabilityAction(db: CoreDatabase, attemptId: string, input: { actor: string; clientId: string }): AttemptRecord {
  activeExecutions.get(attemptId)?.abort();
  return requestCancelAttempt(db, attemptId, input);
}

/** True while a capability adapter call is running in this Core process. */
export function hasInFlightCapabilityExecutions(): boolean {
  return activeExecutions.size > 0;
}

/**
 * Dispatches one governed capability call. Read-only calls execute
 * immediately. Consequential calls execute only once a matching 'mutation'
 * approval on the anchor attempt is already 'approved'; otherwise a pending
 * approval is created (or the existing pending/denied one is returned) and
 * nothing executes. A capability already known unhealthy is never dispatched
 * to and never even gets an approval prompt.
 */
export async function dispatchCapability(db: CoreDatabase, registry: GovernedCapabilityRegistry, input: DispatchCapabilityInput): Promise<DispatchCapabilityResult> {
  const kernel = LocalAutonomySecurityKernel.getInstance(db);
  if (kernel.isSafeModeActive()) {
    return { outcome: 'denied', attemptId: input.correlationId, reason: 'Security violation: SAFE_MODE / EXECUTION_DISABLED is currently active.' };
  }
  const attemptId = ensureCapabilityAttempt(db, input);
  const classification = registry.classify(input.toolName);
  if (!classification) return { outcome: 'unknown_tool', attemptId };

  const health = registry.healthSnapshot()[classification.capabilityId];
  if (health && health.state !== 'available' && health.state !== 'degraded') {
    return { outcome: 'unavailable', attemptId, reason: `capability '${classification.capabilityId}' is ${health.state}${health.reason ? `: ${health.reason}` : ''}` };
  }

  // A restored card re-dispatches the projected summary arguments. Rebind to
  // the canonical full arguments the matching approval is digest-bound to, so
  // policy, mission authorization and execution never see summary text.
  if (hasProjectedBulkValue(input.toolName, input.arguments)) {
    const projectedSummary = {
      toolName: input.toolName,
      arguments: input.arguments,
      ...(input.scopeIdentity ? { scopeIdentity: input.scopeIdentity } : {}),
    };
    const bound = findMatchingApproval(db, attemptId, projectedSummary);
    if (!bound) {
      throw new CoreError('invalid_request', 'projected action arguments can only be dispatched for an existing approval of that exact action');
    }
    input = { ...input, arguments: getApprovalActionArguments(db, bound.id) };
  }

  // The owning adapter may verify a fact about this call and freeze it into
  // the arguments BEFORE the approval digest is computed (for example the
  // creation time of the process a termination would kill). The approval then
  // binds that fact, and execution can re-verify it.
  const preparedArguments = await registry.prepare(input.toolName, input.arguments);
  if (preparedArguments && preparedArguments !== input.arguments) {
    input = { ...input, arguments: preparedArguments };
  }

  const envelope = resolveDispatchEnvelope(db, input, attemptId);
  const policy = evaluateInputPolicy(input, envelope);
  const redacted = registry.redactArguments(input.toolName, input.arguments);
  const { projected, projectedAny } = projectApprovalArguments(input.toolName, redacted);
  // Present only when something was projected, so a small-argument summary is
  // byte-identical to its pre-M45 shape.
  const actionArguments = projectedAny ? redacted : undefined;
  const summary = {
    toolName: input.toolName,
    arguments: projected,
    ...(projectedAny ? { argumentsDigest: canonicalArgumentsDigest(redacted) } : {}),
    ...(input.scopeIdentity ? { scopeIdentity: input.scopeIdentity } : {}),
    ...(input.proposal ? { expectedBaseline: input.proposal.expectedBaseline } : {}),
    ...(input.gmailDraftProposal ? { gmailDraftExpectedDigest: input.gmailDraftProposal.expectedDigest } : {}),
    ...policySummaryFields(envelope, policy, policy.decision === 'deny' ? 'denied' : 'review_required'),
  };
  let existing = findMatchingApproval(db, attemptId, summary);
  // A failed invocation consumes its approval: it authorized one execution
  // and that execution is over. An identical retry is a new attempt and
  // needs a fresh governed approval/invocation rather than replaying the
  // failure. Succeeded, in-flight (pending) and cancelled stay exactly-once.
  if (existing?.status === 'approved') {
    const consumed = findMatchingInvocation(listToolInvocationsForAttempt(db, attemptId), existing);
    if (consumed?.status === 'failed') existing = undefined;
  }

  if (policy.decision === 'deny') {
    if (existing?.status === 'pending') {
      forceRejectForbiddenApproval(db, existing, input, policy);
    } else if (!existing) {
      recordPolicyDenial(db, input, attemptId, summary, envelope, policy, actionArguments);
    }
    return { outcome: 'denied', attemptId, reason: policy.reason };
  }

  // Machine control is authorized separately from the workspace policy: an
  // unattended task may not terminate a process or stop a service, because
  // no person could answer the approval card.
  const machineControl = machineControlDecision(db, input, attemptId);
  if (machineControl) {
    if (existing?.status === 'pending') {
      forceRejectForbiddenApproval(db, existing, input, machineControl);
    } else if (!existing) {
      recordPolicyDenial(db, input, attemptId, summary, envelope, machineControl, actionArguments);
    }
    return { outcome: 'denied', attemptId, reason: machineControl.reason };
  }

  const missionAttemptId = input.scopeIdentity ?? '';
  if (missionAttemptId && input.toolName !== AUTHORIZE_MISSION_TOOL && classification.risk !== 'read_only') {
    const mission = evaluateAuthorizedDispatch(db, {
      attemptId: missionAttemptId,
      toolName: input.toolName,
      arguments: input.arguments,
    });
    if (mission.decision === 'deny') {
      if (existing?.status === 'pending') {
        forceRejectForbiddenApproval(db, existing, input, { ...policy, reason: mission.reason, decision: 'deny' });
      } else if (!existing) {
        recordPolicyDenial(db, input, attemptId, {
          ...summary,
          policyDecision: 'denied',
          policyReason: mission.reason,
        }, envelope, { ...policy, reason: mission.reason, decision: 'deny' }, actionArguments);
      }
      return { outcome: 'denied', attemptId, reason: mission.reason };
    }
    if (mission.decision === 'auto_authorize' && mission.authorization) {
      if (existing?.status === 'approved') {
        const priorInvocation = findMatchingInvocation(listToolInvocationsForAttempt(db, attemptId), existing);
        if (priorInvocation && priorInvocation.status !== 'pending') {
          return { outcome: 'executed', attemptId, toolInvocation: priorInvocation };
        }
      }
      const approval = existing?.status === 'approved'
        ? existing
        : createApproval(db, {
          attemptId,
          kind: 'mutation',
          summary: {
            ...summary,
            policyDecision: 'auto_authorize',
            policyReason: mission.reason,
            missionAuthorizationId: mission.authorization.id,
            envelopeDigest: mission.authorization.digest,
          },
          ...(actionArguments ? { actionArguments } : {}),
          presentation: input.proposal
            ? { ...input.proposal.presentation }
            : input.gmailDraftProposal
              ? { ...input.gmailDraftProposal.presentation }
              : input.connectorPresentation
                ? { ...input.connectorPresentation }
                : undefined,
          actor: CORE_POLICY_ACTOR,
          clientId: input.clientId,
          initialResolution: 'approved',
          resolvedBy: CORE_POLICY_ACTOR,
        });
      const invocation = await executeAndRecord(
        db, registry, attemptId, input, undefined, approval.id,
        input.proposal?.expectedBaseline, envelope,
        input.gmailDraftProposal?.expectedDigest,
      );
      recordAuthorizedAction(db, {
        authorizationId: mission.authorization.id,
        attemptId: missionAttemptId,
        action: input.toolName,
        normalizedPath: mission.normalizedPath,
        envelopeDigest: mission.authorization.digest,
        contentDigest: mission.contentDigest,
        contentBytes: mission.contentBytes,
        policyDecision: 'auto_authorize',
        policyReason: mission.reason,
        evidence: { approvalId: approval.id, invocationId: invocation.id, status: invocation.status },
      });
      return { outcome: 'executed', attemptId, toolInvocation: invocation };
    }
  }

  if (existing?.status === 'rejected') {
    const prior = existing.summary as Record<string, unknown>;
    if (prior.policyDecision === 'denied' && typeof prior.policyReason === 'string' && prior.policyReason.trim()) {
      return { outcome: 'denied', attemptId, reason: prior.policyReason };
    }
    return { outcome: 'denied', attemptId, reason: 'this exact action was already denied and will not be retried' };
  }

  if (classification.risk === 'read_only') {
    return { outcome: 'executed', attemptId, toolInvocation: await executeAndRecord(db, registry, attemptId, input, undefined, undefined, undefined, envelope) };
  }

  if (existing?.status === 'approved') {
    const frozen = envelopeFromApprovalSummary(existing.summary as Record<string, unknown>, envelope.workspaceRoot);
    const frozenPolicy = evaluateInputPolicy(input, frozen);
    if (frozenPolicy.decision === 'deny') {
      return { outcome: 'denied', attemptId, reason: frozenPolicy.reason };
    }
    const priorInvocation = findMatchingInvocation(listToolInvocationsForAttempt(db, attemptId), existing);
    if (priorInvocation?.status !== undefined && priorInvocation.status !== 'pending') {
      return { outcome: 'executed', attemptId, toolInvocation: priorInvocation };
    }
    if (priorInvocation && activeExecutions.has(attemptId)) {
      throw new CoreError('conflict', `capability action for approval '${existing.id}' is already executing`);
    }
    const frozenSummary = existing.summary as Record<string, unknown>;
    return {
      outcome: 'executed',
      attemptId,
      toolInvocation: await executeAndRecord(
        db, registry, attemptId, input, priorInvocation, existing.id,
        parseBaselineIdentity(frozenSummary.expectedBaseline),
        frozen,
        typeof frozenSummary.gmailDraftExpectedDigest === 'string' ? frozenSummary.gmailDraftExpectedDigest : undefined,
      ),
    };
  }
  if (existing?.status === 'pending') {
    return { outcome: 'approval_required', attemptId, approval: existing };
  }

  const attempt = getAttempt(db, attemptId);
  if (attempt.status === 'running') {
    transitionAttempt(db, attemptId, { toStatus: 'waiting_for_approval', actor: input.actor, clientId: input.clientId });
  }
  const approval = createApproval(db, {
    attemptId,
    kind: 'mutation',
    summary,
    ...(actionArguments ? { actionArguments } : {}),
    presentation: input.proposal
      ? { ...input.proposal.presentation }
      : input.gmailDraftProposal
        ? { ...input.gmailDraftProposal.presentation }
        : input.connectorPresentation
          ? { ...input.connectorPresentation }
          : undefined,
    actor: input.actor,
    clientId: input.clientId,
  });
  return { outcome: 'approval_required', attemptId, approval };
}

export interface ResolveCapabilityApprovalInput {
  approvalId: string;
  resolution: 'approved' | 'rejected';
  attemptId: string;
  expectedAttemptRevision: number;
  expectedAttemptStatus: ApprovalRecord['expectedAttemptStatus'];
  requestedActionDigest: string;
  frozenContextHash: string;
  actor: string;
  clientId: string;
  idempotencyKey: string;
}

/** The only way a human decision reaches Core: the caller relays exactly the
 * envelope fields from the approval record it was given — it never fabricates
 * or widens them. Resolution reuses `core/domain/approvals.ts` unchanged. */
export function resolveCapabilityApproval(db: CoreDatabase, input: ResolveCapabilityApprovalInput): ApprovalRecord {
  const existing = getApproval(db, input.approvalId);
  const summary = existing.summary as Record<string, unknown>;
  const toolName = String(summary.toolName ?? '');
  // Policy and mission authorization judge the canonical full arguments the
  // approval is digest-bound to, never the projected summary text.
  const actionArguments = getApprovalActionArguments(db, existing.id);
  const envelope = envelopeFromApprovalSummary(summary, String(summary.workspaceRoot ?? ''));
  const policy = evaluateGovernedAction({
    toolName,
    arguments: actionArguments,
    envelope: envelope.workspaceRoot ? envelope : defaultCommandPolicyEnvelope(String(summary.workspaceRoot ?? '')),
  });
  const missionAttemptId = String(summary.scopeIdentity ?? actionArguments.attemptId ?? '');
  if (input.resolution === 'approved' && missionAttemptId && toolName !== AUTHORIZE_MISSION_TOOL) {
    const mission = evaluateAuthorizedDispatch(db, {
      attemptId: missionAttemptId,
      toolName,
      arguments: actionArguments,
    });
    if (mission.decision === 'deny') {
      forceRejectForbiddenApproval(db, existing, { actor: input.actor, clientId: input.clientId }, {
        ...policy,
        decision: 'deny',
        reason: mission.reason,
      });
      throw new CoreError('invalid_request', `Core denied this action: ${mission.reason}`, {
        policyDecision: 'denied',
        policyReason: mission.reason,
        actor: CORE_POLICY_ACTOR,
        requestedActor: input.actor,
      });
    }
  }
  if (input.resolution === 'approved' && policy.decision === 'deny') {
    forceRejectForbiddenApproval(db, existing, { actor: input.actor, clientId: input.clientId }, policy);
    throw new CoreError('invalid_request', `Core denied this action: ${policy.reason}`, {
      policyDecision: 'denied',
      policyReason: policy.reason,
      actor: CORE_POLICY_ACTOR,
      requestedActor: input.actor,
    });
  }
  const approval = resolveApprovalRecord(db, input.approvalId, {
    resolution: input.resolution,
    attemptId: input.attemptId,
    gate: 'mutation',
    expectedAttemptRevision: input.expectedAttemptRevision,
    expectedAttemptStatus: input.expectedAttemptStatus,
    requestedActionDigest: input.requestedActionDigest,
    frozenContextHash: input.frozenContextHash,
    actor: input.actor,
    clientId: input.clientId,
    idempotencyKey: input.idempotencyKey,
    requestedActor: input.actor,
    policyDecision: input.resolution === 'approved' ? 'approved' : 'denied',
    policyReason: String(summary.policyReason ?? (input.resolution === 'approved' ? 'caller approved a Core-reviewed action' : 'caller rejected the action')),
  });
  const attempt = getAttempt(db, input.attemptId);
  if (attempt.status === 'waiting_for_approval') {
    transitionAttempt(db, input.attemptId, {
      toStatus: 'running',
      actor: input.actor,
      clientId: input.clientId,
      fenceToken: attempt.fenceToken ?? undefined,
    });
  }
  if (toolName === AUTHORIZE_MISSION_TOOL && missionAttemptId) {
    if (input.resolution === 'approved') {
      markMissionAuthorized(db, missionAttemptId, input.actor);
    } else {
      markMissionRejected(db, missionAttemptId, input.actor);
    }
  }
  return approval;
}
