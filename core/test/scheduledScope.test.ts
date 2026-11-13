/**
 * M3 (audit S07): a routine created in a folder runs in that folder with the access it was created with, a routine whose folder
 * is gone does not run blind and says so, and a scheduled run that did not finish its work reaches the notification outbox.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { EventBroadcaster } from '../ws/broadcaster';
import { createScheduledTask } from '../domain/scheduledTasks';
import { startScheduledTaskLoop } from '../runtime/scheduler';
import { listNotifications } from '../domain/notificationOutbox';
import { getAttemptContext } from '../domain/attemptContext';

let dir: string; let ws: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-sched-')); ws = path.join(dir, 'ws'); fs.mkdirSync(ws); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const due = (id: string) => db.run('UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), id]);

describe('scheduled routines keep their scope', () => {
  it('runs in the frozen folder, refuses a missing folder visibly, and reports a run that did not finish', async () => {
    const withScope = createScheduledTask(db, { title: 'Write date', instruction: 'write today.txt', dailyTime: '09:00', timezone: 'Europe/Berlin', scope: { workspaceRoot: ws, workspaceAccess: 'read_write' } });
    const noFolder = createScheduledTask(db, { title: 'Gone folder', instruction: 'write x', dailyTime: '09:05', timezone: 'Europe/Berlin', scope: { workspaceRoot: path.join(dir, 'deleted'), workspaceAccess: 'read_write' } });
    const calls: Array<{ attemptId: string; options?: { workingDirectory?: string } }> = [];
    const executor = {
      contextDefaults: () => ({ selectedModel: 'fake-model', selectedProvider: 'ollama' }),
      // the run "finishes" unfinished: the attempt is failed with the partial prefix
      execute: async (attemptId: string, options?: { workingDirectory?: string }) => { calls.push({ attemptId, options }); db.run("UPDATE attempts SET status = 'failed', failureReason = 'Partly done: still missing today.txt' WHERE id = ?", [attemptId]); },
    };
    due(withScope.id); due(noFolder.id);
    const stop = startScheduledTaskLoop(db, new EventBroadcaster(), executor as never, 60_000);
    try {
      const deadline = Date.now() + 14_000;
      while (Date.now() < deadline && !(calls.length >= 1 && listNotifications(db).length >= 2)) await new Promise((r) => setTimeout(r, 100));
    } finally { stop(); }

    expect(calls).toHaveLength(1);                                          // the missing-folder routine did not run
    expect(calls[0].options?.workingDirectory).toBe(ws);                    // the scoped one ran in its folder
    const context = getAttemptContext(db, calls[0].attemptId);
    expect(context.workspaceRoot).toBe(ws);
    expect((context.approvalPolicy as { workspaceAccess?: string }).workspaceAccess).toBe('read_write');

    const notes = listNotifications(db);
    expect(notes.some((n) => /Gone folder/.test(n.title) && /no longer exists/.test(n.body))).toBe(true);
    expect(notes.some((n) => /Write date/.test(n.title) && n.kind === 'task_failed' && /Partly done/.test(n.body))).toBe(true);
  }, 30_000);
});
