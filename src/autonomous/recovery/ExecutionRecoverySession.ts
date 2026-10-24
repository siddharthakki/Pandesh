import * as fs from 'fs/promises';
import * as path from 'path';
import { fingerprintText } from '../../coding/CodingProposal';
import { computePatchDelta, type PatchDelta } from '../../autonomy/FailureFingerprint';
import { DEFAULT_INSPECTION_LIMITS, WorkspaceInspectionTools } from '../../coding/WorkspaceInspection';
import type { HostBoundCodingProposal } from '../../coding/WorkspaceMutation';
import { AttemptJournal, EvidenceManifest, normalizeEvidencePath, type EvidenceEntry } from './AttemptJournal';
import { checkProposalGrounding, workspaceFileReader, type GroundingOperation, type GroundingVerdict } from './Grounding';
import { mutationProposalFingerprint, postMutationHashes } from './MutationReconciler';
import { operationsFingerprint } from './FailureClassifier';
import type { ValidationRunResult } from '../../coding/ValidationRunner';
import { sha } from './AttemptJournal';
import { validationFailureFacts } from './FailureClassifier';
import type { ModelIdentity } from './RecoveryTypes';
import type { InvestigationEvidenceCarry } from '../../coding/InvestigationEvidence';

/**
 * The narrow, per-dispatch surface the governed executor uses to (a) persist
 * what it observed, (b) enforce grounding and (c) receive the controller's
 * directives. Everything here is best-effort recording EXCEPT
 * {@link checkGrounding}, which is an enforced precondition.
 */

const MAX_SEED_FILE_CHARS = 30_000;
const MAX_SEED_TOTAL_CHARS = 48_000;

export interface ExecutionRecoverySessionOptions {
  journal: AttemptJournal;
  workspaceRoot: string;
  attemptId: string;
  pass: number;
  resolveBaseRevision: () => Promise<string | undefined>;
  seedEvidencePaths?: readonly string[];
  guidance?: readonly string[];
  /** When set, the executor resumes at validation against this already-applied bound proposal. */
  resumeAtValidation?: HostBoundCodingProposal;
  model?: ModelIdentity;
  /** M46: the runtime-compiled Context Pack for this dispatch, rendered ahead of the recovery notes. */
  contextPack?: string;
  /**
   * M46: names files (callers, dependencies, tests of the implicated ones) worth showing when the same validation
   * failure recurs between two repair cycles of one pass. Pure and synchronous; absent means no widening.
   */
  expandEvidence?: (implicated: readonly string[], alreadySeen: readonly string[]) => readonly string[];
  log?: (message: string) => void;
  /** Investigation evidence retained across the retry/repair loops of one task (see coding/InvestigationEvidence.ts). */
  evidenceCarry?: InvestigationEvidenceCarry;
}

export class ExecutionRecoverySession {
  readonly guidance: readonly string[];
  readonly seedEvidencePaths: readonly string[];
  readonly resumeAtValidation?: HostBoundCodingProposal;
  readonly evidenceCarry?: InvestigationEvidenceCarry;
  private readonly filesRead = new Set<string>();
  private baseRevisionCache: { value: string | undefined } | undefined;

  constructor(private readonly options: ExecutionRecoverySessionOptions) {
    this.guidance = options.guidance ?? [];
    this.seedEvidencePaths = options.seedEvidencePaths ?? [];
    this.resumeAtValidation = options.resumeAtValidation;
    this.evidenceCarry = options.evidenceCarry;
  }

  get manifest(): EvidenceManifest {
    return new EvidenceManifest(this.options.journal.state);
  }

  /** Paths read (by the model or the runtime) during this dispatch. */
  get readPaths(): string[] {
    return [...this.filesRead];
  }

  async baseRevision(): Promise<string | undefined> {
    if (!this.baseRevisionCache) this.baseRevisionCache = { value: await this.options.resolveBaseRevision().catch(() => undefined) };
    return this.baseRevisionCache.value;
  }

