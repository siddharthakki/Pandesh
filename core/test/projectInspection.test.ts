import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../domain/pandaBridge';
import { registerProject, loadProjects } from '../domain/projectRegistry';
import { dispatchBridgeTask, prepareProjectInspection, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { checkoutFingerprint, devSpec, planDevStories, permissionDecision, verifyAndIntegrate } from '../runtime/kandev/devStories';
import { getStory, listComments, transitionStory } from '../domain/stories';
import type { KandevClient } from '../runtime/kandev/kandevClient';

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

describe('project-bound tasks through the bridge', () => {
  let dir: string; let data: string; let db: CoreDatabase; let pairing: BridgePairing; let rt: BridgeRuntime; let proj: string; let other: string;
  // Claude is "available" so the dispatch reaches the project gate; the fake never actually starts anything.
  const kandev = {
    healthy: async () => true, reprobeAgent: async () => null,
    tool: async (name: string) => (name === 'list_agents_kandev' ? { agents: [{ id: 'a1', name: 'claude-acp', capability_status: 'ok', profiles: [{ id: 'p', model: 'sonnet', auto_approve: false }] }] } : {}),
  } as unknown as KandevClient;
  const consent = { externalTransfer: true };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projbridge-')); data = path.join(dir, 'data'); fs.mkdirSync(data);
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'Chrome (ChatGPT)' }).pairing;
    rt = { db, kandev, dataDir: data, executor: undefined };
    const mk = (n: string, branch: string) => { const p = path.join(dir, n); fs.mkdirSync(path.join(p, 'src'), { recursive: true }); git(p, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(p, 'src', 'a.js'), `export const a = "${n}";\n`); fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n'); git(p, 'add', '-A'); git(p, 'commit', '-q', '-m', 'init'); git(p, 'checkout', '-q', '-b', branch); fs.writeFileSync(path.join(p, 'src', 'b.js'), 'export const b = 2;\n'); git(p, 'add', '-A'); git(p, 'commit', '-q', '-m', 'on branch'); return p; };
    proj = mk('Pandesh', 'feat/stage-c'); other = mk('Novocomedy', 'dev');
    registerProject(data, { name: 'Pandesh', path: proj, access: 'read', preferredAgents: ['claude'], authorizedBy: 'owner' });
    registerProject(data, { name: 'Novocomedy', path: other, access: 'read-write', authorizedBy: 'owner' });
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const submit = (text: string, id: string) => submitBridgeTask(db, pairing, { clientRequestId: id, instruction: text, sourceRef: { kind: 'chatgpt' } }).task;
  const dispatch = (id: string) => dispatchBridgeTask(rt, id, { executor: 'claude', consent, decidedBy: 'owner', authority: 'host' });

  it('an unauthorized path is refused with a question; nothing is searched, cloned or registered', async () => {
    const t = submit('Inspect C:\\Somewhere\\Else\\app and run its tests. Do not modify files.', 'req-unauth-001');
    await expect(dispatch(t.id)).rejects.toMatchObject({ details: { reason: 'needs_clarification' } });
    expect(getBridgeTask(db, t.id)).toMatchObject({ status: 'awaiting_executor', executor: null });
    expect(getBridgeTask(db, t.id).statusDetail).toMatch(/not an authorized project/);
    expect(loadProjects(data)).toHaveLength(2);
    expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false);
  });

  it('two projects named at once is ambiguous and asks', async () => {
    const t = submit(`Compare the code in ${proj} with ${other}. Do not modify files.`, 'req-ambig-0001');
    await expect(dispatch(t.id)).rejects.toThrow(/different projects/);
    expect(getBridgeTask(db, t.id).executor).toBeNull();
  });

  it('a task that may change a read-only project is refused', async () => {
    const t = submit(`Add a feature to the code in ${proj}`, 'req-write-00001');
    await expect(dispatch(t.id)).rejects.toThrow(/read-only/);
    expect(getBridgeTask(db, t.id).executor).toBeNull();
  });

  it('a missing branch is refused before anything is copied', async () => {
    const t = submit(`Inspect ${proj} on feat/nope and run the tests. Do not modify files.`, 'req-branch-0001');
    await expect(dispatch(t.id)).rejects.toThrow(/no branch 'feat\/nope'/);
    expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false);
  });

  it('a name without code words is not a project reference (the product name is not a repository)', async () => {
    const t = submit('Ask Pandesh what is on my calendar', 'req-name-000001');
    // It goes on to the normal isolated-workspace path (which needs a real Kandev here), so only check the gate did not intervene.
    await dispatch(t.id).catch(() => { /* the fake Kandev cannot start a story */ });
    expect(getBridgeTask(db, t.id).statusDetail ?? '').not.toMatch(/project|authorized/);
  });

  it('the inspection copy is private: right branch, no remote, source untouched', () => {
    const [p] = loadProjects(data);
    const before = checkoutFingerprint(proj)!;
    const plan = prepareProjectInspection(data, 'ptask_1', p!, proj, 'feat/stage-c');
    expect(fs.existsSync(path.join(plan.cloneDir, 'src', 'b.js'))).toBe(true);
    expect(git(plan.cloneDir, 'remote').stdout.trim()).toBe('');
    expect(git(plan.cloneDir, 'branch', '--show-current').stdout.trim()).toBe('feat/stage-c');
    expect(plan.cloneDir.startsWith(path.join(data, 'panda-workspaces'))).toBe(true);
    expect(plan).toMatchObject({ ref: 'feat/stage-c', sourceHead: before.head, sourceStatusSha: before.statusSha, uncommittedFiles: 0 });
    expect(checkoutFingerprint(proj)).toEqual(before);
    // The ref defaults to the checkout's current branch.
    expect(prepareProjectInspection(data, 'ptask_2', p!, proj, null).ref).toBe('feat/stage-c');
  });

  it('uncommitted work in the owner checkout is counted, not copied', () => {
    fs.writeFileSync(path.join(proj, 'scratch.txt'), 'wip');
    const plan = prepareProjectInspection(data, 'ptask_3', loadProjects(data)[0]!, proj, 'feat/stage-c');
    expect(plan.uncommittedFiles).toBe(1);
    expect(fs.existsSync(path.join(plan.cloneDir, 'scratch.txt'))).toBe(false);
  });
});

