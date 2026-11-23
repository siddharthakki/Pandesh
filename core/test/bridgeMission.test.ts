/**
 * Multi-step missions through the bridge: steps with dependencies in one private copy, one owner approval that is a bounded
 * development grant, steps that pass Pandesh's own test run committed without a further click, everything else held for review.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { attachBridgeExecution, cleanMissionSteps, createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../domain/pandaBridge';
import { registerProject } from '../domain/projectRegistry';
import { addComment, getStory, listComments, transitionStory } from '../domain/stories';
import { cancelBridgeTask, dispatchBridgeTask, missionStories, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { checkoutFingerprint, DEV_ACTOR, devSpec, GRANT_REVOKED_TAG, planDevStories, verifyAndIntegrate } from '../runtime/kandev/devStories';
import type { KandevClient } from '../runtime/kandev/kandevClient';

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
let dir: string; let data: string; let db: CoreDatabase; let pairing: BridgePairing; let rt: BridgeRuntime; let rw: string;
const prevHome = process.env.KARKEDIKHA_KANDEV_HOME;
const kandev = {
  healthy: async () => true, reprobeAgent: async () => null,
  tool: async (name: string) => (name === 'list_agents_kandev' ? { agents: [{ id: 'a1', name: 'claude-acp', capability_status: 'ok', profiles: [{ id: 'p', model: 'sonnet', auto_approve: false }] }] } : {}),
  agentMessages: async () => [], sendMessage: async () => undefined, stopTask: async () => undefined, setTaskState: async () => undefined, taskByExternalId: async () => null,
} as unknown as KandevClient;
afterAll(() => { if (prevHome === undefined) delete process.env.KARKEDIKHA_KANDEV_HOME; else process.env.KARKEDIKHA_KANDEV_HOME = prevHome; });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5m-')); data = path.join(dir, 'data'); fs.mkdirSync(data);
  process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'kandev-home');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'ChatGPT' }).pairing;
  rt = { db, kandev, dataDir: data, executor: undefined };
  rw = path.join(dir, 'Calc'); fs.mkdirSync(path.join(rw, 'src'), { recursive: true }); fs.mkdirSync(path.join(rw, 'test'));
  git(rw, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(rw, 'package.json'), JSON.stringify({ name: 'calc', private: true, type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(rw, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(rw, 'test', 'add.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add', () => { assert.equal(add(2, 3), 5); });\n");
  git(rw, 'add', '-A'); git(rw, 'commit', '-q', '-m', 'init');
  registerProject(data, { name: 'Calc', path: rw, access: 'read-write', authorizedBy: 'owner' });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const STEPS = [
  { key: 'divide', instruction: 'Add divide(a, b) in src/divide.js with tests; throw RangeError on division by zero.' },
  { key: 'multiply', instruction: 'Add multiply(a, b) in src/multiply.js with tests.' },
  { key: 'index', instruction: 'Add src/index.js exporting add, divide and multiply, with a test.', dependsOn: ['divide', 'multiply'] },
];
const submitMission = (id: string) => submitBridgeTask(db, pairing, { clientRequestId: id, instruction: `Extend the Calc source code at ${rw}.`, intent: 'code_change', steps: STEPS, sourceRef: { kind: 'chatgpt' } }).task;

describe('mission submission and card', () => {
  it('steps are validated, need a code-change intent, and are written into the instruction the owner approves', () => {
    expect(() => cleanMissionSteps([{ instruction: 'one' }])).toThrow(/2 to 6 steps/);
    expect(() => cleanMissionSteps([{ key: 'a', instruction: 'x', dependsOn: ['b'] }, { key: 'b', instruction: 'y' }])).toThrow(/not an earlier step/);
    expect(() => submitBridgeTask(db, pairing, { clientRequestId: 'req-m-nointent', instruction: 'x', steps: STEPS })).toThrow(/intent code_change/);
    const t = submitMission('req-m-text-0001');
    expect(t.instruction).toMatch(/Steps \(each runs after/);
    expect(t.instruction).toMatch(/3\. \[index\] Add src\/index\.js .* \(after: divide, multiply\)/);
    expect(t.sourceRef.plan?.map(s => s.key)).toEqual(['divide', 'multiply', 'index']);
  });

  it('the mission card is the development grant: bounded, revocable, no push/merge, nothing in the checkout', async () => {
    const t = submitMission('req-m-card-0001');
    const r = await dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'extension:x', authority: 'extension' }) as { approval: { accessLevel: string; exposure: string[] } };
    expect(r.approval.accessLevel).toMatch(/^Mission of 3 code-change steps .*Development grant for 4 hours.*No push, no merge, no install/);
    expect(r.approval.exposure.join(' ')).toMatch(/Stop ends the grant at once/);
  });

  it('after the owner\'s consent all steps are planned as dependent stories in ONE private copy, each carrying the grant', async () => {
    const t = submitMission('req-m-plan-0001');
    await dispatchBridgeTask(rt, t.id, { executor: 'claude', consent: { externalTransfer: true }, decidedBy: 'owner', authority: 'host' }).catch(() => { /* the fake Kandev cannot hand over */ });
    const task = getBridgeTask(db, t.id);
    const stories = missionStories(db, task.projectId!);
    expect(stories).toHaveLength(3);
    const specs = stories.map(s => devSpec(s)!);
    expect(new Set(specs.map(s => s.repoPath)).size).toBe(1);
    expect(new Set(specs.map(s => s.integrationBranch))).toEqual(new Set([`panda/mission-${t.id.slice(-12)}`]));
    expect(specs.every(s => s.codeCopy?.grant && Date.parse(s.codeCopy.grant.expiresAt) > Date.now())).toBe(true);
    expect(git(specs[0]!.repoPath, 'remote').stdout.trim()).toBe('');
    // Live b188f defect 2026-11-23: the steps share a creation instant, so ordering by time + id mislabelled them. Plan order is kept.
    expect(specs.map(s => s.codeCopy?.step)).toEqual([1, 2, 3]);
    expect(stories.map(s => s.title.match(/\d\/3: Add (\S+)/)?.[1])).toEqual(['divide(a,', 'multiply(a,', 'src/index.js']);
  });

  it('steps planned before the position was stored are still ordered by their "i/N:" title, never by their random ids', () => {
    const fp = checkoutFingerprint(rw)!;
    const codeCopy = { projectName: 'Calc', sourcePath: rw, ref: 'main', sourceHead: fp.head, sourceStatusSha: fp.statusSha };
    for (let n = 0; n < 5; n++) {
      const p = planDevStories(db, { projectName: `Panda mission old${n}`, repoPath: rw, baseBranch: 'main', integrationBranch: `panda/mission-old${n}`, verify: ['git', 'status', '--porcelain'],
        stories: ['c', 'a', 'b'].map(k => ({ key: k, title: `Calc ${{ a: 1, b: 2, c: 3 }[k]}/3: step ${k}`, agent: 'claude' as const, maxFiles: 20, codeCopy })) });
      expect(missionStories(db, p.projectId).map(s => s.title.slice(-1))).toEqual(['a', 'b', 'c']);
    }
  });
});

