import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalArgumentJson,
  createEvidenceHash,
  createLoopSignature,
  recoverRepositoryPath,
} from '../runtime/repositoryPathRecovery';

describe('repository path recovery', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-path-recovery-'));
    fs.mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'feature', 'Widget.ts'), 'export const widget = true;\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('normalizes slashes, redundant workspace prefixes, and case without leaving the canonical root', () => {
    const requested = `${path.basename(root)}\\SRC\\FEATURE\\widget.ts`;
    const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: requested, target: 'read' });

    expect(result).toMatchObject({
      original: requested,
      normalized: 'SRC/FEATURE/widget.ts',
      selected: 'src/feature/Widget.ts',
      status: 'corrected',
      confidence: 'exact',
      reason: 'case_insensitive_relative_match',
      automatic: true,
      exists: true,
    });
    expect(path.relative(fs.realpathSync.native(root), result.resolvedPath!)).toBe(path.join('src', 'feature', 'Widget.ts'));
  });

  it('rejects traversal before probing or searching for a matching basename', () => {
    const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: '../Widget.ts', target: 'read' });
    expect(result).toMatchObject({ status: 'rejected', reason: 'traversal_rejected', selected: null, automatic: false });
    expect(result.candidates).toEqual([]);
  });

  it('rejects paths whose nearest existing ancestor is a symlink escape', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-path-outside-'));
    try {
      const link = path.join(root, 'linked-outside');
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: 'linked-outside/new.txt', target: 'write' });
      expect(result).toMatchObject({ status: 'rejected', reason: 'symlink_escape', resolvedPath: null });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('uses only the basename of an invented outside absolute path and selects one unique in-root file', () => {
    const invented = process.platform === 'win32' ? 'Z:\\invented\\private\\Widget.ts' : '/invented/private/Widget.ts';
    const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: invented, target: 'read' });

    expect(result).toMatchObject({
      status: 'corrected', selected: 'src/feature/Widget.ts', reason: 'outside_absolute_unique_basename', automatic: true,
    });
    expect(result.resolvedPath).toBe(path.join(fs.realpathSync.native(root), 'src', 'feature', 'Widget.ts'));
  });

  it('returns sorted candidates and requires user choice for an ambiguous basename', () => {
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'Widget.ts'), 'test\n');
    const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: 'stale/Widget.ts', target: 'read' });

    expect(result).toMatchObject({ status: 'ambiguous', reason: 'ambiguous_match', selected: null, resolvedPath: null, automatic: false });
    expect(result.candidates).toEqual(['src/feature/Widget.ts', 'test/Widget.ts']);
  });

  it('prefers a unique suffix over weaker basename matches', () => {
    fs.mkdirSync(path.join(root, 'test', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'feature', 'Widget.ts'), 'test\n');
    const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: 'invented/src/feature/Widget.ts', target: 'read' });

    expect(result).toMatchObject({ status: 'corrected', selected: 'src/feature/Widget.ts', reason: 'unique_suffix_match' });
  });

  it('ignores generated and protected runtime directories during bounded read recovery', () => {
    for (const ignored of ['.git', 'node_modules', 'out', 'dist', 'build', '.ollama-agent']) {
      fs.mkdirSync(path.join(root, ignored), { recursive: true });
      fs.writeFileSync(path.join(root, ignored, 'OnlyGenerated.ts'), ignored);
    }
    const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: 'OnlyGenerated.ts', target: 'read' });
    expect(result).toMatchObject({ status: 'not_found', reason: 'not_found', candidates: [] });
  });

  it('does not search or redirect write targets and safely resolves a new in-root leaf', () => {
    const newTarget = recoverRepositoryPath({ workspaceRoot: root, requestedPath: 'src/new/Widget.ts', target: 'write' });
    expect(newTarget).toMatchObject({
      status: 'resolved', selected: 'src/new/Widget.ts', exists: false, reason: 'safe_write_target', automatic: false,
    });

    const outside = process.platform === 'win32' ? 'Z:\\invented\\Widget.ts' : '/invented/Widget.ts';
    const outsideResult = recoverRepositoryPath({ workspaceRoot: root, requestedPath: outside, target: 'write' });
    expect(outsideResult).toMatchObject({ status: 'rejected', reason: 'outside_workspace', selected: null });
  });

  it('reports when the bounded scan was truncated without inventing a match', () => {
    const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: 'missing.ts', target: 'read', maxScanEntries: 1 });
    expect(result).toMatchObject({ status: 'not_found', reason: 'scan_truncated', scanTruncated: true });
  });

  it('does not call an observed candidate unambiguous when the bounded scan was truncated', () => {
    fs.writeFileSync(path.join(root, 'A.ts'), 'first\n');
    const invented = process.platform === 'win32' ? 'Z:\\invented\\A.ts' : '/invented/A.ts';
    const result = recoverRepositoryPath({ workspaceRoot: root, requestedPath: invented, target: 'read', maxScanEntries: 1 });
    expect(result).toMatchObject({
      status: 'ambiguous', reason: 'scan_truncated', selected: null, automatic: false, candidates: ['A.ts'], scanTruncated: true,
    });
  });
});

describe('stable loop evidence helpers', () => {
  it('canonicalizes nested arguments and produces order-independent evidence hashes', () => {
    const left = { z: 1, nested: { b: true, a: ['x', undefined] }, omitted: undefined };
    const right = { nested: { a: ['x', null], b: true }, z: 1 };

    expect(canonicalArgumentJson(left)).toBe('{"nested":{"a":["x",null],"b":true},"z":1}');
    expect(createEvidenceHash(left)).toBe(createEvidenceHash(right));
  });

  it('changes loop signatures when operation, result category, arguments, or evidence changes', () => {
    const base = {
      operation: 'read_file', normalizedArguments: { path: 'src/a.ts' }, resultCategory: 'path_rejected', relevantEvidence: { reason: 'outside' },
    };
    const signature = createLoopSignature(base);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(createLoopSignature({ ...base, normalizedArguments: { path: 'src/a.ts' } })).toBe(signature);
    expect(createLoopSignature({ ...base, resultCategory: 'not_found' })).not.toBe(signature);
    expect(createLoopSignature({ ...base, relevantEvidence: { reason: 'ambiguous' } })).not.toBe(signature);
  });
});
