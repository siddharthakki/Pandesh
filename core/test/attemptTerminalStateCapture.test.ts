import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { submitRequest } from '../domain/submission';
import { failAttempt, getAttempt } from '../domain/attempts';
import { classifyAttemptFailure } from '../domain/failureClassification';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-terminal-state-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Mirrors `scripts/acceptance/run-m32-packaged-dogfood.mjs`'s `pollUntil` +
 * `findAttemptById`-style pattern: poll the durable attempt record directly
 * (never the DOM, never a UI label) at a short interval, resolving the
 * instant the status is terminal.
 */
async function pollForTerminalAttempt(attemptId: string, db: CoreDatabase, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const attempt = getAttempt(db, attemptId);
    if (['completed', 'failed', 'cancelled'].includes(attempt.status)) return attempt;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`attempt '${attemptId}' did not reach a terminal state within ${timeoutMs}ms (harness_timeout)`);
}

describe('terminal attempt state — immediate capture and honest classification', () => {
  it('captures a terminal mutation_failed outcome immediately from the durable attempt record, not by waiting out a timeout', async () => {
    const result = submitRequest(db, {
      clientId: 'client-1',
      currentMessage: 'apply the requested change',
      requestedMode: 'karke_dikha',
      workspaceRoot: 'C:\\work\\repo',
      requestedProvider: 'ollama',
      selectedModel: 'test-model',
      toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file'] },
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: 'corr-mutation-failed',
    });

    // Simulate a real mutation-apply failure being recorded as durable Core
    // evidence, exactly as `core/runtime/executor.ts` would via `failAttempt`
    // (a git apply / patch-application error, not a model or validation
    // failure) — the attempt transitions straight to 'failed' with a
    // classifiable failureReason.
    failAttempt(db, result.attempt.id, {
      failureReason: "mutation_failed: git apply rejected 2 of 2 hunks in 'src/greeting.js' — target file diverged from the frozen proposal baseline",
      actor: 'client-1',
      fenceToken: result.attempt.fenceToken,
    });

    // A deliberately generous nominal timeout (would be minutes in the real
    // packaged scenario) — the assertion below is on ELAPSED time, proving
    // detection is immediate and does not depend on exhausting this budget.
    const NOMINAL_TIMEOUT_MS = 30_000;
    const startedAt = Date.now();
    const finalAttempt = await pollForTerminalAttempt(result.attempt.id, db, NOMINAL_TIMEOUT_MS);
    const elapsedMs = Date.now() - startedAt;

    // The attempt was already terminal before polling even began (failAttempt
    // ran synchronously above), so detection should be on the order of one
    // poll interval, nowhere close to the nominal budget.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(finalAttempt.status).toBe('failed');

    // Never infer the classification from a UI label — read it from the
    // durable failureReason the record actually carries.
    const classification = classifyAttemptFailure(finalAttempt.failureReason);
    expect(classification).toBe('mutation_failed');

    // A harness_timeout is a structurally different outcome (no attempt
    // record ever reached a terminal status) and must never be confused
    // with, or silently reported as, a mutation_failed classification.
    expect(classification).not.toBe('unclassified');
  });

  it('reports a genuine harness_timeout distinctly, never fabricating a durable-evidence classification for it', async () => {
    const result = submitRequest(db, {
      clientId: 'client-1',
      currentMessage: 'apply another requested change',
      requestedMode: 'karke_dikha',
      workspaceRoot: 'C:\\work\\repo',
      requestedProvider: 'ollama',
      selectedModel: 'test-model',
      toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file'] },
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: 'corr-harness-timeout',
    });
    // Attempt is deliberately left in 'created' (never transitioned to a
    // terminal status) to exercise the harness's own timeout path.
    await expect(pollForTerminalAttempt(result.attempt.id, db, 100)).rejects.toThrow(/harness_timeout/);
    // The attempt itself carries no failureReason at all — classifying it
    // via classifyAttemptFailure (which callers must NOT do for a harness
    // timeout, since there is no terminal record) would honestly report
    // 'unclassified' rather than any specific durable-evidence category.
    expect(classifyAttemptFailure(getAttempt(db, result.attempt.id).failureReason)).toBe('unclassified');
  });

  it.each([
    ['mutation_failed: patch application failed', 'mutation_failed'],
    ['validation_or_quality_gate_failed', 'validation_failure'],
    ['exceeded 40 tool turns without a final answer', 'gate_deadlock'],
    ["this turn includes an image attachment but no vision-capable model was selected; refusing to silently drop the image", 'product_failure'],
    ['connection refused: ECONNREFUSED 127.0.0.1:11434', 'model_failure'],
    [null, 'unclassified'],
  ] as const)('classifies failureReason %j as %s', (failureReason, expected) => {
    expect(classifyAttemptFailure(failureReason)).toBe(expected);
  });
});
