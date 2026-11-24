/**
 * KKD development stories executed by Kandev.
 *
 * Ownership split (see docs/KANDEV_INTEGRATION.md):
 * - KKD Core stays authoritative for the story, its dependencies, approvals, verification and integration.
 * - Kandev owns execution: dependency-gated starts (`blocked_by`), the parallel worker limit (WIP), agent launch
 *   over ACP (Claude Code, OpenCode, Antigravity, Hermes), per-task git worktrees, and native session resume.
 *
 * A Kandev task is bound to a story by `external_id = story.id` (Kandev de-duplicates on it), so no mapping table is
 * kept. Kandev may say a worker's turn is over; only KKD decides a story is done: it re-runs the story's verify command
 * in the worker's worktree, merges through one integration queue onto a local integration branch (never the user's
 * checkout, never master, never pushed), re-verifies there, and only then marks the Kandev task COMPLETED — which is
 * what releases dependents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { CoreDatabase } from '../../db/connection';
import type { StoryRecord, StoryStatus } from '../../shared/wireTypes';
import { addComment, createStory, getStory, listComments, listStories, transitionStory } from '../../domain/stories';
import { addDependency } from '../../domain/dependencies';
import { recordStoryEvent } from '../../domain/events';
import { createProject, listProjects } from '../../domain/projects';
import { CoreError } from '../../domain/errors';
import { runHardenedGit } from '../../security/hardenedGit';
import { findUnsafeDeliveryPaths } from '../missionDeliveryManifest';
import { appendMessage } from '../../domain/conversations';
import { latestRuntimeSequence, listRuntimeEventsAfter } from '../../domain/runtimeEvents';
import type { RuntimeEventRecord } from '../../shared/wireTypes';
import { KandevClient, kandevHome, type KandevPermission, type KandevSession } from './kandevClient';
import { prepareWorkerProfile } from './workerProfile';
import { gpuLaneLimit } from '../hardwareCapacity';
import { readChangeDiff, unavailableDiff, type ChangeDiff } from './changeDiff';
import { automatedChecks, deviceChecks, examineDiff, runAcceptance, validateAcceptanceChecks, type AcceptanceCheck, type VerificationLevel } from './storyAcceptance';
import { compareTestRuns, judgeTests, runProjectTests, type ProjectTestRun } from './projectTests';

export const DEV_ACTOR = 'kkd:dev-coordinator';
const MAX_VERIFY_RETRIES = 2;
/** A worker process that died mid-turn is resumed in the same session this many times before the story needs a person. */
const MAX_CRASH_RESUMES = 2;
export const CRASH_TAG = '[kkd-dev:worker-crashed]';
const RESUME_TEXT = 'Your previous run was interrupted: the worker process stopped before you finished. Your working directory is as you left it. Continue the task from where you were and finish it.';
const MAX_WORKERS = Number(process.env.KARKEDIKHA_KANDEV_MAX_WORKERS || 2);
const DEFAULT_CLAUDE_MODEL = process.env.KARKEDIKHA_KANDEV_CLAUDE_MODEL || 'sonnet';

export type DevAgent = 'claude' | 'opencode' | 'antigravity' | 'hermes';
export const AGENT_IDS: Record<DevAgent, string> = { claude: 'claude-acp', opencode: 'opencode-acp', antigravity: 'antigravity-acp', hermes: 'hermes-acp' };
/** Agents whose default model runs on the local GPU; at most one of them runs at a time. */
const GPU_AGENTS = new Set<DevAgent>(['opencode', 'hermes']);
export const usesLocalGpu = (spec: Pick<DevStorySpec, 'agent' | 'model'>) => GPU_AGENTS.has(spec.agent) && (!spec.model || /^(ollama|llama|local)/i.test(spec.model));

export interface DevStorySpec {
  kind: 'kkd-dev-story';
  repoPath: string;
  baseBranch: string;
  integrationBranch: string;
  /** Command run in the worktree, then again on the integration branch. Executed without a shell. */
  verify: string[];
  agent: DevAgent;
  model?: string;
  /** Files/directories the story is expected to touch; overlaps are serialized. */
  paths?: string[];
  /** KKD-owned acceptance checks. They live on the story in KKD's database, never in a worktree, and the worker never sees them. */
  acceptance?: AcceptanceCheck[];
  /**
   * `inspect`: a read-only look at an authorized project. The repoPath is a private clone of it; the worker may read and run
   * the tests but not change files. KKD verifies nothing changed (in the clone and in the source checkout) and the worker's
   * final report is the result, labelled worker-only. There is no diff, no integration and no merge.
   */
  mode?: 'inspect';
  inspect?: { projectName: string; sourcePath: string; ref: string; sourceHead: string; sourceStatusSha: string };
  /**
   * With `mode: 'inspect'`: a task that names no project and only asks for an answer (a reply, a status). The worktree is an empty
   * folder; the same read-only rules and checks apply, and the worker's final message, however short, is the result.
   */
  answerOnly?: true;
  /** Most changed files accepted at verification; more fails it with the list (A5 code changes). */
  maxFiles?: number;
  /**
   * A5: a change requested through the bridge and approved by the owner. repoPath is a private copy (no remote) of this project; the
   * owner's checkout at sourcePath is never written by KKD or the worker. The result is a branch in the copy.
   */
  codeCopy?: {
    projectName: string; sourcePath: string; ref: string; sourceHead: string; sourceStatusSha: string;
    /** The task asked for tests: at least one new (or newly passing) test is required, as Pandesh's own test run sees it. */
    testsRequested?: boolean;
    /** A mission step's 1-based position in the mission's plan (stories of one plan share a creation time, so it is kept here). */
    step?: number;
    /**
     * The owner's development grant for a multi-step mission (given once, on the mission's approval card): a step whose change passes
     * Pandesh's own test run (tests ran, no regression, no failing new test) and whose diff raises no review flag is committed onto the
     * integration branch IN THE PRIVATE COPY without a further click, so the next step can start. Bounded by expiry and revocable
     * ([kkd-dev:grant-revoked]); anything else still waits for the owner's review. Delivery into the owner's checkout, push and merge are
     * never covered.
     */
    grant?: { id: string; expiresAt: string; steps: number };
  };
}