  /** Records a read (best effort). `contentHash` must describe the whole file, `ranges` the lines delivered. */
  async recordRead(read: {
    path: string;
    contentHash: string;
    ranges: Array<[number, number]>;
    totalLines?: number;
    source: EvidenceEntry['source'];
  }): Promise<void> {
    const filePath = normalizeEvidencePath(read.path);
    this.filesRead.add(filePath);
    await this.safe(async () => this.options.journal.append({
      t: 'evidence',
      entry: {
        path: filePath,
        contentHash: read.contentHash,
        baseRevision: await this.baseRevision(),
        epoch: this.options.journal.state.mutationEpoch,
        ranges: read.ranges,
        totalLines: read.totalLines,
        source: read.source,
        attemptId: this.options.attemptId,
        at: new Date().toISOString(),
      },
    }));
  }

  async recordSearch(query: string, scope: string | undefined, matchCount: number): Promise<void> {
    await this.safe(() => this.options.journal.append({ t: 'search', attemptId: this.options.attemptId, query: query.slice(0, 200), scope, matchCount }));
  }

  async recordProposal(input: { proposal?: { operations: ReadonlyArray<{ type: string; path: string; content?: string }> }; paths: string[]; valid: boolean; errors?: string[] }): Promise<void> {
    await this.safe(() => this.options.journal.append({
      t: 'proposal',
      attemptId: this.options.attemptId,
      pass: this.options.pass,
      fingerprint: operationsFingerprint(input.proposal?.operations),
      paths: input.paths.slice(0, 32),
      valid: input.valid,
      errors: input.errors?.slice(0, 8),
    }));
  }

  async recordRouting(routing: { attemptedModel?: string; executedModel?: string; fallbackUsed: boolean; decision?: string; reason?: string }): Promise<void> {
    await this.safe(() => this.options.journal.append({ t: 'routing', attemptId: this.options.attemptId, ...routing }));
  }

  async recordValidation(cycle: number, results: readonly ValidationRunResult[]): Promise<void> {
    const state = this.options.journal.state;
    const failures = validationFailureFacts(results, state.passedCommands);
    const passedCommands = results
      .filter(result => result.exitCode === 0 && !result.timedOut)
      .map(result => result.command.replace(/\s+/g, ' ').trim().slice(0, 200));
    await this.safe(() => this.options.journal.append({
      t: 'validation',
      attemptId: this.options.attemptId,
      pass: this.options.pass,
      cycle,
      passed: failures.length === 0,
      failureFingerprint: failures.length === 0 ? undefined : sha(failures.map(failure => `${failure.command}#${failure.signature}`).sort().join(',')),
      failures,
      passedCommands,
    }));
  }

  async recordReviewer(verdict: string, findings: string[]): Promise<void> {
    await this.safe(() => this.options.journal.append({ t: 'reviewer', attemptId: this.options.attemptId, verdict, findings: findings.slice(0, 12) }));
  }

  // ── mutation / validation checkpoints (fail-closed: these are NOT best effort) ─────────

  /** Durably marks that this exact bound proposal is about to be applied. Must complete before applying. */
  async mutationStarted(proposal: HostBoundCodingProposal): Promise<void> {
    const deltas = await this.patchDeltas(proposal);
    await this.options.journal.append({
      t: 'mutation',
      phase: 'started',
      attemptId: this.options.attemptId,
      proposalFingerprint: mutationProposalFingerprint(proposal),
      proposal,
      ...(deltas.length > 0 ? { deltas } : {}),
    });
  }

  /**
   * M46: what this mutation changes per file, measured against the file as it is right now (before the
   * mutation). Best effort by design: it only feeds semantic repetition detection, so a failure to read
   * a file yields no delta for it and never blocks or alters the mutation.
   */
  private async patchDeltas(proposal: HostBoundCodingProposal): Promise<PatchDelta[]> {
    const root = path.resolve(this.options.workspaceRoot);
    const deltas: PatchDelta[] = [];
    for (const operation of proposal.operations.slice(0, 32)) {
      try {
        const absolute = path.resolve(root, operation.path);
        if (absolute !== root && !absolute.startsWith(root + path.sep)) continue;
        const before = await fs.readFile(absolute, 'utf8').catch(() => undefined);
        deltas.push(computePatchDelta({ path: operation.path, op: operation.type, content: operation.content, before }));
      } catch { /* delta is advisory */ }
    }
    return deltas;
  }

