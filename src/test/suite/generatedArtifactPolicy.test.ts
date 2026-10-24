import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  isGeneratedArtifactPath,
  excludeGeneratedArtifactPaths,
  cleanupGeneratedArtifacts,
  isPreExistingBaselinePath,
  captureGeneratedArtifactBaseline,
} from '../../coding/GeneratedArtifactPolicy';
import { reconcileChangeScope, changeScopeIsCommittable } from '../../coding/ChangeScopeReconciliation';
import { runDiffReviewStage } from '../../coding/DiffReviewStage';
import { CodingProposal } from '../../coding/CodingProposal';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout;
}

describe('Canonical Generated Artifact Policy (P0 Bug 2)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-artifact-'));
    for (const args of [
      ['init'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'Test'],
      ['config', 'core.quotepath', 'false'],
    ]) {
      await git(root, args);
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('correctly classifies __pycache__, *.pyc, and .pytest_cache at any depth', () => {
    expect(isGeneratedArtifactPath('src/ordercalc/__pycache__/__init__.cpython-314.pyc')).toBe(true);
    expect(isGeneratedArtifactPath('src/ordercalc/__pycache__/pricing.cpython-314.pyc')).toBe(true);
    expect(isGeneratedArtifactPath('tests/__pycache__/test_pricing.cpython-314-pytest-9.1.1.pyc')).toBe(true);
    expect(isGeneratedArtifactPath('.pytest_cache/v/cache/nodeids')).toBe(true);
    expect(isGeneratedArtifactPath('some/deep/path/.pytest_cache/cache.json')).toBe(true);
    expect(isGeneratedArtifactPath('root_compiled.pyc')).toBe(true);
    expect(isGeneratedArtifactPath('nested/compiled.pyo')).toBe(true);
    expect(isGeneratedArtifactPath('extension.vsix')).toBe(true);
    expect(isGeneratedArtifactPath('dist/bundle.js')).toBe(true);
    expect(isGeneratedArtifactPath('.ollama-agent/tasks/state.json')).toBe(true);

    // Real source files must NOT be classified as generated
    expect(isGeneratedArtifactPath('src/ordercalc/pricing.py')).toBe(false);
    expect(isGeneratedArtifactPath('tests/test_pricing.py')).toBe(false);
    expect(isGeneratedArtifactPath('src/.ollama-agent/user.ts')).toBe(false);
    expect(isGeneratedArtifactPath('src/pycache_lookalike.py')).toBe(false);
  });

  it('excludes generated artifact paths from actual changed lists', () => {
    const mixed = [
      'src/ordercalc/pricing.py',
      'src/ordercalc/__pycache__/pricing.cpython-314.pyc',
      'tests/__pycache__/test_pricing.cpython-314-pytest-9.1.1.pyc',
      '.pytest_cache/README.md',
      'src/ordercalc/new_file.py',
    ];
    const filtered = excludeGeneratedArtifactPaths(mixed);
    expect(filtered).toEqual(['src/ordercalc/pricing.py', 'src/ordercalc/new_file.py']);
  });

  it('reconcileChangeScope ignores untracked generated artifacts instead of failing diff review', () => {
    const approved = ['src/ordercalc/pricing.py'];
    const actual = [
      'src/ordercalc/pricing.py',
      'src/ordercalc/__pycache__/__init__.cpython-314.pyc',
      'src/ordercalc/__pycache__/pricing.cpython-314.pyc',
      'tests/__pycache__/test_pricing.cpython-314-pytest-9.1.1.pyc',
    ];

    const result = reconcileChangeScope(approved, actual);
    expect(result.approved).toEqual(['src/ordercalc/pricing.py']);
    expect(result.unexpected).toEqual([]);
    expect(changeScopeIsCommittable(result)).toBe(true);
  });

  it('unexpected source file still causes deterministic diff rejection', () => {
    const approved = ['src/ordercalc/pricing.py'];
    const actual = [
      'src/ordercalc/pricing.py',
      'src/ordercalc/__pycache__/pricing.cpython-314.pyc',
      'src/ordercalc/unexpected_helper.py',
    ];

    const result = reconcileChangeScope(approved, actual);
    expect(result.approved).toEqual(['src/ordercalc/pricing.py']);
    expect(result.unexpected).toEqual(['src/ordercalc/unexpected_helper.py']);
    expect(changeScopeIsCommittable(result)).toBe(false);
  });

  it('pytest-generated __pycache__ and *.pyc are cleaned up before final diff', async () => {
    // Initial baseline commit
    await fs.mkdir(path.join(root, 'src', 'ordercalc'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'ordercalc', 'pricing.py'), 'def price(): pass\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);

    // Simulate validation running pytest, generating __pycache__ and .pytest_cache
    const pycacheDir = path.join(root, 'src', 'ordercalc', '__pycache__');
    await fs.mkdir(pycacheDir, { recursive: true });
    await fs.writeFile(path.join(pycacheDir, 'pricing.cpython-314.pyc'), 'bytecode');

    const pytestCacheDir = path.join(root, '.pytest_cache');
    await fs.mkdir(pytestCacheDir, { recursive: true });
    await fs.writeFile(path.join(pytestCacheDir, 'cache.json'), '{}');

    // Run cleanup
    const cleanupResult = await cleanupGeneratedArtifacts(root);
    expect(cleanupResult.cleanedFiles.length).toBeGreaterThan(0);

    // Verify __pycache__ file is gone
    const pycExists = await fs.stat(path.join(pycacheDir, 'pricing.cpython-314.pyc')).catch(() => undefined);
    expect(pycExists).toBeUndefined();

    // Verify tracked pricing.py is still present
    expect(await fs.readFile(path.join(root, 'src', 'ordercalc', 'pricing.py'), 'utf8')).toBe('def price(): pass\n');
  });

  it('baseline-tracked generated-looking files are not silently deleted', async () => {
    // A repo where someone explicitly tracked a .pyc or fixture in git
    const legacyPath = path.join(root, 'legacy.pyc');
    await fs.writeFile(legacyPath, 'tracked bytecode fixture');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'tracked fixture']);

    // Verify baseline check identifies it as tracked
    const isBaseline = await isPreExistingBaselinePath(root, 'legacy.pyc');
    expect(isBaseline).toBe(true);

    // Run cleanup
    const cleanupResult = await cleanupGeneratedArtifacts(root);
    expect(cleanupResult.preservedBaselineFiles).toContain('legacy.pyc');

    // Verify file is NOT deleted
    expect(await fs.readFile(legacyPath, 'utf8')).toBe('tracked bytecode fixture');
  });

  it('runDiffReviewStage accepts validation-created artifacts after cleanup without diff rejection', async () => {
    // Initial baseline commit
    await fs.mkdir(path.join(root, 'src', 'ordercalc'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    const pricingPath = path.join(root, 'src', 'ordercalc', 'pricing.py');
    const testPricingPath = path.join(root, 'tests', 'test_pricing.py');
    await fs.writeFile(pricingPath, 'def compute_order_total(): return 0\n');
    await fs.writeFile(testPricingPath, 'def test_pricing(): assert True\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);

    // Simulate mutation: modify pricing.py
    await fs.writeFile(pricingPath, 'def compute_order_total(): return 42\n');

    // Simulate validation creating __pycache__ artifacts in both folders
    const pycache1 = path.join(root, 'src', 'ordercalc', '__pycache__');
    const pycache2 = path.join(root, 'tests', '__pycache__');
    await fs.mkdir(pycache1, { recursive: true });
    await fs.mkdir(pycache2, { recursive: true });
    await fs.writeFile(path.join(pycache1, 'pricing.cpython-314.pyc'), 'bytecode');
    await fs.writeFile(path.join(pycache2, 'test_pricing.cpython-314-pytest-9.1.1.pyc'), 'bytecode');

    const proposal: CodingProposal = {
      version: 1,
      taskSummary: 'Fix compute_order_total so the coupon is applied to merchandise before loyalty discount',
      operations: [{
        type: 'replace',
        path: 'src/ordercalc/pricing.py',
        reason: 'Fix compute_order_total logic',
        content: 'def compute_order_total(): return 42\n',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      limits: {},
      warnings: [],
      status: 'proposed',
    };

    const verdict = await runDiffReviewStage({
      workspaceRoot: root,
      verifiedProposal: proposal,
      approvedScopePaths: ['src/ordercalc/pricing.py'],
      validationResults: [{ command: 'pytest', exitCode: 0, timedOut: false }],
      qualityGateStatus: 'passed',
      originalTaskGoal: 'Fix compute_order_total so the coupon is applied to merchandise before loyalty discount',
    });

    expect(verdict.verdict).toBe('pass');
    expect(verdict.changedFileFindings).toEqual([]);
  });

  it('pre-existing untracked generated-looking files are preserved when baseline is captured', async () => {
    // Initial baseline commit with a source file
    await fs.mkdir(path.join(root, 'src', 'ordercalc'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'ordercalc', 'pricing.py'), 'def price(): pass\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);

    // Suppose BEFORE KarkeDikha begins, the user workspace already has untracked __pycache__ and .pytest_cache
    const pycacheDir = path.join(root, 'src', 'ordercalc', '__pycache__');
    await fs.mkdir(pycacheDir, { recursive: true });
    const pycFile = path.join(pycacheDir, 'preexisting.cpython-314.pyc');
    await fs.writeFile(pycFile, 'pre-existing bytecode');

    const pytestCacheDir = path.join(root, '.pytest_cache');
    await fs.mkdir(pytestCacheDir, { recursive: true });
    const pytestCacheFile = path.join(pytestCacheDir, 'preexisting_cache.json');
    await fs.writeFile(pytestCacheFile, '{"preexisting": true}');

    // Capture baseline before run
    const baseline = await captureGeneratedArtifactBaseline(root);
    expect(baseline.has('src/ordercalc/__pycache__/preexisting.cpython-314.pyc')).toBe(true);
    expect(baseline.has('.pytest_cache/preexisting_cache.json')).toBe(true);

    // Run cleanup with baseline
    const cleanupResult = await cleanupGeneratedArtifacts(root, { baselineArtifacts: baseline });
    expect(cleanupResult.preservedBaselineFiles).toContain('src/ordercalc/__pycache__/preexisting.cpython-314.pyc');
    expect(cleanupResult.preservedBaselineFiles).toContain('.pytest_cache/preexisting_cache.json');
    expect(cleanupResult.cleanedFiles).toEqual([]);

    // Both pre-existing untracked files must remain untouched
    expect(await fs.readFile(pycFile, 'utf8')).toBe('pre-existing bytecode');
    expect(await fs.readFile(pytestCacheFile, 'utf8')).toBe('{"preexisting": true}');
  });

  it('only generated artifacts introduced by the current run are eligible for cleanup', async () => {
    // Initial baseline commit
    await fs.mkdir(path.join(root, 'src', 'ordercalc'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'ordercalc', 'pricing.py'), 'def price(): pass\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);

    // Pre-existing untracked artifact in workspace
    const pycacheDir = path.join(root, 'src', 'ordercalc', '__pycache__');
    await fs.mkdir(pycacheDir, { recursive: true });
    const oldPyc = path.join(pycacheDir, 'old_preexisting.cpython-314.pyc');
    await fs.writeFile(oldPyc, 'old bytecode');

    // Baseline captured before mutation/validation
    const baseline = await captureGeneratedArtifactBaseline(root);

    // Run occurs: validation produces a NEW pyc file
    const newPyc = path.join(pycacheDir, 'new_run.cpython-314.pyc');
    await fs.writeFile(newPyc, 'new run bytecode');

    // Run cleanup with baseline
    const cleanupResult = await cleanupGeneratedArtifacts(root, { baselineArtifacts: baseline });

    // The newly introduced pyc must be cleaned up
    expect(cleanupResult.cleanedFiles).toContain('src/ordercalc/__pycache__/new_run.cpython-314.pyc');
    // The pre-existing untracked pyc must be preserved
    expect(cleanupResult.preservedBaselineFiles).toContain('src/ordercalc/__pycache__/old_preexisting.cpython-314.pyc');

    // oldPyc must still exist
    expect(await fs.readFile(oldPyc, 'utf8')).toBe('old bytecode');
    // newPyc must be deleted
    const newStat = await fs.stat(newPyc).catch(() => undefined);
    expect(newStat).toBeUndefined();
    // Directory must NOT be deleted because it still contains oldPyc
    const dirStat = await fs.stat(pycacheDir).catch(() => undefined);
    expect(dirStat).toBeDefined();
    expect(dirStat?.isDirectory()).toBe(true);
  });
});
