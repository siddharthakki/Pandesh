/**
 * Runtime side of the Panda bridge: finds the executors installed on this PC, routes a relayed task to one, and keeps the
 * relayed task in step with the work.
 *
 * Nothing here re-implements execution. A relayed task becomes one ordinary development story and is dispatched through
 * the existing Kandev/ACP coordinator (core/runtime/kandev/devStories.ts), which already owns isolated worktrees,
 * approvals, independent verification, integration and restart recovery. Pandesh's own Windows capabilities run through the
 * ordinary request/attempt path. This module only chooses, gates (consent, confidentiality) and mirrors.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../../db/connection';
import { CoreError } from '../../domain/errors';
import { runHardenedGit } from '../../security/hardenedGit';
import { getStory } from '../../domain/stories';
import { getAttempt, requestCancelAttempt } from '../../domain/attempts';
import { isTerminalAttemptStatus } from '../../domain/attemptTransitions';
import { submitRequest } from '../../domain/submission';
import { newId } from '../../domain/ids';
import {
  attachBridgeExecution, claimBridgeDispatch, evaluateTransferPolicy, getBridgeTask, listBridgeTasks, recordBridgeStatus,
  setBridgeControl, TERMINAL_BRIDGE_STATUSES,
  type BridgeTaskRecord, type BridgeTaskResult, type BridgeTaskStatus, type BridgeTransferConsent,
} from '../../domain/pandaBridge';
import { detectGpu, gpuLaneLimit, type GpuInfo } from '../hardwareCapacity';
import type { RuntimeExecutor } from '../executor';
import { KandevClient, KandevUnavailableError } from './kandevClient';
import {
  AGENT_IDS, devSpec, devStoryDetail, dispatchDevStories, planDevStories, retryDevStory, stopDevStory, usesLocalGpu, type DevAgent,
} from './devStories';

export type BridgeExecutorId = DevAgent | 'native';

export interface BridgeExecutor {
  id: string;
  label: string;
  kind: 'acp' | 'native';
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
export async function discoverExecutors(kandev: KandevClient, opts: { nativeAvailable?: boolean } = {}): Promise<ExecutorListing> {
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

function workerDescription(task: BridgeTaskRecord, includeContext: boolean): string {
  const parts = [task.instruction];
  if (includeContext && task.contextText) {
    parts.push('', 'Conversation context the user chose to share (background only; the instruction above is the task):', task.contextText);
  }
  parts.push(
    '', 'Deliver working code in this repository together with automated tests using the Node.js built-in test runner',
    '(files named *.test.js; `npm test` runs them). Run the tests and make them pass before you stop.',
  );
  return parts.join('\n');
}

// ------------------------------------------------------------------ dispatch

export interface BridgeRuntime {
  db: CoreDatabase;
  kandev: KandevClient;
  dataDir: string;
  /** Runs Pandesh's own capabilities; absent on a Core without a runtime executor. */
  executor?: RuntimeExecutor;
}

export interface DispatchRequest {
  /** An executor id, or `auto`: Pandesh picks among *local* executors only. */
  executor: string;
  model?: string | null;
  consent?: BridgeTransferConsent;
  decidedBy: string;
  /** What the caller is allowed to authorise. An extension can never grant an external transfer. */
  authority: 'host' | 'extension';
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
export async function dispatchBridgeTask(rt: BridgeRuntime, taskId: string, req: DispatchRequest): Promise<{ task: BridgeTaskRecord; started: boolean }> {
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
    if (!decision.allowed) throw new CoreError('forbidden', decision.message, { reason: decision.code });
  }

  const listing = await discoverExecutors(rt.kandev, { nativeAvailable: Boolean(rt.executor) });
  let routing: 'explicit' | 'auto' = 'explicit';
  let chosen: BridgeExecutor | undefined;
  if (req.executor === 'auto') {
    // Automatic routing is only ever offered when the user selected it, and only among local executors.
    routing = 'auto';
    chosen = chooseAuto(listing) ?? undefined;
    if (!chosen) throw new CoreError('invalid_request', 'automatic routing found no available local executor; choose one explicitly');
  } else {
    chosen = listing.executors.find(e => e.id === req.executor);
    if (!chosen) throw new CoreError('invalid_request', `unknown executor '${req.executor}'`);
    if (!chosen.dispatchable) throw new CoreError('invalid_request', `${chosen.label}: ${chosen.reason}`);
    if (!chosen.available) throw new CoreError('conflict', `${chosen.label} is not available: ${chosen.reason ?? 'unavailable'}`);
  }
  const info = transferInfo(chosen.id, model);

  if (!claimBridgeDispatch(db, taskId, { executor: chosen.id, model, routing, consent: info.external ? (consent ?? null) : null, grantedBy: req.decidedBy })) {
    return { task: getBridgeTask(db, taskId), started: false };
  }
  const includeContext = task.contextConfirmed && (!info.external || consent?.includeContext === true);

  try {
    if (chosen.id === 'native') await startNative(rt, getBridgeTask(db, taskId));
    else await startAcp(rt, getBridgeTask(db, taskId), chosen.id as DevAgent, model, includeContext);
  } catch (err) {
    // Not started: hand the task back so the user can retry or pick another executor. A half-created story is reused on retry.
    const message = err instanceof Error ? err.message : String(err);
    recordBridgeStatus(db, taskId, 'failed', `Could not start ${chosen.label}: ${message}`.slice(0, 500));
    throw err;
  }
  return { task: getBridgeTask(db, taskId), started: true };
}