/** Fingerprint of a checkout's HEAD and working-tree state (read-only git), used to prove an inspection did not touch it. */
export function checkoutFingerprint(dir: string): { head: string; statusSha: string } | null {
  const head = runHardenedGit(['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  const status = runHardenedGit(['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (head.status !== 0 || status.status !== 0) return null;
  return { head: String(head.stdout).trim(), statusSha: createHash('sha256').update(String(status.stdout)).digest('hex') };
}

export function devSpec(story: StoryRecord): DevStorySpec | null {
  const spec = (story.source as { devStory?: DevStorySpec } | null)?.devStory;
  return spec?.kind === 'kkd-dev-story' ? spec : null;
}

// ---------------------------------------------------------------- planning

export interface PlanInput {
  projectName: string;
  repoPath: string;
  baseBranch?: string;
  integrationBranch?: string;
  verify: string[];
  stories: Array<{
    key: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
    agent: DevAgent;
    model?: string;
    paths?: string[];
    verify?: string[];
    dependsOn?: string[];
    /** Independently prepared checks KKD runs against the worker's result (see storyAcceptance.ts). */
    acceptanceChecks?: unknown[];
    /** Read-only inspection of an authorized project (see DevStorySpec.mode). */
    mode?: 'inspect';
    inspect?: DevStorySpec['inspect'];
    /** With mode 'inspect': an answer-only task with no project (see DevStorySpec.answerOnly). */
    answerOnly?: boolean;
    maxFiles?: number;
    codeCopy?: DevStorySpec['codeCopy'];
  }>;
}

/** Creates the stories and their blocked_by dependencies in KKD (authoritative). Nothing runs yet. */
export function planDevStories(db: CoreDatabase, input: PlanInput): { projectId: string; stories: Array<{ key: string; id: string }> } {
  const repoPath = path.resolve(input.repoPath);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new CoreError('invalid_request', `${repoPath} is not a git checkout`);
  const baseBranch = input.baseBranch || 'main';
  const integrationBranch = input.integrationBranch || 'kkd/integration';
  if (/^(master|main)$/.test(integrationBranch)) throw new CoreError('invalid_request', 'the integration branch must not be master/main');
  const keys = new Set(input.stories.map(s => s.key));
  for (const s of input.stories) {
    for (const d of s.dependsOn ?? []) if (!keys.has(d)) throw new CoreError('invalid_request', `story '${s.key}' depends on unknown key '${d}'`);
    if (!AGENT_IDS[s.agent]) throw new CoreError('invalid_request', `story '${s.key}': agent must be one of ${Object.keys(AGENT_IDS).join(', ')}`);
  }
  const acceptance = Object.fromEntries(input.stories.map(s => [s.key, validateAcceptanceChecks(s.key, s.acceptanceChecks)]));
  return db.transaction(() => {
    const project = listProjects(db, { limit: 200 }).find(p => p.name === input.projectName) ?? createProject(db, { name: input.projectName });
    const ids = new Map<string, string>();
    for (const s of input.stories) {
      const spec: DevStorySpec = {
        kind: 'kkd-dev-story', repoPath, baseBranch, integrationBranch, verify: s.verify?.length ? s.verify : input.verify,
        agent: s.agent, model: s.model, paths: s.paths,
        ...(acceptance[s.key].length ? { acceptance: acceptance[s.key] } : {}),
        ...(s.mode === 'inspect' ? { mode: 'inspect' as const, ...(s.inspect ? { inspect: s.inspect } : {}), ...(s.answerOnly ? { answerOnly: true as const } : {}) } : {}),
        ...(s.mode !== 'inspect' && s.codeCopy ? { codeCopy: s.codeCopy } : {}),
        ...(Number.isInteger(s.maxFiles) && s.maxFiles! > 0 ? { maxFiles: s.maxFiles } : {}),
      };
      const story = createStory(db, {
        projectId: project.id, title: s.title, description: s.description ?? '', acceptanceCriteria: s.acceptanceCriteria ?? [],
        storyType: 'story', status: 'ready', assignee: { agent: s.agent, model: s.model ?? null }, source: { devStory: spec }, actor: DEV_ACTOR,
      });
      ids.set(s.key, story.id);
    }
    for (const s of input.stories) {
      for (const d of s.dependsOn ?? []) {
        addDependency(db, { storyId: ids.get(s.key)!, dependsOnStoryId: ids.get(d)!, dependencyType: 'blocked_by', actor: DEV_ACTOR });
      }
    }
    return { projectId: project.id, stories: input.stories.map(s => ({ key: s.key, id: ids.get(s.key)! })) };
  });
}

// ---------------------------------------------------------------- dispatch

function predecessors(db: CoreDatabase, storyId: string): string[] {
  return db.all<{ dependsOnStoryId: string }>(
    "SELECT dependsOnStoryId FROM story_dependencies WHERE storyId = ? AND dependencyType = 'blocked_by'", [storyId],
  ).map(r => r.dependsOnStoryId);
}

function topoOrder(db: CoreDatabase, stories: StoryRecord[]): StoryRecord[] {
  const byId = new Map(stories.map(s => [s.id, s]));
  const out: StoryRecord[] = [];
  const seen = new Set<string>();
  const visit = (s: StoryRecord) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    for (const p of predecessors(db, s.id)) { const ps = byId.get(p); if (ps) visit(ps); }
    out.push(s);
  };
  stories.forEach(visit);
  return out;
}

function overlaps(a: string[] = [], b: string[] = []): string[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return a.filter(x => b.some(y => { const nx = norm(x), ny = norm(y); return nx === ny || nx.startsWith(ny + '/') || ny.startsWith(nx + '/'); }));
}

export function workerPrompt(story: StoryRecord, spec: DevStorySpec): string {
  if (spec.mode === 'inspect' && spec.answerOnly) {
    return [
      `Task: ${story.title}`,
      story.description ? `\n${story.description}` : '',
      '\nThis task needs no project. Your working directory is an empty folder that holds nothing of the owner\'s.',
      'It is ANSWER-ONLY: do NOT create, edit or delete any file, do NOT commit, push or change any Kandev task state, and do not look outside the working directory.',
      'Do what the task asks, then write your answer as your last message and stop. If you cannot do it without changing files, say so plainly in that message.',
    ].join('\n');
  }
  if (spec.codeCopy) {
    return [
      `Task: ${story.title}`,
      story.description ? `\n${story.description}` : '',
      `\nYour CURRENT WORKING DIRECTORY is your own worktree of a private copy of ${spec.codeCopy.projectName} at branch ${spec.codeCopy.ref}. Make the change here. If the task names a path on this PC, that is the owner's checkout: never read or write it; use the same relative path in your working directory.`,
      'Name files by paths RELATIVE to your working directory (src/index.js, test/index.test.js), or absolute paths that start with your working directory (run `pwd` once if unsure). The folder named in your memory or settings instructions is NOT this project: never build file paths from it. Any read or write outside your working directory is refused automatically.',
      `\nRules: change at most ${spec.maxFiles ?? 'a few'} files and only what the task needs. Run the existing tests for the code you touch with single plain commands (no \`&&\`, no \`cd\`). Do NOT commit, push, merge, switch branches, add remotes, install packages or change any Kandev task state: KarkeDikha verifies the change, the owner reviews it, and only then is it committed to a branch in this copy.`,
      'This is a CODE CHANGE task: the owner approved changing files in this copy. Make the requested change and add or update tests for it when the task asks for tests. Pandesh runs the project\'s tests itself before and after your change: do not weaken, skip or delete existing tests, and do not fix unrelated failing tests unless the task asks (report them instead).',
      'If the change cannot be made here, change nothing and say plainly why in your last message. When done, stop and summarise exactly what you changed and which tests you ran with their results.',
    ].join('\n');
  }
  if (spec.mode === 'inspect') {
    return [
      `Task: ${story.title}`,
      story.description ? `\n${story.description}` : '',
      `\nThe repository to inspect is your CURRENT WORKING DIRECTORY: a private copy of ${spec.inspect?.projectName ?? 'the project'} at branch ${spec.inspect?.ref ?? 'the requested branch'}. If the task names a path on this PC, that is the owner's own checkout: do not read it, use relative paths in your working directory instead.`,
      '\nThis is a READ-ONLY inspection. Rules: read and search files freely; run the existing tests with single plain commands (for example `npx vitest run <test files>`); do NOT create, edit or delete any file, do NOT commit, push, switch branches, install packages or change any Kandev task state.',
      'Run commands one at a time (no `&&` chains, no `cd`). When you are done, stop and write the final report as your last message: what you inspected, which tests you ran with their exact results, and each defect you found with file and line, or state plainly that you found none.',
    ].join('\n');
  }
  return [
    `Story: ${story.title}`,
    story.description ? `\n${story.description}` : '',
    story.acceptanceCriteria.length ? `\nAcceptance criteria:\n${story.acceptanceCriteria.map(c => `- ${c}`).join('\n')}` : '',
    spec.paths?.length ? `\nExpected files/areas: ${spec.paths.join(', ')}` : '',
    `\nVerify your work by running: ${spec.verify.join(' ')}`,
    automatedChecks(spec.acceptance ?? []).length ? 'KarkeDikha also runs its own independent acceptance checks on the result. They are not visible to you, so implement the criteria generally, not for particular inputs, and do not edit or delete existing tests to make them pass.' : '',
    '\nRules: work only inside this worktree. Do NOT commit, push, merge or switch branches, and do NOT change any Kandev task state —',
    'KarkeDikha verifies, commits and integrates your changes itself. Run commands one at a time (no `&&` chains or `cd`).',
    'When the work is done and verification passes, stop and summarize what you changed.',
  ].join('\n');
}

/** A worker held on a person's decision for this long, with no live session, stops holding a worker slot. */
export const STALE_DECISION_MS = 30 * 60_000;

interface KandevContext { workspaceId: string; workflowId: string; executorProfileId: string; backlogStepId?: string; runningStepId?: string }

/**
 * Kandev counts every task in "In Progress" against the WIP limit, running or not. A task left there without a worker
 * (stopped, or finished and waiting for KKD) silently takes a worker slot away: with a limit of 2 and one such task,
 * workers ran one at a time. Task REVIEW also means "worker is waiting on a permission", so a task is only moved when it
 * provably holds no worker: no live session and nothing pending. Returns the ids moved.
 */
export async function reclaimIdleWipSlots(kandev: KandevClient, workflowId: string, runningStepId: string, reviewStepId: string, now = Date.now()): Promise<string[]> {
  const { tasks } = await kandev.tool<{ tasks: Array<{ id: string; state: string; workflow_step_id?: string; updated_at?: string }> }>('list_tasks_kandev', { workflow_id: workflowId });
  const moved: string[] = [];
  for (const t of tasks.filter(t => t.workflow_step_id === runningStepId && (t.state === 'REVIEW' || t.state === 'COMPLETED'))) {
    const sessions = await kandev.sessions(t.id).catch(() => null);
    if (!sessions || sessions[0]?.state === 'RUNNING' || sessions[0]?.state === 'STARTING') continue; // unknown or live
    const pending = await kandev.pendingPermissions(t.id).catch(() => null);
    if (!pending) continue; // unknown: the worker may still be alive
    // A recent wait on a decision keeps its slot. One nobody has answered for STALE_DECISION_MS (an abandoned test, a Core that
    // is gone) is moved out of In Progress: its session and its pending request are left exactly as they are, so a late
    // decision still reaches the worker, but it no longer takes a slot from new work (seen 2026-11-21: one such task, two days
    // old, left a two-worker limit running one worker at a time).
    if (pending.length && !(Date.parse(t.updated_at ?? '') < now - STALE_DECISION_MS)) continue;
    await kandev.tool('move_task_kandev', { task_id: t.id, workflow_id: workflowId, workflow_step_id: reviewStepId });
    moved.push(t.id);
  }
  return moved;
}

async function kandevContext(kandev: KandevClient): Promise<KandevContext> {
  const workspaceId = await kandev.defaultWorkspaceId();
  const { workflows } = await kandev.tool<{ workflows: Array<{ id: string }> }>('list_workflows_kandev', { workspace_id: workspaceId });
  const workflowId = workflows[0].id;
  const { steps } = await kandev.tool<{ steps: Array<{ id: string; name: string; wip_limit?: number }> }>('list_workflow_steps_kandev', { workflow_id: workflowId });
  const running = steps.find(s => s.name === 'In Progress');
  const review = steps.find(s => s.name === 'Review');
  if (running && running.wip_limit !== MAX_WORKERS) await kandev.tool('update_workflow_step_kandev', { step_id: running.id, wip_limit: MAX_WORKERS });
  if (running && review) await reclaimIdleWipSlots(kandev, workflowId, running.id, review.id);
  const { executors } = await kandev.tool<{ executors: Array<{ type: string; profiles?: Array<{ id: string }> }> }>('list_executors_kandev', {});
  const worktree = executors.find(e => e.type === 'worktree')?.profiles?.[0]?.id;
  if (!worktree) throw new Error('Kandev has no worktree executor profile');
  return { workspaceId, workflowId, executorProfileId: worktree, backlogStepId: steps.find(s => s.name === 'Backlog')?.id, runningStepId: running?.id };
}

async function profileFor(kandev: KandevClient, agent: DevAgent, model: string | undefined): Promise<string> {
  const { agents } = await kandev.tool<{ agents: Array<{ id: string; name: string; capability_status?: string; capability_error?: string; profiles?: Array<{ id: string; name: string; model: string; auto_approve: boolean }> }> }>('list_agents_kandev', {});
  const entry = agents.find(a => a.name === AGENT_IDS[agent]);
  if (!entry) throw new Error(`${agent} is not installed for Kandev (${AGENT_IDS[agent]} missing)`);
  if (entry.capability_status === 'failed') {
    const fresh = await kandev.reprobeAgent(entry.name);
    if (fresh) { entry.capability_status = fresh.status; entry.capability_error = fresh.error ?? ''; }
  }
  if (entry.capability_status && entry.capability_status !== 'ok') throw new Error(`${agent} is not usable in Kandev: ${entry.capability_status} ${entry.capability_error ?? ''}`.trim());
  const want = agent === 'claude' ? (model || DEFAULT_CLAUDE_MODEL) : model;
  const safe = (entry.profiles ?? []).filter(p => !p.auto_approve);
  const match = want ? safe.find(p => p.model === want) : safe[0];
  if (match) return match.id;
  if (!want) throw new Error(`${agent} has no Kandev profile without auto-approve`);
  const created = await kandev.tool<{ id: string }>('create_agent_profile_kandev', { agent_id: entry.id, name: `KKD ${want}`, model: want, auto_approve: false });
  return created.id;
}

async function kandevRepositoryId(kandev: KandevClient, workspaceId: string, spec: DevStorySpec): Promise<string> {
  const { repositories } = await kandev.tool<{ repositories?: Array<{ id: string; local_path?: string }> }>('list_repositories_kandev', { workspace_id: workspaceId });
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const found = (repositories ?? []).find(r => r.local_path && norm(r.local_path) === norm(spec.repoPath));
  if (found) return found.id;
  const created = await kandev.rest<{ id: string }>('POST', `/workspaces/${workspaceId}/repositories`, {
    name: path.basename(spec.repoPath), source_type: 'local', local_path: spec.repoPath.replace(/\\/g, '/'), default_branch: spec.baseBranch,
  });
  return created.id;
}

function walk(db: CoreDatabase, story: StoryRecord, chain: StoryStatus[], reason: string): StoryRecord {
  let current = story;
  for (const to of chain) {
    if (current.status === to) continue;
    current = transitionStory(db, current.id, { toStatus: to, actor: DEV_ACTOR, reason });
  }
  return current;
}

/**
 * Hands ready stories to Kandev in dependency order. Story dependencies become Kandev `blocked_by`; overlapping
 * `paths` and the single GPU lane add ordering edges that exist only in Kandev and are recorded on the story.
 */
export async function dispatchDevStories(db: CoreDatabase, kandev: KandevClient, input: { projectId: string; storyIds?: string[]; conversationId?: string | null; repair?: Record<string, { prompt: string; baseBranch: string }> }): Promise<Array<{ storyId: string; kandevTaskId: string; waitsFor: string[] }>> {
  const all = listStories(db, { projectId: input.projectId, limit: 200 }).filter(s => devSpec(s));
  const wanted = input.storyIds?.length ? all.filter(s => input.storyIds!.includes(s.id)) : all.filter(s => s.status === 'ready');
  if (!wanted.length) return [];
  const profile = prepareWorkerProfile();
  if (wanted.some(s => devSpec(s)!.agent === 'claude') && (!profile.claude.present || (profile.claude.expiresInMin ?? 0) < 20)) {
    throw new CoreError('invalid_request', profile.claude.present
      ? `the Claude sign-in that workers borrow expires in ${profile.claude.expiresInMin} min; open Claude Code once so it refreshes, then dispatch again`
      : 'Claude Code is not signed in on this PC, so Claude workers cannot run');
  }
  await kandev.ensureRunning();
  const ctx = await kandevContext(kandev);
  // Workers branch from the integration branch, so a dependent sees its predecessors' integrated work.
  for (const spec of new Map(wanted.map(s => [devSpec(s)!.repoPath, devSpec(s)!])).values()) {
    const integ = integrationWorktree(spec);
    if (integ.error) throw new CoreError('invalid_request', `cannot prepare ${spec.integrationBranch} in ${spec.repoPath}: ${integ.error}`);
  }
  const ordered = topoOrder(db, wanted);
  let inFlight = all.filter(s => !wanted.includes(s) && ['implementing', 'review', 'validation', 'delivery_approval', 'merge_queue'].includes(s.status));
  if (input.repair) {
    // A repaired story goes ahead of stories that are only waiting (no worker yet): ordering it behind them would be a cycle.
    const running: StoryRecord[] = [];
    for (const s of inFlight) {
      const t = await kandev.taskByExternalId(ctx.workspaceId, s.id);
      if (t && (await kandev.sessions(t.id)).length) running.push(s);
    }
    inFlight = running;
  }
  const taskIds = new Map<string, string>();
  const results: Array<{ storyId: string; kandevTaskId: string; waitsFor: string[] }> = [];
  for (const story of ordered) {
    const spec = devSpec(story)!;
    const existing = await kandev.taskByExternalId(ctx.workspaceId, story.id);
    if (existing) { taskIds.set(story.id, existing.id); continue; }
    const blockers = new Map<string, string>();
    for (const p of predecessors(db, story.id)) {
      const pred = getStory(db, p);
      if (pred.status === 'done') continue;
      const tid = taskIds.get(p) ?? (await kandev.taskByExternalId(ctx.workspaceId, p))?.id;
      if (!tid) throw new CoreError('dependency_violation', `story '${story.title}' depends on '${pred.title}', which is neither done nor dispatched`);
      blockers.set(tid, `depends on "${pred.title}"`);
    }
    // Resource ordering against stories already in flight and earlier ones in this dispatch (same files, or both on
    // the local GPU).
    const gpuPeers: Array<{ tid: string; title: string }> = [];
    for (const earlier of [...inFlight, ...ordered.slice(0, ordered.indexOf(story))]) {
      const tid = taskIds.get(earlier.id) ?? (inFlight.includes(earlier) ? (await kandev.taskByExternalId(ctx.workspaceId, earlier.id))?.id : undefined);
      if (!tid) continue;
      const espec = devSpec(earlier)!;
      if (usesLocalGpu(spec) && usesLocalGpu(espec)) gpuPeers.push({ tid, title: earlier.title });
      if (blockers.has(tid)) continue;
      const shared = overlaps(spec.paths, espec.paths);
      if (shared.length) blockers.set(tid, `shares ${shared.join(', ')} with "${earlier.title}"`);
    }
    // Local-GPU workloads run side by side only as far as the card's VRAM allows (one on a 24 GB card). Each one beyond the
    // limit waits for the workload `limit` places before it, so at most `limit` run at once.
    const lanes = gpuLaneLimit();
    if (gpuPeers.length >= lanes) {
      const gate = gpuPeers[gpuPeers.length - lanes];
      if (!blockers.has(gate.tid)) blockers.set(gate.tid, `local GPU lane (${lanes} at a time) after "${gate.title}"`);
    }
    const profileId = await profileFor(kandev, spec.agent, spec.model);
    const repositoryId = await kandevRepositoryId(kandev, ctx.workspaceId, spec);
    const task = await kandev.tool<{ id: string }>('create_task_kandev', {
      title: story.title.slice(0, 60), external_id: story.id, prompt: input.repair?.[story.id]?.prompt ?? workerPrompt(story, spec), workspace_id: ctx.workspaceId,
      workflow_id: ctx.workflowId, repository_id: repositoryId, base_branch: input.repair?.[story.id]?.baseBranch ?? spec.integrationBranch,
      executor_profile_id: ctx.executorProfileId, agent_profile_id: profileId,
      // A blocked task waits in Backlog: parked in "In Progress" it would hold one of the WIP worker slots.
      ...(blockers.size ? { blocked_by: [...blockers.keys()], ...(ctx.backlogStepId ? { workflow_step_id: ctx.backlogStepId } : {}) } : {}),
    });
    taskIds.set(story.id, task.id);
    walk(db, story, ['assigned', 'planning', 'proposal_approval', 'implementing'], `dispatched to ${spec.agent} via Kandev task ${task.id} (user-requested dispatch)`);
    addComment(db, story.id, {
      author: DEV_ACTOR,
      body: `[kkd-dev:dispatched] ${spec.agent} · Kandev task ${task.id}${blockers.size ? `\nWaits for: ${[...blockers.values()].join('; ')}` : '\nNo blockers: starts when a worker slot is free.'}`,
    });
    results.push({ storyId: story.id, kandevTaskId: task.id, waitsFor: [...blockers.values()] });
  }
  if (input.conversationId && results.length) {
    // Progress and the final report go back to the chat the stories came from.
    for (const r of results) addComment(db, r.storyId, { author: DEV_ACTOR, body: `[kkd-dev:report-to] ${input.conversationId} batch=${results[0].storyId}` });
  }
  return results;
}

// ---------------------------------------------------------------- permission policy

const SAFE_COMMAND = /^(node|npm|npx|pnpm|git)(\.exe|\.cmd)?\s/;
const SAFE_GIT = /^git\s+(status|diff|log|show|ls-files|grep|rev-parse|branch\s+--show-current)\b/;
const SHELL_META = /[;&|<>`$\n]|\bcd\b/;

/**
 * Allow: file writes inside the story's own worktree, read-only git, and the story's verify/test commands.
 * Reject outright: opaque code-mode actions (OpenCode v2 `execute` runs JS whose effects KKD cannot review — e.g. a
 * user-level memory plugin writing outside the repo). Hold everything else for a human.
 */
// Commands that only print. Anything that writes, deletes, redirects, expands variables or starts a subshell is not here.
const READ_ONLY_HEAD = /^(git\s+(status|diff|log|show|ls-files|grep|rev-parse|branch\s+--show-current)|grep|egrep|sed\s+-n|head|tail|wc|ls|dir|Get-Content|Select-Object|Select-String|findstr|sort|uniq)(\s|$)/i;

/** Splits on `&&`, `;` and `|` outside quotes; null when a quote is left open. */
function splitOutsideQuotes(cmd: string): string[] | null {
  const parts: string[] = [];
  let cur = '', quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ';' || ch === '|' || (ch === '&' && cmd[i + 1] === '&')) {
      if (ch === '&') i++;
      if (ch === '|' && cmd[i + 1] === '|') return null; // `||` chains are not read-only filters
      parts.push(cur.trim()); cur = ''; continue;
    }
    cur += ch;
  }
  if (quote) return null;
  parts.push(cur.trim());
  return parts;
}

/**
 * True for a chain of print-only commands that stays inside the worktree: no redirects (except 2>&1 / 2>/dev/null), no `$`,
 * backticks or `..`, no home or absolute paths outside the worktree, no `sed -i`. Workers use these constantly to read code
 * and each one used to need a human.
 */
export function isReadOnlyChain(command: string, worktree: string): boolean {
  const cmd = command.replace(/\s2>&1\b/g, '').replace(/\s2>\s*\/dev\/null\b/g, '').replace(/\s2>\s*\$null\b/gi, '').trim();
  const parts = splitOutsideQuotes(cmd);
  if (!parts || !parts.length || parts.some(p => !p)) return false;
  const root = path.resolve(worktree).toLowerCase().replace(/\\/g, '/');
  for (const part of parts) {
    if (!READ_ONLY_HEAD.test(part)) return false;
    if (/\bsed\b.*\s-\w*i/i.test(part)) return false;
    // Outside quoted text: no redirects, variables, subshells, or parent/home paths.
    const bare = part.replace(/"[^"]*"|'[^']*'/g, '""');
    // `$(...)`, `$var` and backticks expand inside double quotes as well; only single quotes are literal.
    if (/[<>]|\.\.|~/.test(bare) || /[`$]/.test(part.replace(/'[^']*'/g, "''"))) return false;
    // Any absolute path (quoted or not) must be inside the worktree.
    for (const m of part.matchAll(/(?:[A-Za-z]:[\\/][^\s"']*|(?<![\w.])\/[^\s"']+)/g)) {
      const abs = m[0].replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/').toLowerCase();
      if (abs === '/dev/null') continue;
      if (!(abs === root || abs.startsWith(root + '/'))) return false;
    }
  }
  return true;
}

/** One line per permission request that reached the KKD broker (i.e. the worker's own permission rules did not settle it). Plain log, no model. */
const loggedPermissions = new Set<string>();
function logPermission(storyId: string, p: KandevPermission, d: { allow: boolean; reject?: boolean; reason: string }): void {
  if (loggedPermissions.has(p.pending_id)) return;
  loggedPermissions.add(p.pending_id);
  try {
    fs.appendFileSync(path.join(kandevHome(), 'permission-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), storyId, pendingId: p.pending_id, verdict: d.allow ? 'auto-allow' : d.reject ? 'auto-reject' : 'held', reason: d.reason.slice(0, 200) }) + '\n');
  } catch { /* logging must never affect a decision */ }
}

function isInsideWorktree(p: string, worktree: string): boolean {
  const target = path.resolve(worktree, p.replace(/^\/([a-z])\//i, '$1:/')).toLowerCase();
  const root = path.resolve(worktree).toLowerCase();
  return target === root || target.startsWith(root + path.sep);
}

/** Directions for a worker that reached outside its worktree: where it is, how to name files, and what the wrong path was. */
export function outsideWorktreeFeedback(p: string, worktree: string, exists: boolean): string {
  return `Refused: ${p} is outside your working directory${exists ? '' : ' and does not exist'}. Your working directory is ${worktree}; `
    + 'the project files are there. Use paths relative to it (for example src/index.js), or absolute paths that start with it. '
    + 'The folder named in your memory or settings instructions is not the project.';
}

export function permissionDecision(p: KandevPermission, worktree: string | undefined, spec: DevStorySpec): { allow: boolean; reject?: boolean; reason: string } {
  const a = p.action ?? {};
  // Workers must not drive Kandev (task state, dependencies, permissions, new tasks) or reach personal memory tools.
  const label = `${p.title ?? ''} ${a.description ?? ''} ${a.command ?? ''}`;
  if (/\b(?:mcp__)?kandev(?:__|_)?\w*?(create|update|delete|move|resolve|remove|add|archive|answer|import|reorder|spawn)_\w*|\b(create|update|delete|move|resolve|remove|add|archive|answer|import|reorder|spawn)_\w+_kandev\b/i.test(label)) {
    return { allow: false, reject: true, reason: `workers may not change Kandev tasks, dependencies or permissions: ${label.trim().slice(0, 120)}` };
  }
  if (/engram|(^|[^a-z])mem_(save|session|search|update|delete|get|context)/i.test(label)) {
    return { allow: false, reject: true, reason: `personal memory tools are not available to workers: ${label.trim().slice(0, 120)}` };
  }
  if (/kkd[-_]accept/i.test(label + ' ' + (a.path ?? ''))) {
    return { allow: false, reject: true, reason: 'the acceptance checks are not available to workers' };
  }
  if (a.type === 'other' && !a.command && !a.path && /^execute$/i.test(String(a.description ?? p.title ?? '').trim())) {
    return { allow: false, reject: true, reason: 'opaque code-mode "execute" action rejected; use the edit/shell tools so KKD can review each action' };
  }
  if (spec.mode === 'inspect' && (a.type === 'file_write' || a.type === 'file_edit' || a.type === 'file_delete')) {
    return { allow: false, reject: true, reason: 'this is a read-only inspection: files may not be created, edited or deleted' };
  }
  if (spec.mode === 'inspect' && a.type === 'file_read' && a.path && worktree) {
    // The task text names the owner's checkout by path; the agent must read its private copy (its working directory) instead.
    const target = path.resolve(a.path).toLowerCase();
    const root = path.resolve(worktree).toLowerCase();
    if (target === root || target.startsWith(root + path.sep)) return { allow: true, reason: `read ${path.relative(worktree, a.path)}` };
    return { allow: false, reject: true, reason: `read outside your working directory refused: ${a.path}. The repository to inspect is your current working directory (a private copy); use relative paths there.` };
  }
  if ((a.type === 'file_read' || a.type === 'file_write' || a.type === 'file_edit' || a.type === 'file_delete') && a.path && worktree && !isInsideWorktree(a.path, worktree)) {
    // A path outside the worker's own worktree is refused at once with directions, never put to the owner: in a private copy (A5,
    // missions) nothing outside is part of the task, and a path that does not exist is a mistake whatever the task. Live b188g
    // 2026-11-23: Claude built five Read paths from its memory folder's name and the owner was interrupted five times.
    const exists = fs.existsSync(a.path);
    if (spec.codeCopy || !exists) return { allow: false, reject: true, reason: outsideWorktreeFeedback(a.path, worktree, exists) };
  }
  if ((a.type === 'file_write' || a.type === 'file_edit') && a.path && worktree) {
    const target = path.resolve(a.path).toLowerCase();
    const root = path.resolve(worktree).toLowerCase() + path.sep;
    // node_modules may be a junction to shared dependencies, so a write "inside" it can land outside the worktree.
    const inside = target.startsWith(root) && !target.includes(`${path.sep}.git${path.sep}`) && !target.includes(`${path.sep}node_modules${path.sep}`)
      && !findUnsafeDeliveryPaths([path.relative(worktree, a.path)]).length;
    return { allow: inside, reason: inside ? `edit ${path.relative(worktree, a.path)}` : `write outside the worktree or to a protected path: ${a.path}` };
  }
  let cmd = String(a.command ?? '').trim();
  if (cmd && worktree) {
    // Claude Code habitually writes `cd "<its worktree>" && <cmd> 2>&1 | tail -50`. A cd into its own worktree and
    // read-only output trimming are harmless; strip them and judge the remaining single command.
    const cd = cmd.match(/^cd\s+(?:\/d\s+)?"?([^"&;]+?)"?\s*(?:&&|;)\s*(.+)$/s);
    // (its worktree or a folder inside it, e.g. apps/desktop for a package-level typecheck; never outside, never via `..`).
    if (cd) {
      const target = path.resolve(cd[1].trim().replace(/^\/([a-z])\//i, '$1:/')).toLowerCase(); // Git Bash style /c/Users/... too
      const root = path.resolve(worktree).toLowerCase();
      if (target === root || (target.startsWith(root + path.sep) && !cd[1].includes('..'))) cmd = cd[2].trim();
    }
    // Strip trailing read-only output filters (| tail -50, | grep -i "a\|b", | wc -l ...) and a 2>&1 redirect.
    const FILTER = /\s*\|\s*(tail|head|grep|findstr|sort|uniq|wc)((\s+-{1,2}[\w-]+)|(\s+\d+)|(\s+"[^"`$;&|><]*(\\\|[^"`$;&|><]*)*")|(\s+'[^'`$;&|><]*'))*\s*$/;
    for (let i = 0; i < 4 && FILTER.test(cmd); i++) cmd = cmd.replace(FILTER, '').trim();
    cmd = cmd.replace(/\s+2>&1\s*$/, '').trim();
  }
  if (cmd) {
    // Hiding or discarding the worker's own changes breaks KKD's view of its work (a forgotten `stash pop` reads as "no changes").
    if (/\bgit\s+(stash|reset\s+--hard|clean\s+-\w*f)/i.test(cmd)) {
      return { allow: false, reject: true, reason: 'git stash/reset --hard/clean would hide or discard your own changes; compare against the base with `git diff <base>` or `git show <base>:<file>` instead' };
    }
    if (worktree && isReadOnlyChain(cmd, worktree)) return { allow: true, reason: `read-only: ${cmd.slice(0, 120)}` };
    // An unattended worker must never wait on a person for a shell command: refuse it with guidance so the worker adapts.
    if (SHELL_META.test(cmd)) return { allow: false, reject: true, reason: `not permitted here (compound/shell command): ${cmd.slice(0, 160)}. Run one plain command at a time, or use the file tools (read/search/edit) instead of the shell.` };
    const verify = spec.verify.join(' ');
    if (cmd === verify || SAFE_GIT.test(cmd) || /^git\s+checkout\s+--\s+[\w./-]+$/.test(cmd)) return { allow: true, reason: `run ${cmd}` };
    if (SAFE_COMMAND.test(cmd) && /\b(test|lint|typecheck|tsc)\b/.test(cmd) && !/\b(install|add|publish|push)\b/.test(cmd)) return { allow: true, reason: `run ${cmd}` };
    return { allow: false, reject: true, reason: `not permitted here: ${cmd.slice(0, 160)}. Allowed: the verify command (${spec.verify.join(' ')}), node, tests/typecheck, read-only git. Use the file tools for everything else.` };
  }
  return { allow: false, reason: `${a.type ?? 'unknown'} action needs a human: ${(a.description ?? p.title ?? '').slice(0, 160)}` };
}

// ---------------------------------------------------------------- verification + integration

function sh(cwd: string, argv: string[], timeoutMs = 10 * 60_000): { ok: boolean; out: string } {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, shell: process.platform === 'win32' && /^(npm|npx|pnpm)$/.test(argv[0]) });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim().slice(-4_000) };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = runHardenedGit(args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Comment tags for Pandesh's own test runs on an A5 change (base run cached; comparison per verification). */
const BASELINE_TAG = '[kkd-dev:baseline-tests]';
export const TESTS_TAG = '[kkd-dev:tests]';

/**
 * The project's tests as they were BEFORE the change, run once per story in a temporary detached worktree of the private copy at the
 * commit the worker started from, and cached on the story. The worker's worktree and the owner's checkout are not involved.
 */
function baselineTests(db: CoreDatabase, storyId: string, spec: DevStorySpec, worktree?: string): ProjectTestRun {
  const cached = [...listComments(db, storyId)].reverse().find(c => c.body.startsWith(BASELINE_TAG));
  if (cached) { try { return JSON.parse(cached.body.slice(BASELINE_TAG.length)) as ProjectTestRun; } catch { /* recompute */ } }
  // The base is the commit this worker started from (merge-base of its worktree and the integration branch): for a mission's later
  // step that already holds the earlier steps (live b188f: step 2 was measured against main and claimed step 1's test as new).
  const started = worktree ? git(worktree, ['merge-base', 'HEAD', spec.integrationBranch]) : null;
  const at = (started?.ok && started.out.trim()) || spec.codeCopy?.sourceHead || spec.baseBranch;
  const dir = `${spec.repoPath}-baseline`;
  let run: ProjectTestRun;
  fs.rmSync(dir, { recursive: true, force: true });
  git(spec.repoPath, ['worktree', 'prune']);
  const add = git(spec.repoPath, ['worktree', 'add', '--detach', dir, at]);
  if (!add.ok) run = { command: 'none', ran: false, ok: false, tests: null, passed: 0, failed: 0, output: add.out.slice(-500), note: 'the base could not be checked out for a test run' };
  else {
    run = runProjectTests(dir);
    git(spec.repoPath, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  addComment(db, storyId, { author: DEV_ACTOR, body: `${BASELINE_TAG}${JSON.stringify({ ...run, output: run.output.slice(-600) })}` });
  return run;
}

/**
 * An account problem in what the worker (or Kandev) reported: a usage limit or a sign-in that no longer works. Retrying cannot fix
 * either, so the step is parked with the agent's own words (Pandesh never guesses how much quota is left or when it resets).
 */
export function accountProblem(text: string | null | undefined): { kind: 'usage_limit' | 'signin'; tag: string; reason: string } | null {
  const t = String(text ?? '');
  // Only phrasings Claude Code / the API actually print; a task ABOUT rate limiting must not trip this.
  if (/usage limit (?:reached|hit|exceeded)|hit your (?:usage |session |weekly )?limit|(?:5|five)-hour limit reached|weekly limit reached|limit reached\s*[∙·|]\s*resets|rate_limit_error|API Error:\s*(?:429|529)|overloaded_error|out of extra usage/i.test(t)) {
    return { kind: 'usage_limit', tag: '[kkd-dev:account-limit]', reason: `the agent reported a usage limit: "${t.replace(/\s+/g, ' ').trim().slice(0, 240)}"` };
  }
  if (/not logged in|please run \/login|invalid api key|authentication_error|oauth token (?:has )?expired|API Error:\s*401/i.test(t)) {
    return { kind: 'signin', tag: '[kkd-dev:signin-expired]', reason: `the agent cannot sign in: "${t.replace(/\s+/g, ' ').trim().slice(0, 240)}"` };
  }
  return null;
}

/**
 * The development grant still applies to this story: not expired and not revoked. Revocation is a `[kkd-dev:grant-revoked]` comment on
 * the story (written by the owner's revoke action or by cancelling the mission); after it every step waits for the owner's review again.
 */
export function grantInForce(db: CoreDatabase, storyId: string, grant: NonNullable<NonNullable<DevStorySpec['codeCopy']>['grant']>, now = Date.now()): typeof grant | null {
  if (!(Date.parse(grant.expiresAt) > now)) return null;
  if (listComments(db, storyId).some(c => c.body.startsWith(GRANT_REVOKED_TAG))) return null;
  return grant;
}
export const GRANT_REVOKED_TAG = '[kkd-dev:grant-revoked]';

function changedFiles(worktree: string, base: string): string[] {
  const committed = git(worktree, ['diff', '--name-only', `${base}...HEAD`]).out.split('\n');
  // Porcelain lines are "XY path"; parse the raw output (git() trims, which would eat a leading " M").
  const raw = runHardenedGit(['status', '--porcelain', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8', windowsHide: true });
  const dirty = String(raw.stdout ?? '').split('\n').filter(l => l.length > 3).map(l => l.slice(3).replace(/^"|"$/g, ''));
  return [...new Set([...committed, ...dirty].map(s => s.trim()).filter(Boolean))];
}

/** The integration worktree lives beside Kandev's data, never in the user's checkout. */
function integrationWorktree(spec: DevStorySpec): { dir: string; error?: string } {
  const home = process.env.KARKEDIKHA_KANDEV_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.kkd-kandev');
  const key = `${path.basename(spec.repoPath)}-${createHash('sha1').update(path.resolve(spec.repoPath).toLowerCase()).digest('hex').slice(0, 8)}`;
  const dir = path.join(home, 'kkd-integration', key);
  if (fs.existsSync(path.join(dir, '.git'))) {
    // Trust an existing worktree only if it belongs to this repository and branch.
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out.replace(/\\/g, '/').toLowerCase();
    const mine = path.resolve(spec.repoPath, '.git').replace(/\\/g, '/').toLowerCase();
    if (common === mine && git(dir, ['branch', '--show-current']).out === spec.integrationBranch) return { dir };
    return { dir, error: `${dir} is not this repository's integration worktree for ${spec.integrationBranch}` };
  }
  const exists = git(spec.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${spec.integrationBranch}`]).ok;
  const add = exists
    ? git(spec.repoPath, ['worktree', 'add', dir, spec.integrationBranch])
    : git(spec.repoPath, ['worktree', 'add', '-b', spec.integrationBranch, dir, spec.baseBranch]);
  if (!add.ok) return { dir, error: add.out };
  linkDependencies(spec.repoPath, dir);
  return { dir };
}

/** Points a fresh worktree's node_modules at the source checkout's (a junction; workers may not write through it). */
export function linkDependencies(repoPath: string, worktree: string): void {
  const source = path.join(repoPath, 'node_modules');
  const link = path.join(worktree, 'node_modules');
  if (fs.existsSync(source) && !fs.existsSync(link)) fs.symlinkSync(source, link, 'junction');
}

/**
 * Sends the worker a follow-up and records that it was delivered: the next verification waits for a turn that
 * started after this marker. If the agent is busy the message is not delivered and no marker is written, so the
 * worker's current turn is verified when it ends instead of waiting forever for a turn that will never start.
 */
async function sendFeedback(db: CoreDatabase, kandev: KandevClient, storyId: string, taskId: string, sessionId: string, text: string): Promise<boolean> {
  // Taken before sending: the worker's new turn starts while Kandev accepts the message, i.e. before anything could
  // be recorded afterwards. Turns are compared against this instant (see handOffEpoch).
  let sentAt = new Date().toISOString();
  try {
    try {
      await kandev.sendMessage(taskId, sessionId, text);
    } catch (err) {
      // The session ended (stopped, crashed): relaunch it once and deliver the message to the revived agent.
      if (!/session has ended|not running|no agent/i.test((err as Error).message)) throw err;
      await kandev.relaunchSession(taskId, sessionId);
      sentAt = new Date().toISOString();
      await kandev.sendMessage(taskId, sessionId, text);
    }
    addComment(db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:feedback-sent] @${sentAt} ${text.split('\n')[0].slice(0, 200)}` });
    return true;
  } catch (err) {
    addComment(db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:feedback-undelivered] ${(err as Error).message.slice(0, 200)}` });
    return false;
  }
}

/** The worker's last substantial prose message (after `since`, when given): what it says about the turn that just ended. */
async function workerExplanation(kandev: KandevClient, sessionId: string, since?: string): Promise<string | null> {
  const messages = await kandev.agentMessages(sessionId, 40).catch(() => []);
  const prose = messages.filter(m => m.kind === 'message' && m.text.trim().length > 40 && (!since || m.at > since));
  return prose.length ? prose[prose.length - 1].text.trim() : null;
}

/** Files an agent keeps for itself (its own history/cache); never the user's work. */
const AGENT_OWN_FILES = /(^|\/)\.(?:claude|aider|codex|cline)[^/]*(\/|$)|(^|\/)node_modules(\/|$)/i;

/**
 * Completes a read-only inspection. KKD checks what it can check itself: the private clone has no change, and the source
 * checkout's HEAD and working tree are exactly what they were when the task started. The worker's own report (its last message)
 * is the finding and is labelled worker-only: test results in it are what the worker says it ran, not an independent re-run.
 */
async function finishInspection(db: CoreDatabase, kandev: KandevClient, story: StoryRecord, spec: DevStorySpec, taskId: string, worktree: string, sessionId: string): Promise<void> {
  const changed = changedFiles(worktree, spec.integrationBranch).filter(f => !AGENT_OWN_FILES.test(f.replace(/\\/g, '/')));
  const src = spec.inspect ? checkoutFingerprint(spec.inspect.sourcePath) : null;
  // The owner may legitimately edit or commit in their checkout while an inspection runs, so a different source state is reported,
  // not treated as the agent's doing. What can block is the one thing KKD can attribute: a change inside the private copy. The agent
  // cannot write outside the copy (the permission policy rejects every write and every absolute path outside it).
  const sourceMoved = spec.inspect ? !(src && src.head === spec.inspect.sourceHead && src.statusSha === spec.inspect.sourceStatusSha) : false;
  if (changed.length) {
    walk(db, getStory(db, story.id), ['blocked'], 'the read-only inspection changed files');
    addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] A read-only inspection changed files in its private copy: ${changed.slice(0, 10).join(', ')}. Nothing was accepted.` });
    return;
  }
  const messages = await kandev.agentMessages(sessionId, 60).catch(() => []);
  // An answer may be one short sentence ("Hello from …"); an inspection report is expected to say more than that.
  const minReport = spec.answerOnly ? 0 : 40;
  const prose = messages.filter(m => m.kind === 'message' && m.text.trim().length > minReport);
  const report = (prose[prose.length - 1]?.text ?? '').trim();
  if (!report) {
    walk(db, getStory(db, story.id), ['blocked'], 'the worker finished without writing a report');
    addComment(db, story.id, { author: DEV_ACTOR, body: '[kkd-dev:needs-human] The worker finished without a final report. Retry to ask again.' });
    return;
  }
  const tools = messages.filter(m => m.kind === 'tool_execute').map(m => m.text.replace(/\s+/g, ' ').slice(0, 140));
  const header = spec.answerOnly
    ? '[kkd-dev:inspected] level=worker-only; answer-only task: no project was shared, and KKD checked that no file changed in the worker\'s empty folder; every write and every path outside it was refused by policy.'
    : `[kkd-dev:inspected] level=worker-only; read-only checked by KKD: no file changed in the agent's private copy of ${spec.inspect?.projectName ?? 'the project'} (branch ${spec.inspect?.ref ?? '?'} @ ${spec.inspect?.sourceHead.slice(0, 8) ?? '?'}); every write and every path outside the copy was refused by policy.${sourceMoved ? ' Note: your own checkout changed while this ran (you edited or committed there); the agent never had access to it.' : spec.inspect ? ' Your checkout is exactly as it was.' : ''}`;
  addComment(db, story.id, {
    author: DEV_ACTOR,
    body: [
      header,
      `--- worker ${spec.answerOnly ? 'answer' : 'report'} (its own words; test results are as the worker reported them) ---`,
      report.slice(0, 6_000),
      `--- commands the worker ran (${tools.length}) ---`,
      tools.slice(-8).join(' | ') || 'none recorded',
    ].join('\n'),
  });
  walk(db, getStory(db, story.id), ['validation', 'delivery_approval', 'merge_queue'], 'inspection verified read-only');
  walk(db, getStory(db, story.id), ['done'], 'read-only inspection completed');
  await kandev.stopTask(taskId, 'KKD completed the inspection').catch(() => { /* already idle */ });
  await kandev.setTaskState(taskId, 'COMPLETED');
}

let integrating = false;

/**
 * Order of checks after a worker's turn: scope and the actual diff, the worker's own tests, KKD's independent
 * acceptance checks, then (for a story nothing independent can verify) a human review gate, then the merge and a
 * re-run of everything on the integrated result. A failure goes back to the worker with concrete evidence for a
 * bounded number of attempts; the story is not `done`, so dependents stay locked.
 * `reviewApproved` re-enters after a human approved a story that had no independent check.
 */
export interface VerifyOptions {
  /** The worker is stopped and its work is verified as it stands: a failure parks the story instead of messaging the worker. */
  recovery?: boolean;
  /** Content fingerprint taken when the worktree was reconciled; a worktree that changed since is not committed. */
  fingerprint?: string;
}

export async function verifyAndIntegrate(db: CoreDatabase, kandev: KandevClient, story: StoryRecord, spec: DevStorySpec, taskId: string, worktree: string, sessionId: string, reviewApproved = false, opts: VerifyOptions = {}): Promise<void> {
  if (!reviewApproved) story = walk(db, story, ['review'], 'worker turn finished; KKD review started');
  if (spec.mode === 'inspect') return finishInspection(db, kandev, story, spec, taskId, worktree, sessionId);
  const files = changedFiles(worktree, spec.integrationBranch);
  const unsafe = findUnsafeDeliveryPaths(files);
  // Failures since dispatch or since a human last pressed retry.
  const history = listComments(db, story.id);
  const sinceRetry = history.slice(history.map(c => c.body.startsWith('[kkd-dev:retry]')).lastIndexOf(true) + 1);
  const retries = sinceRetry.filter(c => c.body.startsWith('[kkd-dev:verify-failed]')).length;
  const fail = async (what: string, detail: string) => {
    addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:verify-failed] ${what}\n${detail.slice(-2_000)}` });
    if (opts.recovery) {
      // There is no live worker to correct: say exactly what failed and leave the story for a person.
      walk(db, getStory(db, story.id), ['blocked'], `verification of the preserved work failed: ${what}`);
      addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] Verify Existing Work did not pass: ${what}. Nothing was integrated and the worker was not restarted. Fix the cause and verify again, or Retry to give the worker another turn.` });
      return;
    }
    if (retries + 1 > MAX_VERIFY_RETRIES) {
      walk(db, getStory(db, story.id), ['blocked'], `verification failed ${retries + 1} times: ${what}`);
      // Whatever the worker said last goes with it, so the owner sees its side and not only "failed 3 times".
      const said = await workerExplanation(kandev, sessionId).catch(() => null);
      addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] Verification failed ${retries + 1} times (${what}). Kandev task ${taskId}, worktree ${worktree}.${said ? ` The worker's last words: ${said.replace(/\s+/g, ' ').slice(0, 600)}` : ''}` });
      return;
    }
    const now = getStory(db, story.id);
    walk(db, now, now.status === 'merge_queue' ? ['blocked', 'implementing'] : ['implementing'], `verification failed (${what}); sent back to the worker`);
    const delivered = await sendFeedback(db, kandev, story.id, taskId, sessionId, `KarkeDikha verification failed: ${what}\n\n${detail.slice(-2_000)}\n\nFix it, re-run ${spec.verify.join(' ')}, and stop. Do not commit.`);
    if (!delivered) await repairOrPark(db, kandev, story.id, 'the correction was not accepted by the worker session');
  };
  if (!files.length) {
    // A worker that changed nothing but explained itself (the task cannot be done here, it is not allowed, it needs a decision) is
    // not sent back with "make changes": that pressures it into a diff it already said it should not make, three times in a minute
    // (seen 2026-11-21). Its explanation is kept and the story goes to the owner. Only a silent worker gets the usual correction.
    const explanation = opts.recovery ? null : await workerExplanation(kandev, sessionId, handOffEpoch(history, true));
    if (explanation) {
      addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:verify-failed] the worker made no changes and explained why\n--- worker explanation (its own words) ---\n${explanation.slice(0, 2_000)}` });
      walk(db, getStory(db, story.id), ['blocked'], 'the worker made no changes and explained why; not sent back for repair');
      addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] The worker made no changes and explained why (not sent back for repair): ${explanation.replace(/\s+/g, ' ').slice(0, 600)}` });
      return;
    }
    return fail('the worker made no changes', 'git reports no changed files in the worktree');
  }
  if (unsafe.length) return fail('protected or credential-adjacent files changed', unsafe.map(u => `${u.path}: ${u.reason}`).join('\n'));
  if (spec.maxFiles && files.length > spec.maxFiles) {
    return fail(`${files.length} files changed; this change was approved for at most ${spec.maxFiles}`, `Changed: ${files.join(', ')}\nRevert (git checkout -- <file>) what the task does not need and keep only the requested change.`);
  }
  const outOfScope = spec.paths?.length ? files.filter(f => !overlaps([f], spec.paths).length) : [];
  if (outOfScope.length) {
    return fail('files outside the story scope changed', `Allowed: ${spec.paths!.join(', ')}\nRevert (git checkout -- <file>) these out-of-scope changes: ${outOfScope.join(', ')}`);
  }
  const diff = examineDiff(worktree, spec.integrationBranch);
  if (diff.violations.length) return fail('the diff weakens the tests', `${diff.violations.join('\n')}\nRestore the tests and fix the implementation instead.`);
  const check = sh(worktree, spec.verify);
  if (!check.ok) return fail(`\`${spec.verify.join(' ')}\` failed in the worktree`, check.out);
  const checks = automatedChecks(spec.acceptance ?? []);
  let accepted: ReturnType<typeof runAcceptance> | null = null;
  if (checks.length) {
    accepted = runAcceptance(story.id, checks, worktree);
    if (!accepted.ok) {
      return fail(`KKD's independent acceptance check failed (${accepted.passed}/${accepted.total} cases pass) although the worker's own tests pass`,
        `${accepted.evidence}\n\nThe criteria in the story are authoritative; your own tests did not cover these inputs. Fix the implementation (do not weaken tests) and make it correct in general.`);
    }
  }
  // A5: Pandesh runs the project's own tests on the base and on the change and compares them per test. A regression, a failing new test
  // or (when the task asked for tests) no new test sends the work back; tests that were already failing are reported, never hidden.
  let testReport = '';
  let testsProven = false;
  if (spec.codeCopy) {
    const base = baselineTests(db, story.id, spec, worktree);
    const after = runProjectTests(worktree);
    const cmp = compareTestRuns(base, after);
    addComment(db, story.id, { author: DEV_ACTOR, body: `${TESTS_TAG} ${JSON.stringify(cmp)}` });
    const verdict = judgeTests(cmp, spec.codeCopy.testsRequested === true);
    if (!verdict.ok) return fail(`Pandesh's own test run: ${verdict.what}`, `${after.output}\n\nFix it (do not weaken or delete tests), and stop. Tests that were already failing before your change are not yours to fix unless the task asks.`);
    testReport = verdict.report;
    // Only a per-test comparison (or a passing suite) is evidence enough to commit without a person looking.
    testsProven = after.ran && (cmp.perTest || after.ok);
  }
  const grant = spec.codeCopy?.grant && testsProven && !diff.reviewReasons.length ? grantInForce(db, story.id, spec.codeCopy.grant) : null;
  const level: VerificationLevel = accepted ? 'independent' : 'worker-only';
  addComment(db, story.id, {
    author: DEV_ACTOR,
    body: `[kkd-dev:verified] level=${level}; \`${spec.verify.join(' ')}\` passed in the worktree${accepted ? `; independent acceptance ${accepted.passed}/${accepted.total} (${accepted.names.join(', ')})` : ''}.${testReport ? ` ${testReport}` : ''}\nChanged: ${files.join(', ')}\n${check.out.slice(-600)}`,
  });
  // An A5 change always waits for the owner's review, whatever was verified: only the owner decides what reaches their project.
  const needsReview = spec.codeCopy ? !grant : (level === 'worker-only' || diff.reviewReasons.length > 0);
  if (!reviewApproved && needsReview) {
    // Nothing independent verifies this result (or the diff looks like it weakened tests): "the worker finished" is not
    // "it is correct". Hold it for a person and keep dependents locked.
    walk(db, story, ['validation', 'delivery_approval'], 'worker finished and its own tests pass; waiting for a human review');
    addComment(db, story.id, {
      author: DEV_ACTOR,
      body: `[kkd-dev:awaiting-review] ${spec.codeCopy ? `Change ready for the owner's review. ${testReport}` : level === 'worker-only' ? 'Worker completed and its own tests pass, but KKD has no independent acceptance check for this story.' : 'Independent acceptance passed, but the diff needs a human look.'}${diff.reviewReasons.length ? ` ${diff.reviewReasons.join('; ')}.` : ''}\nChanged: ${files.join(', ')}\nWorktree: ${worktree}\nApprove to integrate it, or retry with a note.`,
    });
    return;
  }
  story = walk(db, story, reviewApproved ? ['merge_queue'] : ['validation', 'delivery_approval', 'merge_queue'], `verified in worktree (${files.length} files, ${level}); local integration branch is pre-authorized, no push`);

  if (opts.fingerprint && worktreeFingerprint(worktree, files) !== opts.fingerprint) {
    return fail('the worktree changed while it was being verified', 'The files that were checked are not the files that would be committed, so nothing was integrated. Verify again.');
  }

  // --- single integration queue ---
  const integ = integrationWorktree(spec);
  if (integ.error) { walk(db, story, ['blocked'], 'integration worktree unavailable'); addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] Could not prepare integration worktree: ${integ.error}` }); return; }
  const branch = git(worktree, ['branch', '--show-current']).out;
  if (git(worktree, ['status', '--porcelain']).out) {
    git(worktree, ['add', '-A', '--', ...files]);
    const commit = git(worktree, ['-c', 'user.name=KarkeDikha', '-c', 'user.email=kkd@localhost', 'commit', '-q', '-m', `${story.title}\n\nKKD story ${story.id}; verified: ${spec.verify.join(' ')}`]);
    if (!commit.ok) return fail('could not commit the worker changes', commit.out);
  }
  const before = git(integ.dir, ['rev-parse', 'HEAD']).out; // roll back to here: a re-run may merge nothing new
  const merge = git(integ.dir, ['-c', 'user.name=KarkeDikha', '-c', 'user.email=kkd@localhost', 'merge', '--no-ff', '-q', '-m', `Integrate: ${story.title} (${branch})`, branch]);
  if (!merge.ok) {
    git(integ.dir, ['merge', '--abort']);
    return fail(`merge conflict integrating ${branch} into ${spec.integrationBranch}`, merge.out);
  }
  const post = sh(integ.dir, spec.verify);
  if (!post.ok) {
    git(integ.dir, ['reset', '--hard', before]);
    return fail(`\`${spec.verify.join(' ')}\` failed after integration (merge rolled back)`, post.out);
  }
  if (spec.codeCopy) {
    // The committed result must show the same test picture: no test that passed before the change may fail on the integration branch.
    const again = judgeTests(compareTestRuns(baselineTests(db, story.id, spec, worktree), runProjectTests(integ.dir)), false);
    if (!again.ok) {
      git(integ.dir, ['reset', '--hard', before]);
      return fail(`Pandesh's own test run failed after integration (merge rolled back): ${again.what}`, '');
    }
  }
  if (checks.length) {
    // The integrated result must also satisfy the independent checks (the merge may interact with earlier stories).
    const again = runAcceptance(story.id, checks, integ.dir);
    if (!again.ok) {
      git(integ.dir, ['reset', '--hard', before]);
      return fail('independent acceptance failed on the integrated result (merge rolled back)', again.evidence);
    }
  }
  const sha = git(integ.dir, ['rev-parse', '--short', 'HEAD']).out;
  walk(db, getStory(db, story.id), ['done'], `integrated as ${sha} on ${spec.integrationBranch}`);
  addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:integrated] ${sha} on ${spec.integrationBranch} (branch ${branch}); level=${level}${reviewApproved ? ' (human-reviewed)' : grant ? ` (committed under the owner's development grant ${grant.id} after Pandesh's own test run passed)` : ''}${opts.recovery ? ' (verified from preserved worker output; worker not restarted)' : ''}; \`${spec.verify.join(' ')}\`${checks.length ? ' and independent acceptance' : ''} passed after merge.` });
  // Stop first: Kandev's stop handler moves the task back to REVIEW, which would undo COMPLETED.
  await kandev.stopTask(taskId, 'KKD integrated the story').catch(() => { /* already idle */ });
  await kandev.setTaskState(taskId, 'COMPLETED'); // releases Kandev dependents
}

