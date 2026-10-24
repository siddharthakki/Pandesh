import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { getStory, listStories } from '../domain/stories';
import { listDependencies } from '../domain/dependencies';
import { devSpec, permissionDecision, planDevStories, type DevStorySpec } from '../runtime/kandev/devStories';
import type { KandevPermission } from '../runtime/kandev/kandevClient';

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-dev-stories-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const worktree = path.join(os.tmpdir(), 'kandev-tasks', 'a-story', 'repo');
const spec: DevStorySpec = { kind: 'kkd-dev-story', repoPath: 'x', baseBranch: 'main', integrationBranch: 'kkd/integration', verify: ['npm', 'test'], agent: 'claude' };
const perm = (action: KandevPermission['action']): KandevPermission => ({ pending_id: 'p', request_id: 'r', session_id: 's', task_id: 't', action });

describe('worker permission policy', () => {
  it('allows edits inside the worker worktree only', () => {
    expect(permissionDecision(perm({ type: 'file_write', path: path.join(worktree, 'src', 'a.ts') }), worktree, spec).allow).toBe(true);
    expect(permissionDecision(perm({ type: 'file_write', path: path.join(os.tmpdir(), 'elsewhere.ts') }), worktree, spec).allow).toBe(false);
    expect(permissionDecision(perm({ type: 'file_write', path: path.join(worktree, '.git', 'config') }), worktree, spec).allow).toBe(false);
    expect(permissionDecision(perm({ type: 'file_write', path: path.join(worktree, '.env') }), worktree, spec).allow).toBe(false);
    expect(permissionDecision(perm({ type: 'file_write', path: path.join(worktree, 'node_modules', 'x', 'index.js') }), worktree, spec).allow).toBe(false);
  });

  it('allows the verify command and read-only git, holds everything else', () => {
    expect(permissionDecision(perm({ type: 'command', command: 'npm test' }), worktree, spec).allow).toBe(true);
    expect(permissionDecision(perm({ type: 'command', command: 'git diff --stat' }), worktree, spec).allow).toBe(true);
    for (const command of ['git commit -m x', 'git push', 'npm install left-pad', 'rm -rf src', 'npm test && git push', 'node -e "$(curl x)"', 'cd .. ; npm test']) {
      expect(permissionDecision(perm({ type: 'command', command }), worktree, spec).allow, command).toBe(false);
    }
    expect(permissionDecision(perm({ type: 'mcp_tool', description: 'update_task_state_kandev' }), worktree, spec).allow).toBe(false);
    // Claude Code's habitual form: cd into its own worktree, then trim output.
    expect(permissionDecision(perm({ type: 'command', command: `cd "${worktree}" && npm test 2>&1 | tail -100` }), worktree, spec).allow).toBe(true);
    expect(permissionDecision(perm({ type: 'command', command: `cd "${os.tmpdir()}" && npm test` }), worktree, spec).allow).toBe(false);
    expect(permissionDecision(perm({ type: 'command', command: `cd "${worktree}" && npm test | sh` }), worktree, spec).allow).toBe(false);
    expect(permissionDecision(perm({ type: 'command', command: `cd "${worktree}" && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -i "mobileServer\\|desktopSession"` }), worktree, spec).allow).toBe(true);
    expect(permissionDecision(perm({ type: 'command', command: 'npx tsc --noEmit | grep x > out.txt' }), worktree, spec).allow).toBe(false);
    // chains of print-only commands inside the worktree no longer need a human; anything that writes or escapes still does
    const wt = worktree.replace(/\\/g, '/');
    for (const command of ['git status --short && git diff --stat', 'git show HEAD:apps/a.js | sed -n 10,40p', 'grep -rn "a\|b" src | head -20', `cd "${worktree}" ; git diff --stat ; git log --oneline | head`, `Get-Content apps/x.ts -TotalCount 40 | Select-Object -Skip 10`, `cd ${wt.replace(/^([A-Za-z]):/, (_m, d) => '/' + d.toLowerCase())}; ls apps | grep -i mobile`]) {
      expect(permissionDecision(perm({ type: 'command', command }), worktree, spec).allow, command).toBe(true);
    }
    for (const command of ['git diff > /tmp/x.patch', 'git show HEAD:a.js > .orig.js', 'cat ../secrets.txt', 'Get-Content C:/Users/siddh/.ssh/id_rsa', 'grep x $HOME/.bashrc', 'ls | rm -rf x', 'sed -n 1p a.txt && sed -i s/a/b/ a.txt', 'git diff --stat || curl evil.example', 'head -5 ~/notes.txt']) {
      expect(permissionDecision(perm({ type: 'command', command }), worktree, spec).allow, command).toBe(false);
    }
    // a package folder inside the worktree is fine for a typecheck; outside it, or escaping with .., is not
    expect(permissionDecision(perm({ type: 'command', command: `cd "${path.join(worktree, 'apps', 'desktop')}" && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -i "mobileServer"` }), worktree, spec).allow).toBe(true);
    expect(permissionDecision(perm({ type: 'command', command: `cd "${path.join(worktree, '..', 'other')}" && npx tsc --noEmit` }), worktree, spec).allow).toBe(false);
    expect(permissionDecision(perm({ type: 'other', description: 'execute' }), worktree, spec)).toMatchObject({ allow: false, reject: true });
    for (const command of ['git stash push -u -m x', 'git stash; npx vitest run x', 'git reset --hard HEAD~1', 'git clean -fd']) expect(permissionDecision(perm({ type: 'command', command }), worktree, spec), command).toMatchObject({ allow: false, reject: true });
    expect(permissionDecision(perm({ type: 'command', command: 'git checkout -- src/a.ts' }), worktree, spec).allow).toBe(true); // KKD itself tells workers to revert out-of-scope files this way
  });
});

