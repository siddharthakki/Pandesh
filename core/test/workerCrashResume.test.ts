import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { addComment, getStory, listComments, transitionStory } from '../domain/stories';
import { CRASH_TAG, DEV_ACTOR, planDevStories, reconcileDevStories } from '../runtime/kandev/devStories';

// Live b188i 2026-11-23: claude.exe of a mission step was killed mid-turn. Kandev closed the turn like a normal one (marked
// error_terminated), Pandesh verified it, read "the worker made no changes" and spent a verification attempt. A crash is resumed instead.
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
let dir: string; let db: CoreDatabase; const prevHome = process.env.KARKEDIKHA_KANDEV_HOME;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-')); process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'kandev-home');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); if (prevHome === undefined) delete process.env.KARKEDIKHA_KANDEV_HOME; else process.env.KARKEDIKHA_KANDEV_HOME = prevHome; });

function setup() {
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.js'), 'x'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'i'); git(repo, 'branch', 'kkd/integration');
  const wt = path.join(process.env.KARKEDIKHA_KANDEV_HOME!, 'tasks', 's', 'repo'); git(repo, 'worktree', 'add', '-q', '-b', 'feature/s', wt, 'kkd/integration');
  const plan = planDevStories(db, { projectName: 'P', repoPath: repo, integrationBranch: 'kkd/integration', verify: ['git', 'status', '--porcelain'], stories: [{ key: 's', title: 'Add b', agent: 'claude' }] });
  const id = plan.stories[0]!.id;
  for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, id, { toStatus: to, actor: DEV_ACTOR, reason: 't' });
  addComment(db, id, { author: DEV_ACTOR, body: '[kkd-dev:dispatched] claude · Kandev task t' });
  db.run("UPDATE story_comments SET createdAt = '2026-01-01T00:00:00.000Z' WHERE storyId = ?", [id]);
  const state = { turn: { started_at: '2026-01-01T00:01:00.000Z', completed_at: '2026-01-01T00:01:10.000Z', metadata: { error_terminated: true } as { error_terminated?: boolean } }, sent: [] as string[] };
  const kandev: any = {
    healthy: async () => true, defaultWorkspaceId: async () => 'ws', taskByExternalId: async () => ({ id: 't', state: 'IN_PROGRESS' }),
    sessions: async () => [{ id: 'sess', state: 'WAITING_FOR_INPUT', worktree_path: wt, worktree_branch: 'feature/s' }],
    agentMessages: async () => [], pendingPermissions: async () => [], sessionStatus: async () => ({ is_agent_running: false }),
    latestTurn: async () => state.turn, sendMessage: async (_t: string, _s: string, text: string) => { state.sent.push(text); },
    relaunchSession: async () => {}, setTaskState: async () => {}, stopTask: async () => {}, tool: async () => ({}), rest: async () => null,
  };
  const bodies = () => listComments(db, id).map(c => c.body);
  return { id, kandev, state, bodies, wt };
}

describe('a worker process that dies mid-turn', () => {
  it('is resumed in the same session, never counted as a failed verification; the same crash counts once; the third parks it', async () => {
    const t = setup();
    await reconcileDevStories(db, t.kandev);
    expect(t.bodies().filter(b => b.startsWith(CRASH_TAG))).toHaveLength(1);
    expect(t.bodies().join('\n')).not.toMatch(/verify-failed/);
    expect(t.state.sent).toEqual([expect.stringMatching(/^Your previous run was interrupted/)]);
    expect(getStory(db, t.id).status).toBe('implementing');

    // The resume message started a new epoch: the crashed turn is not looked at again.
    await reconcileDevStories(db, t.kandev);
    expect(t.bodies().filter(b => b.startsWith(CRASH_TAG))).toHaveLength(1);
    expect(t.state.sent).toHaveLength(1);

    // It crashes again (a later turn): resumed a second time; a third crash parks the story with the reason, no more resumes.
    t.state.turn = { ...t.state.turn, started_at: new Date(Date.now() + 1000).toISOString(), completed_at: new Date(Date.now() + 2000).toISOString() };
    await reconcileDevStories(db, t.kandev);
    expect(t.bodies().filter(b => b.startsWith(CRASH_TAG))).toHaveLength(2);
    t.state.turn = { ...t.state.turn, started_at: new Date(Date.now() + 5000).toISOString(), completed_at: new Date(Date.now() + 6000).toISOString() };
    await reconcileDevStories(db, t.kandev);
    expect(getStory(db, t.id).status).toBe('blocked');
    expect(t.bodies().join('\n')).toMatch(/\[kkd-dev:needs-human\] The worker process stopped 3 times before finishing; Pandesh resumed it 2 time\(s\)/);
    expect(t.state.sent).toHaveLength(2);
  }, 30_000);

  it('a normal finished turn (not error-terminated) is still verified as before', async () => {
    const t = setup();
    t.state.turn.metadata = {};
    await reconcileDevStories(db, t.kandev);
    expect(t.bodies().some(b => b.startsWith(CRASH_TAG))).toBe(false);
    expect(t.bodies().join('\n')).toMatch(/\[kkd-dev:verify-failed\] the worker made no changes/);
  }, 30_000);
});
