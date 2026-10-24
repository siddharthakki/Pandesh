import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseAutonomousProgressPhase } from '../../autonomous/AutonomousProgressEvents';
import { AttemptJournal, EvidenceManifest, mergeRanges } from '../../autonomous/recovery/AttemptJournal';
import { checkProposalGrounding, workspaceFileReader } from '../../autonomous/recovery/Grounding';
import { classifyExecutionResult, validationFailureFacts } from '../../autonomous/recovery/FailureClassifier';
import { composeMutationHistory, planResumeAfterRestart, reconcileMutation } from '../../autonomous/recovery/MutationReconciler';
import { contractDigest, verifyRestoredContract } from '../../autonomous/recovery/TaskContractEnvelope';
import { isCapableForRecovery, selectRecoveryModel, type RecoveryCandidate } from '../../autonomous/recovery/RecoveryModelRouter';
import { fingerprintText } from '../../coding/CodingProposal';
import type { GovernedCodingExecutionResult } from '../../coding/GovernedCodingExecutor';
import type { HostBoundCodingFileOperation, HostBoundCodingProposal } from '../../coding/WorkspaceMutation';
import { sha256 } from '../../coding/WorkspaceMutation';

const hashOf = (text: string): string => fingerprintText(text);

function boundOp(
  type: 'create' | 'replace' | 'delete',
  file: string,
  content: string | undefined,
  before: string | undefined,
): HostBoundCodingFileOperation {
  return {
    type,
    path: file,
    reason: 'test',
    content,
    canonicalPath: `/abs/${file}`,
    snapshot: before === undefined
      ? { state: 'absent', capturedAt: 'now' }
      : { state: 'exists', sha256: sha256(Buffer.from(before, 'utf8')), bytes: before.length, capturedAt: 'now' },
  };
}

function proposal(operations: HostBoundCodingFileOperation[]): HostBoundCodingProposal {
  return {
    version: 1,
    taskSummary: 't',
    operations,
    validationCommands: [{ kind: 'npm-script', script: 'verify' }],
    limits: { maxFiles: 10, maxBytesPerFile: 1000, totalBytes: 10000 },
    warnings: [],
    status: 'proposed',
  };
}

