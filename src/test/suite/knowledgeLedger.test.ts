import { describe, expect, it } from 'vitest';
import { KnowledgeLedger } from '../../memory/KnowledgeLedger';
import { InMemoryMemoryStorage } from '../../memory/MemoryStorage';

describe('governed knowledge ledger', () => {
  it('stores opt-in knowledge and supports supersession and deletion', async () => {
    const ledger = new KnowledgeLedger({
      enabled: true,
      storage: new InMemoryMemoryStorage(),
      sanitize: value => value,
    });
    await ledger.initialize();
    const first = await ledger.add({
      scope: 'repository', key: 'test-command', value: 'npm test', tags: ['validation'], confidence: 0.9,
      sensitivity: 'internal', provenance: { source: 'user', createdBy: 'user' }, pinned: false,
    });
    const second = await ledger.add({
      scope: 'repository', key: 'test-command', value: 'npm run validate', tags: ['validation'], confidence: 1,
      sensitivity: 'internal', provenance: { source: 'user-correction', createdBy: 'user' }, pinned: true,
      supersedes: [first.id],
    });

    expect(ledger.search({ query: 'validation command' })[0].record.id).toBe(second.id);
    expect(await ledger.remove(second.id)).toBe(true);
    expect(ledger.search({ query: 'validate' })).toHaveLength(0);
  });
});
