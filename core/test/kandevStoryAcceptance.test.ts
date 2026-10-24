import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { examineDiff, runAcceptance, validateAcceptanceChecks, type AcceptanceCheck } from '../runtime/kandev/storyAcceptance';

let dir: string;
let savedHome: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-accept-'));
  savedHome = process.env.KARKEDIKHA_KANDEV_HOME;
  process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'kandev-home');
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KARKEDIKHA_KANDEV_HOME; else process.env.KARKEDIKHA_KANDEV_HOME = savedHome;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* a git worktree may still be locked on Windows; the OS temp cleaner takes it */ }
});

// Independently prepared examples: written from the criteria ("count whitespace-separated words"), not from any implementation.
const WORD_COUNT: AcceptanceCheck = {
  kind: 'examples', name: 'word count', module: 'src/wordCount.js', export: 'wordCount',
  cases: [
    { name: 'plain', args: ['one two three'], expected: 3 },
    { name: 'repeated spaces', args: ['one   two'], expected: 2 },
    { name: 'tabs', args: ['a\tb\tc'], expected: 3 },
    { name: 'newlines', args: ['a\nb\r\nc'], expected: 3 },
    { name: 'empty', args: [''], expected: 0 },
    { name: 'only whitespace', args: ['  \t\n '], expected: 0 },
    { name: 'leading and trailing space', args: ['  hi there  '], expected: 2 },
    { name: 'punctuation stays attached', args: ['Hello, world! Again.'], expected: 3 },
  ],
};

function project(source: string): string {
  const root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'wordCount.js'), source);
  return root;
}

