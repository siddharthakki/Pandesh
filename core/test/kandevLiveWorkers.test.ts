/**
 * Regression tests for the 2026-11-21 ChatGPT → Claude Code run (docs/audit/2026-11-21/KANDEV_TO_UI_AUDIT.md §5):
 * - answer-only tasks with no project are verified as answers, never as code changes;
 * - work that may change files never runs in an empty substitute workspace;
 * - a worker that changed nothing and explained why is not sent back with contradictory "make changes" repairs;
 * - the worker's observed events are kept as a bounded log that survives completion and Kandev outages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import {
  attachBridgeExecution, BRIDGE_ACTIVITY_LIMIT, createPairingCode, getBridgeTask, recordBridgeStatus, redeemPairingCode, submitBridgeTask,
  type BridgePairing,
} from '../domain/pandaBridge';
import { addComment, getStory, listComments, listStories, transitionStory } from '../domain/stories';
import { DEV_ACTOR, devSpec, planDevStories, verificationOf, verifyAndIntegrate, waitsOnGpuLane } from '../runtime/kandev/devStories';
import { dispatchBridgeTask, isAnswerOnly, mergeActivity, prepareTaskWorkspace, refersToCode, refreshBridgeTask, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { activityItem, deriveExecutionState } from '../runtime/kandev/bridgeActivity';
import type { KandevClient } from '../runtime/kandev/kandevClient';

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

// The real instructions from the isolated Build 188 run (bridge_tasks, 2026-11-21).
const HELLO_1349 = "Claude Code approval and authentication acceptance test. After explicit owner approval in Pandesh Missions, reply with exactly 'Hello from Claude Code through Pandesh.' Do not read, create, edit, delete, or inspect files or repositories, run commands, or access private data. No changes, no production access, no additional tool use. Do not bypass the approval gate or substitute a different executor. Report whether the message was produced and any error.";
const HELLO_1340 = "CLOUD APPROVAL-GATE ACCEPTANCE TEST ONLY. Using Claude Code, say exactly 'Hello from Claude Code through Pandesh.' Do not inspect, open, read, write, or modify any files or workspace data. No shell commands, no project content, no external side effects. This task MUST wait for explicit owner approval in Pandesh Missions; do not start without approval, and do not substitute another executor or bypass the approval gate. Return the message and execution status.";
const CODING_1404 = "CODING / BUG-FIX TASK — explicit implementation work is authorized only in the registered Pandesh source project's isolated development worktree; no production installation, no merge, no deployment. Investigate and fix the task-verification defect demonstrated by task ptask_509bad2d. Implement a minimal robust fix so verification requirements are task-type-aware. Add focused regression tests reproducing this exact scenario, run relevant automated tests, and return precise files changed.";

describe('which tasks may run without a project', () => {
  it('reads the real hello instructions as answer-only and the real coding task as a change', () => {
    expect(isAnswerOnly(HELLO_1349)).toBe(true);
    expect(isAnswerOnly(HELLO_1340)).toBe(true);
    expect(isAnswerOnly(CODING_1404)).toBe(false);
    expect(isAnswerOnly('Build a simple calculator app')).toBe(false);
  });
});

describe('when a project name refers to its code', () => {
  it('an agent name or a prohibition is not a code reference; a positive request to read the code is', () => {
    expect(refersToCode("Approval-gate acceptance test. Reply with exactly 'Hello from Claude Code through Pandesh.' and nothing else. Do not change anything and do not use any tools.")).toBe(false);
    expect(refersToCode(HELLO_1349)).toBe(false);
    expect(refersToCode('Read-only inspection of the Pandesh source code, branch main. Do not modify any files.')).toBe(true);
    expect(refersToCode('Run the tests in Pandesh with Claude Code and report failures. Do not change files.')).toBe(true);
    expect(refersToCode(CODING_1404)).toBe(true);
  });
});

describe('bridge dispatch without a registered project', () => {
  let dir: string; let data: string; let db: CoreDatabase; let pairing: BridgePairing; let rt: BridgeRuntime;
  // Claude is "available" so dispatch reaches the gates; the fake never really starts anything.
  const kandev = {
    healthy: async () => true, reprobeAgent: async () => null, agentBinaryInstalled: () => true,
    tool: async (name: string) => (name === 'list_agents_kandev' ? { agents: [{ id: 'a1', name: 'claude-acp', capability_status: 'ok', profiles: [{ id: 'p', model: 'sonnet', auto_approve: false }] }] } : {}),
  } as unknown as KandevClient;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveworkers-')); data = path.join(dir, 'data'); fs.mkdirSync(data);
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'ChatGPT' }).pairing;
    rt = { db, kandev, dataDir: data, executor: undefined };
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const submit = (text: string, id: string) => submitBridgeTask(db, pairing, { clientRequestId: id, instruction: text, sourceRef: { kind: 'chatgpt' } }).task;
  const dispatch = (id: string) => dispatchBridgeTask(rt, id, { executor: 'claude', consent: { externalTransfer: true }, decidedBy: 'owner', authority: 'host' });

  it('the 14:04 coding task is refused with a question instead of getting an empty scaffold', async () => {
    const t = submit(CODING_1404, 'req-coding-0001');
    await expect(dispatch(t.id)).rejects.toMatchObject({ details: { reason: 'needs_clarification' } });
    expect(getBridgeTask(db, t.id)).toMatchObject({ status: 'awaiting_executor', executor: null, storyId: null, workspacePath: null });
    expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false);
    expect(listStories(db, { limit: 10 })).toHaveLength(0);
  });

  it('the 13:49 hello task becomes an answer-only story: read-only rules, no tests demanded, no change allowed', async () => {
    const t = submit(HELLO_1349, 'req-hello-00001');
    await dispatch(t.id).catch(() => { /* the fake Kandev cannot hand the story over; the plan is what is checked */ });
    const storyId = getBridgeTask(db, t.id).storyId!;
    const spec = devSpec(getStory(db, storyId))!;
    expect(spec).toMatchObject({ mode: 'inspect', answerOnly: true, verify: ['git', 'status', '--porcelain'] });
    expect(spec.acceptance ?? []).toEqual([]);
    expect(getStory(db, storyId).acceptanceCriteria).toEqual([]);
  });
});

