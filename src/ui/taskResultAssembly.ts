/**
 * Karke Dikha TaskResult assembly (host side).
 *
 * Builds the authoritative, evidence-backed TaskResult for an autonomous task from the durable task record and the real
 * filesystem — never from what the model said. The contract, previews and truth rule live in
 * core/platform/artifacts/taskResult.ts; this file only maps recorded host facts onto them.
 *
 * Artifacts reference the real file (workspace-relative path + size/hash read from disk); content is never copied into a
 * second store.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EvidenceLedger } from '../../core/platform/evidenceLedger';
import {
  artifactId,
  buildTaskResult,
  classifyArtifactPath,
  reconcileOutcome,
  type Artifact,
  type TaskResult,
} from '../../core/platform/artifacts/taskResult';

/** The subset of the durable autonomous task this assembly reads. Structural, so tests need no runtime. */
export interface AssemblableTask {
  taskId: string;
  attemptId?: string;
  state: string;
  goal?: string;
  repositoryRoot?: string;
  worktreeLocation?: string;
  providerModelRoutingSnapshot?: Record<string, unknown>;
  mutationEvidence?: { expectedPaths?: string[]; changedPaths?: string[]; alreadySatisfied?: boolean };
  diffReview?: { approvedScopePaths?: string[] };
  deliveryValidation?: { status: 'pending' | 'passed' | 'failed'; results?: Array<{ command: string; exitCode: number | null; timedOut: boolean }> };
  validationFailure?: { commandLabel: string; exitCode: number | null; timedOut: boolean };
  /**
   * Structural checks that are NOT a test or build (for example the static HTML parse check). They are recorded as evidence and
   * shown, but they never read as "validation passed"; a failed one downgrades a completed task to partial.
   */
  structuralChecks?: Array<{ path: string; ok: boolean; summary: string }>;
  terminalResult?: { status: 'completed' | 'failed' | 'cancelled'; summary: string };
  failure?: { classification: string; message: string };
}

export interface AssemblyContext {
  workspaceRoot: string;
  /** path -> operation type recorded when the proposal was pending (`create_file`, `modify_file`, `delete_file`…). */
  proposedOperations?: ReadonlyMap<string, string>;
  /** Overridable for tests. */
  exists?: (absolutePath: string) => boolean;
  statFile?: (absolutePath: string) => { size: number; hash?: string } | undefined;
  now?: () => Date;
}

const MAX_HASH_BYTES = 2 * 1024 * 1024;

