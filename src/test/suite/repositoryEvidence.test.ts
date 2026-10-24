import { describe, expect, it } from 'vitest';
import { getRepositoryEvidenceRequirements } from '../../agent/TaskIntent';

describe('repository evidence requirements', () => {
  it('detects file, directory, and matching-file evidence', () => {
    const prompt = [
      'Perform read-only repository inspection only.',
      'Read package.json, list files directly under src,',
      'and count files matching src/test/suite/*.test.ts.',
      'Make no workspace changes.',
    ].join(' ');

    expect(getRepositoryEvidenceRequirements(prompt)).toEqual([
      'file_read',
      'directory_listing',
      'file_search',
    ]);
  });

  it('uses generic read evidence for a broad inspection', () => {
    expect(getRepositoryEvidenceRequirements(
      'Inspect this repository read-only and make no workspace changes.',
    )).toEqual(['any_read']);
  });
});
