/**
 * "What did you do for me in the last hour?" (everyday tasks, 2026-11-24): after eleven tasks in other chats, a new chat
 * answered "I have not performed any actions". The answer now comes from Core's task and tool records, and keeps
 * completed, attempted and failed work apart.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { activityWindow, answerActivityQuestion, collectActivity } from '../runtime/activityReport';
import { groupOfTool } from '../runtime/chatToolSelection';
import { classifyChatToolCall } from '../domain/permissionModes';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');

describe('which messages ask for an activity report, and about which period', () => {
  it('recognises the question and its period', () => {
    expect(activityWindow('What did you do for me in the last hour?', NOW)).toEqual({ sinceMs: NOW - 3_600_000, label: 'in the last hour' });
    expect(activityWindow('what have you done in the past 30 minutes', NOW)).toEqual({ sinceMs: NOW - 30 * 60_000, label: 'in the last 30 minutes' });
    expect(activityWindow('What did you get done over the last 2 days?', NOW)).toMatchObject({ sinceMs: NOW - 2 * 86_400_000, label: 'in the last 2 days' });
    expect(activityWindow('What did you do today?', NOW)?.label).toBe('today');
    expect(activityWindow('Tell me what you did yesterday', NOW)?.label).toBe('since yesterday morning');
    expect(activityWindow('What have you done?', NOW)).toEqual({ sinceMs: NOW - 24 * 3_600_000, label: 'in the last 24 hours' });
    expect(activityWindow('Give me an activity report', NOW)?.label).toBe('in the last 24 hours');
  });

  it('leaves other messages alone', () => {
    for (const text of [
      'What did you do to my report?', 'What can you do?', 'What did the meeting notes say I have to do?', 'Do the dishes reminder in the last hour',
      'What do you think about this plan?', 'Open Notepad.', 'What have you done with the file I gave you this morning, where is it and why is it empty, explain everything',
    ]) expect(activityWindow(text, NOW), text).toBeNull();
  });

  it('is offered as a read-only tool with the personal group', () => {
    expect(groupOfTool('activity_report')).toBe('personal');
    expect(classifyChatToolCall('activity_report', { minutes: 60 }, new Set(), null)).toBe('read');
  });
});

describe('the report is what Core recorded', () => {
  let dir: string;
  let db: CoreDatabase;
  let n = 0;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  /** One request in its own chat, as the everyday-task runner made them, placed `minutesAgo` before NOW. */
  function task(message: string, minutesAgo: number, status: string, extra: { failureReason?: string; outcome?: string; blocker?: string } = {}) {
    const conversationId = createConversation(db, { mode: 'saath_kar', actor: 'test' }).id;
    const r = submitRequest(db, {
      clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar', conversationId, workspaceRoot: dir,
      capability: { hasWorkspace: true, gitCapable: false }, correlationId: `c-${++n}`, toolPermissionPolicy: {},
      selectedProvider: 'ollama', selectedModel: 'gemma4:12b',
    });
    const at = new Date(NOW - minutesAgo * 60_000).toISOString();
    db.run('UPDATE requests SET createdAt = ? WHERE id = ?', [at, r.request.id]);
    db.run('UPDATE attempts SET status = ?, failureReason = ?, completedAt = ? WHERE id = ?', [status, extra.failureReason ?? null, at, r.attempt!.id]);
    if (extra.outcome) db.run('INSERT INTO task_outcomes (attemptId, conversationId, requestId, objective, successCriteria, capabilities, evidence, status, blocker, nextAction, summary, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.attempt!.id, conversationId, r.request.id, message, '[]', '[]', '[]', extra.outcome, extra.blocker ?? null, null, null, at, at]);
    return { attemptId: r.attempt!.id, requestId: r.request.id, at };
  }
  function tool(t: { attemptId: string; at: string }, toolName: string, status: string, evidence: Record<string, unknown> = {}, args: Record<string, unknown> = {}) {
    db.run('INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)', [`t-${++n}`, t.attemptId, toolName, JSON.stringify(args), status, t.at, JSON.stringify(evidence)]);
  }

  it('answers from the records of every chat and separates completed, attempted and failed', () => {
    const renamed = task('Rename draft.txt to final.txt.', 50, 'completed', { outcome: 'satisfied' });
    tool(renamed, 'move_file', 'succeeded', { output: 'Renamed draft.txt to final.txt', activity: { kind: 'tool', title: 'Renamed draft.txt to final.txt' } });
    tool(renamed, 'update_task_outcome', 'succeeded');
    const opened = task('Open Notepad.', 40, 'completed', { outcome: 'satisfied' });
    tool(opened, 'open_app', 'succeeded', { activity: { kind: 'tool', title: 'Opened Notepad' } });
    const stopped = task('Open Notepad.', 35, 'cancelled');
    tool(stopped, 'open_app', 'succeeded', { activity: { kind: 'tool', title: 'Opened Notepad' } });
    const partial = task('Create a file shopping.txt with milk, eggs and bread', 30, 'completed', { outcome: 'partial', blocker: 'the file was not written' });
    tool(partial, 'write_file', 'failed', { output: 'NOT DONE (read-only folder): nothing was written.' }, { filePath: 'shopping.txt' });
    tool(partial, 'list_directory', 'succeeded', {}, { path: '.' });
    const failed = task('Rename draft.txt to final.txt.', 20, 'failed', { failureReason: 'Partly done: still missing final.txt' });
    tool(failed, 'write_file', 'succeeded', {}, { filePath: 'final.txt' });
    const chatOnly = task('What is 17 times 23?', 10, 'completed', { outcome: 'satisfied' });
    task('Summarise the Q2 plan', 600, 'completed'); // ten hours ago: outside the hour
    task('M38 governed capability dispatch anchor for conv_x', 12, 'completed'); // Core's own bookkeeping row, never a request
    const asking = task('What did you do for me in the last hour?', 0, 'running');

    const report = collectActivity(db, { sinceMs: NOW - 3_600_000, nowMs: NOW, excludeRequestId: asking.requestId });
    expect(report.tasks.map((t) => [t.message.slice(0, 12), t.state])).toEqual([
      ['What is 17 t', 'completed'], ['Rename draft', 'failed'], ['Create a fil', 'attempted'], ['Open Notepad', 'attempted'], ['Open Notepad', 'completed'], ['Rename draft', 'completed'],
    ]);
    expect(report.tasks.find((t) => t.requestId === renamed.requestId)!.done.map((a) => a.tool)).toEqual(['move_file']); // bookkeeping is not an action

    const answer = answerActivityQuestion(db, 'What did you do for me in the last hour?', { nowMs: NOW, excludeRequestId: asking.requestId })!;
    expect(answer).toMatch(/you gave me 6 requests: 3 completed, 2 attempted but not finished, 1 failed\. Across them 5 recorded actions succeeded and 1 did not\./);
    expect(answer).toMatch(/\*\*Completed \(3\):\*\*[\s\S]*Renamed draft\.txt to final\.txt \(move file\)[\s\S]*Opened Notepad \(open app\)/);
    expect(answer).toMatch(/"What is 17 times 23\?"\n {2}- Answered in the chat; no action on the PC was recorded\./);
    expect(answer).toMatch(/\*\*Attempted, not finished \(2\):\*\*[\s\S]*the file was not written\n {2}- Done: list directory: \.\n {2}- Tried, did not work: write file: shopping\.txt — NOT DONE \(read-only folder\)/);
    expect(answer).toMatch(/"Open Notepad\." — stopped before it finished\n {2}- Done: Opened Notepad/);
    expect(answer).toMatch(/\*\*Failed \(1\):\*\*\n- .*Partly done: still missing final\.txt/);
    expect(answer).not.toMatch(/Q2 plan|What did you do for me/); // outside the period; the question itself
    expect(answer).toMatch(/From Core's task and tool records \(all chats\), not from my memory of this chat\.$/);
  });

  it('counts every request of the period even when only the newest are listed', () => {
    for (let i = 0; i < 30; i++) task(`Task number ${i}`, 5 + i, i % 3 === 0 ? 'failed' : 'completed', i % 3 === 0 ? { failureReason: 'it broke' } : {});
    const report = collectActivity(db, { sinceMs: NOW - 3_600_000, nowMs: NOW });
    expect(report.tasks).toHaveLength(25);
    expect(report.truncated).toBe(5);
    expect(report.totals).toEqual({ completed: 20, attempted: 0, failed: 10 });
    const answer = answerActivityQuestion(db, 'What did you do in the last hour?', { nowMs: NOW })!;
    expect(answer).toMatch(/you gave me 30 requests: 20 completed, 0 attempted but not finished, 10 failed\. In the newest 25, listed below,/);
    expect(answer).toMatch(/5 older requests are not listed here/);
  });

  it('says so when nothing was recorded, and is silent for other messages', () => {
    task('Summarise the Q2 plan', 600, 'completed');
    const answer = answerActivityQuestion(db, 'What did you do in the last hour?', { nowMs: NOW })!;
    expect(answer).toMatch(/^Core has no record of any request in the last hour \(\d\d:\d\d–\d\d:\d\d\), so I did nothing for you in that time\./);
    expect(answerActivityQuestion(db, 'Open Notepad.', { nowMs: NOW })).toBeNull();
  });
});