describe('M42 evidence manifest, grounding and freshness', () => {
  let root: string;
  let journal: AttemptJournal;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm42-evidence-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_e' });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function recordRead(file: string, content: string, over: { base?: string; ranges?: Array<[number, number]>; total?: number } = {}): Promise<void> {
    const lines = content.split('\n').length;
    await journal.append({
      t: 'evidence',
      entry: {
        path: file,
        contentHash: hashOf(content),
        baseRevision: over.base ?? 'base-1',
        epoch: journal.state.mutationEpoch,
        ranges: over.ranges ?? [[1, lines]],
        totalLines: over.total ?? lines,
        source: 'model_read',
        attemptId: 'att_1',
        at: new Date().toISOString(),
      },
    });
  }

  async function ground(operations: Array<{ type: string; path: string }>, base = 'base-1') {
    return checkProposalGrounding({
      operations,
      manifest: new EvidenceManifest(journal.state),
      readCurrent: workspaceFileReader(root),
      baseRevision: base,
    });
  }

  it('an unread target is rejected as never_read; creating a new file needs no read', async () => {
    await fs.writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    expect(await ground([{ type: 'replace', path: 'src/a.ts' }])).toEqual({ ok: false, missing: [{ path: 'src/a.ts', reason: 'never_read' }] });
    expect((await ground([{ type: 'create', path: 'src/new.ts' }])).ok).toBe(true);
    // A target that does not exist has nothing to read; the snapshot binder owns that conflict.
    expect((await ground([{ type: 'replace', path: 'src/missing.ts' }])).ok).toBe(true);
  });

  it('a fresh whole-file read of the current content admits the mutation', async () => {
    const content = 'export const a = 1;\n';
    await fs.writeFile(path.join(root, 'src/a.ts'), content);
    await recordRead('src/a.ts', content);
    expect((await ground([{ type: 'replace', path: 'src/a.ts' }, { type: 'delete', path: 'src/a.ts' }])).ok).toBe(true);
  });

  it('grounding freshness: a read from BEFORE the file changed cannot satisfy grounding after it', async () => {
    const before = 'export const price = 10;\n';
    await fs.writeFile(path.join(root, 'src/p.ts'), before);
    await recordRead('src/p.ts', before);
    expect((await ground([{ type: 'replace', path: 'src/p.ts' }])).ok).toBe(true);

    // The file changes (a mutation lands, or anything else rewrites it).
    await fs.writeFile(path.join(root, 'src/p.ts'), 'export const price = 12;\n');
    const stale = await ground([{ type: 'replace', path: 'src/p.ts' }]);
    expect(stale.ok).toBe(false);
    expect(stale.missing).toEqual([{ path: 'src/p.ts', reason: 'stale_content' }]);

    // Reading the new content re-admits it; the old read never comes back.
    await recordRead('src/p.ts', 'export const price = 12;\n');
    expect((await ground([{ type: 'replace', path: 'src/p.ts' }])).ok).toBe(true);
  });

  it('grounding freshness: evidence recorded against an older base revision is stale even for identical bytes', async () => {
    const content = 'same bytes\n';
    await fs.writeFile(path.join(root, 'src/s.ts'), content);
    await recordRead('src/s.ts', content, { base: 'base-1' });
    const moved = await ground([{ type: 'replace', path: 'src/s.ts' }], 'base-2');
    expect(moved.missing).toEqual([{ path: 'src/s.ts', reason: 'stale_base' }]);
  });

  it('a partial read cannot ground a whole-file replace, but can ground a delete; ranges accumulate to full coverage', async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(path.join(root, 'src/big.ts'), content);
    await recordRead('src/big.ts', content, { ranges: [[1, 4]], total: 10 });
    expect((await ground([{ type: 'replace', path: 'src/big.ts' }])).missing).toEqual([{ path: 'src/big.ts', reason: 'partial_read' }]);
    expect((await ground([{ type: 'delete', path: 'src/big.ts' }])).ok).toBe(true);
    await recordRead('src/big.ts', content, { ranges: [[5, 10]], total: 10 });
    expect((await ground([{ type: 'replace', path: 'src/big.ts' }])).ok).toBe(true);
  });

  it('evidence and the manifest fingerprint survive a restart (reopen folds the same state)', async () => {
    await recordRead('src/a.ts', 'a\n');
    await journal.append({ t: 'search', attemptId: 'att_1', query: 'nothing', matchCount: 0 });
    const fingerprint = new EvidenceManifest(journal.state).fingerprint();
    const reopened = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_e' });
    expect(new EvidenceManifest(reopened.state).fingerprint()).toBe(fingerprint);
    expect(reopened.state.negativeSearches).toEqual([{ query: 'nothing', scope: undefined }]);
    // New evidence changes the fingerprint (the no-progress guard depends on this).
    await recordRead('src/b.ts', 'b\n');
    expect(new EvidenceManifest(journal.state).fingerprint()).not.toBe(fingerprint);
  });

  it('tolerates a torn final line from a crash mid-append and keeps every earlier record', async () => {
    await recordRead('src/a.ts', 'a\n');
    await fs.appendFile(journal.filePath, '{"t":"evidence","entry":{"path":"src/torn');
    const reopened = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_e' });
    expect(reopened.state.corruptLines).toBe(1);
    expect(reopened.state.evidence.has('src/a.ts')).toBe(true);
    // Appending after the tear keeps working.
    await reopened.append({ t: 'search', attemptId: 'att_1', query: 'q', matchCount: 2 });
    expect((await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_e' })).state.records).toBeGreaterThanOrEqual(2);
  });

  it('mergeRanges joins overlapping and adjacent ranges only', () => {
    expect(mergeRanges([[5, 8], [1, 3], [4, 4], [10, 12]])).toEqual([[1, 8], [10, 12]]);
  });
});

