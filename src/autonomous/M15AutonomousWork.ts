import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TaskStore } from '../agent/TaskStore';
import type { WorkspaceMutationLease } from '../coding/ExecutionIntegrity';
import type { HostBoundCodingProposal } from '../coding/WorkspaceMutation';
import type { CodingValidationCommand } from '../coding/CodingProposal';
import { WorkspaceHost, WorkspaceLease, GitWorktreeHost, WorkspaceHostFactory } from '../workspace/WorkspaceHost';
import { discoverWorkspaceRoot } from '../workspace/WorkspaceDiscovery';
import { UNBORN_HEAD_COMMIT } from '../orchestration/WorktreeManager';
import type { StageRoutingDecision } from '../coding/StageRouting';
import {
  classifyExecutionProfile,
  parseDeterministicFileWrite,
  type DeterministicFileWrite,
  type ExecutionProfile,
} from '../orchestration/ExecutionProfile';

const execFileAsync = promisify(execFile);

export const M15_TASK_SCHEMA_VERSION = 1 as const;
export const M15_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * Single shared, explicit limit for autonomous task `goal`/`instructions` text,
 * counted in UTF-8 bytes (Buffer.byteLength) so multi-byte punctuation and emoji
 * count consistently regardless of layer. Large enough for realistic multi-page
 * coding specifications. Over-limit input must be rejected before task creation,
 * never silently truncated.
 */
export const MAX_AUTONOMOUS_TASK_INPUT_BYTES = 40_000;

export function autonomousTaskInputUtf8ByteCount(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Thrown by {@link DurableTaskQueue.enqueue} when goal/instructions exceed the
 * shared input limit. Callers must show the user the current/allowed counts and
 * retain their draft text; the task is never partially created. */
export class AutonomousTaskInputTooLargeError extends Error {
  constructor(
    readonly field: 'goal' | 'instructions',
    readonly utf8ByteCount: number,
    readonly limitBytes: number = MAX_AUTONOMOUS_TASK_INPUT_BYTES,
  ) {
    super('autonomous_task_input_too_large');
  }
}

export interface AutonomousTaskInputIntegrity {
  submittedCharacterCount: number;
  persistedCharacterCount: number;
  submittedUtf8ByteCount: number;
  persistedUtf8ByteCount: number;
  /** sha256 hex digest of the persisted goal+instructions; bounded, content-free. */
  inputDigest: string;
  /** True when persisted text is byte-identical to submitted text (only security
   * control-character stripping, if any, can make this false). */
  inputPreserved: boolean;
}

function computeInputDigest(goal: string, instructions: string): string {
  return crypto.createHash('sha256').update(goal, 'utf8').update('␞', 'utf8').update(instructions, 'utf8').digest('hex');
}

/** Bounded, content-free integrity evidence describing a submitted/persisted task
 * text pair. Exported so the runtime can re-verify it on reload without recomputing
 * the hashing scheme inline. */
export function buildInputIntegrity(submittedGoal: string, submittedInstructions: string, persistedGoal: string, persistedInstructions: string): AutonomousTaskInputIntegrity {
  return {
    submittedCharacterCount: Array.from(submittedGoal).length + Array.from(submittedInstructions).length,
    persistedCharacterCount: Array.from(persistedGoal).length + Array.from(persistedInstructions).length,
    submittedUtf8ByteCount: autonomousTaskInputUtf8ByteCount(submittedGoal) + autonomousTaskInputUtf8ByteCount(submittedInstructions),
    persistedUtf8ByteCount: autonomousTaskInputUtf8ByteCount(persistedGoal) + autonomousTaskInputUtf8ByteCount(persistedInstructions),
    inputDigest: computeInputDigest(persistedGoal, persistedInstructions),
    inputPreserved: submittedGoal === persistedGoal && submittedInstructions === persistedInstructions,
  };
}

/** Recomputes the digest from a task's current persisted goal/instructions and
 * compares it against the digest recorded at enqueue time. A mismatch means the
 * persisted task text was altered after creation (disk corruption, manual edit,
 * partial write) and must block before graph execution. Tasks created before this
 * evidence existed (no `inputIntegrity`) are treated as verified for compatibility. */
export function verifyInputIntegrity(task: Pick<AutonomousTask, 'goal' | 'instructions' | 'inputIntegrity'>): boolean {
  if (!task.inputIntegrity) return true;
  return computeInputDigest(task.goal, task.instructions) === task.inputIntegrity.inputDigest;
}

export type AutonomousTaskOrigin =
  | 'local-request'
  | 'continued-session'
  | 'scheduled'
  | 'recurring'
  | 'github-issue'
  | 'retry'
  | 'review-comment';

export type AutonomousLifecycleState =
  | 'queued'
  | 'scheduled'
  | 'waiting_for_resources'
  | 'preparing'
  | 'waiting_for_approval'
  | 'running'
  | 'waiting_for_proposal_approval'
  | 'waiting_for_mutation_approval'
  | 'paused'
  | 'cancelling'
  | 'validating'
  | 'waiting_for_delivery_approval'
  | 'committing'
  | 'creating_pull_request'
  | 'monitoring_ci'
  | 'waiting_for_review'
  | 'updating_pull_request'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AutonomousPriority = 'low' | 'normal' | 'high' | 'urgent';
export type AutonomousTaskKind = 'read-only' | 'mutating';

/**
 * Task-Scoped Autonomy V1 — who resolves this task's ordinary Karke Dikha
 * proposal/mutation/delivery gates. `'supervised'` (default) is today's
 * unchanged behavior: every gate waits for an explicit user approval.
 * `'hands_off'` is an explicit, task-scoped authorization the user chooses
 * before the task starts — the task's own runtime auto-resolves those three
 * gates the instant each opens, through the exact same resolution machinery
 * and safety re-verification a user click would go through (see
 * `AutonomousTaskRuntime.autoAuthorizeGate` in M15AutonomousRuntime.ts).
 * Every other existing safeguard — LocalDeliveryService's dirty-workspace/
 * stale-baseline/worktree-identity checks, the bounded validation-repair
 * budget, deterministic diff review, cancellation — remains fully
 * authoritative and completely unchanged; only who calls the resolver
 * differs. Frozen once at task creation (see `DurableTaskQueue.enqueue`) and
 * never mutated afterward, so a later change to the user's global default
 * cannot retroactively alter an already-running task. This is deliberately
 * NOT threaded through Core's `AttemptContextRecord` — Core does not need to
 * know who calls its real `resolveApproval`, only that it was called.
 */
export type KarkeAutonomyMode = 'supervised' | 'hands_off';

export interface AutonomousSchedule {
  enabled: boolean;
  timezone: 'UTC';
  notBefore?: string;
  recurrence?: { kind: 'interval'; everyMs: number; maxOccurrences?: number };
  occurrence: number;
  overduePolicy: 'enqueue-on-activation' | 'skip';
  nextRunAt?: string;
}

export interface FollowUpInstruction {
  id: string;
  /** Client-generated idempotency key. Reusing it for this task returns the
   * original durable receipt instead of appending a second instruction. */
  messageId?: string;
  /** Monotonic per-task receipt order. Legacy records may omit it. */
  sequence?: number;
  content: string;
  createdAt: string;
  /** Scope-changing guidance supersedes approvals and delivery eligibility. */
  scopeChanging?: boolean;
  appliedAt?: string;
  appliedBoundary?: string;
}

export interface AppliedFollowUpBatch {
  effectiveGoal: string;
  instructions: FollowUpInstruction[];
}

export interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
  url?: string;
  title?: string;
}

export interface ValidationRequirement {
  command: string;
  required: boolean;
}

export interface DeliveryPolicy {
  requireApprovalBeforeCommit: boolean;
  requireApprovalBeforePullRequest: boolean;
  createDraftPullRequest: boolean;
  monitorCi: boolean;
  allowPrComments: boolean;
  retainSuccessfulWorktree: boolean;
}

export interface GitHubDeliveryState {
  transport: 'fake' | 'gh-cli';
  remote?: string;
  baseBranch?: string;
  branchPushed?: boolean;
  commitSha?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  draft?: boolean;
  ci?: CiStatus;
  review?: ReviewStatus;
}

export interface CiStatus {
  state: 'unknown' | 'pending' | 'success' | 'failure' | 'cancelled' | 'action-required' | 'unavailable';
  failedChecks: Array<{ name: string; summary: string }>;
  observedAt: string;
}

export interface ReviewStatus {
  state: 'unknown' | 'waiting' | 'approved' | 'changes-requested' | 'commented';
  unresolvedComments: number;
  comments: ReviewComment[];
  observedAt: string;
}

export interface ReviewComment {
  id: string;
  author?: string;
  isBot?: boolean;
  path?: string;
  line?: number;
  body: string;
}