async function startAcp(rt: BridgeRuntime, task: BridgeTaskRecord, agent: DevAgent, model: string | null, includeContext: boolean): Promise<void> {
  const { db } = rt;
  let storyId = task.storyId;
  let projectId = task.projectId;
  let workspace = task.workspacePath;
  if (!storyId) {
    workspace = prepareTaskWorkspace(rt.dataDir, task.id);
    const title = task.instruction.replace(/\s+/g, ' ').trim().slice(0, 80);
    const plan = planDevStories(db, {
      projectName: 'Panda bridge',
      repoPath: workspace,
      baseBranch: 'main',
      integrationBranch: `panda/${task.id.slice(-12)}`,
      verify: ['npm', 'test'],
      stories: [{
        key: 'task', title, description: workerDescription(task, includeContext), agent, ...(model ? { model } : {}),
        acceptanceCriteria: ['The requested behaviour is implemented', 'Automated tests cover it and `npm test` passes'],
        acceptanceChecks: [{ kind: 'script', name: 'Tests exist and pass', source: TESTS_PRESENT_CHECK }],
      }],
    });
    storyId = plan.stories[0].id;
    projectId = plan.projectId;
    attachBridgeExecution(db, task.id, { projectId, storyId, workspacePath: workspace });
  }
  await dispatchWhenKandevIsReady(rt, projectId!, storyId, task.conversationId);
  recordBridgeStatus(db, task.id, 'running', `${KNOWN[agent].label} is working in an isolated workspace.`);
}

/**
 * Kandev answers its very first calls after a cold start with an empty error while it seeds its first workspace. Handing a
 * story over is idempotent (a Kandev task is bound to its story id), so wait a moment and try again instead of failing the task.
 */
async function dispatchWhenKandevIsReady(rt: BridgeRuntime, projectId: string, storyId: string, conversationId: string | null): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await dispatchDevStories(rt.db, rt.kandev, { projectId, storyIds: [storyId], conversationId });
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
  if (storyStatus === 'done') return { status: 'completed', detail: 'Finished and verified.' };
  if (phase === 'stopped') return control === 'cancelled' ? { status: 'cancelled', detail: 'Cancelled.' } : { status: 'paused', detail: 'Paused. Resume to continue from the preserved work.' };
  if (phase === 'needs approval') return { status: 'awaiting_approval', detail: 'The executor is waiting for your approval in Pandesh.' };
  if (phase === 'awaiting review') return { status: 'awaiting_approval', detail: 'The work is ready; review and approve it in Pandesh.' };
  if (phase === 'blocked') return { status: 'needs_attention', detail: 'The work needs your attention in Pandesh.' };
  if (phase === 'verifying' || phase === 'integrating' || phase.startsWith('turn finished')) return { status: 'verifying', detail: 'Verifying the result.' };
  if (phase === 'waiting') return { status: 'running', detail: 'Waiting for a free worker slot.' };
  return { status: 'running', detail: 'Working.' };
}

/** Brings a relayed task up to date from the work behind it and stores a checkpoint when something changed. */
export async function refreshBridgeTask(rt: BridgeRuntime, taskId: string): Promise<BridgeTaskRecord> {
  const { db } = rt;
  const task = getBridgeTask(db, taskId);
  if (TERMINAL_BRIDGE_STATUSES.has(task.status) || !['dispatching', 'running', 'awaiting_approval', 'verifying', 'paused', 'needs_attention'].includes(task.status)) return task;

  if (task.storyId) {
    const story = getStory(db, task.storyId);
    if (!devSpec(story)) return task;
    try {
      const detail = await devStoryDetail(db, rt.kandev, task.storyId);
      const view = detail.story;
      // Planned but not yet handed to Kandev: the dispatch in progress (or a failed one) owns the status, not the mirror.
      if (view.phase === 'not dispatched' || story.status === 'ready') return getBridgeTask(db, taskId);
      const mapped = mapPhase(view.phase, story.status, task.control);
      const result: BridgeTaskResult = {
        verification: view.verification,
        evidence: view.evidence ? redactPaths(view.evidence).slice(0, 3_000) : null,
        changedFiles: detail.changedFiles,
        commit: view.commit,
        pendingApprovals: view.pendingApprovals,
        // The worker's own commands and file names can carry local paths; none of them leave this PC.
        activity: view.activity.map(a => ({ ...a, text: redactPaths(a.text) })),
        timeline: detail.timeline.slice(-30),
      };
      // Where the coordinator names a concrete reason (a free slot, a review), show it; for settled states the mapped wording is clearer.
      const settled = mapped.status === 'paused' || mapped.status === 'cancelled' || mapped.status === 'completed';
      const detailText = !settled && view.waitingReason ? redactPaths(view.waitingReason).slice(0, 300) : mapped.detail;
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
    recordBridgeStatus(db, taskId, task.control === 'cancelled' && isTerminalAttemptStatus(attempt.status) ? 'cancelled' : status, detail);
  }
  return getBridgeTask(db, taskId);
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
  if (task.storyId) {
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
        if (['dispatching', 'running', 'awaiting_approval', 'verifying', 'needs_attention'].includes(t.status)) await refreshBridgeTask(rt, t.id).catch(() => { /* next tick */ });
      }
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

