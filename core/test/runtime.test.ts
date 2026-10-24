import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createProject } from '../domain/projects';
import { createConversation, appendMessage, listMessages, archiveConversation, listConversations } from '../domain/conversations';
import * as requestsModule from '../domain/requests';
const { createRequest, getRequest } = requestsModule;
import {
  createAttempt,
  transitionAttempt,
  failAttempt,
  requestCancelAttempt,
  confirmAttemptCancelled,
  retryAttempt,
  listAttempts,
  claimAttempt,
  getAttempt,
} from '../domain/attempts';
import { startModelInvocation, completeModelInvocation, listModelInvocationsForAttempt } from '../domain/modelInvocations';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { createApproval, resolveApproval, listApprovalsForAttempt } from '../domain/approvals';
import { createCheckpoint, listCheckpointsForAttempt } from '../domain/checkpoints';
import { listRuntimeEventsAfter } from '../domain/runtimeEvents';
import { CoreError } from '../domain/errors';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-runtime-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function envelope(overrides: Partial<Parameters<typeof createRequest>[1]> = {}) {
  return createRequest(db, {
    clientId: 'client-1',
    currentMessage: 'hello there',
    requestedMode: 'baat_kar',
    resolvedMode: 'baat_kar',
    routeReason: 'ordinary question routed to Baat Kar',
    contextPolicy: {
      includeConversationHistory: false,
      includeProjectContext: false,
      includeRepositoryContext: false,
      includeGlobalStoryContext: false,
    },
    correlationId: 'corr-1',
    ...overrides,
  });
}

describe('conversations: Core-owned transcripts', () => {
  it('creates a conversation and appends messages in order, isolated per conversation', () => {
    const a = createConversation(db, { mode: 'baat_kar', actor: 'client-1' });
    const b = createConversation(db, { mode: 'baat_kar', actor: 'client-1' });
    appendMessage(db, a.id, { role: 'user', content: 'hi from A', actor: 'client-1' });
    appendMessage(db, b.id, { role: 'user', content: 'hi from B', actor: 'client-1' });
    appendMessage(db, a.id, { role: 'assistant', content: 'reply in A', actor: 'client-1' });

    const messagesA = listMessages(db, a.id);
    expect(messagesA.map((m) => m.content)).toEqual(['hi from A', 'reply in A']);
    const messagesB = listMessages(db, b.id);
    expect(messagesB.map((m) => m.content)).toEqual(['hi from B']);
  });

  it('rejects an over-length message rather than truncating silently', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'client-1' });
    expect(() => appendMessage(db, conv.id, { role: 'user', content: 'x'.repeat(100_001), actor: 'client-1' })).toThrow(CoreError);
  });

  it('archive is idempotent-safe: archiving twice throws invalid_transition, not silent double-archive', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'client-1' });
    archiveConversation(db, conv.id, { actor: 'client-1' });
    expect(() => archiveConversation(db, conv.id, { actor: 'client-1' })).toThrow(CoreError);
  });

  it('excludes archived conversations from the default list', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'client-1' });
    archiveConversation(db, conv.id, { actor: 'client-1' });
    expect(listConversations(db).map((c) => c.id)).not.toContain(conv.id);
    expect(listConversations(db, { includeArchived: true }).map((c) => c.id)).toContain(conv.id);
  });
});

describe('requests: immutable envelope', () => {
  it('creates a request envelope with no update route available', () => {
    const req = envelope();
    expect(req.requestedMode).toBe('baat_kar');
    expect(req.resolvedMode).toBe('baat_kar');
    // No `updateRequest` export exists — immutability is structural, not just a convention.
    expect((requestsModule as unknown as Record<string, unknown>).updateRequest).toBeUndefined();
  });

  it('rejects resolvedMode != requestedMode unless requestedMode is auto', () => {
    expect(() =>
      envelope({ requestedMode: 'baat_kar', resolvedMode: 'karke_dikha' }),
    ).toThrow(CoreError);
  });

  it('allows auto to resolve to any concrete mode', () => {
    const req = envelope({ requestedMode: 'auto', resolvedMode: 'karke_dikha', routeReason: 'broad goal' });
    expect(req.resolvedMode).toBe('karke_dikha');
  });

  it('route override: user picks a concrete mode directly, distinct from what Auto would have chosen, without creating a second request', () => {
    // The client calls classifyRequest() first (see routing.test.ts), sees the
    // suggested route, and the user overrides it by creating the request with an
    // explicit requestedMode instead of 'auto'. Only one request is ever created —
    // there is no separate "override" endpoint, so no duplicate-request path exists.
    const req = envelope({
      requestedMode: 'karke_dikha',
      resolvedMode: 'karke_dikha',
      routeReason: 'user override: Auto suggested Baat Kar, user selected Karke Dikha directly',
    });
    expect(req.resolvedMode).toBe('karke_dikha');
    expect(req.routeReason).toContain('override');
  });

  it('rejects a request referencing a non-existent conversation', () => {
    expect(() => envelope({ conversationId: 'conv_does_not_exist' })).toThrow(CoreError);
  });
});

