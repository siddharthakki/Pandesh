import { describe, expect, it } from 'vitest';
import { ContextEngine } from '../../intelligence/ContextEngine';

describe('context engine v2', () => {
  it('keeps pinned context and removes lower-priority overflow', () => {
    const result = new ContextEngine().compactSync([
      { id: 'fixed', kind: 'system', content: 'fixed', priority: 100, pinned: true, estimatedTokens: 10 },
      { id: 'current', kind: 'message', content: 'current', priority: 90, pinned: true, estimatedTokens: 10 },
      { id: 'important', kind: 'code', content: 'important', priority: 80, estimatedTokens: 80 },
      { id: 'optional', kind: 'code', content: 'optional', priority: 10, estimatedTokens: 80 },
    ], { maxTokens: 128, reservedTokens: 8 });

    expect(result.includedIds).toContain('fixed');
    expect(result.includedIds).toContain('current');
    expect(result.includedIds).toContain('important');
    expect(result.droppedIds).toContain('optional');
  });
});
