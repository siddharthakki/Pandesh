import { describe, it, expect } from 'vitest';
import { buildContextPolicy } from '../domain/contextPolicy';

describe('buildContextPolicy: explicit, bounded context layers per mode', () => {
  it('Baat Kar includes bounded repository context when supplied, never project/story context', () => {
    const policy = buildContextPolicy('baat_kar', { hasConversation: true, hasRepository: true, hasStory: true });
    expect(policy).toEqual({
      includeConversationHistory: true,
      includeProjectContext: false,
      includeRepositoryContext: true,
      includeGlobalStoryContext: false,
    });
  });

  it('Baat Kar with no conversation selected includes no history', () => {
    const policy = buildContextPolicy('baat_kar', { hasConversation: false, hasRepository: false, hasStory: false });
    expect(policy.includeConversationHistory).toBe(false);
    expect(policy.includeRepositoryContext).toBe(false);
  });

  it('Saath Kar includes conversation + project/repository context, never global story', () => {
    const policy = buildContextPolicy('saath_kar', { hasConversation: true, hasRepository: true, hasStory: false });
    expect(policy).toEqual({
      includeConversationHistory: true,
      includeProjectContext: true,
      includeRepositoryContext: true,
      includeGlobalStoryContext: false,
    });
  });

  it('Karke Dikha never includes conversation history (retry-from-scratch contract)', () => {
    const policy = buildContextPolicy('karke_dikha', { hasConversation: true, hasRepository: true, hasStory: true });
    expect(policy.includeConversationHistory).toBe(false);
    expect(policy.includeGlobalStoryContext).toBe(true);
    expect(policy.includeRepositoryContext).toBe(true);
  });

  it('Karke Dikha with no repository excludes project/repository context (planning-only path)', () => {
    const policy = buildContextPolicy('karke_dikha', { hasConversation: false, hasRepository: false, hasStory: true });
    expect(policy.includeProjectContext).toBe(false);
    expect(policy.includeRepositoryContext).toBe(false);
    expect(policy.includeGlobalStoryContext).toBe(true);
  });
});
