/**
 * P0: the executor path (Saath Kar / legacy chat) rebuilt its history from prose plus the working-state brief. A tool
 * result from an earlier turn — here a reminder id the reply never quoted — must reach its next model call too.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { RuntimeExecutor } from '../runtime/executor';

describe('executor context carries the tool execution journal', () => {
  it('a reminder id from an earlier turn reaches the next model call; another conversation\'s does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-exec-journal-'));
    const db = openDatabase(path.join(dir, 'core.db'));
    runMigrations(db);
    try {
      const mk = (title: string) => {
        const conv = createConversation(db, { mode: 'saath_kar', actor: 'user', title });
        const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: 'Remind me to call Bob', requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
        const att = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'test' });
        return { conv, att };
      };
      const a = mk('A');
      const id = 'reminder_abcdefab-1234-4abc-8abc-abcdefabcdef';
      const inv = startToolInvocation(db, { attemptId: a.att.id, toolName: 'create_reminder', argsSummary: { title: 'Call Bob' }, actor: 'test' });
      completeToolInvocation(db, inv.id, { actor: 'test', status: 'succeeded', exitCode: 0, evidence: { output: `Reminder created (id ${id})` }, result: { text: `Reminder created (id ${id}): "Call Bob"` } });
      appendMessage(db, a.conv.id, { role: 'user', content: 'Remind me to call Bob', actor: 'user' });
      appendMessage(db, a.conv.id, { role: 'assistant', content: 'Done!', actor: 'assistant' });
      appendMessage(db, a.conv.id, { role: 'user', content: 'Dismiss that reminder', actor: 'user' });

      const executor = new RuntimeExecutor(db, new EventBroadcaster());
      const context: any = { selectedModel: 'fake-model', selectedProvider: 'ollama', modelSelection: { requiredCapabilities: {} }, contextPolicy: { includeConversationHistory: true } };
      const { messages } = (executor as any).buildMessages('saath_kar', a.conv.id, 'Dismiss that reminder', null, undefined, undefined, context, []);
      const text = messages.map((m: any) => String(m.content)).join('\n');
      expect(text).toContain('EXECUTION JOURNAL');
      expect(text).toMatch(new RegExp(`RESOLVED REFERENCE:[^\n]*${id}`));

      const b = mk('B');
      appendMessage(db, b.conv.id, { role: 'user', content: 'Dismiss that reminder', actor: 'user' });
      const other = (executor as any).buildMessages('saath_kar', b.conv.id, 'Dismiss that reminder', null, undefined, undefined, context, []).messages;
      expect(other.map((m: any) => String(m.content)).join('\n')).not.toContain(id);
    } finally {
      try { db.close(); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
