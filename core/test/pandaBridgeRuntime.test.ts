import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createPairingCode, getBridgeTask, recordBridgeStatus, redeemPairingCode, attachBridgeExecution, submitBridgeTask } from '../domain/pandaBridge';
import { addComment, getStory, transitionStory } from '../domain/stories';
import { planDevStories, DEV_ACTOR, permissionDecision } from '../runtime/kandev/devStories';
import { prepareTaskWorkspace, refreshBridgeTask, discoverExecutors, dispatchBridgeTask, cancelBridgeTask } from '../runtime/kandev/pandaBridge';
import { listMessages } from '../domain/conversations';
import { getAttempt } from '../domain/attempts';
import type { RuntimeExecutor } from '../runtime/executor';
import type { KandevClient, KandevPermission } from '../runtime/kandev/kandevClient';

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-bridge-rt-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A Kandev that reports whatever the test sets; only the calls the status mirror makes are implemented. */
function fakeKandev(state: { up?: boolean; sessionState?: string; pending?: KandevPermission[] }): KandevClient {
  return {
    healthy: async () => state.up !== false,
    defaultWorkspaceId: async () => 'ws-1',
    taskByExternalId: async () => ({ id: 'kt-1', title: 't', state: 'IN_PROGRESS' }),
    sessions: async () => [{ id: 'ks-1', state: state.sessionState ?? 'RUNNING', worktree_branch: 'feature/x' }],
    pendingPermissions: async () => state.pending ?? [],
    agentMessages: async () => [{ id: 'm1', at: new Date().toISOString(), kind: 'tool_execute', text: 'npm test' }],
    latestTurn: async () => null,
    tool: async () => ({ agents: [] }),
  } as unknown as KandevClient;
}

function setup() {
  const { code } = createPairingCode(db);
  const { pairing } = redeemPairingCode(db, { code, label: 'Chrome' });
  const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: 'Build a simple calculator app' });
  const workspace = prepareTaskWorkspace(dir, task.id);
  const plan = planDevStories(db, {
    projectName: 'Panda bridge', repoPath: workspace, verify: ['npm', 'test'], integrationBranch: 'panda/test',
    stories: [{ key: 'task', title: 'Build a simple calculator app', agent: 'opencode' }],
  });
  const storyId = plan.stories[0].id;
  for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 'test' });
  attachBridgeExecution(db, task.id, { projectId: plan.projectId, storyId, workspacePath: workspace });
  recordBridgeStatus(db, task.id, 'running', 'Working.');
  return { taskId: task.id, storyId };
}

const permission: KandevPermission = {
  pending_id: 'p-1', request_id: 'r-1', session_id: 'ks-1', task_id: 'kt-1', title: 'Run a command',
  action: { type: 'command', command: 'npm install left-pad' }, options: [{ kind: 'allow_once', option_id: 'a' }, { kind: 'reject_once', option_id: 'b' }],
};