  async mutationApplied(proposal: HostBoundCodingProposal): Promise<void> {
    const fingerprint = mutationProposalFingerprint(proposal);
    await this.options.journal.append({
      t: 'mutation',
      phase: 'applied',
      attemptId: this.options.attemptId,
      proposalFingerprint: fingerprint,
      postHashes: await postMutationHashes(this.options.workspaceRoot, proposal),
    });
    await this.safe(() => this.options.journal.append({
      t: 'patch',
      attemptId: this.options.attemptId,
      fingerprint,
      paths: proposal.operations.map(operation => operation.path).slice(0, 32),
    }));
  }

  /** Validation-repair cycles already consumed on this task attempt by earlier passes (durable). */
  get priorRepairCycles(): number {
    return this.options.journal.state.validationRepairCycles;
  }

  /** Durably consumes a repair cycle BEFORE its turn is dispatched, so a failed turn still counts on re-entry. */
  private lastRepairFailure: string | undefined;

  /**
   * Called before each validation-repair turn. When the failing set is the same as after the previous cycle (the last
   * repair changed nothing observable), repeating the request would repeat the hypothesis, so the runtime supplies
   * the callers, dependencies and tests of the implicated files that the model has not seen. Returns a prompt block
   * (empty when nothing applies). The first cycle never widens: there is no repeat yet.
   */
  async widenedRepairContext(results: readonly ValidationRunResult[], cycle: number, proposalPaths: readonly string[]): Promise<string> {
    const failures = validationFailureFacts(results, this.options.journal.state.passedCommands);
    // The failing tests and error classes identify the failure; the raw output signature also varies with the values a
    // reworded attempt happens to produce, so it is only the fallback when no test is named.
    const identityOf = (tests: readonly string[], classes: readonly string[]): string | undefined => (tests.length > 0 ? sha(`${[...tests].sort().join('|')}#${[...classes].sort().join(',')}`) : undefined);
    const tests = failures.flatMap(failure => failure.semantic?.tests ?? []);
    const classes = failures.flatMap(failure => failure.semantic?.errorClasses ?? []);
    const signature = failures.length === 0 ? undefined : identityOf(tests, classes) ?? sha(failures.map(failure => `${failure.command}#${failure.signature}`).sort().join(','));
    // A new pass (a controller-driven validation repair) starts from where the previous pass's failure left off.
    if (this.lastRepairFailure === undefined) {
      const prior = [...this.options.journal.state.outcomes].reverse().find(outcome => !outcome.ok && outcome.cause === 'validation_failure')?.failureFingerprint;
      if (prior) this.lastRepairFailure = identityOf(prior.tests, prior.errorClasses);
    }
    const repeated = signature !== undefined && this.lastRepairFailure === signature;
    this.lastRepairFailure = signature;
    if (!repeated || !this.options.expandEvidence) return '';
    const seen = [...this.options.journal.state.evidence.keys()];
    const implicated = [...failures.flatMap(failure => failure.namedPaths), ...proposalPaths];
    const extra = this.options.expandEvidence(implicated, seen).filter(item => !seen.includes(item)).slice(0, 4);
    if (extra.length === 0) return '';
    const reason = 'the same validation failure recurred after the last repair; supplying the callers, dependencies and tests of the implicated files';
    await this.safe(() => this.options.journal.append({ t: 'evidence_widened', attemptId: this.options.attemptId, pass: this.options.pass, cycle, paths: extra, reason }));
    this.options.log?.(`evidence_widened pass=${this.options.pass} cycle=${cycle} files=${extra.join(',')}`);
    const shown = await this.renderSeedFiles(extra);
    return `
### Runtime evidence widening
The same failure recurred after your last change, so that approach did not address the cause. Do not repeat it. The runtime added files you had not seen:
${shown}`;
  }

