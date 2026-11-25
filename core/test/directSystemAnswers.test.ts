import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, listMessages } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt, getAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { piAgentEngine } from '../runtime/piAgentEngine';
import { drivesAsked, formatDiskSpace, isDiskSpaceRequest } from '../runtime/directSystemAnswers';

const TELEMETRY = JSON.stringify({
  CPU: { Model: 'AMD Ryzen 9 5900X', Cores: 12, LoadPercent: 7 },
  Disks: [{ DeviceId: 'C:', TotalGB: 930.5, FreeGB: 412.3 }, { DeviceId: 'D:', TotalGB: 1862.9, FreeGB: 1500 }, { DeviceId: 'E:', TotalGB: 500, FreeGB: 20 }],
});

describe('a plain free-space question is answered from the disk tool, without a model', () => {
  it('recognises the plain questions', () => {
    for (const q of [
      'How much free space is left on my C: and D: drives?',
      'How much disk space do I have left?',
      'what is the free space on the D drive',
      'How much storage is available on C:?',
      'free disk space?',
    ]) expect(isDiskSpaceRequest(q), q).toBe(true);
  });
  it('leaves everything that asks for more to the model', () => {
    for (const q of [
      'Free up space on my C: drive',
      'Which folders use the most disk space?',
      'Why is my disk space running out?',
      'How much space is left, and then delete the temp files',
      'Is there enough space for a 50 GB model?',
      'List the files in D:\\Projects and their size',
      'I need more free space. Can you clean up my downloads? Thanks.',
      'What GPU do I have?',
      '',
    ]) expect(isDiskSpaceRequest(q), q).toBe(false);
  });
  it('reads the drives the question names', () => {
    expect(drivesAsked('How much free space is left on my C: and D: drives?')).toEqual(['C', 'D']);
    expect(drivesAsked('free space on the D drive')).toEqual(['D']);
    expect(drivesAsked('C and D drives free space')).toEqual(['C', 'D']);
    expect(drivesAsked('How much disk space is left?')).toEqual([]);
    expect(drivesAsked('space in D:\\Projects')).toEqual([]); // a path is not a drive question
  });
  it('writes the answer from the tool\'s own numbers', () => {
    const both = formatDiskSpace(TELEMETRY, ['C', 'D'])!;
    expect(both).toContain('**C:** 412.3 GB free of 930.5 GB (44% free)');
    expect(both).toContain('**D:** 1,500 GB free of 1,862.9 GB (81% free)');
    expect(both).not.toContain('E:');
    expect(formatDiskSpace(TELEMETRY, [])!).toContain('**E:** 20 GB free of 500 GB (4% free)'); // no drive named: every local drive
  });
  it('says so when a named drive does not exist, and hands over to the model when it cannot read the numbers', () => {
    expect(formatDiskSpace(TELEMETRY, ['C', 'Z'])).toContain('No local drive Z: was found.');
    expect(formatDiskSpace(TELEMETRY, ['Z'])).toBeNull();
    expect(formatDiskSpace('not json', [])).toBeNull();
    expect(formatDiskSpace(JSON.stringify({ CPU: {} }), [])).toBeNull();
    expect(formatDiskSpace(JSON.stringify({ Disks: { DeviceId: 'C:', TotalGB: 100, FreeGB: 50 } }), ['C'])).toContain('**C:** 50 GB free of 100 GB (50% free)'); // PowerShell gives one disk as an object
  });
});

describe('the turn itself: no model is asked', () => {
  let db: CoreDatabase; let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-direct-')); db = openDatabase(path.join(dir, 'core.db')); runMigrations(db); });
  afterEach(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

  const turn = async (text: string, dispatched: string[]) => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Disk' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `corr_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop', clientId: 'desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const capabilities = {
      definitions: [{ name: 'system_hardware_telemetry' }],
      dispatch: async (name: string) => { dispatched.push(name); return { outcome: 'executed', toolInvocation: { status: 'succeeded', evidence: { output: TELEMETRY } } }; },
    } as never;
    const result = await piAgentEngine.executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, capabilities, model: 'no-such-model:0b' });
    return { result, conv, att };
  };

  it('answers a free-space question from the disk tool alone, and records it', async () => {
    const dispatched: string[] = [];
    const { result, conv, att } = await turn('How much free space is left on my C: and D: drives?', dispatched);
    expect(dispatched).toEqual(['system_hardware_telemetry']);
    expect(result.success).toBe(true);
    expect(result.reply).toContain('**C:** 412.3 GB free of 930.5 GB');
    expect(result.reply).toContain('**D:** 1,500 GB free');
    expect(listMessages(db, conv.id).some((m) => m.role === 'assistant' && m.content === result.reply)).toBe(true);
    expect(getAttempt(db, att.id)?.status).toBe('completed');
  });
});
