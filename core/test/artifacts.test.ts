import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createConversation } from '../domain/conversations';
import { getArtifact, listArtifacts, registerArtifact } from '../domain/artifacts';

let dir: string;
let databasePath: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-artifacts-'));
  databasePath = path.join(dir, 'core.db');
  db = openCoreDatabase(databasePath).db;
});

afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function register(file: string, conversationId?: string) {
  return registerArtifact(db, {
    conversationId, kind: 'image', title: 'Generated landscape', mimeType: 'image/png',
    absolutePath: file, source: 'test-generator', metadata: { prompt: 'bounded prompt' }, actor: 'test',
  });
}

describe('Core-owned artifact records', () => {
  it('verifies bytes, persists provenance, and restores after a database restart', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const file = path.join(dir, 'landscape.png');
    fs.writeFileSync(file, Buffer.from('synthetic image bytes'));
    const created = register(file, conversation.id);
    expect(created.availability).toBe('ready');
    expect(created.byteSize).toBe(21);
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(created.metadata).toEqual({ prompt: 'bounded prompt' });

    db.close();
    db = openCoreDatabase(databasePath).db;
    expect(listArtifacts(db, conversation.id).map((item) => item.id)).toEqual([created.id]);
    expect(getArtifact(db, created.id).availability).toBe('ready');
  });

  it('reports changed and missing bytes honestly instead of keeping Ready', () => {
    const file = path.join(dir, 'output.png');
    fs.writeFileSync(file, 'original');
    const created = register(file);
    fs.writeFileSync(file, 'tampered');
    expect(getArtifact(db, created.id).availability).toBe('changed');
    fs.rmSync(file);
    expect(getArtifact(db, created.id).availability).toBe('missing');
  });

  it('refuses a path until a real readable non-empty file exists', () => {
    expect(() => register(path.join(dir, 'missing.png'))).toThrow(/does not exist or is not readable/);
    const empty = path.join(dir, 'empty.png');
    fs.writeFileSync(empty, '');
    expect(() => register(empty)).toThrow(/non-empty file/);
    expect(listArtifacts(db)).toEqual([]);
  });
});
