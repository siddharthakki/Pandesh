/**
 * Micro-test cluster C4 (D-JOB-1): JOB-011 asked for the application deadline two turns after the posting was read;
 * the model said the posting has none. The posting's text from the earlier read_file must reach the next turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createRequest } from '../domain/requests';
import { createConversation } from '../domain/conversations';
import { listEarlierReads, renderEarlierReadsSection } from '../domain/earlierReads';

const POSTING = '# Product Manager (m/f/d) - Ulm\nSalary: 72,000-85,000 EUR per year.\nApplication deadline: 30 November 2026.\nApply at: https://careers.example.com/danube-digital/pm-ulm';

let dir: string;
let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-earlier-reads-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
function turnWithTool(conversationId: string, tool: string, args: Record<string, unknown>, output: string, status = 'succeeded'): string {
  seq += 1;
  const request = createRequest(db, {
    clientId: 'client-1', currentMessage: `turn ${seq}`, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId,
    contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
    correlationId: `corr-${seq}`,
  });
  const at = new Date(Date.UTC(2026, 10, 11, 12, 0, seq)).toISOString();
  db.run(`INSERT INTO attempts (id, requestId, kind, status, createdAt, updatedAt, revision) VALUES (?, ?, 'saath_kar', 'completed', ?, ?, 1)`, [`att_${seq}`, request.id, at, at]);
  db.run(`INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt, endedAt, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [`ti_${seq}`, `att_${seq}`, tool, JSON.stringify(args), status, at, at, JSON.stringify({ output })]);
  return request.id;
}

function conversation(): string {
  return createConversation(db, { mode: 'saath_kar', actor: 'client-1' }).id;
}

describe('files read earlier in a conversation', () => {
  it('carries the posting read two turns ago into the next turn (JOB-011)', () => {
    const conv = conversation();
    turnWithTool(conv, 'read_file', { filePath: 'D:\\ws\\job\\pm-role-ulm.md' }, POSTING);
    turnWithTool(conv, 'calculate', { expression: '1+1' }, '2');
    const now = turnWithTool(conv, 'resolve_time', { expression: 'today' }, 'x');
    const section = renderEarlierReadsSection(listEarlierReads(db, conv, { excludeRequestId: now }));
    expect(section).toContain('Application deadline: 30 November 2026');
    expect(section).toContain('Salary: 72,000-85,000 EUR');
    expect(section).toContain('pm-role-ulm.md');
  });

  it('keeps only the latest read of a file, skips failed reads and other conversations', () => {
    const conv = conversation();
    const other = conversation();
    turnWithTool(conv, 'read_file', { filePath: 'notes.md' }, 'old text');
    turnWithTool(conv, 'read_file', { filePath: 'notes.md' }, 'new text');
    turnWithTool(conv, 'read_file', { filePath: 'missing.md' }, 'Error: not found', 'failed');
    turnWithTool(other, 'read_file', { filePath: 'secret.md' }, 'other conversation');
    const reads = listEarlierReads(db, conv);
    expect(reads.map((r) => [r.target, r.content])).toEqual([['notes.md', 'new text']]);
  });

  it('is bounded and empty when nothing was read', () => {
    const conv = conversation();
    expect(renderEarlierReadsSection(listEarlierReads(db, conv))).toBe('');
    turnWithTool(conv, 'document_read', { path: 'big.pdf' }, 'x'.repeat(50_000));
    const section = renderEarlierReadsSection(listEarlierReads(db, conv));
    expect(section.length).toBeLessThan(2_500);
    expect(section).toContain('read the file again for the rest');
  });
});
