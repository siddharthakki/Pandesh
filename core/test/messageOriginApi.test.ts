/**
 * Step 0 of the reliability program (owner, 2026-11-13): the Core API used to accept a client-supplied
 * `modelInvocationId` on any message. Cloud chat keeps only assistant messages linked to a cloud model call, so a caller
 * could label private local text as cloud output and have it sent to a cloud provider. The link is now accepted only on
 * an assistant message whose model call ran in the same conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { createConversation, listMessages } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { startModelInvocation } from '../domain/modelInvocations';

const TOKEN = generateToken();
let dir: string; let db: CoreDatabase; let api: RunningApiServer;

const post = (p: string, body: unknown) => fetch(`http://127.0.0.1:${api.port}${p}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client', 'Idempotency-Key': `k-${Math.random()}` },
});

function invocationIn(conversationId: string): string {
  const req = createRequest(db, { clientId: 'desktop', conversationId, currentMessage: 'hi', requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
  const att = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'client:desktop' });
  return startModelInvocation(db, { attemptId: att.id, requestedProvider: 'ollama', requestedModel: 'gemma4:12b', policyModel: 'gemma4:12b', actor: 'test' }).id;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-msgorigin-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  api = await startApiServer({ db, token: TOKEN, broadcaster: new EventBroadcaster(), dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }), onShutdown: () => {} });
});
afterEach(async () => { await api.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('client-supplied message origin', () => {
  it('an intermediate tool-loop model call cannot be claimed as a reply; the last call of the attempt can', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', title: 'a', actor: 'test' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: 'hi', requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'client:desktop' });
    const first = startModelInvocation(db, { attemptId: att.id, requestedProvider: 'ollama', requestedModel: 'm', policyModel: 'm', actor: 'test' }).id;
    await new Promise((r) => setTimeout(r, 5));
    const last = startModelInvocation(db, { attemptId: att.id, requestedProvider: 'ollama', requestedModel: 'm', policyModel: 'm', actor: 'test' }).id;
    expect((await post(`/v1/conversations/${conv.id}/messages`, { role: 'assistant', content: 'forged', modelInvocationId: first })).status).toBe(400);
    expect((await post(`/v1/conversations/${conv.id}/messages`, { role: 'assistant', content: 'reply', modelInvocationId: last })).status).toBe(201);
  });

  it('cannot be bypassed by omitting or spoofing X-Client-Id', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', title: 'a', actor: 'test' });
    const mi = invocationIn(conv.id);
    const raw = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${api.port}/v1/conversations/${conv.id}/messages`, {
      method: 'POST', body: JSON.stringify({ role: 'user', content: 'private', modelInvocationId: mi }),
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': `k-${Math.random()}`, ...headers },
    });
    expect((await raw({})).status).toBe(400);
    expect((await raw({ 'X-Client-Id': '' })).status).toBe(400);
    expect((await raw({ 'X-Client-Id': 'model-pi' })).status).toBe(400);
    expect((await raw({ 'X-Client-Id': 'tool-x' })).status).toBe(400);
    expect(listMessages(db, conv.id)).toHaveLength(0);
  });

  it('rejects a user message that claims a model call', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', title: 'a', actor: 'test' });
    const mi = invocationIn(conv.id);
    const res = await post(`/v1/conversations/${conv.id}/messages`, { role: 'user', content: 'private local note', modelInvocationId: mi });
    expect(res.status).toBe(400);
    expect(listMessages(db, conv.id)).toHaveLength(0);
  });

  it('rejects an assistant message that claims a model call from another conversation or one that does not exist', async () => {
    const a = createConversation(db, { mode: 'saath_kar', title: 'a', actor: 'test' }); const b = createConversation(db, { mode: 'saath_kar', title: 'b', actor: 'test' });
    const foreign = invocationIn(b.id);
    expect((await post(`/v1/conversations/${a.id}/messages`, { role: 'assistant', content: 'x', modelInvocationId: foreign })).status).toBe(400);
    expect((await post(`/v1/conversations/${a.id}/messages`, { role: 'assistant', content: 'x', modelInvocationId: 'mi_does_not_exist' })).status).toBe(400);
    expect(listMessages(db, a.id)).toHaveLength(0);
  });

  it('still accepts an assistant message linked to this conversation\'s own model call, and unlinked messages', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', title: 'a', actor: 'test' });
    const own = invocationIn(conv.id);
    expect((await post(`/v1/conversations/${conv.id}/messages`, { role: 'assistant', content: 'reply', modelInvocationId: own })).status).toBe(201);
    expect((await post(`/v1/conversations/${conv.id}/messages`, { role: 'user', content: 'plain' })).status).toBe(201);
    expect(listMessages(db, conv.id)).toHaveLength(2);
  });
});

import { appendMessage } from '../domain/conversations';
describe('the check lives in appendMessage, not in a route', () => {
  it('a client-originated call cannot link a foreign or already-linked invocation; an internal call (no clientId) can', () => {
    const a = createConversation(db, { mode: 'saath_kar', title: 'a', actor: 'test' }); const b = createConversation(db, { mode: 'saath_kar', title: 'b', actor: 'test' });
    const foreign = invocationIn(b.id); const own = invocationIn(a.id);
    expect(() => appendMessage(db, a.id, { role: 'assistant', content: 'x', modelInvocationId: foreign, actor: 'c', clientId: 'desktop' })).toThrow(/modelInvocationId/);
    appendMessage(db, a.id, { role: 'assistant', content: 'x', modelInvocationId: own, actor: 'c', clientId: 'desktop' });
    expect(() => appendMessage(db, a.id, { role: 'assistant', content: 'again', modelInvocationId: own, actor: 'c', clientId: 'desktop' })).toThrow(/modelInvocationId/);
    expect(appendMessage(db, b.id, { role: 'assistant', content: 'engine reply', modelInvocationId: foreign, actor: 'core' }).modelInvocationId).toBe(foreign);
  });
});