describe('independent acceptance checks', () => {
  it('catches a split(/\\s/) word count that passes its own simple test', () => {
    const wrong = project("exports.wordCount = (s) => s.split(/\\s/).length;\n");
    const res = runAcceptance('story-1', [WORD_COUNT], wrong);
    expect(res.ok).toBe(false);
    expect(res.passed).toBeLessThan(res.total);
    // concrete evidence: which input, what was expected, what came back
    expect(res.evidence).toMatch(/repeated spaces: wordCount\("one {3}two"\) — expected 2 but got 4/);
    expect(res.evidence).toMatch(/empty: wordCount\(""\) — expected 0 but got 1/);
    expect(res.evidence).toMatch(/✓|✗/);
  });

  it('accepts a correct implementation, in CommonJS and as an ES module', () => {
    const cjs = project("module.exports = { wordCount: (s) => (s.trim() ? s.trim().split(/\\s+/).length : 0) };\n");
    expect(runAcceptance('story-2', [WORD_COUNT], cjs)).toMatchObject({ ok: true, passed: 8, total: 8 });
    fs.writeFileSync(path.join(cjs, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(cjs, 'src', 'wordCount.js'), "export const wordCount = (s) => (s.trim() ? s.trim().split(/\\s+/).length : 0);\n");
    expect(runAcceptance('story-2', [WORD_COUNT], cjs).ok).toBe(true);
  });

  it('reports a missing module or export instead of passing', () => {
    const root = project('exports.other = () => 1;\n');
    expect(runAcceptance('story-3', [WORD_COUNT], root)).toMatchObject({ ok: false });
    expect(runAcceptance('story-3', [{ ...WORD_COUNT, module: 'src/nope.js' }], root).evidence).toMatch(/cannot be loaded/);
    expect(runAcceptance('story-3', [WORD_COUNT], root).evidence).toMatch(/no function named wordCount/);
  });

  it('does not let the worker replace the check: it lives outside the worktree and a same-named file changes nothing', () => {
    const root = project("exports.wordCount = (s) => s.split(/\\s/).length;\n");
    // A worker "adding its own acceptance test" under the same names is just another file in its tree.
    fs.writeFileSync(path.join(root, 'run-examples.mjs'), 'process.exit(0)');
    fs.mkdirSync(path.join(root, 'kkd-acceptance'), { recursive: true });
    expect(runAcceptance('story-4', [WORD_COUNT], root).ok).toBe(false);
    expect(fs.existsSync(path.join(process.env.KARKEDIKHA_KANDEV_HOME!, 'kkd-acceptance', 'story-4', 'run-examples.mjs'))).toBe(true);
    expect(path.relative(root, process.env.KARKEDIKHA_KANDEV_HOME!).startsWith('..')).toBe(true);
  });

  it('runs a trusted script check with the tree as KKD_ACCEPT_ROOT and gives it no KKD secrets', () => {
    const root = project('exports.wordCount = () => 1;\n');
    process.env.KKD_TEST_SECRET = 'leak-me';
    try {
      const script: AcceptanceCheck = { kind: 'script', name: 'env', source: "import fs from 'node:fs';\nif (process.env.KKD_TEST_SECRET) { console.error('leaked'); process.exit(2); }\nif (!fs.existsSync(process.env.KKD_ACCEPT_ROOT + '/src/wordCount.js')) process.exit(3);\n" };
      expect(runAcceptance('story-5', [script], root).ok).toBe(true);
      expect(runAcceptance('story-5', [{ kind: 'script', name: 'fails', source: 'console.error("boom"); process.exit(1);' }], root)).toMatchObject({ ok: false });
    } finally { delete process.env.KKD_TEST_SECRET; }
  });

  it('validates checks at planning time', () => {
    expect(() => validateAcceptanceChecks('k', 'nope')).toThrow(/must be a list/);
    expect(() => validateAcceptanceChecks('k', [{ kind: 'examples', module: '../x.js', cases: [{ args: [], expected: 1 }] }])).toThrow(/relative to the repository/);
    expect(() => validateAcceptanceChecks('k', [{ kind: 'examples', module: 'C:\\x.js', cases: [{ args: [], expected: 1 }] }])).toThrow(/relative/);
    expect(() => validateAcceptanceChecks('k', [{ kind: 'examples', module: 'a.js', cases: [] }])).toThrow(/cases are required/);
    expect(() => validateAcceptanceChecks('k', [{ kind: 'examples', module: 'a.js', cases: [{ args: 1, expected: 1 }] }])).toThrow(/args/);
    expect(() => validateAcceptanceChecks('k', [{ kind: 'weird' }])).toThrow(/kind must be/);
    expect(validateAcceptanceChecks('k', undefined)).toEqual([]);
    expect(validateAcceptanceChecks('k', [WORD_COUNT])).toHaveLength(1);
  });
});

describe('diff examination', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  function repo(): string {
    const root = path.join(dir, 'repo');
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    git(root, 'init', '-q', '-b', 'kkd/integration');
    fs.writeFileSync(path.join(root, 'src.js'), 'exports.f = () => 1;\n');
    fs.writeFileSync(path.join(root, 'test', 'f.test.js'), "const assert = require('assert');\nassert.strictEqual(f(1), 1);\nassert.strictEqual(f(2), 2);\n");
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'worker');
    return root;
  }

  it('flags deleted tests and skipped tests as violations', () => {
    const root = repo();
    fs.rmSync(path.join(root, 'test', 'f.test.js'));
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'new.test.js'), "it.skip('x', () => {});\n");
    git(root, 'add', '-A');
    const found = examineDiff(root, 'kkd/integration');
    expect(found.violations.join('\n')).toMatch(/deleted test file test\/f\.test\.js/);
    expect(found.violations.join('\n')).toMatch(/skips or focuses tests/);
  });

  it('requires human review (but does not fail) when an existing test loses assertions', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'test', 'f.test.js'), "const assert = require('assert');\nassert.strictEqual(f(1), 1);\n");
    const found = examineDiff(root, 'kkd/integration');
    expect(found.violations).toEqual([]);
    expect(found.reviewReasons.join('\n')).toMatch(/lost 1 assertion/);
  });

  it('is quiet for an ordinary change that adds code and tests', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'src.js'), 'exports.f = (x) => x;\n');
    fs.appendFileSync(path.join(root, 'test', 'f.test.js'), "assert.strictEqual(f(3), 3);\n");
    expect(examineDiff(root, 'kkd/integration')).toEqual({ violations: [], reviewReasons: [] });
  });
});

