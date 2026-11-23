/**
 * Runtime side of the Panda bridge: finds the executors installed on this PC, routes a relayed task to one, and keeps the
 * relayed task in step with the work.
 *
 * Nothing here re-implements execution. A relayed task becomes one ordinary development story and is dispatched through
 * the existing Kandev/ACP coordinator (core/runtime/kandev/devStories.ts), which already owns isolated worktrees,
 * approvals, independent verification, integration and restart recovery. Pandesh's own Windows capabilities run through the
 * ordinary request/attempt path. This module only chooses, gates (consent, confidentiality) and mirrors.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../../db/connection';
import { CoreError } from '../../domain/errors';
import { runHardenedGit } from '../../security/hardenedGit';
import { addComment, getStory, listComments, listStories } from '../../domain/stories';
import type { StoryRecord } from '../../shared/wireTypes';
import { loadProjects, projectAllows, resolveProject, type ProjectRecord } from '../../domain/projectRegistry';
import { asksForChange, deriveMutationPolicy } from '../../domain/mutationPolicy';
import { consumeApproval, decideApproval, pendingApproval, recordDirectApproval, requestApproval, usableApproval, withdrawApproval, type ExternalApprovalRequest } from '../../domain/bridgeApprovals';
import { getAttempt, requestCancelAttempt } from '../../domain/attempts';
import { isTerminalAttemptStatus } from '../../domain/attemptTransitions';
import { submitRequest } from '../../domain/submission';
import { newId } from '../../domain/ids';
import {
  attachBridgeExecution, claimBridgeDispatch, evaluateTransferPolicy, getBridgeTask, getPairing, listBridgeTasks, recordBridgeStatus,
  setBridgeControl, TERMINAL_BRIDGE_STATUSES, BRIDGE_ACTIVITY_LIMIT,
  type BridgeTaskOutcome, type BridgeTaskRecord, type MissionStep, type BridgeTaskResult, type BridgeTaskStatus, type BridgeTransferConsent,
} from '../../domain/pandaBridge';
import { detectGpu, gpuLaneLimit, type GpuInfo } from '../hardwareCapacity';
import type { RuntimeExecutor } from '../executor';
import { KandevClient, KandevUnavailableError } from './kandevClient';
import { parseServiceArgs, type ServiceHost, type ServiceRegistry } from './bridgeServices';
import { classifyInstruction, WORKSPACE_MARKER } from './intentRouter';
import { asksForTests, isReadOnlyIntent, resolveTaskIntent, type TaskIntent, type TaskIntentKind } from '../../domain/taskIntent';
import { allDeclarations, BUILTIN_WORKFLOWS, routeTask, trackRecords } from './capabilityRegistry';
import { judgeTests, type TestComparison } from './projectTests';
import {
  DEV_ACTOR, GRANT_REVOKED_TAG, TESTS_TAG, AGENT_IDS, approveDevStoryReview, checkoutFingerprint, devSpec, devStoryChangeDiff, devStoryDetail, devStoryWorkerEvents, dispatchDevStories, planDevStories, retryDevStory, stopDevStory, usesLocalGpu, type DevAgent, type DevStorySpec,
} from './devStories';
import { unavailableDiff, type ChangeDiff } from './changeDiff';

export type BridgeExecutorId = DevAgent | 'native';

export interface BridgeExecutor {
  id: string;
  label: string;
  kind: 'acp' | 'native' | 'service';
  /** False for an ACP agent Kandev knows but the coordinator cannot drive yet. */
  dispatchable: boolean;
  available: boolean;
  reason: string | null;
  /** True when running a task here sends the task text to an external model. */
  external: boolean;
  usesLocalGpu: boolean;
  models: string[];
}

const KNOWN: Record<BridgeExecutorId, { label: string; binary: string | null; external: boolean }> = {
  claude: { label: 'Claude Code', binary: 'claude', external: true },
  opencode: { label: 'OpenCode', binary: 'opencode', external: false },
  hermes: { label: 'Hermes', binary: 'hermes', external: false },
  antigravity: { label: 'Antigravity', binary: null, external: true },
  native: { label: 'Pandesh (native Windows capabilities)', binary: null, external: false },
};

/** A model name that runs on this PC. Anything else (a provider-prefixed cloud model) is external. */
export function isLocalModel(model: string | null | undefined): boolean {
  return !model || /^(ollama|llama|local|lmstudio)/i.test(model);
}

export function transferInfo(executor: string, model: string | null | undefined): { id: string; label: string; external: boolean } {
  // Registered deterministic services run in-process on this PC; nothing is sent to a model.
  if (executor.startsWith('service:')) return { id: executor, label: executor, external: false };
  const known = KNOWN[executor as BridgeExecutorId];
  const label = known?.label ?? executor;
  // Unknown executors are treated as external until proven otherwise.
  const external = known ? (known.external || ((executor === 'opencode' || executor === 'hermes') && !isLocalModel(model))) : true;
  return { id: executor, label, external };
}

/** Is the executable on PATH? A plain directory scan (honouring PATHEXT on Windows): nothing is spawned to find out. */
function onPath(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  return dirs.some(dir => exts.some(ext => { try { return fs.statSync(path.join(dir, binary + ext)).isFile(); } catch { return false; } }));
}

export interface ExecutorListing {
  kandev: { running: boolean };
  hardware: { gpu: GpuInfo | null; gpuLanes: number };
  executors: BridgeExecutor[];
}

/** What can run a task right now. Passive: it never starts Kandev. */
export async function discoverExecutors(kandev: KandevClient, opts: { nativeAvailable?: boolean; services?: ServiceRegistry; includeInternal?: boolean } = {}): Promise<ExecutorListing> {
  const running = await kandev.healthy();
  const gpu = detectGpu();
  const executors: BridgeExecutor[] = [];
  let agents: Array<{ id: string; name: string; capability_status?: string; capability_error?: string; profiles?: Array<{ model: string; auto_approve: boolean }> }> = [];
  if (running) {
    try { agents = (await kandev.tool<{ agents: typeof agents }>('list_agents_kandev', {})).agents ?? []; } catch { agents = []; }
  }
  const byName = new Map(agents.map(a => [a.name, a]));
  for (const id of Object.keys(AGENT_IDS) as DevAgent[]) {
    const known = KNOWN[id];
    const agent = byName.get(AGENT_IDS[id]);
    const installed = known.binary ? onPath(known.binary) : Boolean(agent);
    let available = installed;
    let reason: string | null = null;
    if (agent && agent.capability_status === 'failed') {
      const fresh = await kandev.reprobeAgent(agent.name);
      if (fresh) { agent.capability_status = fresh.status; agent.capability_error = fresh.error ?? ''; }
    }
    if (agent && agent.capability_status && agent.capability_status !== 'ok') { available = false; reason = `${agent.capability_status} ${agent.capability_error ?? ''}`.trim(); }
    else if (!installed) reason = `${known.label} is not installed on this PC`;
    else if (!running) reason = 'Kandev is started on demand when the task is dispatched';
    const models = [...new Set((agent?.profiles ?? []).filter(p => !p.auto_approve).map(p => p.model).filter(Boolean))];
    executors.push({
      id, label: known.label, kind: 'acp', dispatchable: true, available, reason,
      external: transferInfo(id, models[0]).external, usesLocalGpu: usesLocalGpu({ agent: id, model: undefined }), models,
    });
  }
  // Other ACP agents Kandev has installed: visible, but the story coordinator cannot drive them yet.
  for (const agent of agents) {
    // `dynamic` is Kandev's placeholder for agents discovered at runtime, not an agent a person can choose.
    if (Object.values(AGENT_IDS).includes(agent.name) || agent.name === 'dynamic') continue;
    executors.push({
      id: agent.name, label: agent.name, kind: 'acp', dispatchable: false, available: false,
      reason: 'installed in Kandev, but the Pandesh coordinator does not drive this agent yet', external: true, usesLocalGpu: false,
      models: [...new Set((agent.profiles ?? []).map(p => p.model).filter(Boolean))],
    });
  }
  executors.push({
    id: 'native', label: KNOWN.native.label, kind: 'native', dispatchable: true, available: opts.nativeAvailable !== false, reason: opts.nativeAvailable === false ? 'no runtime executor is configured on this Core' : null,
    external: false, usesLocalGpu: false, models: [],
  });
  for (const svc of opts.services?.list() ?? []) {
    if (svc.internal && !opts.includeInternal) continue; // private-data services are not advertised to browsers
    executors.push({ id: `service:${svc.id}`, label: svc.label, kind: 'service', dispatchable: true, available: true, reason: null, external: false, usesLocalGpu: false, models: [] });
  }
  return { kandev: { running }, hardware: { gpu, gpuLanes: gpuLaneLimit(gpu) }, executors };
}

// ------------------------------------------------------------------ isolated workspace