// ---------------------------------------------------------------- reconcile loop

const ACTIVE: StoryStatus[] = ['implementing', 'review', 'validation', 'merge_queue', 'blocked'];

/** A story that shares files with another unfinished story that already has a worker must not take a worker slot (Kandev counts a blocked task in "In Progress" against the limit). */
async function waitsOnOverlap(db: CoreDatabase, kandev: KandevClient, workspaceId: string, story: StoryRecord, spec: DevStorySpec): Promise<boolean> {
  for (const other of listStories(db, { projectId: story.projectId, limit: 200 })) {
    const ospec = devSpec(other);
    if (!ospec || other.id === story.id || other.status === 'done' || other.status === 'blocked' || !overlaps(spec.paths, ospec.paths).length) continue;
    const t = await kandev.taskByExternalId(workspaceId, other.id).catch(() => null);
    if (t && (await kandev.sessions(t.id).catch(() => [])).length) return true;
  }
  return false;
}

/**
 * A local-GPU story must stay in Backlog while the GPU lanes are taken. Its Kandev blocked_by keeps it from starting, but released
 * to "In Progress" it would hold a worker slot the whole time it waits (seen live 2026-11-21: a queued OpenCode task kept a Claude
 * story that needs no GPU from starting). The GPU is one per machine, so peers are counted across every project.
 */
