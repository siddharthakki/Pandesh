import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { createMission, getMission, updateMissionStep } from '../domain/missions';
import { buildOutcomeReceipt } from '../runtime/outcomeReceipt';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-receipt-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function lead() {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
  const r = submitRequest(db, {
    clientId: 'test-client', currentMessage: 'build a tip calculator', requestedMode: 'baat_kar', conversationId: conv.id, workspaceRoot: dir,
    capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${Math.random()}`, toolPermissionPolicy: {},
    selectedProvider: 'ollama', selectedModel: 'gemma4:12b',
  });
  return { conversationId: conv.id, attemptId: r.attempt.id };
}

describe('buildOutcomeReceipt', () => {
  it('aggregates steps, tools, models, approvals and artifacts into a structured receipt', () => {
    const l = lead();
    const m = createMission(db, {
      conversationId: l.conversationId, parentAttemptId: l.attemptId, clientId: 'test-client', objective: 'Build a tip calculator with tests',
      workspaceRoot: dir, selectedProvider: 'ollama', selectedModel: 'gemma4:12b',
      steps: [
        { agentId: 'coding', title: 'Write code', brief: 'add formatEuro with tests', kind: 'work' },
        { agentId: 'reviewer', title: 'Verify', brief: 'run tests independently', kind: 'review' },
      ],
    });
    const step1 = m.steps[0];
    const step2 = m.steps[1];

    // Give step 1 a real delegated attempt so tool/model/approval rows can attach.
    const childReq = submitRequest(db, {
      clientId: 'test-client', currentMessage: 'child', requestedMode: 'baat_kar', conversationId: l.conversationId, workspaceRoot: dir,
      capability: { hasWorkspace: true, gitCapable: false }, correlationId: `child-${Math.random()}`, toolPermissionPolicy: {},
      selectedProvider: 'ollama', selectedModel: 'gemma4:12b',
    });
    updateMissionStep(db, step1.id, { childAttemptId: childReq.attempt.id } as any);

    // Re-fetch the step so childAttemptId is populated.
    const m2 = getMission(db, m.id);
    const att1 = m2.steps[0].childAttemptId!;

    // Step 1 succeeds with evidence + artifact.
    updateMissionStep(db, step1.id, {
      status: 'succeeded',
      resultText: 'Added formatEuro and a test.',
      evidence: { verified: [{ tool: 'write_file', count: 2 }, { tool: 'run_checks', count: 1 }], unrelated: [], failed: [], unbacked: [], totalCalls: 3, seconds: 47 },
      artifacts: [{ path: path.join(dir, 'tip.py'), bytes: 120, kind: 'file', exists: true }],
    });
    // Step 2 review succeeds.
    updateMissionStep(db, step2.id, {
      status: 'succeeded',
      resultText: 'Tests pass.',
      evidence: { verified: [{ tool: 'run_checks', count: 1 }], unrelated: [], failed: [], unbacked: [], totalCalls: 1, seconds: 3 },
    });

    // Tool invocations for step 1's attempt.
    db.run(`INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt, endedAt, exitCode, evidence) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['t1', att1, 'write_file', '{}', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 0, '{}']);
    db.run(`INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt, endedAt, exitCode, evidence) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['t2', att1, 'write_file', '{}', 'succeeded', '2026-01-01T00:00:02Z', '2026-01-01T00:00:03Z', 0, '{}']);
    db.run(`INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt, endedAt, exitCode, evidence) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['t3', att1, 'run_checks', '{}', 'succeeded', '2026-01-01T00:00:04Z', '2026-01-01T00:00:05Z', 0, '{}']);

    // Model invocation.
    db.run(`INSERT INTO model_invocations (id, attemptId, requestedProvider, requestedModel, actualProvider, actualModel, status, startedAt, endedAt, latencyMs, usageMetadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['m1', att1, 'ollama', 'gemma4:12b', 'ollama', 'gemma4:12b', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z', 10000, JSON.stringify({ promptTokens: 100, completionTokens: 50 })]);

    // Approval.
    db.run(`INSERT INTO approvals (id, attemptId, kind, status, requestedAt, resolvedAt, resolution, summary) VALUES (?,?,?,?,?,?,?,?)`,
      ['a1', att1, 'mutation', 'approved', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 'approved', '{}']);
    db.run(`INSERT INTO approvals (id, attemptId, kind, status, requestedAt, resolvedAt, resolution, summary) VALUES (?,?,?,?,?,?,?,?)`,
      ['a2', att1, 'mutation', 'approved', '2026-01-01T00:00:02Z', '2026-01-01T00:00:03Z', 'approved', '{}']);

    // Mark mission completed.
    db.run(`UPDATE missions SET status='completed', createdAt='2026-01-01T00:00:00Z', completedAt='2026-01-01T00:00:50Z', resultSummary='Next: run it for 84.50.' WHERE id=?`, [m.id]);

    const receipt = buildOutcomeReceipt(db, m.id);
    expect(receipt.objective).toBe('Build a tip calculator with tests');
    expect(receipt.status).toBe('completed');
    expect(receipt.headline).toBe('Verified');
    expect(receipt.steps).toHaveLength(2);
    expect(receipt.steps[0].status).toBe('succeeded');
    expect(receipt.steps[1].kind).toBe('review');
    expect(receipt.independentlyReviewed).toBe(true);
    // Operations
    const ops = Object.fromEntries(receipt.operations.map((o) => [o.label, o.count]));
    expect(ops['files changed']).toBe(2);
    expect(ops['tests passed']).toBe(1);
    expect(ops['checks run']).toBe(1);
    // Artifacts
    expect(receipt.artifacts).toHaveLength(1);
    expect(receipt.artifacts[0].path).toContain('tip.py');
    // Approvals
    expect(receipt.approvalsUsed).toBe(2);
    // Model/tokens
    expect(receipt.model).toBe('gemma4:12b');
    expect(receipt.provider).toBe('ollama');
    expect(receipt.tokens).toEqual({ prompt: 100, completion: 50 });
    // Duration
    expect(receipt.durationMs).toBe(50000);
    // Verified outputs include reviewed level from reviewer step
    expect(receipt.verifiedOutputs.some((v) => v.level === 'reviewed')).toBe(true);
    // Undo
    expect(receipt.undoAvailable).toBe(false);
  });

  it('reports partial/failed steps honestly and never hides them', () => {
    const l = lead();
    const m = createMission(db, {
      conversationId: l.conversationId, parentAttemptId: l.attemptId, clientId: 'test-client', objective: 'Organize Downloads',
      workspaceRoot: dir, selectedProvider: 'ollama', selectedModel: 'gemma4:12b',
      steps: [
        { agentId: 'operations', title: 'Inventory', brief: 'scan disks and folders', kind: 'work' },
        { agentId: 'operations', title: 'Move files', brief: 'apply the approved plan', kind: 'work' },
      ],
    });
    updateMissionStep(db, m.steps[0].id, { status: 'succeeded', resultText: '327 files observed', evidence: { verified: [{ tool: 'pc_organize_scan', count: 1 }], unrelated: [], failed: [], unbacked: [], totalCalls: 1 } });
    updateMissionStep(db, m.steps[1].id, { status: 'failed', resultText: null, error: 'approval not received' });
    db.run(`UPDATE missions SET status='failed', completedAt='2026-01-01T00:00:10Z' WHERE id=?`, [m.id]);

    const receipt = buildOutcomeReceipt(db, m.id);
    expect(receipt.status).toBe('failed');
    expect(receipt.headline).toBe('Not finished');
    expect(receipt.partialOrFailed).toHaveLength(1);
    expect(receipt.partialOrFailed[0].status).toBe('failed');
    expect(receipt.partialOrFailed[0].reason).toBe('approval not received');
    // The succeeded step is still listed.
    expect(receipt.steps[0].status).toBe('succeeded');
    expect(receipt.steps[1].status).toBe('failed');
  });

  it('marks unverified steps honestly (no tool call backs the report)', () => {
    const l = lead();
    const m = createMission(db, {
      conversationId: l.conversationId, parentAttemptId: l.attemptId, clientId: 'test-client', objective: 'Check the PC',
      workspaceRoot: dir, selectedProvider: 'ollama', selectedModel: 'gemma4:12b',
      steps: [{ agentId: 'operations', title: 'Scan', brief: 'scan the PC thoroughly', kind: 'work' }],
    });
    updateMissionStep(db, m.steps[0].id, { status: 'unverified', resultText: 'PC is fine.', evidence: { verified: [], unrelated: [], failed: [], unbacked: ['get_system_info'], totalCalls: 0 } });
    db.run(`UPDATE missions SET status='completed_with_issues', completedAt='2026-01-01T00:00:05Z' WHERE id=?`, [m.id]);

    const receipt = buildOutcomeReceipt(db, m.id);
    expect(receipt.status).toBe('completed_with_issues');
    expect(receipt.headline).toBe('Completed with issues');
    expect(receipt.partialOrFailed).toHaveLength(1);
    expect(receipt.partialOrFailed[0].status).toBe('unverified');
  });

  it('undo is available when organizer actions ran', () => {
    const l = lead();
    const m = createMission(db, {
      conversationId: l.conversationId, parentAttemptId: l.attemptId, clientId: 'test-client', objective: 'Organize',
      workspaceRoot: dir, selectedProvider: 'ollama', selectedModel: 'gemma4:12b',
      steps: [{ agentId: 'operations', title: 'Apply', brief: 'apply the org plan', kind: 'work' }],
    });
    updateMissionStep(db, m.steps[0].id, {
      status: 'succeeded',
      resultText: 'Applied 196 moves.',
      evidence: { verified: [{ tool: 'pc_organize_apply', count: 1 }], unrelated: [], failed: [], unbacked: [], totalCalls: 1 },
    });
    db.run(`UPDATE missions SET status='completed', createdAt='2026-01-01T00:00:00Z', completedAt='2026-01-01T00:00:05Z' WHERE id=?`, [m.id]);
    const receipt = buildOutcomeReceipt(db, m.id);
    expect(receipt.undoAvailable).toBe(true);
    expect(receipt.undoHint).toBe('pc_organize_undo available');
  });
});