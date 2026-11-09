/**
 * P0 (Build 161 audit): schema upgrades must be reversible and a newer schema must never be run by an older Core.
 *
 * - Core migrated an existing database on first start without any backup (the `migration-backups` folder was defined
 *   but never used); only the in-app updater copied core.db, the full installer did not. A faulty migration had no
 *   automatic way back.
 * - runMigrations applied only the migrations it knew and silently ignored newer ones already recorded, so an older
 *   build ran on a newer database (the rollback instructions could only say "never do this").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../db/connection';
import { MIGRATIONS } from '../db/migrations';
import { openCoreDatabase } from '../db/openCore';
import { CoreDatabaseFailedError } from '../db/preflight';

let dir: string;
const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-safety-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A database exactly as the previous build left it: every migration but the last. */
function previousBuildDatabase(file: string): void {
  const db = openDatabase(file);
  for (const m of MIGRATIONS.slice(0, -1)) {
    db.exec(m.sql);
    db.run('INSERT OR IGNORE INTO schema_migrations (version, description, appliedAt, checksum) VALUES (?, ?, ?, ?)', [m.version, m.description, new Date().toISOString(), 'test']);
  }
  db.run("INSERT INTO conversations (id, mode, title, createdAt, updatedAt, revision) VALUES ('conv_keep', 'baat_kar', 'keep me', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z', 1)");
  db.close();
}

function schemaOf(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v); } finally { db.close(); }
}

describe('schema upgrade safety', () => {
  it('takes a verified backup of the previous schema before migrating an existing database', () => {
    const file = path.join(dir, 'core.db');
    previousBuildDatabase(file);
    const { db, migrationsApplied } = openCoreDatabase(file);
    db.close();
    expect(migrationsApplied).toEqual([latest]);
    const backups = fs.readdirSync(path.join(dir, 'migration-backups')).filter((f) => f.endsWith('.db'));
    expect(backups).toHaveLength(1);
    const backup = path.join(dir, 'migration-backups', backups[0]);
    expect(backups[0]).toContain(`schema${latest - 1}`);
    expect(schemaOf(backup)).toBe(latest - 1);
    const copy = new DatabaseSync(backup, { readOnly: true });
    expect(copy.prepare("SELECT title FROM conversations WHERE id = 'conv_keep'").get()).toEqual({ title: 'keep me' });
    expect(Object.values(copy.prepare('PRAGMA quick_check').get() as object)[0]).toBe('ok');
    copy.close();
    expect(schemaOf(file)).toBe(latest);
  });

  it('takes no backup for a new database or one already at the current schema', () => {
    const file = path.join(dir, 'core.db');
    openCoreDatabase(file).db.close();
    openCoreDatabase(file).db.close();
    expect(fs.existsSync(path.join(dir, 'migration-backups'))).toBe(false);
  });

  it('refuses a database written by a newer Pandesh, and changes nothing in it', () => {
    const file = path.join(dir, 'core.db');
    openCoreDatabase(file).db.close();
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO schema_migrations (version, description, appliedAt, checksum) VALUES (?, ?, ?, ?)').run(latest + 1, 'from a newer build', new Date().toISOString(), 'x');
    raw.close();
    const before = fs.readFileSync(file);
    expect(() => openCoreDatabase(file)).toThrow(CoreDatabaseFailedError);
    expect(() => openCoreDatabase(file)).toThrow(/newer Pandesh/);
    expect(schemaOf(file)).toBe(latest + 1);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});