export async function waitsOnGpuLane(db: CoreDatabase, kandev: KandevClient, workspaceId: string, story: StoryRecord, spec: DevStorySpec, lanes = gpuLaneLimit()): Promise<boolean> {
  if (!usesLocalGpu(spec)) return false;
  let busy = 0;
  for (const other of listStories(db, { limit: 200 })) {
    const ospec = devSpec(other);
    if (!ospec || other.id === story.id || !ACTIVE.includes(other.status) || !usesLocalGpu(ospec)) continue;
    const t = await kandev.taskByExternalId(workspaceId, other.id).catch(() => null);
    const s = t ? (await kandev.sessions(t.id).catch(() => []))[0] : undefined;
    if (s && (s.state === 'RUNNING' || s.state === 'STARTING')) busy++;
  }
  return busy >= lanes;
}

/** One reconciliation pass over dispatched stories. Safe to call repeatedly and after any restart. */
export async function reconcileDevStories(db: CoreDatabase, kandev: KandevClient): Promise<void> {
  const stories = listStories(db, { limit: 200 }).filter(s => devSpec(s) && ACTIVE.includes(s.status));
  if (!stories.length) return;
  try { prepareWorkerProfile(); } catch { /* the next dispatch reports it */ }
  if (!(await kandev.healthy())) return;
  const workspaceId = await kandev.defaultWorkspaceId();
  let ctx: KandevContext | undefined;
  for (const story of stories) {
    const spec = devSpec(story)!;
    const task = await kandev.taskByExternalId(workspaceId, story.id);
    if (!task) continue;
    const isIntegrated = listComments(db, story.id).some(c => c.body.startsWith('[kkd-dev:integrated]') || c.body.startsWith('[kkd-dev:inspected]'));
    if (task.state === 'COMPLETED' && !isIntegrated) {
      // Something other than KKD (e.g. the worker via Kandev's task MCP) completed it: undo, so dependents stay gated.
      await kandev.setTaskState(task.id, 'REVIEW');
      addComment(db, story.id, { author: DEV_ACTOR, body: '[kkd-dev:anomaly] Kandev task was marked COMPLETED without KKD integration; reverted to REVIEW.' });
      continue;
    }
    const session = (await kandev.sessions(task.id))[0];
    if (session?.state === 'FAILED' && story.status !== 'blocked') {
      // Kandev could not start (or lost) the worker. Without this the story would read "starting" forever.
      const account = accountProblem(session.error_message);
      walk(db, story, ['blocked'], account ? account.reason.slice(0, 200) : 'the worker session failed');
      addComment(db, story.id, { author: DEV_ACTOR, body: account
        ? `[kkd-dev:needs-human] ${account.tag} ${account.kind === 'usage_limit' ? 'Claude could not continue: ' : 'Claude is not signed in: '}${account.reason}. Not retried automatically (a retry cannot fix it). The worktree is kept; Retry once ${account.kind === 'usage_limit' ? 'the limit has reset' : 'Claude Code is signed in again (open it once)'}.`
        : `[kkd-dev:needs-human] [kkd-dev:launch-failed] Kandev worker session failed: ${(session.error_message ?? 'no error reported').slice(0, 300)}. Fix the cause, then retry.` });
      continue;
    }
    if (story.status === 'blocked') {
      // Stopped or waiting for a human: nothing may run. If a worker came back anyway (Kandev restart, a slot
      // freeing up), stop it again.
      if (session && (session.state === 'RUNNING' || session.state === 'STARTING')) {
        await kandev.stopTask(task.id, 'KKD: story is stopped/blocked').catch(() => { /* already idle */ });
        addComment(db, story.id, { author: DEV_ACTOR, body: '[kkd-dev:anomaly] A worker was running for a stopped/blocked story; stopped it again.' });
      }
      continue;
    }
    if (!session) {
      // A dependent waits in Kandev's Backlog (which never auto-starts, so it holds no worker slot). KKD releases it
      // once KKD itself has verified and integrated every predecessor: moving it to "In Progress" starts the worker.
      const openPreds = predecessors(db, story.id).filter(d => getStory(db, d).status !== 'done');
      if (story.status === 'implementing' && !openPreds.length && !(await waitsOnOverlap(db, kandev, workspaceId, story, spec)) && !(await waitsOnGpuLane(db, kandev, workspaceId, story, spec))) {
        // Kandev must agree the predecessors are complete, or it refuses to start the dependent.
        for (const d of predecessors(db, story.id)) {
          const dt = await kandev.taskByExternalId(workspaceId, d);
          const integratedByKkd = listComments(db, d).some(c => c.body.startsWith('[kkd-dev:integrated]'));
          if (dt && dt.state !== 'COMPLETED' && integratedByKkd) await kandev.setTaskState(dt.id, 'COMPLETED');
        }
        ctx ??= await kandevContext(kandev);
        if (ctx.backlogStepId && ctx.runningStepId && task.workflow_step_id === ctx.backlogStepId) {
          await kandev.tool('move_task_kandev', { task_id: task.id, workflow_id: ctx.workflowId, workflow_step_id: ctx.runningStepId });
          addComment(db, story.id, { author: DEV_ACTOR, body: '[kkd-dev:released] All predecessors are verified and integrated; handed to a worker.' });
        }
      } else if (usesLocalGpu(spec) && (await waitsOnGpuLane(db, kandev, workspaceId, story, spec))) {
        // Released earlier (or by an older build) while the GPU is busy: back to Backlog so it stops holding a worker slot.
        ctx ??= await kandevContext(kandev);
        if (ctx.backlogStepId && ctx.runningStepId && task.workflow_step_id === ctx.runningStepId) {
          await kandev.tool('move_task_kandev', { task_id: task.id, workflow_id: ctx.workflowId, workflow_step_id: ctx.backlogStepId });
          addComment(db, story.id, { author: DEV_ACTOR, body: '[kkd-dev:requeued] Waiting for the local GPU lane in Backlog, so it does not hold a worker slot.' });
        }
      }
      continue; // blocked in Kandev or waiting for a worker slot
    }
    // KKD's own dependency gate, independent of Kandev's blocked_by (which a worker or Kandev itself could drop):
    // a story never runs before all its predecessors are verified and integrated by KKD.
    const open = predecessors(db, story.id).filter(d => getStory(db, d).status !== 'done');
    if (open.length && !isIntegrated) {
      await kandev.stopTask(task.id, 'KKD: predecessors not integrated').catch(() => { /* already idle */ });
      for (const d of open) {
        const dt = await kandev.taskByExternalId(workspaceId, d);
        if (dt) await kandev.tool('add_task_dependency_kandev', { task_id: task.id, depends_on_task_id: dt.id }).catch(() => { /* already linked */ });
      }
      walk(db, story, ['blocked'], 'started before its predecessors were integrated');
      addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] [kkd-dev:anomaly] Kandev started this story while ${open.length} predecessor(s) were not integrated; KKD stopped it. Retry once they are done.` });
      continue;
    }
    if (session.worktree_path) { try { linkDependencies(spec.repoPath, session.worktree_path); } catch { /* verify will report it */ } }
    if (story.status === 'implementing') {
      // A worker that hit a usage limit or lost its sign-in often stays "running" with that error as its last message: park it with
      // the agent's own words instead of nudging it (a nudge would only spend another turn on the same error).
      const lastSaid = (await Promise.resolve().then(() => kandev.agentMessages(session.id, 5)).catch(() => [])).filter(m => m.kind === 'message' || m.kind === 'error').pop();
      const account = lastSaid ? accountProblem(lastSaid.text) : null;
      if (account && lastSaid!.text.length < 600) {
        await kandev.stopTask(task.id, `KKD: ${account.kind === 'usage_limit' ? 'usage limit' : 'sign-in'} reported by the agent`).catch(() => { /* already idle */ });
        walk(db, story, ['blocked'], account.reason.slice(0, 200));
        addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] ${account.tag} ${account.reason}. The worker was stopped and not retried; the worktree is kept. Retry once ${account.kind === 'usage_limit' ? 'the limit has reset' : 'Claude Code is signed in again'}.` });
        continue;
      }
      await relayWorkerNarrative(db, kandev, story, session.id).catch(() => { /* cosmetic: never block reconciliation */ });
      if (await nudgeIfSilent(db, kandev, story, task.id, session.id).catch(() => false)) continue;
    }
    if (story.status === 'merge_queue' && !integrating && session.worktree_path) {
      // Core stopped mid-integration. Finish if the merge landed, otherwise send the story back through review.
      const branch = git(session.worktree_path, ['branch', '--show-current']).out;
      const integ = integrationWorktree(spec);
      if (!integ.error && branch && git(integ.dir, ['merge-base', '--is-ancestor', branch, 'HEAD']).ok && sh(integ.dir, spec.verify).ok
        && (!automatedChecks(spec.acceptance ?? []).length || runAcceptance(story.id, spec.acceptance!, integ.dir).ok)) {
        const sha = git(integ.dir, ['rev-parse', '--short', 'HEAD']).out;
        walk(db, story, ['done'], `integration recovered after restart: ${sha}`);
        addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:integrated] ${sha} on ${spec.integrationBranch} (branch ${branch}); recovered after a Core restart, verify re-run passed.` });
        await kandev.setTaskState(task.id, 'COMPLETED');
      } else {
        walk(db, story, ['blocked', 'review'], 'integration interrupted by a restart; re-verifying');
      }
      continue;
    }
    let resolvedNow = false;
    for (const p of await kandev.pendingPermissions(task.id)) {
      const decision = permissionDecision(p, session.worktree_path, spec);
      logPermission(story.id, p, decision);
      if (decision.allow) { await kandev.resolvePermission(p, 'allow_once'); resolvedNow = true; }
      else if (decision.reject) {
        await kandev.resolvePermission(p, 'reject_once');
        resolvedNow = true;
        addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:rejected] ${decision.reason}` });
      } else {
        const marker = `[kkd-dev:approval] ${p.pending_id}`;
        if (!listComments(db, story.id).some(c => c.body.startsWith(marker))) addComment(db, story.id, { author: DEV_ACTOR, body: `${marker}\n${decision.reason}` });
      }
    }
    if (integrating || resolvedNow) continue; // a just-approved action means the worker is mid-turn
    const status = await kandev.sessionStatus(task.id, session.id).catch(() => null);
    // A turn is over only when Kandev recorded its completion (task REVIEW alone also means "waiting on a
    // permission"), and — after KKD sent verification feedback — only for a turn that started after it.
    // A retry/resume also starts a new epoch: the turn a Stop All cancelled must never be verified as finished work.
    const lastFeedback = handOffEpoch(listComments(db, story.id), false);
    const turn = await kandev.latestTurn(session.id).catch(() => null);
    const turnOver = Boolean(turn?.completed_at) && session.state !== 'RUNNING' && session.state !== 'STARTING'
      && (!lastFeedback || turn!.started_at > lastFeedback);
    if (status?.needs_resume && status.resume_reason === 'agent_not_running' && !turnOver) {
      await kandev.relaunchSession(task.id, session.id);
      addComment(db, story.id, { author: DEV_ACTOR, body: '[kkd-dev:resumed] Worker process was gone (restart); relaunched the same agent session.' });
      continue;
    }
    if (!turnOver || !session.worktree_path) continue;
    if ((await kandev.pendingPermissions(task.id)).length) continue; // waiting on a human decision
    // A turn that ended because the worker PROCESS died (killed, crashed) is not finished work, whatever it left in the worktree.
    // Kandev closes it with a completion time like a normal turn but marks it error_terminated; without this it was verified, read as
    // "the worker made no changes" and cost a verification attempt (live b188i 2026-11-23, claude.exe killed mid-step). Resume the
    // same session (its context is restored), bounded. Usage limits and lost sign-ins were already parked above and never get here.
    if (turnOver && turn?.metadata?.error_terminated === true) {
      const marks = listComments(db, story.id).filter(c => c.body.startsWith(CRASH_TAG));
      const thisTurn = `${CRASH_TAG} @${turn!.started_at}`;
      // The same crashed turn is counted once (a resume message that could not be delivered is simply tried again next tick).
      const crashes = marks.filter(c => !c.body.startsWith(thisTurn)).length;
      if (marks.some(c => c.body.startsWith(thisTurn))) {
        await sendFeedback(db, kandev, story.id, task.id, session.id, RESUME_TEXT);
        continue;
      }
      if (crashes >= MAX_CRASH_RESUMES) {
        walk(db, story, ['blocked'], 'the worker process stopped repeatedly');
        addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] The worker process stopped ${crashes + 1} times before finishing; Pandesh resumed it ${crashes} time(s) and stops trying. The worktree is kept; Retry to start it again.` });
        continue;
      }
      addComment(db, story.id, { author: DEV_ACTOR, body: `${thisTurn} The worker process stopped before it finished (Kandev: turn error-terminated); resuming the same session (${crashes + 1} of ${MAX_CRASH_RESUMES}).` });
      await sendFeedback(db, kandev, story.id, task.id, session.id, RESUME_TEXT);
      continue;
    }
    integrating = true;
    try {
      await verifyAndIntegrate(db, kandev, getStory(db, story.id), spec, task.id, session.worktree_path, session.id);
    } finally {
      integrating = false;
    }
  }
}

const NARRATIVE_MIN_GAP_MS = 20_000;

/**
 * Relays what the worker itself says ("All relevant tests pass…", "Now fixing the route…") into the chat the story came
 * from, as it happens. Only the worker's prose (not tool calls), batched at most every 20 s, never repeated: a marker
 * remembers the newest message already relayed. Without this the chat is silent between milestones.
 */
export async function relayWorkerNarrative(db: CoreDatabase, kandev: KandevClient, story: StoryRecord, sessionId: string): Promise<boolean> {
  const comments = listComments(db, story.id);
  const target = [...comments].reverse().find(c => c.body.startsWith('[kkd-dev:report-to] '));
  if (!target) return false;
  const conversationId = /^\[kkd-dev:report-to\] (\S+)/.exec(target.body)?.[1];
  if (!conversationId) return false;
  const marker = [...comments].reverse().find(c => c.body.startsWith('[kkd-dev:said-until] '));
  // First look: relay only what is new from now on, not the worker's whole history.
  const since = marker ? marker.body.slice('[kkd-dev:said-until] '.length).trim() : new Date(Date.now() - 60_000).toISOString();
  if (marker && Date.now() - Date.parse(marker.createdAt) < NARRATIVE_MIN_GAP_MS) return false;
  const fresh = (await kandev.agentMessages(sessionId)).filter(m => m.kind === 'message' && m.at > since && m.text.trim().length > 20);
  if (!fresh.length) return false;
  const text = fresh.map(m => m.text.trim()).join('\n\n').slice(0, 700);
  // The "relayed until" marker and the message are written together: a failure between the two must not relay it again.
  db.transaction(() => {
    addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:said-until] ${fresh[fresh.length - 1].at}` });
    try { appendMessage(db, conversationId, { role: 'assistant', content: `💬 **${story.title}** (${devSpec(story)?.agent ?? 'worker'}): ${text}`, actor: DEV_ACTOR }); } catch { /* conversation deleted */ }
  });
  return true;
}

