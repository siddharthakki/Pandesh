import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseAndValidateCodingProposal,
  validateCodingProposal,
  hasModifyIntent,
  hasExplicitFileDeletionIntent,
  CodingProposal,
} from '../../coding/CodingProposal';
import {
  WorkspaceMutationEngine,
  WorkspaceSnapshotBinder,
  assertExplicitDeleteIntent,
} from '../../coding/WorkspaceMutation';
import { verifyMutationEvidence } from '../../coding/GovernedCodingExecutor';

describe('Operation semantics preservation (P0 Bug 1)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'op-semantics-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('replace operation on existing file remains modify', async () => {
    const filePath = path.join(root, 'src', 'ordercalc', 'pricing.py');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'def compute_order_total():\n    return 10\n');

    const proposal: CodingProposal = {
      version: 1,
      taskSummary: 'Fix compute_order_total coupon order',
      operations: [{
        type: 'replace',
        path: 'src/ordercalc/pricing.py',
        reason: 'Fix compute_order_total so coupon is applied first',
        content: 'def compute_order_total():\n    return 42\n',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      limits: {},
      warnings: [],
      status: 'proposed',
    };

    const bound = await new WorkspaceSnapshotBinder(root).bind(proposal);
    const mutator = new WorkspaceMutationEngine(root);
    const result = await mutator.apply(bound);

    expect(result.filesModified).toEqual(['src/ordercalc/pricing.py']);
    expect(result.filesCreated).toEqual([]);
    expect(result.filesDeleted).toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe('def compute_order_total():\n    return 42\n');
  });

  it('full-file replacement remains modify', async () => {
    const filePath = path.join(root, 'src', 'ordercalc', 'pricing.py');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'original content');

    const proposal: CodingProposal = {
      version: 1,
      taskSummary: 'Update pricing file completely',
      operations: [{
        type: 'replace',
        path: 'src/ordercalc/pricing.py',
        reason: 'Replace full file content',
        content: 'new full file content\n',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      limits: {},
      warnings: [],
      status: 'proposed',
    };

    const bound = await new WorkspaceSnapshotBinder(root).bind(proposal);
    const mutator = new WorkspaceMutationEngine(root);
    const result = await mutator.apply(bound);

    expect(result.filesModified).toEqual(['src/ordercalc/pricing.py']);
    expect(result.filesDeleted).toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe('new full file content\n');
  });

  it('patch/edit remains modify if supported', () => {
    const rawProposal = JSON.stringify({
      version: 1,
      taskSummary: 'Fix compute_order_total discount logic',
      operations: [
        {
          type: 'edit',
          path: 'src/ordercalc/pricing.py',
          reason: 'Fix compute_order_total so coupon applies first',
          content: 'def compute_order_total(): pass\n',
        },
        {
          type: 'patch',
          path: 'src/ordercalc/tax.py',
          reason: 'Update tax computation',
          content: 'def compute_tax(): pass\n',
        },
      ],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const validated = parseAndValidateCodingProposal(rawProposal, []);
    expect(validated.ok).toBe(true);
    expect(validated.proposal?.operations[0].type).toBe('replace');
    expect(validated.proposal?.operations[1].type).toBe('replace');
  });

  it('action alias normalizes to type', () => {
    const rawProposal = JSON.stringify({
      version: 1,
      taskSummary: 'Update calculations',
      operations: [
        {
          action: 'modify',
          path: 'src/ordercalc/pricing.py',
          reason: 'Update calculation logic',
          code: 'def compute(): pass\n',
        },
      ],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const validated = parseAndValidateCodingProposal(rawProposal, []);
    expect(validated.ok).toBe(true);
    expect(validated.proposal?.operations[0].type).toBe('replace');
    expect(validated.proposal?.operations[0].content).toBe('def compute(): pass\n');
  });

  it('explicit delete remains delete', async () => {
    const filePath = path.join(root, 'src', 'ordercalc', 'legacy.py');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '# old deprecated module');

    const proposal: CodingProposal = {
      version: 1,
      taskSummary: 'Remove deprecated modules',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/legacy.py',
        reason: 'delete obsolete legacy.py file',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      limits: {},
      warnings: [],
      status: 'proposed',
    };

    const bound = await new WorkspaceSnapshotBinder(root).bind(proposal);
    const mutator = new WorkspaceMutationEngine(root);
    const result = await mutator.apply(bound);

    expect(result.filesDeleted).toEqual(['src/ordercalc/legacy.py']);
    expect(result.filesModified).toEqual([]);
    expect(result.filesCreated).toEqual([]);
    const exists = await fs.stat(filePath).catch(() => undefined);
    expect(exists).toBeUndefined();
  });

  it('malformed replacement does not silently become delete', () => {
    // Modify intent with type 'delete' without explicit file deletion must fail with delete_intent_mismatch
    const proposalWithModifyIntentAsDelete = JSON.stringify({
      version: 1,
      taskSummary: 'Fix compute_order_total so coupon is applied first',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: 'Fix compute_order_total so the coupon is applied to merchandise before the loyalty discount',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const result = parseAndValidateCodingProposal(proposalWithModifyIntentAsDelete, []);
    expect(result.ok).toBe(false);
    // Because intent is modify, normalizeOperation normalizes type to 'replace', which then requires content!
    // NEVER becomes delete!
    expect(result.errors).toContain('operation_content_required');
  });

  it('operation with delete type but provided content normalizes to replace', () => {
    const proposalWithContent = JSON.stringify({
      version: 1,
      taskSummary: 'Update pricing logic',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: 'Update compute_order_total',
        content: 'def compute_order_total(): pass\n',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const result = parseAndValidateCodingProposal(proposalWithContent, []);
    expect(result.ok).toBe(true);
    expect(result.proposal?.operations[0].type).toBe('replace');
    expect(result.proposal?.operations[0].content).toBe('def compute_order_total(): pass\n');
  });

  it('assertExplicitDeleteIntent detects modify intent mismatch', () => {
    expect(() => assertExplicitDeleteIntent({
      type: 'delete',
      path: 'src/ordercalc/pricing.py',
      reason: 'Fix compute_order_total so the coupon is applied to merchandise before the loyalty discount',
    }, 'Fix compute_order_total')).toThrow(/delete_intent_mismatch/);

    expect(() => assertExplicitDeleteIntent({
      type: 'delete',
      path: 'src/ordercalc/legacy.py',
      reason: 'delete obsolete legacy.py file from repository',
    }, 'Remove obsolete files from repository')).not.toThrow();
  });

  it('1. "remove obsolete branch from pricing.py" must NOT become file delete', async () => {
    const filePath = path.join(root, 'src', 'ordercalc', 'pricing.py');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const originalContent = 'def calculate_total(p, q):\n    # obsolete branch\n    return p + q\n';
    await fs.writeFile(filePath, originalContent);

    const raw = JSON.stringify({
      version: 1,
      taskSummary: 'remove obsolete branch from pricing.py',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: 'remove the obsolete branch from pricing.py',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const parsed = parseAndValidateCodingProposal(raw, []);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toContain('operation_content_required');
    expect(parsed.errors).not.toContain('content_prohibited_for_delete');

    expect(() => assertExplicitDeleteIntent({
      type: 'delete',
      path: 'src/ordercalc/pricing.py',
      reason: 'remove the obsolete branch from pricing.py',
    }, 'remove obsolete branch from pricing.py')).toThrow(/delete_intent_mismatch/);

    const mutator = new WorkspaceMutationEngine(root);
    await expect(mutator.apply({
      version: 1 as const,
      taskSummary: 'remove obsolete branch from pricing.py',
      operations: [{
        type: 'delete' as const,
        path: 'src/ordercalc/pricing.py',
        canonicalPath: filePath,
        reason: 'remove the obsolete branch from pricing.py',
        snapshot: { state: 'exists' as const, sha256: 'abc', bytes: originalContent.length, capturedAt: new Date().toISOString() },
      }],
      validationCommands: [{ kind: 'git-diff-check' as const }],
      limits: { maxFiles: 10, maxBytesPerFile: 100000, totalBytes: 100 },
      warnings: [],
      status: 'proposed' as const,
    })).rejects.toThrow(/delete_intent_mismatch/);

    expect(await fs.readFile(filePath, 'utf8')).toBe(originalContent);
  });

  it('2. "delete unused helper function from pricing.py" must NOT become file delete', async () => {
    const filePath = path.join(root, 'src', 'ordercalc', 'pricing.py');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const originalContent = 'def helper(): pass\ndef calculate_total(p, q): return p * q\n';
    await fs.writeFile(filePath, originalContent);

    const raw = JSON.stringify({
      version: 1,
      taskSummary: 'delete unused helper function from pricing.py',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: 'delete the unused helper function from pricing.py',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const parsed = parseAndValidateCodingProposal(raw, []);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toContain('operation_content_required');

    expect(() => assertExplicitDeleteIntent({
      type: 'delete',
      path: 'src/ordercalc/pricing.py',
      reason: 'delete the unused helper function from pricing.py',
    }, 'delete unused helper function from pricing.py')).toThrow(/delete_intent_mismatch/);
  });

  it('3. "remove bug-causing import" must NOT become file delete', async () => {
    const filePath = path.join(root, 'src', 'ordercalc', 'pricing.py');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const originalContent = 'import bad_mod\ndef calc(): pass\n';
    await fs.writeFile(filePath, originalContent);

    const raw = JSON.stringify({
      version: 1,
      taskSummary: 'remove bug-causing import',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: 'remove bug-causing import from pricing.py',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const parsed = parseAndValidateCodingProposal(raw, []);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toContain('operation_content_required');

    expect(() => assertExplicitDeleteIntent({
      type: 'delete',
      path: 'src/ordercalc/pricing.py',
      reason: 'remove bug-causing import',
    }, 'remove bug-causing import')).toThrow(/delete_intent_mismatch/);
  });

  it('4. explicit "delete obsolete_file.py from repository" remains a valid file delete', async () => {
    const obsoletePath = path.join(root, 'obsolete_file.py');
    const keepPath = path.join(root, 'active_file.py');
    await fs.writeFile(obsoletePath, '# obsolete\n');
    await fs.writeFile(keepPath, '# active\n');

    const raw = JSON.stringify({
      version: 1,
      taskSummary: 'delete obsolete_file.py from repository',
      operations: [{
        type: 'delete',
        path: 'obsolete_file.py',
        reason: 'delete obsolete_file.py from repository',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const parsed = parseAndValidateCodingProposal(raw, []);
    expect(parsed.ok).toBe(true);
    expect(parsed.proposal?.operations[0].type).toBe('delete');

    expect(() => assertExplicitDeleteIntent({
      type: 'delete',
      path: 'obsolete_file.py',
      reason: 'delete obsolete_file.py from repository',
    }, 'delete obsolete_file.py from repository')).not.toThrow();

    const bound = await new WorkspaceSnapshotBinder(root).bind(parsed.proposal!);
    const mutator = new WorkspaceMutationEngine(root);
    const result = await mutator.apply(bound);

    expect(result.filesDeleted).toEqual(['obsolete_file.py']);
    expect(await fs.stat(obsoletePath).catch(() => undefined)).toBeUndefined();
    expect(await fs.readFile(keepPath, 'utf8')).toBe('# active\n');
  });

  it('5. delete-like operation WITH replacement content cannot silently discard content', () => {
    const raw = JSON.stringify({
      version: 1,
      taskSummary: 'remove obsolete code from pricing.py',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: 'remove obsolete branch and update logic',
        content: 'def calculate_total(p, q): return p * q\n',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    const parsed = parseAndValidateCodingProposal(raw, []);
    expect(parsed.ok).toBe(true);
    expect(parsed.proposal?.operations[0].type).toBe('replace');
    expect(parsed.proposal?.operations[0].content).toBe('def calculate_total(p, q): return p * q\n');

    const directDeleteWithContent = validateCodingProposal({
      version: 1,
      taskSummary: 'delete file',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: 'delete file entirely',
        content: 'some non-empty content',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    }, []);
    expect(directDeleteWithContent.ok).toBe(false);
    expect(directDeleteWithContent.errors).toContain('content_prohibited_for_delete');
  });

  it('6. compact repair may not convert modification intent into filesystem deletion', () => {
    // Model receives validation failure for missing content, and tries to escape it by returning delete
    const repairAttempt = {
      version: 1,
      taskSummary: 'Fix calculate_total so that it multiplies price by quantity',
      operations: [{
        type: 'delete',
        path: 'src/ordercalc/pricing.py',
        reason: 'remove pricing.py',
      }],
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    };

    const validated = validateCodingProposal(repairAttempt, []);
    expect(validated.ok).toBe(false);
    expect(validated.errors).toContain('delete_intent_mismatch');
  });

  it('7. mutation evidence rejects semantic mismatches (replace->delete, create->delete, delete->write)', async () => {
    const dummySnapshot = { state: 'exists' as const, sha256: 'abc', bytes: 10, capturedAt: new Date().toISOString() };

    // 7a. Approved replace -> actual delete
    const replaceProposal = {
      version: 1 as const,
      taskSummary: 'Fix pricing',
      operations: [{
        type: 'replace' as const,
        path: 'src/pricing.py',
        canonicalPath: path.join(root, 'src', 'pricing.py'),
        reason: 'Fix function',
        content: 'new content',
        snapshot: dummySnapshot,
      }],
      validationCommands: [{ kind: 'git-diff-check' as const }],
      limits: { maxFiles: 10, maxBytesPerFile: 10000, totalBytes: 100 },
      warnings: [],
      status: 'proposed' as const,
    };

    await expect(verifyMutationEvidence(root, replaceProposal, 0, {
      filesCreated: [],
      filesModified: [],
      filesDeleted: ['src/pricing.py'],
      filesRestored: [],
      rollbackAttempted: false,
      rollbackSucceeded: true,
    })).rejects.toThrow(/mutation_semantics_mismatch: replace operation was executed as delete/);

    // 7b. Approved create -> actual delete
    const createProposal = {
      version: 1 as const,
      taskSummary: 'Add new module',
      operations: [{
        type: 'create' as const,
        path: 'src/new.py',
        canonicalPath: path.join(root, 'src', 'new.py'),
        reason: 'Add module',
        content: 'new content',
        snapshot: { state: 'missing' as const, capturedAt: new Date().toISOString() },
      }],
      validationCommands: [{ kind: 'git-diff-check' as const }],
      limits: { maxFiles: 10, maxBytesPerFile: 10000, totalBytes: 100 },
      warnings: [],
      status: 'proposed' as const,
    };

    await expect(verifyMutationEvidence(root, createProposal, 0, {
      filesCreated: [],
      filesModified: [],
      filesDeleted: ['src/new.py'],
      filesRestored: [],
      rollbackAttempted: false,
      rollbackSucceeded: true,
    })).rejects.toThrow(/mutation_semantics_mismatch: create operation was executed as delete/);

    // 7c. Approved delete -> actual modify/create
    const deleteProposal = {
      version: 1 as const,
      taskSummary: 'Delete obsolete file from repository',
      operations: [{
        type: 'delete' as const,
        path: 'src/obsolete.py',
        canonicalPath: path.join(root, 'src', 'obsolete.py'),
        reason: 'delete obsolete.py from repository',
        snapshot: dummySnapshot,
      }],
      validationCommands: [{ kind: 'git-diff-check' as const }],
      limits: { maxFiles: 10, maxBytesPerFile: 10000, totalBytes: 100 },
      warnings: [],
      status: 'proposed' as const,
    };

    await expect(verifyMutationEvidence(root, deleteProposal, 0, {
      filesCreated: [],
      filesModified: ['src/obsolete.py'],
      filesDeleted: [],
      filesRestored: [],
      rollbackAttempted: false,
      rollbackSucceeded: true,
    })).rejects.toThrow(/mutation_semantics_mismatch: delete operation was executed as write/);
  });

  it('no write occurs when operation semantics mismatch', async () => {
    const filePath = path.join(root, 'src', 'ordercalc', 'pricing.py');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const originalContent = 'def compute_order_total(): return 100\n';
    await fs.writeFile(filePath, originalContent);

    const proposalWithMismatch = {
      version: 1 as const,
      taskSummary: 'Fix compute_order_total discount order',
      operations: [{
        type: 'delete' as const,
        path: 'src/ordercalc/pricing.py',
        canonicalPath: filePath,
        reason: 'Fix compute_order_total function bug',
        snapshot: { state: 'exists' as const, sha256: 'xyz', bytes: 100, capturedAt: new Date().toISOString() },
      }],
      validationCommands: [{ kind: 'git-diff-check' as const }],
      limits: { maxFiles: 10, maxBytesPerFile: 100000, totalBytes: 100 },
      warnings: [],
      status: 'proposed' as const,
    };

    const mutator = new WorkspaceMutationEngine(root);
    await expect(mutator.apply(proposalWithMismatch)).rejects.toThrow(/delete_intent_mismatch/);

    // Verify file is UNTOUCHED
    expect(await fs.readFile(filePath, 'utf8')).toBe(originalContent);
  });
});