describe('M42 mutation reconciliation (exactly-once across restart)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm42-reconcile-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const write = (file: string, content: string) => fs.writeFile(path.join(root, file), content);

  it('recognises the pre state, the post state and a mixed state from bytes on disk', async () => {
    const p = proposal([boundOp('replace', 'src/a.ts', 'new a\n', 'old a\n'), boundOp('create', 'src/b.ts', 'new b\n', undefined)]);
    await write('src/a.ts', 'old a\n');
    expect((await reconcileMutation(root, p)).state).toBe('not_applied');
    await write('src/a.ts', 'new a\n');
    await write('src/b.ts', 'new b\n');
    expect((await reconcileMutation(root, p)).state).toBe('applied');
    await fs.rm(path.join(root, 'src/b.ts'));
    expect((await reconcileMutation(root, p)).state).toBe('mixed');
    await write('src/b.ts', 'somebody else wrote this\n');
    expect((await reconcileMutation(root, p)).state).toBe('mixed');
  });

  it('a restart with the mutation on disk resumes at validation and never re-applies it', async () => {
    const original = proposal([boundOp('create', 'src/a.ts', 'export const a = 1;\n', undefined)]);
    await write('src/a.ts', 'export const a = 1;\n');
    const plan = await planResumeAfterRestart(root, {
      entries: [{ phase: 'applied', proposal: original }],
      validationCompleted: false,
    });
    expect(plan.kind).toBe('resume_validation');
    if (plan.kind === 'resume_validation') {
      expect(plan.proposal.validationCommands).toEqual(original.validationCommands);
    }
  });

  it('a started-but-never-landed mutation is safe to run normally; an unrecognisable state fails closed', async () => {
    const original = proposal([boundOp('replace', 'src/a.ts', 'new\n', 'old\n')]);
    await write('src/a.ts', 'old\n');
    expect((await planResumeAfterRestart(root, { entries: [{ phase: 'started', proposal: original }], validationCompleted: false })).kind).toBe('fresh');
    await write('src/a.ts', 'half written garbage\n');
    const uncertain = await planResumeAfterRestart(root, { entries: [{ phase: 'started', proposal: original }], validationCompleted: false });
    expect(uncertain.kind).toBe('uncertain');
  });

  it('after a repair mutation the composed state (approved op type kept, repaired content) is what validation resumes against', async () => {
    const approved = proposal([boundOp('create', 'src/a.ts', 'v1\n', undefined)]);
    const repair = proposal([boundOp('replace', 'src/a.ts', 'v2\n', 'v1\n')]);
    const composed = composeMutationHistory([{ proposal: approved }, { proposal: repair }]);
    expect(composed?.operations).toHaveLength(1);
    expect(composed?.operations[0]).toMatchObject({ type: 'create', content: 'v2\n' });
    expect(composed?.operations[0].snapshot.state).toBe('absent');

    await write('src/a.ts', 'v2\n');
    const plan = await planResumeAfterRestart(root, {
      entries: [{ phase: 'applied', proposal: approved }, { phase: 'applied', proposal: repair }],
      validationCompleted: false,
    });
    expect(plan.kind).toBe('resume_validation');
  });

  it('a repair that was started but did not land still resumes on the last applied state; one that landed resumes on it', async () => {
    const approved = proposal([boundOp('create', 'src/a.ts', 'v1\n', undefined)]);
    const repair = proposal([boundOp('replace', 'src/a.ts', 'v2\n', 'v1\n')]);
    await write('src/a.ts', 'v1\n');
    const notLanded = await planResumeAfterRestart(root, {
      entries: [{ phase: 'applied', proposal: approved }, { phase: 'started', proposal: repair }],
      validationCompleted: false,
    });
    expect(notLanded.kind).toBe('resume_validation');
    await write('src/a.ts', 'v2\n');
    const landed = await planResumeAfterRestart(root, {
      entries: [{ phase: 'applied', proposal: approved }, { phase: 'started', proposal: repair }],
      validationCompleted: false,
    });
    expect(landed.kind).toBe('resume_validation');
    if (landed.kind === 'resume_validation') expect(landed.detail).toContain('pending_repair_landed');
  });

  it('journal mutation history: started/applied pairing, validation completion and supersession', async () => {
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_m' });
    const p = proposal([boundOp('create', 'src/a.ts', 'x\n', undefined)]);
    await journal.append({ t: 'mutation', phase: 'started', attemptId: 'a', proposalFingerprint: 'fp', proposal: p });
    expect(journal.state.mutation?.entries.map(entry => entry.phase)).toEqual(['started']);
    await journal.append({ t: 'mutation', phase: 'applied', attemptId: 'a', proposalFingerprint: 'fp', postHashes: { 'src/a.ts': 'h' } });
    expect(journal.state.mutation?.entries.map(entry => entry.phase)).toEqual(['applied']);
    expect(journal.state.mutationEpoch).toBe(1);
    await journal.append({ t: 'validation_phase', phase: 'started', attemptId: 'a' });
    expect(journal.state.mutation?.validationCompleted).toBe(false);
    await journal.append({ t: 'validation_phase', phase: 'completed', attemptId: 'a', passed: false });
    expect(journal.state.mutation?.validationCompleted).toBe(true);

    const reopened = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_m' });
    expect(reopened.state.mutation?.entries[0].proposal?.operations[0].path).toBe('src/a.ts');
    expect(reopened.state.mutation?.validationCompleted).toBe(true);

    // A changed contract (scope-changing steering) means the recorded mutation no longer describes the worktree.
    await reopened.append({ t: 'superseded', reason: 'instruction_revision_changed', instructionRevision: 2 });
    expect(reopened.state.mutation).toBeUndefined();
    expect(reopened.state.instructionRevision).toBe(2);
  });

  it('delivery fence: started blocks re-delivery until it is completed or known-aborted', async () => {
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_d' });
    await journal.append({ t: 'delivery', phase: 'started', attemptId: 'a' });
    expect((await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_d' })).state.delivery?.phase).toBe('started');
    await journal.append({ t: 'delivery', phase: 'aborted', attemptId: 'a', detail: 'workspace_delivery_conflict' });
    expect(journal.state.delivery).toBeUndefined();
    await journal.append({ t: 'delivery', phase: 'started', attemptId: 'a' });
    await journal.append({ t: 'delivery', phase: 'completed', attemptId: 'a' });
    await journal.append({ t: 'terminal', terminalState: 'COMPLETE', reason: 'delivered' });
    expect((await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_d' })).state.terminal?.terminalState).toBe('COMPLETE');
  });
});

describe('M42 task contract envelope (stale approvals)', () => {
  const p = proposal([boundOp('replace', 'src/a.ts', 'new\n', 'old\n')]);

  it('the digest binds revision, operations and validation commands', () => {
    const base = contractDigest({ instructionRevision: 0, proposal: p });
    expect(contractDigest({ instructionRevision: 0, proposal: p })).toBe(base);
    expect(contractDigest({ instructionRevision: 1, proposal: p })).not.toBe(base);
    expect(contractDigest({ instructionRevision: 0, proposal: proposal([boundOp('replace', 'src/a.ts', 'different\n', 'old\n')]) })).not.toBe(base);
    expect(contractDigest({ instructionRevision: 0, proposal: { ...p, validationCommands: [{ kind: 'npm-script', script: 'other' }] } })).not.toBe(base);
  });

  it('a restored approval is valid only for the contract it was granted against', () => {
    const digest = contractDigest({ instructionRevision: 0, proposal: p });
    const records = [{ gate: 'proposal', digest, instructionRevision: 0, proposalFingerprint: 'REPLACED' }];
    // Records are matched by the proposal's own fingerprint.
    const fingerprint = (verifyRestoredContract([], p, 0) as { ok: boolean }).ok;
    expect(fingerprint).toBe(true); // legacy task: nothing recorded
    expect(verifyRestoredContract(records, p, 0)).toMatchObject({ ok: false }); // records exist, none for THIS proposal
  });
});

describe('M42 failure classification', () => {
  function result(over: Partial<GovernedCodingExecutionResult>): GovernedCodingExecutionResult {
    return {
      runId: 'r',
      status: 'invalid_proposal',
      validations: [],
      validationHistory: [],
      repairAttempts: 0,
      validationPhase: { status: 'not_started' },
      ...over,
    };
  }
  const ctx = { attemptId: 'att', pass: 1 };

  const table: Array<{ name: string; result: Partial<GovernedCodingExecutionResult>; cause: string; subcode?: string }> = [
    { name: 'operation_content_required with unread targets is grounding, not format', result: { status: 'invalid_proposal', failureReason: 'operation_content_required', attemptedPaths: ['src/a.ts'] }, cause: 'grounding_failure', subcode: 'operation_content_required' },
    { name: 'malformed proposal is a format failure', result: { status: 'invalid_proposal', failureReason: 'operation_malformed, operations_empty' }, cause: 'format_failure', subcode: 'operation_malformed' },
    { name: 'scope mismatch with the approved validation plan is semantic', result: { status: 'invalid_proposal', failureReason: 'validation_command_scope_uncovered' }, cause: 'semantic_failure', subcode: 'validation_command_scope_uncovered' },
    { name: 'a security rejection is a policy boundary', result: { status: 'invalid_proposal', failureReason: 'path_uri_scheme_rejected' }, cause: 'policy_boundary', subcode: 'path_uri_scheme_rejected' },
    { name: 'an unreachable provider is a provider failure', result: { status: 'proposal_unavailable', failureReason: 'provider_unavailable' }, cause: 'provider_failure', subcode: 'provider_unavailable' },
    { name: 'an unusable model response is a format failure', result: { status: 'proposal_unavailable', failureReason: 'empty_content' }, cause: 'format_failure' },
    { name: 'ungrounded proposal', result: { status: 'grounding_failed', groundingMissing: [{ path: 'src/a.ts', reason: 'stale_content' }] }, cause: 'grounding_failure', subcode: 'stale_content' },
    { name: 'insufficient context is missing evidence', result: { status: 'insufficient_context_reported' }, cause: 'grounding_failure', subcode: 'insufficient_context' },
    { name: 'a no-change claim is semantic and never success', result: { status: 'no_change_claim_reported' }, cause: 'semantic_failure', subcode: 'no_change_claim' },
    { name: 'create target exists contradicts the repository', result: { status: 'create_target_exists' }, cause: 'semantic_failure', subcode: 'create_target_exists' },
    { name: 'a workspace that moved after review invalidates the snapshot', result: { status: 'workspace_changed_after_review' }, cause: 'grounding_failure', subcode: 'stale_snapshot' },
    { name: 'the catch-all mutation_failed still exposes a provider fault when nothing mutated', result: { status: 'mutation_failed', errorCode: 'ECONNREFUSED 127.0.0.1:11434' }, cause: 'provider_failure' },
    { name: 'a genuine mutation fault stays environmental and uncertain', result: { status: 'mutation_failed', errorCode: 'write failed', mutation: { filesCreated: ['a'], filesModified: [], filesDeleted: [], filesRestored: [], rollbackAttempted: false, rollbackSucceeded: false } }, cause: 'environment_failure', subcode: 'mutation_failed' },
    { name: 'a human rejection is a boundary, not something to recover around', result: { status: 'execution_rejected' }, cause: 'policy_boundary', subcode: 'human_rejected' },
    { name: 'readiness failures are environmental', result: { status: 'readiness_blocked' }, cause: 'environment_failure', subcode: 'readiness_blocked' },
  ];
  for (const row of table) {
    it(row.name, () => {
      const outcome = classifyExecutionResult(result(row.result), ctx);
      expect(outcome.ok).toBe(false);
      expect(outcome.cause).toBe(row.cause);
      if (row.subcode) expect(outcome.subcode).toBe(row.subcode);
      expect(outcome.status).toBe(row.result.status);
    });
  }

  it('an unusable repair TURN is a format/provider failure of the model, not "nothing changed"', () => {
    const failing = [{ command: 'npm test', exitCode: 1, durationMs: 5, timedOut: false, output: 'AssertionError: expected 1 to be 2' }];
    const format = classifyExecutionResult(result({ status: 'validation_failed', validations: failing, repairStopReason: 'unavailable', repairStopDetail: ['unavailable', 'operations_empty'] }), ctx);
    expect(format.cause).toBe('format_failure');
    expect(format.subcode).toBe('validation_repair_unavailable');
    expect(format.facts.validationFailures).toHaveLength(1); // the underlying defect is still on record
    const provider = classifyExecutionResult(result({ status: 'validation_failed', validations: failing, repairStopReason: 'unavailable', repairStopDetail: ['unavailable', 'provider_unavailable'] }), ctx);
    expect(provider.cause).toBe('provider_failure');
    const exhausted = classifyExecutionResult(result({ status: 'validation_failed', validations: failing, repairStopReason: 'exhausted' }), ctx);
    expect(exhausted.cause).toBe('validation_failure');
  });

  it('a completed run is a successful StageOutcome, not a failure', () => {
    const outcome = classifyExecutionResult(result({ status: 'completed', validationPhase: { status: 'completed', applicableCommandCount: 1, failedCommandCount: 0 } }), ctx);
    expect(outcome.ok).toBe(true);
    expect(outcome.cause).toBeUndefined();
    expect(outcome.stage).toBe('validation');
  });

  it('operation_content_required names the unread proposal targets so the runtime can supply them', () => {
    const outcome = classifyExecutionResult(result({ status: 'invalid_proposal', failureReason: 'operation_content_required', attemptedPaths: ['src/pricing.ts'], filesRead: [] }), ctx);
    expect(outcome.facts.groundingMissing).toEqual([{ path: 'src/pricing.ts', reason: 'never_read' }]);
    // Falls back to files the task text names when the proposal carried none.
    const fallback = classifyExecutionResult(result({ status: 'invalid_proposal', failureReason: 'operation_content_required' }), { ...ctx, fallbackPaths: ['src/named.ts'] });
    expect(fallback.facts.groundingMissing).toEqual([{ path: 'src/named.ts', reason: 'never_read' }]);
  });

  describe('validation failure kinds', () => {
    const vr = (command: string, output: string, over: { exitCode?: number | null; timedOut?: boolean } = {}) => ({
      command,
      exitCode: over.exitCode === undefined ? 1 : over.exitCode,
      durationMs: 5,
      timedOut: over.timedOut ?? false,
      output,
    });
    it('separates code defects, regressions, environment, invalid assumptions and tool failures', () => {
      expect(validationFailureFacts([vr('npm test', 'AssertionError: expected 1 to be 2')])[0].kind).toBe('code_defect');
      expect(validationFailureFacts([vr('npm test', 'AssertionError: expected 1 to be 2')], new Set(['npm test']))[0].kind).toBe('regression');
      expect(validationFailureFacts([vr('npm test', "Error: Cannot find module 'left-pad'")])[0].kind).toBe('environment');
      expect(validationFailureFacts([vr('npm test', "Error: Cannot find module './local'")])[0].kind).toBe('code_defect');
      expect(validationFailureFacts([vr('npm run x', 'npm ERR! Missing script: "x"')])[0].kind).toBe('invalid_assumption');
      expect(validationFailureFacts([vr('vitest', 'No test files found, exiting with code 1')])[0].kind).toBe('invalid_assumption');
      expect(validationFailureFacts([vr('npm test', '', { timedOut: true, exitCode: null })])[0].kind).toBe('tool_failure');
      expect(validationFailureFacts([vr('npm test', 'ok', { exitCode: 0 })])).toEqual([]);
    });

    it('environment-only failures classify as environment_failure; mixed code defects stay validation_failure', () => {
      const env = classifyExecutionResult(result({ status: 'validation_failed', validations: [vr('npm test', "Cannot find module 'left-pad'")] }), ctx);
      expect(env.cause).toBe('environment_failure');
      expect(env.subcode).toBe('validation_environment');
      const code = classifyExecutionResult(result({ status: 'validation_failed', validations: [vr('npm test', "Cannot find module 'left-pad'"), vr('tsc', 'src/a.ts(3,1): error TS2322: bad')] }), ctx);
      expect(code.cause).toBe('validation_failure');
      expect(code.subcode).toBe('code_defect');
      expect(code.facts.validationFailures.find(failure => failure.command === 'tsc')?.namedPaths).toContain('src/a.ts');
    });

    it('failure signatures ignore volatile timings/hashes so an identical failure fingerprints identically', () => {
      const a = classifyExecutionResult(result({ status: 'validation_failed', validations: [vr('npm test', 'FAIL 12ms AssertionError: expected 1 to be 2 (abcdef1234567)')] }), ctx);
      const b = classifyExecutionResult(result({ status: 'validation_failed', validations: [vr('npm test', 'FAIL 987ms AssertionError: expected 1 to be 2 (0011223344556)')] }), ctx);
      expect(a.fingerprints.failure).toBe(b.fingerprints.failure);
      const other = classifyExecutionResult(result({ status: 'validation_failed', validations: [vr('npm test', 'FAIL TypeError: cannot read properties of undefined')] }), ctx);
      expect(other.fingerprints.failure).not.toBe(a.fingerprints.failure);
    });
  });
});

describe('M42 recovery model candidates', () => {
  const base: RecoveryCandidate = {
    provider: 'ollama',
    model: 'm:7b',
    local: true,
    available: true,
    capability: { chat: true, structuredOutput: true, embeddingOnly: false, allowedRoles: [], contextWindow: 8192 },
  };
  it('excludes embedding-only, autocomplete-only, unavailable and non-structured models; honours minimum context', () => {
    expect(isCapableForRecovery(base)).toBe(true);
    expect(isCapableForRecovery({ ...base, capability: { ...base.capability, embeddingOnly: true } })).toBe(false);
    expect(isCapableForRecovery({ ...base, capability: { ...base.capability, allowedRoles: ['autocomplete'] } })).toBe(false);
    expect(isCapableForRecovery({ ...base, available: false })).toBe(false);
    expect(isCapableForRecovery({ ...base, capability: { ...base.capability, structuredOutput: false } })).toBe(false);
    expect(isCapableForRecovery(base, 32768)).toBe(false);
  });

  it('never picks a model already attempted on this task and reports truthfully when none is left', () => {
    const choice = selectRecoveryModel({
      cause: 'provider_failure',
      current: { provider: 'ollama', model: 'a' },
      attempted: ['ollama/a', 'ollama/b'],
      candidates: [{ ...base, model: 'a' }, { ...base, model: 'b' }],
      policy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
    });
    expect(choice).toMatchObject({ kind: 'none', reason: 'no_capable_untried_model' });
  });

  it('a grounding failure is never model-shaped', () => {
    expect(selectRecoveryModel({
      cause: 'grounding_failure',
      current: {},
      attempted: [],
      candidates: [base],
      policy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: true },
    })).toMatchObject({ kind: 'none', reason: 'not_model_shaped' });
  });
});

describe('M42 accounting reconciliation (Slice-1 gaps)', () => {
  it('the M16 quality gate and the deterministic diff reviewer make no provider/model dispatch, so they have no model calls to account', async () => {
    const forbidden = /providers\/|agent\/(?:Governed|LocalFirst|ProviderGateway)|ProviderGateway|GovernedModelExecutionDispatcher|\.chat\(|listModels\(/;
    for (const file of ['src/evals/M16QualityEvaluation.ts', 'src/coding/DiffReview.ts', 'src/coding/DiffReviewStage.ts']) {
      const source = await fs.readFile(path.join(process.cwd(), file), 'utf8');
      const imports = source.split('\n').filter(line => /^\s*import\b/.test(line) || /\brequire\(/.test(line));
      expect(imports.filter(line => forbidden.test(line)), `${file} imports a model dispatch path`).toEqual([]);
      expect(forbidden.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), `${file} calls a provider`).toBe(false);
    }
  });
});

describe('M42 progress rendering', () => {
  it('renders recovery decisions and stops with truthful, human-readable titles', () => {
    const reinvestigate = parseAutonomousProgressPhase('recovery_decision seq=1 action=REINVESTIGATE cause=grounding_failure subcode=operation_content_required change=new_evidence');
    expect(reinvestigate.kind).toBe('recovery_decision');
    expect(reinvestigate.title).toBe('Gathering missing evidence and re-investigating');
    expect(reinvestigate.detail).toContain('What changes next: new evidence');
    const stop = parseAutonomousProgressPhase('recovery_decision seq=4 action=BLOCK cause=no_progress subcode=create_target_exists terminal=NO_PROGRESS');
    expect(stop.kind).toBe('recovery_stopped');
    expect(stop.title).toContain('no progress');
    const change = parseAutonomousProgressPhase('recovery_decision seq=2 action=CHANGE_MODEL cause=format_failure subcode=x change=changed_model model=ollama/strong:32b');
    expect(change.detail.join('\n')).toContain('Model: ollama/strong:32b');
    expect(parseAutonomousProgressPhase('recovery_resume_validation mutation_already_applied=true').title).toBe('Resuming at validation');
    expect(parseAutonomousProgressPhase('proposal_ungrounded paths=src/a.ts:never_read').kind).toBe('proposal_ungrounded');
  });
});

describe('M42 runtime evidence supply is boundary-safe', () => {
  it('seed paths are untrusted: traversal, absolute, credential and missing paths are never read or shown; a real file is supplied and recorded', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm42-seed-'));
    try {
      await fs.mkdir(path.join(root, 'work', 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'secret-outside.txt'), 'TOP-SECRET-OUTSIDE');
      await fs.writeFile(path.join(root, 'work', '.env'), 'TOKEN=TOP-SECRET-ENV');
      await fs.writeFile(path.join(root, 'work', 'src', 'a.ts'), 'export const a = 1;\n');
      const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_seed' });
      const { ExecutionRecoverySession } = await import('../../autonomous/recovery/ExecutionRecoverySession');
      const session = new ExecutionRecoverySession({
        journal,
        workspaceRoot: path.join(root, 'work'),
        attemptId: 'att',
        pass: 1,
        resolveBaseRevision: async () => 'base-1',
        seedEvidencePaths: ['../secret-outside.txt', path.join(root, 'secret-outside.txt'), '.env', 'src/missing.ts', 'src/a.ts'],
        guidance: ['Recovery: test guidance.'],
      });
      const rendered = await session.renderRecoveryContext();
      expect(rendered).not.toContain('TOP-SECRET');
      expect(rendered).toContain('export const a = 1;');
      expect(rendered).toContain('Runtime recovery notes');
      expect(rendered.match(/cannot be supplied/g)?.length).toBe(3);
      expect(rendered).toContain('does not exist');
      expect(journal.state.evidence.has('src/a.ts')).toBe(true);
      expect(journal.state.evidence.has('.env')).toBe(false);
      expect(journal.state.negativeSearches.length).toBeGreaterThanOrEqual(4);
      // The supplied read is admissible grounding for that file, and only that file.
      const grounded = await session.checkGrounding([{ type: 'replace', path: 'src/a.ts' }]);
      expect(grounded.ok).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
