import { describe, expect, it } from 'vitest';
import { RevisionSearch } from '../../reliability/RevisionSearch';

describe('revision search', () => {
  it('locates the first bad revision through an injected probe', async () => {
    const revisions = ['a', 'b', 'c', 'd'];
    const result = await new RevisionSearch().locateFirstBad(revisions, {
      evaluate: async revision => revisions.indexOf(revision) >= 2 ? 'bad' : 'good',
    });

    expect(result.complete).toBe(true);
    expect(result.firstBadRevision).toBe('c');
  });
});
