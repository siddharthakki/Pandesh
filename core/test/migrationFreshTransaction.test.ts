/**
 * A brand-new database takes every migration in one transaction; an existing one still migrates step by step.
 * (runMigrations: one commit instead of one per migration for the database every test and every first start creates.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, appliedSchemaVersion, runMigrations } from '../db/migrations';

let dir: string;
let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-fresh-')); db = openDatabase(path.join(dir, 'core.db')); });
afterEach(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });

const tables = (d: CoreDatabase) => d.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name");

describe('migrations on a new and on an existing database', () => {
  it('a new database gets every migration, recorded in order, and passes the integrity check', () => {
    const { applied } = runMigrations(db);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(appliedSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(db.integrityCheck()).toBe(true);
    expect(runMigrations(db).applied).toEqual([]);
  });

  it('an existing database one version behind applies only what is missing and ends with the same schema', () => {
    runMigrations(db);
    const full = tables(db);
    // Put it back to the previous build's schema: forget the last migration and what it created.
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    db.exec('DROP TABLE IF EXISTS mission_steps; DROP TABLE IF EXISTS missions;');
    db.run('DELETE FROM schema_migrations WHERE version = ?', [last.version]);
    expect(appliedSchemaVersion(db)).toBe(last.version - 1);
    expect(runMigrations(db).applied).toEqual([last.version]);
    expect(tables(db)).toEqual(full);
  });

  it('a new database that fails part-way keeps nothing: no table, no migration record', () => {
    const broken = { version: LATEST_SCHEMA_VERSION + 1, description: 'broken on purpose', sql: 'CREATE TABLE ok_before_failure (id TEXT); CREATE TABLE (' };
    MIGRATIONS.push(broken);
    try {
      expect(() => runMigrations(db)).toThrow();
    } finally {
      MIGRATIONS.pop();
    }
    expect(appliedSchemaVersion(db)).toBe(0);
    expect(tables(db).filter((t) => t.name !== 'schema_migrations' && t.name !== 'core_metadata')).toEqual([]);
    // The same database then migrates cleanly.
    expect(runMigrations(db).applied).toHaveLength(MIGRATIONS.length);
  });
});
