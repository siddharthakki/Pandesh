import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildTextEditProposal, resolveAnchoredEdit } from '../runtime/textEditProposal';
import { sha256OfBuffer } from '../runtime/writeProposal';
import { CoreToolRunner } from '../runtime/toolRunner';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';

const FOOTER_BASELINE = [
  '<html>',
  '<body>',
  '<div id="cookie-consent">',
  '  <p>We use cookies.</p>',
  '  <button>Accept</button>',
  '</div>',
  '<footer>&copy; 2025 Kha Ke Dikha. All rights reserved.</footer>',
  '</body>',
  '</html>',
  '',
].join('\n');

describe('resolveAnchoredEdit', () => {
  it('applies a unique anchor and changes nothing else', () => {
    const result = resolveAnchoredEdit(FOOTER_BASELINE, '&copy; 2025', '&copy; 2026');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.content).toBe(FOOTER_BASELINE.replace('&copy; 2025', '&copy; 2026'));
    // Every line except the footer year is byte-for-byte identical.
    const beforeLines = FOOTER_BASELINE.split('\n');
    const afterLines = result.content.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);
    const changedLines = beforeLines.filter((line, index) => line !== afterLines[index]);
    expect(changedLines).toEqual(['<footer>&copy; 2025 Kha Ke Dikha. All rights reserved.</footer>']);
  });

  it('fails without producing content when the anchor is missing', () => {
    const result = resolveAnchoredEdit(FOOTER_BASELINE, 'this text is not present', 'x');
    expect(result.ok).toBe(false);
  });

  it('fails without producing content when the anchor is ambiguous (occurs more than once)', () => {
    const result = resolveAnchoredEdit(FOOTER_BASELINE, '</', '< /');
    expect(result.ok).toBe(false);
  });

  it('rejects an empty find', () => {
    const result = resolveAnchoredEdit(FOOTER_BASELINE, '', 'x');
    expect(result.ok).toBe(false);
  });
});

describe('buildTextEditProposal', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'text-edit-proposal-'));
    fs.mkdirSync(path.join(workspaceRoot, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'templates', 'base.html'), FOOTER_BASELINE, 'utf8');
  });
  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('computes the full resulting content, a one-line diff, and the pre-edit SHA-256', () => {
    const built = buildTextEditProposal({
      workspaceRoot,
      requestedPath: 'templates/base.html',
      find: '&copy; 2025',
      replace: '&copy; 2026',
    });
    expect(built && !('error' in built)).toBe(true);
    if (!built || 'error' in built) throw new Error('unreachable');
    expect(built.content).toBe(FOOTER_BASELINE.replace('&copy; 2025', '&copy; 2026'));
    expect(built.expectedBaseline).toEqual({
      kind: 'file',
      sha256: sha256OfBuffer(Buffer.from(FOOTER_BASELINE, 'utf8')),
    });
    const removed = built.presentation.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
    const added = built.presentation.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0]).toContain('2025');
    expect(added[0]).toContain('2026');
  });

  it('refuses (without mutation) when the anchor is missing', () => {
    const before = fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8');
    const built = buildTextEditProposal({
      workspaceRoot,
      requestedPath: 'templates/base.html',
      find: 'does-not-exist',
      replace: 'x',
    });
    expect(built && 'error' in built).toBe(true);
    expect(fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8')).toBe(before);
  });

  it('refuses (without mutation) when the anchor is ambiguous', () => {
    const before = fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8');
    const built = buildTextEditProposal({
      workspaceRoot,
      requestedPath: 'templates/base.html',
      find: '</',
      replace: '< /',
    });
    expect(built && 'error' in built).toBe(true);
    expect(fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8')).toBe(before);
  });

  it('refuses when there is no file to anchor against', () => {
    const built = buildTextEditProposal({
      workspaceRoot,
      requestedPath: 'templates/does-not-exist.html',
      find: 'x',
      replace: 'y',
    });
    expect(built && 'error' in built).toBe(true);
  });
});

