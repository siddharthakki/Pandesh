import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchConnectorAction } from '../domain/connectorDispatch';
import { resolveCapabilityApproval, cancelCapabilityAction } from '../domain/capabilityDispatch';
import { getConnectorPermissions, setConnectorPermission, listConnectorStatuses } from '../domain/connectors';
import { listToolInvocationsForAttempt } from '../domain/toolInvocations';
import { listApprovalsForAttempt } from '../domain/approvals';
import { recordGmailDraftBinding } from '../domain/gmailDrafts';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { buildConnectorAdapters, CONNECTOR_CREDENTIAL_ENV } from '../runtime/connectors/connectorDefinitions';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';
import type { ApprovalRecord } from '../shared/wireTypes';

let dir: string;
let dbPath: string;
let db: CoreDatabase;
const SECRET = 'gmail-oauth-refresh-token-do-not-leak';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-foundation-'));
  dbPath = path.join(dir, 'core.db');
  db = openCoreDatabase(dbPath).db;
  delete process.env[CONNECTOR_CREDENTIAL_ENV.gmail];
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env[CONNECTOR_CREDENTIAL_ENV.gmail];
});

/** `gmail_send_draft` requires a durable draft binding (recorded by
 * `gmail_create_draft`'s real executor) before it will even create an
 * approval — see `connectorDispatch.ts`'s `dispatchGmailSendDraft`. These
 * tier-gating/redaction tests use a fake executor that never creates a real
 * binding, so they set one up directly to exercise the generic mechanism
 * with `gmail_send_draft` standing in for "a consequential connector tool". */
function bindTestDraft(draftId: string): void {
  recordGmailDraftBinding(db, {
    content: {
      accountEmail: 'me@example.com', draftId, threadId: null,
      to: ['x@example.com'], cc: [], bcc: [], subject: 'hi', bodyText: 'hi', bodyHtml: null,
    },
  });
}

function decisionFrom(approval: ApprovalRecord) {
  return {
    approvalId: approval.id,
    resolution: 'approved' as const,
    attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    actor: 'client-1',
    clientId: 'client-1',
    idempotencyKey: `approve:${approval.id}`,
  };
}

/** A "configured, connectable" Gmail adapter — the only place in this suite
 * where the credential env var is set and a fake probe/executor is supplied,
 * so the default (production) adapters elsewhere stay provably inert. */
async function buildTestRegistry(executorCalls: Array<Record<string, unknown>>): Promise<{ registry: GovernedCapabilityRegistry; connectors: Map<string, ConnectorAdapter> }> {
  process.env[CONNECTOR_CREDENTIAL_ENV.gmail] = SECRET;
  const connectors = buildConnectorAdapters({
    gmail: {
      probe: async () => ({ ok: true }),
      executor: async (toolName, args) => {
        executorCalls.push({ toolName, ...args });
        return { status: 'succeeded', exitCode: 0, output: 'sent', resultCategory: 'gmail_send_succeeded' };
      },
    },
  });
  // `health()` is deliberately cheap/cached and never itself triggers I/O
  // (matching every other GovernedCapabilityAdapter, e.g. githubCapability.ts)
  // — something must call `probeHealth()` to warm the cache before a real
  // integration would report `available`/`connected`. A future milestone
  // wires a periodic health-check loop; this test stands in for it.
  await connectors.get('gmail')!.probeHealth();
  const registry = new GovernedCapabilityRegistry();
  for (const adapter of connectors.values()) registry.register(adapter);
  return { registry, connectors: connectors as unknown as Map<string, ConnectorAdapter> };
}

