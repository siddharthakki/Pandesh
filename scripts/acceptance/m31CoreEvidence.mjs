// Supplementary (never primary) M31 Core evidence collection for the
// packaged-UI acceptance harness. Per the M31 harness requirements: direct
// Core HTTP/WS/DB assertions are only ever used AFTER a real UI action has
// already been observed, to corroborate it — never as a substitute for
// driving/reading the actual webview.
//
// This module deliberately never uses the bearer token (generated inside the
// Extension Host's SecretStorage, which this out-of-process harness has no
// legitimate access to): it only reads the unauthenticated discovery record
// (core.json — contains no secret, see docs/m31-architecture.md) and the
// SQLite database file directly, both from the isolated global data
// directory the harness itself created via KARKEDIKHA_DATA_DIR.

import * as fs from 'fs';
import * as path from 'path';

export function readDiscoveryRecord(globalDataDir) {
  const file = path.join(globalDataDir, 'core.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function pollForDiscoveryRecord(globalDataDir, { timeoutMs = 20000, intervalMs = 300, predicate } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = readDiscoveryRecord(globalDataDir);
    if (last && (!predicate || predicate(last))) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a discovery record${predicate ? ' matching predicate' : ''}; last=${JSON.stringify(last)}`);
}

/** True if a PID is alive, cross-platform (used only for diagnostic evidence, never to drive control flow that would substitute for a UI check). */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Read-only-in-spirit inspection of the isolated Core SQLite database file.
 * Opens with the real `node:sqlite` module (built into this Node runtime,
 * same as the Core itself uses) purely to SELECT — never to mutate.
 */
export async function inspectCoreDatabase(globalDataDir) {
  const dbPath = path.join(globalDataDir, 'core.db');
  if (!fs.existsSync(dbPath)) {
    return { exists: false, dbPath };
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const projectCount = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
    const storyCount = db.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
    const eventCount = db.prepare('SELECT COUNT(*) AS n FROM story_events').get().n;
    const commentCount = db.prepare('SELECT COUNT(*) AS n FROM story_comments').get().n;
    const projects = db.prepare('SELECT id, name, archivedAt FROM projects').all();
    const stories = db.prepare('SELECT id, projectId, title, status, revision, archivedAt FROM stories').all();
    const duplicateTitles = db
      .prepare('SELECT projectId, title, COUNT(*) AS n FROM stories WHERE archivedAt IS NULL GROUP BY projectId, title HAVING COUNT(*) > 1')
      .all();
    const singletonOwnerRow = db.prepare("SELECT value FROM core_metadata WHERE key = 'singleton_owner'").get();
    const singletonOwner = singletonOwnerRow ? JSON.parse(singletonOwnerRow.value) : null;
    const eventsByStory = db.prepare('SELECT storyId, eventType, COUNT(*) AS n FROM story_events GROUP BY storyId, eventType, idempotencyKey HAVING COUNT(*) > 1').all();
    return {
      exists: true,
      dbPath,
      projectCount,
      storyCount,
      eventCount,
      commentCount,
      projects,
      stories,
      duplicateTitles,
      singletonOwner,
      duplicateIdempotentEvents: eventsByStory,
    };
  } finally {
    db.close();
  }
}

/** Recursively scans a disposable workspace for any Core-owned artifact (database, discovery record, token file, legacy Board JSON) that should never be written there. */
export function scanWorkspaceForForbiddenCoreArtifacts(workspaceRoot) {
  const forbiddenNames = new Set(['core.db', 'core.db-wal', 'core.db-shm', 'core.json', 'core.lock']);
  const hits = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (forbiddenNames.has(entry.name)) {
        hits.push(full);
      }
    }
  }
  walk(workspaceRoot);
  return hits;
}
