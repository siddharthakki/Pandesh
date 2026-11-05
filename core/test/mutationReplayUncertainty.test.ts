/**
 * M-benchmark P4 — the mutation replay guard.
 *
 * A workspace edit is replay-sensitive. The rule the ledger and the writer
 * both obey is three-way (`core/domain/mutationLedger.ts`):
 *
 *   - the file already holds the RESULT  -> the write landed: a verified
 *     no-op, and nothing is written again;
 *   - the file still holds the BASELINE -> the write never landed: safe to
 *     apply it;
 *   - the file holds NEITHER             -> the outcome of the earlier
 *     attempt is UNKNOWN, and an unknown side effect is NEVER replayed.
 *
 * These tests drive the REAL tool runner and prove the third case: the
 * write is refused, nothing is written, and a repeated dispatch of the very
 * same approved proposal writes nothing either.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { CoreToolRunner } from '../runtime/toolRunner';
import { LocalAutonomySecurityKernel } from '../../core/security/kernel';
import { buildWriteFileProposal } from '../runtime/writeProposal';

const ORIGINAL_CONTENT = 'line one\nline two\nline three\n';
const PROPOSED_CONTENT = 'line one\nline two changed\nline three\n';
const THIRD_PARTY_CONTENT = 'line one\nedited by somebody else\nline three\n';

let dir: string;
let db: CoreDatabase;

function grantFor(call: { name: string; arguments: Record<string, unknown> }) {
  const kernel = LocalAutonomySecurityKernel.getInstance(db);
  const attemptId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const approvalId = `appr_${attemptId}`;
  const now = new Date().toISOString();
  db.run('PRAGMA foreign_keys = OFF');
  db.run(
    `INSERT INTO approvals (id, attemptId, kind, status, requestedAt, resolvedAt, resolution, summary)
     VALUES (?, ?, 'mutation', 'resolved', ?, ?, 'approved', ?)`,
    [approvalId, attemptId, now, now, JSON.stringify({ toolName: call.name })],
  );
  db.run('PRAGMA foreign_keys = ON');
  const request = kernel.normalizeRequest({
    attemptId,
    executor: 'core:tool_runner',
    capability: 'filesystem',
    workspaceRoot: dir,
    targetResource: path.resolve(dir, String(call.arguments.path ?? '')),
    arguments: call.arguments,
    riskLevel: 'consequential',
  });
  const decision = kernel.authorize(request, { approvalId });
  if (decision.decision !== 'ALLOW' || !decision.grant) {
    throw new Error(`Failed to authorize grant: ${decision.reason}`);
  }
  return { grant: decision.grant, attemptId };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-replay-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), ORIGINAL_CONTENT, 'utf8');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the mutation replay guard', () => {
  it('refuses a write whose pre-image moved on, and writes nothing', async () => {
    const runner = new CoreToolRunner();
    const proposal = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT })!;
    // Somebody else edited the file after the proposal was computed.
    fs.writeFileSync(path.join(dir, 'note.txt'), THIRD_PARTY_CONTENT, 'utf8');

    const call = { name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } };
    const { grant, attemptId } = grantFor(call);
    const result = await runner.run(call, {
      cwd: dir,
      expectedBaseline: proposal.expectedBaseline,
      expectedResultSha256: proposal.resultSha256,
      securityGrant: grant,
      attemptId,
    });

    expect(result.status).toBe('failed');
    expect(result.output).toContain('Stale proposal');
    // The file is exactly as the third party left it.
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(THIRD_PARTY_CONTENT);
  });

  it('never replays an uncertain outcome: a repeated dispatch writes nothing', async () => {
    const runner = new CoreToolRunner();
    const proposal = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT })!;
    fs.writeFileSync(path.join(dir, 'note.txt'), THIRD_PARTY_CONTENT, 'utf8');

    const call = { name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { grant, attemptId } = grantFor(call);
      const result = await runner.run(call, {
        cwd: dir,
        expectedBaseline: proposal.expectedBaseline,
        expectedResultSha256: proposal.resultSha256,
        securityGrant: grant,
        attemptId,
      });
      expect(result.status).toBe('failed');
      // The refusal says why, and says that the side effect was not repeated.
      expect(result.output).toContain('outcome of the earlier attempt at this change is unknown');
      expect(result.output).toContain('was not repeated');
      expect(result.output).toContain('Nothing was written');
      expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(THIRD_PARTY_CONTENT);
    }
  });

  it('is a no-op when the file already holds the result', async () => {
    const runner = new CoreToolRunner();
    const proposal = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT })!;
    // The write landed before the completion record was lost.
    fs.writeFileSync(path.join(dir, 'note.txt'), PROPOSED_CONTENT, 'utf8');

    const call = { name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } };
    const { grant, attemptId } = grantFor(call);
    const result = await runner.run(call, {
      cwd: dir,
      expectedBaseline: proposal.expectedBaseline,
      expectedResultSha256: proposal.resultSha256,
      securityGrant: grant,
      attemptId,
    });

    expect(result.status).toBe('succeeded');
    expect(result.resultCategory).toBe('mutation_already_applied');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(PROPOSED_CONTENT);
  });
});