/** A correction not picked up by a new agent turn within this long was dropped (queued, never delivered). */
const DELIVERY_ACK_MS = 45_000;
/** A worker that took the message but produced no real work for this long is silent (first turns included). */
const SILENT_AFTER_MS = 180_000;
/** A tool call still running is legitimate (a test suite, a build) for this long; after that it counts as hung. */
const LONG_TOOL_MS = 30 * 60_000;

/** Work the worker did: its prose and its tool calls. Boot logs, permission prompts and a live process are not progress. */
const PROGRESS_KINDS = new Set(['message', 'tool_execute', 'tool_edit', 'tool_read', 'tool_search']);

/**
 * Watchdog for a worker KKD is waiting on. Three separate questions, each answered from what Kandev recorded:
 *  - Delivered? A correction counts as delivered once a new agent turn started after it; KKD records `[kkd-dev:delivered]`.
 *    Not delivered after DELIVERY_ACK_MS means it was dropped: one fresh session on the preserved work (no resend).
 *  - Working? Only the worker's own messages and tool calls after the hand-off count — not the boot log, not a live process.
 *    A tool call that is still running (a long test run) is working until LONG_TOOL_MS.
 *  - Otherwise it is silent after SILENT_AFTER_MS: one fresh session (see repairDevStory), and if that one fails the same
 *    way, park the story visibly (blocked, needs-human) so the queue moves on instead of looping.
 */
export async function nudgeIfSilent(db: CoreDatabase, kandev: KandevClient, story: StoryRecord, taskId: string, sessionId: string): Promise<boolean> {
  const comments = listComments(db, story.id);
  const sent = [...comments].reverse().find(c => /^\[kkd-dev:(feedback-sent|retry)\]/.test(c.body));
  const handOff = handOffEpoch(comments, false);
  if (!sent || !handOff) return false;
  const age = Date.now() - Date.parse(handOff);
  if (age < DELIVERY_ACK_MS) return false;
  const sinceSent = comments.slice(comments.indexOf(sent) + 1);
  if (sinceSent.some(c => c.body.startsWith('[kkd-dev:approval] ') && !sinceSent.some(d => d.body.startsWith('[kkd-dev:decided]')))) return false;
  if ((await kandev.pendingPermissions(taskId)).length) return false; // waiting on a person, not silent

  const messages = await kandev.agentMessages(sessionId, 20);
  const turn = await kandev.latestTurn?.(sessionId).catch(() => null) ?? null;
  if (!turn) return false; // the session has not begun its first turn (queued for a worker slot or still starting): not silent
  const delivered = Boolean(turn && turn.started_at >= handOff);
  const worked = messages.some(m => PROGRESS_KINDS.has(m.kind) && m.at > handOff);
  const running = messages.some(m => m.kind.startsWith('tool_') && m.status !== 'complete' && m.status !== 'error' && Date.now() - Date.parse(m.at) < LONG_TOOL_MS);
  if (delivered && !comments.some(c => c.body.startsWith(`[kkd-dev:delivered] @${handOff}`))) {
    addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:delivered] @${handOff} The worker started a turn on KKD's last message (${Math.round(age / 1000)} s after sending).` });
  }
  if (worked || running) return false; // real work, or a tool call that is legitimately still running

  // A correction that never arrived, or a worker that went silent: one fresh worker session on the preserved work, never
  // another resend or restart of this session. If that fresh session also fails, the story is parked with the reason.
  if (!delivered) {
    return repairOrPark(db, kandev, story.id, `a correction was never delivered (${Math.round(age / 1000)} s, no new agent turn)`);
  }
  // Silence is measured from when the worker actually began its turn, not from when KKD queued the message (a queued session can wait).
  const quiet = Date.now() - Math.max(Date.parse(handOff), Date.parse(turn.started_at));
  if (quiet < SILENT_AFTER_MS) return false; // delivered; give the worker its first minutes
  return repairOrPark(db, kandev, story.id, `no work for ${Math.round(quiet / 60_000)} min after KKD's last message`);
}

/** Stops the worker for good (including anything it queued) and makes the story visibly blocked. */
async function parkSilentStory(db: CoreDatabase, kandev: KandevClient, story: StoryRecord, taskId: string, why: string): Promise<boolean> {
  await kandev.stopTask(taskId, `KKD watchdog: parked (${why})`).catch(() => { /* already idle */ });
  walk(db, getStory(db, story.id), ['blocked'], `worker silent: ${why}`);
  addComment(db, story.id, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] [kkd-dev:parked] The worker produced no work (${why}). KKD stopped it and parked this story instead of restarting again. Retry it for a fresh session, or check the worker's process, permissions and model.` });
  return true;
}

/** The newest retry marker is a KKD-started repair: the story already had its one fresh session since the last human action. */
function alreadyRepaired(db: CoreDatabase, storyId: string): boolean {
  const retry = [...listComments(db, storyId)].reverse().find(c => c.body.startsWith('[kkd-dev:retry]'));
  return Boolean(retry?.body.includes('[kkd-dev:repair]'));
}

/**
 * One recovery for a worker that cannot take a correction: a fresh session on the preserved work (once per human action);
 * if that has already happened, park the story with the true reason. Returns true: the story was handled.
 */
async function repairOrPark(db: CoreDatabase, kandev: KandevClient, storyId: string, why: string): Promise<boolean> {
  const story = getStory(db, storyId);
  const workspaceId = await kandev.defaultWorkspaceId();
  const task = await kandev.taskByExternalId(workspaceId, storyId);
  if (alreadyRepaired(db, storyId) || !task) {
    if (task) return parkSilentStory(db, kandev, story, task.id, `${why}; the fresh repair session had the same problem`);
    walk(db, story, ['blocked'], why);
    addComment(db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] ${why}. No Kandev task exists to repair.` });
    return true;
  }
  await repairDevStory(db, kandev, storyId, why, DEV_ACTOR);
  return true;
}

/** Latest verification failure on the story, as the worker should read it. */
function lastFailure(db: CoreDatabase, storyId: string): string | null {
  const c = [...listComments(db, storyId)].reverse().find(x => x.body.startsWith('[kkd-dev:verify-failed]'));
  return c ? c.body.replace(/^\[kkd-dev:verify-failed\]\s*/, '') : null;
}

/**
 * Fresh worker session on preserved work. The old worker is stopped (and proven gone); whatever it changed is committed on
 * a preserved branch, which becomes the base of a new Kandev task whose initial prompt carries the story, the exact failed
 * checks and the smallest next action. Delivery is the task's first turn, so there is no follow-up message to drop, resend
 * or deliver twice. KKD's trusted acceptance checks and integration gates are unchanged.
 */
export async function repairDevStory(db: CoreDatabase, kandev: KandevClient, storyId: string, why: string, author: string): Promise<void> {
  const story = getStory(db, storyId);
  const spec = devSpec(story);
  if (!spec) throw new CoreError('invalid_request', 'not a development story');
  await kandev.ensureRunning();
  const workspaceId = await kandev.defaultWorkspaceId();
  const task = await kandev.taskByExternalId(workspaceId, storyId);
  const session = task ? (await kandev.sessions(task.id))[0] : undefined;
  const park = (reason: string) => {
    walk(db, getStory(db, storyId), ['blocked'], reason);
    addComment(db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] [kkd-dev:parked] Fresh-session repair could not start: ${reason}. Nothing was changed or integrated.` });
  };
  if (task && session) {
    const gone = await confirmWorkerStopped(kandev, task.id, session.id);
    if (!gone.stopped) return park(`the old worker did not stop (${gone.detail})`);
  }
  // Preserve: commit the old worker's changes on its own branch and pin them under a KKD ref.
  let base = spec.integrationBranch;
  let preserved: string[] = [];
  const wt = session?.worktree_path;
  if (wt && fs.existsSync(wt)) {
    preserved = changedFiles(wt, spec.integrationBranch);
    if (preserved.length) {
      if (git(wt, ['status', '--porcelain']).out) {
        git(wt, ['add', '-A', '--', ...preserved]);
        const c = git(wt, ['-c', 'user.name=KarkeDikha', '-c', 'user.email=kkd@localhost', 'commit', '-q', '-m', `${story.title}\n\nKKD story ${story.id}; preserved for a fresh repair session`]);
        if (!c.ok) return park(`could not preserve the existing changes: ${c.out.slice(0, 200)}`);
      }
      const ref = `kkd/preserved/${storyId.replace(/^story_/, '').slice(0, 8)}-${Date.now()}`;
      const pin = git(spec.repoPath, ['branch', ref, git(wt, ['rev-parse', 'HEAD']).out]);
      if (!pin.ok) return park(`could not pin the existing changes: ${pin.out.slice(0, 200)}`);
      base = ref;
    }
  }
  const failure = lastFailure(db, storyId);
  const prompt = [
    workerPrompt(story, spec),
    '\n--- FRESH SESSION: REPAIR OF EXISTING WORK ---',
    preserved.length ? `A previous worker already changed these files; they are committed in this worktree as its starting point. Do not start over or redo them:\n${preserved.map(f => `- ${f}`).join('\n')}` : 'The previous worker left no changes; implement the story.',
    failure ? `\nKarkeDikha checked that work and it FAILED. Failed checks (expected vs actual):\n${failure.slice(0, 2_000)}` : '',
    '\nSmallest next action: change the implementation so the failing behaviours above work in general. Do not edit, delete or weaken tests.',
    `Then run ${spec.verify.join(' ')} and stop. Do not commit.`,
  ].filter(Boolean).join('\n');

  // Release the old task (its branch and the preserved ref keep the work), then dispatch one new task through the normal
  // path so dependency and file-overlap ordering still applies.
  if (task) {
    await kandev.setTaskState(task.id, 'CANCELLED').catch(() => { /* best effort */ });
    await kandev.rest('POST', `/tasks/${task.id}/archive`, {}).catch(() => { /* keep history if archive is refused */ });
    await kandev.rest('DELETE', `/workspaces/${workspaceId}/tasks/by-external-id?external_id=${encodeURIComponent(storyId)}`).catch(() => { /* already released */ });
  }
  addComment(db, storyId, { author, body: `[kkd-dev:retry] [kkd-dev:repair] ${why}. Fresh worker session on preserved work (${preserved.length} file(s), base ${base}); old Kandev task ${task?.id ?? 'none'} stopped and archived.` });
  const current = getStory(db, storyId);
  walk(db, current, current.status === 'blocked' ? ['ready'] : current.status === 'ready' ? [] : ['blocked', 'ready'], `fresh repair session: ${why}`);
  try {
    await dispatchDevStories(db, kandev, { projectId: story.projectId, storyIds: [storyId], repair: { [storyId]: { prompt, baseBranch: base } } });
  } catch (err) {
    return park((err as Error).message.slice(0, 300));
  }
  // Stories that were only waiting on this story's old task (same files) now wait on the new one.
  const fresh = await kandev.taskByExternalId(workspaceId, storyId);
  if (!task || !fresh) return;
  for (const other of listStories(db, { projectId: story.projectId, limit: 200 })) {
    const ospec = devSpec(other);
    if (!ospec || other.id === storyId || other.status === 'done' || !overlaps(spec.paths, ospec.paths).length) continue;
    const ot = await kandev.taskByExternalId(workspaceId, other.id).catch(() => null);
    if (!ot || (await kandev.sessions(ot.id)).length) continue;
    await kandev.tool('remove_task_dependency_kandev', { task_id: ot.id, depends_on_task_id: task.id }).catch(() => { /* was not linked */ });
    await kandev.tool('add_task_dependency_kandev', { task_id: ot.id, depends_on_task_id: fresh.id }).catch(() => { /* already linked */ });
  }
}

/**
 * A person reviewed a story that had no independent check and approves its integration. KKD still re-runs scope, diff,
 * the worker's tests (and any acceptance checks) before merging, and re-verifies the integrated result.
 */
export async function approveDevStoryReview(db: CoreDatabase, kandev: KandevClient, storyId: string, note?: string): Promise<void> {
  const story = getStory(db, storyId);
  const spec = devSpec(story);
  if (!spec) throw new CoreError('invalid_request', 'not a development story');
  if (story.status !== 'delivery_approval') throw new CoreError('conflict', `story is ${story.status}, not waiting for review`);
  if (integrating) throw new CoreError('conflict', 'another story is being integrated; try again in a moment');
  await kandev.ensureRunning();
  const workspaceId = await kandev.defaultWorkspaceId();
  const task = await kandev.taskByExternalId(workspaceId, storyId);
  const session = task ? (await kandev.sessions(task.id))[0] : undefined;
  if (!task || !session?.worktree_path) throw new CoreError('not_found', 'the story has no worker worktree to integrate');
  addComment(db, storyId, { author: 'user', body: `[kkd-dev:review-approved] ${note ?? 'Reviewed by the user.'}` });
  integrating = true;
  try {
    await verifyAndIntegrate(db, kandev, story, spec, task.id, session.worktree_path, session.id, true);
  } finally {
    integrating = false;
  }
}