describe('verification lifecycle (real git, fake Kandev)', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

  async function setup(acceptance: boolean) {
    const { openCoreDatabase } = await import('../db/openCore');
    const { planDevStories } = await import('../runtime/kandev/devStories');
    const db = openCoreDatabase(path.join(dir, 'core.db')).db;
    const repo = path.join(dir, 'app');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'src', 'wordCount.js'), 'exports.wordCount = () => 0;\n');
    fs.writeFileSync(path.join(repo, 'check.js'), 'process.exit(0);\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
    const planned = planDevStories(db, {
      projectName: 'P', repoPath: repo, verify: ['node', 'check.js'],
      stories: [
        { key: 'wc', title: 'Word count', agent: 'claude', paths: ['src/'], ...(acceptance ? { acceptanceChecks: [WORD_COUNT] } : {}) },
        { key: 'next', title: 'Uses word count', agent: 'claude', dependsOn: ['wc'] },
      ],
    });
    const sent: string[] = [];
    const states: string[] = [];
    const kandev = {
      sendMessage: async (_t: string, _s: string, text: string) => { sent.push(text); },
      stopTask: async () => {}, setTaskState: async (_t: string, s: string) => { states.push(s); },
    } as any;
    // The worker's worktree, branched from the integration branch exactly as dispatch does.
    git(repo, 'branch', 'kkd/integration', 'main');
    const worktree = path.join(dir, 'worker-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'worker/wc', worktree, 'kkd/integration');
    return { db, repo, planned, kandev, sent, states, worktree };
  }

  const wrong = "exports.wordCount = (s) => s.split(/\\s/).length;\n";
  const right = "exports.wordCount = (s) => (s.trim() ? s.trim().split(/\\s+/).length : 0);\n";

  it('sends a wrong-but-self-tested implementation back with evidence, keeps the dependent locked, then integrates the repair', async () => {
    const { verifyAndIntegrate, devSpec } = await import('../runtime/kandev/devStories');
    const { getStory, transitionStory, listComments } = await import('../domain/stories') as any;
    const t = await setup(true);
    const wcId = t.planned.stories[0].id, nextId = t.planned.stories[1].id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing']) transitionStory(t.db, wcId, { toStatus: to, actor: 'kkd', reason: 't' });
    fs.writeFileSync(path.join(t.worktree, 'src', 'wordCount.js'), wrong);
    const run = () => verifyAndIntegrate(t.db, t.kandev, getStory(t.db, wcId), devSpec(getStory(t.db, wcId))!, 'task-1', t.worktree, 'sess-1');

    await run();
    expect(getStory(t.db, wcId).status).toBe('implementing');                 // sent back, not accepted
    expect(getStory(t.db, nextId).status).not.toBe('done');                   // dependent stays locked
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatch(/independent acceptance check failed/);
    expect(t.sent[0]).toMatch(/repeated spaces: wordCount\("one {3}two"\) — expected 2 but got 4/);
    expect(t.states).not.toContain('COMPLETED');
    expect(git(t.repo, 'log', '--oneline', 'kkd/integration').stdout.trim().split('\n')).toHaveLength(1); // nothing merged

    fs.writeFileSync(path.join(t.worktree, 'src', 'wordCount.js'), right);   // the worker's repair
    await run();
    const done = getStory(t.db, wcId);
    expect(done.status).toBe('done');
    const bodies = listComments(t.db, wcId).map((c: any) => c.body).join('\n');
    expect(bodies).toMatch(/\[kkd-dev:verified\] level=independent;.*independent acceptance 8\/8/);
    expect(bodies).toMatch(/\[kkd-dev:integrated\].*level=independent/);
    expect(t.states).toContain('COMPLETED');
    const integrationRoot = path.join(process.env.KARKEDIKHA_KANDEV_HOME!, 'kkd-integration');
    const integrationDir = fs.readdirSync(integrationRoot).find(n => /^app-[0-9a-f]{8}$/.test(n)); // keyed by repo path, not just the name
    expect(integrationDir).toBeTruthy();
    expect(fs.readFileSync(path.join(integrationRoot, integrationDir!, 'src', 'wordCount.js'), 'utf8').split('\r\n').join('\n')).toBe(right);
    t.db.close();
  });

  it('holds a story with no independent check for human review, locks dependents, and integrates only after approval', async () => {
    const { verifyAndIntegrate, devSpec } = await import('../runtime/kandev/devStories');
    const { getStory, transitionStory, listComments } = await import('../domain/stories') as any;
    const t = await setup(false);
    const wcId = t.planned.stories[0].id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing']) transitionStory(t.db, wcId, { toStatus: to, actor: 'kkd', reason: 't' });
    fs.writeFileSync(path.join(t.worktree, 'src', 'wordCount.js'), right);

    await verifyAndIntegrate(t.db, t.kandev, getStory(t.db, wcId), devSpec(getStory(t.db, wcId))!, 'task-1', t.worktree, 'sess-1');
    expect(getStory(t.db, wcId).status).toBe('delivery_approval');            // "worker completed", not "verified"
    expect(t.states).not.toContain('COMPLETED');
    expect(listComments(t.db, wcId).map((c: any) => c.body).join('\n')).toMatch(/\[kkd-dev:awaiting-review\] Worker completed and its own tests pass, but KKD has no independent acceptance check/);

    await verifyAndIntegrate(t.db, t.kandev, getStory(t.db, wcId), devSpec(getStory(t.db, wcId))!, 'task-1', t.worktree, 'sess-1', true);
    expect(getStory(t.db, wcId).status).toBe('done');
    expect(listComments(t.db, wcId).map((c: any) => c.body).join('\n')).toMatch(/\[kkd-dev:integrated\].*level=worker-only \(human-reviewed\)/);
    t.db.close();
  });

  it('verifies the work a cancelled worker left behind without starting a worker: wrong → blocked with the reason, repaired → integrated', async () => {
    const { verifyExistingDevStory } = await import('../runtime/kandev/devStories');
    const { getStory, transitionStory, listComments } = await import('../domain/stories') as any;
    const t = await setup(true);
    const wcId = t.planned.stories[0].id, nextId = t.planned.stories[1].id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing']) transitionStory(t.db, wcId, { toStatus: to, actor: 'kkd', reason: 't' });
    // Kandev keeps task worktrees under its own home; the first session points somewhere else on purpose.
    const taskWorktree = path.join(process.env.KARKEDIKHA_KANDEV_HOME!, 'tasks', 'wc', 'app');
    git(t.repo, 'worktree', 'add', '-q', '-b', 'worker/wc2', taskWorktree, 'kkd/integration');
    fs.writeFileSync(path.join(taskWorktree, 'src', 'wordCount.js'), wrong);

    const session: any = { id: 'sess-1', state: 'WAITING_FOR_INPUT', worktree_path: t.worktree, worktree_branch: 'worker/wc' };
    let agentRunning = true, polls = 0;
    const calls: string[] = [];
    const kandev: any = {
      ...t.kandev,
      ensureRunning: async () => {}, defaultWorkspaceId: async () => 'ws',
      taskByExternalId: async (_w: string, id: string) => ({ id: 'task-1', external_id: id }),
      sessions: async () => [session],
      stopTask: async () => { calls.push('stop'); },
      sessionStatus: async () => ({ is_agent_running: agentRunning && ++polls < 3 }), // the process takes a couple of polls to end
      pendingPermissions: async () => [], resolvePermission: async () => {},
      sendMessage: async () => { calls.push('message'); }, relaunchSession: async () => { calls.push('relaunch'); },
    };
    const bodies = () => listComments(t.db, wcId).map((c: any) => c.body).join('\n');
    const integrationLog = () => git(t.repo, 'log', '--oneline', 'kkd/integration').stdout.trim().split('\n').length;

    // 1. A worktree that is not one of Kandev's task worktrees is refused before anything is checked or merged.
    let r = await verifyExistingDevStory(t.db, kandev, wcId);
    expect(r).toMatchObject({ outcome: 'blocked', status: 'blocked' });
    expect(r.reason).toMatch(/not one of Kandev's task worktrees/);
    expect(calls).toContain('stop');

    // 2. The right worktree, but the preserved work is wrong: KKD's own check rejects it; no worker is contacted.
    session.worktree_path = taskWorktree; session.worktree_branch = 'worker/wc2';
    r = await verifyExistingDevStory(t.db, kandev, wcId);
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toMatch(/independent acceptance check failed/);
    expect(bodies()).toMatch(/\[kkd-dev:reconciled\] worker stopped .*branch worker\/wc2 at [0-9a-f]+, 0 commit\(s\) ahead of kkd\/integration, 1 uncommitted path\(s\), 1 changed file\(s\)/);
    expect(calls).not.toContain('message');
    expect(calls).not.toContain('relaunch');
    expect(integrationLog()).toBe(1);
    expect(getStory(t.db, nextId).status).not.toBe('done');

    // 3. The work is repaired in the preserved worktree; verifying again integrates it through the normal gates.
    fs.writeFileSync(path.join(taskWorktree, 'src', 'wordCount.js'), right);
    r = await verifyExistingDevStory(t.db, kandev, wcId);
    expect(r).toMatchObject({ outcome: 'integrated', status: 'done', reason: null });
    expect(r.commit).toMatch(/^[0-9a-f]+$/);
    expect(bodies()).toMatch(/\[kkd-dev:integrated\].*level=independent \(verified from preserved worker output; worker not restarted\)/);
    expect(t.states).toContain('COMPLETED');
    expect(calls).not.toContain('message');
    expect(integrationLog()).toBeGreaterThan(1);

    // Nothing to verify on a story that is already done.
    await expect(verifyExistingDevStory(t.db, kandev, wcId)).rejects.toThrow(/only an implementing or blocked story/);
    t.db.close();
  }, 60_000);
});

