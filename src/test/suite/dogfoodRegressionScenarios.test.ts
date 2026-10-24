import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  CodingProposal,
  validateCodingProposal,
  hasExplicitFileDeletionIntent,
  hasModifyIntent,
  normalizeOperationType,
} from '../../coding/CodingProposal';
import {
  WorkspaceMutationEngine,
  WorkspaceSnapshotBinder,
} from '../../coding/WorkspaceMutation';
import {
  runDiffReviewStage,
} from '../../coding/DiffReviewStage';
import {
  cleanupGeneratedArtifacts,
  captureGeneratedArtifactBaseline,
  isGeneratedArtifactPath,
} from '../../coding/GeneratedArtifactPolicy';
import {
  reconcileChangeScope,
  changeScopeIsCommittable,
} from '../../coding/ChangeScopeReconciliation';
import {
  GovernedCodingExecutor,
  verifyMutationEvidence,
} from '../../coding/GovernedCodingExecutor';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout;
}

describe('Real Regression Dogfood Scenarios', () => {
  let rootA: string;
  let rootB: string;
  let rootC: string;

  beforeEach(async () => {
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'dogfood-a-'));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'dogfood-b-'));
    rootC = await fs.mkdtemp(path.join(os.tmpdir(), 'dogfood-c-'));
  });

  afterEach(async () => {
    await fs.rm(rootA, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(rootB, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(rootC, { recursive: true, force: true }).catch(() => undefined);
  });

  it('Dogfood A — Original corruption class: Modify intent must never delete file', async () => {
    // 1. Setup disposable repository with Python code
    await git(rootA, ['init']);
    await git(rootA, ['config', 'user.email', 'dogfood@example.com']);
    await git(rootA, ['config', 'user.name', 'Dogfood']);
    await git(rootA, ['config', 'core.quotepath', 'false']);

    const srcDir = path.join(rootA, 'src', 'ordercalc');
    await fs.mkdir(srcDir, { recursive: true });
    const pricingFile = path.join(srcDir, 'pricing.py');
    await fs.writeFile(
      pricingFile,
      'def calculate_total(price, quantity):\n    return price + quantity\n',
      'utf8',
    );

    const testDir = path.join(rootA, 'tests');
    await fs.mkdir(testDir, { recursive: true });
    const testFile = path.join(testDir, 'test_pricing.py');
    await fs.writeFile(
      testFile,
      'from src.ordercalc.pricing import calculate_total\n\ndef test_calculate_total():\n    assert calculate_total(10, 5) == 50\n',
      'utf8',
    );

    await git(rootA, ['add', '.']);
    await git(rootA, ['commit', '-m', 'Initial baseline']);

    const initialStatus = await git(rootA, ['status', '--short']);
    expect(initialStatus.trim()).toBe('');

    // 2. Scenario 1: Model generates sloppy proposal with "remove" language
    // "remove the obsolete addition logic from pricing.py"
    const sloppyReason = 'remove the obsolete addition logic from pricing.py';
    const taskSummary = 'Fix calculate_total so that it multiplies price by quantity. Preserve the existing file and unrelated behavior.';

    // Test normalizeOperationType invariants directly
    expect(hasModifyIntent(sloppyReason)).toBe(true);
    expect(hasExplicitFileDeletionIntent(sloppyReason, taskSummary, 'src/ordercalc/pricing.py')).toBe(false);

    // If model returned type 'delete' without content for this modification goal:
    const invalidDeleteProposal: CodingProposal = {
      version: 1,
      taskSummary,
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: sloppyReason,
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      limits: {},
      warnings: [],
      status: 'proposed',
    };

    // Validation MUST reject this with delete_intent_mismatch (FAIL CLOSED)
    const invalidValidation = validateCodingProposal(invalidDeleteProposal, []);
    expect(invalidValidation.ok).toBe(false);
    expect(invalidValidation.errors).toContain('delete_intent_mismatch');

    // And WorkspaceMutationEngine MUST reject it before any filesystem mutation
    const binder = new WorkspaceSnapshotBinder(rootA);
    const boundInvalid = await binder.bind(invalidDeleteProposal);
    const mutator = new WorkspaceMutationEngine(rootA);
    await expect(mutator.apply(boundInvalid)).rejects.toThrow(/delete_intent_mismatch/);

    // Verify source file still exists and was NOT deleted
    expect(await fs.readFile(pricingFile, 'utf8')).toContain('return price + quantity');

    // 3. Scenario 2: Valid replace proposal with proper implementation
    const fixedContent = 'def calculate_total(price, quantity):\n    return price * quantity\n';
    const validProposal: CodingProposal = {
      version: 1,
      taskSummary,
      operations: [{
        type: 'replace',
        path: 'src/ordercalc/pricing.py',
        reason: 'Fix calculate_total to multiply price by quantity',
        content: fixedContent,
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      limits: {},
      warnings: [],
      status: 'proposed',
    };

    // Validation passes
    const validValidation = validateCodingProposal(validProposal, []);
    expect(validValidation.ok).toBe(true);
    expect(validValidation.errors).toEqual([]);

    // Snapshot binding and mutation apply
    const boundValid = await binder.bind(validProposal);
    const mutationResult = await mutator.apply(boundValid);

    // Verify mutation result: file was modified, NOT deleted
    expect(mutationResult.filesModified).toEqual(['src/ordercalc/pricing.py']);
    expect(mutationResult.filesDeleted).toEqual([]);
    expect(mutationResult.filesCreated).toEqual([]);

    // Verify evidence verification succeeds
    const evidence = await verifyMutationEvidence(rootA, boundValid, 0, mutationResult);
    expect(evidence.contentVerified).toBe(true);
    expect(evidence.gitDiffPresent).toBe(true);

    // Diff review stage passes
    const diffVerdict = await runDiffReviewStage({
      workspaceRoot: rootA,
      verifiedProposal: validProposal,
      approvedScopePaths: ['src/ordercalc/pricing.py'],
      validationResults: [{ command: 'git diff --check', exitCode: 0, timedOut: false }],
      qualityGateStatus: 'passed',
      originalTaskGoal: taskSummary,
    });
    expect(diffVerdict.verdict).toBe('pass');
    expect(diffVerdict.changedFileFindings).toEqual([]);

    // Verify file content on disk
    const onDisk = await fs.readFile(pricingFile, 'utf8');
    expect(onDisk).toBe(fixedContent);

    // Capture final git status and diff
    const finalStatus = await git(rootA, ['status', '--short']);
    const finalDiff = await git(rootA, ['diff']);
    console.log('=== DOGFOOD A FINAL STATUS ===\n' + finalStatus);
    console.log('=== DOGFOOD A FINAL DIFF ===\n' + finalDiff);

    expect(finalStatus.trim()).toBe('M src/ordercalc/pricing.py');
    expect(finalDiff).toContain('-    return price + quantity');
    expect(finalDiff).toContain('+    return price * quantity');
  });

  it('Dogfood B — Legitimate deletion: Explicit file deletion succeeds without disabling valid deletions', async () => {
    // 1. Setup disposable repository with an active file and an obsolete file
    await git(rootB, ['init']);
    await git(rootB, ['config', 'user.email', 'dogfood@example.com']);
    await git(rootB, ['config', 'user.name', 'Dogfood']);
    await git(rootB, ['config', 'core.quotepath', 'false']);

    const srcDir = path.join(rootB, 'src', 'ordercalc');
    await fs.mkdir(srcDir, { recursive: true });
    const pricingFile = path.join(srcDir, 'pricing.py');
    await fs.writeFile(pricingFile, 'def calculate_total(p, q): return p * q\n', 'utf8');

    const obsoleteFile = path.join(srcDir, 'obsolete_file.py');
    await fs.writeFile(obsoleteFile, '# Deprecated legacy helper\ndef old_helper(): pass\n', 'utf8');

    await git(rootB, ['add', '.']);
    await git(rootB, ['commit', '-m', 'Initial baseline with obsolete file']);

    // 2. Task: Legitimate whole-file deletion
    const taskSummary = 'Delete obsolete_file.py from the repository because it is no longer used. Do not modify unrelated files.';
    const deleteReason = 'Delete obsolete_file.py from the repository because it is no longer used';

    expect(hasExplicitFileDeletionIntent(deleteReason, taskSummary, 'src/ordercalc/obsolete_file.py')).toBe(true);

    const deleteProposal: CodingProposal = {
      version: 1,
      taskSummary,
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/obsolete_file.py',
        reason: deleteReason,
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      limits: {},
      warnings: [],
      status: 'proposed',
    };

    // Proposal validation passes
    const deleteValidation = validateCodingProposal(deleteProposal, []);
    expect(deleteValidation.ok).toBe(true);
    expect(deleteValidation.errors).toEqual([]);

    // Snapshot binding and mutation execution
    const binder = new WorkspaceSnapshotBinder(rootB);
    const bound = await binder.bind(deleteProposal);
    const mutator = new WorkspaceMutationEngine(rootB);
    const mutationResult = await mutator.apply(bound);

    // Verify evidence: recorded as deleted, NOT modified or created
    expect(mutationResult.filesDeleted).toEqual(['src/ordercalc/obsolete_file.py']);
    expect(mutationResult.filesModified).toEqual([]);
    expect(mutationResult.filesCreated).toEqual([]);

    // Verify obsolete file is GONE from disk
    const fileExists = await fs.stat(obsoleteFile).catch(() => undefined);
    expect(fileExists).toBeUndefined();

    // Verify active file remains untouched
    const pricingContent = await fs.readFile(pricingFile, 'utf8');
    expect(pricingContent).toBe('def calculate_total(p, q): return p * q\n');

    // Verify evidence verification passes
    const evidence = await verifyMutationEvidence(rootB, bound, 0, mutationResult);
    expect(evidence.contentVerified).toBe(true);
    expect(evidence.gitDiffPresent).toBe(true);

    // Diff review stage passes
    const diffVerdict = await runDiffReviewStage({
      workspaceRoot: rootB,
      verifiedProposal: deleteProposal,
      approvedScopePaths: ['src/ordercalc/obsolete_file.py'],
      validationResults: [{ command: 'git diff --check', exitCode: 0, timedOut: false }],
      qualityGateStatus: 'passed',
      originalTaskGoal: taskSummary,
    });
    expect(diffVerdict.verdict).toBe('pass');
    expect(diffVerdict.changedFileFindings).toEqual([]);

    // Capture final git status and diff
    const finalStatus = await git(rootB, ['status', '--short']);
    const finalDiff = await git(rootB, ['diff']);
    console.log('=== DOGFOOD B FINAL STATUS ===\n' + finalStatus);
    console.log('=== DOGFOOD B FINAL DIFF ===\n' + finalDiff);

    expect(finalStatus.trim()).toBe('D src/ordercalc/obsolete_file.py');
    expect(finalDiff).toContain('deleted file mode');
    expect(finalDiff).toContain('--- a/src/ordercalc/obsolete_file.py');
  });

  it('Dogfood C — Pytest artifact pollution & pre-existing untracked state preservation', async () => {
    // 1. Setup disposable repository with Python source and tests
    await git(rootC, ['init']);
    await git(rootC, ['config', 'user.email', 'dogfood@example.com']);
    await git(rootC, ['config', 'user.name', 'Dogfood']);
    await git(rootC, ['config', 'core.quotepath', 'false']);

    const srcDir = path.join(rootC, 'src', 'ordercalc');
    await fs.mkdir(srcDir, { recursive: true });
    const pricingFile = path.join(srcDir, 'pricing.py');
    await fs.writeFile(pricingFile, 'def calculate_total(p, q): return 0\n', 'utf8');

    await git(rootC, ['add', '.']);
    await git(rootC, ['commit', '-m', 'Initial baseline']);

    // 2. Pre-existing untracked artifacts present BEFORE the autonomous task starts:
    // (a) Pre-existing untracked __pycache__ bytecode
    const preExistingPycacheDir = path.join(srcDir, '__pycache__');
    await fs.mkdir(preExistingPycacheDir, { recursive: true });
    const preExistingPyc = path.join(preExistingPycacheDir, 'module.cpython-313.pyc');
    await fs.writeFile(preExistingPyc, 'pre-existing untracked bytecode', 'utf8');

    // (b) Pre-existing untracked .pytest_cache folder
    const preExistingPytestCache = path.join(rootC, '.pytest_cache');
    await fs.mkdir(preExistingPytestCache, { recursive: true });
    const pytestCacheFile = path.join(preExistingPytestCache, 'cache.json');
    await fs.writeFile(pytestCacheFile, '{"pre_existing": true}', 'utf8');

    // Verify git status before run shows ?? for the untracked artifacts
    const preRunStatus = await git(rootC, ['status', '--porcelain', '--untracked-files=all']);
    expect(preRunStatus).toContain('?? src/ordercalc/__pycache__/module.cpython-313.pyc');
    expect(preRunStatus).toContain('?? .pytest_cache/cache.json');

    // 3. Runtime starts: capture generated artifact baseline BEFORE mutation/validation
    const baselineArtifacts = await captureGeneratedArtifactBaseline(rootC);
    expect(baselineArtifacts.has('src/ordercalc/__pycache__/module.cpython-313.pyc')).toBe(true);
    expect(baselineArtifacts.has('.pytest_cache/cache.json')).toBe(true);

    // 4. Task executes mutation on pricing.py
    const taskSummary = 'Update calculate_total implementation';
    const proposal: CodingProposal = {
      version: 1,
      taskSummary,
      operations: [{
        type: 'replace',
        path: 'src/ordercalc/pricing.py',
        reason: 'Update calculate_total',
        content: 'def calculate_total(p, q): return p * q\n',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      limits: {},
      warnings: [],
      status: 'proposed',
    };

    const binder = new WorkspaceSnapshotBinder(rootC);
    const bound = await binder.bind(proposal);
    const mutator = new WorkspaceMutationEngine(rootC);
    await mutator.apply(bound);

    // 5. Validation runs (e.g. pytest) and produces a NEW generated artifact during this run
    const testPycacheDir = path.join(rootC, 'tests', '__pycache__');
    await fs.mkdir(testPycacheDir, { recursive: true });
    const newRunPyc = path.join(testPycacheDir, 'test_pricing.cpython-313.pyc');
    await fs.writeFile(newRunPyc, 'new run bytecode', 'utf8');

    // 6. Cleanup runs with the pre-captured baseline
    const cleanupResult = await cleanupGeneratedArtifacts(rootC, { baselineArtifacts });

    // Invariant: newly created artifact IS cleaned
    expect(cleanupResult.cleanedFiles).toContain('tests/__pycache__/test_pricing.cpython-313.pyc');
    const newPycExists = await fs.stat(newRunPyc).catch(() => undefined);
    expect(newPycExists).toBeUndefined();

    // Invariant: pre-existing untracked artifacts are PRESERVED
    expect(cleanupResult.preservedBaselineFiles).toContain('src/ordercalc/__pycache__/module.cpython-313.pyc');
    expect(cleanupResult.preservedBaselineFiles).toContain('.pytest_cache/cache.json');
    expect(await fs.readFile(preExistingPyc, 'utf8')).toBe('pre-existing untracked bytecode');
    expect(await fs.readFile(pytestCacheFile, 'utf8')).toBe('{"pre_existing": true}');

    // 7. Diff review runs: untracked generated artifacts do NOT block diff review
    const diffVerdict = await runDiffReviewStage({
      workspaceRoot: rootC,
      verifiedProposal: proposal,
      approvedScopePaths: ['src/ordercalc/pricing.py'],
      validationResults: [{ command: 'pytest', exitCode: 0, timedOut: false }],
      qualityGateStatus: 'passed',
      originalTaskGoal: taskSummary,
      baselineArtifacts,
    });
    expect(diffVerdict.verdict).toBe('pass');
    expect(diffVerdict.changedFileFindings).toEqual([]);

    // 8. Scope reconciliation test:
    // Case 8a: Approved change + pre-existing untracked generated artifacts -> committable
    const committableScope = reconcileChangeScope(
      ['src/ordercalc/pricing.py'],
      ['src/ordercalc/pricing.py'],
    );
    expect(changeScopeIsCommittable(committableScope)).toBe(true);

    // Case 8b: An unexpected real source file created during run -> deterministically rejected
    const unexpectedRealSource = path.join(srcDir, 'unexpected.py');
    await fs.writeFile(unexpectedRealSource, 'def rogue(): pass\n', 'utf8');

    const blockedScope = reconcileChangeScope(
      ['src/ordercalc/pricing.py'],
      ['src/ordercalc/pricing.py', 'src/ordercalc/unexpected.py'],
    );
    expect(changeScopeIsCommittable(blockedScope)).toBe(false);
    expect(blockedScope.unexpected).toEqual(['src/ordercalc/unexpected.py']);

    // Remove unexpected file to restore clean dogfood repo
    await fs.rm(unexpectedRealSource);

    // Capture final git status and diff
    const finalStatus = await git(rootC, ['status', '--short']);
    const finalDiff = await git(rootC, ['diff']);
    console.log('=== DOGFOOD C FINAL STATUS ===\n' + finalStatus);
    console.log('=== DOGFOOD C FINAL DIFF ===\n' + finalDiff);

    // In status: pricing.py is modified, pre-existing untracked artifacts remain untracked (??), new pyc is gone!
    expect(finalStatus).toContain('M src/ordercalc/pricing.py');
    expect(finalStatus).toContain('?? .pytest_cache/');
    expect(finalStatus).toContain('?? src/ordercalc/__pycache__/');
    expect(finalStatus).not.toContain('tests/__pycache__');
  });
});
