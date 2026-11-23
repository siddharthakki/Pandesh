/**
 * A5: owner-approved ChatGPT coding in one isolated worktree of a private copy of a read-write project.
 * docs/strategy/2026-11-21-capability-consolidation/A5_SCOPED_CODING_PROPOSAL.md
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { attachBridgeExecution, createPairingCode, getBridgeTask, recordBridgeStatus, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../domain/pandaBridge';
import { registerProject } from '../domain/projectRegistry';
import { listPendingApprovals } from '../domain/bridgeApprovals';
import { getStory, listComments, transitionStory } from '../domain/stories';
import { accessLevelOf, CODE_CHANGE_MAX_FILES, deliverBridgeChange, dispatchBridgeTask, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { checkoutFingerprint, DEV_ACTOR, devSpec, planDevStories, verifyAndIntegrate } from '../runtime/kandev/devStories';
import type { KandevClient } from '../runtime/kandev/kandevClient';

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

let dir: string; let data: string; let db: CoreDatabase; let pairing: BridgePairing; let rt: BridgeRuntime; let rw: string; let ro: string;
const kandev = {
  healthy: async () => true, reprobeAgent: async () => null, agentBinaryInstalled: () => true,
  tool: async (name: string) => (name === 'list_agents_kandev' ? { agents: [{ id: 'a1', name: 'claude-acp', capability_status: 'ok', profiles: [{ id: 'p', model: 'sonnet', auto_approve: false }] }] } : {}),
} as unknown as KandevClient;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-')); data = path.join(dir, 'data'); fs.mkdirSync(data);
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'ChatGPT' }).pairing;
  rt = { db, kandev, dataDir: data, executor: undefined };
  const mk = (n: string) => {
    const p = path.join(dir, n); fs.mkdirSync(path.join(p, 'src'), { recursive: true }); git(p, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(p, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n'); fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(p, 'README.md'), `# ${n}\n`); // distinct content, so the two repositories have different identities
    fs.mkdirSync(path.join(p, 'node_modules')); fs.writeFileSync(path.join(p, 'node_modules', 'owner-dep.js'), '');
    git(p, 'add', '-A'); git(p, 'commit', '-q', '-m', 'init'); return p;
  };
  rw = mk('Calc'); ro = mk('Ledger');
  registerProject(data, { name: 'Calc', path: rw, access: 'read-write', authorizedBy: 'owner' });
  registerProject(data, { name: 'Ledger', path: ro, access: 'read', authorizedBy: 'owner' });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const submit = (text: string, id: string) => submitBridgeTask(db, pairing, { clientRequestId: id, instruction: text, sourceRef: { kind: 'chatgpt' } }).task;
const FIX = (p: string) => `Fix the bug in the Calc source: add() in src/add.js subtracts. Make it add and keep the tests passing. Project path ${p}`;

describe('A5 gate and approval card', () => {
  it('a change to a read-only project is refused; nothing is asked, copied or started', async () => {
    const t = submit(`Fix the bug in the Ledger source code at ${ro}`, 'req-a5-ro-0001');
    await expect(dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'extension:x', authority: 'extension' })).rejects.toThrow(/authorized read-only/);
    expect(listPendingApprovals(db)).toEqual([]);
    expect(fs.existsSync(path.join(data, 'panda-workspaces', `${t.id}-code`))).toBe(false);
  });

  it('a change to a read-write project asks the owner with the exact scope; the client cannot approve', async () => {
    const t = submit(FIX(rw), 'req-a5-card-001');
    const r = await dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'extension:x', authority: 'extension' }) as { started: boolean; approval: { accessLevel: string; exposure: string[]; project: { name: string; branch: string; access: string } } };
    expect(r.started).toBe(false);
    expect(r.approval.project).toMatchObject({ name: 'Calc', branch: 'main', access: 'read-write' });
    expect(r.approval.accessLevel).toBe(accessLevelOf({ mode: 'code' } as never));
    expect(r.approval.accessLevel).toMatch(new RegExp(`at most ${CODE_CHANGE_MAX_FILES} files.*no push, no merge, no install`));
    expect(r.approval.exposure.join(' ')).toMatch(/reads or writes in a private copy of Calc/);
    expect(r.approval.exposure.join(' ')).toMatch(/nothing is pushed, merged or installed.*as a new branch/);
    expect(getBridgeTask(db, t.id)).toMatchObject({ executor: null, storyId: null });
  });

  it('a question about a read-write project stays an inspection', async () => {
    const t = submit(`Explain how add() in the Calc source at ${rw} works.`, 'req-a5-q-00001');
    const r = await dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'extension:x', authority: 'extension' }) as { approval: { accessLevel: string } };
    expect(r.approval.accessLevel).toMatch(/^Read-only inspection/);
  });

  it('with the owner\'s consent the change runs in a private copy: no remote, no link into the owner\'s folders, owner checkout untouched', async () => {
    const before = checkoutFingerprint(rw);
    const t = submit(FIX(rw), 'req-a5-run-0001');
    await dispatchBridgeTask(rt, t.id, { executor: 'claude', consent: { externalTransfer: true }, decidedBy: 'owner', authority: 'host' }).catch(() => { /* the fake Kandev cannot hand over */ });
    const task = getBridgeTask(db, t.id);
    const spec = devSpec(getStory(db, task.storyId!))!;
    expect(spec).toMatchObject({ maxFiles: CODE_CHANGE_MAX_FILES, codeCopy: { projectName: 'Calc', sourcePath: rw, ref: 'main' } });
    expect(spec.mode).toBeUndefined();
    expect(spec.repoPath).toBe(path.join(data, 'panda-workspaces', `${t.id}-code`));
    expect(git(spec.repoPath, 'remote').stdout.trim()).toBe('');
    expect(fs.existsSync(path.join(spec.repoPath, 'node_modules'))).toBe(false);
    expect(checkoutFingerprint(rw)).toEqual(before);
  });
});

