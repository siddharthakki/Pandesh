import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreToolRunner } from '../runtime/toolRunner';
import { buildWriteFileProposal } from '../runtime/writeProposal';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import type { ModelToolCall } from '../runtime/modelBackend';

let dir: string;
let db: CoreDatabase;
let kernel: LocalAutonomySecurityKernel;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-file-'));
  const res = openCoreDatabase(path.join(dir, 'core.db'));
  db = res.db;
  kernel = LocalAutonomySecurityKernel.initialize(db, 'test-secret-key-32-bytes-secure!!');
});

afterEach(() => {
  try {
    LocalAutonomySecurityKernel.setInstance(null);
    db?.close();
  } catch {}
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

function grantFor(call: ModelToolCall) {
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

  const req = kernel.normalizeRequest({
    attemptId,
    executor: 'core:tool_runner',
    capability: 'filesystem',
    workspaceRoot: dir,
    targetResource: path.resolve(dir, String(call.arguments.path ?? '')),
    arguments: call.arguments,
    riskLevel: 'consequential',
  });
  const decision = kernel.authorize(req, { approvalId });
  if (decision.decision !== 'ALLOW' || !decision.grant) {
    throw new Error(`Failed to authorize grant: ${decision.reason}`);
  }
  return { grant: decision.grant, attemptId };
}

describe('governed creation of a file in a missing directory', () => {
  it('the proposal names the directories it will create and creates none itself', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const proposal = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'src/lib/deep/new.ts', content: 'x\n' })!;
    expect(proposal.presentation.createsDirectories).toEqual(['src/lib', 'src/lib/deep']);
    expect(proposal.presentation.diff).toContain('will also create the parent directories: src/lib, src/lib/deep');
    expect(fs.existsSync(path.join(dir, 'src', 'lib'))).toBe(false);
  });

  it('an existing parent adds no directory notice', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const proposal = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'src/new.ts', content: 'x\n' })!;
    expect(proposal.presentation.createsDirectories).toBeUndefined();
    expect(proposal.presentation.diff).not.toContain('parent director');
  });

  it('approved execution creates the parents and writes the file', async () => {
    const proposal = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'a/b/new.txt', content: 'hello\n' })!;
    const call: ModelToolCall = { name: 'propose_file_change', arguments: { path: 'a/b/new.txt', content: 'hello\n' } };
    const { grant, attemptId } = grantFor(call);
    const result = await new CoreToolRunner().run(
      call,
      { cwd: dir, expectedBaseline: proposal.expectedBaseline, securityGrant: grant, attemptId },
    );
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'a', 'b', 'new.txt'), 'utf8')).toBe('hello\n');
  });

  it('a path escaping the workspace is refused before any directory is created', async () => {
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}`);
    const call: ModelToolCall = { name: 'propose_file_change', arguments: { path: `../outside-${path.basename(dir)}/x/new.txt`, content: 'x' } };
    const { grant, attemptId } = grantFor(call);
    const result = await new CoreToolRunner().run(
      call,
      { cwd: dir, securityGrant: grant, attemptId },
    );
    expect(result.status).toBe('failed');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('a failed write removes only the directories it created', async () => {
    fs.mkdirSync(path.join(dir, 'keep'));
    fs.writeFileSync(path.join(dir, 'keep', 'existing.txt'), 'stay');
    // A 300-character file name is refused by the filesystem itself on every
    // platform, after the parent directories were created.
    const longName = `${'n'.repeat(300)}.txt`;
    const call: ModelToolCall = { name: 'propose_file_change', arguments: { path: `keep/x/y/${longName}`, content: 'x' } };
    const { grant, attemptId } = grantFor(call);
    const result = await new CoreToolRunner().run(
      call,
      { cwd: dir, expectedBaseline: { kind: 'absent' }, securityGrant: grant, attemptId },
    );
    expect(result.status).toBe('failed');
    expect(result.resultCategory).not.toBe('write_succeeded');
    expect(fs.existsSync(path.join(dir, 'keep', 'x'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'keep', 'existing.txt'), 'utf8')).toBe('stay');
  });
});