/** Human action on a blocked or stopped story: give it a fresh retry budget and let the coordinator verify its next finished turn. */
export async function retryDevStory(db: CoreDatabase, kandev: KandevClient, storyId: string, note?: string): Promise<void> {
  const story = getStory(db, storyId);
  if (story.status !== 'blocked' && story.status !== 'delivery_approval') throw new CoreError('conflict', `story is ${story.status}, not blocked or waiting for review`);
  const open = predecessors(db, storyId).filter(d => getStory(db, d).status !== 'done');
  await kandev.ensureRunning();
  const workspaceId = await kandev.defaultWorkspaceId();
  const task = await kandev.taskByExternalId(workspaceId, storyId);
  // A story that failed verification or was parked for a silent worker restarts as a fresh session on its preserved work.
  const sinceStart = listComments(db, storyId);
  const failedSince = sinceStart.slice(sinceStart.map(c => /^\[kkd-dev:(retry|dispatched)\]/.test(c.body)).lastIndexOf(true) + 1).some(c => c.body.startsWith('[kkd-dev:verify-failed]') || c.body.includes('[kkd-dev:parked]'));
  if (story.status === 'blocked' && task && failedSince) return repairDevStory(db, kandev, storyId, note ?? 'Retry requested', 'user');
  addComment(db, storyId, { author: 'user', body: `[kkd-dev:retry] ${note ?? 'Retry requested.'}` });
  walk(db, story, ['implementing'], 'retry requested by the user');
  const wasStopped = isStoppedBeforeRetry(db, storyId);
  if (!task || open.length) return; // not dispatched yet, or still waits for predecessors (KKD releases it later)
  const ctx = await kandevContext(kandev);
  if (wasStopped && ctx.runningStepId && task.workflow_step_id !== ctx.runningStepId) {
    // Stop All parked the task in Backlog; put it back in the step that admits workers.
    await kandev.tool('move_task_kandev', { task_id: task.id, workflow_id: ctx.workflowId, workflow_step_id: ctx.runningStepId }).catch(() => { /* already there */ });
  }
  const session = (await kandev.sessions(task.id))[0];
  if (!session) return; // never started: Kandev starts it from "In Progress"
  // The stopped/failed session has ended. Relaunch it (agents with ACP session/load keep their context) and start a
  // new turn; verification only counts a turn that starts after this point.
  const status = await kandev.sessionStatus(task.id, session.id).catch(() => null);
  if (!status?.is_agent_running) await kandev.relaunchSession(task.id, session.id);
  const spec = devSpec(story)!;
  await sendFeedback(db, kandev, storyId, task.id, session.id, note ?? [
    'You were stopped before finishing. Continue this story from where you left off:', '', workerPrompt(story, spec),
  ].join('\n'));
}

export interface RetryReport {
  /** True when the retry is on record (the task left "needs you"), whether or not the worker is running yet. */
  ok: boolean;
  recorded: boolean;
  /** started = the worker was handed the task; pending = recorded, the worker has not started yet; not_started = nothing changed. */
  state: 'started' | 'pending' | 'not_started';
  /** What to tell the person, in plain words. */
  detail: string;
}

/**
 * A retry asked for by a person, reported as what really happened. `retryDevStory` records the retry first and then
 * starts the worker; when only that second half failed, the old route answered "an internal error occurred" and the
 * task screen said "Retry did not start" although the retry was on record and the task was already moving (live,
 * 2026-11-24: it then failed again normally and came back with its reason). Three different outcomes, three messages.
 */
export async function retryDevStoryReported(db: CoreDatabase, kandev: KandevClient, storyId: string, note?: string): Promise<RetryReport> {
  try {
    await retryDevStory(db, kandev, storyId, note);
    return { ok: true, recorded: true, state: 'started', detail: 'Retry started. If it fails again, the task comes back to "Needs you" with the new reason.' };
  } catch (err) {
    if (err instanceof CoreError) throw err; // e.g. the task is not waiting for a retry: the caller shows that reason as it is
    const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
    let status: string | null = null;
    try { status = getStory(db, storyId).status; } catch { /* the story is gone */ }
    if (status === 'implementing') {
      return { ok: true, recorded: true, state: 'pending', detail: `Retry recorded. The worker has not started yet (${why}); Pandesh keeps trying, and if it cannot start the task comes back to "Needs you" with the reason.` };
    }
    return { ok: false, recorded: false, state: 'not_started', detail: `Retry not started, nothing was changed: the worker service did not answer (${why}). The task is still waiting here.` };
  }
}

// ---------------------------------------------------------------- recovery: verify work that already exists

/** Content fingerprint of the files KKD is about to commit, so a worktree that changes mid-verification is caught. */
function worktreeFingerprint(worktree: string, files: string[]): string {
  const h = createHash('sha1');
  h.update(git(worktree, ['rev-parse', 'HEAD']).out);
  for (const f of [...files].sort()) {
    h.update(`\n${f}\0${fs.existsSync(path.join(worktree, f)) ? git(worktree, ['hash-object', '--', f]).out : 'deleted'}`);
  }
  return h.digest('hex').slice(0, 16);
}

/** Stops the worker and proves it is gone: Kandev must report no live agent process, and nothing it queued may stay approvable. */
async function confirmWorkerStopped(kandev: KandevClient, taskId: string, sessionId: string): Promise<{ stopped: boolean; detail: string }> {
  let detail = 'Kandev did not confirm that the worker process ended';
  for (let attempt = 0; attempt < 12; attempt++) {
    await kandev.stopTask(taskId, 'KKD: verifying the work that already exists').catch(() => { /* already idle */ });
    const session = (await kandev.sessions(taskId).catch(() => []))[0];
    const status = await kandev.sessionStatus(taskId, sessionId).catch(() => null);
    const live = session?.state === 'RUNNING' || session?.state === 'STARTING';
    if (status && !status.is_agent_running && !live) {
      for (const p of await kandev.pendingPermissions(taskId).catch(() => [])) await kandev.resolvePermission(p, 'reject_once').catch(() => { /* gone with the process */ });
      return { stopped: true, detail: `session ${session?.state ?? 'unknown'}, no agent process` };
    }
    detail = status ? `agent still running (session ${session?.state ?? 'unknown'})` : 'Kandev could not report the worker status';
    await new Promise(r => setTimeout(r, 1_000));
  }
  return { stopped: false, detail };
}

/** KKD committed this story's work on the worker branch (its message names the story) and the integration branch already contains it. */
function mergedByKkd(spec: DevStorySpec, storyId: string, worktree: string): boolean {
  if (!git(worktree, ['log', '-1', '--format=%B']).out.includes(`KKD story ${storyId}`)) return false;
  const integ = integrationWorktree(spec);
  return !integ.error && git(integ.dir, ['merge-base', '--is-ancestor', git(worktree, ['rev-parse', 'HEAD']).out, 'HEAD']).ok;
}

/** Re-runs the story's tests and independent checks on the integration branch as it stands. */
function proveIntegrated(spec: DevStorySpec, storyId: string, sha: string): { ok: true; sha: string; level: VerificationLevel } | { ok: false; what: string; detail: string } {
  const integ = integrationWorktree(spec);
  if (integ.error) return { ok: false, what: 'the integration worktree is unavailable', detail: integ.error };
  const post = sh(integ.dir, spec.verify);
  if (!post.ok) return { ok: false, what: `\`${spec.verify.join(' ')}\` failed on the integrated result`, detail: post.out };
  const checks = automatedChecks(spec.acceptance ?? []);
  if (checks.length) {
    const again = runAcceptance(storyId, checks, integ.dir);
    if (!again.ok) return { ok: false, what: 'independent acceptance failed on the integrated result', detail: again.evidence };
  }
  const merge = git(integ.dir, ['rev-list', '--merges', '--ancestry-path', '--reverse', `${sha}..HEAD`]).out.split('\n')[0];
  return { ok: true, sha: git(integ.dir, ['rev-parse', '--short', merge || 'HEAD']).out, level: checks.length ? 'independent' : 'worker-only' };
}

interface ReconciledWorktree { branch: string; head: string; ahead: number; files: string[]; dirty: number; fingerprint: string }

/** Does the worktree really belong to this story and repository, and what exactly is in it? Never trusts the session record alone. */
function reconcileWorktree(spec: DevStorySpec, session: KandevSession): ReconciledWorktree | { error: string } {
  const worktree = session.worktree_path;
  if (!worktree || !fs.existsSync(path.join(worktree, '.git'))) return { error: 'the worker has no worktree on disk' };
  // Compared where the paths really are: git reports the repository's full spelling, a story may hold an 8.3 short
  // or junction spelling of the same folder (Build 161 audit; the CI-only kandevStoryAcceptance failure). A junction
  // that points elsewhere now resolves to where it points, which only makes these checks stricter.
  const norm = (p: string) => {
    let resolved = path.resolve(p);
    try { resolved = fs.realpathSync.native(resolved); } catch { /* compared as spelled */ }
    return resolved.replace(/\\/g, '/').toLowerCase();
  };
  if (!norm(worktree).startsWith(`${norm(path.join(kandevHome(), 'tasks'))}/`)) return { error: 'the worktree is not one of Kandev\'s task worktrees' };
  const common = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
  if (!common || norm(common) !== norm(path.join(spec.repoPath, '.git'))) return { error: 'the worktree belongs to a different repository than this story\'s' };
  const branch = git(worktree, ['branch', '--show-current']).out;
  if (!branch) return { error: 'the worktree is on a detached HEAD' };
  if (session.worktree_branch && session.worktree_branch !== branch) return { error: `the worktree is on ${branch}, not the worker's branch ${session.worktree_branch}` };
  if ([spec.integrationBranch, spec.baseBranch, 'main', 'master'].includes(branch)) return { error: `the worktree is on ${branch}, which is not a worker branch` };
  if (git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok || git(worktree, ['rev-parse', '-q', '--verify', 'REBASE_HEAD']).ok) return { error: 'a merge or rebase is half-finished in the worktree' };
  if (!git(worktree, ['merge-base', spec.integrationBranch, 'HEAD']).ok) return { error: `the worktree shares no history with ${spec.integrationBranch}` };
  const files = changedFiles(worktree, spec.integrationBranch);
  const dirty = git(worktree, ['status', '--porcelain', '--untracked-files=all']).out.split('\n').filter(Boolean).length;
  const ahead = Number(git(worktree, ['rev-list', '--count', `${spec.integrationBranch}..HEAD`]).out) || 0;
  return { branch, head: git(worktree, ['rev-parse', '--short', 'HEAD']).out, ahead, files, dirty, fingerprint: worktreeFingerprint(worktree, files) };
}

/**
 * "Verify Existing Work": finishes a story whose worker is gone (cancelled, interrupted, restarted away) but whose
 * output is preserved in its worktree. Completed work must not depend on the conversation that produced it.
 * It starts no worker and replays nothing. Order: park the story and stop the worker for good → prove it is stopped →
 * reconcile worktree, branch, HEAD, diff and story binding → the normal gates (scope, protected paths, diff integrity,
 * the story's tests, independent acceptance) → merge onto the local integration branch → everything again on the result.
 * Only a passing run marks the story done; anything else leaves it blocked with the specific reason.
 */
export async function verifyExistingDevStory(db: CoreDatabase, kandev: KandevClient, storyId: string, note?: string): Promise<{ outcome: 'integrated' | 'blocked' | 'awaiting-review'; status: StoryStatus; commit: string | null; reason: string | null }> {
  const story = getStory(db, storyId);
  const spec = devSpec(story);
  if (!spec) throw new CoreError('invalid_request', 'not a development story');
  if (!['implementing', 'blocked'].includes(story.status)) throw new CoreError('conflict', `story is ${story.status}; only an implementing or blocked story with preserved work can be verified this way`);
  if (integrating) throw new CoreError('conflict', 'another story is being integrated; try again in a moment');
  integrating = true;
  const outcomeOf = () => outcomeShape(db, storyId);
  const stay = (reason: string) => {
    addComment(db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:needs-human] Verify Existing Work could not run: ${reason}. Nothing was integrated and the worker was not restarted.` });
    return outcomeOf();
  };
  try {
    // Park first (synchronously): from here no reconcile pass may restart, nudge or re-verify this story's worker.
    walk(db, story, ['blocked'], 'verifying the work that already exists; the worker stays stopped');
    addComment(db, storyId, { author: 'user', body: `[kkd-dev:verify-existing] ${note ?? 'Verify Existing Work requested.'}` });
    await kandev.ensureRunning();
    const workspaceId = await kandev.defaultWorkspaceId();
    const task = await kandev.taskByExternalId(workspaceId, storyId);
    if (!task || task.external_id !== storyId) return stay('this story has no Kandev task bound to it');
    // Every worker this story ever had (a reassign or retry may have replaced the task that holds the work): all must be gone.
    const taskIds = [...new Set([task.id, ...listComments(db, storyId).flatMap(c => [...c.body.matchAll(/Kandev task ([0-9a-f-]{36})/g)].map(m => m[1]))])];
    if (spec.mode === 'inspect') {
      // An inspection leaves no changes by design: what is preserved is the worker's report. Accept it under the same read-only checks.
      for (const id of taskIds) {
        const session = (await kandev.sessions(id).catch(() => []))[0];
        if (!session?.worktree_path) continue;
        if (!['CANCELLED', 'COMPLETED', 'FAILED'].includes(session.state)) {
          const s = await confirmWorkerStopped(kandev, id, session.id);
          if (!s.stopped) return stay(`a worker could not be confirmed stopped (${s.detail})`);
        }
        await verifyAndIntegrate(db, kandev, getStory(db, storyId), spec, task.id, session.worktree_path, session.id, false, { recovery: true });
        return outcomeOf();
      }
      return stay('the inspection has no preserved worker session');
    }
    const found: Array<{ taskId: string; session: KandevSession; facts: ReconciledWorktree }> = [];
    let stopped = { stopped: true, detail: 'no live agent' };
    let lastError = 'the story never started a worker, so there is no work to verify';
    let merged: { taskId: string; branch: string; sha: string } | null = null;
    for (const id of taskIds) {
      const session = (await kandev.sessions(id).catch(() => []))[0];
      if (!session) continue;
      if (!['CANCELLED', 'COMPLETED', 'FAILED'].includes(session.state)) {
        stopped = await confirmWorkerStopped(kandev, id, session.id);
        if (!stopped.stopped) return stay(`a worker could not be confirmed stopped (${stopped.detail})`);
      }
      const facts = reconcileWorktree(spec, session);
      if ('error' in facts) lastError = facts.error;
      else if (facts.files.length) found.push({ taskId: id, session, facts });
      else if (mergedByKkd(spec, storyId, session.worktree_path!)) merged = { taskId: id, branch: facts.branch, sha: git(session.worktree_path!, ['rev-parse', 'HEAD']).out };
    }
    if (merged) {
      // An earlier run already merged this story's commit; it only lacks the final proof and the Done transition.
      const proof = proveIntegrated(spec, story.id, merged.sha);
      if (!proof.ok) {
        addComment(db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:verify-failed] ${proof.what}\n${proof.detail}` });
        return stay(proof.what);
      }
      walk(db, getStory(db, storyId), ['review', 'validation', 'delivery_approval', 'merge_queue', 'done'], `already integrated as ${proof.sha}; re-verified on ${spec.integrationBranch}`);
      addComment(db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:integrated] ${proof.sha} on ${spec.integrationBranch} (branch ${merged.branch}); level=${proof.level} (verified from preserved worker output; worker not restarted; merge already present, re-verified); \`${spec.verify.join(' ')}\`${proof.level === 'independent' ? ' and independent acceptance' : ''} passed on the integrated result.` });
      await kandev.stopTask(task.id, 'KKD integrated the story').catch(() => { /* already idle */ });
      await kandev.setTaskState(task.id, 'COMPLETED');
      return outcomeOf();
    }
    if (!found.length) return stay(lastError === 'the story never started a worker, so there is no work to verify' ? lastError : `no worker left changes to verify (${lastError})`);
    // The worktree holding the most changes is the preserved work; a worker that was started later and barely began is not.
    found.sort((a, b) => b.facts.files.length - a.facts.files.length);
    const { session, facts } = found[0];
    addComment(db, storyId, {
      author: DEV_ACTOR,
      body: `[kkd-dev:reconciled] worker stopped (${stopped.detail}); branch ${facts.branch} at ${facts.head}, ${facts.ahead} commit(s) ahead of ${spec.integrationBranch}, ${facts.dirty} uncommitted path(s), ${facts.files.length} changed file(s), fingerprint ${facts.fingerprint}.`,
    });
    await verifyAndIntegrate(db, kandev, getStory(db, storyId), spec, task.id, session.worktree_path!, session.id, false, { recovery: true, fingerprint: facts.fingerprint });
  } catch (err) {
    if (getStory(db, storyId).status !== 'done') stay(`unexpected error: ${(err as Error).message.slice(0, 300)}`);
  } finally {
    integrating = false;
  }
  return outcomeOf();
}

function outcomeShape(db: CoreDatabase, storyId: string): { outcome: 'integrated' | 'blocked' | 'awaiting-review'; status: StoryStatus; commit: string | null; reason: string | null } {
  const story = getStory(db, storyId);
  const comments = listComments(db, storyId);
  const last = (tag: string) => [...comments].reverse().find(c => c.body.startsWith(`[kkd-dev:${tag}]`))?.body ?? null;
  if (story.status === 'done') return { outcome: 'integrated', status: story.status, commit: last('integrated')?.match(/\] (\w+)/)?.[1] ?? null, reason: null };
  if (story.status === 'delivery_approval') return { outcome: 'awaiting-review', status: story.status, commit: null, reason: last('awaiting-review') };
  return { outcome: 'blocked', status: story.status, commit: null, reason: (last('needs-human') ?? last('verify-failed') ?? '').replace(/^\[kkd-dev:[\w-]+\]\s*/, '').slice(0, 600) || null };
}

/**
 * When the worker was last handed work: a delivered follow-up (its pre-send instant), a retry, or optionally the
 * dispatch. Only a Kandev turn that started after this counts as finished work.
 */
function handOffEpoch(comments: Array<{ body: string; createdAt: string }>, includeDispatch: boolean): string | undefined {
  const re = includeDispatch ? /^\[kkd-dev:(feedback-sent|retry|dispatched)\]/ : /^\[kkd-dev:(feedback-sent|retry)\]/;
  const c = [...comments].reverse().find(x => re.test(x.body));
  if (!c) return undefined;
  const stamped = /^\[kkd-dev:feedback-sent\] @(\S+)/.exec(c.body)?.[1];
  if (stamped) return stamped;
  // Older feedback markers were written after sending; the turn may have started up to a moment before them.
  return c.body.startsWith('[kkd-dev:feedback-sent]') ? new Date(Date.parse(c.createdAt) - 2_000).toISOString() : c.createdAt;
}

/** True when the story's latest stop/retry marker before the retry just recorded was a Stop All. */
function isStoppedBeforeRetry(db: CoreDatabase, storyId: string): boolean {
  const tags = listComments(db, storyId).map(c => c.body).filter(b => /^\[kkd-dev:(stopped|retry)\]/.test(b));
  return tags.at(-2)?.startsWith('[kkd-dev:stopped]') ?? false;
}

function isStopped(db: CoreDatabase, storyId: string): boolean {
  // A verify-existing request is a deliberate action on the story, so a failure after it is announced like any other block.
  const tags = listComments(db, storyId).map(c => c.body).filter(b => /^\[kkd-dev:(stopped|retry|verify-existing)\]/.test(b));
  return tags.at(-1)?.startsWith('[kkd-dev:stopped]') ?? false;
}

