import { describe, it, expect } from 'vitest';
import { formatBytes, rehearsalHeadline, hasConflicts, conflictCount } from '../renderer-v2/src/rehearsalModel';

describe('rehearsal model', () => {
  const plan = { planId: 'p1', totalMoves: 196, moves: [
    { source: 'report.pdf', destination: 'Documents/', bytes: 2100000, conflict: false },
    { source: 'notes.txt', destination: 'Documents/', bytes: 12000, conflict: true },
  ], duplicates: [{ set: 1, files: 3, bytes: 4200000 }], conflicts: 1, spaceFreedBytes: 4200000, spaceMovedBytes: 89000000, digest: 'sha256:abcd1234' };
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(4200000)).toBe('4.0 MB');
  });
  it('headline shows proposed moves, zero changed', () => {
    expect(rehearsalHeadline(plan)).toBe('Preview · 196 proposed moves · 0 changed yet');
  });
  it('detects conflicts', () => {
    expect(hasConflicts(plan)).toBe(true);
    expect(conflictCount(plan)).toBe(1);
  });
});