describe('CoreToolRunner propose_text_edit execution', () => {
  let workspaceRoot: string;
  let runner: CoreToolRunner;
  let db: CoreDatabase;
  let kernel: LocalAutonomySecurityKernel;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'text-edit-exec-'));
    fs.mkdirSync(path.join(workspaceRoot, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'templates', 'base.html'), FOOTER_BASELINE, 'utf8');
    runner = new CoreToolRunner();
    const res = openCoreDatabase(path.join(workspaceRoot, 'core.db'));
    db = res.db;
    kernel = LocalAutonomySecurityKernel.initialize(db, 'test-secret-key-32-bytes-secure!!');
  });
  afterEach(() => {
    try {
      LocalAutonomySecurityKernel.setInstance(null);
      db?.close();
    } catch {}
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {}
  });

  function grantFor(call: { name: string; arguments: Record<string, any> }) {
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
      workspaceRoot,
      targetResource: path.resolve(workspaceRoot, String(call.arguments.path ?? '')),
      arguments: call.arguments,
      riskLevel: 'consequential',
    });
    const decision = kernel.authorize(req, { approvalId });
    if (decision.decision !== 'ALLOW' || !decision.grant) {
      throw new Error(`Failed to authorize grant: ${decision.reason}`);
    }
    return { grant: decision.grant, attemptId };
  }

  it('applies a unique anchored replacement, leaving unrelated content byte-for-byte unchanged', async () => {
    const built = buildTextEditProposal({
      workspaceRoot, requestedPath: 'templates/base.html', find: '&copy; 2025', replace: '&copy; 2026',
    });
    if (!built || 'error' in built) throw new Error('unreachable');
    const call = { name: 'propose_text_edit', arguments: { path: 'templates/base.html', find: '&copy; 2025', replace: '&copy; 2026' } };
    const { grant, attemptId } = grantFor(call);
    const result = await runner.run(
      call,
      { cwd: workspaceRoot, expectedBaseline: built.expectedBaseline, securityGrant: grant, attemptId },
    );
    expect(result.status).toBe('succeeded');
    const after = fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8');
    expect(after).toBe(FOOTER_BASELINE.replace('&copy; 2025', '&copy; 2026'));
    expect(after).toContain('<p>We use cookies.</p>');
    expect(after).toContain('<button>Accept</button>');
  });

  it('refuses to write when the baseline is stale, and leaves the file exactly as the racing writer left it', async () => {
    const built = buildTextEditProposal({
      workspaceRoot, requestedPath: 'templates/base.html', find: '&copy; 2025', replace: '&copy; 2026',
    });
    if (!built || 'error' in built) throw new Error('unreachable');
    // Someone else mutates the file after the proposal was built but before
    // it is applied — the anchor still occurs exactly once, so an anchor-only
    // check would incorrectly allow this write.
    const racedContent = FOOTER_BASELINE.replace('cookies.', 'cookies and local storage.');
    fs.writeFileSync(path.join(workspaceRoot, 'templates', 'base.html'), racedContent, 'utf8');

    const call = { name: 'propose_text_edit', arguments: { path: 'templates/base.html', find: '&copy; 2025', replace: '&copy; 2026' } };
    const { grant, attemptId } = grantFor(call);
    const result = await runner.run(
      call,
      { cwd: workspaceRoot, expectedBaseline: built.expectedBaseline, securityGrant: grant, attemptId },
    );
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('write_stale_baseline');
    expect(fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8')).toBe(racedContent);
  });

  it('refuses a missing anchor without writing anything', async () => {
    const before = fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8');
    const result = await runner.run(
      { name: 'propose_text_edit', arguments: { path: 'templates/base.html', find: 'not-present', replace: 'x' } },
      { cwd: workspaceRoot },
    );
    expect(result.status).toBe('failed');
    expect(fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8')).toBe(before);
  });

  it('refuses a duplicate anchor without writing anything', async () => {
    const before = fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8');
    const result = await runner.run(
      { name: 'propose_text_edit', arguments: { path: 'templates/base.html', find: '</', replace: '< /' } },
      { cwd: workspaceRoot },
    );
    expect(result.status).toBe('failed');
    expect(fs.readFileSync(path.join(workspaceRoot, 'templates', 'base.html'), 'utf8')).toBe(before);
  });
});
