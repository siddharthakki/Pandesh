/**
 * Regression suite for the A5 coding dispatch failure of 2026-11-22 (ptask_c00d7741…): a ChatGPT coding request for a registered
 * read-write project ran as a read-only inspection, changed nothing, and was reported "Finished and verified".
 *
 * Covers: intent classification and authorization at dispatch, Pandesh's own before/after test run, the owner's review (approve and
 * deny), the owner's checkout never being written, no push/merge, and the status/outcome a requester (MCP) is told.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { attachBridgeExecution, createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask, toBridgeTaskView, type BridgePairing } from '../domain/pandaBridge';
import { registerProject } from '../domain/projectRegistry';
import { listPendingApprovals } from '../domain/bridgeApprovals';
import { getStory, listComments, transitionStory } from '../domain/stories';
import { approveBridgeChange, dispatchBridgeTask, outcomeOf, rejectBridgeChange, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { checkoutFingerprint, DEV_ACTOR, devSpec, planDevStories, TESTS_TAG, verifyAndIntegrate } from '../runtime/kandev/devStories';
import { compareTestRuns, judgeTests, parseTap, runProjectTests } from '../runtime/kandev/projectTests';
import type { KandevClient } from '../runtime/kandev/kandevClient';

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

/** The live instruction, pointed at this test's Calc project. */
const LIVE = (p: string) => `In the REGISTERED Calc source code project (${p}), implement a small divide(a,b) function in its own module with tests for normal division and explicit division-by-zero error, preserving existing add/multiply features. This is an isolated development CODING task. Resolve the named registered Calc project, and FAIL CLOSED if it cannot be found; never use an empty starter repo or any other project. Use the authorized isolated private copy/worktree; do not edit the owner checkout, push, merge, deploy or install. Run focused tests and provide a real diff for review. Require the standard owner approval before Claude Code receives any task details, and the owner-only review approval before delivering changes.`;

let dir: string; let data: string; let db: CoreDatabase; let pairing: BridgePairing; let rt: BridgeRuntime; let rw: string; let ro: string;
const prevHome = process.env.KARKEDIKHA_KANDEV_HOME;
const kandev = {
  healthy: async () => true, reprobeAgent: async () => null,
  tool: async (name: string) => (name === 'list_agents_kandev' ? { agents: [{ id: 'a1', name: 'claude-acp', capability_status: 'ok', profiles: [{ id: 'p', model: 'sonnet', auto_approve: false }] }] } : {}),
} as unknown as KandevClient;