/** A worker session whose messages, deliveries and final state the test controls. */
function fakeWorker() {
  const w = {
    messages: [] as Array<{ id: string; at: string; kind: string; text: string }>,
    sent: [] as string[], states: [] as string[],
  };
  const kandev = {
    agentMessages: async () => w.messages, stopTask: async () => {}, setTaskState: async (_t: string, s: string) => { w.states.push(s); },
    sendMessage: async (_t: string, _s: string, x: string) => { w.sent.push(x); }, relaunchSession: async () => {},
  } as unknown as KandevClient;
  return { w, kandev };
}

describe('verifying what the worker did', () => {
  let dir: string; let db: CoreDatabase; let repo: string; let wt: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveverify-')); db = openCoreDatabase(path.join(dir, 'core.db')).db;
    repo = path.join(dir, 'repo'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'README.md'), 'x'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'i');
    wt = path.join(dir, 'wt'); git(repo, 'branch', 'panda/int', 'main'); git(repo, 'worktree', 'add', '-q', '-b', 'feature/w', wt, 'main');
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function plan(kind: 'answer' | 'code'): string {
    const p = planDevStories(db, {
      projectName: 'Panda bridge', repoPath: repo, baseBranch: 'main', integrationBranch: 'panda/int', verify: ['git', 'status', '--porcelain'],
      stories: [kind === 'answer' ? { key: 't', title: 'Say hello', agent: 'claude', mode: 'inspect', answerOnly: true } : { key: 't', title: 'Fix the verifier', agent: 'claude' }],
    });
    const id = p.stories[0]!.id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, id, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
    return id;
  }
  const verify = (kandev: KandevClient, id: string) => verifyAndIntegrate(db, kandev, getStory(db, id), devSpec(getStory(db, id))!, 'kt-1', wt, 'ks-1');
  const comments = (id: string) => listComments(db, id).map(c => c.body).join('\n');

  it('an answer-only task succeeds with zero changed files and keeps the exact (short) answer', async () => {
    const { w, kandev } = fakeWorker();
    w.messages = [{ id: '1', at: '2026-11-21T13:49:54Z', kind: 'message', text: 'Hello from Claude Code through Pandesh.' }];
    const id = plan('answer');
    await verify(kandev, id);
    expect(getStory(db, id).status).toBe('done');
    expect(comments(id)).toMatch(/\[kkd-dev:inspected\] level=worker-only; answer-only task/);
    expect(comments(id)).toContain('Hello from Claude Code through Pandesh.');
    expect(comments(id)).not.toMatch(/verify-failed|made no changes/);
    expect(w.sent).toEqual([]);
    expect(w.states).toContain('COMPLETED');
  });

  it('an answer-only task that changed a file is not accepted', async () => {
    const { w, kandev } = fakeWorker();
    w.messages = [{ id: '1', at: '2026-11-21T13:49:54Z', kind: 'message', text: 'Hello from Claude Code through Pandesh.' }];
    fs.writeFileSync(path.join(wt, 'hello.txt'), 'hi');
    const id = plan('answer');
    await verify(kandev, id);
    expect(getStory(db, id).status).toBe('blocked');
    expect(comments(id)).toMatch(/changed files in its private copy: hello\.txt/);
    expect(w.sent).toEqual([]);
  });

  it('a coding worker that changed nothing and explained why goes to the owner with its explanation, without a repair request', async () => {
    const { w, kandev } = fakeWorker();
    const why = "I'm not going to manufacture a diff just to satisfy a no-changes check: this worktree contains only a scaffold and no task-verification code.";
    w.messages = [{ id: '1', at: '2026-11-21T14:04:45Z', kind: 'tool_execute', text: 'git status' }, { id: '2', at: '2026-11-21T14:04:59Z', kind: 'message', text: why }];
    const id = plan('code');
    await verify(kandev, id);
    expect(getStory(db, id).status).toBe('blocked');
    expect(w.sent).toEqual([]); // no "Fix it, re-run …" sent back
    expect(comments(id)).toMatch(/\[kkd-dev:needs-human\] The worker made no changes and explained why \(not sent back for repair\)/);
    expect(comments(id)).toContain('manufacture a diff');
  });

  it('a silent coding worker that changed nothing still gets the one usual correction', async () => {
    const { w, kandev } = fakeWorker();
    w.messages = [{ id: '1', at: '2026-11-21T14:04:45Z', kind: 'tool_execute', text: 'ls' }];
    const id = plan('code');
    await verify(kandev, id);
    expect(getStory(db, id).status).toBe('implementing');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatch(/the worker made no changes/);
  });

  it('when corrections run out, the worker\'s last words go to the owner with the failure', async () => {
    const { w, kandev } = fakeWorker();
    const id = plan('code');
    // Earlier prose from before the latest hand-off: not an answer to this turn, but still what the worker last said.
    w.messages = [{ id: '1', at: '2026-01-01T00:00:00Z', kind: 'message', text: 'The scaffold has no source to change; I need the real project to proceed with this fix.' }];
    addComment(db, id, { author: DEV_ACTOR, body: '[kkd-dev:dispatched] claude' });
    addComment(db, id, { author: DEV_ACTOR, body: '[kkd-dev:verify-failed] the worker made no changes' });
    addComment(db, id, { author: DEV_ACTOR, body: '[kkd-dev:verify-failed] the worker made no changes' });
    await verify(kandev, id);
    expect(getStory(db, id).status).toBe('blocked');
    expect(w.sent).toEqual([]);
    expect(comments(id)).toMatch(/Verification failed 3 times \(the worker made no changes\).*The worker's last words: The scaffold has no source/);
  });
});

