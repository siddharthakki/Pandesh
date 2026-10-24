import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { EventBroadcaster } from '../ws/broadcaster';
import { appendMessage, createConversation, listMessages } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { listResponseAlternatives, registerResponseAlternative, setActiveResponseAlternative } from '../domain/workbench';
import { createResearchSession, listCitationsForMessage, recordCitations, recordResearchSource } from '../domain/research';
import { RuntimeExecutor } from '../runtime/executor';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';

let dir: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-workbench-execution-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('M36 response regeneration', () => {
  it('keeps cited response alternatives durable across restart with one restored active selection and no repeat research request', async () => {
    const requests: ModelChatRequest[] = [];
    const backend: ModelBackend = { async streamChat(request, _token): Promise<ModelChatResult> {
      requests.push(request);
      return { content: 'A regenerated answer. [S1]', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    } };
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const research = createResearchSession(db, { conversationId: conversation.id, query: 'What is durable?', provider: 'searxng', actor: 'test' });
    const user = listMessages(db, conversation.id).at(-1)!;
    const source = recordResearchSource(db, {
      researchId: research.session.id, resultRank: 1, normalizedUrl: 'https://example.test/durable', finalUrl: 'https://example.test/durable',
      title: 'Durability evidence', provider: 'searxng', retrievedAt: new Date().toISOString(), httpStatus: 200, contentType: 'text/html',
      extractedTextHash: 'extracted-hash', rawResponseHash: 'raw-hash', extractedText: 'Durability evidence.', status: 'fetched', failure: null,
    });
    const original = appendMessage(db, conversation.id, { role: 'assistant', content: 'The original answer. [S1]', actor: 'test' });
    recordCitations(db, original.id, [{ sourceId: source.id, label: 'S1' }]);
    registerResponseAlternative(db, { conversationId: conversation.id, userMessageId: user.id, assistantMessageId: original.id, activate: true });
    const submission = submitRequest(db, {
      clientId: 'test', currentMessage: user.content, requestedMode: 'baat_kar', conversationId: conversation.id,
      selectedProvider: 'ollama', selectedModel: 'fixture', correlationId: 'regeneration-test',
      reuseUserMessageId: user.id, regenerateAssistantMessageId: original.id,
    });
    const executor = new RuntimeExecutor(db, new EventBroadcaster(), { backend, defaultModel: 'fixture' });
    await executor.execute(submission.attempt.id);

    expect(requests).toHaveLength(1);
    expect(requests[0].messages.map(message => message.content)).toEqual(expect.arrayContaining(['What is durable?']));
    expect(requests[0].messages.map(message => message.content)).not.toContain('The original answer. [S1]');
    expect(listMessages(db, conversation.id).map(message => message.content)).toEqual(['What is durable?', 'The original answer. [S1]', 'A regenerated answer. [S1]']);
    const alternatives = listResponseAlternatives(db, conversation.id, user.id);
    expect(alternatives).toHaveLength(2);
    expect(alternatives.map(alternative => alternative.active)).toEqual([false, true]);
    expect(alternatives.map(alternative => alternative.userMessageId)).toEqual([user.id, user.id]);
    const regenerated = listMessages(db, conversation.id).at(-1)!;
    expect(listCitationsForMessage(db, regenerated.id).map(citation => citation.validationStatus)).toEqual(['valid']);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM research_sessions WHERE conversationId = ?', [conversation.id])?.count).toBe(1);

    setActiveResponseAlternative(db, { conversationId: conversation.id, alternativeId: alternatives[0].id, actor: 'test' });
    db.close();
    db = openCoreDatabase(path.join(dir, 'core.db')).db;

    const afterRestart = listResponseAlternatives(db, conversation.id, user.id);
    expect(afterRestart).toHaveLength(2);
    expect(afterRestart.map(alternative => alternative.active)).toEqual([true, false]);
    expect(listMessages(db, conversation.id).map(message => message.content)).toEqual(['What is durable?', 'The original answer. [S1]', 'A regenerated answer. [S1]']);
    expect(listCitationsForMessage(db, original.id).every(citation => citation.validationStatus === 'valid')).toBe(true);
    expect(listCitationsForMessage(db, regenerated.id).every(citation => citation.validationStatus === 'valid')).toBe(true);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM research_sessions WHERE conversationId = ?', [conversation.id])?.count).toBe(1);
  });
});