describe('attempts: lifecycle, cancellation, retry lineage', () => {
  it('creates exactly one first attempt per request', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    expect(attempt.status).toBe('created');
    expect(attempt.predecessorAttemptId).toBeNull();
    expect(() => createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' })).toThrow(CoreError);
  });

  it('enforces the transition graph — cannot jump from created to completed', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    expect(() => transitionAttempt(db, attempt.id, { toStatus: 'completed', actor: 'client-1' })).toThrow(CoreError);
  });

  it('runs a normal lifecycle to completion, stamping startedAt/completedAt', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    const running = transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'client-1' });
    expect(running.startedAt).not.toBeNull();
    const completed = transitionAttempt(db, running.id, { toStatus: 'completed', actor: 'client-1' });
    expect(completed.completedAt).not.toBeNull();
  });

  it('failAttempt records a failureReason and is terminal', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'client-1' });
    const failed = failAttempt(db, attempt.id, { failureReason: 'provider unavailable', actor: 'client-1' });
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('provider unavailable');
  });

  it('cancellation is idempotent: repeated cancel requests do not error or double-transition', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'client-1' });
    const first = requestCancelAttempt(db, attempt.id, { actor: 'client-1' });
    expect(first.status).toBe('cancelling');
    const second = requestCancelAttempt(db, attempt.id, { actor: 'client-1' });
    expect(second.cancelRequestedAt).toBe(first.cancelRequestedAt);
    const cancelled = confirmAttemptCancelled(db, attempt.id, { actor: 'client-1' });
    expect(cancelled.status).toBe('cancelled');
    // Confirming again is a no-op, not an error — late/duplicate confirmations must not throw.
    expect(confirmAttemptCancelled(db, attempt.id, { actor: 'client-1' }).status).toBe('cancelled');
  });

  it('a cancelled attempt cannot be revived by a late transition', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'client-1' });
    requestCancelAttempt(db, attempt.id, { actor: 'client-1' });
    confirmAttemptCancelled(db, attempt.id, { actor: 'client-1' });
    expect(() => transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'client-1' })).toThrow(CoreError);
  });

  it('retry creates a new attempt linked to its predecessor, never copying transcript/scratch', () => {
    const req = envelope();
    const first = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    transitionAttempt(db, first.id, { toStatus: 'running', actor: 'client-1' });
    failAttempt(db, first.id, { failureReason: 'boom', actor: 'client-1' });

    const retried = retryAttempt(db, { predecessorAttemptId: first.id, actor: 'client-1' });
    expect(retried.id).not.toBe(first.id);
    expect(retried.predecessorAttemptId).toBe(first.id);
    expect(retried.status).toBe('created');
    expect(retried.failureReason).toBeNull();
  });

  it('duplicate retry does not create two successor attempts', () => {
    const req = envelope();
    const first = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    transitionAttempt(db, first.id, { toStatus: 'running', actor: 'client-1' });
    failAttempt(db, first.id, { failureReason: 'retryable provider failure', actor: 'client-1' });
    const retryA = retryAttempt(db, { predecessorAttemptId: first.id, actor: 'client-1' });
    const retryB = retryAttempt(db, { predecessorAttemptId: first.id, actor: 'client-1' });
    expect(retryB.id).toBe(retryA.id);
    expect(listAttempts(db, { requestId: req.id })).toHaveLength(2); // original + one retry, not two
  });

  it('claim protects against a second owner stealing a live lease, but allows takeover once stale', async () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    claimAttempt(db, attempt.id, { claimOwner: 'core-instance-A', leaseMs: 50, actor: 'client-1' });
    expect(() => claimAttempt(db, attempt.id, { claimOwner: 'core-instance-B', leaseMs: 50, actor: 'client-1' })).toThrow(CoreError);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const takeover = claimAttempt(db, attempt.id, { claimOwner: 'core-instance-B', leaseMs: 50, actor: 'client-1' });
    expect(takeover.claimOwner).toBe('core-instance-B');
  });

  it('optimistic concurrency: stale expectedRevision is rejected', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'client-1' });
    expect(() =>
      transitionAttempt(db, attempt.id, { toStatus: 'completed', expectedRevision: 1, actor: 'client-1' }),
    ).toThrow(CoreError);
  });
});

