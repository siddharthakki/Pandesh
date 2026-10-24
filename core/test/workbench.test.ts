import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { appendMessage, createConversation, listMessages } from '../domain/conversations';
import { branchConversation, exportConversation, registerResponseAlternative, searchConversations, setActiveResponseAlternative } from '../domain/workbench';

let dir: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-workbench-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('M36 workbench projections', () => {
  it('branches by immutable ancestry without copying or contaminating messages', () => {
    const parent = createConversation(db, { mode: 'baat_kar', title: 'Release notes', actor: 'test' });
    const first = appendMessage(db, parent.id, { role: 'user', content: 'Summarize the attachment', actor: 'test' });
    appendMessage(db, parent.id, { role: 'assistant', content: 'Original answer', actor: 'test' });
    const branch = branchConversation(db, { parentConversationId: parent.id, branchPointMessageId: first.id, actor: 'test' });
    appendMessage(db, branch.id, { role: 'user', content: 'Branch-only follow-up', actor: 'test' });

    expect(listMessages(db, branch.id).map(message => message.content)).toEqual(['Summarize the attachment', 'Branch-only follow-up']);
    expect(listMessages(db, parent.id).map(message => message.content)).toEqual(['Summarize the attachment', 'Original answer']);
    const exported = exportConversation(db, branch.id);
    expect(exported.branch).toMatchObject({ parentConversationId: parent.id, branchPointMessageId: first.id });
    expect(JSON.stringify(exported)).not.toContain('approval');
  });

  it('keeps response alternatives durable and switches the active answer without rewriting history', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', title: 'Routing evidence', actor: 'test' });
    const user = appendMessage(db, conversation.id, { role: 'user', content: 'Which model is suitable?', actor: 'test' });
    const original = appendMessage(db, conversation.id, { role: 'assistant', content: 'Original model answer', actor: 'test' });
    const regenerated = appendMessage(db, conversation.id, { role: 'assistant', content: 'Regenerated model answer', actor: 'test' });
    const one = registerResponseAlternative(db, { conversationId: conversation.id, userMessageId: user.id, assistantMessageId: original.id, activate: true });
    const two = registerResponseAlternative(db, { conversationId: conversation.id, userMessageId: user.id, assistantMessageId: regenerated.id, activate: true });
    const selected = setActiveResponseAlternative(db, { conversationId: conversation.id, alternativeId: one.id, actor: 'test' });

    expect(selected.active).toBe(true);
    expect(exportConversation(db, conversation.id).messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['Original model answer', 'Regenerated model answer']);
    expect(exportConversation(db, conversation.id).messages.find(message => message.id === regenerated.id)?.alternatives[0].active).toBe(false);
    expect(two.ordinal).toBe(1);

    const otherConversation = createConversation(db, { mode: 'baat_kar', title: 'Other durable work', actor: 'test' });
    expect(() => setActiveResponseAlternative(db, { conversationId: otherConversation.id, alternativeId: one.id, actor: 'test' })).toThrow(/not found in this conversation/);
  });

  it('returns deterministic bounded Core-owned search results and excludes internal envelopes', () => {
    const one = createConversation(db, { mode: 'baat_kar', title: 'Model routing', actor: 'test' });
    appendMessage(db, one.id, { role: 'user', content: 'Need a vision-capable local model', actor: 'test' });
    const two = createConversation(db, { mode: 'baat_kar', title: 'Other work', actor: 'test' });
    appendMessage(db, two.id, { role: 'assistant', content: 'No matching phrase here', actor: 'test' });

    const results = searchConversations(db, 'vision-capable', 1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ conversationId: one.id, matchedKinds: ['message'] });
    expect(() => searchConversations(db, 'x'.repeat(201))).toThrow(/exceeds/);
  });
});
