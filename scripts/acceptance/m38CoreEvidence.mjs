// M38 — direct, read-only Core SQLite evidence helpers for the packaged
// governed-external-tool-fabric acceptance harness. Mirrors m31CoreEvidence.mjs's
// established convention (opened with node:sqlite's DatabaseSync in readOnly
// mode, never the authenticated Core HTTP token): this out-of-process harness
// has no legitimate access to the bearer token held in the Extension Host's
// SecretStorage (see src/core-client/tokenStore.ts), so every assertion here
// is corroborating evidence read directly from the same isolated
// KARKEDIKHA_DATA_DIR/core.db this harness itself pointed Core at — never a
// substitute for the real webview action already observed over CDP.

import * as fs from 'node:fs';
import * as path from 'node:path';

export function discoveryRecordPath(globalDataDir) {
  return path.join(globalDataDir, 'core.json');
}

export function readDiscoveryRecord(globalDataDir) {
  const file = discoveryRecordPath(globalDataDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function pollForDiscoveryRecord(globalDataDir, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = readDiscoveryRecord(globalDataDir);
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a Core discovery record at ${discoveryRecordPath(globalDataDir)}`);
}

/** Cross-platform PID liveness check, diagnostic only. */
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function openDb(globalDataDir) {
  const dbPath = path.join(globalDataDir, 'core.db');
  if (!fs.existsSync(dbPath)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

export async function withDb(globalDataDir, fn) {
  const db = await openDb(globalDataDir);
  if (!db) return fn(null);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export async function findRequestByMessage(globalDataDir, messageText) {
  return withDb(globalDataDir, (db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM requests WHERE currentMessage = ? ORDER BY createdAt DESC LIMIT 1').get(messageText) ?? null;
  });
}

export async function findAttemptsForRequest(globalDataDir, requestId) {
  return withDb(globalDataDir, (db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM attempts WHERE requestId = ? ORDER BY createdAt DESC').all(requestId);
  });
}

export async function findAttemptById(globalDataDir, attemptId) {
  return withDb(globalDataDir, (db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) ?? null;
  });
}

export async function findApprovalsForAttempt(globalDataDir, attemptId) {
  return withDb(globalDataDir, (db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM approvals WHERE attemptId = ? ORDER BY requestedAt ASC').all(attemptId);
  });
}

/** All approval rows, regardless of attemptId — used to find the
 * capability-dispatch anchor attempt's own approval row (a *different*
 * attemptId than the real Saath Kar attempt) by requestedActionDigest. */
export async function findApprovalsByDigest(globalDataDir, requestedActionDigest) {
  return withDb(globalDataDir, (db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM approvals WHERE summary LIKE ? OR id = ? ORDER BY requestedAt ASC').all(`%${requestedActionDigest}%`, requestedActionDigest);
  });
}

export async function findApprovalById(globalDataDir, approvalId) {
  return withDb(globalDataDir, (db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) ?? null;
  });
}

export async function findAllApprovals(globalDataDir) {
  return withDb(globalDataDir, (db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM approvals ORDER BY requestedAt ASC').all();
  });
}

export async function findLoopContinuation(globalDataDir, attemptId) {
  return withDb(globalDataDir, (db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM attempt_loop_continuations WHERE attemptId = ?').get(attemptId) ?? null;
  });
}

export async function countLoopContinuations(globalDataDir) {
  return withDb(globalDataDir, (db) => {
    if (!db) return 0;
    return db.prepare('SELECT COUNT(*) AS n FROM attempt_loop_continuations').get().n;
  });
}

export async function findAllLoopContinuations(globalDataDir) {
  return withDb(globalDataDir, (db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM attempt_loop_continuations').all();
  });
}

export async function findToolInvocations(globalDataDir, attemptId) {
  return withDb(globalDataDir, (db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt ASC').all(attemptId);
  });
}

export async function findConversationMessages(globalDataDir, conversationId) {
  return withDb(globalDataDir, (db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM conversation_messages WHERE conversationId = ? ORDER BY seq ASC').all(conversationId);
  });
}

export async function pollUntilDb(fn, { timeoutMs = 30000, intervalMs = 400, describe } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe ? describe() : 'db condition'}; last=${JSON.stringify(last)}`);
}