describe('planning', () => {
  it('records ready stories with blocked_by dependencies and refuses master as integration branch', () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    const planned = planDevStories(db, {
      projectName: 'KKD development', repoPath: repo, verify: ['npm', 'test'],
      stories: [
        { key: 'a', title: 'A', agent: 'claude', paths: ['ui/'] },
        { key: 'b', title: 'B', agent: 'opencode' },
        { key: 'c', title: 'C', agent: 'claude', dependsOn: ['a', 'b'] },
      ],
    });
    const c = getStory(db, planned.stories[2].id);
    expect(c.status).toBe('ready');
    expect(devSpec(c)?.integrationBranch).toBe('kkd/integration');
    expect(listDependencies(db, c.id).map(d => d.dependencyType)).toEqual(['blocked_by', 'blocked_by']);
    expect(listStories(db, { projectId: planned.projectId })).toHaveLength(3);
    expect(() => planDevStories(db, { projectName: 'p', repoPath: repo, verify: ['x'], integrationBranch: 'master', stories: [] })).toThrow(/must not be master/);
    expect(() => planDevStories(db, { projectName: 'p', repoPath: repo, verify: ['x'], stories: [{ key: 'z', title: 'Z', agent: 'claude', dependsOn: ['nope'] }] })).toThrow(/unknown key/);
  });
});