  async recordRepairCycle(cycle: number): Promise<void> {
    await this.options.journal.append({ t: 'repair_cycle', attemptId: this.options.attemptId, pass: this.options.pass, cycle });
  }

  async validationPhase(phase: 'started' | 'completed', passed?: boolean): Promise<void> {
    await this.options.journal.append({ t: 'validation_phase', phase, attemptId: this.options.attemptId, passed });
  }

  // ── grounding (enforced) ─────────────────────────────────────────────────

  async checkGrounding(operations: readonly GroundingOperation[]): Promise<GroundingVerdict> {
    return checkProposalGrounding({
      operations,
      manifest: this.manifest,
      readCurrent: workspaceFileReader(this.options.workspaceRoot),
      baseRevision: await this.baseRevision(),
    });
  }

  /**
   * Reads the seed paths from the CURRENT worktree, records each as fresh
   * evidence (source `runtime_seed`) and renders them, with the runtime's
   * guidance lines, as a prompt block. The runtime — not the model — decides
   * what gets read, so a model that would not read the file still gets it.
   */
  async renderRecoveryContext(options: { includeGuidance?: boolean } = {}): Promise<string> {
    const parts: string[] = [];
    if (this.options.contextPack) parts.push('\n' + this.options.contextPack + '\n');
    if (this.guidance.length > 0 && options.includeGuidance !== false) {
      parts.push(`\n### Runtime recovery notes\n${this.guidance.map(line => `- ${line}`).join('\n')}\n`);
    }
    parts.push(await this.renderSeedFiles(this.seedEvidencePaths));
    return parts.join('');
  }

  /** Renders each path as a governed, complete-or-truncated file block (and records complete ones as runtime-seed reads). */
  private async renderSeedFiles(paths: readonly string[]): Promise<string> {
    const out: string[] = [];
    let budget = MAX_SEED_TOTAL_CHARS;
    // Seed paths are model- or tool-output-derived, so they are UNTRUSTED: the same governed reader the
    // investigation tools use enforces the workspace boundary, path policy (traversal, absolute, UNC,
    // credential files), binary and size limits before anything is read or shown.
    const inspection = new WorkspaceInspectionTools(this.options.workspaceRoot, { ...DEFAULT_INSPECTION_LIMITS, maxReadBytes: 300_000 });
    for (const seedPath of paths) {
      if (budget <= 0) break;
      const relative = normalizeEvidencePath(seedPath);
      let content: string;
      try {
        content = (await inspection.readTextFile(relative)).content;
      } catch (error) {
        const rejected = error instanceof Error && /rejected|required|escape|outside|limit|binary/i.test(error.message);
        out.push(`\n### ${relative.slice(0, 200)}\nNEGATIVE EVIDENCE: ${rejected ? 'this path cannot be supplied (outside the allowed workspace read policy)' : 'the file does not exist in the current worktree (or is unreadable)'}.\n`);
        await this.safe(() => this.options.journal.append({ t: 'search', attemptId: this.options.attemptId, query: `read:${relative}`, matchCount: 0 }));
        continue;
      }
      const cap = Math.min(MAX_SEED_FILE_CHARS, budget);
      const complete = content.length <= cap;
      const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
      const body = complete ? content : content.slice(0, cap);
      budget -= body.length;
      out.push(`\n### ${relative}\n${complete ? 'COMPLETE current file' : 'TRUNCATED current file; remainder omitted'}; ${fingerprintText(content)}\n\`\`\`\n${body}\n\`\`\`\n`);
      // Only a complete delivery is recorded as a (whole-file) read.
      if (complete) {
        await this.recordRead({
          path: relative,
          contentHash: fingerprintText(content),
          ranges: lines === 0 ? [[1, 1]] : [[1, lines]],
          totalLines: lines || 1,
          source: 'runtime_seed',
        });
      }
    }
    return out.join('');
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.options.log?.(`recovery_journal_write_failed ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}