export interface AutonomousTask {
  schemaVersion: typeof M15_TASK_SCHEMA_VERSION;
  taskId: string;
  attemptId: string;
  origin: AutonomousTaskOrigin;
  taskKind: AutonomousTaskKind;
  repositoryRoot: string;
  repositoryId: string;
  sourceIssue?: GitHubIssueRef;
  goal: string;
  instructions: string;
  priority: AutonomousPriority;
  createdAt: string;
  scheduledAt?: string;
  schedule?: AutonomousSchedule;
  state: AutonomousLifecycleState;
  attempt: number;
  maxRetries: number;
  m13RunId?: string;
  branchName?: string;
  /**
   * The destination branch in the primary workspace repository (e.g. 'main')
   * where verified delivery commits are applied.
   * Distinct from `branchName`, which is the dedicated isolated worktree task branch (e.g. 'forge/att_...').
   */
  destinationBranch?: string;
  /**
   * Full HEAD SHA of the target repository captured once, at task creation
   * (`git rev-parse HEAD`). Historical "at start" fact: paired with
   * `destinationBranch` it backs the Details "Branch / HEAD" row and is never
   * refreshed from later workspace state or overwritten by delivery.
   */
  repositoryHeadAtStart?: string;
  worktreeLocation?: string;
  worktreeBaseCommit?: string;
  /**
   * Unified Conversation V1 — the narrow, cryptographically-verified set of
   * currently tracked-dirty workspace paths this task is authorized to
   * build on top of, because every one of them is exactly and durably
   * attributable to an approved Saath Kar mutation from THIS SAME
   * conversation (see src/orchestration/TrustedDirtyProvenance.ts). Computed
   * once at task creation; seeded into the isolated worktree
   * (WorktreeManager.createLease's `seedFiles`) and re-verified against
   * current bytes again at delivery time (LocalDeliveryService). Absent for
   * any task not created alongside a verified trusted-dirty workspace —
   * which is the overwhelming majority of tasks — and for any task whose
   * dirty workspace did not fully verify (that task simply has no baseline,
   * and today's unmodified `workspace_dirty` block still applies at delivery).
   */
  trustedDirtyBaseline?: Array<{ path: string; sha256: string; approvalId: string; content: string }>;
  providerModelRoutingSnapshot: Record<string, string>;
  /** Authoritative workflow-depth decision persisted with the exact goal. */
  executionProfile?: ExecutionProfile;
  /** Exact host-derived proposal input. Its presence never bypasses approvals. */
  deterministicProposal?: DeterministicFileWrite;
  permissionProfile: 'normal' | 'readonly';
  /** Task-Scoped Autonomy V1 — see {@link KarkeAutonomyMode}. Absent on tasks
   * persisted before this field existed; every read site defaults with
   * `task.autonomyMode ?? 'supervised'`, preserving prior behavior exactly,
   * following the same pattern already established for `instructionRevision`/
   * `inputIntegrity`/`diffReview.reviewedDiffFingerprint` in this file. */
  autonomyMode?: KarkeAutonomyMode;
  validationRequirements: ValidationRequirement[];
  /** Exact approved validation commands rerun after delivery against the
   * materialized state that will be reported as complete. Persisted before
   * the delivery gate so restart/re-approval cannot lose the contract. */
  deliveryValidation?: {
    commands: CodingValidationCommand[];
    status: 'pending' | 'passed' | 'failed';
    root?: string;
    results?: Array<{
      command: string;
      exitCode: number | null;
      timedOut: boolean;
      durationMs: number;
      outputTail?: string;
    }>;
    verifiedAt?: string;
  };
  deliveryPolicy: DeliveryPolicy;
  notificationPolicy: { enabled: boolean; persisted: boolean };
  githubDelivery: GitHubDeliveryState;
  latestProgress?: string;
  terminalResult?: { status: 'completed' | 'failed' | 'cancelled'; summary: string };
  failure?: {
    classification: string;
    message: string;
    at: string;
    /** M42: the recovery control plane's terminal state for this stop, when it made the decision. */
    recovery?: { terminalState: string; cause?: string; subcode?: string; decisionSeq: number };
  };
  validationFailure?: {
    commandLabel: string;
    exitCode: number | null;
    durationMs: number;
    stdoutStderrTail: string;
    failingStage: 'validation';
    worktree: string;
    retryAvailable: boolean;
    timedOut: boolean;
  };
  graphFailureEvidence?: Record<string, unknown>;
  qualityGate?: { gateId: string; runId: string; status: string; findingsCount: number; decidedAt: string };
  /** Phase 5 — independent post-implementation actual-diff review, run after
   * deterministic validation and the M16 gate, before delivery approval.
   * Distinct from the pre-mutation proposal reviewer. Only `verdict: 'pass'`
   * allows the transition to `waiting_for_delivery_approval`. */
  diffReview?: {
    verdict: 'pass' | 'reject';
    requirementFindings: string[];
    changedFileFindings: string[];
    validationFindings: string[];
    securityFindings: string[];
    objectiveRelevanceFindings: string[];
    explanation: string;
    reviewerProvider: string;
    reviewerModel: string;
    decidedAt: string;
    /** Approved operation scope used for this review, persisted so Phase 7
     * commit-time reconciliation in `approveDelivery()` can re-check the
     * real worktree against the same approved paths without re-deriving
     * them from a proposal object that is no longer in memory. */
    approvedScopePaths: string[];
    /** Phase 7 — sha256 fingerprint of the exact `git diff HEAD` text this
     * review verdict was decided against (see `fingerprintReviewedDiff`).
     * Commit-time reconciliation regenerates the actual diff immediately
     * before `git add` and rejects if it no longer matches, even when the
     * changed-file paths themselves are unchanged (e.g. an approved file
     * edited again after review). Absent on tasks persisted before this
     * field existed; those are treated as unverifiable-but-not-rejected by
     * path-scope reconciliation alone, preserving prior behavior. */
    reviewedDiffFingerprint?: string;
    /** Durable steering revision whose mutation/validation evidence was
     * reviewed. Delivery must reject a verdict from any older revision. */
    instructionRevision?: number;
  };
  /** Host-verified repository mutation evidence captured before validation.
   * This is revision-bound so stale work cannot become delivery-eligible
   * after steering changes the effective instruction. */
  mutationEvidence?: {
    instructionRevision: number;
    expectedPaths: string[];
    changedPaths: string[];
    contentVerified: boolean;
    gitDiffPresent: boolean;
    alreadySatisfied: boolean;
    verifiedAt: string;
  };
  /** Phase 6 — explicit stage routing provenance, keyed by stage name. Records
   * which provider/model actually executed each stage, why it was routed
   * there, and (when a preferred model candidate was unavailable) why the
   * stage fell back to a deterministic host. See `src/coding/StageRouting.ts`.
   * Only stages that have actually run so far have an entry. */
  stageRouting?: Record<string, StageRoutingDecision>;
  followUps: FollowUpInstruction[];
  /** Highest durably received steering sequence. Used as a delivery fence. */
  instructionRevision?: number;
  /** Original goal plus every durably applied steering instruction, in
   * monotonic receipt order. This is persisted in the same atomic task write
   * that marks those instructions applied. */
  effectiveGoal?: string;
  claim?: { owner: string; leaseUntil: string; heartbeatAt: string };
  evidence: string[];
  inputIntegrity?: AutonomousTaskInputIntegrity;
  /** Current coding-proposal version for this task; increments once per
   * revision requested through the in-chat proposal approval gate. */
  proposalVersion?: number;
  /** Bounded, non-sensitive summary of the proposal currently awaiting
   * in-chat approval. Cleared once the pending gate is resolved. Never
   * includes file content. */
  pendingProposal?: PendingProposalSummary;
  /** Internal restart checkpoint for the exact host-bound proposal behind
   * `pendingProposal`. Unlike the bounded webview summary, this retains the
   * operation payload and snapshots needed to continue after approval without
   * regenerating a second proposal. It is never projected into the approval
   * card or sent to Core as approval-summary metadata. */
  proposalRestartCheckpoint?: HostBoundCodingProposal;
  /** Bounded, non-sensitive summary of the mutation approval currently
   * awaiting in-chat resolution. Cleared once the pending gate is resolved. */
  pendingMutationApproval?: PendingMutationSummary;
  /** Bounded automatic validation repairs performed inside this one attempt. */
  validationRepairAttempts?: number;
}

export interface PendingProposalSummary {
  proposalId: string;
  version: number;
  instructionRevision?: number;
  taskSummary: string;
  operations: Array<{ type: string; path: string; reason: string }>;
  validationCommands: Array<{ kind: string; script?: string }>;
  warnings: string[];
}

export interface PendingMutationSummary {
  requestId: string;
  proposalId: string;
  instructionRevision?: number;
  operationCount: number;
  targets: string[];
  elevatedConfirmationRequired: boolean;
  repairPolicy?: {
    maxCycles: number;
    allowedPaths: string[];
    validationCommands: Array<{ kind: string; script?: string; args?: string[] }>;
  };
}