/** A fresh git repository for exactly this task, under Core's data directory. The worker never sees the user's checkouts. */
export function prepareTaskWorkspace(dataDir: string, taskId: string): string {
  const dir = path.join(dataDir, 'panda-workspaces', taskId.replace(/[^\w-]/g, '_'));
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'panda-task', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Panda task workspace\n\nCreated by Pandesh for one relayed task. Work happens only in this repository.\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  const git = (args: string[]) => {
    const r = runHardenedGit(args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new CoreError('internal_error', `workspace setup failed (git ${args[0]}): ${String(r.stderr ?? '').trim().slice(0, 200)}`);
  };
  git(['init', '-b', 'main']);
  git(['add', '-A']);
  git(['-c', 'user.name=Pandesh', '-c', 'user.email=pandesh@localhost', 'commit', '-m', 'Task workspace']);
  return dir;
}

/**
 * Pandesh's own check, outside the worktree and invisible to the worker: the repository must contain tests, they must run,
 * at least one must pass and none may fail. Without it, a worker that wrote no tests would "pass" `node --test`.
 */
export const TESTS_PRESENT_CHECK = [
  "import { run } from 'node:test';",
  "process.chdir(process.env.KKD_ACCEPT_ROOT);",
  "let pass = 0, fail = 0;",
  "for await (const e of run({ concurrency: false, timeout: 120000 })) {",
  "  if (e.data && e.data.details && e.data.details.type === 'suite') continue;",
  "  if (e.type === 'test:pass') pass++; else if (e.type === 'test:fail') fail++;",
  "}",
  "console.log('tests=' + (pass + fail) + ' pass=' + pass + ' fail=' + fail);",
  "process.exit(fail > 0 || pass < 1 ? 1 : 0);",
].join('\n');

function answerDescription(task: BridgeTaskRecord, includeContext: boolean): string {
  const parts = [task.instruction];
  if (includeContext && task.contextText) {
    parts.push('', 'Conversation context the user chose to share (background only; the instruction above is the task):', task.contextText);
  }
  return parts.join('\n');
}

// ------------------------------------------------------------------ project inspection

export interface InspectionPlan {
  project: ProjectRecord; sourcePath: string; ref: string; cloneDir: string;
  sourceHead: string; sourceStatusSha: string; uncommittedFiles: number;
  /** `code`: the copy is where an approved change is made (A5). */
  mode: 'inspect' | 'code';
}

/**
 * A private, disposable copy of an authorized project at one branch, for a read-only inspection. The agent never gets the
 * owner's checkout: it works in a clone (no remote, so nothing can be pushed anywhere) whose dependencies are a junction to the
 * project's own node_modules, and KKD proves afterwards that the owner's checkout was not touched. Uncommitted work in the
 * owner's checkout is NOT part of the snapshot, and the report says so.
 */
export function prepareProjectInspection(dataDir: string, taskId: string, project: ProjectRecord, sourcePath: string, requestedRef: string | null, expectCommit: string | null = null, mode: 'inspect' | 'code' = 'inspect'): InspectionPlan {
  const fp = checkoutFingerprint(sourcePath);
  if (!fp) throw new CoreError('invalid_request', `'${project.name}' is not a readable git checkout at its registered path`);
  const run = (args: string[], cwd: string) => runHardenedGit(args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const current = String(run(['rev-parse', '--abbrev-ref', 'HEAD'], sourcePath).stdout ?? '').trim();
  const ref = requestedRef ?? (current && current !== 'HEAD' ? current : project.repo.defaultBranch ?? '');
  if (!ref) throw new CoreError('invalid_request', `which branch of '${project.name}' should be inspected? The checkout is on a detached HEAD and the task named none.`, { reason: 'needs_clarification' });
  if (run(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], sourcePath).status !== 0) {
    throw new CoreError('invalid_request', `'${project.name}' has no branch '${ref}'. Nothing was inspected; name an existing branch.`, { reason: 'needs_clarification' });
  }
  const cloneDir = path.join(dataDir, 'panda-workspaces', `${taskId.replace(/[^\w-]/g, '_')}-${mode}`);
  if (!fs.existsSync(path.join(cloneDir, '.git'))) {
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    const clone = run(['clone', '--quiet', '--no-hardlinks', '--single-branch', '--branch', ref, sourcePath, cloneDir], path.dirname(cloneDir));
    if (clone.status !== 0) throw new CoreError('internal_error', `could not prepare the inspection copy: ${String(clone.stderr ?? '').trim().slice(0, 200)}`);
    run(['remote', 'remove', 'origin'], cloneDir); // nothing in the copy can reach the owner's repository
    if (expectCommit) {
      const head = String(run(['rev-parse', 'HEAD'], cloneDir).stdout ?? '').trim();
      if (!head.startsWith(expectCommit)) { fs.rmSync(cloneDir, { recursive: true, force: true }); throw new CoreError('conflict', `the branch moved while it was being copied (expected ${expectCommit}); nothing was sent. Ask again.`, { reason: 'approval_scope_changed' }); }
    }
    // An inspection may borrow the owner's dependencies through a junction. A copy that will be changed never links back into the
    // owner's folders: a write through the link would land in the owner's checkout.
    const deps = path.join(sourcePath, 'node_modules');
    if (mode === 'inspect' && fs.existsSync(deps) && !fs.existsSync(path.join(cloneDir, 'node_modules'))) fs.symlinkSync(deps, path.join(cloneDir, 'node_modules'), 'junction');
  }
  const porcelain = String(run(['status', '--porcelain', '--untracked-files=all'], sourcePath).stdout ?? '').split('\n').filter(Boolean);
  return { project, sourcePath, ref, cloneDir, sourceHead: fp.head, sourceStatusSha: fp.statusSha, uncommittedFiles: porcelain.length, mode };
}

/** The question that makes the owner say which project (or register one); the task stays waiting, nothing runs. */
function needsClarification(db: CoreDatabase, taskId: string, question: string): never {
  recordBridgeStatus(db, taskId, 'awaiting_executor', question.slice(0, 400));
  throw new CoreError('invalid_request', question, { reason: 'needs_clarification' });
}

/** Words that make a bare project NAME a reference to its code rather than to the product ("ask Pandesh for my brief"). */
// "tests" (plural) and "test suite" point at code; a lone "test" usually names the request itself ("an acceptance test").
const CODE_CUE = /\b(repo|repository|codebase|source|implementation|branch|tests|test suite|test files?|module|files?|folder|directory|defects?|bugs?|code)\b/i;

/**
 * The part of an instruction that can make a project name a reference to its code. Agent names are not code words ("Claude Code"
 * contains "code"), and a prohibition is not a reference ("do not read files or repositories"). Without this, a hello that names
 * Claude Code and Pandesh became a read-only inspection of the Pandesh repository (seen live 2026-11-21).
 */
export function codeCueText(instruction: string): string {
  return instruction
    .replace(/\b(?:claude[ -]?code|open[ -]?code|antigravity|hermes)\b/gi, ' ')
    .replace(/\b(?:do not|don't|never|must not|mustn't|without|no)\b[^.!?\n]*/gi, ' ');
}
export const refersToCode = (instruction: string): boolean => CODE_CUE.test(codeCueText(instruction));

/** At most this many changed files are accepted from one ChatGPT-requested code change (A5); more fails verification with the list. */
export const CODE_CHANGE_MAX_FILES = 20;

/**
 * `inspect`: read-only look at a private copy. `code` (A5): a change made by the agent in its own worktree of a private copy of a
 * `read-write` project; it comes back only as a branch in that copy, after verification and the owner's review. Nothing is pushed,
 * merged or installed, and the owner's checkout gets the change only when the owner asks for it as a new branch.
 */
export interface ProjectIntent { project: ProjectRecord; path: string; ref: string | null; readOnlyRequested: boolean; mode: 'inspect' | 'code'; intent: TaskIntent }

/** The mission steps of a task (empty for a single task). */
export const missionOf = (task: Pick<BridgeTaskRecord, 'sourceRef'>): MissionStep[] => task.sourceRef?.plan ?? [];

/** The kind of work that governs a relayed task: what the requester declared, else what its text asks for (core/domain/taskIntent.ts). */
export function taskIntentOf(task: Pick<BridgeTaskRecord, 'instruction' | 'sourceRef'>): TaskIntent {
  return resolveTaskIntent(task.instruction, task.sourceRef?.declaredIntent ?? null);
}

/**
 * A request this task is not permitted to make (a change to a read-only project). The task fails with the reason, so the requester sees a
 * permission failure and never a completed inspection in its place. Nothing ran, nothing was copied.
 */
function permissionRefused(db: CoreDatabase, taskId: string, reason: string): never {
  recordBridgeStatus(db, taskId, 'failed', `Not permitted: ${reason}`.slice(0, 500));
  throw new CoreError('forbidden', reason, { reason: 'permission_denied' });
}

/**
 * The project gate, without copying anything: which authorised project (if any) the task is about, and whether this executor and this
 * kind of work are allowed there. Ambiguous or unregistered means ask (the task stays waiting); a change the project does not allow is a
 * permission failure. A requested change is never silently turned into an inspection, and no permission is widened.
 */
function gateProject(rt: BridgeRuntime, task: BridgeTaskRecord, chosen: BridgeExecutor): ProjectIntent | null {
  if (chosen.kind === 'service') return null;
  const intent = taskIntentOf(task);
  if (intent.conflict) needsClarification(rt.db, task.id, intent.conflict);
  const projects = loadProjects(rt.dataDir);
  const r = projects.length || /[A-Za-z]:[\\/]/.test(task.instruction) ? resolveProject(projects, task.instruction) : ({ status: 'none' } as const);
  if (r.status === 'ambiguous' || r.status === 'unauthorized') needsClarification(rt.db, task.id, r.question);
  // A project NAME refers to its code when the task is a code change or uses code words; a path always does.
  if (r.status !== 'resolved' || !(r.via === 'path' || intent.kind === 'code' || refersToCode(task.instruction))) return null;
  if (chosen.kind !== 'acp') needsClarification(rt.db, task.id, `This task is about the project '${r.project.name}'. ${chosen.label} cannot be confined to that project yet; choose Claude Code or OpenCode.`);
  // A question about the code is an inspection; a change (or an action on the project's files) is a change.
  const readOnly = isReadOnlyIntent(intent.kind);
  const allowed = projectAllows(r.project, readOnly);
  if (!allowed.ok) permissionRefused(rt.db, task.id, `${allowed.reason} (Pandesh read this task as ${intent.kind === 'code' ? 'a code change' : 'an action that changes files'} because ${intent.reason}.)`);
  return { project: r.project, path: r.path, ref: r.ref, readOnlyRequested: readOnly, mode: readOnly ? 'inspect' : 'code', intent };
}

/**
 * No registered project resolved. An agent may still answer (a reply, a read-only check of nothing), but Pandesh never hands work that
 * may change files an empty substitute workspace: that silently swaps the owner's project for a blank folder (seen 2026-11-21, where a
 * coding task "for the Pandesh source" got a scaffold, the worker found no code and verification failed it three times).
 */
function requireAnswerOnly(rt: BridgeRuntime, task: BridgeTaskRecord, chosen: BridgeExecutor): void {
  if (chosen.kind !== 'acp') return;
  const intent = taskIntentOf(task);
  if (intent.conflict) needsClarification(rt.db, task.id, intent.conflict);
  if (isReadOnlyIntent(intent.kind)) return;
  if (intent.kind === 'operation') needsClarification(rt.db, task.id, `This task asks for an action on this PC or outside it (${intent.reason}), and coding agents do not run such actions, so nothing ran. Ask Pandesh directly, or ask for an answer only.`);
  needsClarification(rt.db, task.id, `This task is a code change (${intent.reason}), but it names no registered project, so nothing ran. Pandesh does not run such work in an empty substitute workspace or in any other project. Register the project in Pandesh and name it (or its path) in the task, or ask for an answer only (say "do not change any files").`);
}

/** The instruction asks for an answer or a read-only look, never a change (the same reading Pandesh applies to its own requests). */
export function isAnswerOnly(instruction: string): boolean {
  return deriveMutationPolicy(instruction) === 'denied' || !asksForChange(instruction);
}

/** Read-only look at what an inspection would copy (branch, commit, uncommitted files); copies nothing. */
function previewInspection(intent: ProjectIntent): { branch: string; commit: string; uncommittedFiles: number } {
  const fp = checkoutFingerprint(intent.path);
  if (!fp) throw new CoreError('invalid_request', `'${intent.project.name}' is not a readable git checkout at its registered path`);
  const run = (args: string[]) => runHardenedGit(args, { cwd: intent.path, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const current = String(run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout ?? '').trim();
  const branch = intent.ref ?? (current && current !== 'HEAD' ? current : intent.project.repo.defaultBranch ?? '');
  if (!branch) throw new CoreError('invalid_request', `which branch of '${intent.project.name}' should be inspected? The checkout is on a detached HEAD and the task named none.`, { reason: 'needs_clarification' });
  const tip = run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (tip.status !== 0) throw new CoreError('invalid_request', `'${intent.project.name}' has no branch '${branch}'. Nothing was inspected; name an existing branch.`, { reason: 'needs_clarification' });
  const dirty = String(run(['status', '--porcelain', '--untracked-files=all']).stdout ?? '').split('\n').filter(Boolean).length;
  return { branch, commit: String(tip.stdout ?? '').trim().slice(0, 12), uncommittedFiles: dirty };
}

/** What the card says the agent may do; the dispatch checks the approved text against the current intent. */
/** How long a mission's development grant lasts after the owner allows it. */
export const MISSION_GRANT_MS = 4 * 60 * 60_000;

export function accessLevelOf(intent: ProjectIntent | null, missionSteps = 0): string {
  if (!intent) return 'Answer only: no project is shared and no file may be changed';
  if (intent.mode === 'code' && missionSteps > 1) return `Mission of ${missionSteps} code-change steps in isolated worktrees of one private copy (at most ${CODE_CHANGE_MAX_FILES} files per step, tests allowed). Development grant for ${MISSION_GRANT_MS / 3_600_000} hours: a step whose change passes Pandesh's own test run is committed in the private copy without asking again and the next step starts; anything else waits for your review. No push, no merge, no install, nothing in your checkout unless you ask`;
  if (intent.mode === 'code') return `Code change in an isolated worktree of a private copy: it may change at most ${CODE_CHANGE_MAX_FILES} files there and run tests; no push, no merge, no install`;
  return 'Read-only inspection of a private copy: it may read files and run existing tests, it cannot change anything';
}

/** Who receives the data, in the owner's words. */
function providerOf(executor: string, model: string | null): string {
  if (executor === 'claude') return 'Anthropic (Claude, your Claude account; may cost money)';
  if (executor === 'antigravity') return 'Google (Antigravity)';
  return model ? `the cloud provider behind model "${model}"` : 'an external cloud provider';
}

/**
 * A paired browser asked for an external agent. It cannot authorise that, so nothing starts: Pandesh records an approval request with the
 * full picture (agent, provider, project, branch, access, what leaves the PC, the instruction) and waits for the owner in the Pandesh app.
 */
async function requestExternalApproval(rt: BridgeRuntime, task: BridgeTaskRecord, req: DispatchRequest): Promise<{ task: BridgeTaskRecord; started: false; approval: ExternalApprovalRequest }> {
  const listing = await discoverExecutors(rt.kandev, { nativeAvailable: Boolean(rt.executor), ...(rt.services ? { services: rt.services } : {}) });
  const chosen = listing.executors.find(e => e.id === req.executor);
  if (!chosen) throw new CoreError('invalid_request', `unknown executor '${req.executor}'`);
  if (!chosen.dispatchable) throw new CoreError('invalid_request', `${chosen.label}: ${chosen.reason}`);
  if (!chosen.available) throw new CoreError('conflict', `${chosen.label} is not available: ${chosen.reason ?? 'unavailable'}`);
  const intent = gateProject(rt, task, chosen);
  if (!intent) requireAnswerOnly(rt, task, chosen);
  const preview = intent ? previewInspection(intent) : null;
  const provider = providerOf(chosen.id, req.model ?? null);
  const includeContext = task.contextConfirmed;
  const exposure = [
    `The task text goes to ${provider}.`,
    preview
      ? `Everything ${chosen.label} reads ${intent!.mode === 'code' ? 'or writes ' : ''}in a private copy of ${intent!.project.name} (branch ${preview.branch} at ${preview.commit}) goes there too. Your own checkout is not shared${preview.uncommittedFiles ? `, and ${preview.uncommittedFiles} uncommitted or untracked file(s) in it are not part of the copy` : ''}.`
      : `No project is shared: this is an answer-only task. ${chosen.label} gets an empty folder, may not change any file, and only the task text goes to ${provider}.`,
    ...(intent?.mode === 'code' && missionOf(task).length > 1 ? [
      `This is a mission of ${missionOf(task).length} steps (listed in the task). Allowing it grants, for ${MISSION_GRANT_MS / 3_600_000} hours: each step whose change passes Pandesh's own before/after test run is committed to one branch in that copy without asking you again, and the steps that depend on it start. A step that fails Pandesh's checks, or whose diff looks like it weakens tests, waits for your review. Stop ends the grant at once.`,
      `Nothing is pushed, merged or installed, and nothing reaches your checkout unless you ask for it as a new branch at the end.`,
    ] : intent?.mode === 'code' ? [`The change stays in that copy: nothing is pushed, merged or installed. Pandesh runs the project's tests before and after the change, you review it in Pandesh first, and it reaches your checkout only if you ask, as a new branch.`] : []),
    `Pandesh reads this task as ${intent ? (intent.mode === 'code' ? 'a code change' : 'a read-only inspection') : 'an answer only'}: ${(intent?.intent ?? taskIntentOf(task)).reason}${(intent?.intent ?? taskIntentOf(task)).source === 'declared' ? ' (declared by the requester)' : ''}.`,
    includeContext ? 'The ChatGPT conversation context you chose to share is included.' : 'No ChatGPT conversation context is included.',
  ];
  const request = requestApproval(rt.db, {
    taskId: task.id, executor: chosen.id, agentLabel: chosen.label, provider, model: req.model ?? null,
    project: intent && preview ? { name: intent.project.name, branch: preview.branch, commit: preview.commit, access: intent.project.access, uncommittedFiles: preview.uncommittedFiles } : null,
    accessLevel: accessLevelOf(intent, missionOf(task).length),
    exposure, instruction: task.instruction.slice(0, 2000), instructionSha256: task.instructionSha256,
    sensitivity: task.sensitivity, sensitivityReasons: task.sensitivityReasons, includeContext, requestedBy: req.decidedBy,
  });
  recordBridgeStatus(rt.db, task.id, 'awaiting_executor', `Waiting for your approval in Pandesh to send this task to ${chosen.label}.`);
  return { task: getBridgeTask(rt.db, task.id), started: false, approval: request };
}

// ------------------------------------------------------------------ dispatch

export interface BridgeRuntime {
  db: CoreDatabase;
  kandev: KandevClient;
  dataDir: string;
  /** Runs Pandesh's own capabilities; absent on a Core without a runtime executor. */
  executor?: RuntimeExecutor;
  /** Deterministic services and workflows dispatched through the same task lifecycle (no LLM). */
  services?: ServiceRegistry;
}

export interface DispatchRequest {
  /** An executor id, or `auto`: Pandesh picks among *local* executors only. */
  executor: string;
  model?: string | null;
  consent?: BridgeTransferConsent;
  decidedBy: string;
  /** What kind of work this is. With `auto` the capability registry picks the executor for it; it is also recorded so reliability is demonstrated per class. */
  taskClass?: string;
  /** `auto` only: allow external executors to be considered (the transfer-consent gate still applies). */
  allowExternal?: boolean;
  /** What the caller is allowed to authorise. An extension can never grant an external transfer. */
  authority: 'host' | 'extension';
  /** The owner's approval this dispatch executes. It must be an `approved` decision whose scope matches exactly. */
  approvalRequestId?: string;
}

function chooseAuto(listing: ExecutorListing): BridgeExecutor | null {
  const order = ['opencode', 'hermes', 'native'];
  for (const id of order) {
    const e = listing.executors.find(x => x.id === id && x.available && x.dispatchable && !x.external);
    if (e) return e;
  }
  return null;
}

/**
 * Starts a task on an executor. Exactly-once: the dispatch is claimed in one atomic statement, so a retry, a double click
 * or a second browser gets the existing task back and nothing else starts.
 */
export async function dispatchBridgeTask(rt: BridgeRuntime, taskId: string, req: DispatchRequest): Promise<{ task: BridgeTaskRecord; started: boolean; approval?: ExternalApprovalRequest }> {
  const { db } = rt;
  const task = getBridgeTask(db, taskId);
  if (task.control === 'cancelled' || TERMINAL_BRIDGE_STATUSES.has(task.status)) throw new CoreError('conflict', `task is ${task.status}`);
  if (task.status !== 'awaiting_executor' && task.status !== 'failed') {
    if (task.executor) return { task, started: false }; // already routed: a retry gets the existing task
    throw new CoreError('conflict', `task is ${task.status}`);
  }

  const model = req.model ?? null;
  // Consent gate first, before anything is probed or started: nothing external runs without it, and an extension cannot grant it.
  const consent = req.authority === 'host' ? req.consent : undefined;
  if (req.executor !== 'auto') {
    const decision = evaluateTransferPolicy(task, transferInfo(req.executor, model), consent);
    if (!decision.allowed) {
      // A browser may ASK for a cloud agent; it cannot authorise it. The request goes to the Pandesh app for the owner's decision.
      if (decision.code === 'external_consent_required' && req.authority === 'extension') return requestExternalApproval(rt, task, req);
      throw new CoreError('forbidden', decision.message, { reason: decision.code });
    }
    // An external agent started with consent must be the one the owner approved, for this very instruction.
    if (transferInfo(req.executor, model).external && req.approvalRequestId) {
      const ev = usableApproval(db, taskId, req.approvalRequestId);
      // The instruction is checked against its CONTENT, not only the stored digest: an edited task text cannot ride on an old approval.
      const actual = crypto.createHash('sha256').update(task.instruction).digest('hex');
      if (ev.scope.executor !== req.executor || ev.scope.model !== model || ev.scope.instructionSha256 !== task.instructionSha256 || actual !== ev.scope.instructionSha256) {
        throw new CoreError('forbidden', 'this approval does not cover that executor, model or instruction; nothing was started');
      }
    }
  }

  const listing = await discoverExecutors(rt.kandev, { nativeAvailable: Boolean(rt.executor), includeInternal: true, ...(rt.services ? { services: rt.services } : {}) });
  let routing: 'explicit' | 'auto' = 'explicit';
  let chosen: BridgeExecutor | undefined;
  let derived: { taskClass: string; reason: string; args: Record<string, unknown> } | null = null;
  if (req.executor === 'auto') {
    // Automatic routing is only ever offered when the user selected it, and only among local executors.
    routing = 'auto';
    if (req.taskClass) {
      const decision = routeTask({ taskClass: req.taskClass, allowExternal: req.allowExternal === true }, listing, allDeclarations(rt.services), trackRecords(db));
      chosen = decision.selected ? listing.executors.find(e => e.id === decision.selected) : undefined;
      if (!chosen) throw new CoreError('invalid_request', `automatic routing: ${decision.refusal ?? 'no executor selected'}`);
    } else {
      // Routine operations go to the registered deterministic service; anything that needs interpretation, or that no service
      // can do, goes to the local model as before. Both paths stay local and explicit about what ran.
      const intent = classifyInstruction(task.instruction);
      if (intent) {
        const cls = intent.kind === 'workflow' ? 'workflow.run' : intent.taskClass;
        const decision = routeTask({ taskClass: cls, deterministicOnly: true }, listing, allDeclarations(rt.services), trackRecords(db));
        const svcExecutor = decision.selected ? listing.executors.find(e => e.id === decision.selected) : undefined;
        if (svcExecutor) {
          chosen = svcExecutor;
          const workspace = () => prepareTaskWorkspace(rt.dataDir, task.id);
          const fill = (o: Record<string, unknown>) => (o.path === WORKSPACE_MARKER ? { ...o, path: workspace() } : o);
          derived = intent.kind === 'workflow'
            ? { taskClass: cls, reason: intent.reason, args: { workflow: intent.workflowId, input: fill(intent.input) } }
            : { taskClass: cls, reason: intent.reason, args: fill(intent.args) };
        }
      }
      if (!chosen) chosen = chooseAuto(listing) ?? undefined;
    }
    if (!chosen) throw new CoreError('invalid_request', 'automatic routing found no available local executor; choose one explicitly');
  } else {
    chosen = listing.executors.find(e => e.id === req.executor);
    if (!chosen) throw new CoreError('invalid_request', `unknown executor '${req.executor}'`);
    if (!chosen.dispatchable) throw new CoreError('invalid_request', `${chosen.label}: ${chosen.reason}`);
    if (!chosen.available) throw new CoreError('conflict', `${chosen.label} is not available: ${chosen.reason ?? 'unavailable'}`);
  }
  // Services that handle private data (a household's documents) are not for a paired browser, however they were chosen (named or routed).
  if (chosen.kind === 'service' && rt.services?.get(chosen.id.slice('service:'.length))?.internal && req.authority !== 'host') {
    throw new CoreError('forbidden', `${chosen.label} is internal to Pandesh and cannot be started from a browser`);
  }
  // Project-aware workspace: a task that names an authorized project (by path, or by name together with code words) is resolved
  // against the owner's registry. It is never resolved to whatever workspace is open, never searched for, and a read-only
  // project never runs a task that may change files. Ambiguous or unauthorized means ask; no permission is widened.
  let inspection: InspectionPlan | null = null;
  const intent = gateProject(rt, task, chosen);
  if (!intent) requireAnswerOnly(rt, task, chosen);
  if (intent && transferInfo(chosen.id, model).external && req.approvalRequestId) {
    // What the owner approved is what runs: same project, branch AND commit. A moved branch, an edited registry entry or a swapped
    // checkout since the card was shown means the card no longer describes this run.
    const approved = usableApproval(db, taskId, req.approvalRequestId).scope;
    const now = previewInspection(intent);
    // The approved access must be exactly what would run now: an inspection card never starts a change, and a change needs a project
    // that is still read-write. (Before A5 this also required access 'read', which made read-write projects impossible to inspect.)
    const sameAccess = approved.access === accessLevelOf(intent, missionOf(task).length) && (intent.mode === 'inspect' || intent.project.access === 'read-write');
    if (approved.project !== intent.project.name || approved.branch !== now.branch || (approved.commit ?? null) !== now.commit || !sameAccess) {
      throw new CoreError('conflict', `'${intent.project.name}' changed since you approved this (now ${now.branch} at ${now.commit}); nothing was copied or sent. Ask again to see the new details.`, { reason: 'approval_scope_changed' });
    }
    inspection = prepareProjectInspection(rt.dataDir, task.id, intent.project, intent.path, now.branch, now.commit, intent.mode);
  } else if (intent) inspection = prepareProjectInspection(rt.dataDir, task.id, intent.project, intent.path, intent.ref, null, intent.mode);
  const info = transferInfo(chosen.id, model);
  if (routing === 'auto' && info.external) {
    // A routed (not hand-picked) external executor still needs the host's explicit consent for this task.
    const decision = evaluateTransferPolicy(task, info, consent);
    if (!decision.allowed) throw new CoreError('forbidden', decision.message, { reason: decision.code });
  }

  if (!claimBridgeDispatch(db, taskId, { executor: chosen.id, model, routing, consent: info.external ? (consent ?? null) : null, grantedBy: req.decidedBy, ...((req.taskClass ?? derived?.taskClass) ? { taskClass: (req.taskClass ?? derived?.taskClass) as string } : {}) })) {
    return { task: getBridgeTask(db, taskId), started: false };
  }
  const includeContext = task.contextConfirmed && (!info.external || consent?.includeContext === true);
  if (info.external && req.approvalRequestId) consumeApproval(db, taskId, req.approvalRequestId, req.decidedBy);
  // A host-authorised external start that did not come through an approval card is still put in the audit trail, with who and what scope.
  if (info.external && !req.approvalRequestId) {
    recordDirectApproval(db, taskId, { executor: chosen.id, model, project: inspection?.project.name ?? null, branch: inspection?.ref ?? null, access: inspection ? (inspection.mode === 'code' ? 'code change in an isolated copy' : 'read-only inspection') : 'answer only', instructionSha256: task.instructionSha256, confidentialOverride: consent?.confidentialOverride === true, includeContext }, req.decidedBy);
  }

  try {
    if (chosen.kind === 'service') startService(rt, getBridgeTask(db, taskId), chosen.id.slice('service:'.length), derived ?? undefined);
    else if (chosen.id === 'native') await startNative(rt, getBridgeTask(db, taskId));
    else await startAcp(rt, getBridgeTask(db, taskId), chosen.id as DevAgent, model, includeContext, inspection);
  } catch (err) {
    // Not started: hand the task back so the user can retry or pick another executor. A half-created story is reused on retry.
    const message = err instanceof Error ? err.message : String(err);
    recordBridgeStatus(db, taskId, 'failed', `Could not start ${chosen.label}: ${message}`.slice(0, 500));
    throw err;
  }
  return { task: getBridgeTask(db, taskId), started: true };
}

async function startAcp(rt: BridgeRuntime, task: BridgeTaskRecord, agent: DevAgent, model: string | null, includeContext: boolean, inspection: InspectionPlan | null = null): Promise<void> {
  const { db } = rt;
  let storyId = task.storyId;
  let projectId = task.projectId;
  let workspace = task.workspacePath;
  const steps = missionOf(task);
  let storyIds: string[] | undefined;
  if (!storyId && inspection?.mode === 'code' && steps.length > 1) {
    // A mission: one dependent story per step, all in Kandev worktrees of ONE private copy, integrated in order onto one branch. The
    // owner's approval of the mission card is the development grant the steps carry (bounded by time; revoked by Stop).
    workspace = inspection.cloneDir;
    const objective = task.instruction.split('\nSteps (')[0]!.trim();
    const grant = { id: `grant-${task.id.slice(-12)}`, expiresAt: new Date(Date.now() + MISSION_GRANT_MS).toISOString(), steps: steps.length };
    const plan = planDevStories(db, {
      // A project of its own per mission, so the task's projectId names exactly its steps.
      projectName: `Panda mission ${task.id.slice(-12)}`,
      repoPath: workspace,
      baseBranch: inspection.ref,
      integrationBranch: `panda/mission-${task.id.slice(-12)}`,
      verify: ['git', 'status', '--porcelain'],
      stories: steps.map((s, i) => ({
        key: s.key, title: `${inspection.project.name} ${i + 1}/${steps.length}: ${s.instruction}`.slice(0, 80),
        description: [`Mission objective: ${objective}`, '', `This step (${s.key}): ${s.instruction}`, s.dependsOn.length ? `It builds on the already integrated steps: ${s.dependsOn.join(', ')}.` : ''].join('\n'),
        agent, ...(model ? { model } : {}), dependsOn: s.dependsOn,
        acceptanceCriteria: ['The step\'s change is made in this repository', 'Tests that passed before still pass'],
        maxFiles: CODE_CHANGE_MAX_FILES,
        codeCopy: { projectName: inspection.project.name, sourcePath: inspection.sourcePath, ref: inspection.ref, sourceHead: inspection.sourceHead, sourceStatusSha: inspection.sourceStatusSha, testsRequested: asksForTests(s.instruction), grant, step: i + 1 },
      })),
    });
    storyIds = plan.stories.map(s => s.id);
    storyId = storyIds[0]!;
    projectId = plan.projectId;
    attachBridgeExecution(db, task.id, { projectId, storyId, workspacePath: workspace });
  } else if (!storyId && inspection?.mode === 'code') {
    // A5: the change is made in Kandev's worktree of the private copy, verified, held for the owner's review, then integrated onto a
    // branch inside the copy. The copy has no remote; the owner's checkout is never a worktree, a base or an integration target.
    workspace = inspection.cloneDir;
    const plan = planDevStories(db, {
      projectName: 'Panda bridge',
      repoPath: workspace,
      baseBranch: inspection.ref,
      integrationBranch: `panda/change-${task.id.slice(-12)}`,
      verify: ['git', 'status', '--porcelain'],
      stories: [{
        key: 'task', title: `Change ${inspection.project.name}: ${task.instruction.replace(/\s+/g, ' ').trim()}`.slice(0, 80),
        description: answerDescription(task, includeContext), agent, ...(model ? { model } : {}),
        acceptanceCriteria: ['The requested change is made in this repository', 'The existing tests for the touched code still pass'],
        maxFiles: CODE_CHANGE_MAX_FILES,
        codeCopy: { projectName: inspection.project.name, sourcePath: inspection.sourcePath, ref: inspection.ref, sourceHead: inspection.sourceHead, sourceStatusSha: inspection.sourceStatusSha, testsRequested: asksForTests(task.instruction) },
      }],
    });
    storyId = plan.stories[0].id;
    projectId = plan.projectId;
    attachBridgeExecution(db, task.id, { projectId, storyId, workspacePath: workspace });
  } else if (!storyId && inspection) {
    workspace = inspection.cloneDir;
    const title = `Inspect ${inspection.project.name}: ${task.instruction.replace(/\s+/g, ' ').trim()}`.slice(0, 80);
    const plan = planDevStories(db, {
      projectName: 'Panda bridge',
      repoPath: workspace,
      baseBranch: inspection.ref,
      integrationBranch: `panda/inspect-${task.id.slice(-12)}`,
      // The one command the worker may run besides read-only git and tests; harmless here.
      verify: ['git', 'status', '--porcelain'],
      stories: [{
        key: 'task', title, agent, ...(model ? { model } : {}), mode: 'inspect',
        description: [task.instruction, inspection.uncommittedFiles ? `\n(Note: the owner's checkout has ${inspection.uncommittedFiles} uncommitted or untracked file(s) that are not part of this snapshot of branch ${inspection.ref}; say so in your report if it matters.)` : ''].join(''),
        inspect: { projectName: inspection.project.name, sourcePath: inspection.sourcePath, ref: inspection.ref, sourceHead: inspection.sourceHead, sourceStatusSha: inspection.sourceStatusSha },
      }],
    });
    storyId = plan.stories[0].id;
    projectId = plan.projectId;
    attachBridgeExecution(db, task.id, { projectId, storyId, workspacePath: workspace });
  } else if (!storyId) {
    // No project: an answer-only task (dispatch refused anything that may change files). The worker's working directory is an empty
    // folder that holds nothing of the owner's; it is verified like an inspection: any changed file fails it, and its own final
    // message is the result. It is never sent back with "make changes" repair instructions.
    workspace = prepareTaskWorkspace(rt.dataDir, task.id);
    const title = task.instruction.replace(/\s+/g, ' ').trim().slice(0, 80);
    const plan = planDevStories(db, {
      projectName: 'Panda bridge',
      repoPath: workspace,
      baseBranch: 'main',
      integrationBranch: `panda/${task.id.slice(-12)}`,
      verify: ['git', 'status', '--porcelain'],
      stories: [{ key: 'task', title, description: answerDescription(task, includeContext), agent, ...(model ? { model } : {}), mode: 'inspect', answerOnly: true }],
    });
    storyId = plan.stories[0].id;
    projectId = plan.projectId;
    attachBridgeExecution(db, task.id, { projectId, storyId, workspacePath: workspace });
  }
  // A mission retried after a failed start re-dispatches all its steps (handing over is idempotent per story).
  if (!storyIds && steps.length > 1 && projectId) storyIds = missionStories(db, projectId).map(s => s.id);
  await dispatchWhenKandevIsReady(rt, projectId!, storyIds ?? [storyId], task.conversationId);
  recordBridgeStatus(db, task.id, 'running', steps.length > 1 && inspection
    ? `Mission of ${steps.length} steps started on a private copy of ${inspection.project.name} (branch ${inspection.ref}); steps run in dependency order. Nothing is pushed and your checkout is not touched.`
    : inspection?.mode === 'code'
    ? `${KNOWN[agent].label} is changing a private copy of ${inspection.project.name} (branch ${inspection.ref}); nothing is pushed and your checkout is not touched.`
    : inspection
    ? `${KNOWN[agent].label} is inspecting a read-only copy of ${inspection.project.name} (branch ${inspection.ref}); your checkout is not touched.`
    : `${KNOWN[agent].label} is answering. No project is shared and it may not change any file.`);
}

/**
 * Kandev answers its very first calls after a cold start with an empty error while it seeds its first workspace. Handing a
 * story over is idempotent (a Kandev task is bound to its story id), so wait a moment and try again instead of failing the task.
 */
async function dispatchWhenKandevIsReady(rt: BridgeRuntime, projectId: string, storyIds: string[], conversationId: string | null): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await dispatchDevStories(rt.db, rt.kandev, { projectId, storyIds, conversationId });
      return;
    } catch (err) {
      last = err;
      const warming = err instanceof KandevUnavailableError || /list_workspaces_kandev|has no workspace|not reachable/i.test(err instanceof Error ? err.message : String(err));
      if (!warming) throw err;
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }
  throw last;
}

const activeServices = new Map<string, AbortController>();

/** Runs a registered deterministic service in the background; status, cancel and the deadline reuse the bridge lifecycle. */
function startService(rt: BridgeRuntime, task: BridgeTaskRecord, serviceId: string, derived?: { reason: string; args: Record<string, unknown> }): void {
  const svc = rt.services?.get(serviceId);
  if (!svc) throw new CoreError('invalid_request', `unknown service '${serviceId}'`);
  const ac = new AbortController();
  activeServices.set(task.id, ac);
  const base: BridgeTaskResult = { verification: null, evidence: null, changedFiles: [], commit: null, pendingApprovals: [], activity: [], timeline: [] };
  const log = (event: string, text: string) => ({ at: new Date().toISOString(), event, text });
  recordBridgeStatus(rt.db, task.id, 'running', derived ? `Routed to ${svc.label}, no model involved: ${derived.reason}.` : `${svc.label} is running (no model involved).`);
  void (async () => {
    try {
      const host: ServiceHost = {
        kandevRunning: () => rt.kandev.healthy(),
        runWorkflow: async (workflowId, input) => {
          const { runWorkflow } = await import('./workflowRouter');
          const def = BUILTIN_WORKFLOWS.find(w => w.id === workflowId);
          if (!def) throw new Error(`unknown workflow '${workflowId}'`);
          return runWorkflow(rt, getPairing(rt.db, task.pairingId), def, input, { runId: `wf-${task.id}`.slice(0, 60), decidedBy: 'bridge:intent-router' });
        },
      };
      const out = await svc.run({ args: derived?.args ?? parseServiceArgs(task.instruction), signal: ac.signal, db: rt.db, host, taskId: task.id, dataDir: rt.dataDir });
      if (ac.signal.aborted || getBridgeTask(rt.db, task.id).control === 'cancelled') return;
      recordBridgeStatus(rt.db, task.id, 'completed', out.summary, {
        ...base, verification: out.verification ?? 'independent', evidence: redactPaths(JSON.stringify(out.evidence)).slice(0, 3_000), changedFiles: out.files ?? [],
        timeline: [log('service', `${svc.id}: ${out.summary}`)],
      });
    } catch (err) {
      if (ac.signal.aborted) return;
      const msg = redactPaths(err instanceof Error ? err.message : String(err)).slice(0, 300);
      recordBridgeStatus(rt.db, task.id, 'failed', `${svc.label} failed: ${msg}`, { ...base, timeline: [log('service', `failed: ${msg}`)] });
    } finally { activeServices.delete(task.id); }
  })();
}

async function startNative(rt: BridgeRuntime, task: BridgeTaskRecord): Promise<void> {
  if (!rt.executor) throw new CoreError('conflict', 'this Core has no runtime executor for native capabilities');
  const workspace = prepareTaskWorkspace(rt.dataDir, task.id);
  const first = rt.db.get<{ id: string }>("SELECT id FROM conversation_messages WHERE conversationId = ? AND role = 'user' ORDER BY seq ASC LIMIT 1", [task.conversationId]);
  const submitted = submitRequest(rt.db, {
    clientId: 'panda-bridge', currentMessage: task.instruction, requestedMode: 'saath_kar', conversationId: task.conversationId,
    workspaceRoot: workspace, capability: { hasWorkspace: true, gitCapable: true }, correlationId: newId('corr'),
    idempotencyKey: `panda-bridge:${task.id}`, ...(first ? { reuseUserMessageId: first.id } : {}),
  });
  attachBridgeExecution(rt.db, task.id, { attemptId: submitted.attempt.id, workspacePath: workspace });
  void rt.executor.execute(submitted.attempt.id, { workingDirectory: workspace }).catch(() => { /* surfaced through the attempt's own status */ });
  recordBridgeStatus(rt.db, task.id, 'running', 'Pandesh is working on it with its native capabilities.');
}

// ------------------------------------------------------------------ mirror work state into the relayed task

const redactPaths = (text: string) => text.replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'`<>|,;]*[^\s"'`<>|,;.]/g, '<path>');

function mapPhase(phase: string, storyStatus: string, control: BridgeTaskRecord['control']): { status: BridgeTaskStatus; detail: string } {
  // What "done" means depends on the kind of task; the outcome summary says it (never a blanket "verified").
  if (storyStatus === 'done') return { status: 'completed', detail: 'Finished.' };
  if (phase === 'stopped') return control === 'cancelled' ? { status: 'cancelled', detail: 'Cancelled.' } : { status: 'paused', detail: 'Paused. Resume to continue from the preserved work.' };
  if (phase === 'needs approval') return { status: 'awaiting_approval', detail: 'The executor is waiting for your approval in Pandesh.' };
  if (phase === 'awaiting review') return { status: 'awaiting_approval', detail: 'The work is ready; review and approve it in Pandesh.' };
  if (phase === 'blocked') return { status: 'needs_attention', detail: 'The work needs your attention in Pandesh.' };
  if (phase === 'verifying' || phase === 'integrating' || phase.startsWith('turn finished')) return { status: 'verifying', detail: 'Verifying the result.' };
  if (phase === 'waiting') return { status: 'running', detail: 'Waiting for a free worker slot.' };
  return { status: 'running', detail: 'Working.' };
}

/**
 * Appends newly observed worker events to the recorded log: deduplicated by Kandev message id, in time order, the newest
 * BRIDGE_ACTIVITY_LIMIT kept. `fresh === null` (Kandev unreachable, no session yet) leaves the log exactly as it was.
 */
export function mergeActivity(previous: BridgeTaskResult['activity'], fresh: BridgeTaskResult['activity'] | null): BridgeTaskResult['activity'] {
  if (!fresh) return previous;
  // Entries without an id come from builds that kept only the last three lines; the full log replaces them.
  const byId = new Map(previous.filter(e => e.id).map(e => [e.id!, e]));
  let changed = byId.size !== previous.length;
  for (const e of fresh) {
    if (!e.id) continue;
    const old = byId.get(e.id);
    // Kandev streams a message by growing it under the same id: the newer text (or tool status) replaces the fragment.
    if (!old || old.text !== e.text || old.status !== e.status) { byId.set(e.id, e); changed = true; }
  }
  if (!changed) return previous;
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-BRIDGE_ACTIVITY_LIMIT);
}

const WORKER_EXPLANATION = '--- worker explanation (its own words) ---';

/**
 * What happened to the REQUESTED outcome, read from KKD's own records on the story (never from the worker's claims): the worker is still
 * working, finished (an answer or an inspection: its own report), failed (made no change and said why), failed Pandesh's checks, waits for
 * the owner's review, was not approved, or the change was approved and committed (and perhaps delivered).
 */
export function outcomeOf(db: CoreDatabase, task: BridgeTaskRecord, storyStatus: string, spec: DevStorySpec, changedFiles: string[]): BridgeTaskOutcome {
  const intent: TaskIntentKind = spec.codeCopy ? 'code' : spec.mode === 'inspect' ? (spec.answerOnly ? 'answer' : 'inspect') : taskIntentOf(task).kind;
  const prior = task.result?.outcome;
  if (prior?.state === 'review_denied') return prior; // the owner's refusal is final
  const comments = task.storyId ? listComments(db, task.storyId) : [];
  const last = (tag: string) => [...comments].reverse().find(c => c.body.startsWith(tag)) ?? null;
  const project = spec.codeCopy?.projectName ?? spec.inspect?.projectName ?? 'the project';
  let tests: BridgeTaskOutcome['tests'] = null;
  let testLine = '';
  const tc = last(TESTS_TAG);
  if (tc) {
    try {
      const cmp = JSON.parse(tc.body.slice(TESTS_TAG.length)) as TestComparison;
      tests = { command: cmp.command, perTest: cmp.perTest, passedAfter: cmp.after.passed, failedAfter: cmp.after.failed, newPassing: cmp.newPassing, newFailing: cmp.newFailing, regressions: cmp.regressions, preExistingFailing: cmp.preExistingFailing, fixed: cmp.fixed };
      const j = judgeTests(cmp, spec.codeCopy?.testsRequested === true);
      testLine = j.ok ? j.report : `Pandesh's own test run failed: ${j.what}.`;
    } catch { /* an unreadable record is simply not reported */ }
  }
  const failed = last('[kkd-dev:verify-failed]');
  const explanation = failed && failed.body.includes(WORKER_EXPLANATION) ? failed.body.slice(failed.body.indexOf(WORKER_EXPLANATION) + WORKER_EXPLANATION.length).trim().slice(0, 1_500) : null;
  const failedWhat = failed ? failed.body.split('\n')[0]!.replace('[kkd-dev:verify-failed]', '').trim().slice(0, 300) : '';
  const o = (state: BridgeTaskOutcome['state'], summary: string): BridgeTaskOutcome => ({ intent, state, summary: redactPaths(summary).replace(/\s+/g, ' ').trim(), tests, workerExplanation: explanation });

  if (storyStatus === 'done') {
    if (intent === 'code') {
      const delivered = task.result?.codeChange?.delivered;
      const underGrant = /development grant/.test(last('[kkd-dev:integrated]')?.body ?? '');
      const how = underGrant ? 'passed Pandesh\'s own test run and was committed under your development grant' : 'was approved by you and committed';
      return delivered
        ? o('delivered', `The requested change to ${project} ${how}, and is in your checkout as the new branch ${delivered.branch} (not checked out, not merged, not pushed). ${testLine}`)
        : o('outcome_completed', `The requested change to ${project} ${how} to ${spec.integrationBranch} in Pandesh's private copy; nothing was pushed, merged or installed. ${testLine} It reaches your checkout only if you choose "Bring into my checkout".`);
    }
    if (intent === 'answer') return o('worker_finished', 'Answered. The reply is the worker\'s own; no project was shared and no file changed.');
    return o('worker_finished', `Inspection of ${project} finished. The findings, including any test results, are the worker's own report; Pandesh checked only that nothing changed. No code was changed.`);
  }
  if (storyStatus === 'delivery_approval' && intent === 'code') {
    return o('awaiting_owner_review', `The change to ${project} is ready for your review in Pandesh: ${changedFiles.length} file(s) changed (${changedFiles.slice(0, 6).join(', ')}). ${testLine} Nothing is committed until you approve it.`);
  }
  if (storyStatus === 'blocked' && task.control === 'none') {
    if (explanation || /made no changes/.test(failedWhat)) {
      return o('worker_failed', `The worker made no changes${explanation ? ` and explained why: ${explanation}` : ', and gave no explanation.'}${intent === 'code' ? ' The requested change was not made.' : ''}`);
    }
    const needs = last('[kkd-dev:needs-human]');
    // The worker could not run at all (usage limit, sign-in, launch failure): that is the worker failing, not a check failing.
    if (needs && /\[kkd-dev:(account-limit|signin-expired|launch-failed)\]/.test(needs.body)) {
      return o('worker_failed', `${needs.body.replace(/\[kkd-dev:[\w-]+\]\s*/g, '').trim().slice(0, 500)}${intent === 'code' ? ' The requested change was not made.' : ''}`);
    }
    return o('verification_failed', `Pandesh's checks did not accept the result${failedWhat ? `: ${failedWhat}` : needs ? `: ${needs.body.replace('[kkd-dev:needs-human]', '').trim().slice(0, 300)}` : '.'}${intent === 'code' ? ' The requested change was not delivered.' : ''}`);
  }
  if (failed && intent === 'code' && (storyStatus === 'implementing' || storyStatus === 'review')) {
    return o('worker_running', `Pandesh's check failed (${failedWhat}); the worker was asked to fix it.`);
  }
  return o('worker_running', 'Working.');
}