describe('mirroring the work into the relayed task', () => {
  it('shows a worker approval as awaiting_approval with what is being asked, and clears it once decided', async () => {
    const { taskId } = setup();
    const state: Parameters<typeof fakeKandev>[0] = { pending: [permission] };
    const rt = { db, kandev: fakeKandev(state), dataDir: dir };

    const waiting = await refreshBridgeTask(rt, taskId);
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.result?.pendingApprovals).toEqual([{ pendingId: 'p-1', what: 'npm install left-pad' }]);

    state.pending = [];
    const working = await refreshBridgeTask(rt, taskId);
    expect(working.status).toBe('running');
    expect(working.result?.pendingApprovals).toEqual([]);
    expect(working.result?.activity.at(-1)?.text).toBe('npm test');
  });

  it('reports completion with independent verification evidence, and never reopens it', async () => {
    const { taskId, storyId } = setup();
    const rt = { db, kandev: fakeKandev({ sessionState: 'COMPLETED' }), dataDir: dir };
    addComment(db, storyId, { author: DEV_ACTOR, body: '[kkd-dev:verified] level=independent; tests=3 pass=3 fail=0\nChanged: calc.js, calc.test.js\nok' });
    addComment(db, storyId, { author: DEV_ACTOR, body: '[kkd-dev:integrated] abc1234 on panda/test (branch feature/x); level=independent; `npm test` and independent acceptance passed after merge.' });
    for (const to of ['review', 'validation', 'delivery_approval', 'merge_queue', 'done'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 'test' });
    expect(getStory(db, storyId).status).toBe('done');

    const done = await refreshBridgeTask(rt, taskId);
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ verification: 'independent', commit: 'abc1234', changedFiles: ['calc.js', 'calc.test.js'] });
    expect(done.completedAt).not.toBeNull();
    // a later poll against a worker that has gone cannot undo the result
    const again = await refreshBridgeTask({ ...rt, kandev: fakeKandev({ up: false }) }, taskId);
    expect(again.status).toBe('completed');
  });

  it('does not call a story running before it has been handed to the executor', async () => {
    const { code } = createPairingCode(db);
    const { pairing } = redeemPairingCode(db, { code, label: 'Chrome' });
    const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: 'Build a simple calculator app' });
    const workspace = prepareTaskWorkspace(dir, task.id);
    const plan = planDevStories(db, { projectName: 'Panda bridge', repoPath: workspace, verify: ['npm', 'test'], integrationBranch: 'panda/test', stories: [{ key: 'task', title: 't', agent: 'opencode' }] });
    attachBridgeExecution(db, task.id, { projectId: plan.projectId, storyId: plan.stories[0].id, workspacePath: workspace });
    recordBridgeStatus(db, task.id, 'dispatching', 'Starting opencode.');
    const after = await refreshBridgeTask({ db, kandev: fakeKandev({}), dataDir: dir }, task.id);
    expect(after.status).toBe('dispatching');
    expect(after.statusDetail).toBe('Starting opencode.');
  });

  it('shows a stopped worker as paused, and keeps the last status while the executor is unreachable', async () => {
    const { taskId, storyId } = setup();
    const down = { db, kandev: fakeKandev({ up: false }), dataDir: dir };
    expect((await refreshBridgeTask(down, taskId)).status).toBe('running'); // not dispatched / unreachable: nothing invented

    addComment(db, storyId, { author: 'user', body: '[kkd-dev:stopped] Paused from the browser bridge' });
    transitionStory(db, storyId, { toStatus: 'blocked', actor: DEV_ACTOR, reason: 'paused' });
    const paused = await refreshBridgeTask({ db, kandev: fakeKandev({ sessionState: 'CANCELLED' }), dataDir: dir }, taskId);
    expect(paused.status).toBe('paused');
    expect(getBridgeTask(db, taskId).statusDetail).toMatch(/Paused/);
  });
});

describe('executor discovery', () => {
  it('lists the four known agents plus native, flags cloud ones external, and never starts Kandev', async () => {
    const listing = await discoverExecutors(fakeKandev({ up: false }), { nativeAvailable: true });
    const byId = Object.fromEntries(listing.executors.map(e => [e.id, e]));
    expect(Object.keys(byId).sort()).toEqual(['antigravity', 'claude', 'hermes', 'native', 'opencode']);
    expect(byId.claude.external).toBe(true);
    expect(byId.antigravity.external).toBe(true);
    expect(byId.opencode.external).toBe(false);
    expect(byId.native).toMatchObject({ kind: 'native', external: false, available: true });
    expect(listing.kandev.running).toBe(false);
    expect(listing.hardware.gpuLanes).toBeGreaterThanOrEqual(1);
  });

  it('lists other ACP agents Kandev has as visible but not dispatchable, and disables native without an executor', async () => {
    const kandev = {
      ...fakeKandev({}),
      tool: async () => ({ agents: [{ id: 'a1', name: 'cursor-acp', capability_status: 'ok', profiles: [{ model: 'auto', auto_approve: false }] }] }),
    } as unknown as KandevClient;
    const listing = await discoverExecutors(kandev, { nativeAvailable: false });
    const other = listing.executors.find(e => e.id === 'cursor-acp');
    expect(other).toMatchObject({ dispatchable: false, available: false, external: true });
    expect(listing.executors.find(e => e.id === 'native')?.available).toBe(false);
  });
});