/**
 * Stop All: halts every worker and parks every unfinished development story so nothing restarts on its own — not
 * after a Kandev or Core restart and not when a worker slot frees up. Each story becomes `blocked` with a
 * `[kkd-dev:stopped]` marker and its Kandev task moves to Backlog; it resumes only through an explicit retry.
 * A merge already in progress is allowed to finish first (it is a few seconds of local git work).
 */
export async function stopAllDevStories(db: CoreDatabase, kandev: KandevClient, reason = 'Stop All requested by the user'): Promise<{ stopped: string[]; stillRunning: string[]; kandevAvailable: boolean }> {
  for (let i = 0; integrating && i < 120; i++) await new Promise(r => setTimeout(r, 500));
  const stories = listStories(db, { limit: 200 }).filter(s => devSpec(s) && STOPPABLE.includes(s.status));
  return stopStories(db, kandev, stories, reason);
}

const STOPPABLE: StoryStatus[] = ['implementing', 'review', 'validation', 'delivery_approval', 'merge_queue'];

/** Stops one story's worker and parks the story exactly as Stop All does, leaving every other story alone. */
export async function stopDevStory(db: CoreDatabase, kandev: KandevClient, storyId: string, reason = 'Stopped by the user'): Promise<{ stopped: string[]; stillRunning: string[]; kandevAvailable: boolean }> {
  const story = getStory(db, storyId);
  if (!devSpec(story)) throw new CoreError('invalid_request', 'not a development story');
  if (!STOPPABLE.includes(story.status)) throw new CoreError('conflict', `story is ${story.status}; there is nothing to stop`);
  for (let i = 0; integrating && i < 120; i++) await new Promise(r => setTimeout(r, 500));
  return stopStories(db, kandev, [getStory(db, storyId)], reason);
}

async function stopStories(db: CoreDatabase, kandev: KandevClient, stories: StoryRecord[], reason: string): Promise<{ stopped: string[]; stillRunning: string[]; kandevAvailable: boolean }> {
  const available = await kandev.healthy();
  const ctx = available ? await kandevContext(kandev).catch(() => null) : null;
  const stopped: string[] = [];
  const tasks: Array<{ storyId: string; taskId: string }> = [];
  for (const story of stories) {
    walk(db, getStory(db, story.id), ['blocked'], reason);
    addComment(db, story.id, { author: 'user', body: `[kkd-dev:stopped] ${reason}` });
    stopped.push(story.id);
    if (!ctx) continue;
    const task = await kandev.taskByExternalId(ctx.workspaceId, story.id).catch(() => null);
    if (!task) continue;
    tasks.push({ storyId: story.id, taskId: task.id });
    if (ctx.backlogStepId) await kandev.tool('move_task_kandev', { task_id: task.id, workflow_id: ctx.workflowId, workflow_step_id: ctx.backlogStepId }).catch(() => { /* deferred or already there */ });
    await kandev.stopTask(task.id, reason).catch(() => { /* not running */ });
  }
  // Confirm the workers are really gone; report the truth rather than assuming.
  const stillRunning: string[] = [];
  for (let attempt = 0; attempt < 10 && tasks.length; attempt++) {
    stillRunning.length = 0;
    for (const t of tasks) {
      const session = (await kandev.sessions(t.taskId).catch(() => []))[0];
      if (!session) continue;
      const status = await kandev.sessionStatus(t.taskId, session.id).catch(() => null);
      if (status?.is_agent_running && (session.state === 'RUNNING' || session.state === 'STARTING')) {
        stillRunning.push(t.storyId);
        await kandev.stopTask(t.taskId, reason).catch(() => { /* retry next round */ });
      }
    }
    if (!stillRunning.length) break;
    await new Promise(r => setTimeout(r, 1_000));
  }
  return { stopped, stillRunning: [...stillRunning], kandevAvailable: available };
}

/**
 * Moves an unfinished story to another agent: stops and archives its Kandev task, releases the external_id binding,
 * records the new agent on the story, and puts it back to `ready` for the next dispatch. Worktree changes made by the
 * previous worker stay on its branch and are not carried over.
 */
export async function reassignDevStory(db: CoreDatabase, kandev: KandevClient, storyId: string, agent: DevAgent, model?: string): Promise<StoryRecord> {
  const story = getStory(db, storyId);
  const spec = devSpec(story);
  if (!spec) throw new CoreError('invalid_request', 'not a development story');
  if (story.status === 'done' || story.status === 'merge_queue') throw new CoreError('conflict', `story is ${story.status}`);
  if (!AGENT_IDS[agent]) throw new CoreError('invalid_request', `unknown agent '${agent}'`);
  const workspaceId = await kandev.defaultWorkspaceId();
  const task = await kandev.taskByExternalId(workspaceId, storyId);
  if (task) {
    await kandev.stopTask(task.id, `KKD reassigned the story to ${agent}`).catch(() => { /* not running */ });
    await kandev.setTaskState(task.id, 'CANCELLED').catch(() => { /* best effort */ });
    await kandev.rest('POST', `/tasks/${task.id}/archive`, {}).catch(() => { /* keep history if archive is refused */ });
    await kandev.rest('DELETE', `/workspaces/${workspaceId}/tasks/by-external-id?external_id=${encodeURIComponent(storyId)}`).catch(() => { /* already released */ });
  }
  const next: DevStorySpec = { ...spec, agent, model };
  db.transaction(() => {
    db.run('UPDATE stories SET source = ?, assignee = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?', [
      JSON.stringify({ ...(story.source ?? {}), devStory: next }), JSON.stringify({ agent, model: model ?? null }), new Date().toISOString(), storyId,
    ]);
    recordStoryEvent(db, { storyId, eventType: 'story_updated', actor: DEV_ACTOR, metadata: { reassigned: { from: spec.agent, to: agent, kandevTaskId: task?.id ?? null } } });
  });
  addComment(db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:reassigned] ${spec.agent} → ${agent}${task ? ` (Kandev task ${task.id} cancelled and archived)` : ''}` });
  const current = getStory(db, storyId);
  const chain: StoryStatus[] = current.status === 'blocked' ? ['ready'] : current.status === 'ready' ? [] : ['blocked', 'ready'];
  return walk(db, current, chain, `reassigned to ${agent}`);
}

/** Resolves a held worker permission on the user's behalf (Panda approval). */
export async function decideDevPermission(db: CoreDatabase, kandev: KandevClient, storyId: string, pendingId: string, allow: boolean, decidedBy = 'unattributed'): Promise<void> {
  const workspaceId = await kandev.defaultWorkspaceId();
  const task = await kandev.taskByExternalId(workspaceId, storyId);
  if (!task) throw new CoreError('not_found', 'story has no Kandev task');
  const p = (await kandev.pendingPermissions(task.id)).find(x => x.pending_id === pendingId);
  if (!p) throw new CoreError('conflict', 'that request is no longer pending');
  await kandev.resolvePermission(p, allow ? 'allow_once' : 'reject_once');
  addComment(db, storyId, { author: 'user', body: `[kkd-dev:decided] ${allow ? 'Allowed' : 'Denied'} (by ${decidedBy}): ${p.action?.command ?? p.action?.path ?? p.title ?? pendingId}` });
}

// ---------------------------------------------------------------- compact status for Panda / Pandesh

export interface DevStoryView {
  id: string; title: string; agent: DevAgent; status: StoryStatus; phase: string; waitingReason: string | null;
  dependsOn: string[]; createdAt: string; updatedAt: string; kandevTaskId: string | null; branch: string | null;
  commit: string | null; evidence: string | null;
  /** independent = KKD's own acceptance checks passed; human-reviewed = a person approved it; worker-only = only the worker's tests ran. */
  verification: 'independent' | 'human-reviewed' | 'worker-only' | null; acceptanceChecks: number; pendingApprovals: Array<{ pendingId: string; what: string }>;
  /** Steps KKD cannot automate (a physical phone). `awaiting` until the user confirms; automated checks passing never clears it. */
  deviceVerification: { state: 'awaiting' | 'confirmed'; instructions: string[] } | null;
  /** The worker's last few real actions/messages (live, from Kandev); empty when nothing is running. */
  activity: Array<{ at: string; kind: string; text: string }>;
  /** Failed independent verifications so far and how many corrections KKD sends back before asking the user. */
  attempts: { failedVerifications: number; maxCorrections: number };
}

function deviceVerificationOf(story: StoryRecord, spec: DevStorySpec, comments: Array<{ body: string }>): DevStoryView['deviceVerification'] {
  const steps = deviceChecks(spec.acceptance ?? []);
  if (!steps.length) return null;
  const confirmed = comments.some(c => c.body.startsWith('[kkd-dev:device-verified]'));
  return { state: confirmed ? 'confirmed' : 'awaiting', instructions: steps.map(d => `${d.name}: ${d.instructions}`) };
}

/** The user ran the device steps and says they pass (or fail: pass `ok:false`, which keeps the story awaiting and records why). */
export function confirmDeviceVerification(db: CoreDatabase, storyId: string, ok: boolean, note?: string): void {
  const story = getStory(db, storyId);
  const spec = devSpec(story);
  if (!spec || !deviceChecks(spec.acceptance ?? []).length) throw new CoreError('invalid_request', 'this story has no device verification steps');
  addComment(db, storyId, { author: 'user', body: ok ? `[kkd-dev:device-verified] ${note ?? 'Verified on the device.'}` : `[kkd-dev:device-failed] ${note ?? 'Failed on the device.'}` });
}

export function verificationOf(evidence: string | null, done: boolean): DevStoryView['verification'] {
  if (!evidence) return null;
  // Only KKD's own header line says what was verified. The rest is the worker's report, which may quote these very words
  // (seen live 2026-11-21: an inspection of this file was labelled "reviewed by a person").
  const header = evidence.split('\n', 1)[0];
  if (/level=independent/.test(header)) return 'independent';
  if (/human-reviewed/.test(header)) return 'human-reviewed';
  return done || /level=worker-only/.test(header) ? 'worker-only' : null;
}

export async function devStoryStatus(db: CoreDatabase, kandev: KandevClient, projectId?: string, onlyStoryId?: string): Promise<{ available: boolean; counts: Record<string, number>; stories: DevStoryView[] }> {
  const stories = listStories(db, { projectId, limit: 200 }).filter(s => devSpec(s) && !s.archivedAt);
  const available = await kandev.healthy();
  const workspaceId = available ? await kandev.defaultWorkspaceId().catch(() => null) : null;
  const titles = new Map(stories.map(s => [s.id, s.title]));
  const views: DevStoryView[] = [];
  // One story's detail (a relayed task refreshed every few seconds) must not query Kandev for every other story too.
  for (const s of onlyStoryId ? stories.filter(x => x.id === onlyStoryId) : stories) {
    const comments = listComments(db, s.id);
    const last = (tag: string) => [...comments].reverse().find(c => c.body.startsWith(`[kkd-dev:${tag}]`))?.body ?? null;
    const task = workspaceId ? await kandev.taskByExternalId(workspaceId, s.id).catch(() => null) : null;
    const session = task ? (await kandev.sessions(task.id).catch(() => []))[0] : undefined;
    const pending = task && session ? await kandev.pendingPermissions(task.id).catch(() => []) : [];
    const activity = s.status === 'implementing' && session ? (await kandev.agentMessages(session.id, 12).catch(() => [])).filter(m => ['message', 'tool_execute', 'tool_edit', 'tool_read', 'tool_search'].includes(m.kind)).slice(-3).map(m => ({ at: m.at, kind: m.kind.replace(/^tool_/, ''), text: m.text.replace(/\s+/g, ' ').slice(0, 160) })) : [];
    const deps = predecessors(db, s.id);
    const openDeps = deps.filter(d => { try { return getStory(db, d).status !== 'done'; } catch { return false; } });
    let phase: string = s.status;
    let waiting: string | null = null;
    if (s.status === 'implementing') {
      if (!task) phase = 'not dispatched';
      else if (!session) { phase = 'waiting'; waiting = openDeps.length ? `waiting for ${openDeps.map(d => `"${titles.get(d) ?? d}"`).join(', ')}` : (last('dispatched')?.split('\n').find(l => l.startsWith('Waits for:')) ?? 'waiting for a free worker slot'); }
      else if (pending.length) { phase = 'needs approval'; waiting = 'a worker action needs your decision'; }
      else if (session.state === 'RUNNING' || session.state === 'STARTING') phase = 'running';
      else {
        // Only a turn that completed after the latest hand-off counts as finished; otherwise the worker is starting.
        const epoch = handOffEpoch(comments, true) ?? '';
        const turn = await kandev.latestTurn(session.id).catch(() => null);
        phase = turn?.completed_at && turn.started_at > epoch ? 'turn finished — verifying' : 'starting';
      }
    } else if (s.status === 'delivery_approval') { phase = 'awaiting review'; waiting = 'the worker finished and its tests pass, but nothing independent verified it — review the change, then approve'; }
    else if (s.status === 'review' || s.status === 'validation') phase = 'verifying';
    else if (s.status === 'merge_queue') phase = 'integrating';
    else if (s.status === 'blocked' && isStopped(db, s.id)) { phase = 'stopped'; waiting = 'stopped by you — nothing runs until you retry it'; }
    else if (s.status === 'blocked') { phase = 'blocked'; waiting = last('needs-human') ?? last('verify-failed'); }
    if (!available && ACTIVE.includes(s.status)) waiting = 'Kandev is not running — start it with scripts/kandev/start-kandev.ps1';
    views.push({
      id: s.id, title: s.title, agent: devSpec(s)!.agent, status: s.status, phase, waitingReason: waiting,
      dependsOn: deps.map(d => titles.get(d) ?? d), createdAt: s.createdAt, updatedAt: s.updatedAt, kandevTaskId: task?.id ?? null,
      branch: session?.worktree_branch ?? null, commit: last('integrated')?.match(/\] (\w+)/)?.[1] ?? null,
      evidence: last('integrated') ?? last('inspected') ?? last('awaiting-review') ?? last('verified') ?? last('verify-failed'),
      verification: verificationOf(last('integrated') ?? last('inspected') ?? last('verified'), s.status === 'done'),
      acceptanceChecks: automatedChecks(devSpec(s)!.acceptance ?? []).length,
      deviceVerification: deviceVerificationOf(s, devSpec(s)!, comments),
      attempts: { failedVerifications: comments.filter(c => c.body.startsWith('[kkd-dev:verify-failed]')).length, maxCorrections: MAX_VERIFY_RETRIES },
      pendingApprovals: pending.map(p => { const what = p.action?.command ?? p.action?.path ?? p.title ?? 'action'; rememberOwnerView(p.pending_id, what); return { pendingId: p.pending_id, what }; }),
      activity,
    });
  }
  const counts: Record<string, number> = { running: 0, completed: 0, ready: 0, blocked: 0, approval: 0, waiting: 0, verifying: 0, review: 0 };
  for (const v of views) {
    if (v.status === 'done') counts.completed++;
    else if (v.status === 'delivery_approval') counts.review++;
    else if (v.status === 'ready') counts.ready++;
    else if (v.status === 'blocked') counts.blocked++;
    else if (v.phase === 'needs approval') counts.approval++;
    else if (v.phase === 'running') counts.running++;
    else if (v.phase === 'waiting') counts.waiting++;
    else counts.verifying++;
  }
  return { available, counts, stories: views };
}

const TIMELINE_EVENTS = new Set(['dispatched', 'verify-failed', 'verified', 'integrated', 'inspected', 'awaiting-review', 'needs-human', 'stopped', 'retry', 'reassigned', 'decided', 'device-verified', 'device-failed']);

/**
 * What a pending worker permission really asks, paths included, for the OWNER's own approval card only. Task details and anything a
 * paired client (ChatGPT) reads carry the redacted text; the owner must see the real path to decide (live b188h 2026-11-23: five cards
 * read "<path>"). Memory only, refilled from Kandev on every status read, bounded.
 */
const ownerView = new Map<string, string>();
function rememberOwnerView(pendingId: string, what: string): void {
  ownerView.delete(pendingId); ownerView.set(pendingId, what);
  while (ownerView.size > 500) ownerView.delete(ownerView.keys().next().value!);
}
export function ownerViewOfPending(pendingId: string): string | null { return ownerView.get(pendingId) ?? null; }

/** Worktrees and home folders are private to this PC: absolute paths never leave Core in a task detail. */
function redactPrivatePaths(text: string): string {
  return text.replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/(?:home|Users|tmp|var)\/)[^\s"'`<>|,;]*[^\s"'`<>|,;.]/g, '<path>');
}

/** One story for the phone: the status view plus a chronological timeline and the files the last verification saw changed. */
/** Kandev message kinds that are observable worker events (its prose, tool calls, permission requests, session status). */
const WORKER_EVENT = /^(message|tool_[a-z_]+|permission_request|status)$/;

/**
 * The worker's recent observable events for one story, newest last, straight from Kandev: what it said, the tools it called, the
 * permissions it asked for. Nothing is invented or summarised; text is whitespace-collapsed, capped and stripped of private paths.
 * Returns null when there is no Kandev task or session yet (or Kandev is unreachable).
 */
