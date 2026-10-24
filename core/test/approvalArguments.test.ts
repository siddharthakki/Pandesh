import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import {
  APPROVAL_INLINE_ARGUMENT_MAX_BYTES,
  canonicalArgumentsDigest,
  isProjectedBulkValue,
  projectApprovalArguments,
} from '../domain/approvalArguments';
import { createApproval, getApproval, getApprovalActionArguments, listApprovalsForAttempt } from '../domain/approvals';
import {
  dispatchCapability,
  ensureCapabilityAttempt,
  listCapabilityActions,
  resolveCapabilityApproval,
} from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry, type GovernedCapabilityAdapter } from '../runtime/governedCapability';
import type { ToolExecutionResult } from '../runtime/toolRunner';
import type { ApprovalRecord } from '../shared/wireTypes';
import {
  buildMissionEnvelope,
  markMissionAuthorized,
  requestMissionAuthorization,
} from '../runtime/missionAuthorization';

let dir: string;
let db: CoreDatabase;
let executed: Array<{ name: string; arguments: Record<string, unknown> }>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm45-approval-arguments-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  executed = [];
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A workspace-shaped adapter that records exactly what it was asked to run. */
function recordingRegistry(): GovernedCapabilityRegistry {
  const adapter: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => ['propose_file_change', 'propose_text_edit'].map((name) => ({ name, description: name, parameters: {} })),
    classify: () => 'consequential',
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async (call): Promise<ToolExecutionResult> => {
      executed.push({ name: call.name, arguments: call.arguments });
      return { status: 'succeeded', exitCode: 0, output: 'ok' };
    },
  };
  return new GovernedCapabilityRegistry().register(adapter);
}

function decisionFrom(approval: ApprovalRecord, resolution: 'approved' | 'rejected') {
  return {
    approvalId: approval.id,
    resolution,
    attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    actor: 'client-1',
    clientId: 'client-1',
    idempotencyKey: `idem-${approval.id}`,
  };
}

const base = { cwd: process.cwd(), actor: 'core', clientId: 'client-1' };
const summaryBytes = (approval: ApprovalRecord) => Buffer.byteLength(JSON.stringify(approval.summary), 'utf8');

describe('projectApprovalArguments', () => {
  it('projects an oversized bulk field to bytes + sha256 and leaves everything else', () => {
    const content = 'a'.repeat(APPROVAL_INLINE_ARGUMENT_MAX_BYTES + 1);
    const { projected, projectedAny } = projectApprovalArguments('propose_file_change', { path: 'src/a.ts', content });
    expect(projectedAny).toBe(true);
    expect(projected.path).toBe('src/a.ts');
    expect(isProjectedBulkValue(projected.content)).toBe(true);
    expect((projected.content as { $bytes: number }).$bytes).toBe(APPROVAL_INLINE_ARGUMENT_MAX_BYTES + 1);
  });

  it('is idempotent: an already-projected value passes through unchanged', () => {
    const first = projectApprovalArguments('propose_text_edit', { path: 'a', find: 'f'.repeat(600), replace: 'short' });
    const second = projectApprovalArguments('propose_text_edit', first.projected);
    expect(second.projected).toEqual(first.projected);
    expect(second.projectedAny).toBe(false);
  });

  it('leaves small arguments and other tools byte-identical (same object)', () => {
    const small = { path: 'a.ts', content: 'tiny' };
    expect(projectApprovalArguments('propose_file_change', small)).toEqual({ projected: small, projectedAny: false });
    const command = { command: 'x'.repeat(5000) };
    expect(projectApprovalArguments('run_command', command).projected).toBe(command);
  });
});

