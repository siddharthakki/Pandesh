/**
 * Micro-test cluster C6 (D-LOC-5): with "I live in Ulm, Germany" stored (residence → location), local questions were
 * answered for Berlin. The stored place must reach the turn; nothing stored means no fact (the model asks).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { homeLocationFact, readHomeLocation } from '../domain/homeLocation';

let dir: string;
let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-home-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function fact(subject: string, predicate: string, value: string, state = 'active', scopeType = 'user') {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO memory_facts (id, memoryType, scopeType, scopeId, subject, predicate, normalizedValue, displayValue, structuredValue, sensitivity, state, validFrom, createdAt, updatedAt, revision, writeIdentity)
     VALUES (?, 'semantic', ?, 'user', ?, ?, ?, ?, '{}', 'personal', ?, ?, ?, ?, 1, ?)`,
    [`mem_${subject}_${predicate}_${state}`, scopeType, subject, predicate, value.toLowerCase(), value, state, now, now, now, `wi_${subject}_${predicate}_${state}`],
  );
}

describe('home location for local questions', () => {
  it('reads the stored residence (LOC/TRV/CAT micro-tests)', () => {
    fact('residence', 'location', 'Ulm, Germany');
    expect(readHomeLocation(db)).toBe('Ulm, Germany');
    const line = homeLocationFact(readHomeLocation(db));
    expect(line).toContain('Ulm, Germany');
    expect(line).toMatch(/never infer a place from the time zone/i);
  });

  it('gives nothing when no home place is stored or it was forgotten', () => {
    expect(readHomeLocation(db)).toBeNull();
    expect(homeLocationFact(null)).toBe('');
    fact('residence', 'location', 'Ulm, Germany', 'forgotten');
    expect(readHomeLocation(db)).toBeNull();
  });

  it('ignores unrelated facts and non-user scopes', () => {
    fact('project', 'location', 'D:\\work');
    fact('residence', 'location', 'Somewhere', 'active', 'project');
    expect(readHomeLocation(db)).toBeNull();
  });
});