describe('A5 verification and delivery', () => {
  /** A finished A5 task: the copy holds an integration branch with the fix; the story is done and the bridge task completed. */
  function finished() {
    const copy = path.join(dir, 'copy');
    git(dir, 'clone', '-q', rw, copy); git(copy, 'remote', 'remove', 'origin');
    git(copy, 'checkout', '-q', '-b', 'panda/change-x');
    fs.writeFileSync(path.join(copy, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n'); git(copy, 'commit', '-qam', 'fix add'); git(copy, 'checkout', '-q', 'main');
    const fp = checkoutFingerprint(rw)!;
    const p = planDevStories(db, { projectName: 'Panda bridge', repoPath: copy, baseBranch: 'main', integrationBranch: 'panda/change-x', verify: ['git', 'status', '--porcelain'],
      stories: [{ key: 't', title: 'Change Calc', agent: 'claude', maxFiles: 2, codeCopy: { projectName: 'Calc', sourcePath: rw, ref: 'main', sourceHead: fp.head, sourceStatusSha: fp.statusSha } }] });
    const storyId = p.stories[0]!.id;
    const t = submit(FIX(rw), 'req-a5-done-001');
    attachBridgeExecution(db, t.id, { projectId: p.projectId, storyId, workspacePath: copy });
    return { copy, storyId, taskId: t.id };
  }

  it('more changed files than approved fails verification with the list', async () => {
    const { copy, storyId } = finished();
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
    const wt = path.join(dir, 'wt'); git(copy, 'worktree', 'add', '-q', '-b', 'feature/w', wt, 'main');
    for (const f of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(wt, f), 'x');
    const sent: string[] = [];
    const k = { agentMessages: async () => [], sendMessage: async (_t: string, _s: string, x: string) => { sent.push(x); } } as unknown as KandevClient;
    await verifyAndIntegrate(db, k, getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    expect(listComments(db, storyId).map(c => c.body).join('\n')).toMatch(/3 files changed; this change was approved for at most 2/);
  });

  it('delivers the approved change as a NEW branch in the owner\'s checkout without touching its working tree, once', () => {
    const { storyId, taskId } = finished();
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing', 'review', 'validation', 'delivery_approval', 'merge_queue', 'done'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
    recordBridgeStatus(db, taskId, 'completed', 'Finished and verified.', { verification: 'human-reviewed', evidence: null, changedFiles: ['src/add.js'], commit: null, pendingApprovals: [], activity: [], timeline: [] });
    fs.writeFileSync(path.join(rw, 'owner-wip.txt'), 'uncommitted owner work');
    const before = checkoutFingerprint(rw)!;
    const d = deliverBridgeChange(rt, taskId, 'Pandesh');
    expect(d.branch).toBe(`pandesh/chatgpt-${taskId.slice(-12)}`);
    expect(checkoutFingerprint(rw)).toEqual(before); // same HEAD, same working tree (the owner's WIP is untouched)
    expect(git(rw, 'show', `${d.branch}:src/add.js`).stdout).toMatch(/a \+ b/);
    expect(git(rw, 'branch', '--show-current').stdout.trim()).toBe('main');
    expect(git(rw, 'remote').stdout.trim()).toBe('');
    expect(deliverBridgeChange(rt, taskId, 'Pandesh')).toEqual(d); // idempotent
    expect(getBridgeTask(db, taskId).statusDetail).toMatch(/not checked out, not merged, not pushed/);
  });

  it('refuses to deliver before approval, and never overwrites an existing branch', () => {
    const { storyId, taskId } = finished();
    expect(() => deliverBridgeChange(rt, taskId, 'Pandesh')).toThrow(/not approved and integrated yet/);
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing', 'review', 'validation', 'delivery_approval', 'merge_queue', 'done'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
    recordBridgeStatus(db, taskId, 'completed', 'Finished.', { verification: 'human-reviewed', evidence: null, changedFiles: [], commit: null, pendingApprovals: [], activity: [], timeline: [] });
    git(rw, 'branch', `pandesh/chatgpt-${taskId.slice(-12)}`);
    expect(() => deliverBridgeChange(rt, taskId, 'Pandesh')).toThrow(/already has a branch/);
  });
});