describe('trusted check files and device checks', () => {
  it('loads a script from the trusted-checks folder only, and keeps device steps out of the automated total', async () => {
    const { trustedChecksDir } = await import('../runtime/kandev/storyAcceptance');
    fs.mkdirSync(trustedChecksDir(), { recursive: true });
    const good = path.join(trustedChecksDir(), 'ok.mjs');
    fs.writeFileSync(good, 'process.exit(0);');
    const outside = path.join(dir, 'outside.mjs');
    fs.writeFileSync(outside, 'process.exit(0);');
    const [script, device] = validateAcceptanceChecks('s', [
      { kind: 'script', name: 'from file', sourceFile: good },
      { kind: 'device', name: 'phone', instructions: 'Open the PDF on the phone.' },
    ]);
    expect(script).toMatchObject({ kind: 'script', source: 'process.exit(0);' });
    expect(device).toMatchObject({ kind: 'device' });
    expect(() => validateAcceptanceChecks('s', [{ kind: 'script', name: 'x', sourceFile: outside }])).toThrow(/trusted-checks|sourceFile/);
    expect(() => validateAcceptanceChecks('s', [{ kind: 'script', name: 'x', sourceFile: path.join(trustedChecksDir(), '..', 'outside.mjs') }])).toThrow();
    expect(() => validateAcceptanceChecks('s', [{ kind: 'device', name: 'phone' }])).toThrow(/instructions/);
    const root = project('exports.x = 1;');
    const res = runAcceptance('story-d', [script, device], root);
    expect(res).toMatchObject({ ok: true, total: 1, passed: 1, names: ['from file'] });
    expect(runAcceptance('story-d', [device], root).ok).toBe(false); // a device step alone verifies nothing
  });
});
