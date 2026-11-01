/**
 * Long-term memory on a real on-disk Core database: a fact survives a restart
 * (close + reopen), is recalled two weeks later in a different conversation by
 * words the model actually uses, stays reachable after many newer facts, and
 * can be corrected and forgotten.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { createConversation, appendMessage } from '../domain/conversations';
import { rememberMemory, recallMemories, forgetMemory, listMemoryContradictions, resolveMemoryContradiction } from '../domain/memory';

let dir: string;
let dbPath: string;
let db: CoreDatabase;

function open(): CoreDatabase {
  const handle = openDatabase(dbPath);
  runMigrations(handle);
  return handle;
}

function sourceTurn(handle: CoreDatabase, content: string) {
  const conversation = createConversation(handle, { mode: 'saath_kar', actor: 'test' });
  const message = appendMessage(handle, conversation.id, { role: 'user', content, actor: 'test' });
  return { sourceConversationId: conversation.id, sourceMessageId: message.id };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-memory-longterm-'));
  dbPath = path.join(dir, 'core.db');
  db = open();
});

afterEach(() => {
  vi.useRealTimers();
  try { db.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('long-term memory', () => {
  it('survives a restart and is recalled 14 days later by loose words in a new conversation', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
    rememberMemory(db, {
      memoryType: 'user', scopeType: 'user', scopeId: 'owner',
      subject: 'coffee preference', predicate: 'is', value: 'oat flat white, no sugar',
      sensitivity: 'confidential', actor: 'test', consentApprovalId: 'approval-1',
      ...sourceTurn(db, 'Remember that I take an oat flat white, no sugar.'),
    });
    db.close();

    vi.setSystemTime(new Date('2026-11-15T09:00:00Z'));
    db = open();
    createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const { entries } = recallMemories(db, { query: 'what coffee do I like' });
    expect(entries.map((entry) => entry.memory.displayValue)).toEqual(['oat flat white, no sugar']);
    expect(entries[0].kind).toBe('durable_fact');
  });

  it('keeps recent facts reachable after more than the recall limit of older ones', () => {
    const source = sourceTurn(db, 'project notes');
    for (let i = 0; i < 60; i++) {
      rememberMemory(db, {
        memoryType: 'project', scopeType: 'project', scopeId: 'Pandesh',
        subject: `note ${i}`, predicate: 'is', value: `detail ${i}`,
        sensitivity: 'internal', actor: 'test', ...source,
      });
    }
    rememberMemory(db, {
      memoryType: 'project', scopeType: 'project', scopeId: 'Pandesh',
      subject: 'database decision', predicate: 'is', value: 'SQLite only, no vector store',
      sensitivity: 'internal', actor: 'test', ...source,
    });
    const all = recallMemories(db, { scopeType: 'project', scopeId: 'Pandesh' }).entries;
    expect(all.at(-1)?.memory.subject).toBe('database decision');
    expect(recallMemories(db, { query: 'database' }).entries.map((entry) => entry.memory.displayValue)).toEqual(['SQLite only, no vector store']);
  });

  it('corrects an outdated fact and forgets on request', () => {
    const base = { memoryType: 'user' as const, scopeType: 'user' as const, scopeId: 'owner', subject: 'home city', predicate: 'is', sensitivity: 'confidential' as const, actor: 'test' };
    rememberMemory(db, { ...base, value: 'Munich', ...sourceTurn(db, 'I live in Munich.') });
    const later = rememberMemory(db, { ...base, value: 'Ulm', ...sourceTurn(db, 'No, I live in Ulm now, not Munich.') });
    const [contradiction] = listMemoryContradictions(db, later.memory.id);
    expect(contradiction).toBeDefined();
    resolveMemoryContradiction(db, { contradictionId: contradiction.id, policy: 'prefer_later', actor: 'test' } as any);
    expect(recallMemories(db, { query: 'city' }).entries.map((entry) => entry.memory.displayValue)).toEqual(['Ulm']);

    forgetMemory(db, { memoryId: later.memory.id, actor: 'test' });
    db.close();
    db = open();
    expect(recallMemories(db, { query: 'city' }).entries).toEqual([]);
  });
});
