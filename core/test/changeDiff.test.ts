/**
 * A5 "View diff": the read-only Git diff behind the review box (core/runtime/kandev/changeDiff.ts) and the bridge wrapper that
 * proves the folder is this task's private copy before reading anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DIFF_LIMITS, readChangeDiff, safeChangePath } from '../runtime/kandev/changeDiff';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { attachBridgeExecution, createPairingCode, recordBridgeStatus, redeemPairingCode, submitBridgeTask } from '../domain/pandaBridge';
import { transitionStory } from '../domain/stories';
import { bridgeChangeDiff, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { checkoutFingerprint, DEV_ACTOR, devStoryChangeDiff, planDevStories } from '../runtime/kandev/devStories';
import type { KandevClient } from '../runtime/kandev/kandevClient';

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdiff-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A repo with one commit holding several kinds of file. */
function repo(at = path.join(dir, 'r')): string {
  fs.mkdirSync(path.join(at, 'src'), { recursive: true });
  git(at, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(at, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(at, 'old.txt'), 'gone soon\n');
  fs.writeFileSync(path.join(at, 'move-me.txt'), 'line one\nline two\nline three\n');
  fs.writeFileSync(path.join(at, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(at, 'add', '-A'); git(at, 'commit', '-q', '-m', 'init');
  return at;
}
const head = (r: string) => git(r, 'rev-parse', 'HEAD').stdout.trim();

describe('readChangeDiff', () => {
  it('shows modified, deleted, renamed, binary and new files with real counts and patches, against the working tree', () => {
    const r = repo(); const base = head(r);
    fs.writeFileSync(path.join(r, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
    fs.rmSync(path.join(r, 'old.txt'));
    git(r, 'mv', 'move-me.txt', 'moved.txt');
    fs.writeFileSync(path.join(r, 'logo.bin'), Buffer.from([0, 9, 9, 9, 0, 1]));
    fs.writeFileSync(path.join(r, 'src', 'sub.js'), 'export const sub = (a, b) => a - b;\nexport default sub;\n');
    fs.writeFileSync(path.join(r, 'pic.png'), Buffer.from([137, 80, 78, 71, 0, 0, 1]));
    const d = readChangeDiff(r, base, null, { source: 'worker worktree' });
    const by = Object.fromEntries(d.files.map(f => [f.path, f]));
    expect(d.available).toBe(true);
    expect(by['src/add.js']).toMatchObject({ status: 'modified', additions: 1, deletions: 1, binary: false, truncated: false });
    expect(by['src/add.js'].patch).toMatch(/^-export const add = \(a, b\) => a - b;$/m);
    expect(by['src/add.js'].patch).toMatch(/^\+export const add = \(a, b\) => a \+ b;$/m);
    expect(by['old.txt']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(by['moved.txt']).toMatchObject({ status: 'renamed', oldPath: 'move-me.txt' });
    expect(by['logo.bin']).toMatchObject({ status: 'modified', binary: true, patch: null, additions: null });
    expect(by['logo.bin'].note).toMatch(/Binary/);
    expect(by['src/sub.js']).toMatchObject({ status: 'untracked', additions: 2, deletions: 0 });
    expect(by['src/sub.js'].patch).toMatch(/^\+export default sub;$/m);
    expect(by['pic.png']).toMatchObject({ status: 'untracked', binary: true, patch: null });
    expect(d.summary).toMatchObject({ files: 6, binary: 2 });
    expect(d.head).toMatch(/\+ uncommitted$/);
  });

  it('reads a committed range (the approved change in the private copy) and ignores files outside the change', () => {
    const r = repo(); const base = head(r);
    git(r, 'checkout', '-q', '-b', 'panda/change-x');
    fs.writeFileSync(path.join(r, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
    fs.mkdirSync(path.join(r, '.claude')); fs.writeFileSync(path.join(r, '.claude', 'settings.json'), '{}');
    git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'fix');
    fs.writeFileSync(path.join(r, 'scratch.txt'), 'not committed, not part of the range');
    const d = readChangeDiff(r, base, 'refs/heads/panda/change-x', { source: 'private copy', ignore: /(^|\/)\.claude(\/|$)/ });
    expect(d.files.map(f => f.path)).toEqual(['src/add.js']);
    expect(d.ignored).toEqual(['.claude/settings.json']);
    expect(d.summary).toMatchObject({ files: 1, additions: 1, deletions: 1 });
  });

  it('flags a large diff (cut, counts kept) and a huge one (not shown), never silently', () => {
    const r = repo(); const base = head(r);
    fs.writeFileSync(path.join(r, 'big.txt'), Array.from({ length: DIFF_LIMITS.fileLines + 50 }, (_, i) => `line ${i}`).join('\n') + '\n');
    git(r, 'add', 'big.txt'); // tracked, so Git counts it
    fs.writeFileSync(path.join(r, 'huge.txt'), 'x'.repeat(DIFF_LIMITS.fileBytes + 10)); // untracked and over the byte cap
    const d = readChangeDiff(r, base, null, { source: 'worker worktree' });
    const big = d.files.find(f => f.path === 'big.txt')!;
    expect(big).toMatchObject({ truncated: true, additions: DIFF_LIMITS.fileLines + 50 });
    expect(big.patch!.split('\n').length).toBeLessThanOrEqual(DIFF_LIMITS.fileLines);
    expect(big.note).toMatch(/Large diff/);
    const huge = d.files.find(f => f.path === 'huge.txt')!;
    expect(huge).toMatchObject({ patch: null });
    expect(huge.note).toMatch(/too large/);
    expect(d.summary.large).toBe(2);
  });

  it('writes nothing: index, refs, HEAD and working tree are identical afterwards', () => {
    const r = repo(); const base = head(r);
    fs.writeFileSync(path.join(r, 'src', 'add.js'), 'changed\n');
    fs.writeFileSync(path.join(r, 'new.txt'), 'new\n');
    const index = fs.readFileSync(path.join(r, '.git', 'index'));
    const before = checkoutFingerprint(r);
    const refs = git(r, 'for-each-ref').stdout;
    readChangeDiff(r, base, null, { source: 'worker worktree' });
    expect(fs.readFileSync(path.join(r, '.git', 'index')).equals(index)).toBe(true);
    expect(checkoutFingerprint(r)).toEqual(before);
    expect(git(r, 'for-each-ref').stdout).toBe(refs);
  });

  it('an unknown base is reported as unavailable, not as an empty change', () => {
    const r = repo();
    const d = readChangeDiff(r, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', null, { source: 'worker worktree' });
    expect(d).toMatchObject({ available: false, files: [] });
    expect(d.reason).toMatch(/could not compare/);
  });
});

describe('safeChangePath', () => {
  it('accepts paths inside the worktree and refuses traversal, absolute and drive paths', () => {
    const r = repo();
    expect(safeChangePath(r, 'src/add.js')).toBe(true);
    expect(safeChangePath(r, 'src/deleted-file.js')).toBe(true); // a deleted file: its folder is inside
    for (const bad of ['../outside.txt', 'src/../../x', '..\\x', '/etc/passwd', 'C:/Windows/win.ini', 'C:x', 'a\0b', '']) expect(safeChangePath(r, bad)).toBe(false);
  });

  it('refuses a path through a link that leads outside the worktree, and does not read an untracked link', () => {
    const r = repo();
    const outside = path.join(dir, 'secret'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'key.txt'), 'SECRET');
    try { fs.symlinkSync(outside, path.join(r, 'escape'), 'junction'); } catch { return; /* links not allowed here */ }
    expect(safeChangePath(r, 'escape/key.txt')).toBe(false);
    const d = readChangeDiff(r, head(r), null, { source: 'worker worktree' });
    expect(JSON.stringify(d)).not.toMatch(/SECRET/);
  });
});

describe('bridge View diff', () => {
  let db: CoreDatabase; let data: string;
  beforeEach(() => { data = path.join(dir, 'data'); fs.mkdirSync(data); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
  afterEach(() => db.close());

  /** An approved A5 change whose copy sits at `copyAt`. */
  function approved(copyAt: string, finish = true) {
    const owner = repo(path.join(dir, 'owner'));
    git(dir, 'clone', '-q', owner, copyAt); git(copyAt, 'remote', 'remove', 'origin');
    git(copyAt, 'checkout', '-q', '-b', 'panda/change-x');
    fs.writeFileSync(path.join(copyAt, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n'); git(copyAt, 'commit', '-qam', 'fix'); git(copyAt, 'checkout', '-q', 'main');
    const fp = checkoutFingerprint(owner)!;
    const p = planDevStories(db, { projectName: 'Panda bridge', repoPath: copyAt, baseBranch: 'main', integrationBranch: 'panda/change-x', verify: ['git', 'status', '--porcelain'],
      stories: [{ key: 't', title: 'Change Calc', agent: 'claude', maxFiles: 20, codeCopy: { projectName: 'Calc', sourcePath: owner, ref: 'main', sourceHead: fp.head, sourceStatusSha: fp.statusSha } }] });
    const storyId = p.stories[0]!.id;
    if (finish) for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing', 'review', 'validation', 'delivery_approval', 'merge_queue', 'done'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
    const pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'ChatGPT' }).pairing;
    const t = submitBridgeTask(db, pairing, { clientRequestId: 'req-diff-00001', instruction: 'Fix add in Calc', sourceRef: { kind: 'chatgpt' } }).task;
    attachBridgeExecution(db, t.id, { projectId: p.projectId, storyId, workspacePath: copyAt });
    recordBridgeStatus(db, t.id, 'completed', 'Finished and verified.', { verification: 'human-reviewed', evidence: null, changedFiles: ['src/add.js'], commit: null, pendingApprovals: [],
      activity: [
        { id: 'e1', at: '2026-11-21T16:00:00.000Z', kind: 'tool_execute', status: 'complete', text: 'npm test' },
        { id: 'e2', at: '2026-11-21T16:00:01.000Z', kind: 'message', text: 'Tests run: npm test: 1 test, 1 pass, 0 fail.' },
      ],
      timeline: [{ at: '2026-11-21T16:00:41.000Z', event: 'integrated', text: 'd0144e4 on panda/change-x; level=worker-only (human-reviewed)' }] });
    const rt: BridgeRuntime = { db, kandev: {} as KandevClient, dataDir: data, executor: undefined };
    return { rt, taskId: t.id, storyId };
  }

  it('shows the approved change from the private copy, with the tests and who ran them', async () => {
    const { rt, taskId } = approved(path.join(data, 'panda-workspaces', 'ptask-code'));
    const r = await bridgeChangeDiff(rt, taskId);
    expect(r.diff).toMatchObject({ available: true, source: 'private copy', summary: { files: 1, additions: 1, deletions: 1 } });
    expect(r.diff.files[0]).toMatchObject({ path: 'src/add.js', status: 'modified' });
    expect(r.tests.worker).toEqual([{ command: 'npm test', status: 'complete', at: '2026-11-21T16:00:00.000Z' }]);
    expect(r.tests.workerSummary).toMatch(/1 pass, 0 fail/);
    expect(r.tests.pandesh).toMatchObject({ level: 'human-reviewed' });
  });

  it('reads nothing from a repository that is not a Pandesh private copy', async () => {
    const { rt, taskId } = approved(path.join(dir, 'elsewhere'));
    const r = await bridgeChangeDiff(rt, taskId);
    expect(r.diff).toMatchObject({ available: false, files: [] });
    expect(r.diff.reason).toMatch(/not in a Pandesh private copy/);
  });

  it('before approval, a worker worktree that is not one of Kandev\'s is refused', async () => {
    const { storyId } = approved(path.join(data, 'panda-workspaces', 'ptask-code'), false); // not integrated: the diff comes from the worker
    const fake = { defaultWorkspaceId: async () => 'w', taskByExternalId: async () => ({ id: 'kt', external_id: storyId }), sessions: async () => [{ id: 's', state: 'COMPLETED', worktree_path: path.join(dir, 'owner') }] } as unknown as KandevClient;
    const d = await devStoryChangeDiff(db, fake, storyId);
    expect(d).toMatchObject({ available: false, files: [] });
    expect(d.reason).toMatch(/not one of Kandev's task worktrees/);
  });
});
