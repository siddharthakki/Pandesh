import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchCapability, resolveCapabilityApproval } from '../domain/capabilityDispatch';
import { listToolInvocationsForAttempt } from '../domain/toolInvocations';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { ApprovalRecord } from '../shared/wireTypes';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-capability-exactly-once-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

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

describe('M38 approved capability dispatch exactly-once invariant', () => {
  it('returns the recorded terminal invocation instead of re-running a non-idempotent adapter', async () => {
    const adapterCalls: Array<Record<string, unknown>> = [];
    const registry = new GovernedCapabilityRegistry().register({
      id: 'test-non-idempotent-write',
      definitions: () => [{
        name: 'test_non_idempotent_write',
        description: 'A consequential test adapter with no internal deduplication.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      }],
      classify: () => 'consequential',
      health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
      run: async (call) => {
        adapterCalls.push(call.arguments);
        return {
          status: 'succeeded',
          exitCode: 0,
          output: 'mutated',
          resultCategory: 'test_write_succeeded',
          normalizedArguments: call.arguments,
        };
      },
    });

    const input = {
      correlationId: 'exactly-once-action',
      toolName: 'test_non_idempotent_write',
      arguments: { value: 'one mutation only' },
      cwd: process.cwd(),
      actor: 'core',
      clientId: 'client-1',
    };

    const requested = await dispatchCapability(db, registry, input);
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval));

    const first = await dispatchCapability(db, registry, input);
    const duplicate = await dispatchCapability(db, registry, input);

    expect(first.outcome).toBe('executed');
    expect(duplicate.outcome).toBe('executed');
    if (first.outcome !== 'executed' || duplicate.outcome !== 'executed') {
      throw new Error('expected both dispatch responses to return durable execution evidence');
    }
    expect(duplicate.toolInvocation.id).toBe(first.toolInvocation.id);
    expect(duplicate.toolInvocation.status).toBe('succeeded');
    expect(adapterCalls).toHaveLength(1);
    expect(listToolInvocationsForAttempt(db, requested.attemptId)).toHaveLength(1);
  });
});