describe('Jarvis Connector Foundation: permission separation (requirement #2)', () => {
  it('a read-only grant can read but cannot execute a consequential connector action', async () => {
    const { registry, connectors } = await buildTestRegistry([]);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'read', granted: true, actor: 'operator' });

    const readResult = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-1', toolName: 'gmail_search', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(readResult.outcome).toBe('executed');

    const sendResult = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-1', toolName: 'gmail_send_draft', arguments: { to: 'x@example.com', subject: 'hi', body: 'hi' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(sendResult.outcome).toBe('denied');
    if (sendResult.outcome === 'denied') expect(sendResult.reason).toMatch(/execute.*not.*permitted|permission/i);

    // No approval was ever created for the denied action — the gate runs
    // strictly before dispatchCapability, so there is nothing to approve.
    expect(listApprovalsForAttempt(db, sendResult.attemptId)).toHaveLength(0);
  });

  it('an execute grant does not implicitly grant draft, and vice versa', async () => {
    const { registry, connectors } = await buildTestRegistry([]);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });

    const draftResult = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-2', toolName: 'gmail_create_draft', arguments: { to: 'x@example.com', subject: 'hi', body: 'hi' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(draftResult.outcome).toBe('denied');

    const permissions = getConnectorPermissions(db, 'gmail');
    expect(permissions).toEqual({ read: false, draft: false, execute: true });
  });

  it('permission grants default to false — a connector with no grants at all cannot execute', async () => {
    const { registry, connectors } = await buildTestRegistry([]);
    const result = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-3', toolName: 'gmail_send_draft', arguments: { to: 'x@example.com', subject: 'hi', body: 'hi' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(result.outcome).toBe('denied');
  });
});

describe('Jarvis Connector Foundation: secrets never reach evidence (requirement #3)', () => {
  it('the credential value never appears in approval summaries, tool-invocation evidence, or connector status', async () => {
    const executorCalls: Array<Record<string, unknown>> = [];
    const { registry, connectors } = await buildTestRegistry(executorCalls);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });
    bindTestDraft('draft-1');

    const requested = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-secret', toolName: 'gmail_send_draft', arguments: { draftId: 'draft-1' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval));
    const executed = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-secret', toolName: 'gmail_send_draft', arguments: { draftId: 'draft-1' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(executed.outcome).toBe('executed');

    const approvals = listApprovalsForAttempt(db, requested.attemptId);
    const invocations = listToolInvocationsForAttempt(db, requested.attemptId);
    const statuses = listConnectorStatuses(db, connectors as any);

    const haystacks = [
      JSON.stringify(approvals),
      JSON.stringify(invocations),
      JSON.stringify(statuses),
      fs.readFileSync(dbPath).toString('latin1'), // raw SQLite file bytes
    ];
    for (const haystack of haystacks) expect(haystack).not.toContain(SECRET);
  });

  it('a connector adapter reports state from env-var *presence* only — never echoes the credential value', async () => {
    const { connectors } = await buildTestRegistry([]);
    const statuses = listConnectorStatuses(db, connectors as any);
    const gmail = statuses.find((s) => s.id === 'gmail');
    expect(gmail?.state).not.toBe('not_configured'); // credential is present in this test
    expect(JSON.stringify(gmail)).not.toContain(SECRET);
  });
});

describe('Jarvis Connector Foundation: staleness recheck on confirmation (requirement #4)', () => {
  it('editing a queued connector action after it was offered for confirmation forces re-confirmation', async () => {
    const commandQueue = await import('../domain/commandQueue');
    const enqueued = commandQueue.enqueueCommand(db, {
      instruction: 'Send email to alice@example.com: subject "Q3 numbers", body "See attached."',
      title: 'Send email to alice@example.com',
      source: 'text',
    });
    const offered = commandQueue.offerNextConfirmation(db, Date.now(), 60_000);
    expect(offered?.id).toBe(enqueued.id);
    expect(offered?.status).toBe('confirming');

    // The exact recipient/content changes before the human confirms.
    const edited = commandQueue.editCommand(db, enqueued.id, {
      instruction: 'Send email to bob@example.com: subject "Q3 numbers", body "See attached."',
    });
    expect(edited.status).toBe('waiting'); // confirmation cleared, not silently carried forward
    expect(edited.confirmationToken).toBeNull();

    // The stale token/revision from the first offer can no longer confirm.
    expect(() => commandQueue.confirmRun(db, enqueued.id, offered!.confirmationToken!, offered!.revision))
      .toThrow(/not awaiting confirmation|revision/i);

    // A fresh offer on the edited command must be confirmed again.
    const reOffered = commandQueue.offerNextConfirmation(db, Date.now(), 60_000);
    expect(reOffered?.instruction).toContain('bob@example.com');
    const confirmed = commandQueue.confirmRun(db, enqueued.id, reOffered!.confirmationToken!, reOffered!.revision);
    expect(confirmed.status).toBe('active');
  });
});