describe('waiting for the local GPU', () => {
  it('a GPU story waits while the lanes are taken; a cloud worker never waits on the GPU', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpulane-'));
    const db = openCoreDatabase(path.join(dir, 'core.db')).db;
    try {
      const repo = path.join(dir, 'r'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a'), 'a'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'i');
      const p = planDevStories(db, { projectName: 'P', repoPath: repo, verify: ['git', 'status', '--porcelain'], integrationBranch: 'kkd/int', stories: [
        { key: 'g1', title: 'gpu one', agent: 'opencode' }, { key: 'g2', title: 'gpu two', agent: 'opencode' }, { key: 'c', title: 'cloud', agent: 'claude' },
      ] });
      const [g1, g2, c] = p.stories.map(s => s.id);
      for (const id of [g1, g2, c]) for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, id!, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
      const running = new Set([g1]);
      const kandev = { taskByExternalId: async (_w: string, id: string) => ({ id }), sessions: async (id: string) => (running.has(id) ? [{ id: 's', state: 'RUNNING' }] : []) } as unknown as KandevClient;
      const spec = (id: string) => devSpec(getStory(db, id))!;
      expect(await waitsOnGpuLane(db, kandev, 'ws', getStory(db, g2!), spec(g2!), 1)).toBe(true);
      expect(await waitsOnGpuLane(db, kandev, 'ws', getStory(db, g2!), spec(g2!), 2)).toBe(false);
      expect(await waitsOnGpuLane(db, kandev, 'ws', getStory(db, c!), spec(c!), 1)).toBe(false);
      running.clear();
      expect(await waitsOnGpuLane(db, kandev, 'ws', getStory(db, g2!), spec(g2!), 1)).toBe(false);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('queued is not stalled', () => {
  it('a task queued for the GPU lane for ten minutes reads as queued, not stalled; a silent running worker still reads as stalled', () => {
    const now = Date.parse('2026-11-21T15:30:00Z');
    const old = '2026-11-21T15:20:00Z';
    const queued = deriveExecutionState({ now, task: { status: 'running', executor: 'opencode', control: 'none', updatedAt: old, statusDetail: 'Waits for: local GPU lane (1 at a time) after "Inspect Pandesh"', result: null }, storyWaitingForSlot: true, lastActivityAt: null });
    expect(queued.state).toBe('waiting_for_model');
    expect(queued.reason).toMatch(/Queued for the local GPU/);
    const silent = deriveExecutionState({ now, task: { status: 'running', executor: 'claude', control: 'none', updatedAt: old, statusDetail: 'Working.', result: null }, storyWaitingForSlot: false, lastActivityAt: Date.parse(old) });
    expect(silent.state).toBe('stalled');
  });
});

describe('what the result is called', () => {
  it('reads the verification level from Pandesh\'s own header, never from words in the worker\'s report', () => {
    // Live 2026-11-21: Claude inspected this code and quoted "human-reviewed"; the panel then said "reviewed by a person".
    const report = "[kkd-dev:inspected] level=worker-only; read-only checked by KKD: no file changed.\n--- worker report ---\nverification is 'independent' | 'human-reviewed' | 'worker-only'; level=independent means acceptance passed.";
    expect(verificationOf(report, true)).toBe('worker-only');
    expect(verificationOf('[kkd-dev:integrated] abc on panda/x (branch f); level=worker-only (human-reviewed); `npm test` passed after merge.', true)).toBe('human-reviewed');
    expect(verificationOf('[kkd-dev:integrated] abc on panda/x (branch f); level=independent; passed.', true)).toBe('independent');
  });
});

describe('the worker event log', () => {
  const ev = (i: number, kind = 'tool_read') => ({ id: `m${i}`, at: new Date(Date.UTC(2026, 10, 21, 10, 0, i)).toISOString(), kind, text: `event ${i}` });

  it('appends by message id, in time order, without duplicates, bounded', () => {
    const a = mergeActivity([], [ev(1), ev(2)]);
    const b = mergeActivity(a, [ev(2), ev(3)]);
    expect(b.map(e => e.id)).toEqual(['m1', 'm2', 'm3']);
    expect(mergeActivity(b, [ev(3)])).toBe(b); // nothing new: the same array, so nothing is rewritten
    expect(mergeActivity(b, null)).toBe(b); // Kandev unreachable: the log is kept as it was
    const many = mergeActivity([], Array.from({ length: BRIDGE_ACTIVITY_LIMIT + 25 }, (_, i) => ev(i)));
    expect(many).toHaveLength(BRIDGE_ACTIVITY_LIMIT);
    expect(many[0]!.id).toBe('m25');
    // A streamed message grows under the same id (seen live: "The" → the full report): the newer text replaces the fragment.
    const streamed = mergeActivity(mergeActivity([], [{ ...ev(5, 'message'), text: 'The' }]), [{ ...ev(5, 'message'), text: 'The worker reports five findings.' }]);
    expect(streamed.map(e => e.text)).toEqual(['The worker reports five findings.']);
    // Lines from builds that kept only the last three (no id) are replaced by the full log.
    expect(mergeActivity([{ at: 'x', kind: 'message', text: 'old' }], [ev(1)]).map(e => e.id)).toEqual(['m1']);
  });

  describe('mirrored into the relayed task', () => {
    let dir: string; let db: CoreDatabase;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelog-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
    afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

    it('accumulates across refreshes, keeps the log after completion and through an outage, and reports the newest event', async () => {
      const { code } = createPairingCode(db);
      const { pairing } = redeemPairingCode(db, { code, label: 'ChatGPT' });
      const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-log-000001', instruction: 'Say hello. Do not change any files.' });
      const ws = prepareTaskWorkspace(dir, task.id);
      const p = planDevStories(db, { projectName: 'Panda bridge', repoPath: ws, verify: ['git', 'status', '--porcelain'], integrationBranch: 'panda/log', stories: [{ key: 't', title: 'Say hello', agent: 'claude', mode: 'inspect', answerOnly: true }] });
      const storyId = p.stories[0]!.id;
      for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
      attachBridgeExecution(db, task.id, { projectId: p.projectId, storyId, workspacePath: ws });
      recordBridgeStatus(db, task.id, 'running', 'Working.');

      const state = { up: true, messages: [ev(1, 'status'), ev(2, 'tool_read')] as Array<ReturnType<typeof ev>> };
      const kandev = {
        healthy: async () => state.up, defaultWorkspaceId: async () => { if (!state.up) throw new Error('down'); return 'ws-1'; },
        taskByExternalId: async () => ({ id: 'kt-1', title: 't', state: 'IN_PROGRESS' }),
        sessions: async () => [{ id: 'ks-1', state: 'RUNNING', worktree_branch: 'feature/say-hello' }],
        pendingPermissions: async () => [], latestTurn: async () => null,
        agentMessages: async () => state.messages.map(m => ({ ...m, text: `${m.text} in C:\\Users\\someone\\secret` })),
      } as unknown as KandevClient;
      const rt = { db, kandev, dataDir: dir };

      await refreshBridgeTask(rt, task.id);
      state.messages = [ev(2, 'tool_read'), ev(3, 'message')];
      const mid = await refreshBridgeTask(rt, task.id);
      expect(mid.result?.activity.map(e => e.id)).toEqual(['m1', 'm2', 'm3']);
      expect(mid.result?.activity.every(e => !/Users/.test(e.text))).toBe(true); // private paths never stored
      expect(mid.result?.branch).toBe('feature/say-hello');

      const item = activityItem(db, getBridgeTask(db, task.id), 'ChatGPT');
      expect(item).toMatchObject({ eventCount: 3, lastEventAt: ev(3).at, latest: { kind: 'message' }, branch: 'feature/say-hello', storyId });

      // The story finishes; the final refresh keeps every event recorded so far.
      for (const to of ['review', 'validation', 'delivery_approval', 'merge_queue', 'done'] as const) transitionStory(db, storyId, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
      addComment(db, storyId, { author: DEV_ACTOR, body: '[kkd-dev:inspected] level=worker-only; answer-only task\n--- worker answer ---\nHello' });
      state.messages = [ev(3, 'message'), ev(4, 'message')];
      const done = await refreshBridgeTask(rt, task.id);
      expect(done.status).toBe('completed');
      expect(done.result?.activity.map(e => e.id)).toEqual(['m1', 'm2', 'm3', 'm4']);

      // Later reads (Kandev gone, Core restarted: a fresh read from the database) still have the whole log.
      state.up = false;
      const after = await refreshBridgeTask(rt, task.id);
      expect(after.result?.activity).toHaveLength(4);
      expect(getBridgeTask(db, task.id).result?.activity).toHaveLength(4);
    });
  });
});