describe('worker boundaries', () => {
  it('rejects workers driving Kandev or personal memory, outright rather than asking the user', () => {
    for (const title of ['mcp__kandev__update_task_state_kandev', 'mcp__kandev__resolve_agent_permission_kandev', 'kandev_remove_task_dependency_kandev', 'create_task_kandev']) {
      expect(permissionDecision({ ...perm({ type: 'other' }), title }, worktree, spec), title).toMatchObject({ allow: false, reject: true });
    }
    expect(permissionDecision({ ...perm({ type: 'other' }), title: 'mcp__engram__mem_save' }, worktree, spec)).toMatchObject({ allow: false, reject: true });
    // A worktree path under the Kandev home is not mistaken for a Kandev tool call.
    const kHome = path.join(os.tmpdir(), '.kkd-kandev', 'tasks', 'update-readme_x1', 'repo');
    expect(permissionDecision(perm({ type: 'file_write', path: path.join(kHome, 'README.md') }), kHome, spec).allow).toBe(true);
  });

  it('gives Claude workers only the access token, never the refresh token or MCP OAuth tokens', async () => {
    const realHome = path.join(dir, 'home');
    fs.mkdirSync(path.join(realHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(realHome, '.claude', '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'at-1', refreshToken: 'rt-secret', expiresAt: Date.now() + 3_600_000, scopes: ['x'] },
      mcpOAuth: { slack: { accessToken: 'slack-secret' } },
    }));
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, KARKEDIKHA_KANDEV_HOME: process.env.KARKEDIKHA_KANDEV_HOME };
    process.env.USERPROFILE = realHome; process.env.HOME = realHome; process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'kandev');
    try {
      const { prepareWorkerProfile, workerHome } = await import('../runtime/kandev/workerProfile');
      const r = prepareWorkerProfile();
      expect(r.claude).toMatchObject({ present: true });
      const copied = fs.readFileSync(path.join(workerHome(), '.claude', '.credentials.json'), 'utf8');
      expect(copied).toContain('at-1');
      expect(copied).not.toContain('rt-secret');
      expect(copied).not.toContain('slack-secret');
      const settings = JSON.parse(fs.readFileSync(path.join(workerHome(), '.claude', 'settings.json'), 'utf8'));
      expect(settings.permissions.deny).toContain('mcp__kandev');
      expect(settings.permissions.deny.some((d: string) => d.startsWith('Read(') && d.includes('/.claude/**'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(workerHome(), '.config', 'opencode', 'service.json'), 'utf8')).port).not.toBe(49374);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('refuses a non-loopback Kandev URL', async () => {
    const { KandevClient } = await import('../runtime/kandev/kandevClient');
    expect(() => new KandevClient('http://192.168.1.20:38500')).toThrow(/127\.0\.0\.1/);
    expect(() => new KandevClient('http://127.0.0.1:38500')).not.toThrow();
    expect(() => new KandevClient('http://127.154.85.132:58455')).not.toThrow(); // launcher's random loopback endpoint
    expect(() => new KandevClient('http://10.0.0.5:58455')).toThrow(/127\.0\.0\.1/);
  });
});

describe('chat reporting', () => {
  it('posts each milestone and one final report exactly once, and not for stopped stories', async () => {
    const { createConversation, listMessages } = await import('../domain/conversations');
    const { addComment, transitionStory } = await import('../domain/stories');
    const { reportDevStoryProgress } = await import('../runtime/kandev/devStories');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    const planned = planDevStories(db, { projectName: 'P', repoPath: repo, verify: ['npm', 'test'], stories: [{ key: 'a', title: 'A', agent: 'claude' }, { key: 'b', title: 'B', agent: 'opencode', dependsOn: ['a'] }] });
    const conv = createConversation(db, { mode: 'baat_kar', title: 'chat', actor: 'user' });
    const [a, b] = planned.stories.map(s => s.id);
    for (const id of [a, b]) addComment(db, id, { author: 'kkd', body: `[kkd-dev:report-to] ${conv.id} batch=${a}` });
    const toDone = (id: string, sha: string) => {
      for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing', 'review', 'validation', 'delivery_approval', 'merge_queue', 'done'] as const) transitionStory(db, id, { toStatus: to, actor: 'kkd', reason: 't' });
      addComment(db, id, { author: 'kkd', body: `[kkd-dev:integrated] ${sha} on kkd/integration (branch x); passed.` });
    };
    toDone(a, 'aaa111');
    expect(reportDevStoryProgress(db)).toBe(1);
    expect(reportDevStoryProgress(db)).toBe(0);
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing', 'blocked'] as const) transitionStory(db, b, { toStatus: to, actor: 'kkd', reason: 't' });
    addComment(db, b, { author: 'user', body: '[kkd-dev:stopped] Stop All' });
    expect(reportDevStoryProgress(db)).toBe(0); // a stopped story is not "settled": no final report, no alarm
    // Resumed, then failed: once stopped earlier must not hide that the story now needs the user.
    addComment(db, b, { author: 'user', body: '[kkd-dev:retry] resume' });
    transitionStory(db, b, { toStatus: 'implementing', actor: 'kkd', reason: 't' });
    transitionStory(db, b, { toStatus: 'blocked', actor: 'kkd', reason: 't' });
    addComment(db, b, { author: 'kkd', body: '[kkd-dev:needs-human] Verification failed 3 times.' });
    expect(reportDevStoryProgress(db)).toBe(2); // "B needs you" + final "1 of 2"
    expect(listMessages(db, conv.id).map((m: any) => m.content).at(-2)).toMatch(/B\*\* needs you: Verification failed 3 times/);
    expect(reportDevStoryProgress(db)).toBe(0);
    addComment(db, b, { author: 'user', body: '[kkd-dev:retry] go' });
    transitionStory(db, b, { toStatus: 'implementing', actor: 'kkd', reason: 't' });
    for (const to of ['review', 'validation', 'delivery_approval', 'merge_queue', 'done'] as const) transitionStory(db, b, { toStatus: to, actor: 'kkd', reason: 't' });
    addComment(db, b, { author: 'kkd', body: '[kkd-dev:integrated] bbb222 on kkd/integration (branch y); passed.' });
    expect(reportDevStoryProgress(db)).toBe(2); // B integrated + updated final
    expect(reportDevStoryProgress(db)).toBe(0);
    const texts = listMessages(db, conv.id).map((m: any) => m.content);
    expect(texts.at(-1)).toMatch(/2 of 2 completed/);
    expect(texts.at(-1)).toMatch(/"B" started only after "A" were integrated/);
  });

  it('tells the chat when a worker action is waiting for a decision, once, and not after it was decided', async () => {
    const { createConversation, listMessages } = await import('../domain/conversations');
    const { addComment, transitionStory } = await import('../domain/stories');
    const { reportDevStoryProgress } = await import('../runtime/kandev/devStories');
    const repo = path.join(dir, 'repo2');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    const planned = planDevStories(db, { projectName: 'P2', repoPath: repo, verify: ['npm', 'test'], stories: [{ key: 'a', title: 'A', agent: 'claude' }] });
    const conv = createConversation(db, { mode: 'baat_kar', title: 'chat', actor: 'user' });
    const a = planned.stories[0].id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, a, { toStatus: to, actor: 'kkd', reason: 't' });
    addComment(db, a, { author: 'kkd', body: `[kkd-dev:report-to] ${conv.id} batch=${a}` });
    addComment(db, a, { author: 'kkd', body: '[kkd-dev:approval] p-1\ncommand needs a human: npx tsc --noEmit | grep x' });
    expect(reportDevStoryProgress(db)).toBe(1);
    expect(reportDevStoryProgress(db)).toBe(0);
    expect(listMessages(db, conv.id).at(-1)?.content).toMatch(/\*\*A\*\* is paused and needs your decision: command needs a human: npx tsc --noEmit/);
    addComment(db, a, { author: 'kkd', body: '[kkd-dev:approval] p-2\ncommand needs a human: git stash' });
    addComment(db, a, { author: 'user', body: '[kkd-dev:decided] Denied: git stash' });
    expect(reportDevStoryProgress(db)).toBe(0); // already decided: no stale alarm
    // A rejection by KKD's own check is announced too (once), so the repair loop is not invisible.
    addComment(db, a, { author: 'kkd', body: "[kkd-dev:verify-failed] KKD's independent acceptance check failed (0/1 cases pass)\n✗ phone API: leaks kandevTaskId" });
    expect(reportDevStoryProgress(db)).toBe(1);
    expect(reportDevStoryProgress(db)).toBe(0);
    expect(listMessages(db, conv.id).at(-1)?.content).toMatch(/rejected the worker's result \(attempt 1 of 3\).*leaks kandevTaskId/);
  });
});

describe('live worker narrative and the silence watchdog', () => {
  const setup = async () => {
    const { createConversation, listMessages } = await import('../domain/conversations');
    const { addComment, transitionStory, getStory: get } = await import('../domain/stories');
    const repo = path.join(dir, 'repo3');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    const planned = planDevStories(db, { projectName: 'P3', repoPath: repo, verify: ['npm', 'test'], stories: [{ key: 'a', title: 'A', agent: 'claude' }] });
    const conv = createConversation(db, { mode: 'baat_kar', title: 'chat', actor: 'user' });
    const id = planned.stories[0].id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing'] as const) transitionStory(db, id, { toStatus: to, actor: 'kkd', reason: 't' });
    addComment(db, id, { author: 'kkd', body: `[kkd-dev:report-to] ${conv.id} batch=${id}` });
    return { conv, id, story: () => get(db, id), listMessages, addComment };
  };

  it('relays the worker\'s own prose into the chat once, batched, and ignores tool calls', async () => {
    const { relayWorkerNarrative } = await import('../runtime/kandev/devStories');
    const t = await setup();
    const at = new Date().toISOString();
    const kandev: any = { agentMessages: async () => [
      { id: '1', at, kind: 'tool_execute', text: 'npx vitest run' },
      { id: '2', at, kind: 'message', text: 'All relevant tests pass; now fixing the phone API so it no longer returns the Kandev task id.' },
    ] };
    expect(await relayWorkerNarrative(db, kandev, t.story(), 'sess')).toBe(true);
    expect(t.listMessages(db, t.conv.id).at(-1)?.content).toMatch(/\*\*A\*\* \(claude\): All relevant tests pass; now fixing the phone API/);
    expect(t.listMessages(db, t.conv.id).at(-1)?.content).not.toMatch(/vitest/);
    expect(await relayWorkerNarrative(db, kandev, t.story(), 'sess')).toBe(false); // throttled and not repeated
  });

  it('does not resend or restart a session that dropped a correction: one fresh repair session, then park', async () => {
    const { nudgeIfSilent } = await import('../runtime/kandev/devStories');
    const t = await setup();
    t.addComment(db, t.id, { author: 'kkd', body: '[kkd-dev:verify-failed] check failed\n✗ phone API leaks kandevTaskId' });
    t.addComment(db, t.id, { author: 'kkd', body: `[kkd-dev:feedback-sent] @${new Date().toISOString()} KarkeDikha verification failed` });
    const calls: string[] = [];
    // Dispatching the fresh task is not available in this mock, so the repair parks; what matters is what was (not) sent.
    const kandev: any = {
      agentMessages: async () => [], pendingPermissions: async () => [], latestTurn: async () => ({ started_at: '2025-12-31T00:00:00.000Z', completed_at: '2025-12-31T00:01:00.000Z' }),
      ensureRunning: async () => {}, defaultWorkspaceId: async () => 'ws', taskByExternalId: async () => ({ id: 'task', state: 'IN_PROGRESS' }),
      sessions: async () => [{ id: 'sess', state: 'COMPLETED' }], sessionStatus: async () => ({ is_agent_running: false }),
      stopTask: async () => { calls.push('stop'); }, relaunchSession: async () => { calls.push('relaunch'); }, sendMessage: async () => { calls.push('send'); },
      setTaskState: async () => {}, rest: async () => null,
    };
    // too recent: nothing happens
    expect(await nudgeIfSilent(db, kandev, t.story(), 'task', 'sess')).toBe(false);
    db.run("UPDATE story_comments SET body = '[kkd-dev:feedback-sent] @2026-01-01T00:00:00.000Z KarkeDikha verification failed' WHERE storyId = ? AND body LIKE '[kkd-dev:feedback-sent]%'", [t.id]);
    // no turn started after the message: the correction was dropped -> a fresh session on the preserved work, never a resend
    expect(await nudgeIfSilent(db, kandev, t.story(), 'task', 'sess')).toBe(true);
    expect(calls).not.toContain('send');
    expect(calls).not.toContain('relaunch');
    const bodies = () => db.all<{ body: string }>('SELECT body FROM story_comments WHERE storyId = ? ORDER BY createdAt, rowid', [t.id]).map(r => r.body);
    expect(bodies().some(b => b.startsWith('[kkd-dev:retry] [kkd-dev:repair]'))).toBe(true);
    // the repaired session fails the same way: no second repair, the story is parked with the reason
    t.addComment(db, t.id, { author: 'kkd', body: '[kkd-dev:feedback-sent] @2026-01-01T00:00:00.000Z again' });
    await nudgeIfSilent(db, kandev, t.story(), 'task', 'sess');
    expect(bodies().filter(b => b.startsWith('[kkd-dev:retry] [kkd-dev:repair]')).length).toBe(1);
    expect(bodies().some(b => /\[kkd-dev:parked\].*same problem/.test(b))).toBe(true);
    expect(calls).not.toContain('send');
  }, 30_000);

  it('does not count a boot log as progress, acknowledges delivery, and allows long tools', async () => {
    const { nudgeIfSilent } = await import('../runtime/kandev/devStories');
    const t = await setup();
    const old = '2026-01-01T00:00:00.000Z';
    t.addComment(db, t.id, { author: 'kkd', body: '[kkd-dev:verify-failed] check failed' });
    t.addComment(db, t.id, { author: 'kkd', body: `[kkd-dev:feedback-sent] @${old} failed` });
    db.run("UPDATE story_comments SET createdAt = ? WHERE storyId = ?", [old, t.id]);
    const calls: string[] = [];
    let msgs: any[] = [{ id: 'b', at: '2026-01-01T00:00:05.000Z', kind: 'script_execution', text: 'boot' }];
    const kandev: any = {
      agentMessages: async () => msgs, pendingPermissions: async () => [],
      latestTurn: async () => ({ started_at: '2026-01-01T00:00:06.000Z' }),
      ensureRunning: async () => {}, defaultWorkspaceId: async () => 'ws', taskByExternalId: async () => ({ id: 'task', state: 'IN_PROGRESS' }),
      sessions: async () => [{ id: 'sess', state: 'COMPLETED' }], sessionStatus: async () => ({ is_agent_running: false }),
      stopTask: async () => { calls.push('stop'); }, relaunchSession: async () => { calls.push('relaunch'); }, sendMessage: async () => { calls.push('send'); },
      setTaskState: async () => {}, rest: async () => null,
    };
    // delivered (a turn started) but only a boot log: silent -> fresh session, not a restart of this one
    expect(await nudgeIfSilent(db, kandev, t.story(), 'task', 'sess')).toBe(true);
    expect(calls).not.toContain('relaunch');
    expect(calls).not.toContain('send');
    expect(db.all("SELECT body FROM story_comments WHERE storyId = ? AND body LIKE '[kkd-dev:delivered]%'", [t.id]).length).toBe(1);
    // a still-running tool is not silence
    calls.length = 0;
    db.run("UPDATE story_comments SET createdAt = ? WHERE storyId = ?", [old, t.id]);
    db.run("UPDATE story_comments SET body = ? WHERE storyId = ? AND body LIKE '[kkd-dev:feedback-sent]%'", [`[kkd-dev:feedback-sent] @${old} failed`, t.id]);
    msgs = [{ id: 'x', at: new Date().toISOString(), kind: 'tool_execute', text: 'npx vitest', status: 'running' }];
    expect(await nudgeIfSilent(db, kandev, t.story(), 'task', 'sess')).toBe(false);
    expect(calls).toEqual([]);
  }, 30_000);
});

describe('task detail for clients', () => {
  it('leaves out Kandev ids and private filesystem locations, and keeps the useful text', async () => {
    const { addComment, transitionStory } = await import('../domain/stories');
    const { devStoryDetail } = await import('../runtime/kandev/devStories');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    const planned = planDevStories(db, { projectName: 'P', repoPath: repo, verify: ['npm', 'test'], stories: [{ key: 'a', title: 'A', agent: 'claude' }] });
    const id = planned.stories[0].id;
    for (const to of ['assigned', 'planning', 'proposal_approval', 'implementing', 'blocked'] as const) transitionStory(db, id, { toStatus: to, actor: 'kkd', reason: 't' });
    addComment(db, id, { author: 'kkd', body: '[kkd-dev:needs-human] Verification failed. Kandev task t-1, worktree C:\\Users\\me\\.kkd-kandev\\tasks\\a\\repo and /home/me/x/y, share \\\\srv\\share\\z.' });
    addComment(db, id, { author: 'user', body: '[kkd-dev:decided] Allowed: cd "C:\\Users\\me\\.kkd-kandev\\tasks\\a\\repo" && npm test' });
    const detail = await devStoryDetail(db, { healthy: async () => false } as any, id);
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/Users|\.kkd-kandev|\/home\/me|srv|kandevTaskId":"/);
    expect(detail.story.kandevTaskId).toBeNull();
    expect(detail.timeline.map(t => t.event)).toEqual(['needs-human', 'decided']);
    expect(detail.timeline[0].text).toMatch(/Verification failed\. Kandev task t-1, worktree <path> and <path>, share <path>\./);
    expect(detail.timeline[1].text).toMatch(/Allowed: cd "<path>" && npm test/);
  });
});