export async function devStoryWorkerEvents(kandev: KandevClient, storyId: string, limit = 50): Promise<{ branch: string | null; events: Array<{ id: string; at: string; kind: string; text: string; status?: string }> } | null> {
  try {
    const workspaceId = await kandev.defaultWorkspaceId();
    const task = await kandev.taskByExternalId(workspaceId, storyId);
    if (!task) return null;
    const session = (await kandev.sessions(task.id))[0];
    if (!session) return null;
    const messages = await kandev.agentMessages(session.id, limit);
    return {
      branch: session.worktree_branch ?? null,
      events: messages.filter(m => m.id && WORKER_EVENT.test(m.kind)).map(m => ({
        id: m.id, at: m.at, kind: m.kind, text: redactPrivatePaths(m.text.replace(/\s+/g, ' ').trim()).slice(0, 400), ...(m.status ? { status: m.status } : {}),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * The story's change as a read-only diff (the review's "View diff"). Before approval it is read from the worker's worktree, after
 * reconcileWorktree has proven that worktree is Kandev's and belongs to this story's repository. After integration it is read from
 * the integration branch in the story's own repository. Nothing is written and nothing is approved here.
 */
export async function devStoryChangeDiff(db: CoreDatabase, kandev: KandevClient, storyId: string): Promise<ChangeDiff & { ignored: string[] }> {
  const story = getStory(db, storyId);
  const spec = devSpec(story);
  if (!spec) throw new CoreError('invalid_request', 'not a development story');
  const none = (reason: string, source: ChangeDiff['source'] = null) => ({ ...unavailableDiff(reason, source), ignored: [] });
  if (story.status === 'done' || story.status === 'merge_queue') {
    const repo = spec.repoPath;
    if (!fs.existsSync(path.join(repo, '.git'))) return none('The repository that holds the approved change is gone.', 'private copy');
    const top = git(repo, ['rev-parse', '--show-toplevel']).out;
    if (!top || path.resolve(top).toLowerCase() !== path.resolve(repo).toLowerCase()) return none('The repository that holds the approved change could not be confirmed.', 'private copy');
    const tip = `refs/heads/${spec.integrationBranch}`;
    if (!git(repo, ['rev-parse', '--verify', '--quiet', tip]).ok) return none('The approved change is no longer in its branch.', 'private copy');
    const base = spec.codeCopy?.sourceHead && git(repo, ['cat-file', '-e', `${spec.codeCopy.sourceHead}^{commit}`]).ok ? spec.codeCopy.sourceHead : git(repo, ['merge-base', spec.baseBranch, tip]).out;
    if (!base) return none('The change could not be compared with its base.', 'private copy');
    return readChangeDiff(repo, base, tip, { source: 'private copy', ignore: AGENT_OWN_FILES });
  }
  const workspaceId = await kandev.defaultWorkspaceId();
  const task = await kandev.taskByExternalId(workspaceId, storyId);
  const session = task ? (await kandev.sessions(task.id).catch(() => []))[0] : undefined;
  if (!session) return none('The worker has not started, so there is no change yet.', 'worker worktree');
  const facts = reconcileWorktree(spec, session);
  if ('error' in facts) return none(`The diff is not shown: ${facts.error}.`, 'worker worktree');
  const base = git(session.worktree_path!, ['merge-base', spec.integrationBranch, 'HEAD']).out;
  if (!base) return none('The change could not be compared with its base.', 'worker worktree');
  return readChangeDiff(session.worktree_path!, base, null, { source: 'worker worktree', ignore: AGENT_OWN_FILES });
}

export async function devStoryDetail(db: CoreDatabase, kandev: KandevClient, storyId: string): Promise<{ story: DevStoryView; timeline: Array<{ at: string; event: string; text: string }>; changedFiles: string[] }> {
  const found = (await devStoryStatus(db, kandev, undefined, storyId)).stories.find(v => v.id === storyId);
  if (!found) throw new CoreError('not_found', 'task not found');
  // No Kandev identifiers, worker configuration or private filesystem locations in the detail.
  const story: DevStoryView = {
    ...found, kandevTaskId: null,
    waitingReason: found.waitingReason && redactPrivatePaths(found.waitingReason),
    evidence: found.evidence && redactPrivatePaths(found.evidence),
    pendingApprovals: found.pendingApprovals.map(p => ({ ...p, what: redactPrivatePaths(p.what) })),
  };
  const comments = listComments(db, storyId);
  const timeline: Array<{ at: string; event: string; text: string }> = [];
  for (const c of comments) {
    const m = /^\[kkd-dev:([a-z-]+)\]\s*([\s\S]*)$/.exec(c.body);
    if (m && TIMELINE_EVENTS.has(m[1])) timeline.push({ at: c.createdAt, event: m[1], text: redactPrivatePaths(m[2].trim()) });
  }
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const verified = [...comments].reverse().find(c => c.body.startsWith('[kkd-dev:verified]'));
  const changed = verified ? /^Changed:\s*(.+)$/m.exec(verified.body)?.[1] : undefined;
  const changedFiles = changed ? changed.split(',').map(f => f.trim()).filter(Boolean) : [];
  return { story, timeline, changedFiles };
}

// ---------------------------------------------------------------- worker tasks that need the person

export interface WorkerAttentionItem {
  storyId: string; title: string; agent: string;
  /** failed = the worker could not start or its result was rejected for good; awaiting_review = finished, waits for the person's review. */
  state: 'failed' | 'awaiting_review';
  /** The recorded reason, as KKD wrote it when it happened (private paths removed). */
  reason: string;
  /** When that failure or review request was recorded. */
  since: string;
  /** The chat the task was started from, when it still exists. */
  conversationId: string | null;
  /** The task's own recorded events, oldest first (the last ones). */
  timeline: Array<{ at: string; event: string; text: string }>;
  canRetry: boolean;
}

/**
 * Worker tasks that wait for the person, read from Core's own records only (no call to Kandev, so the task screen can
 * ask every few seconds and still sees them while Kandev is down). A failed task stays here, with its real reason and
 * recorded events, until it is retried, reassigned or stopped: the chat is told once, the task screen keeps showing it.
 */
export function devStoriesNeedingAttention(db: CoreDatabase): WorkerAttentionItem[] {
  const out: WorkerAttentionItem[] = [];
  for (const s of listStories(db, { limit: 200 })) {
    if (s.archivedAt || (s.status !== 'blocked' && s.status !== 'delivery_approval')) continue;
    const spec = devSpec(s);
    if (!spec) continue;
    // Report markers are bookkeeping, not events (and one flooded story had 30,000 of them): never loaded here.
    const comments = db.all<{ body: string; createdAt: string }>("SELECT body, createdAt FROM story_comments WHERE storyId = ? AND body NOT LIKE '[kkd-dev:reported]%' ORDER BY createdAt ASC", [s.id]);
    const lastTag = comments.map(c => /^\[kkd-dev:(stopped|retry|verify-existing)\]/.test(c.body)).lastIndexOf(true);
    if (s.status === 'blocked' && lastTag >= 0 && comments[lastTag].body.startsWith('[kkd-dev:stopped]')) continue; // stopped by the person: nothing to decide
    const sinceRetry = comments.slice(comments.map(c => c.body.startsWith('[kkd-dev:retry]')).lastIndexOf(true) + 1).reverse();
    const hit = s.status === 'delivery_approval'
      ? [...comments].reverse().find(c => c.body.startsWith('[kkd-dev:awaiting-review]'))
      : sinceRetry.find(c => c.body.startsWith('[kkd-dev:needs-human]')) ?? sinceRetry.find(c => c.body.startsWith('[kkd-dev:verify-failed]'));
    const reason = hit ? hit.body.replace(/^(\[kkd-dev:[\w-]+\]\s*)+/, '').split('\n')[0].slice(0, 400) : (s.status === 'blocked' ? 'Blocked; no reason was recorded.' : 'The worker finished; nothing independent verified it. Review the change, then approve.');
    const reportTo = comments.find(c => c.body.startsWith('[kkd-dev:report-to] '))?.body.split(' ')[1] ?? null;
    const conversationId = reportTo && db.get('SELECT 1 AS x FROM conversations WHERE id = ?', [reportTo]) ? reportTo : null;
    const timeline: WorkerAttentionItem['timeline'] = [];
    for (const c of comments) {
      const m = /^\[kkd-dev:([a-z-]+)\]\s*([\s\S]*)$/.exec(c.body);
      if (m && TIMELINE_EVENTS.has(m[1])) timeline.push({ at: c.createdAt, event: m[1], text: redactPrivatePaths(m[2].replace(/^(\[kkd-dev:[\w-]+\]\s*)+/, '').trim()).slice(0, 400) });
    }
    out.push({
      storyId: s.id, title: s.title, agent: spec.agent,
      state: s.status === 'blocked' ? 'failed' : 'awaiting_review',
      reason: redactPrivatePaths(reason), since: hit?.createdAt ?? s.updatedAt, conversationId,
      timeline: timeline.slice(-8), canRetry: true,
    });
  }
  return out.sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
}

// ---------------------------------------------------------------- reporting back to the chat

/**
 * Posts story milestones into the conversation the stories were dispatched from: each integration, each story that
 * needs the user, and one final report when every story of the batch is completed or needs a human. Every message
 * is derived from KKD's own evidence comments and posted once (tracked by `[kkd-dev:reported]` markers), so restarts
 * neither lose nor repeat reports.
 */
/**
 * A report key in the form it is stored and compared. `addComment` trims the comment body, so a key cut from a longer
 * text that happened to end in a space was stored without it and never matched again: one failed worker story posted
 * its "needs you" message on every 5-second poll, 30,163 times in three days (found 2026-11-24). Every key goes through
 * this before it is written or looked up, so what is compared is always what is stored.
 */
export function reportKey(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Posts one report into a conversation at most once per (story, key), whoever calls it and however often: the marker
 * is looked up in the database in its stored form, and the marker and the message are written in ONE transaction, so
 * neither a repeated poll, a restart, a replayed event nor a failure between the two writes can post it a second time.
 * Returns true when a message was written now. A deleted conversation still records the marker (nothing to retry).
 */
export function postStoryReportOnce(db: CoreDatabase, input: { storyId: string; conversationId: string; key: string; content: string }): boolean {
  const marker = `[kkd-dev:reported] ${reportKey(input.key)}`;
  return db.transaction(() => {
    if (db.get('SELECT 1 AS x FROM story_comments WHERE storyId = ? AND body = ? LIMIT 1', [input.storyId, marker])) return false;
    addComment(db, input.storyId, { author: DEV_ACTOR, body: marker });
    try {
      appendMessage(db, input.conversationId, { role: 'assistant', content: input.content, actor: DEV_ACTOR });
    } catch { /* conversation deleted: the marker stays, so this is not retried forever */ }
    return true;
  });
}

export function reportDevStoryProgress(db: CoreDatabase): number {
  const rows = db.all<{ storyId: string; body: string }>(
    "SELECT storyId, body FROM story_comments WHERE body LIKE '[kkd-dev:report-to]%'",
  );
  const batches = new Map<string, { conversationId: string; storyIds: string[] }>();
  for (const r of rows) {
    const m = /^\[kkd-dev:report-to\] (\S+) batch=(\S+)/.exec(r.body);
    if (!m) continue;
    const b = batches.get(m[2]) ?? { conversationId: m[1], storyIds: [] };
    if (!b.storyIds.includes(r.storyId)) b.storyIds.push(r.storyId);
    batches.set(m[2], b);
  }
  let posted = 0;
  for (const [batchId, batch] of batches) {
    const stories = batch.storyIds.map(id => { try { return getStory(db, id); } catch { return null; } }).filter((s): s is StoryRecord => Boolean(s));
    const reported = (id: string) => new Set(listComments(db, id).filter(c => c.body.startsWith('[kkd-dev:reported]')).map(c => reportKey(c.body.slice('[kkd-dev:reported]'.length))));
    const post = (storyId: string, rawKey: string, content: string) => {
      if (postStoryReportOnce(db, { storyId, conversationId: batch.conversationId, key: rawKey, content })) posted++;
    };
    const tag = (s: StoryRecord, t: string) => [...listComments(db, s.id)].reverse().find(c => c.body.startsWith(`[kkd-dev:${t}]`))?.body ?? null;
    for (const s of stories) {
      const done = reported(s.id);
      const integrated = tag(s, 'integrated');
      if (s.status === 'done' && integrated) {
        const key = `integrated ${integrated.slice(0, 60)}`;
        if (!done.has(reportKey(key))) post(s.id, key, `✅ **${s.title}** is done — ${devSpec(s)!.agent} finished; ${verificationPhrase(integrated, devSpec(s)!)}: ${integrated.replace('[kkd-dev:integrated] ', '')}${deviceVerificationOf(s, devSpec(s)!, listComments(db, s.id))?.state === 'awaiting' ? '\n⏳ Awaiting device verification: automated checks passed, but this has not been verified on a physical phone.' : ''}`);
      } else if (s.status === 'implementing') {
        // A worker action KKD's policy cannot allow on its own is waiting for a person. Without a chat message the run
        // just looks hung (and every story queued behind it with it).
        const comments = listComments(db, s.id);
        const approvalAt = comments.map(c => c.body.startsWith('[kkd-dev:approval] ')).lastIndexOf(true);
        const lastApproval = approvalAt >= 0 ? comments[approvalAt] : undefined;
        // Comment order, not timestamps: a decision can land in the same millisecond as the request.
        if (lastApproval && !comments.slice(approvalAt + 1).some(c => /^\[kkd-dev:(decided|retry|stopped)\]/.test(c.body))) {
          const lines = lastApproval.body.split(/\r?\n/);
          const pendingId = lines[0].slice('[kkd-dev:approval] '.length);
          const key = `approval ${pendingId}`;
          if (!done.has(reportKey(key))) post(s.id, key, `⏸ **${s.title}** is paused and needs your decision: ${lines.slice(1).join(' ').slice(0, 400)}\nAllow or deny it in Panda → Tasks. The run does not continue until you decide.`);
        }
        // KKD rejected the worker's result and sent it back: say so (otherwise the repair loop is invisible).
        const sinceRetry = comments.slice(comments.map(c => c.body.startsWith('[kkd-dev:retry]')).lastIndexOf(true) + 1);
        const failures = sinceRetry.filter(c => c.body.startsWith('[kkd-dev:verify-failed]'));
        failures.forEach((f, i) => {
          const key = `verify-failed ${f.createdAt}`;
          if (done.has(reportKey(key))) return;
          const text = f.body.replace(/^\[kkd-dev:verify-failed\]\s*/, '').split(/\r?\n/).filter(Boolean).slice(0, 2).join(' — ').slice(0, 420);
          post(s.id, key, `🔁 **${s.title}** — KKD rejected the worker's result (attempt ${i + 1} of ${MAX_VERIFY_RETRIES + 1}) and sent it back for repair: ${text}`);
        });
      } else if (s.status === 'delivery_approval') {
        const hit = tag(s, 'awaiting-review');
        const key = `awaiting-review ${hit?.slice(0, 80)}`;
        if (hit && !done.has(reportKey(key))) post(s.id, key, `🔎 **${s.title}** is waiting for your review — ${hit.replace(/^\[kkd-dev:[\w-]+\]\s*/, '').split('\n')[0].slice(0, 300)}\nSay "approve ${s.title}" after you looked at it, or open Tasks.`);
      } else if (s.status === 'blocked' && !isStopped(db, s.id)) {
        // The block that happened since the latest retry (an earlier, already-retried one must not hide or repeat it).
        const comments = listComments(db, s.id);
        const sinceRetry = comments.slice(comments.map(c => c.body.startsWith('[kkd-dev:retry]')).lastIndexOf(true) + 1).reverse();
        const hit = sinceRetry.find(c => c.body.startsWith('[kkd-dev:needs-human]')) ?? sinceRetry.find(c => c.body.startsWith('[kkd-dev:verify-failed]'));
        const why = hit?.body ?? null;
        if (why) {
          // One notification per failure EVENT: the key is the id of the comment that recorded it. A new failure after a
          // retry is a new comment and so a new notification; the same failure seen by another poll is not. Markers
          // written before 2026-11-24 used the comment's time and text, and still count.
          const key = `needs-human ${hit!.id}`;
          const legacyKey = `needs-human ${hit!.createdAt} ${why.slice(0, 60)}`;
          if (!done.has(reportKey(key)) && !done.has(reportKey(legacyKey))) post(s.id, key, `⚠️ **${s.title}** needs you: ${why.replace(/^\[kkd-dev:[\w-]+\]\s*/g, '').replace(/^\[kkd-dev:[\w-]+\]\s*/, '').split('\n')[0].slice(0, 300)}\nSay "retry" or "reassign to claude/opencode", or open Tasks.`);
        }
      }
    }
    const allSettled = stories.length > 0 && stories.every(s => s.status === 'done' || s.status === 'delivery_approval' || (s.status === 'blocked' && !isStopped(db, s.id)));
    const head = stories[0];
    const settledDone = stories.filter(s => s.status === 'done').length;
    // Keyed by the completed count: a batch that settled with a story needing you reports again once it is fixed.
    if (allSettled && head && !reported(head.id).has(reportKey(`final ${batchId} ${settledDone}/${stories.length}`))) {
      const doneCount = settledDone;
      const spec = devSpec(head)!;
      const lines = stories.map(s => {
        const sp = devSpec(s)!;
        if (s.status === 'done') {
          const sha = tag(s, 'integrated')?.match(/\] (\w+)/)?.[1] ?? '?';
          const files = tag(s, 'verified')?.split('\n').find(l => l.startsWith('Changed:'))?.slice(9) ?? '';
          const device = deviceVerificationOf(s, sp, listComments(db, s.id));
          return `- ✅ ${s.title} — ${sp.agent}; ${verificationPhrase(tag(s, 'integrated') ?? '', sp)}; commit ${sha}${files ? `; changed ${files}` : ''}${device?.state === 'awaiting' ? ' — ⏳ AWAITING DEVICE VERIFICATION (automated checks only; not verified on a physical phone)' : ''}`;
        }
        if (s.status === 'delivery_approval') return `- 🔎 ${s.title} — ${sp.agent}; worker completed, NOT independently verified; waiting for your review`;
        return `- ⚠️ ${s.title} — ${sp.agent}; needs a human: ${(tag(s, 'needs-human') ?? tag(s, 'verify-failed') ?? '').replace(/^(\[kkd-dev:[\w-]+\]\s*)+/, '').split('\n')[0].slice(0, 200)}`;
      });
      const deps = stories.filter(s => predecessors(db, s.id).length).map(s => `"${s.title}" started only after ${predecessors(db, s.id).map(d => `"${stories.find(x => x.id === d)?.title ?? d}"`).join(' and ')} were integrated`);
      post(head.id, `final ${batchId} ${doneCount}/${stories.length}`, [
        `**Development stories finished — ${doneCount} of ${stories.length} completed.**`,
        ...lines,
        deps.length ? `\nOrdering: ${deps.join('; ')}.` : '',
        `\nAll work is on the local branch \`${spec.integrationBranch}\` in ${spec.repoPath} (not pushed, not merged into ${spec.baseBranch}).`,
      ].filter(Boolean).join('\n'));
    }
  }
  return posted;
}

function verificationPhrase(integrated: string, spec: DevStorySpec): string {
  const how = verificationOf(integrated, true);
  if (how === 'independent') return `KKD's own acceptance checks (${automatedChecks(spec.acceptance ?? []).length}) and \`${spec.verify.join(' ')}\` passed in the worktree and again after merge — independently verified`;
  if (how === 'human-reviewed') return `integrated after your review; no independent check existed, \`${spec.verify.join(' ')}\` passed after merge`;
  return `KKD re-ran \`${spec.verify.join(' ')}\` and integrated it (worker's tests only, not independently verified)`;
}

/** Background loop started by the Core API server. Silent no-op when nothing is dispatched. */
export function startDevStoryLoop(db: CoreDatabase, broadcaster?: { publishRuntime(event: RuntimeEventRecord): void }, intervalMs = 5_000): () => void {
  const kandev = new KandevClient();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    // Taken before anything is posted so the worker narrative (posted during reconcile) is broadcast to the open chat too.
    const before = latestRuntimeSequence(db);
    try { await reconcileDevStories(db, kandev); }
    catch (err) { console.error(`[karkedikha-core ${new Date().toISOString()}] dev-story reconcile failed:`, err instanceof Error ? err.message : err); }
    try { reportDevStoryProgress(db); }
    catch (err) { console.error(`[karkedikha-core ${new Date().toISOString()}] dev-story report failed:`, err instanceof Error ? err.message : err); }
    try { if (broadcaster) for (const event of listRuntimeEventsAfter(db, before, 200)) broadcaster.publishRuntime(event); }
    catch (err) { console.error(`[karkedikha-core ${new Date().toISOString()}] dev-story broadcast failed:`, err instanceof Error ? err.message : err); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