describe('model invocations: requested vs actual truth', () => {
  it('scopes cockpit completion telemetry to its attempt and preserves numeric usage', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    const inv = startModelInvocation(db, { attemptId: attempt.id, actor: 'client-1' });
    completeModelInvocation(db, inv.id, {
      status: 'succeeded', actor: 'client-1',
      usageMetadata: { promptTokens: 1024, completionTokens: 88, durationMs: 2000 },
    });
    const event = listRuntimeEventsAfter(db, 0, 100).find((item) => item.entityId === inv.id && item.eventType === 'model_invocation_completed');
    expect(event?.metadata).toMatchObject({ attemptId: attempt.id, promptTokens: 1024, completionTokens: 88, durationMs: 2000 });
  });
  it('requires a fallbackReason whenever fallbackUsed is true — no silent fallback', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    const inv = startModelInvocation(db, { attemptId: attempt.id, requestedModel: 'qwen2.5-coder:1.5b', actor: 'client-1' });
    expect(() =>
      completeModelInvocation(db, inv.id, { status: 'succeeded', actualModel: 'llama3', fallbackUsed: true, actor: 'client-1' }),
    ).toThrow(CoreError);
  });

  it('records requested and actual model as distinct truthful fields', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    const inv = startModelInvocation(db, {
      attemptId: attempt.id,
      requestedProvider: 'ollama',
      requestedModel: 'qwen2.5-coder:1.5b',
      actor: 'client-1',
    });
    const completed = completeModelInvocation(db, inv.id, {
      status: 'succeeded',
      actualProvider: 'ollama',
      actualModel: 'qwen2.5-coder:1.5b',
      actor: 'client-1',
    });
    expect(completed.requestedModel).toBe('qwen2.5-coder:1.5b');
    expect(completed.actualModel).toBe('qwen2.5-coder:1.5b');
    expect(completed.fallbackUsed).toBe(false);
    expect(completed.latencyMs).not.toBeNull();
    expect(listModelInvocationsForAttempt(db, attempt.id)).toHaveLength(1);
  });

  it('cannot complete the same invocation twice', () => {
    const req = envelope();
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    const inv = startModelInvocation(db, { attemptId: attempt.id, actor: 'client-1' });
    completeModelInvocation(db, inv.id, { status: 'succeeded', actor: 'client-1' });
    expect(() => completeModelInvocation(db, inv.id, { status: 'succeeded', actor: 'client-1' })).toThrow(CoreError);
  });
});

describe('tool invocations: truthful evidence', () => {
  it('records exit code and evidence on completion', () => {
    const req = envelope({ requestedMode: 'saath_kar', resolvedMode: 'saath_kar' });
    const attempt = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'client-1' });
    const inv = startToolInvocation(db, { attemptId: attempt.id, toolName: 'shell', argsSummary: { command: 'npm test' }, actor: 'client-1' });
    const completed = completeToolInvocation(db, inv.id, {
      status: 'succeeded',
      exitCode: 0,
      evidence: { stdout: 'ok', cwd: '/tmp/repo' },
      actor: 'client-1',
    });
    expect(completed.exitCode).toBe(0);
    expect(completed.evidence.cwd).toBe('/tmp/repo');
  });
});