describe('worker approval authority', () => {
  it('a spoofed desktop client id with only the Core bearer token is not the Panda host', async () => {
    const { deriveRequestPrincipal } = await import('../api/server');
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as import('node:http').IncomingMessage;
    const spoof = deriveRequestPrincipal(req({ authorization: 'Bearer core', 'x-client-id': 'desktop_fake' }), 'core', 'op', 'host', 'desktop_fake');
    expect(spoof.isTrustedHost).toBe(false);
    const real = deriveRequestPrincipal(req({ authorization: 'Bearer core', 'x-host-token': 'host', 'x-client-id': 'desktop_x' }), 'core', 'op', 'host', 'desktop_x');
    expect(real.isTrustedHost).toBe(true);
  });

  it('a double-quoted command substitution is not a read-only command', () => {
    expect(permissionDecision(perm({ type: 'command', command: 'grep "$(node evil.js)" src/a.ts' }), worktree, spec).allow).toBe(false);
  });
});

describe('WIP slot reclamation', () => {
  it('moves only idle finished tasks out of In Progress, never a live worker, a pending approval, or another step', async () => {
    const { reclaimIdleWipSlots } = await import('../runtime/kandev/devStories');
    const tasks = [
      { id: 'idle-review', state: 'REVIEW', workflow_step_id: 'run' },       // finished, no worker: reclaimed
      { id: 'idle-done', state: 'COMPLETED', workflow_step_id: 'run' },      // other batch, integrated: reclaimed
      { id: 'live', state: 'REVIEW', workflow_step_id: 'run' },              // session still RUNNING: kept
      { id: 'asking', state: 'REVIEW', workflow_step_id: 'run' },            // waiting on a permission: kept
      { id: 'working', state: 'IN_PROGRESS', workflow_step_id: 'run' },      // active: kept
      { id: 'backlog-review', state: 'REVIEW', workflow_step_id: 'backlog' },// other step: kept
      { id: 'unknown', state: 'REVIEW', workflow_step_id: 'run' },           // session lookup fails: kept
    ];
    const sessionState: Record<string, string> = { 'idle-review': 'COMPLETED', 'idle-done': 'COMPLETED', live: 'RUNNING', asking: 'WAITING_FOR_INPUT' };
    const moves: Array<{ task_id: string; workflow_step_id: string }> = [];
    const kandev: any = {
      tool: async (name: string, args: any) => { if (name === 'list_tasks_kandev') return { tasks }; if (name === 'move_task_kandev') moves.push(args); return {}; },
      sessions: async (id: string) => { if (id === 'unknown') throw new Error('boom'); return sessionState[id] ? [{ id: 's', state: sessionState[id] }] : []; },
      pendingPermissions: async (id: string) => (id === 'asking' ? [{ pending_id: 'p' }] : []),
    };
    expect(await reclaimIdleWipSlots(kandev, 'wf', 'run', 'review')).toEqual(['idle-review', 'idle-done']);
    expect(moves).toEqual([{ task_id: 'idle-review', workflow_id: 'wf', workflow_step_id: 'review' }, { task_id: 'idle-done', workflow_id: 'wf', workflow_step_id: 'review' }]);
  });
});
