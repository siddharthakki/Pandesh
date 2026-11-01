import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { buildMinimalPdf } from './fixtures/documentFixtures';
import { startScriptedOllama, afterToolResult, type ScriptedOllama } from './support/scriptedOllama';

/** read_file on a PDF hands the model the document's text (extracted locally), not UTF-8-decoded binary. */

let model: ScriptedOllama;
let previousUrl: string | undefined;
let tempDir: string;
let toolOutput: string | null = null;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-readdoc-'));
  fs.mkdirSync(path.join(tempDir, 'ws'));
  fs.writeFileSync(path.join(tempDir, 'ws', 'invoice.pdf'), buildMinimalPdf('Invoice INV-2041 from Northwind Traders total 1234.50 EUR'));
  model = await startScriptedOllama((call) => {
    const out = afterToolResult(call);
    if (out !== null) { toolOutput = out; return { text: 'Read it.' }; }
    return { tool: { name: 'read_file', args: { filePath: 'invoice.pdf' } } };
  });
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = model.url;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await model.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe('read_file extracts documents', () => {
  it('returns the PDF text layer to the model', async () => {
    const { PiAgentEngine } = await import('../runtime/piAgentEngine');
    const db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    try {
      const text = 'Read invoice.pdf and tell me the total';
      const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Doc' });
      appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
      const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
      const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
      const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
      await new PiAgentEngine().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, workspaceRoot: path.join(tempDir, 'ws'), prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model' });
      expect(toolOutput).toContain('INV-2041');
      expect(toolOutput).toContain('Northwind Traders');
      expect(toolOutput).not.toContain('%PDF');
    } finally {
      db.close();
    }
  }, 30_000);
});
