import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createPairingCode, getBridgeTask, redeemPairingCode } from '../domain/pandaBridge';
import { activityItem } from '../runtime/kandev/bridgeActivity';
import { trackRecords } from '../runtime/kandev/capabilityRegistry';

let dir: string; let db: CoreDatabase; let pairingId: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-compat-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  pairingId = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'Chrome' }).pairing.id;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** Rows exactly as the previous release wrote them: no task class on checkpoints, results from the old mirror, sparse source refs. */
function legacyTask(id: string, status: string, over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bridge_tasks (id, pairingId, clientRequestId, instruction, instructionSha256, sourceRef, status, statusDetail, control, result, executor, routing, createdAt, updatedAt, completedAt)
     VALUES (?, ?, ?, 'old task', 'x', '{}', ?, ?, 'none', ?, ?, 'explicit', ?, ?, ?)`,
    [id, pairingId, `legacy-${id}`, status, over.statusDetail ?? null, over.result ?? null, over.executor ?? 'opencode', now, now, status === 'completed' ? now : null],
  );
  db.run("INSERT INTO bridge_task_checkpoints (taskId, status, detail, createdAt) VALUES (?, 'dispatching', 'Starting opencode.', ?)", [id, now]);
}

describe('records written by the previous release', () => {
  it('every old status still renders in the new activity vocabulary', () => {
    const statuses = ['awaiting_executor', 'dispatching', 'running', 'awaiting_approval', 'verifying', 'paused', 'needs_attention', 'completed', 'failed', 'cancelled'];
    for (const s of statuses) legacyTask(`ptask_${s}`, s);
    for (const s of statuses) {
      const item = activityItem(db, getBridgeTask(db, `ptask_${s}`), 'Chrome');
      expect(item.stateLabel, s).toBeTruthy();
      expect(item.origin.title).toBeNull();
    }
  });

  it('an old completed result without activity/timeline keys, and a task with no attempt, do not break the view', () => {
    legacyTask('ptask_old_done', 'completed', { result: JSON.stringify({ verification: 'independent', evidence: 'npm test: 3 passed', changedFiles: ['a.js'], commit: 'abc1234', pendingApprovals: [] }), statusDetail: 'Finished and verified.' });
    const item = activityItem(db, getBridgeTask(db, 'ptask_old_done'), 'Chrome');
    expect(item).toMatchObject({ state: 'completed', verification: 'independent', progress: null });
  });

  it('old checkpoints (no task class) simply contribute nothing to demonstrated reliability', () => {
    legacyTask('ptask_old_ok', 'completed');
    expect(trackRecords(db).size).toBe(0);
  });
});

describe('browser report wording and sanitization', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'panda-bridge', 'extension', 'content.js'), 'utf8');
  const a = src.indexOf('  function scrub'); const b = src.indexOf('  // Appends to whatever');
  const { buildReport } = new Function(`${src.slice(a, b)}; return { buildReport };`)() as { buildReport: (t: Record<string, unknown>) => string };

  it('shows the outcome and says plainly when it is only the executor\'s own report', () => {
    const r = buildReport({ id: 'ptask_1', status: 'completed', instruction: 'List files', executor: 'native', statusDetail: 'Finished.', result: { verification: 'worker-only', evidence: 'There are 2 files.\n\nHidden entries exist.' } });
    expect(r).toContain('Result: There are 2 files. Hidden entries exist.');
    expect(r).toContain('Verification: the executor');
    expect(r).toContain('not independently verified');
    expect(r.split('\n').length).toBeGreaterThan(5);
  });

  it('removes local paths and secret-looking tokens from every field', () => {
    const r = buildReport({
      id: 'ptask_2', status: 'completed', instruction: 'Fix C:/Users/bob/secret_proj/a.ts with key sk-abcdefghijklmnopqrstuv',
      statusDetail: 'wrote D:/Projects/x/y.js', result: { verification: 'independent', evidence: 'saved to \\\\server\\share\\f.txt and /Users/bob/n.txt', changedFiles: ['E:/work/a.js'] },
    });
    expect(r).not.toMatch(/bob|secret_proj|sk-abc|server|E:\/work|D:\/Projects/);
    expect(r).toContain('<path>');
    expect(r).toContain('<secret>');
  });
});
