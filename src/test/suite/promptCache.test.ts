import { describe, expect, it } from 'vitest';
import { PromptCache } from '../../performance/PromptCache';

describe('bounded prompt cache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new PromptCache<{ value: number }>({ maxEntries: 2, maxBytes: 1000 });
    const one = PromptCache.key(['one']);
    const two = PromptCache.key(['two']);
    const three = PromptCache.key(['three']);
    cache.set(one, { value: 1 });
    cache.set(two, { value: 2 });
    cache.get(one);
    cache.set(three, { value: 3 });

    expect(cache.get(one)?.value).toBe(1);
    expect(cache.get(two)).toBeUndefined();
    expect(cache.get(three)?.value).toBe(3);
  });
});