export interface AutonomousTaskEvent {
  schemaVersion: typeof M15_EVENT_SCHEMA_VERSION;
  eventId: string;
  taskId: string;
  seq: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

const TERMINAL_STATES = new Set<AutonomousLifecycleState>(['completed', 'failed', 'cancelled']);
const ACTIVE_MUTATING_STATES = new Set<AutonomousLifecycleState>([
  'waiting_for_resources',
  'preparing',
  'waiting_for_approval',
  'running',
  'waiting_for_proposal_approval',
  'waiting_for_mutation_approval',
  'validating',
  'waiting_for_delivery_approval',
  'committing',
  'creating_pull_request',
  'monitoring_ci',
  'waiting_for_review',
  'updating_pull_request',
  'paused',
  'cancelling',
]);

const VALID_TRANSITIONS: Record<AutonomousLifecycleState, AutonomousLifecycleState[]> = {
  queued: ['scheduled', 'waiting_for_resources', 'preparing', 'paused', 'cancelling', 'cancelled'],
  scheduled: ['queued', 'waiting_for_resources', 'paused', 'cancelling', 'cancelled'],
  waiting_for_resources: ['preparing', 'queued', 'paused', 'cancelling', 'cancelled'],
  preparing: ['waiting_for_approval', 'running', 'blocked', 'failed', 'cancelling'],
  waiting_for_approval: ['running', 'paused', 'blocked', 'cancelling', 'cancelled'],
  running: ['paused', 'validating', 'blocked', 'failed', 'cancelling', 'cancelled', 'waiting_for_proposal_approval', 'waiting_for_mutation_approval'],
  waiting_for_proposal_approval: ['running', 'blocked', 'failed', 'cancelling', 'cancelled'],
  waiting_for_mutation_approval: ['running', 'blocked', 'failed', 'cancelling', 'cancelled'],
  paused: ['queued', 'waiting_for_resources', 'running', 'cancelling', 'cancelled'],
  cancelling: ['cancelled', 'failed'],
  validating: ['waiting_for_delivery_approval', 'committing', 'blocked', 'failed', 'cancelling'],
  waiting_for_delivery_approval: ['committing', 'paused', 'blocked', 'cancelling', 'cancelled'],
  committing: ['creating_pull_request', 'monitoring_ci', 'completed', 'blocked', 'failed', 'cancelling'],
  creating_pull_request: ['monitoring_ci', 'waiting_for_review', 'completed', 'blocked', 'failed', 'cancelling'],
  monitoring_ci: ['waiting_for_review', 'completed', 'blocked', 'failed', 'cancelling'],
  waiting_for_review: ['updating_pull_request', 'completed', 'blocked', 'failed', 'cancelling'],
  updating_pull_request: ['validating', 'committing', 'monitoring_ci', 'blocked', 'failed', 'cancelling'],
  blocked: ['queued', 'paused', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Read-only check mirroring `DurableTaskQueue.transition()`'s own validation, so
 * call sites that cannot afford an uncaught throw (e.g. a UI command handler) can
 * fail safe with a friendly message instead of letting an invalid transition
 * propagate as an unhandled rejection. */
export function isValidAutonomousTransition(from: AutonomousLifecycleState, to: AutonomousLifecycleState): boolean {
  if (TERMINAL_STATES.has(from)) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeText(value: string, limit = 1200): string {
  return value
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function applyFollowUpToEffectiveGoal(goal: string, followUp: FollowUpInstruction): string {
  const replacement = /\buse\s+([\w./\\-]+\.[a-z0-9]+)\s+instead\b/i.exec(followUp.content)?.[1];
  if (replacement && /[\w./\\-]+\.[a-z0-9]+/i.test(goal)) {
    return goal.replace(/[\w./\\-]+\.[a-z0-9]+/i, replacement);
  }
  return `${goal}\n\nSteering guidance from the user:\n[${followUp.sequence ?? '?'}] ${followUp.content}`;
}

/**
 * Non-truncating, structure-preserving sanitization for full task `goal`/
 * `instructions` content: strips ANSI escape sequences and non-printable control
 * characters (defense against terminal/log injection) but keeps every printable
 * character, all newlines (LF and CRLF), tabs, and Markdown structure intact. Never
 * collapses whitespace and never slices — the caller enforces the input-size limit
 * separately and rejects rather than truncates.
 */
function sanitizeTaskContent(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function safeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function priorityRank(priority: AutonomousPriority): number {
  switch (priority) {
    case 'urgent': return 3;
    case 'high': return 2;
    case 'normal': return 1;
    case 'low': return 0;
  }
}

export function taskDir(root: string, taskId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) {
    throw new Error(`Invalid autonomous task id: ${taskId}`);
  }
  return path.join(root, '.ollama-agent', 'autonomous-tasks', taskId);
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  const retryDelaysMs = process.platform === 'win32' ? [0, 10, 25, 50, 100] : [0];
  let lastError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      await fs.rename(temporary, filePath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw error;
    }
  }
  await fs.rm(temporary, { force: true }).catch(() => undefined);
  throw lastError;
}

export class DurableTaskQueue {
  private readonly terminalListeners = new Set<(task: AutonomousTask) => void | Promise<void>>();

  private static readonly claimLocks = new Map<string, Promise<void>>();
  private static readonly eventLocks = new Map<string, Promise<void>>();
  private static readonly taskLocks = new Map<string, Promise<void>>();
  constructor(private readonly repositoryRoot: string) {}

  async enqueue(input: Omit<AutonomousTask, 'schemaVersion' | 'taskId' | 'attemptId' | 'createdAt' | 'state' | 'attempt' | 'followUps' | 'evidence'> & { taskId?: string; attemptId?: string }): Promise<AutonomousTask> {
    const goalByteCount = autonomousTaskInputUtf8ByteCount(input.goal);
    if (goalByteCount > MAX_AUTONOMOUS_TASK_INPUT_BYTES) {
      throw new AutonomousTaskInputTooLargeError('goal', goalByteCount);
    }
    const instructionsByteCount = autonomousTaskInputUtf8ByteCount(input.instructions);
    if (instructionsByteCount > MAX_AUTONOMOUS_TASK_INPUT_BYTES) {
      throw new AutonomousTaskInputTooLargeError('instructions', instructionsByteCount);
    }
    const persistedGoal = sanitizeTaskContent(input.goal);
    const persistedInstructions = sanitizeTaskContent(input.instructions);
    const executionProfile = classifyExecutionProfile(persistedGoal);
    const deterministicProposal = executionProfile.useDeterministicProposal
      ? parseDeterministicFileWrite(persistedGoal)
      : undefined;
    const createdAt = nowIso();
    const task: AutonomousTask = {
      schemaVersion: M15_TASK_SCHEMA_VERSION,
      taskId: input.taskId ?? safeId('m15'),
      attemptId: input.attemptId ?? safeId('attempt'),
      createdAt,
      state: input.scheduledAt ? 'scheduled' : 'queued',
      attempt: 1,
      followUps: [],
      evidence: [],
      ...input,
      goal: persistedGoal,
      instructions: persistedInstructions,
      executionProfile,
      deterministicProposal,
      inputIntegrity: buildInputIntegrity(input.goal, input.instructions, persistedGoal, persistedInstructions),
    };
    await this.writeTask(task);
    await this.appendEvent(task.taskId, 'task_queued', { state: task.state, origin: task.origin });
    return task;
  }

  async get(taskId: string): Promise<AutonomousTask | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(taskDir(this.repositoryRoot, taskId), 'task.json'), 'utf8')) as AutonomousTask;
      if (parsed.schemaVersion !== M15_TASK_SCHEMA_VERSION) {
        throw new Error(`Unsupported M15 task schema: ${parsed.schemaVersion}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<AutonomousTask[]> {
    const root = path.join(this.repositoryRoot, '.ollama-agent', 'autonomous-tasks');
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const tasks: AutonomousTask[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const task = await this.get(entry.name);
      if (task) tasks.push(task);
    }
    tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return tasks;
  }

  /** Rebuilds missing/stale routing from the exact durable goal. No caller may
   * inject a preclassified profile or proposal through this boundary. */
  async resolveExecutionRouting(taskId: string, goal?: string): Promise<AutonomousTask> {
    return this.withTaskLock(taskId, async () => {
      const task = await this.require(taskId);
      const exactGoal = goal ?? task.effectiveGoal ?? task.goal;
      const executionProfile = classifyExecutionProfile(exactGoal);
      const deterministicProposal = executionProfile.useDeterministicProposal
        ? parseDeterministicFileWrite(exactGoal)
        : undefined;
      const updated = { ...task, executionProfile, deterministicProposal };
      await this.writeTask(updated);
      await this.appendEvent(taskId, 'execution_routing_resolved', {
        tier: executionProfile.tier,
        maxStages: executionProfile.maxStages,
        deterministicExtraction: executionProfile.deterministicExtraction.status,
        deterministicReason: executionProfile.deterministicExtraction.reason,
      });
      return updated;
    });
  }

  async transition(taskId: string, nextState: AutonomousLifecycleState, payload: Record<string, unknown> = {}): Promise<AutonomousTask> {
    const updated = await this.withTaskLock(taskId, async () => {
      const task = await this.require(taskId);
      if (TERMINAL_STATES.has(task.state)) {
        throw new Error(`Terminal autonomous task cannot transition from ${task.state} to ${nextState}.`);
      }
      if (!VALID_TRANSITIONS[task.state].includes(nextState)) {
        throw new Error(`Invalid autonomous task transition: ${task.state} -> ${nextState}.`);
      }
      const updated = { ...task, state: nextState };
      await this.writeTask(updated);
      await this.appendEvent(taskId, 'state_transition', { from: task.state, to: nextState, ...payload });
      return updated;
    });
    if (TERMINAL_STATES.has(updated.state)) this.publishTerminal(updated);
    return updated;
  }

  /**
   * Publishes a terminal task only after its task record and transition event
   * are durable. This is an in-process host lifecycle signal, not a second
   * source of truth: reconnect/reload still reads the persisted queue.
   */
  onTerminal(listener: (task: AutonomousTask) => void | Promise<void>): { dispose(): void } {
    this.terminalListeners.add(listener);
    return { dispose: () => this.terminalListeners.delete(listener) };
  }

  private publishTerminal(task: AutonomousTask): void {
    for (const listener of this.terminalListeners) {
      void Promise.resolve(listener(task)).catch(() => undefined);
    }
  }

  async claimNext(owner: string, leaseMs: number, now = new Date()): Promise<AutonomousTask | undefined> {
    return this.withLock(DurableTaskQueue.claimLocks, this.repositoryRoot, () => this.claimNextLocked(owner, leaseMs, now));
  }

  private async claimNextLocked(owner: string, leaseMs: number, now: Date): Promise<AutonomousTask | undefined> {
    const tasks = await this.list();
    const eligible = tasks
      .filter(task => !TERMINAL_STATES.has(task.state))
      .filter(task => task.state === 'queued' || task.state === 'scheduled' || task.state === 'waiting_for_resources')
      .filter(task => !task.claim || Date.parse(task.claim.leaseUntil) <= now.getTime())
      .filter(task => !task.scheduledAt || Date.parse(task.scheduledAt) <= now.getTime())
      .sort((left, right) =>
        priorityRank(right.priority) - priorityRank(left.priority) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.taskId.localeCompare(right.taskId));
    const task = eligible[0];
    if (!task) return undefined;
    const claimed: AutonomousTask = {
      ...task,
      claim: {
        owner,
        heartbeatAt: now.toISOString(),
        leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
      },
    };
    await this.writeTask(claimed);
    await this.appendEvent(task.taskId, 'task_claimed', { owner, leaseUntil: claimed.claim?.leaseUntil });
    return claimed;
  }

  async heartbeat(taskId: string, owner: string, leaseMs: number): Promise<void> {
    await this.withTaskLock(taskId, async () => {
      const task = await this.require(taskId);
      if (task.claim?.owner !== owner) throw new Error(`Task ${taskId} is not claimed by ${owner}.`);
      const now = Date.now();
      await this.writeTask({
        ...task,
        claim: { owner, heartbeatAt: new Date(now).toISOString(), leaseUntil: new Date(now + leaseMs).toISOString() },
      });
      await this.appendEvent(taskId, 'task_heartbeat', { owner, leaseUntil: new Date(now + leaseMs).toISOString() });
    });
  }

  async releaseClaim(taskId: string, owner: string): Promise<void> {
    await this.withTaskLock(taskId, async () => {
      const task = await this.require(taskId);
      if (task.claim?.owner !== owner) return;
      const released: AutonomousTask = { ...task };
      delete released.claim;
      await this.writeTask(released);
      await this.appendEvent(taskId, 'task_claim_released', { owner });
    });
  }

  async requestCancellation(taskId: string): Promise<void> {
    await this.withTaskLock(taskId, async () => {
      const task = await this.require(taskId);
      if (TERMINAL_STATES.has(task.state)) return;
      await this.writeTask({ ...task, state: 'cancelling' });
      await this.appendEvent(taskId, 'cancellation_requested', {});
    });
  }

  async addFollowUp(
    taskId: string,
    content: string,
    options: { messageId?: string; scopeChanging?: boolean } = {},
  ): Promise<FollowUpInstruction> {
    return this.withTaskLock(taskId, async () => {
      const task = await this.require(taskId);
      if (TERMINAL_STATES.has(task.state)) {
        throw new Error(`Terminal autonomous task cannot receive follow-up guidance (${task.state}).`);
      }
      const messageId = options.messageId?.trim();
      if (messageId) {
        const existing = task.followUps.find(item => item.messageId === messageId);
        if (existing) return existing;
      }
      const normalized = sanitizeText(content, 2000);
      if (!normalized) throw new Error('follow_up_content_required');
      const sequence = task.followUps.reduce(
        (highest, item, index) => Math.max(highest, item.sequence ?? index + 1),
        0,
      ) + 1;
      const followUp: FollowUpInstruction = {
        id: safeId('followup'),
        messageId: messageId || undefined,
        sequence,
        content: normalized,
        createdAt: nowIso(),
        scopeChanging: options.scopeChanging ?? false,
      };
      await this.writeTask({
        ...task,
        instructionRevision: sequence,
        followUps: [...task.followUps, followUp],
      });
      await this.appendEvent(taskId, 'follow_up_received', {
        followUpId: followUp.id,
        messageId: followUp.messageId ?? '',
        sequence,
        scopeChanging: followUp.scopeChanging ?? false,
      });
      return followUp;
    });
  }

  async markFollowUpApplied(taskId: string, followUpId: string): Promise<void> {
    await this.applyPendingFollowUps(taskId, 'legacy', [followUpId]);
  }

  /**
   * Atomically folds pending guidance into the persisted effective goal and
   * marks the same ordered instructions applied. A restart can therefore see
   * either the old goal and pending receipt, or the new goal and applied
   * receipt, never a half-applied instruction.
   */
  async applyPendingFollowUps(
    taskId: string,
    boundary: string,
    onlyIds?: readonly string[],
  ): Promise<AppliedFollowUpBatch> {
    return this.withTaskLock(taskId, async () => {
      const task = await this.require(taskId);
      const selected = task.followUps
        .filter(item => !item.appliedAt && (!onlyIds || onlyIds.includes(item.id)))
        .sort((left, right) =>
          (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
          || left.createdAt.localeCompare(right.createdAt)
          || left.id.localeCompare(right.id));
      if (selected.length === 0) {
        return { effectiveGoal: task.effectiveGoal ?? task.goal, instructions: [] };
      }
      const appliedAt = nowIso();
      const selectedIds = new Set(selected.map(item => item.id));
      const baseGoal = task.effectiveGoal ?? task.goal;
      const effectiveGoal = selected.reduce(applyFollowUpToEffectiveGoal, baseGoal);
      const executionProfile = classifyExecutionProfile(effectiveGoal);
      const deterministicProposal = executionProfile.useDeterministicProposal
        ? parseDeterministicFileWrite(effectiveGoal)
        : undefined;
      await this.writeTask({
        ...task,
        effectiveGoal,
        executionProfile,
        deterministicProposal,
        followUps: task.followUps.map(item => selectedIds.has(item.id)
          ? { ...item, appliedAt, appliedBoundary: sanitizeText(boundary, 120) }
          : item),
      });
      for (const item of selected) {
        await this.appendEvent(taskId, 'follow_up_applied', {
          followUpId: item.id,
          messageId: item.messageId ?? '',
          sequence: item.sequence ?? 0,
          boundary,
        });
      }
      return {
        effectiveGoal,
        instructions: selected.map(item => ({ ...item, appliedAt, appliedBoundary: boundary })),
      };
    });
  }

  async recordProgress(taskId: string, progress: string): Promise<void> {
    await this.withTaskLock(taskId, async () => {
      const task = await this.require(taskId);
      await this.writeTask({ ...task, latestProgress: sanitizeText(progress, 500) });
      await this.appendEvent(taskId, 'progress', { progress });
    });
  }

  /** Appends a durable event without touching the task record (used for observe-only telemetry). */
  async recordEvent(taskId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.appendEvent(taskId, type, payload);
  }

  async update(task: AutonomousTask, eventType: string, payload: Record<string, unknown> = {}): Promise<AutonomousTask> {
    return this.withTaskLock(task.taskId, async () => {
      const latest = await this.require(task.taskId);
      const updated = {
        ...latest,
        ...task,
        // Never let an update constructed from an earlier read erase a
        // durable follow-up receipt or move its revision backwards.
        followUps: latest.followUps,
        instructionRevision: Math.max(latest.instructionRevision ?? 0, task.instructionRevision ?? 0) || undefined,
        effectiveGoal: latest.effectiveGoal ?? task.effectiveGoal,
        executionProfile: latest.executionProfile ?? task.executionProfile,
        deterministicProposal: latest.executionProfile
          ? latest.deterministicProposal
          : task.deterministicProposal,
      };
      await this.writeTask(updated);
      await this.appendEvent(task.taskId, eventType, payload);
      return updated;
    });
  }

  async events(taskId: string): Promise<AutonomousTaskEvent[]> {
    const file = path.join(taskDir(this.repositoryRoot, taskId), 'events.jsonl');
    try {
      const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
      return lines.map(line => JSON.parse(line) as AutonomousTaskEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async eventsAfter(taskId: string, afterSeq = 0): Promise<AutonomousTaskEvent[]> {
    return (await this.events(taskId)).filter(event => event.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  }

  async recoverOnActivation(owner: string): Promise<Array<{ taskId: string; action: string }>> {
    const actions: Array<{ taskId: string; action: string }> = [];
    for (const task of await this.list()) {
      if (TERMINAL_STATES.has(task.state)) continue;
      if (task.state === 'cancelling') {
        await this.update({ ...task, state: 'cancelled', terminalResult: { status: 'cancelled', summary: 'Cancelled during activation recovery.' } }, 'task_cancelled', {});
        actions.push({ taskId: task.taskId, action: 'cancelled' });
        continue;
      }
      const uncertain = ['preparing', 'running', 'validating', 'committing', 'creating_pull_request', 'updating_pull_request'].includes(task.state);
      if (uncertain) {
        await this.update({ ...task, state: 'blocked', failure: { classification: 'recovery_required', message: 'Interrupted state requires explicit resume.', at: nowIso() } }, 'task_blocked', { owner });
        actions.push({ taskId: task.taskId, action: 'blocked' });
        continue;
      }
      if (task.state === 'scheduled' && task.scheduledAt && Date.parse(task.scheduledAt) <= Date.now()) {
        await this.transition(task.taskId, 'queued', { reason: 'overdue_on_activation' });
        actions.push({ taskId: task.taskId, action: 'queued-overdue' });
      }
    }
    return actions;
  }

  private async require(taskId: string): Promise<AutonomousTask> {
    const task = await this.get(taskId);
    if (!task) throw new Error(`Autonomous task not found: ${taskId}`);
    return task;
  }

  private async writeTask(task: AutonomousTask): Promise<void> {
    await atomicWrite(path.join(taskDir(this.repositoryRoot, task.taskId), 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  }

  private withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    return this.withLock(
      DurableTaskQueue.taskLocks,
      `${this.repositoryRoot}:${taskId}`,
      action,
    );
  }

  private async appendEvent(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.withLock(DurableTaskQueue.eventLocks, `${this.repositoryRoot}:${taskId}`, async () => {
      const existing = await this.events(taskId);
      const seq = existing.reduce((highest, event) => Math.max(highest, event.seq), 0) + 1;
      const event: AutonomousTaskEvent = {
        schemaVersion: M15_EVENT_SCHEMA_VERSION,
        eventId: `${taskId}:${seq}`,
        taskId,
        seq,
        type,
        timestamp: nowIso(),
        payload: sanitizeRecord(payload),
      };
      const file = path.join(taskDir(this.repositoryRoot, taskId), 'events.jsonl');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  private async withLock<T>(locks: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(key) === queued) locks.delete(key);
    }
  }
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = typeof item === 'string' ? sanitizeText(item, 1000) : item;
  }
  return out;
}

export class TaskScheduler {
  static calculateNextRun(schedule: AutonomousSchedule, from = new Date()): string | undefined {
    if (!schedule.enabled || !schedule.recurrence) return undefined;
    const every = schedule.recurrence.everyMs;
    if (!Number.isInteger(every) || every < 60_000) throw new Error('Recurring schedule interval must be at least 60000ms.');
    if (schedule.recurrence.maxOccurrences !== undefined && schedule.occurrence >= schedule.recurrence.maxOccurrences) return undefined;
    return new Date(from.getTime() + every).toISOString();
  }
}

export class TaskResourceScheduler {
  private readonly active = new Map<string, AutonomousTask>();

  constructor(private readonly limits: { maxActiveTasks: number; maxActiveMutatingTasks: number; modelConcurrency: Record<string, number> }) {}

  canStart(task: AutonomousTask): { ok: boolean; reason?: string } {
    if (this.active.size >= this.limits.maxActiveTasks) return { ok: false, reason: 'max-active-tasks' };
    if (task.taskKind === 'mutating') {
      const mutating = [...this.active.values()].filter(item => item.taskKind === 'mutating');
      if (mutating.length >= this.limits.maxActiveMutatingTasks) return { ok: false, reason: 'max-mutating-tasks' };
      if (mutating.some(item => item.repositoryId === task.repositoryId)) return { ok: false, reason: 'repository-mutation-exclusive' };
    }
    const model = task.providerModelRoutingSnapshot['model'] ?? 'default';
    const limit = this.limits.modelConcurrency[model] ?? this.limits.modelConcurrency['*'] ?? 1;
    const activeForModel = [...this.active.values()].filter(item => (item.providerModelRoutingSnapshot['model'] ?? 'default') === model).length;
    if (activeForModel >= limit) return { ok: false, reason: 'model-capacity' };
    return { ok: true };
  }

  reserve(task: AutonomousTask): void {
    const decision = this.canStart(task);
    if (!decision.ok) throw new Error(`Cannot reserve resources: ${decision.reason ?? 'unknown'}`);
    this.active.set(task.taskId, task);
  }

  release(taskId: string): void {
    this.active.delete(taskId);
  }
}

/** Outcome of a worktree finalize/reconcile disposal attempt. `reason` is a
 * structured diagnostic explaining why a lease was preserved instead of removed. */
export interface WorktreeDisposalResult {
  disposed: boolean;
  reason?: string;
}

export class IsolatedWorktreeManager {
  private hostPromise?: Promise<WorkspaceHost>;

  constructor(
    private readonly repositoryRoot: string,
    /**
     * Resolves the isolation backend for this repository root. Defaults to the
     * unmodified `WorktreeManager` behind `GitWorktreeHost` — identical to the
     * prior hardcoded `new WorktreeManager(repositoryRoot)` default, so every
     * existing caller keeps exact current behavior. `autoWorkspaceHostFactory`
     * (below) is the git-optional alternative: it classifies the root once
     * (git / plain / empty / nested-git) and picks `GitWorktreeHost` only when
     * the root is itself a Git repository top-level.
     */
    private readonly hostFactory: () => Promise<WorkspaceHost> = async () => new GitWorktreeHost(repositoryRoot),
  ) {}

  private getHost(): Promise<WorkspaceHost> {
    if (!this.hostPromise) {
      this.hostPromise = this.hostFactory();
    }
    return this.hostPromise;
  }

  async bind(task: AutonomousTask, requestedBranch = branchForTask(task)): Promise<{ task: AutonomousTask; lease: WorkspaceLease }> {
    const seedFiles = task.trustedDirtyBaseline?.map((entry) => ({ path: entry.path, content: entry.content }));
    const host = await this.getHost();
    const lease = await host.createLease(task.taskId, ['**/*'], requestedBranch, seedFiles);
    const updated: AutonomousTask = {
      ...task,
      branchName: lease.branch,
      worktreeLocation: lease.worktreePath,
      worktreeBaseCommit: lease.baseCommit,
    };
    return { task: updated, lease };
  }

  /**
   * M42: a task that stopped at a resumable block had its lease marked `failed` (releasing the
   * write-scope lock for other work) while its worktree and branch were deliberately kept. A
   * human resume of that same task re-activates the lease; {@link assertBinding} then
   * re-verifies branch, base commit, Git top-level and HEAD before anything runs, so this
   * never trusts the record alone. Only `failed` leases are re-activated (never `completed`,
   * `cancelled` or a missing lease).
   */
  async reactivateRetryableLease(task: AutonomousTask): Promise<boolean> {
    if (!task.worktreeLocation) return false;
    const host = await this.getHost();
    const lease = (await host.listLeases()).find(candidate => candidate.taskId === task.taskId);
    if (!lease || lease.status !== 'failed') return false;
    await host.markStatus(task.taskId, 'active');
    return true;
  }

  /**
   * Revalidates persisted worktree metadata immediately before autonomous graph
   * execution. The durable task record and lease manifest must always agree.
   * A `git-worktree` lease additionally re-verifies Git top-level, checked-out
   * branch and HEAD against the filesystem, so it never trusts the manifest
   * record alone. A `plain-scope-lock` lease has no separate worktree to
   * cross-check against Git — there is no isolated copy — so identity there
   * rests on the manifest's exclusivity guarantee (one active `**\/*`-scoped
   * lease per root) plus the mutation pipeline's own per-write content-hash
   * revalidation (`WorkspaceSnapshotBinder`/`WorkspaceMutationEngine`), which
   * is what actually detects a workspace changed out from under a pending
   * proposal in that mode.
   */
  async assertBinding(task: AutonomousTask): Promise<void> {
    const mismatch = (reason: string): Error =>
      new Error(`worktree_identity_mismatch:${reason}`);

    // A task must have a persisted isolated-workspace binding before identity
    // can be verified. `branchName` is deliberately NOT required here: a
    // plain-scope-lock lease has no Git branch by design (see WorkspaceHost.ts),
    // so the branch requirement is enforced per-isolation below, only where a
    // Git worktree actually exists.
    if (!task.worktreeLocation || !task.worktreeBaseCommit) {
      throw mismatch('missing_binding');
    }

    // Copy narrowed optional fields into immutable string locals. This prevents
    // TypeScript from widening them again across asynchronous operations.
    const worktreeLocation: string = task.worktreeLocation;
    const worktreeBaseCommit: string = task.worktreeBaseCommit;
    const repositoryRoot: string = task.repositoryRoot;

    const host = await this.getHost();
    const lease = (await host.listLeases())
      .find(candidate => candidate.taskId === task.taskId);

    if (!lease) {
      throw mismatch('lease_unavailable');
    }

    if (lease.status !== 'active') {
      throw mismatch('lease_unavailable');
    }

    if (lease.isolation === 'plain-scope-lock') {
      // A plain-scope-lock lease has no separate worktree and no Git branch:
      // its identity rests on the manifest's exclusivity guarantee (one active
      // `**\/*`-scoped lease per root) plus realpath equality of the recorded
      // worktree and repository roots, re-checked here against the manifest.
      if (lease.branch !== (task.branchName ?? undefined)) {
        throw mismatch('branch_metadata');
      }
      if (lease.baseCommit !== worktreeBaseCommit) {
        throw mismatch('base_commit_metadata');
      }
      try {
        const [taskWorktree, leaseWorktree, taskRepository, leaseRepository] = await Promise.all([
          fs.realpath(worktreeLocation, 'utf8'),
          fs.realpath(lease.worktreePath, 'utf8'),
          fs.realpath(repositoryRoot, 'utf8'),
          fs.realpath(lease.repositoryRoot, 'utf8'),
        ]);
        if (!pathsEqual(taskWorktree, leaseWorktree) || !pathsEqual(taskRepository, leaseRepository)) {
          throw mismatch('worktree_path');
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('worktree_identity_mismatch:')) throw error;
        throw mismatch('unavailable');
      }
      return;
    }

    // Git-worktree isolation below: the persisted task branch is required
    // identity — a git lease always carries one, so its absence is a
    // corrupted/partial binding, never an ambiguous worktree to adopt.
    const branchName = task.branchName;
    if (!branchName) {
      throw mismatch('missing_binding');
    }

    if (lease.branch !== branchName) {
      throw mismatch('branch_metadata');
    }

    if (lease.baseCommit !== worktreeBaseCommit) {
      throw mismatch('base_commit_metadata');
    }

    try {
      const [
        taskWorktree,
        leaseWorktree,
        taskRepository,
        leaseRepository,
      ] = await Promise.all([
        fs.realpath(worktreeLocation, 'utf8'),
        fs.realpath(lease.worktreePath, 'utf8'),
        fs.realpath(repositoryRoot, 'utf8'),
        fs.realpath(lease.repositoryRoot, 'utf8'),
      ]);

      if (!pathsEqual(taskWorktree, leaseWorktree)) {
        throw mismatch('worktree_path');
      }

      if (!pathsEqual(taskRepository, leaseRepository)) {
        throw mismatch('repository_path');
      }

      if (pathsEqual(taskWorktree, taskRepository)) {
        throw mismatch('not_isolated');
      }

      const commandOptions = {
        cwd: taskWorktree,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8' as const,
      };
      const trustedTaskWorktree = taskWorktree.replace(/\\/g, '/');

      const [
        gitRootResult,
        branchResult,
      ] = await Promise.all([
        execFileAsync(
          'git',
          ['-c', `safe.directory=${trustedTaskWorktree}`, 'rev-parse', '--show-toplevel'],
          commandOptions,
        ),
        execFileAsync(
          'git',
          ['-c', `safe.directory=${trustedTaskWorktree}`, 'branch', '--show-current'],
          commandOptions,
        ),
      ]);

      const gitRoot = await fs.realpath(
        gitRootResult.stdout.trim(),
        'utf8',
      );

      if (!pathsEqual(gitRoot, taskWorktree)) {
        throw mismatch('git_top_level');
      }

      if (branchResult.stdout.trim() !== branchName) {
        throw mismatch('checked_out_branch');
      }

      if (worktreeBaseCommit === UNBORN_HEAD_COMMIT) {
        // Greenfield binding (repository had no first commit when the worktree
        // was created): the task worktree must STILL be unborn — nothing may
        // have committed to its dedicated branch before execution. An existing
        // HEAD here means a foreign commit landed on the task branch, which
        // must fail closed rather than be adopted. Git's own `--verify -q`
        // exits 1 with no output for an unborn HEAD; any other failure is a
        // genuine unavailability, never "greenfield".
        let headSha = '';
        try {
          const headVerify = await execFileAsync(
            'git',
            ['-c', `safe.directory=${trustedTaskWorktree}`, 'rev-parse', '--verify', '-q', 'HEAD'],
            commandOptions,
          );
          headSha = headVerify.stdout.trim();
        } catch (error) {
          const exitCode = (error as NodeJS.ErrnoException & { code?: string | number }).code;
          if (typeof exitCode !== 'number' || exitCode !== 1) {
            throw mismatch('unavailable');
          }
        }
        if (headSha !== '') {
          throw mismatch('head_commit');
        }
      } else {
        const headResult = await execFileAsync(
          'git',
          ['-c', `safe.directory=${trustedTaskWorktree}`, 'rev-parse', 'HEAD'],
          commandOptions,
        );
        if (headResult.stdout.trim() !== worktreeBaseCommit) {
          throw mismatch('head_commit');
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('worktree_identity_mismatch:')
      ) {
        throw error;
      }

      throw mismatch('unavailable');
    }
  }

  async status(task: AutonomousTask): Promise<{ clean: boolean; changedFiles: string[]; stale: boolean }> {
    if (!task.worktreeLocation) return { clean: false, changedFiles: [], stale: true };
    const host = await this.getHost();
    const changedFiles = await host.changedFiles(task.taskId).catch(() => []);
    return { clean: changedFiles.length === 0, changedFiles, stale: false };
  }

  async listLeases(): Promise<WorkspaceLease[]> {
    return (await this.getHost()).listLeases();
  }

  /**
   * Finalizes a task's worktree lease once it is no longer actively mutating, so its
   * write scope can never again be reported as overlapping a genuinely active task.
   * Idempotent: a lease already removed or already finalized is treated as a no-op,
   * since repeated recovery/disposal passes must not throw.
   *
   * `completed` means the task reached delivery review, not that delivery finished —
   * the worktree is still needed there, so it is never disposed on that outcome.
   * `failed`/`cancelled` release the write-scope lock unconditionally (e.g. a task
   * that lands in the retryable `blocked` state is marked `failed` here too, so a
   * later task can claim an overlapping scope). Physical disposal only happens when
   * `dispose` is true, i.e. the task's queue state is genuinely terminal and will
   * never be retried against this worktree again — a merely-blocked, retryable task
   * keeps its worktree (and evidence) intact even though its lease is marked `failed`.
   * When eligible, a clean worktree is removed and its manifest slot released; a
   * dirty one is preserved with a diagnostic reason.
   */
  async finalize(
    task: AutonomousTask,
    status: 'completed' | 'failed' | 'cancelled',
    options: { dispose?: boolean } = {},
  ): Promise<WorktreeDisposalResult> {
    if (!task.worktreeLocation) return { disposed: false };
    try {
      await (await this.getHost()).markStatus(task.taskId, status);
    } catch (error) {
      if (error instanceof Error && /^Unknown worktree lease:/.test(error.message)) return { disposed: false };
      throw error;
    }
    if (status === 'completed') return { disposed: false, reason: 'awaiting_delivery' };
    if (options.dispose === false) return { disposed: false, reason: 'retryable_not_terminal' };
    return this.disposeIfClean(task.taskId);
  }

  /** Removes a non-active lease's worktree/branch/manifest entry only if it has no
   * uncommitted changes; a dirty worktree is left in place for later inspection. */
  private async disposeIfClean(taskId: string): Promise<WorktreeDisposalResult> {
    const host = await this.getHost();
    const changed = await host.changedFiles(taskId).catch(() => null);
    if (changed === null) return { disposed: false, reason: 'lease_unavailable' };
    if (changed.length > 0) return { disposed: false, reason: `dirty:${changed.join(',')}` };
    await host.cleanup(taskId).catch(() => undefined);
    return { disposed: true };
  }

  /**
   * Activation-time safety net: reconciles any lease left `active` by a task that
   * crashed, was disposed, or was interrupted mid-mutation, using the durable task
   * queue as the source of truth for the outcome. Must run after queue-level
   * recovery has already blocked interrupted in-flight tasks.
   */
  async reconcileStaleLeases(queue: DurableTaskQueue): Promise<Array<{ taskId: string; action: string }>> {
    const actions: Array<{ taskId: string; action: string }> = [];
    const host = await this.getHost();
    const leases = await host.listLeases();
    for (const lease of leases) {
      if (lease.status === 'active') {
        const task = await queue.get(lease.taskId);
        if (!task) {
          await host.markStatus(lease.taskId, 'failed').catch(() => undefined);
          actions.push({ taskId: lease.taskId, action: 'lease_orphan_failed' });
          await this.disposeAndRecord(lease.taskId, actions);
          continue;
        }
        const status = leaseStatusForTaskState(task.state);
        if (status) {
          await host.markStatus(lease.taskId, status).catch(() => undefined);
          actions.push({ taskId: lease.taskId, action: `lease_reconciled_${status}` });
          // 'blocked' maps to lease status 'failed' (to release the write-scope lock)
          // but is retryable at the queue level (blocked -> queued); only dispose when
          // the task itself is genuinely terminal.
          if (task.state === 'failed' || task.state === 'cancelled') {
            await this.disposeAndRecord(lease.taskId, actions);
          }
        }
        continue;
      }
      // Non-active lease left over from a prior session: the directory itself may
      // already be gone (crash between `cleanup`'s worktree-remove and manifest
      // rewrite, or manual removal) — reconcile the manifest against disk first.
      const stillOnDisk = await fs.stat(lease.worktreePath).then(() => true, () => false);
      if (!stillOnDisk) {
        await host.cleanup(lease.taskId).catch(() => undefined);
        actions.push({ taskId: lease.taskId, action: 'lease_stale_pruned' });
        continue;
      }
      if (lease.status === 'failed' || lease.status === 'cancelled') {
        await this.disposeAndRecord(lease.taskId, actions);
      }
    }
    return actions;
  }

  private async disposeAndRecord(taskId: string, actions: Array<{ taskId: string; action: string }>): Promise<void> {
    const result = await this.disposeIfClean(taskId);
    actions.push({ taskId, action: result.disposed ? 'lease_disposed' : `lease_dirty_preserved:${result.reason ?? 'unknown'}` });
  }
}

/**
 * The git-optional alternative to `IsolatedWorktreeManager`'s default host
 * factory: classifies `repositoryRoot` once (memoized by the caller via
 * `IsolatedWorktreeManager`'s own `hostPromise` cache) and picks
 * `GitWorktreeHost` only when the root is itself a Git repository top-level,
 * `PlainFolderHost` otherwise (plain, empty, or nested-repo roots). Passing
 * this instead of the default preserves identical behavior for existing Git
 * repositories and adds support for everything else.
 */
export function autoWorkspaceHostFactory(repositoryRoot: string): () => Promise<WorkspaceHost> {
  return async () => WorkspaceHostFactory.forRoot(await discoverWorkspaceRoot(repositoryRoot));
}

function leaseStatusForTaskState(state: AutonomousLifecycleState): 'completed' | 'failed' | 'cancelled' | undefined {
  if (state === 'cancelled') return 'cancelled';
  if (state === 'failed' || state === 'blocked') return 'failed';
  // Delivery approval still needs the active lease for identity validation and
  // commit. The runtime finalizes it only after approval succeeds or is rejected.
  if (state === 'completed') return 'completed';
  return undefined;
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function branchForTask(task: AutonomousTask): string {
  const base = task.sourceIssue ? `issue-${task.sourceIssue.issueNumber}` : task.taskId;
  const summary = task.goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  return `forge/${base}-${summary}`.slice(0, 100);
}

export interface GitHubDeliveryTransport {
  getIssue(ref: GitHubIssueRef): Promise<{ title: string; body: string; url?: string }>;
  createDraftPullRequest(input: { owner: string; repo: string; title: string; body: string; head: string; base: string }): Promise<GitHubPullRequestMetadata>;
  getChecks(ref: { owner: string; repo: string; sha: string }): Promise<CiStatus>;
  getReviewComments(ref: { owner: string; repo: string; pullRequestNumber: number }): Promise<ReviewComment[]>;
}

export interface GitHubPullRequestMetadata {
  number: number;
  url: string;
  draft: boolean;
  headRefName?: string;
  baseRefName?: string;
  state?: string;
}

export interface DeliveryCommandRunner {
  run(command: string, cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
}

class DefaultDeliveryCommandRunner implements DeliveryCommandRunner {
  async run(command: string, cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(command, [...args], { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
  }
}

export function parseGitHubPullRequestMetadata(json: string): GitHubPullRequestMetadata {
  const parsed = JSON.parse(json) as {
    number?: unknown; url?: unknown; isDraft?: unknown; headRefName?: unknown; baseRefName?: unknown; state?: unknown;
  };
  if (!Number.isInteger(parsed.number) || (parsed.number as number) <= 0) throw new Error('Invalid GitHub pull request number.');
  if (typeof parsed.url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(parsed.url)) throw new Error('Invalid GitHub pull request URL.');
  if (typeof parsed.isDraft !== 'boolean') throw new Error('Invalid GitHub pull request draft state.');
  if (typeof parsed.headRefName !== 'string' || typeof parsed.baseRefName !== 'string' || typeof parsed.state !== 'string') {
    throw new Error('Incomplete GitHub pull request metadata.');
  }
  return {
    number: parsed.number as number,
    url: sanitizeText(parsed.url, 500),
    draft: parsed.isDraft,
    headRefName: sanitizeText(parsed.headRefName, 200),
    baseRefName: sanitizeText(parsed.baseRefName, 200),
    state: sanitizeText(parsed.state, 40),
  };
}

export class FakeGitHubDeliveryTransport implements GitHubDeliveryTransport {
  readonly pullRequests: Array<{ number: number; url: string; draft: boolean; title: string }> = [];
  constructor(private readonly issues = new Map<number, { title: string; body: string; url?: string }>()) {}
  async getIssue(ref: GitHubIssueRef): Promise<{ title: string; body: string; url?: string }> {
    return this.issues.get(ref.issueNumber) ?? { title: `Issue ${ref.issueNumber}`, body: '', url: ref.url };
  }
  async createDraftPullRequest(input: { owner: string; repo: string; title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string; draft: boolean }> {
    const existing = this.pullRequests.find(pr => pr.title === input.title);
    if (existing) return existing;
    const number = this.pullRequests.length + 1;
    const created = { number, url: `https://example.test/${input.owner}/${input.repo}/pull/${number}`, draft: true, title: input.title };
    this.pullRequests.push(created);
    return created;
  }
  async getChecks(): Promise<CiStatus> {
    return { state: 'success', failedChecks: [], observedAt: nowIso() };
  }
  async getReviewComments(): Promise<ReviewComment[]> {
    return [];
  }
}

export class GhCliGitHubDeliveryTransport implements GitHubDeliveryTransport {
  constructor(private readonly cwd: string, private readonly runner: DeliveryCommandRunner = new DefaultDeliveryCommandRunner()) {}
  async getIssue(ref: GitHubIssueRef): Promise<{ title: string; body: string; url?: string }> {
    const result = await this.gh(['issue', 'view', String(ref.issueNumber), '--repo', `${ref.owner}/${ref.repo}`, '--json', 'title,body,url']);
    const parsed = JSON.parse(result) as { title?: string; body?: string; url?: string };
    return { title: sanitizeText(parsed.title ?? '', 300), body: sanitizeText(parsed.body ?? '', 4000), url: parsed.url };
  }
  async createDraftPullRequest(input: { owner: string; repo: string; title: string; body: string; head: string; base: string }): Promise<GitHubPullRequestMetadata> {
    const repository = `${input.owner}/${input.repo}`;
    const createdUrl = (await this.gh(['pr', 'create', '--repo', repository, '--title', input.title, '--body', input.body, '--head', input.head, '--base', input.base, '--draft'])).trim();
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(createdUrl)) throw new Error('gh pr create did not return a GitHub pull request URL.');
    const authoritative = await this.gh(['pr', 'view', createdUrl, '--repo', repository, '--json', 'number,url,isDraft,headRefName,baseRefName,state']);
    return parseGitHubPullRequestMetadata(authoritative);
  }
  async getChecks(ref: { owner: string; repo: string; sha: string }): Promise<CiStatus> {
    const result = await this.gh(['run', 'list', '--repo', `${ref.owner}/${ref.repo}`, '--commit', ref.sha, '--limit', '10', '--json', 'conclusion,status,name']);
    const runs = JSON.parse(result) as Array<{ conclusion?: string; status?: string; name?: string }>;
    const failed = runs.filter(run => run.conclusion === 'failure').map(run => ({ name: sanitizeText(run.name ?? 'check', 120), summary: 'Failed' }));
    return { state: failed.length ? 'failure' : runs.some(run => run.status !== 'completed') ? 'pending' : 'success', failedChecks: failed, observedAt: nowIso() };
  }
  async getReviewComments(ref: { owner: string; repo: string; pullRequestNumber: number }): Promise<ReviewComment[]> {
    const result = await this.gh(['pr', 'view', String(ref.pullRequestNumber), '--repo', `${ref.owner}/${ref.repo}`, '--json', 'comments']);
    const parsed = JSON.parse(result) as { comments?: Array<{ id?: string; author?: { login?: string; is_bot?: boolean }; body?: string }> };
    return (parsed.comments ?? []).map((comment, index) => ({
      id: sanitizeText(comment.id ?? `comment-${index}`, 120),
      author: sanitizeText(comment.author?.login ?? '', 120),
      isBot: comment.author?.is_bot,
      body: sanitizeText(comment.body ?? '', 1000),
    }));
  }
  private async gh(args: string[]): Promise<string> {
    const { stdout } = await this.runner.run('gh', this.cwd, args);
    return stdout;
  }
}

export class GitDeliveryService {
  constructor(private readonly transport: GitHubDeliveryTransport) {}

  async ingestIssue(repositoryRoot: string, ref: GitHubIssueRef, queue: DurableTaskQueue): Promise<AutonomousTask> {
    const issue = await this.transport.getIssue(ref);
    return queue.enqueue({
      origin: 'github-issue',
      taskKind: 'mutating',
      repositoryRoot,
      repositoryId: `${ref.owner}/${ref.repo}`,
      sourceIssue: { ...ref, title: sanitizeText(issue.title, 300), url: issue.url },
      goal: issue.title,
      instructions: `Issue text is untrusted context. Acceptance proposal: ${issue.body}`,
      priority: 'normal',
      maxRetries: 2,
      providerModelRoutingSnapshot: {},
      permissionProfile: 'normal',
      validationRequirements: [],
      deliveryPolicy: defaultDeliveryPolicy(),
      notificationPolicy: { enabled: true, persisted: true },
      githubDelivery: { transport: 'fake' },
    });
  }

  async createDraftPullRequest(task: AutonomousTask, baseBranch: string): Promise<AutonomousTask> {
    if (!task.sourceIssue) throw new Error('Draft PR creation requires a source issue reference.');
    if (!task.branchName) throw new Error('Draft PR creation requires a governed branch.');
    const body = [
      'Summary',
      sanitizeText(task.goal, 1000),
      '',
      'Source issue',
      task.sourceIssue.url ?? `${task.sourceIssue.owner}/${task.sourceIssue.repo}#${task.sourceIssue.issueNumber}`,
      '',
      'Implemented changes',
      sanitizeText(task.latestProgress ?? 'Generated by governed M13 workflow.', 1000),
      '',
      'Validation performed',
      task.validationRequirements.map(item => `- ${sanitizeText(item.command, 160)}`).join('\n') || 'Validation evidence recorded in task artifacts.',
      '',
      'Known limitations',
      'M15 does not merge automatically.',
      '',
      'Risk notes',
      'Issue and review text were treated as untrusted input.',
      '',
      'Generated evidence references',
      task.evidence.join('\n') || 'See local task record.',
      '',
      'Human-review checklist',
      '- Review generated diff',
      '- Confirm CI status',
      '- Confirm unresolved comments are addressed',
    ].join('\n');
    const pr = await this.transport.createDraftPullRequest({
      owner: task.sourceIssue.owner,
      repo: task.sourceIssue.repo,
      title: sanitizeText(task.goal, 200),
      body,
      head: task.branchName,
      base: baseBranch,
    });
    return {
      ...task,
      githubDelivery: {
        ...task.githubDelivery,
        baseBranch,
        pullRequestNumber: pr.number,
        pullRequestUrl: pr.url,
        draft: pr.draft,
      },
    };
  }
}

export class MergeReadinessService {
  async report(task: AutonomousTask, worktree?: { clean: boolean; changedFiles: string[]; stale: boolean }): Promise<MergeReadinessReport> {
    const blockingFailures: string[] = [];
    if (task.state !== 'completed' && task.state !== 'waiting_for_review' && task.state !== 'monitoring_ci') blockingFailures.push(`task-state-${task.state}`);
    if (!task.githubDelivery.commitSha) blockingFailures.push('missing-commit');
    if (task.githubDelivery.ci && task.githubDelivery.ci.state !== 'success') blockingFailures.push('ci-not-success');
    if ((task.githubDelivery.review?.unresolvedComments ?? 0) > 0) blockingFailures.push('unresolved-comments');
    if (task.githubDelivery.draft !== true) blockingFailures.push('not-draft-pr-record');
    if (worktree?.stale) blockingFailures.push('stale-worktree');
    return {
      schemaVersion: 1,
      taskId: task.taskId,
      taskState: task.state,
      proposalApprovalState: task.deliveryPolicy.requireApprovalBeforeCommit ? 'required' : 'not-required',
      worktreeState: worktree ? { clean: worktree.clean, changedFiles: worktree.changedFiles.slice(0, 50), stale: worktree.stale } : { clean: false, changedFiles: [], stale: true },
      branch: task.branchName,
      commitSha: task.githubDelivery.commitSha,
      validationResult: task.evidence.some(item => item.includes('validation:passed')) ? 'passed' : 'unknown',
      sideEffectDetection: 'not-recorded',
      ciStatus: task.githubDelivery.ci?.state ?? 'unknown',
      reviewStatus: task.githubDelivery.review?.state ?? 'unknown',
      unresolvedComments: task.githubDelivery.review?.unresolvedComments ?? 0,
      conflictStatus: 'unknown',
      baseBranchDivergence: 'unknown',
      requiredChecks: [],
      draft: task.githubDelivery.draft ?? false,
      sensitiveChangeStatus: 'unknown',
      knownLimitations: ['Automatic merge is unavailable in M15.'],
      blockingFailures,
      warnings: [],
      mergeReady: blockingFailures.length === 0,
    };
  }
}

export interface MergeReadinessReport {
  schemaVersion: 1;
  taskId: string;
  taskState: AutonomousLifecycleState;
  proposalApprovalState: string;
  worktreeState: { clean: boolean; changedFiles: string[]; stale: boolean };
  branch?: string;
  commitSha?: string;
  validationResult: string;
  sideEffectDetection: string;
  ciStatus: CiStatus['state'];
  reviewStatus: ReviewStatus['state'];
  unresolvedComments: number;
  conflictStatus: string;
  baseBranchDivergence: string;
  requiredChecks: string[];
  draft: boolean;
  sensitiveChangeStatus: string;
  knownLimitations: string[];
  blockingFailures: string[];
  warnings: string[];
  mergeReady: boolean;
}

export class TaskRuntimeCoordinator {
  private readonly owner = `extension-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  private stopped = false;

  constructor(
    private readonly queue: DurableTaskQueue,
    private readonly resources: TaskResourceScheduler,
    private readonly worktrees: IsolatedWorktreeManager,
  ) {}

  async activateRecovery(): Promise<Array<{ taskId: string; action: string }>> {
    const queueActions = await this.queue.recoverOnActivation(this.owner);
    const leaseActions = await this.worktrees.reconcileStaleLeases(this.queue);
    return [...queueActions, ...leaseActions];
  }

  stop(): void {
    this.stopped = true;
  }

  async processOne(): Promise<AutonomousTask | undefined> {
    if (this.stopped) return undefined;
    const task = await this.queue.claimNext(this.owner, 60_000);
    if (!task) return undefined;
    const decision = this.resources.canStart(task);
    if (!decision.ok) {
      await this.queue.transition(task.taskId, 'waiting_for_resources', { reason: decision.reason });
      await this.queue.releaseClaim(task.taskId, this.owner);
      return task;
    }
    this.resources.reserve(task);
    try {
      // claimNext() also returns tasks left in 'waiting_for_resources' by a prior
      // canStart() rejection just above; those must route through 'preparing' too,
      // or the next transition below (-> 'waiting_for_approval') is not a valid
      // outgoing edge from 'waiting_for_resources' in VALID_TRANSITIONS and throws.
      let current = task.state === 'queued' || task.state === 'scheduled' || task.state === 'waiting_for_resources'
        ? await this.queue.transition(task.taskId, 'preparing')
        : task;
      if (current.taskKind === 'mutating' && !current.worktreeLocation) {
        const bound = await this.worktrees.bind(current);
        current = await this.queue.update(bound.task, 'worktree_bound', { branchName: bound.task.branchName });
      }
      current = await this.queue.transition(current.taskId, 'waiting_for_approval');
      return current;
    } finally {
      this.resources.release(task.taskId);
      await this.queue.releaseClaim(task.taskId, this.owner);
    }
  }
}

export class TaskNotificationService {
  private readonly records: Array<{ taskId: string; type: string; message: string; at: string }> = [];
  notify(taskId: string, type: string, message: string): void {
    this.records.push({ taskId, type, message: sanitizeText(message, 500), at: nowIso() });
  }
  list(): Array<{ taskId: string; type: string; message: string; at: string }> {
    return this.records.map(item => ({ ...item }));
  }
}

export async function acquireM15MutationLease(repositoryRoot: string, task: AutonomousTask): Promise<WorkspaceMutationLease> {
  const { WorkspaceMutationLease } = await import('../coding/ExecutionIntegrity');
  return WorkspaceMutationLease.acquire(repositoryRoot, `m15-${task.taskId}-${task.attemptId}`, 'm15');
}

export function defaultDeliveryPolicy(): DeliveryPolicy {
  return {
    requireApprovalBeforeCommit: true,
    requireApprovalBeforePullRequest: true,
    createDraftPullRequest: true,
    monitorCi: true,
    allowPrComments: false,
    retainSuccessfulWorktree: false,
  };
}

export function createDefaultAutonomousTask(repositoryRoot: string, goal: string, destinationBranch?: string): Omit<AutonomousTask, 'schemaVersion' | 'taskId' | 'attemptId' | 'createdAt' | 'state' | 'attempt' | 'followUps' | 'evidence'> {
  const repositoryId = crypto.createHash('sha256').update(path.resolve(repositoryRoot)).digest('hex').slice(0, 16);
  const executionProfile = classifyExecutionProfile(goal);
  return {
    origin: 'local-request',
    taskKind: 'mutating',
    repositoryRoot,
    repositoryId,
    goal,
    instructions: goal,
    priority: 'normal',
    maxRetries: 2,
    destinationBranch,
    providerModelRoutingSnapshot: { provider: 'configured', model: 'configured' },
    executionProfile,
    deterministicProposal: executionProfile.useDeterministicProposal
      ? parseDeterministicFileWrite(goal)
      : undefined,
    permissionProfile: 'normal',
    validationRequirements: [],
    deliveryPolicy: defaultDeliveryPolicy(),
    notificationPolicy: { enabled: true, persisted: true },
    githubDelivery: { transport: 'fake' },
  };
}

export async function resolveLocalTaskDestinationBranch(repositoryRoot: string): Promise<string | undefined> {
  try {
    const branch = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: repositoryRoot,
      windowsHide: true,
    });
    const current = String(branch.stdout ?? '').trim();
    return current || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveLocalTaskRepositoryHead(repositoryRoot: string): Promise<string | undefined> {
  try {
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      windowsHide: true,
    });
    return String(head.stdout ?? '').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Composer local-request tasks default to `transport: 'fake'` so tests and
 * fixtures never push. When the workspace has a configured `origin` remote,
 * the supported live route is the existing gh-cli path: commit on the isolated
 * `forge/att_*` branch, `git push --set-upstream origin <taskBranch>:<taskBranch>`
 * (never trunk), then the existing draft-PR helper against the workspace's
 * current branch as base. Missing origin stays fake — that is not a push.
 */
export async function resolveLocalTaskGitHubDelivery(repositoryRoot: string): Promise<GitHubDeliveryState> {
  try {
    const origin = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repositoryRoot,
      windowsHide: true,
    });
    if (!String(origin.stdout ?? '').trim()) {
      return { transport: 'fake' };
    }
    const branch = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: repositoryRoot,
      windowsHide: true,
    });
    const baseBranch = String(branch.stdout ?? '').trim();
    if (!baseBranch || !/^[A-Za-z0-9._/-]{1,200}$/.test(baseBranch)) {
      return { transport: 'fake' };
    }
    return { transport: 'gh-cli', remote: 'origin', baseBranch };
  } catch {
    return { transport: 'fake' };
  }
}

export async function listResumableAutonomousTasks(repositoryRoot: string): Promise<AutonomousTask[]> {
  const queue = new DurableTaskQueue(repositoryRoot);
  return (await queue.list()).filter(task => !TERMINAL_STATES.has(task.state));
}

export async function mirrorToLegacyTaskStore(repositoryRoot: string, task: AutonomousTask): Promise<void> {
  const store = new TaskStore(repositoryRoot);
  const existing = await store.getTask(task.taskId);
  if (!existing) {
    await store.createTask({
      taskId: task.taskId,
      workspaceId: task.repositoryId,
      workspaceRoot: repositoryRoot,
      userGoal: task.goal,
      mode: 'autonomous',
      model: task.providerModelRoutingSnapshot['model'] ?? 'configured',
      providerType: task.providerModelRoutingSnapshot['provider'] ?? 'configured',
      title: task.goal,
    });
  }
}

export function getDefaultM15WorktreeRoot(repositoryRoot: string): string {
  const key = crypto.createHash('sha256').update(path.resolve(repositoryRoot)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'ollama-agent-m15-worktrees', key);
}