/**
 * A mission's steps (its own project's stories), in plan order. The stories of one plan are created in the same instant, so creation time
 * cannot order them: the plan position is stored in the spec (`step`), and for missions planned before that, read from the title's "i/N:".
 */
export function missionStories(db: CoreDatabase, projectId: string): StoryRecord[] {
  const position = (s: StoryRecord): number => devSpec(s)?.codeCopy?.step ?? Number(s.title.match(/ (\d+)\/\d+: /)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return listStories(db, { projectId, limit: 50 }).filter(s => devSpec(s)?.codeCopy)
    .sort((a, b) => position(a) - position(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Mirrors a mission: each step's own outcome (from KKD's records), and one overall status that never claims more than the steps show.
 * Completed only when every step is integrated; a stopped step makes the mission need attention (the steps after it wait); a step held
 * for review makes it await the owner. Worker events come from the step that is working now.
 */
async function refreshMission(rt: BridgeRuntime, task: BridgeTaskRecord): Promise<BridgeTaskRecord> {
  const { db } = rt;
  const plan = missionOf(task);
  const stories = task.projectId ? missionStories(db, task.projectId) : [];
  if (!stories.length || stories.every(s => s.status === 'ready')) return task;
  const steps: NonNullable<BridgeTaskResult['steps']> = [];
  const changed = new Set<string>();
  for (const [i, s] of stories.entries()) {
    const spec = devSpec(s)!;
    const detail = await devStoryDetail(db, rt.kandev, s.id).catch(() => null);
    detail?.changedFiles.forEach(f => changed.add(f));
    let o = outcomeOf(db, { ...task, storyId: s.id, result: task.result ? { ...task.result, outcome: undefined } : null }, s.status, spec, detail?.changedFiles ?? []);
    // A step whose dependencies are not integrated yet is queued in Kandev, not worked on: say what it waits for.
    const waitsFor = (plan[i]?.dependsOn ?? []).filter(k => { const j = plan.findIndex(p => p.key === k); return stories[j]?.status !== 'done'; });
    if (s.status === 'implementing' && waitsFor.length && o.state === 'worker_running') o = { ...o, state: 'waiting', summary: `Waits for ${waitsFor.join(', ')}.` };
    steps.push({ key: plan[i]?.key ?? `step-${i + 1}`, title: s.title, storyId: s.id, storyStatus: s.status, state: o.state, summary: o.summary, tests: o.tests, pendingApprovals: detail?.story.pendingApprovals ?? [] });
  }
  const active = stories.find(s => s.status !== 'done') ?? stories[stories.length - 1]!;
  const activeStep = steps.find(s => s.storyId === active.id)!;
  const worker = await devStoryWorkerEvents(rt.kandev, active.id).catch(() => null);
  const spec = devSpec(stories[0]!)!;
  const project = spec.codeCopy!.projectName;
  const done = steps.filter(s => s.storyStatus === 'done').length;
  const stopped = steps.find(s => s.storyStatus === 'blocked');
  const review = steps.find(s => s.storyStatus === 'delivery_approval');
  let status: BridgeTaskStatus; let state: BridgeTaskOutcome['state']; let summary: string;
  if (task.control === 'paused') { status = 'paused'; state = 'worker_running'; summary = `Paused after ${done} of ${steps.length} steps.`; }
  else if (done === steps.length) {
    status = 'completed'; state = task.result?.codeChange?.delivered ? 'delivered' : 'outcome_completed';
    summary = `All ${steps.length} steps of the mission on ${project} are committed to ${spec.integrationBranch} in Pandesh's private copy (nothing pushed, merged or installed). ${steps[steps.length - 1]!.summary.replace(/^.*?(Pandesh ran)/, '$1')}`;
  } else if (stopped && task.control === 'none') {
    status = 'needs_attention'; state = stopped.state;
    summary = `Step ${steps.indexOf(stopped) + 1} of ${steps.length} (${stopped.key}) stopped: ${stopped.summary} ${done} step(s) are done; the steps after it wait.`;
  } else if (review) {
    status = 'awaiting_approval'; state = 'awaiting_owner_review';
    summary = `Step ${steps.indexOf(review) + 1} of ${steps.length} (${review.key}) waits for your review: ${review.summary}`;
  } else {
    status = 'running'; state = 'worker_running';
    summary = `Step ${steps.indexOf(activeStep) + 1} of ${steps.length} (${activeStep.key}) is ${activeStep.storyStatus === 'implementing' ? 'being worked on' : activeStep.storyStatus}; ${done} done. ${activeStep.state === 'worker_running' && activeStep.summary !== 'Working.' ? activeStep.summary : ''}`.trim();
  }
  const result: BridgeTaskResult = {
    verification: done === steps.length ? 'worker-only' : null,
    evidence: null,
    changedFiles: [...changed],
    commit: null,
    pendingApprovals: activeStep.pendingApprovals,
    activity: mergeActivity(task.result?.activity ?? [], worker?.events.map(e => ({ ...e, text: redactPaths(e.text) })) ?? null),
    timeline: [],
    branch: worker?.branch ?? task.result?.branch ?? null,
    codeChange: { project, baseRef: spec.codeCopy!.ref, delivered: task.result?.codeChange?.delivered ?? null },
    steps,
    outcome: { intent: 'code', state, summary: redactPaths(summary).replace(/\s+/g, ' ').trim(), tests: activeStep.tests, workerExplanation: stopped ? (stopped.summary.match(/explained why: (.*)/)?.[1] ?? null) : null },
  };
  recordBridgeStatus(db, task.id, status, result.outcome!.summary.slice(0, 500), result);
  return getBridgeTask(db, task.id);
}

/** Brings a relayed task up to date from the work behind it and stores a checkpoint when something changed. */
export async function refreshBridgeTask(rt: BridgeRuntime, taskId: string): Promise<BridgeTaskRecord> {
  const { db } = rt;
  const task = getBridgeTask(db, taskId);
  if (TERMINAL_BRIDGE_STATUSES.has(task.status) || !['dispatching', 'running', 'awaiting_approval', 'verifying', 'paused', 'needs_attention'].includes(task.status)) return task;

  if (task.storyId && missionOf(task).length > 1) {
    try { return await refreshMission(rt, task); } catch { recordBridgeStatus(db, taskId, task.status, 'Waiting for the executor to be reachable again.'); return getBridgeTask(db, taskId); }
  }
  if (task.storyId) {
    const story = getStory(db, task.storyId);
    if (!devSpec(story)) return task;
    try {
      const detail = await devStoryDetail(db, rt.kandev, task.storyId);
      const view = detail.story;
      // Planned but not yet handed to Kandev: the dispatch in progress (or a failed one) owns the status, not the mirror.
      if (view.phase === 'not dispatched' || story.status === 'ready') return getBridgeTask(db, taskId);
      const mapped = mapPhase(view.phase, story.status, task.control);
      const worker = await devStoryWorkerEvents(rt.kandev, task.storyId);
      const result: BridgeTaskResult = {
        verification: view.verification,
        // An inspection's evidence IS the report; give it room.
        evidence: view.evidence ? redactPaths(view.evidence).slice(0, view.evidence.startsWith('[kkd-dev:inspected]') ? 8_000 : 3_000) : null,
        changedFiles: detail.changedFiles,
        commit: view.commit,
        pendingApprovals: view.pendingApprovals,
        // The worker's own events, appended to what was already recorded (kept after the task ends and across restarts). Commands and
        // file names can carry local paths; they are redacted, and only the summary line ever leaves this PC (see the extension view).
        activity: mergeActivity(task.result?.activity ?? [], worker?.events.map(e => ({ ...e, text: redactPaths(e.text) })) ?? null),
        timeline: detail.timeline.slice(-30),
        branch: worker?.branch ?? task.result?.branch ?? view.branch ?? null,
        ...(devSpec(story)!.codeCopy ? { codeChange: { project: devSpec(story)!.codeCopy!.projectName, baseRef: devSpec(story)!.codeCopy!.ref, delivered: task.result?.codeChange?.delivered ?? null } } : {}),
      };
      result.outcome = outcomeOf(db, task, story.status, devSpec(story)!, detail.changedFiles);
      // Where the coordinator names a concrete reason (a free slot, a review), show it; for settled states the mapped wording is clearer.
      const settled = mapped.status === 'paused' || mapped.status === 'cancelled' || mapped.status === 'completed';
      // Finished, failed, awaiting the owner's review: the outcome says exactly what happened (a held worker action keeps its own wording).
      const speaks = result.outcome.state !== 'worker_running' && (mapped.status === 'completed' || mapped.status === 'needs_attention' || (mapped.status === 'awaiting_approval' && !view.pendingApprovals.length));
      const detailText = speaks ? result.outcome.summary.slice(0, 500) : !settled && view.waitingReason ? redactPaths(view.waitingReason).slice(0, 300) : mapped.detail;
      recordBridgeStatus(db, taskId, mapped.status, detailText, result);
    } catch {
      recordBridgeStatus(db, taskId, task.status, 'Waiting for the executor to be reachable again.');
    }
  } else if (task.attemptId) {
    const attempt = getAttempt(db, task.attemptId);
    const map: Record<string, [BridgeTaskStatus, string]> = {
      created: ['running', 'Queued.'], queued: ['running', 'Queued.'], running: ['running', 'Working.'],
      waiting_for_approval: ['awaiting_approval', 'Waiting for your approval in Pandesh.'], validating: ['verifying', 'Verifying the result.'],
      paused: ['paused', 'Paused.'], blocked: ['needs_attention', 'Needs your attention in Pandesh.'], recovery_required: ['needs_attention', 'Needs your attention in Pandesh.'],
      cancelling: ['running', 'Cancelling.'], completed: ['completed', 'Finished.'], failed: ['failed', 'The attempt failed.'], cancelled: ['cancelled', 'Cancelled.'],
    };
    const [status, detail] = map[attempt.status] ?? ['running', 'Working.'];
    // A finished native task carries what Pandesh actually answered, so a report and the activity view show the outcome and not just "Finished".
    // It is the model's own answer: labelled worker-only, never "verified".
    let result: BridgeTaskResult | undefined;
    if (attempt.status === 'completed' && task.conversationId) {
      const row = db.get<{ content: string }>("SELECT content FROM conversation_messages WHERE conversationId = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1", [task.conversationId]);
      if (row?.content) result = { verification: 'worker-only', evidence: redactPaths(row.content).slice(0, 3_000), changedFiles: [], commit: null, pendingApprovals: [], activity: [], timeline: [] };
    }
    recordBridgeStatus(db, taskId, task.control === 'cancelled' && isTerminalAttemptStatus(attempt.status) ? 'cancelled' : status, detail, result);
  }
  return getBridgeTask(db, taskId);
}

/** The A5 story behind a relayed task, or a conflict saying why there is none. */
function codeChangeOf(rt: BridgeRuntime, taskId: string): { task: BridgeTaskRecord; storyId: string; spec: DevStorySpec & { codeCopy: NonNullable<DevStorySpec['codeCopy']> }; allDone: boolean } {
  const task = getBridgeTask(rt.db, taskId);
  // A mission's review/approval is about the step that is waiting for it; delivery needs every step done.
  const stories = task.projectId && missionOf(task).length > 1 ? missionStories(rt.db, task.projectId) : [];
  const storyId = stories.find(s => s.status === 'delivery_approval')?.id ?? task.storyId;
  const spec = storyId ? devSpec(getStory(rt.db, storyId)) : null;
  if (!storyId || !spec?.codeCopy) throw new CoreError('conflict', 'this task is not a code change');
  const allDone = stories.length ? stories.every(s => s.status === 'done') : getStory(rt.db, storyId).status === 'done';
  return { task, storyId, spec: spec as DevStorySpec & { codeCopy: NonNullable<DevStorySpec['codeCopy']> }, allDone };
}

/**
 * The owner approves a reviewed A5 change (host only; the route checks). KKD then commits it onto the integration branch inside
 * the private copy, re-runs its checks there, and the task completes. Nothing is pushed: the copy has no remote.
 */
export async function approveBridgeChange(rt: BridgeRuntime, taskId: string, who: string): Promise<BridgeTaskRecord> {
  const { task, storyId } = codeChangeOf(rt, taskId);
  // A change the owner refused (or a cancelled task) can never be approved afterwards, whatever state the worker was left in.
  if (task.control === 'cancelled' || task.status === 'cancelled' || task.result?.outcome?.state === 'review_denied') throw new CoreError('conflict', 'this change was not approved or the task was cancelled; nothing can be approved now');
  await approveDevStoryReview(rt.db, rt.kandev, storyId, `Approved in Pandesh by ${who}`);
  return refreshBridgeTask(rt, taskId);
}

const TEST_RUN = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+(?:vitest|jest)|vitest\b|jest\b|pytest\b|python\s+-m\s+(?:pytest|unittest)|node\s+--test\b|go\s+test\b|cargo\s+test\b|dotnet\s+test\b|mvn\s+test\b|gradle\w*\s+test\b)/i;

export interface BridgeChangeTests {
  /** What Pandesh itself checked, with the level it reached. */
  pandesh: { level: string | null; detail: string | null };
  /** Test commands the worker ran, from its event log (reported by the worker, not re-run by Pandesh). */
  worker: Array<{ command: string; status: string; at: string }>;
  workerSummary: string | null;
}

/**
 * The A5 change as a read-only diff for the owner's review (host only; the route checks). Read from the worker's worktree before
 * approval and from the private copy after; both are proven to be this task's before anything is read. Approves nothing.
 */
export async function bridgeChangeDiff(rt: BridgeRuntime, taskId: string): Promise<{ diff: ChangeDiff & { ignored: string[] }; tests: BridgeChangeTests }> {
  const { task, storyId, spec } = codeChangeOf(rt, taskId);
  const norm = (p: string) => { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch { /* as spelled */ } return r.replace(/\\/g, '/').toLowerCase(); };
  const root = norm(path.join(rt.dataDir, 'panda-workspaces'));
  const diff = norm(spec.repoPath).startsWith(`${root}/`)
    ? await devStoryChangeDiff(rt.db, rt.kandev, storyId)
    : { ...unavailableDiff('The diff is not shown: the change is not in a Pandesh private copy.'), ignored: [] };
  const result = task.result;
  const activity = result?.activity ?? [];
  const worker = activity.filter(a => a.kind.startsWith('tool') && TEST_RUN.test(a.text)).map(a => ({ command: a.text.slice(0, 200), status: a.status ?? 'unknown', at: a.at }));
  const summary = [...activity].reverse().find(a => a.kind === 'message' && /\btests?\b/i.test(a.text) && /\b(pass|fail|error)/i.test(a.text));
  const kkd = [...(result?.timeline ?? [])].reverse().find(t => t.event === 'integrated' || t.event === 'verified');
  return {
    diff,
    tests: { pandesh: { level: result?.verification ?? null, detail: kkd ? redactPaths(kkd.text.split('\n')[0]).slice(0, 300) : null }, worker, workerSummary: summary ? redactPaths(summary.text).slice(0, 400) : null },
  };
}

/**
 * The owner asks for an approved A5 change in their own checkout. It arrives as a NEW local branch fetched from the private copy:
 * the owner's working tree, index and current branch are not touched, nothing is checked out, merged or pushed, and an existing
 * branch is never overwritten.
 */
export function deliverBridgeChange(rt: BridgeRuntime, taskId: string, who: string): { branch: string; commit: string } {
  const { task, spec, allDone } = codeChangeOf(rt, taskId);
  if (task.status !== 'completed' || !allDone) throw new CoreError('conflict', 'the change is not approved and integrated yet');
  if (task.result?.codeChange?.delivered) return task.result.codeChange.delivered;
  const git = (args: string[], cwd: string) => runHardenedGit(args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${spec.integrationBranch}`], spec.repoPath);
  if (tip.status !== 0) throw new CoreError('conflict', 'the approved change is not in the private copy any more; nothing was delivered');
  const commit = String(tip.stdout ?? '').trim();
  const branch = `pandesh/chatgpt-${task.id.slice(-12)}`;
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], spec.codeCopy.sourcePath).status === 0) throw new CoreError('conflict', `your checkout already has a branch '${branch}'; nothing was overwritten`);
  const before = checkoutFingerprint(spec.codeCopy.sourcePath);
  const fetched = git(['fetch', '--no-tags', '--quiet', spec.repoPath, `refs/heads/${spec.integrationBranch}:refs/heads/${branch}`], spec.codeCopy.sourcePath);
  if (fetched.status !== 0) throw new CoreError('internal_error', `could not bring the change into your checkout: ${String(fetched.stderr ?? '').trim().slice(0, 200)}`);
  const after = checkoutFingerprint(spec.codeCopy.sourcePath);
  if (!before || !after || before.head !== after.head || before.statusSha !== after.statusSha) throw new CoreError('internal_error', 'your checkout changed while the branch was delivered; check it before using the branch');
  const delivered = { branch, commit, at: new Date().toISOString() };
  const withDelivery: BridgeTaskRecord = { ...task, result: { ...(task.result as BridgeTaskResult), codeChange: { project: spec.codeCopy.projectName, baseRef: spec.codeCopy.ref, delivered } } };
  const result: BridgeTaskResult = { ...withDelivery.result!, outcome: outcomeOf(rt.db, withDelivery, 'done', spec, task.result?.changedFiles ?? []) };
  recordBridgeStatus(rt.db, taskId, 'completed', `Delivered by ${who} as branch ${branch} in your checkout (not checked out, not merged, not pushed).`, result);
  return delivered;
}

/**
 * The owner does NOT approve a reviewed A5 change (host only; the route checks). Nothing is committed, integrated or delivered; the worker
 * is stopped and its worktree kept for reference. The task ends as cancelled with the reason, and its outcome says the change was refused.
 */
export async function rejectBridgeChange(rt: BridgeRuntime, taskId: string, who: string, note?: string): Promise<BridgeTaskRecord> {
  const { task, storyId, spec } = codeChangeOf(rt, taskId);
  if (task.control === 'cancelled' || task.status === 'cancelled' || getStory(rt.db, storyId).status !== 'delivery_approval') throw new CoreError('conflict', 'there is no change waiting for your review on this task');
  const why = note ? ` Note: ${note.replace(/\s+/g, ' ').slice(0, 300)}` : '';
  addComment(rt.db, storyId, { author: DEV_ACTOR, body: `[kkd-dev:review-denied] Not approved in Pandesh by ${who}. Nothing was committed, integrated or delivered.${why}` });
  setBridgeControl(rt.db, taskId, 'cancelled');
  await stopDevStory(rt.db, rt.kandev, storyId, `Change not approved by ${who}`).catch(() => { /* the worker is already idle; the decision stands */ });
  const outcome: BridgeTaskOutcome = { ...outcomeOf(rt.db, task, 'delivery_approval', spec, task.result?.changedFiles ?? []), state: 'review_denied', summary: `You did not approve the change to ${spec.codeCopy.projectName}. Nothing was committed, merged, pushed or delivered; the worker's worktree is kept for reference.${why}` };
  recordBridgeStatus(rt.db, taskId, 'cancelled', outcome.summary, { ...(task.result as BridgeTaskResult), outcome });
  return getBridgeTask(rt.db, taskId);
}

export async function pauseBridgeTask(rt: BridgeRuntime, taskId: string, who: string): Promise<BridgeTaskRecord> {
  const task = getBridgeTask(rt.db, taskId);
  if (!task.storyId) throw new CoreError('conflict', 'only tasks running on an ACP executor can be paused; cancel this one instead');
  if (task.control === 'paused') return task;
  if (!['running', 'awaiting_approval', 'verifying', 'needs_attention'].includes(task.status)) throw new CoreError('conflict', `task is ${task.status}; nothing to pause`);
  // Record the intent first so the state never disagrees with it while the worker shuts down; undo it if the stop fails.
  setBridgeControl(rt.db, taskId, 'paused');
  let res: Awaited<ReturnType<typeof stopDevStory>>;
  try { res = await stopDevStory(rt.db, rt.kandev, task.storyId, `Paused from the browser bridge by ${who}`); } catch (err) { setBridgeControl(rt.db, taskId, 'none'); throw err; }
  recordBridgeStatus(rt.db, taskId, 'paused', res.stillRunning.length ? 'Pause requested; the worker is still shutting down.' : 'Paused. Resume to continue from the preserved work.');
  return getBridgeTask(rt.db, taskId);
}

export async function resumeBridgeTask(rt: BridgeRuntime, taskId: string, who: string): Promise<BridgeTaskRecord> {
  const task = getBridgeTask(rt.db, taskId);
  if (task.control !== 'paused' || !task.storyId) throw new CoreError('conflict', 'only a paused task can be resumed');
  setBridgeControl(rt.db, taskId, 'none');
  try {
    await retryDevStory(rt.db, rt.kandev, task.storyId, `Resumed from the browser bridge by ${who}`);
  } catch (err) {
    // If the retry was recorded (the story is back to implementing) only the explicit session relaunch failed or was slow, e.g.
    // because the worker was paused while still starting. The coordinator's reconcile loop finishes that hand-off, so this is
    // a resume in progress, not a failure. If the retry was not recorded, nothing changed: stay paused and say why.
    if (getStory(rt.db, task.storyId).status !== 'implementing') { setBridgeControl(rt.db, taskId, 'paused'); throw err; }
    recordBridgeStatus(rt.db, taskId, 'running', 'Resumed; waiting for the worker to start.');
    return getBridgeTask(rt.db, taskId);
  }
  recordBridgeStatus(rt.db, taskId, 'running', 'Resumed from the preserved work.');
  return getBridgeTask(rt.db, taskId);
}

export async function cancelBridgeTask(rt: BridgeRuntime, taskId: string, who: string): Promise<BridgeTaskRecord> {
  const task = getBridgeTask(rt.db, taskId);
  if (task.status === 'cancelled' || task.status === 'completed') return task;
  setBridgeControl(rt.db, taskId, 'cancelled');
  activeServices.get(taskId)?.abort();
  if (task.storyId && task.projectId && missionOf(task).length > 1) {
    // Stop ends the development grant at once on every step, then stops the steps that are working or waiting.
    for (const s of missionStories(rt.db, task.projectId)) {
      if (s.status === 'done') continue;
      addComment(rt.db, s.id, { author: DEV_ACTOR, body: `${GRANT_REVOKED_TAG} Mission stopped by ${who}; the development grant no longer applies.` });
      if (['implementing', 'review', 'validation', 'delivery_approval', 'merge_queue'].includes(s.status)) await stopDevStory(rt.db, rt.kandev, s.id, `Mission cancelled by ${who}`).catch(() => { /* reported by the next refresh */ });
    }
  } else if (task.storyId) {
    const story = getStory(rt.db, task.storyId);
    if (['implementing', 'review', 'validation', 'delivery_approval', 'merge_queue'].includes(story.status)) {
      await stopDevStory(rt.db, rt.kandev, task.storyId, `Cancelled from the browser bridge by ${who}`);
    }
  } else if (task.attemptId) {
    const attempt = getAttempt(rt.db, task.attemptId);
    if (!isTerminalAttemptStatus(attempt.status)) {
      requestCancelAttempt(rt.db, task.attemptId, { actor: `panda-bridge:${who}`, clientId: 'panda-bridge' });
      rt.executor?.cancel(task.attemptId);
    }
  }
  recordBridgeStatus(rt.db, taskId, 'cancelled', 'Cancelled.');
  return getBridgeTask(rt.db, taskId);
}

const DISPATCH_STALE_MS = 3 * 60_000;
const BRIDGE_TASK_DEADLINE_MS = 30 * 60_000;

/** Background mirror: keeps every live relayed task current, so a result is stored even when no browser is watching. */
export function startPandaBridgeLoop(rt: BridgeRuntime, intervalMs = 5_000): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const t of listBridgeTasks(rt.db, { limit: 100 })) {
        // A dispatch claimed but never started (Core stopped in between) must not sit in "dispatching" forever.
        if (t.status === 'dispatching' && Date.now() - Date.parse(t.updatedAt) > DISPATCH_STALE_MS) {
          recordBridgeStatus(rt.db, t.id, 'failed', 'Starting the executor was interrupted. Start it again.');
          continue;
        }
        // A service task whose in-process run is gone (Core restarted) cannot finish: say so instead of showing it as running.
        if (t.status === 'running' && t.executor?.startsWith('service:') && !activeServices.has(t.id)) {
          recordBridgeStatus(rt.db, t.id, 'failed', 'Core restarted while this service was running. Start it again.');
          continue;
        }
        // Practical deadline: a tiny bridge job must not run indefinitely. Reuse the existing cancel path.
        // A mission runs as long as its development grant (several Claude steps take longer than one small bridge job).
        if (t.status === 'running' && Date.now() - Date.parse(t.createdAt) > (missionOf(t).length > 1 ? MISSION_GRANT_MS : BRIDGE_TASK_DEADLINE_MS)) {
          await cancelBridgeTask(rt, t.id, 'Pandesh (deadline)').catch(() => { /* best effort */ });
          continue;
        }
        if (['dispatching', 'running', 'awaiting_approval', 'verifying', 'needs_attention'].includes(t.status)) await refreshBridgeTask(rt, t.id).catch(() => { /* next tick */ });
      }
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}



/**
 * Before "Allow" is recorded: is the card the owner is looking at still true? The task text, its sensitivity, the shared-context flag and
 * the project, branch and commit it would copy must match the request. If anything changed, the request is withdrawn (not approved) and the
 * owner is told to ask again, so an approval can never describe something other than what would run.
 */
function assertCardStillAccurate(rt: BridgeRuntime, task: BridgeTaskRecord, requestId: string): void {
  const request = pendingApproval(rt.db, task.id);
  if (!request || request.requestId !== requestId) return; // decideApproval reports the missing/stale request itself
  const withdraw = (why: string): never => { withdrawApproval(rt.db, task.id, requestId, why); throw new CoreError('conflict', `${why} Nothing was sent. Ask again from the browser to see the new details.`, { reason: 'approval_scope_changed' }); };
  if (crypto.createHash('sha256').update(task.instruction).digest('hex') !== request.instructionSha256) withdraw('The task text changed since the card was shown.');
  if (task.sensitivity !== request.sensitivity) withdraw('The task\'s sensitivity changed since the card was shown.');
  if (task.contextConfirmed !== request.includeContext) withdraw('What conversation context is shared changed since the card was shown.');
  const shown = request.project;
  let intent: ProjectIntent | null = null;
  try { intent = gateProject(rt, task, { id: request.executor, label: request.agentLabel, kind: 'acp' } as BridgeExecutor); }
  catch { withdraw('The project this task refers to can no longer be resolved.'); }
  if (!shown && intent) withdraw(`The task now refers to the project '${intent!.project.name}', which the card did not show.`);
  if (shown) {
    if (!intent || intent.project.name !== shown.name) withdraw('The project changed since the card was shown.');
    if (intent!.project.access !== shown.access) withdraw(`The access level of '${shown.name}' changed since the card was shown.`);
    const now = previewInspection(intent!);
    if (now.branch !== shown.branch || now.commit !== shown.commit) withdraw(`'${shown.name}' moved from ${shown.branch} at ${shown.commit} to ${now.branch} at ${now.commit} since the card was shown.`);
  }
}

// ------------------------------------------------------------------ the owner's decision on an external-agent request

/**
 * The owner's decision, made in the Pandesh app. Approve: the task starts on exactly the approved agent, with exactly the approved scope.
 * Refuse: the task ends here. Nothing else is started in its place and no other executor is tried.
 */
export async function decideExternalApproval(rt: BridgeRuntime, taskId: string, input: { requestId: string; decision: 'approve' | 'refuse'; by: string; confidentialOverride?: boolean }): Promise<{ task: BridgeTaskRecord; started: boolean }> {
  const task = getBridgeTask(rt.db, taskId);
  if (task.control === 'cancelled' || TERMINAL_BRIDGE_STATUSES.has(task.status)) throw new CoreError('conflict', `task is ${task.status}`);
  if (input.decision === 'approve') assertCardStillAccurate(rt, task, input.requestId);
  const { request } = decideApproval(rt.db, { taskId, requestId: input.requestId, decision: input.decision, by: input.by, confidentialOverride: input.confidentialOverride });
  if (input.decision === 'refuse') {
    setBridgeControl(rt.db, taskId, 'cancelled');
    recordBridgeStatus(rt.db, taskId, 'cancelled', `You refused to send this task to ${request.agentLabel}. Nothing was sent, and no other executor was used.`);
    return { task: getBridgeTask(rt.db, taskId), started: false };
  }
  return dispatchBridgeTask(rt, taskId, {
    executor: request.executor, model: request.model, decidedBy: input.by, authority: 'host', approvalRequestId: request.requestId,
    consent: { externalTransfer: true, confidentialOverride: input.confidentialOverride === true, includeContext: request.includeContext },
  });
}