describe('read-only inspection story', () => {
  let dir: string; let db: CoreDatabase; let repo: string; let wt: string;
  const sent: string[] = []; const states: string[] = [];
  let messages: Array<{ kind: string; text: string; at: string; id: string }> = [];
  const kandev = { agentMessages: async () => messages, stopTask: async () => {}, setTaskState: async (_t: string, s: string) => { states.push(s); }, sendMessage: async (_t: string, _s: string, x: string) => { sent.push(x); } } as unknown as KandevClient;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; states.length = 0;
    repo = path.join(dir, 'src-project'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'i');
    wt = path.join(dir, 'worker'); git(repo, 'branch', 'panda/inspect-x', 'main'); git(repo, 'worktree', 'add', '-q', wt, 'panda/inspect-x');
    messages = [{ id: '1', at: '2026-11-20T10:00:00Z', kind: 'tool_execute', text: 'npx vitest run core/test/x.test.ts' }, { id: '2', at: '2026-11-20T10:01:00Z', kind: 'message', text: 'Report: ran the router tests, 12 passed. Defect: none found in the router, intentRouter.ts line 52 is fine.' }];
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function story() {
    const fp = checkoutFingerprint(repo)!;
    const planned = planDevStories(db, { projectName: 'P', repoPath: repo, baseBranch: 'main', integrationBranch: 'panda/inspect-x', verify: ['git', 'status', '--porcelain'],
      stories: [{ key: 't', title: 'Inspect', agent: 'claude', mode: 'inspect', inspect: { projectName: 'Pandesh', sourcePath: repo, ref: 'main', sourceHead: fp.head, sourceStatusSha: fp.statusSha } }] });
    const id = planned.stories[0]!.id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, id, { toStatus: to, actor: 'kkd', reason: 't' });
    return id;
  }
  const run = (id: string) => verifyAndIntegrate(db, kandev, getStory(db, id), devSpec(getStory(db, id))!, 'task-1', wt, 'sess-1');

  it('completes with the worker report, labelled worker-only, with KKD having verified nothing changed', async () => {
    const id = story();
    await run(id);
    expect(getStory(db, id).status).toBe('done');
    const body = listComments(db, id).map(c => c.body).find(b => b.startsWith('[kkd-dev:inspected]'))!;
    expect(body).toMatch(/level=worker-only; read-only checked by KKD/);
    expect(body).toMatch(/12 passed/);
    expect(body).toMatch(/npx vitest run/);
    expect(states).toContain('COMPLETED');
  });

  it('a change in the clone blocks it instead of accepting it', async () => {
    const id = story(); fs.writeFileSync(path.join(wt, 'new.txt'), 'oops');
    await run(id);
    expect(getStory(db, id).status).toBe('blocked');
    expect(listComments(db, id).map(c => c.body).join('\n')).toMatch(/read-only inspection changed files: new\.txt/);
    expect(states).not.toContain('COMPLETED');
  });

  it('a changed source checkout blocks it', async () => {
    const id = story(); fs.writeFileSync(path.join(repo, 'a.txt'), 'changed under us');
    await run(id);
    expect(getStory(db, id).status).toBe('blocked');
    expect(listComments(db, id).map(c => c.body).join('\n')).toMatch(/source checkout no longer matches/);
  });

  it('a worker that wrote no report is not accepted', async () => {
    const id = story(); messages = [];
    await run(id);
    expect(getStory(db, id).status).toBe('blocked');
  });

  it('the agent\'s own housekeeping files do not count as changes', async () => {
    const id = story(); fs.mkdirSync(path.join(wt, '.claude')); fs.writeFileSync(path.join(wt, '.claude', 'x.json'), '{}');
    await run(id);
    expect(getStory(db, id).status).toBe('done');
  });

  it('file writes are rejected outright in an inspection, tests and read-only git are allowed', () => {
    const id = story(); const spec = devSpec(getStory(db, id))!;
    const p = (a: Record<string, unknown>) => ({ pending_id: 'x', title: 't', action: a }) as never;
    expect(permissionDecision(p({ type: 'file_write', path: path.join(wt, 'x.js') }), wt, spec)).toMatchObject({ allow: false, reject: true });
    expect(permissionDecision(p({ type: 'file_edit', path: path.join(wt, 'x.js') }), wt, spec)).toMatchObject({ reject: true });
    expect(permissionDecision(p({ type: 'execute', command: 'npx vitest run core/test/deterministicRouting.test.ts' }), wt, spec)).toMatchObject({ allow: true });
    expect(permissionDecision(p({ type: 'execute', command: 'git log --oneline' }), wt, spec)).toMatchObject({ allow: true });
    expect(permissionDecision(p({ type: 'execute', command: 'git push origin main' }), wt, spec)).toMatchObject({ allow: false });
  });
});