describe('development grant at verification', () => {
  function step(grant: { id: string; expiresAt: string; steps: number } | undefined) {
    const copy = path.join(data, 'panda-workspaces', 'copy');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    git(dir, 'clone', '-q', rw, copy); git(copy, 'remote', 'remove', 'origin'); git(copy, 'branch', 'panda/mission-x', 'main');
    const fp = checkoutFingerprint(rw)!;
    const p = planDevStories(db, { projectName: 'Panda mission x', repoPath: copy, baseBranch: 'main', integrationBranch: 'panda/mission-x', verify: ['git', 'status', '--porcelain'],
      stories: [{ key: 'divide', title: 'Calc 1/3: divide', agent: 'claude', maxFiles: 20, codeCopy: { projectName: 'Calc', sourcePath: rw, ref: 'main', sourceHead: fp.head, sourceStatusSha: fp.statusSha, testsRequested: true, ...(grant ? { grant } : {}) } }] });
    const storyId = p.stories[0]!.id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
    const wt = path.join(dir, 'wt'); git(copy, 'worktree', 'add', '-q', '-b', 'feature/w', wt, 'panda/mission-x');
    fs.writeFileSync(path.join(wt, 'src', 'divide.js'), "export const divide = (a, b) => { if (b === 0) throw new RangeError('division by zero'); return a / b; };\n");
    fs.writeFileSync(path.join(wt, 'test', 'divide.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { divide } from '../src/divide.js';\ntest('divides', () => { assert.equal(divide(6, 3), 2); });\n");
    return { storyId, wt, copy, fp };
  }
  const live = { id: 'grant-x', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), steps: 3 };

  it('a step that passes Pandesh\'s test run is committed under the grant, without review; the owner checkout is untouched', async () => {
    const { storyId, wt, copy, fp } = step(live);
    await verifyAndIntegrate(db, kandev, getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    expect(getStory(db, storyId).status).toBe('done');
    expect(listComments(db, storyId).map(c => c.body).join('\n')).toMatch(/\[kkd-dev:integrated\].*committed under the owner's development grant grant-x/);
    expect(git(copy, 'show', 'panda/mission-x:src/divide.js').stdout).toMatch(/RangeError/);
    expect(checkoutFingerprint(rw)).toEqual(fp);
    expect(git(copy, 'rev-parse', 'main').stdout.trim()).toBe(fp.head);
  });

  it('without a grant, with a revoked grant, or an expired one, the same step waits for the owner', async () => {
    for (const [name, grant, revoke] of [['none', undefined, false], ['revoked', live, true], ['expired', { ...live, expiresAt: new Date(Date.now() - 1000).toISOString() }, false]] as const) {
      const { storyId, wt } = step(grant);
      if (revoke) addComment(db, storyId, { author: DEV_ACTOR, body: `${GRANT_REVOKED_TAG} test` });
      await verifyAndIntegrate(db, kandev, getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
      expect(getStory(db, storyId).status, name).toBe('delivery_approval');
      fs.rmSync(path.join(data, 'panda-workspaces'), { recursive: true, force: true }); fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('a failing step is never committed under the grant: it goes back to the worker', async () => {
    const { storyId, wt } = step(live);
    fs.writeFileSync(path.join(wt, 'test', 'divide.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { divide } from '../src/divide.js';\ntest('divides', () => { assert.equal(divide(6, 3), 3); });\n");
    await verifyAndIntegrate(db, kandev, getStory(db, storyId), devSpec(getStory(db, storyId))!, 'kt', wt, 'ks');
    expect(getStory(db, storyId).status).toBe('implementing');
  });
});

describe('stopping a mission', () => {
  it('Stop revokes the grant on every unfinished step', async () => {
    const t = submitMission('req-m-stop-0001');
    await dispatchBridgeTask(rt, t.id, { executor: 'claude', consent: { externalTransfer: true }, decidedBy: 'owner', authority: 'host' }).catch(() => undefined);
    const task = getBridgeTask(db, t.id);
    attachBridgeExecution(db, t.id, {});
    await cancelBridgeTask(rt, t.id, 'Pandesh');
    for (const s of missionStories(db, task.projectId!)) expect(listComments(db, s.id).some(c => c.body.startsWith(GRANT_REVOKED_TAG))).toBe(true);
    expect(getBridgeTask(db, t.id).status).toBe('cancelled');
  });
});