describe('Jarvis Connector Foundation: duplicate execution prevented after restart (requirement #5)', () => {
  it('re-dispatching the same approved connector action after a fresh db connection reuses the terminal invocation, never re-executing', async () => {
    const executorCalls: Array<Record<string, unknown>> = [];
    const { registry, connectors } = await buildTestRegistry(executorCalls);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });
    bindTestDraft('draft-1');

    const input = {
      correlationId: 'conv-restart', toolName: 'gmail_send_draft',
      arguments: { draftId: 'draft-1' },
      cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    };
    const requested = await dispatchConnectorAction(db, registry, connectors as any, input);
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval));
    db.close();

    // Simulate a Core process restart: reopen the same database file fresh,
    // and rebuild the registry (a new process would too).
    const restarted = openCoreDatabase(dbPath).db;
    try {
      const first = await dispatchConnectorAction(restarted, registry, connectors as any, input);
      const duplicate = await dispatchConnectorAction(restarted, registry, connectors as any, input);
      expect(first.outcome).toBe('executed');
      expect(duplicate.outcome).toBe('executed');
      if (first.outcome === 'executed' && duplicate.outcome === 'executed') {
        expect(duplicate.toolInvocation.id).toBe(first.toolInvocation.id);
      }
      expect(executorCalls).toHaveLength(1);
    } finally {
      restarted.close();
      db = openCoreDatabase(dbPath).db;
    }
  });
});

describe('Jarvis Connector Foundation: cancellation is honestly represented (requirement #5)', () => {
  it('a cancelled connector action is recorded as cancelled even if the adapter finishes afterward', async () => {
    let releaseAdapter!: () => void;
    const gate = new Promise<void>((resolve) => { releaseAdapter = resolve; });
    process.env[CONNECTOR_CREDENTIAL_ENV.gmail] = SECRET;
    const connectors = buildConnectorAdapters({
      gmail: {
        probe: async () => ({ ok: true }),
        executor: async () => {
          await gate;
          return { status: 'succeeded', exitCode: 0, output: 'sent late' };
        },
      },
    });
    await connectors.get('gmail')!.probeHealth();
    const registry = new GovernedCapabilityRegistry();
    for (const adapter of connectors.values()) registry.register(adapter);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });
    bindTestDraft('draft-1');

    const input = {
      correlationId: 'conv-cancel', toolName: 'gmail_send_draft',
      arguments: { draftId: 'draft-1' },
      cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    };
    const requested = await dispatchConnectorAction(db, registry, connectors as any, input);
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval));

    const executionPromise = dispatchConnectorAction(db, registry, connectors as any, input);
    await new Promise((r) => setTimeout(r, 10));
    cancelCapabilityAction(db, requested.attemptId, { actor: 'core', clientId: 'client-1' });
    releaseAdapter();

    const result = await executionPromise;
    expect(result.outcome).toBe('executed');
    if (result.outcome === 'executed') {
      expect(result.toolInvocation.status).toBe('cancelled');
      expect(result.toolInvocation.evidence).toEqual({ cancelled: true });
    }
  });
});

