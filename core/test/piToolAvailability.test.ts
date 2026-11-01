import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { isSmallTalk } from '../domain/conversationRelevance';
import { startScriptedOllama, type ScriptedOllama } from './support/scriptedOllama';

/**
 * Ordinary requests reach a model that HAS tools. Previously a request under 200 characters that matched none of the
 * workspace keyword markers was sent to a tool-less model, which could only offer to act ("Would you like me to check
 * your email?") — the root of the generic, repeated-question and stale-answer replies.
 */

describe('isSmallTalk', () => {
  it.each(['hi', 'Hello!', 'hey pandesh', 'Pandesh, good morning', 'thanks!', 'Thank you so much.', 'ok', 'got it, thanks', 'bye', 'who are you?', 'what model are you running?'])('"%s" is small talk', (text) => {
    expect(isSmallTalk(text)).toBe(true);
  });
  it.each(['check my mail', 'how hot is it in Delhi?', "what's on my schedule tomorrow", 'find my tax return pdf', 'hi, check my mail', 'thanks, now delete the draft', 'who won the match yesterday?', 'ok print it'])('"%s" is a request, not small talk', (text) => {
    expect(isSmallTalk(text)).toBe(false);
  });
});

let model: ScriptedOllama;
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;

beforeAll(async () => {
  model = await startScriptedOllama(() => ({ text: 'Done looking.' }));
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = model.url;
  PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await model.close();
});

describe('Pi offers tools to ordinary requests', () => {
  let db: CoreDatabase;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-tools-'));
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  async function firstModelCall(text: string) {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Tools' });
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const before = model.calls.length;
    await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model' });
    return model.calls[before];
  }

  it.each(['check my mail', 'how hot is it in Delhi?', "what's on my schedule tomorrow", 'find my tax return pdf'])('"%s" reaches the model with tools', async (text) => {
    const call = await firstModelCall(text);
    expect(call.tools.length).toBeGreaterThan(0);
    expect(call.tools).toContain('search_files');
  }, 30_000);

  it.each(['hi', 'thanks pandesh!'])('"%s" is answered without tools', async (text) => {
    const call = await firstModelCall(text);
    expect(call.tools).toEqual([]);
  }, 30_000);
});
