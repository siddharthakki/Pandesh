import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation, appendMessage } from '../domain/conversations';
import { rememberMemory } from '../domain/memory';
import { createMemoryCapabilityAdapter } from '../runtime/memoryCapability';

// Live demo 2026-11-09: "our flour supplier delivers on Wednesdays" was stored in project scope "Bakery"; a later recall
// at user scope found nothing and Pandesh answered "I don't have that information".
let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-scope-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const conversation = createConversation(db, { mode: 'saath_kar', actor: 'test:actor' });
  const message = appendMessage(db, conversation.id, { role: 'user', content: 'Remember: our flour supplier delivers on Wednesdays.', actor: 'test:actor' });
  rememberMemory(db, {
    memoryType: 'project', scopeType: 'project', scopeId: 'Bakery', subject: 'flour supplier details', predicate: 'delivery day',
    value: 'Flour supplier: Muehle Sonnenhof; Delivery day: Wednesday.', sensitivity: 'internal',
    sourceConversationId: conversation.id, sourceMessageId: (message as { id: string }).id, actor: 'test:actor',
  });
});
afterEach(() => { db.close?.(); fs.rmSync(dir, { recursive: true, force: true }); });

async function recall(args: Record<string, unknown>) {
  const adapter = createMemoryCapabilityAdapter({ db });
  const result = await adapter.run({ id: 'c1', name: 'memory_recall', arguments: args } as never, { cwd: dir } as never);
  return JSON.parse(String((result as { output?: string }).output ?? '{}'));
}

describe('memory_recall at user scope also finds the user\'s project facts when nothing else matches', () => {
  it('widens a keyword recall that found nothing at user scope', async () => {
    const out = await recall({ query: 'flour supplier delivery', scopeType: 'user' });
    expect(out.entries).toHaveLength(1);
    expect(JSON.stringify(out.entries[0])).toContain('Wednesday');
    expect(out.includedScopes).toContain('project');
  });

  it('prefers the project fact that matches more words over a user fact that matches one word', async () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'test:actor' });
    const message = appendMessage(db, conversation.id, { role: 'user', content: 'The sourdough loaf costs 5.20 euros.', actor: 'test:actor' });
    rememberMemory(db, {
      memoryType: 'user', scopeType: 'user', scopeId: 'user_preferences', subject: 'sourdough loaf price', predicate: 'cost',
      value: 'The sourdough loaf costs 5.20 euros.', sensitivity: 'internal',
      sourceConversationId: conversation.id, sourceMessageId: (message as { id: string }).id, actor: 'test:actor',
    });
    const out = await recall({ query: 'flour supplier delivery cost', scopeType: 'user' });
    expect(out.entries).toHaveLength(1);
    expect(JSON.stringify(out.entries[0])).toContain('Muehle Sonnenhof');
  });

  it('does not widen an explicit scope id', async () => {
    expect((await recall({ query: 'flour supplier', scopeType: 'user', scopeId: 'someone-else' })).entries).toHaveLength(0);
    expect((await recall({ query: 'nothing-matches-this', scopeType: 'user' })).entries).toHaveLength(0);
    expect((await recall({ scopeType: 'project', scopeId: 'Other' })).entries).toHaveLength(0);
  });
});