function normalize(relativePath: string): string {
  return String(relativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function defaultStat(absolutePath: string): { size: number; hash?: string } | undefined {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return undefined;
    const hash = stat.size <= MAX_HASH_BYTES
      ? crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')
      : undefined;
    return { size: stat.size, ...(hash ? { hash } : {}) };
  } catch {
    return undefined;
  }
}

/** Resolves a recorded relative path under `root`, refusing anything that escapes it. */
export function resolveUnderRoot(root: string, relativePath: string): string | undefined {
  const normalized = normalize(relativePath);
  if (!normalized || path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return undefined;
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return absolute;
}

function terminalStatus(state: string): TaskResult['status'] | undefined {
  switch (state) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'blocked': return 'blocked';
    case 'cancelled': return 'cancelled';
    default: return undefined;
  }
}

/**
 * Returns undefined while the task is still running. For a terminal task it returns the evidence-backed result, with the
 * runtime's "completed" downgraded to `partial` whenever a promised file is missing or recorded validation failed.
 */
export function assembleAutonomousTaskResult(task: AssemblableTask, context: AssemblyContext): TaskResult | undefined {
  const claimed = terminalStatus(task.state);
  if (!claimed) return undefined;

  // A delivered task lives in the workspace; before delivery (blocked/failed) any partial output is in the isolated worktree.
  const root = task.state === 'completed' ? (task.repositoryRoot || context.workspaceRoot) : (task.worktreeLocation || task.repositoryRoot || context.workspaceRoot);
  const exists = context.exists ?? ((absolute: string) => { try { return fs.existsSync(absolute); } catch { return false; } });
  const stat = context.statFile ?? defaultStat;
  const existsRel = (relativePath: string): boolean => {
    const absolute = resolveUnderRoot(root, relativePath);
    return absolute !== undefined && exists(absolute);
  };

  const changed = [...new Set((task.mutationEvidence?.changedPaths?.length ? task.mutationEvidence.changedPaths : task.diffReview?.approvedScopePaths ?? []).map(normalize).filter(Boolean))];
  const promised = [...new Set((task.mutationEvidence?.expectedPaths ?? []).map(normalize).filter(Boolean))];
  const operations = context.proposedOperations ?? new Map<string, string>();

  const ledger = new EvidenceLedger(() => (context.now ?? (() => new Date()))().getTime());
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const artifacts: Artifact[] = [];
  const createdAt = (context.now ?? (() => new Date()))().toISOString();

  for (const rel of changed) {
    const operation = operations.get(rel) ?? '';
    const present = existsRel(rel);
    if (/delete|remove/i.test(operation)) {
      deleted.push(rel);
      ledger.record({ kind: 'file_written', subject: rel, summary: `Deleted ${rel}`, ok: !present });
      continue;
    }
    if (!present) {
      // Recorded as changed but not on disk and not a deletion: do not claim it exists.
      ledger.record({ kind: 'file_written', subject: rel, summary: `Recorded change to ${rel} but the file was not found`, ok: false });
      continue;
    }
    (/create|add|new/i.test(operation) ? created : modified).push(rel);
    const evidence = ledger.record({ kind: 'file_written', subject: rel, summary: `${/create|add|new/i.test(operation) ? 'Created' : 'Changed'} ${rel}`, ok: true });
    const absolute = resolveUnderRoot(root, rel);
    const info = absolute ? stat(absolute) : undefined;
    const { type, mimeType } = classifyArtifactPath(rel);
    artifacts.push({
      id: artifactId('art'),
      type,
      title: path.posix.basename(rel),
      path: rel,
      ...(mimeType ? { mimeType } : {}),
      ...(info ? { sizeBytes: info.size, ...(info.hash ? { hash: info.hash } : {}) } : {}),
      evidenceIds: [evidence.id],
      createdAt,
    });
  }

  const commands: string[] = [];
  for (const run of task.deliveryValidation?.results ?? []) {
    commands.push(run.command);
    const ok = run.exitCode === 0 && !run.timedOut;
    ledger.record({ kind: /build|compile|tsc/i.test(run.command) ? 'build_run' : 'test_run', subject: run.command, summary: `${run.command} → ${run.timedOut ? 'timed out' : `exit ${run.exitCode}`}`, ok, ...(run.exitCode !== null ? { exitCode: run.exitCode } : {}) });
  }
  if (task.validationFailure && !(task.deliveryValidation?.results?.length)) {
    // A failure record always counts as a failed validation, even when its label/exit code were not captured.
    const label = typeof task.validationFailure.commandLabel === 'string' && task.validationFailure.commandLabel ? task.validationFailure.commandLabel : 'validation';
    const exitCode = typeof task.validationFailure.exitCode === 'number' ? task.validationFailure.exitCode : undefined;
    commands.push(label);
    ledger.record({ kind: 'test_run', subject: label, summary: `${label} → ${task.validationFailure.timedOut ? 'timed out' : `exit ${exitCode ?? 'unknown'}`}`, ok: false, ...(exitCode !== undefined ? { exitCode } : {}) });
  }

  const failedStructural: string[] = [];
  for (const check of task.structuralChecks ?? []) {
    ledger.record({ kind: 'command_run', subject: `structure check ${check.path}`, summary: check.summary, ok: check.ok });
    if (!check.ok) failedStructural.push(check.path);
  }

  const draft = buildTaskResult({ status: claimed, summary: '', ledger, artifacts });
  const verdict = reconcileOutcome({
    claimed,
    promisedPaths: promised,
    exists: existsRel,
    validationStatus: draft.validationStatus,
    mutated: created.length + modified.length + deleted.length > 0,
  });

  const warnings = [...verdict.warnings];
  let finalStatus = verdict.status;
  if (failedStructural.length > 0 && finalStatus === 'completed') {
    finalStatus = 'partial';
    warnings.push(`Structure check failed for ${failedStructural.slice(0, 3).join(', ')}.`);
  }
  if (claimed === 'completed' && task.mutationEvidence?.alreadySatisfied && changed.length === 0) warnings.push('Nothing needed to change: the repository already satisfied the request.');
  const reasons = claimed === 'failed' || claimed === 'blocked' ? (task.failure?.message ? [task.failure.message] : []) : [];
  const counts = `${created.length} created, ${modified.length} modified, ${deleted.length} deleted`;
  const summary = finalStatus === 'completed'
    ? (task.terminalResult?.summary || `Completed: ${counts}.`)
    : finalStatus === 'partial'
      ? `Incomplete: ${warnings.join(' ')}`
      : (task.terminalResult?.summary || task.failure?.message || `${claimed[0].toUpperCase()}${claimed.slice(1)}.`);

  return {
    ...draft,
    status: finalStatus,
    summary,
    origin: {
      taskId: task.taskId,
      ...(task.attemptId ? { attemptId: task.attemptId } : {}),
      ...(typeof task.providerModelRoutingSnapshot?.['model'] === 'string' ? { model: String(task.providerModelRoutingSnapshot['model']) } : {}),
      ...(typeof task.providerModelRoutingSnapshot?.['provider'] === 'string' ? { provider: String(task.providerModelRoutingSnapshot['provider']) } : {}),
    },
    changes: { created, modified, deleted },
    commands,
    warnings: [...warnings, ...reasons],
  };
}

/** What Core recorded for one Saath Kar turn: every field comes from tool invocations and the filesystem, never from model prose. */
export interface SaathTurnEvidence {
  attemptId: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  failureMessage?: string;
  model?: string;
  provider?: string;
  /** Approved file mutations Core executed (path as Core resolved it). */
  mutations: Array<{ path: string; ok: boolean; operation?: string }>;
  /** Mechanical validation gates Core ran after those mutations. */
  validations: Array<{ command: string; ok: boolean; exitCode: number | null; timedOut?: boolean }>;
  /** Structural (non test/build) checks Core ran, e.g. the static HTML parse check. */
  structuralChecks: Array<{ path: string; ok: boolean; summary: string }>;
}

/** The durable Core records a finished Saath Kar turn is re-derived from (History reopen / restart). Structural, so tests need no Core. */
export interface DurableSaathRecords {
  attemptId: string;
  outcome: SaathTurnEvidence['outcome'];
  /** The conversation's capability actions (the anchor attempt is shared by every turn, so they are windowed by time). */
  actions: ReadonlyArray<{
    toolName: string;
    outcome: string;
    requestedAt: string;
    arguments?: Record<string, unknown>;
    presentation?: Record<string, unknown> | null;
    invocation?: { evidence?: Record<string, unknown> } | null;
  }>;
  /** The turn's own tool invocations (the mechanical validation and the static structure check are recorded here). */
  invocations: ReadonlyArray<{ toolName: string; status: string; exitCode: number | null; argsSummary?: Record<string, unknown>; evidence?: Record<string, unknown> }>;
  /** The turn's span; only actions requested inside it belong to it. */
  window: { from: string; to?: string | null };
}

/**
 * Re-derives a finished Saath Kar turn's evidence from Core's durable records, with exactly the same meaning the live path gives
 * the same facts (see AgentPanel's tool-invocation event handling). Nothing here is read from UI state or model prose.
 */
export function saathEvidenceFromDurableRecords(records: DurableSaathRecords): SaathTurnEvidence {
  const from = Date.parse(records.window.from);
  const to = records.window.to ? Date.parse(records.window.to) : Number.POSITIVE_INFINITY;
  const mutations: SaathTurnEvidence['mutations'] = [];
  for (const action of records.actions) {
    if (action.toolName !== 'propose_file_change' && action.toolName !== 'propose_text_edit') continue;
    const requested = Date.parse(action.requestedAt);
    if (!(requested >= from && requested <= to)) continue;
    const normalized = (action.invocation?.evidence?.['normalizedArguments'] as Record<string, unknown> | undefined) ?? action.arguments ?? {};
    const changedPath = normalize(String(normalized['path'] ?? action.arguments?.['path'] ?? ''));
    if (!changedPath) continue;
    const presentation = action.presentation as { kind?: string; baseline?: string } | null | undefined;
    mutations.push({
      path: changedPath,
      ok: action.outcome === 'succeeded',
      ...(presentation?.kind === 'write_file_diff' ? { operation: presentation.baseline === 'absent' ? 'create_file' : 'modify_file' } : {}),
    });
  }
  const validations: SaathTurnEvidence['validations'] = [];
  const structuralChecks: SaathTurnEvidence['structuralChecks'] = [];
  for (const invocation of records.invocations) {
    const ok = invocation.status === 'succeeded';
    if (invocation.toolName === 'workspace_validation') {
      const gates = Array.isArray(invocation.argsSummary?.['gates']) ? (invocation.argsSummary!['gates'] as unknown[]).map(String) : [];
      validations.push({ command: gates.join(' && ') || 'workspace validation', ok, exitCode: ok ? 0 : 1 });
    } else if (invocation.toolName === 'static_html_check') {
      const output = String(invocation.evidence?.['output'] ?? (ok ? 'Static HTML structure check passed' : 'Static HTML structure check failed'));
      structuralChecks.push({ path: String(invocation.argsSummary?.['path'] ?? ''), ok, summary: output.split('\n')[0].slice(0, 300) });
    }
  }
  return { attemptId: records.attemptId, outcome: records.outcome, mutations, validations, structuralChecks };
}

/**
 * The same evidence-backed TaskResult Karke Dikha produces, for a Saath Kar turn. Returns undefined when the turn changed
 * nothing and validated nothing (a pure conversation has no result card). Artifacts are the files Core really changed, checked
 * against the disk; a change whose file is missing is not claimed.
 */
export function assembleSaathTaskResult(evidence: SaathTurnEvidence, context: AssemblyContext): TaskResult | undefined {
  const applied = evidence.mutations.filter(mutation => mutation.ok && mutation.path);
  if (applied.length === 0 && evidence.validations.length === 0 && evidence.structuralChecks.length === 0) return undefined;
  const operations = new Map<string, string>(context.proposedOperations ?? []);
  for (const mutation of applied) if (mutation.operation) operations.set(normalize(mutation.path), mutation.operation);
  const validationFailed = evidence.validations.some(validation => !validation.ok);
  const task: AssemblableTask = {
    taskId: evidence.attemptId,
    attemptId: evidence.attemptId,
    state: evidence.outcome === 'completed' ? 'completed' : evidence.outcome === 'cancelled' ? 'cancelled' : 'failed',
    repositoryRoot: context.workspaceRoot,
    providerModelRoutingSnapshot: { ...(evidence.model ? { model: evidence.model } : {}), ...(evidence.provider ? { provider: evidence.provider } : {}) },
    mutationEvidence: { expectedPaths: [], changedPaths: [...new Set(applied.map(mutation => normalize(mutation.path)))] },
    ...(evidence.validations.length > 0
      ? {
        deliveryValidation: {
          status: validationFailed ? 'failed' as const : 'passed' as const,
          results: evidence.validations.map(validation => ({ command: validation.command, exitCode: validation.exitCode ?? (validation.ok ? 0 : 1), timedOut: validation.timedOut === true })),
        },
      }
      : {}),
    ...(evidence.structuralChecks.length > 0 ? { structuralChecks: evidence.structuralChecks } : {}),
    ...(evidence.failureMessage ? { failure: { classification: 'execution_failed', message: evidence.failureMessage } } : {}),
  };
  return assembleAutonomousTaskResult(task, { ...context, proposedOperations: operations });
}

/** Maps a reconciled result onto the single terminal outcome the Dhaaga projection shows. */
export function terminalOutcomeForResult(result: TaskResult): { outcome: 'completed' | 'blocked' | 'failed' | 'cancelled'; detail?: string } {
  switch (result.status) {
    case 'completed': return { outcome: 'completed' };
    case 'partial': return { outcome: result.validations.some(v => !v.ok) ? 'failed' : 'blocked', detail: result.warnings?.[0] ?? 'Incomplete' };
    case 'cancelled': return { outcome: 'cancelled' };
    case 'blocked': return { outcome: 'blocked' };
    default: return { outcome: 'failed' };
  }
}