describe('native Pandesh capabilities as an executor', () => {
  it('runs through the ordinary request/attempt path once, without duplicating the user turn, and can be cancelled', async () => {
    const { code } = createPairingCode(db);
    const { pairing } = redeemPairingCode(db, { code, label: 'Chrome' });
    const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: 'Open the calculator and tell me the time' });
    const calls: string[] = [];
    const executor = { execute: async (attemptId: string) => { calls.push(attemptId); }, cancel: (attemptId: string) => { calls.push(`cancel:${attemptId}`); } } as unknown as RuntimeExecutor;
    const rt = { db, kandev: fakeKandev({ up: false }), dataDir: dir, executor };

    const first = await dispatchBridgeTask(rt, task.id, { executor: 'native', decidedBy: 'host', authority: 'host' });
    const second = await dispatchBridgeTask(rt, task.id, { executor: 'native', decidedBy: 'host', authority: 'host' });
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(calls.filter(c => !c.startsWith('cancel'))).toHaveLength(1); // one execution, however many times it is requested

    const linked = getBridgeTask(db, task.id);
    expect(linked).toMatchObject({ executor: 'native', status: 'running', routing: 'explicit' });
    expect(linked.attemptId).toBeTruthy();
    expect(listMessages(db, linked.conversationId!).filter(m => m.role === 'user')).toHaveLength(1);
    expect(getAttempt(db, linked.attemptId!).kind).toBe('saath_kar');

    const cancelled = await cancelBridgeTask(rt, task.id, 'test');
    expect(cancelled.status).toBe('cancelled');
    expect(calls).toContain(`cancel:${linked.attemptId}`);
  });

  it('refuses native dispatch when this Core has no runtime executor', async () => {
    const { code } = createPairingCode(db);
    const { pairing } = redeemPairingCode(db, { code, label: 'Chrome' });
    const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: 'Do a thing' });
    await expect(dispatchBridgeTask({ db, kandev: fakeKandev({ up: false }), dataDir: dir }, task.id, { executor: 'native', decidedBy: 'host', authority: 'host' })).rejects.toThrow(/not available/);
    expect(getBridgeTask(db, task.id).status).toBe('awaiting_executor');
  });
});

describe('Deny cannot be circumvented by a repeat of the same permission', () => {
  const spec = { verify: ['npm', 'test'] } as Parameters<typeof permissionDecision>[2];
  const worktree = 'C:\work\task';
  const denied = 'npm install left-pad';
  const variants = [
    denied,
    `cd "${worktree}" && ${denied}`,
    `${denied} 2>&1 | tail -50`,
    `NPM INSTALL LEFT-PAD`,
    `${denied}; echo done`,
    `npm i left-pad`,
  ];

  it('never auto-allows any re-request of a denied command, with a fresh pending id each time', () => {
    variants.forEach((command, i) => {
      const d = permissionDecision({ ...permission, pending_id: `again-${i}`, action: { type: 'command', command } }, worktree, spec);
      expect(d.allow, command).toBe(false);
    });
  });

  it('never auto-allows an action that needs a human, however it is described', () => {
    for (const type of ['other', 'network', 'unknown', undefined]) {
      const d = permissionDecision({ ...permission, action: { type: type as never, description: 'access the network' } }, worktree, spec);
      expect(d.allow, String(type)).toBe(false);
    }
  });
});