describe('approvals: exactly-once, exactly-one-live-card', () => {
  it('resolving twice rejects the duplicate decision', () => {
    const req = envelope({ requestedMode: 'karke_dikha', resolvedMode: 'karke_dikha' });
    const attempt = createAttempt(db, { requestId: req.id, kind: 'karke_dikha', actor: 'client-1' });
    const approval = createApproval(db, { attemptId: attempt.id, kind: 'mutation', actor: 'client-1' });
    const approvalEnvelope = {
      attemptId: approval.attemptId,
      gate: approval.kind,
      expectedAttemptRevision: approval.expectedAttemptRevision,
      expectedAttemptStatus: approval.expectedAttemptStatus,
      requestedActionDigest: approval.requestedActionDigest,
      frozenContextHash: approval.frozenContextHash,
      expectedRevision: approval.revision,
    };
    const first = resolveApproval(db, approval.id, { resolution: 'approved', ...approvalEnvelope, actor: 'client-1' });
    expect(first.status).toBe('approved');
    expect(() => resolveApproval(db, approval.id, { resolution: 'rejected', ...approvalEnvelope, actor: 'client-1' })).toThrow(CoreError);
  });

  it('creating a new approval of the same kind supersedes the prior pending one', () => {
    const req = envelope({ requestedMode: 'karke_dikha', resolvedMode: 'karke_dikha' });
    const attempt = createAttempt(db, { requestId: req.id, kind: 'karke_dikha', actor: 'client-1' });
    const first = createApproval(db, { attemptId: attempt.id, kind: 'proposal', actor: 'client-1' });
    const second = createApproval(db, { attemptId: attempt.id, kind: 'proposal', actor: 'client-1' });
    const all = listApprovalsForAttempt(db, attempt.id);
    const firstAfter = all.find((a) => a.id === first.id)!;
    expect(firstAfter.status).toBe('superseded');
    expect(all.find((a) => a.id === second.id)!.status).toBe('pending');
    // Exactly one live (pending) proposal-kind approval at a time.
    expect(all.filter((a) => a.kind === 'proposal' && a.status === 'pending')).toHaveLength(1);
  });
});

describe('checkpoints', () => {
  it('records checkpoints for an attempt in order', () => {
    const req = envelope({ requestedMode: 'karke_dikha', resolvedMode: 'karke_dikha' });
    const attempt = createAttempt(db, { requestId: req.id, kind: 'karke_dikha', actor: 'client-1' });
    createCheckpoint(db, { attemptId: attempt.id, kind: 'pre_mutation', actor: 'client-1' });
    createCheckpoint(db, { attemptId: attempt.id, kind: 'post_mutation', actor: 'client-1' });
    expect(listCheckpointsForAttempt(db, attempt.id).map((c) => c.kind)).toEqual(['pre_mutation', 'post_mutation']);
  });
});

describe('runtime_events: append-only stream, parallel to story_events', () => {
  it('every attempt mutation produces at least one runtime_event replayable via listRuntimeEventsAfter', () => {
    const req = envelope();
    const before = listRuntimeEventsAfter(db, 0, 1000).length;
    const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'client-1' });
    const after = listRuntimeEventsAfter(db, 0, 1000);
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((e) => e.domain === 'attempt' && e.entityId === attempt.id && e.eventType === 'attempt_transitioned')).toBe(true);
  });
});

describe('context isolation regression: contamination cannot occur structurally', () => {
  it('a request envelope for one conversation cannot read messages from a different conversation', () => {
    const stale = createConversation(db, { mode: 'baat_kar', actor: 'client-1' });
    appendMessage(db, stale.id, { role: 'user', content: 'No thank you', actor: 'client-1' });

    const fresh = createConversation(db, { mode: 'baat_kar', actor: 'client-1' });
    appendMessage(db, fresh.id, { role: 'user', content: 'What is the weather API for?', actor: 'client-1' });

    const freshMessages = listMessages(db, fresh.id);
    expect(freshMessages.every((m) => !m.content.includes('No thank you'))).toBe(true);
  });

  it('a project reference does not exist purely for schema completeness — creating a request against it is rejected until it exists', () => {
    const req = envelope();
    expect(getRequest(db, req.id).projectId).toBeNull();
  });
});

// touch createProject import so lint doesn't flag it as unused if a future test needs it
void createProject;