describe('Jarvis Connector Foundation: disconnected tools stay visibly unavailable (requirements #1, #7, #8)', () => {
  it('all four connectors report not_configured with zero credentials configured, and grant no permission by default', () => {
    const connectors = buildConnectorAdapters(); // production wiring: no probe/executor
    const statuses = listConnectorStatuses(db, connectors);
    expect(statuses).toHaveLength(4);
    for (const status of statuses) {
      expect(status.state).toBe('not_configured');
      expect(status.permissions).toEqual({ read: false, draft: false, execute: false });
    }
  });

  it('a configured-but-unprobed production connector (no live provider integration) reports unavailable, never connected', () => {
    process.env[CONNECTOR_CREDENTIAL_ENV.printer] = 'printer-credential-present';
    try {
      const connectors = buildConnectorAdapters(); // still no probe/executor override
      const statuses = listConnectorStatuses(db, connectors);
      const printer = statuses.find((s) => s.id === 'printer');
      expect(printer?.state).toBe('unavailable');
      expect(printer?.state).not.toBe('connected');
    } finally {
      delete process.env[CONNECTOR_CREDENTIAL_ENV.printer];
    }
  });

  it('the production registry can never execute a live connector action: health gates run() before it is ever reached', async () => {
    const connectors = buildConnectorAdapters();
    const registry = new GovernedCapabilityRegistry();
    for (const adapter of connectors.values()) registry.register(adapter);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });
    bindTestDraft('draft-1');

    const result = await dispatchConnectorAction(db, registry, connectors, {
      correlationId: 'conv-no-live-action', toolName: 'gmail_send_draft',
      arguments: { draftId: 'draft-1' },
      cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    // Permission is granted, yet nothing executes: the connector itself is
    // unhealthy (no credential, no probe), so dispatchCapability's own
    // health gate refuses before any adapter code runs.
    expect(result.outcome).toBe('unavailable');
  });
});

describe('Jarvis Connector Foundation: gmail_send_draft draft-bound send safety', () => {
  it('refuses (denied, no approval ever created) when no draft binding exists for the given draftId', async () => {
    const { registry, connectors } = await buildTestRegistry([]);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });

    const result = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-unbound', toolName: 'gmail_send_draft', arguments: { draftId: 'never-created' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(result.outcome).toBe('denied');
    if (result.outcome === 'denied') expect(result.reason).toMatch(/no approved draft/i);
    expect(listApprovalsForAttempt(db, result.attemptId)).toHaveLength(0);
  });

  it('refuses when draftId is missing entirely, before ever touching the database for a binding', async () => {
    const { registry, connectors } = await buildTestRegistry([]);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });

    const result = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-no-draft-id', toolName: 'gmail_send_draft', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(result.outcome).toBe('denied');
  });

  it('freezes the approved digest and a human-readable presentation into the approval, from the stored binding', async () => {
    const { registry, connectors } = await buildTestRegistry([]);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });
    bindTestDraft('draft-2');

    const result = await dispatchConnectorAction(db, registry, connectors as any, {
      correlationId: 'conv-presentation', toolName: 'gmail_send_draft', arguments: { draftId: 'draft-2' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (result.outcome !== 'approval_required') throw new Error('expected approval_required');
    const summary = result.approval.summary as Record<string, unknown>;
    expect(typeof summary.gmailDraftExpectedDigest).toBe('string');
    expect(result.approval.presentation).toMatchObject({ kind: 'gmail_send_draft', to: ['x@example.com'], subject: 'hi' });
  });

  it('a retried dispatch of an already-approved-and-executed send reuses the terminal result, never re-sends or gets denied', async () => {
    const executorCalls: Array<Record<string, unknown>> = [];
    const { registry, connectors } = await buildTestRegistry(executorCalls);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'execute', granted: true, actor: 'operator' });
    bindTestDraft('draft-3');

    const input = {
      correlationId: 'conv-retry', toolName: 'gmail_send_draft', arguments: { draftId: 'draft-3' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    };
    const requested = await dispatchConnectorAction(db, registry, connectors as any, input);
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval));
    const executed = await dispatchConnectorAction(db, registry, connectors as any, input);
    expect(executed.outcome).toBe('executed');

    // Simulate a retried dispatch (e.g. a UI double-click or a restart
    // reconciliation) of the identical send request.
    const retried = await dispatchConnectorAction(db, registry, connectors as any, input);
    expect(retried.outcome).toBe('executed');
    if (retried.outcome === 'executed' && executed.outcome === 'executed') {
      expect(retried.toolInvocation.id).toBe(executed.toolInvocation.id);
    }
    expect(executorCalls.filter((c) => c.toolName === 'gmail_send_draft')).toHaveLength(1);
  });
});