describe('M45 approval argument split', () => {
  it('a small-argument approval summary keeps its pre-M45 shape (no digest, no payload)', async () => {
    const registry = recordingRegistry();
    const requested = await dispatchCapability(db, registry, {
      ...base, correlationId: 'small', toolName: 'propose_file_change', arguments: { path: 'a.ts', content: 'tiny' },
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    const summary = requested.approval.summary as Record<string, unknown>;
    expect(summary.arguments).toEqual({ path: 'a.ts', content: 'tiny' });
    expect(summary).not.toHaveProperty('argumentsDigest');
    expect(getApprovalActionArguments(db, requested.approval.id)).toEqual({ path: 'a.ts', content: 'tiny' });
  });

  it('bounds a 40 KB proposal summary, then executes the exact full bytes once approved', async () => {
    const registry = recordingRegistry();
    const content = `${'0123456789abcdef'.repeat(2560)}\n`;
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(40_000);
    const args = { path: 'big.txt', content };
    const requested = await dispatchCapability(db, registry, { ...base, correlationId: 'big', toolName: 'propose_file_change', arguments: args });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');

    expect(summaryBytes(requested.approval)).toBeLessThanOrEqual(8192);
    const summary = requested.approval.summary as { arguments: Record<string, unknown>; argumentsDigest?: string };
    expect(isProjectedBulkValue(summary.arguments.content)).toBe(true);
    expect(summary.argumentsDigest).toBe(canonicalArgumentsDigest(args));
    expect(getApprovalActionArguments(db, requested.approval.id)).toEqual(args);

    // Retrying the identical action returns the same pending approval.
    const retried = await dispatchCapability(db, registry, { ...base, correlationId: 'big', toolName: 'propose_file_change', arguments: args });
    expect(retried.outcome === 'approval_required' && retried.approval.id).toBe(requested.approval.id);
    expect(listApprovalsForAttempt(db, requested.attemptId)).toHaveLength(1);

    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));
    const done = await dispatchCapability(db, registry, { ...base, correlationId: 'big', toolName: 'propose_file_change', arguments: args });
    expect(done.outcome).toBe('executed');
    expect(executed).toHaveLength(1);
    expect(executed[0].arguments.content).toBe(content);
  });

  it('the restore listing shows the projected value, and re-dispatching it rebinds to the full bytes', async () => {
    const registry = recordingRegistry();
    const content = 'z'.repeat(40_000);
    const requested = await dispatchCapability(db, registry, {
      ...base, correlationId: 'restore', toolName: 'propose_file_change', arguments: { path: 'r.txt', content },
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    const listed = listCapabilityActions(db, { correlationId: 'restore', clientId: 'client-1' }).actions[0];
    expect(isProjectedBulkValue((listed.arguments as Record<string, unknown>).content)).toBe(true);

    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));
    // The restored card re-sends the listing's (projected) arguments.
    const done = await dispatchCapability(db, registry, {
      ...base, correlationId: 'restore', toolName: 'propose_file_change', arguments: listed.arguments as Record<string, unknown>,
    });
    expect(done.outcome).toBe('executed');
    expect(executed).toHaveLength(1);
    expect(executed[0].arguments.content).toBe(content);
  });

  it('refuses to dispatch projected arguments that match no approval', async () => {
    const registry = recordingRegistry();
    const projected = projectApprovalArguments('propose_file_change', { path: 'p.txt', content: 'q'.repeat(2000) }).projected;
    await expect(dispatchCapability(db, registry, {
      ...base, correlationId: 'orphan', toolName: 'propose_file_change', arguments: projected,
    })).rejects.toThrow(/projected action arguments/);
    expect(executed).toHaveLength(0);
  });

  it('a digest mismatch is refused at creation and at read', async () => {
    const attemptId = ensureCapabilityAttempt(db, { correlationId: 'digest', actor: 'core', clientId: 'client-1' });
    const full = { path: 'd.txt', content: 'w'.repeat(2000) };
    const { projected } = projectApprovalArguments('propose_file_change', full);
    expect(() => createApproval(db, {
      attemptId, kind: 'mutation', actor: 'core',
      summary: { toolName: 'propose_file_change', arguments: projected, argumentsDigest: canonicalArgumentsDigest({ ...full, content: 'other' }) },
      actionArguments: full,
    })).toThrow(/do not match the summary digest/);

    const approval = createApproval(db, {
      attemptId, kind: 'mutation', actor: 'core',
      summary: { toolName: 'propose_file_change', arguments: projected, argumentsDigest: canonicalArgumentsDigest(full) },
      actionArguments: full,
    });
    db.run('UPDATE approvals SET actionArgumentsJson = ? WHERE id = ?', [JSON.stringify({ ...full, content: 'tampered' }), approval.id]);
    expect(() => getApprovalActionArguments(db, approval.id)).toThrow(/no longer match their digest/);
  });

  it('a legacy row that stored raw content in its summary still matches a new dispatch of the same action', async () => {
    const registry = recordingRegistry();
    const content = 'L'.repeat(3000);
    const args = { path: 'legacy.txt', content };
    const attemptId = ensureCapabilityAttempt(db, { correlationId: 'legacy', actor: 'core', clientId: 'client-1' });
    const legacy = createApproval(db, {
      attemptId, kind: 'mutation', actor: 'core',
      summary: {
        toolName: 'propose_file_change', arguments: args,
        workspaceRoot: process.cwd(), pushAuthorized: false, networkAuthorized: false, installAuthorized: false,
        policyDecision: 'review_required', policyReason: 'review',
      },
    });
    expect(getApprovalActionArguments(db, legacy.id)).toEqual(args);

    const again = await dispatchCapability(db, registry, { ...base, correlationId: 'legacy', toolName: 'propose_file_change', arguments: args });
    expect(again.outcome).toBe('approval_required');
    if (again.outcome === 'approval_required') expect(again.approval.id).toBe(legacy.id);
    expect(listApprovalsForAttempt(db, attemptId)).toHaveLength(1);

    resolveCapabilityApproval(db, decisionFrom(getApproval(db, legacy.id), 'approved'));
    const done = await dispatchCapability(db, registry, { ...base, correlationId: 'legacy', toolName: 'propose_file_change', arguments: args });
    expect(done.outcome).toBe('executed');
    expect(executed[0].arguments.content).toBe(content);
  });

  it('mission authorization at resolve time judges the full bytes, not the projected summary', async () => {
    const registry = recordingRegistry();
    const missionAttemptId = ensureCapabilityAttempt(db, { correlationId: 'mission-owner', actor: 'core', clientId: 'client-1' });
    const envelope = buildMissionEnvelope({ workspaceRoot: dir, objective: 'Tidy', model: 'fixture' });
    envelope.fileChangeLimits.maxBytesPerFile = 16 * 1024;
    // Dispatched before authorization exists: review is required, so a pending approval is created.
    const requested = await dispatchCapability(db, registry, {
      ...base, cwd: dir, correlationId: 'mission-work', scopeIdentity: missionAttemptId,
      toolName: 'propose_file_change', arguments: { path: 'src/big.txt', content: 'm'.repeat(20 * 1024) },
    });
    if (requested.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${requested.outcome}`);
    expect(summaryBytes(requested.approval)).toBeLessThanOrEqual(8192);

    requestMissionAuthorization(db, { attemptId: missionAttemptId, approvalAttemptId: missionAttemptId, clientId: 'client-1', actor: 'core', envelope });
    markMissionAuthorized(db, missionAttemptId, 'client-1');

    // Only the full 20 KB content can yield this reason; the projected summary would read as "requires text content".
    expect(() => resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved')))
      .toThrow(/exceeds the per-file size limit/);
    expect(getApproval(db, requested.approval.id).status).toBe('rejected');
    expect(executed).toHaveLength(0);
  });
});