beforeAll(() => { /* integration worktrees go under the test folder, never ~/.kkd-kandev */ });
afterAll(() => { if (prevHome === undefined) delete process.env.KARKEDIKHA_KANDEV_HOME; else process.env.KARKEDIKHA_KANDEV_HOME = prevHome; });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5d-')); data = path.join(dir, 'data'); fs.mkdirSync(data);
  process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'kandev-home');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'ChatGPT' }).pairing;
  rt = { db, kandev, dataDir: data, executor: undefined };
  // The CalcDemo shape: add() is broken and its test fails BEFORE any change; there is no multiply().
  const mk = (n: string) => {
    const p = path.join(dir, n); fs.mkdirSync(path.join(p, 'src'), { recursive: true }); fs.mkdirSync(path.join(p, 'test'));
    git(p, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: n.toLowerCase(), private: true, type: 'module', scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(p, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n');
    fs.writeFileSync(path.join(p, 'test', 'add.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add', () => { assert.equal(add(2, 3), 5); });\n");
    fs.writeFileSync(path.join(p, 'README.md'), `# ${n}\n`);
    git(p, 'add', '-A'); git(p, 'commit', '-q', '-m', 'init'); return p;
  };
  rw = mk('Calc'); ro = mk('Ledger');
  registerProject(data, { name: 'Calc', path: rw, access: 'read-write', authorizedBy: 'owner' });
  registerProject(data, { name: 'Ledger', path: ro, access: 'read', authorizedBy: 'owner' });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const submit = (text: string, id: string, intent?: string) => submitBridgeTask(db, pairing, { clientRequestId: id, instruction: text, sourceRef: { kind: 'chatgpt' }, ...(intent ? { intent } : {}) }).task;
const askAsChatGPT = (taskId: string) => dispatchBridgeTask(rt, taskId, { executor: 'claude', decidedBy: 'extension:x', authority: 'extension' }) as Promise<{ started: boolean; approval?: { accessLevel: string; exposure: string[]; project: { name: string; access: string } | null } }>;

describe('dispatch: intent and authorization', () => {
  it('1. a ChatGPT coding task for a read-write project asks the owner for a CODE CHANGE (the live failure)', async () => {
    const t = submit(LIVE(rw), 'req-d-live-0001');
    const r = await askAsChatGPT(t.id);
    expect(r.started).toBe(false);
    expect(r.approval!.project).toMatchObject({ name: 'Calc', access: 'read-write' });
    expect(r.approval!.accessLevel).toMatch(/^Code change in an isolated worktree of a private copy/);
    expect(r.approval!.exposure.join(' ')).toMatch(/reads this task as a code change/);
    expect(r.approval!.exposure.join(' ')).toMatch(/runs the project's tests before and after/);
  });

  it('2. without the owner nothing starts: a paired client only gets a card; an unregistered path is refused', async () => {
    const t = submit(LIVE(rw), 'req-d-noauth-01');
    await askAsChatGPT(t.id);
    expect(getBridgeTask(db, t.id)).toMatchObject({ executor: null, storyId: null, status: 'awaiting_executor' });
    expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false);
    // A host dispatch of an external agent without consent is refused outright.
    await expect(dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'owner', authority: 'host' })).rejects.toThrow(/Nothing was sent/);
    const other = path.join(dir, 'NotRegistered'); fs.mkdirSync(other); git(other, 'init', '-q');
    const u = submit(`Implement divide(a, b) with tests in ${other}`, 'req-d-noauth-02');
    await expect(askAsChatGPT(u.id)).rejects.toThrow();
    expect(listPendingApprovals(db).map(a => a.taskId)).not.toContain(u.id);
  });

  it('3. a coding request for a read-only project is a permission failure, not an inspection', async () => {
    const t = submit(`Implement divide(a, b) with tests in the Ledger source code at ${ro}`, 'req-d-ro-00001');
    await expect(askAsChatGPT(t.id)).rejects.toThrow(/authorized read-only/);
    expect(getBridgeTask(db, t.id)).toMatchObject({ status: 'failed', storyId: null });
    expect(getBridgeTask(db, t.id).statusDetail).toMatch(/^Not permitted: .*read this task as a code change/);
    expect(listPendingApprovals(db)).toEqual([]);
  });

  it('4. a code change naming no project, or an ambiguous one, asks which; nothing runs anywhere else', async () => {
    const t = submit('Implement divide(a, b) with tests for division by zero.', 'req-d-none-001', 'code_change');
    await expect(askAsChatGPT(t.id)).rejects.toThrow(/names no registered project/);
    expect(getBridgeTask(db, t.id)).toMatchObject({ status: 'awaiting_executor', storyId: null });
    const a = submit('Implement divide(a, b) in the Calc source and in the Ledger source.', 'req-d-amb-0001');
    await expect(askAsChatGPT(a.id)).rejects.toThrow();
    expect(getBridgeTask(db, a.id).storyId).toBeNull();
  });

  it('5. explicit coding intent is never downgraded; a contradiction asks instead of inspecting', async () => {
    // Declared code change with soft wording: still a change.
    const d = submit(`Calc at ${rw}: divide(a, b) please, plus tests.`, 'req-d-decl-001', 'code_change');
    expect((await askAsChatGPT(d.id)).approval!.accessLevel).toMatch(/^Code change/);
    // Declared inspection narrows a change request to read-only.
    const n = submit(`Fix the bug in add() in the Calc source at ${rw}`, 'req-d-decl-002', 'inspect');
    expect((await askAsChatGPT(n.id)).approval!.accessLevel).toMatch(/^Read-only inspection/);
    // Change + read-only: the requester must choose; no card, no inspection.
    const c = submit(`Implement divide(a, b) with tests in the Calc source at ${rw}. This is read-only.`, 'req-d-conf-001');
    await expect(askAsChatGPT(c.id)).rejects.toThrow(/Say which one you want/);
    expect(listPendingApprovals(db).map(a => a.taskId)).not.toContain(c.id);
    // An unknown declared kind is refused, never guessed.
    expect(() => submit('anything', 'req-d-bad-0001', 'deploy-it')).toThrow(/unknown intent/);
  });
});

describe('verification, review and reporting', () => {
  /** A dispatched A5 task: private copy (no remote), story in `implementing`, a worker worktree. */
  function started(instruction = LIVE(rw)) {
    const copy = path.join(data, 'panda-workspaces', 'copy');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    git(dir, 'clone', '-q', rw, copy); git(copy, 'remote', 'remove', 'origin');
    const fp = checkoutFingerprint(rw)!;
    const p = planDevStories(db, { projectName: 'Panda bridge', repoPath: copy, baseBranch: 'main', integrationBranch: 'panda/change-x', verify: ['git', 'status', '--porcelain'],
      stories: [{ key: 't', title: 'Change Calc', agent: 'claude', maxFiles: 20, codeCopy: { projectName: 'Calc', sourcePath: rw, ref: 'main', sourceHead: fp.head, sourceStatusSha: fp.statusSha, testsRequested: true } }] });
    const storyId = p.stories[0]!.id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
    const t = submit(instruction, `req-v-${Math.random().toString(36).slice(2, 12)}`);
    attachBridgeExecution(db, t.id, { projectId: p.projectId, storyId, workspacePath: copy });
    // As at dispatch: the integration branch exists in the copy, and the worker branches from it.
    git(copy, 'branch', 'panda/change-x', 'main');
    const wt = path.join(dir, 'wt'); git(copy, 'worktree', 'add', '-q', '-b', 'feature/w', wt, 'panda/change-x');
    return { copy, storyId, taskId: t.id, wt, before: fp };
  }
  const k = (said: string[] = []) => ({
    agentMessages: async () => said.map((text, i) => ({ kind: 'message', text, at: `2026-11-22T10:00:0${i}Z` })),
    sendMessage: async () => undefined, stopTask: async () => undefined, setTaskState: async () => undefined,
    taskByExternalId: async () => null,
  }) as unknown as KandevClient;
  const writeDivide = (wt: string, testBody = 'assert.equal(divide(6, 3), 2);') => {
    fs.writeFileSync(path.join(wt, 'src', 'divide.js'), "export function divide(a, b) {\n  if (b === 0) throw new RangeError('division by zero');\n  return a / b;\n}\n");
    fs.writeFileSync(path.join(wt, 'test', 'divide.test.js'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { divide } from '../src/divide.js';\ntest('divides', () => { ${testBody} });\ntest('division by zero throws', () => { assert.throws(() => divide(1, 0), RangeError); });\n`);
  };
  const outcome = (taskId: string, storyId: string) => outcomeOf(db, getBridgeTask(db, taskId), getStory(db, storyId).status, devSpec(getStory(db, storyId))!, ['src/divide.js', 'test/divide.test.js']);

  it('6. a worker that changes nothing is a failed outcome with its own words, never completed', async () => {
    const { storyId, taskId } = started();
    const why = 'I could not implement divide because the task text was ambiguous about the module name, so I changed nothing at all.';
    await verifyAndIntegrate(db, k([why]), getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', path.join(dir, 'wt'), 'ks');
    expect(getStory(db, storyId).status).toBe('blocked');
    const o = outcome(taskId, storyId);
    expect(o).toMatchObject({ intent: 'code', state: 'worker_failed' });
    expect(o.summary).toMatch(/made no changes and explained why: I could not implement divide/);
    expect(o.summary).toMatch(/requested change was not made/);
    expect(o.workerExplanation).toMatch(/ambiguous about the module name/);
  });

  it('7. a test that already failed before the change is reported, not hidden, and not blamed on the change', async () => {
    const { storyId, taskId, wt } = started();
    writeDivide(wt);
    await verifyAndIntegrate(db, k(), getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    expect(getStory(db, storyId).status).toBe('delivery_approval'); // held for the owner, never auto-integrated
    const tests = JSON.parse(listComments(db, storyId).reverse().find(c => c.body.startsWith(TESTS_TAG))!.body.slice(TESTS_TAG.length));
    expect(tests).toMatchObject({ perTest: true, regressions: [], newFailing: [], preExistingFailing: ['add'] });
    expect(tests.newPassing.sort()).toEqual(['divides', 'division by zero throws']);
    const o = outcome(taskId, storyId);
    expect(o.state).toBe('awaiting_owner_review');
    expect(o.summary).toMatch(/1 test\(s\) were already failing before the change and still fail \(not caused by it\): add/);
    expect(o.summary).not.toMatch(/verified/i);
  });

  it('7b. a new failing test, a regression, or no new test when tests were asked for: sent back, not accepted', async () => {
    const { storyId, wt } = started();
    writeDivide(wt, 'assert.equal(divide(6, 3), 3);'); // a wrong test the worker wrote
    await verifyAndIntegrate(db, k(), getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    expect(getStory(db, storyId).status).toBe('implementing');
    expect(listComments(db, storyId).map(c => c.body).join('\n')).toMatch(/Pandesh's own test run: 1 new test\(s\) fail: divides/);
    // only a source change, no test, though the task asked for tests
    fs.rmSync(path.join(wt, 'test', 'divide.test.js'));
    await verifyAndIntegrate(db, k(), getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    expect(listComments(db, storyId).map(c => c.body).join('\n')).toMatch(/asked for tests, but no new test was added/);
  });

  it('8 + 9 + 10 + 11. correct change and passing tests → owner approval → committed in the private copy only; owner checkout untouched; nothing pushed', async () => {
    const { storyId, taskId, wt, copy, before } = started();
    writeDivide(wt);
    await verifyAndIntegrate(db, k(), getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    expect(getStory(db, storyId).status).toBe('delivery_approval');
    expect(git(copy, 'rev-parse', 'panda/change-x').stdout.trim()).toBe(before.head); // nothing committed before approval
    // The owner approves (the same path the approve-change route takes after review).
    await verifyAndIntegrate(db, k(), getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks', true);
    expect(getStory(db, storyId).status).toBe('done');
    expect(git(copy, 'show', 'panda/change-x:src/divide.js').stdout).toMatch(/division by zero/);
    const o = outcome(taskId, storyId);
    expect(o.state).toBe('outcome_completed');
    expect(o.summary).toMatch(/approved by you and committed to panda\/change-x in Pandesh's private copy; nothing was pushed, merged or installed/);
    expect(o.tests).toMatchObject({ regressions: [], preExistingFailing: ['add'] });
    // 10: the owner's checkout is exactly as it was: same HEAD, same working tree, no new branch.
    expect(checkoutFingerprint(rw)).toEqual(before);
    expect(git(rw, 'branch', '--list').stdout.trim()).toBe('* main');
    expect(fs.existsSync(path.join(rw, 'src', 'divide.js'))).toBe(false);
    // 11: the copy has no remote, so nothing can be pushed; main in the copy is unchanged (no merge to main).
    expect(git(copy, 'remote').stdout.trim()).toBe('');
    expect(git(copy, 'rev-parse', 'main').stdout.trim()).toBe(before.head);
  });

  it('9b. the owner does not approve: nothing is committed or delivered, and the task says so', async () => {
    const { storyId, taskId, wt, copy, before } = started();
    writeDivide(wt);
    await verifyAndIntegrate(db, k(), getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    const task = await rejectBridgeChange({ ...rt, kandev: k() }, taskId, 'Pandesh');
    expect(task.status).toBe('cancelled');
    expect(task.result?.outcome).toMatchObject({ state: 'review_denied' });
    expect(task.statusDetail).toMatch(/did not approve the change to Calc. Nothing was committed, merged, pushed or delivered/);
    expect(git(copy, 'rev-parse', 'panda/change-x').stdout.trim()).toBe(before.head); // nothing committed
    expect(checkoutFingerprint(rw)).toEqual(before);
    await expect(rejectBridgeChange({ ...rt, kandev: k() }, taskId, 'Pandesh')).rejects.toThrow(/no change waiting for your review/);
    await expect(approveBridgeChange({ ...rt, kandev: k() }, taskId, 'Pandesh')).rejects.toThrow(/was not approved or the task was cancelled/);
  });

  it('12. what a requester is told: the outcome, not "Finished and verified"', async () => {
    const { storyId, taskId, wt } = started();
    writeDivide(wt);
    await verifyAndIntegrate(db, k(), getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    const view = toBridgeTaskView({ ...getBridgeTask(db, taskId), result: { verification: 'worker-only', evidence: null, changedFiles: [], commit: null, pendingApprovals: [], activity: [], timeline: [], outcome: outcome(taskId, storyId) } });
    expect(view.result?.outcome).toMatchObject({ intent: 'code', state: 'awaiting_owner_review', tests: { newPassing: expect.arrayContaining(['divides']), preExistingFailing: ['add'] } });
    // An inspection that finishes is reported as the worker's own report, never as a verified or completed change.
    const insp = outcomeOf(db, getBridgeTask(db, taskId), 'done', { kind: 'kkd-dev-story', repoPath: '.', baseBranch: 'main', integrationBranch: 'x', verify: [], agent: 'claude', mode: 'inspect', inspect: { projectName: 'Calc', sourcePath: rw, ref: 'main', sourceHead: '', sourceStatusSha: '' } }, []);
    expect(insp).toMatchObject({ intent: 'inspect', state: 'worker_finished' });
    expect(insp.summary).toMatch(/worker's own report.*No code was changed/);
  });
});

describe('project tests (base vs change)', () => {
  it('parses node TAP per test and compares base vs after', () => {
    const tap = 'TAP version 13\n# Subtest: add\nnot ok 1 - add\n# Subtest: suite\n    # Subtest: inner\n    ok 1 - inner\nok 2 - suite\n';
    expect(parseTap(tap)).toEqual({ add: 'fail', 'suite > inner': 'pass', suite: 'pass' });
    const base = { command: 'node --test', ran: true, ok: false, tests: { add: 'fail' as const, keep: 'pass' as const }, passed: 1, failed: 1, output: '', note: null };
    const after = { ...base, tests: { add: 'fail' as const, keep: 'fail' as const, divides: 'pass' as const }, passed: 1, failed: 2 };
    const c = compareTestRuns(base, after);
    expect(c).toMatchObject({ regressions: ['keep'], newPassing: ['divides'], preExistingFailing: ['add'] });
    expect(judgeTests(c, true)).toMatchObject({ ok: false, what: expect.stringMatching(/passed before the change now fail: keep/) });
  });

  it('a project without a test command is reported as such', () => {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), 'a5t-'));
    try {
      expect(runProjectTests(p)).toMatchObject({ ran: false, note: expect.stringMatching(/declares no test command/) });
    } finally { fs.rmSync(p, { recursive: true, force: true }); }
  });
});
