import { describe, expect, it } from 'vitest';
import type { ConversationMessageRecord } from '../shared/wireTypes';
import { boundChatHistoryForReplay, CHAT_HISTORY_BUDGET_CHARS } from '../runtime/chatHistoryBudget';

function message(seq: number, role: 'user' | 'assistant', content: string): ConversationMessageRecord {
  return { seq, id: `m${seq}`, conversationId: 'c1', role, content, modelInvocationId: null, createdAt: new Date(seq).toISOString() };
}

describe('boundChatHistoryForReplay', () => {
  it('keeps everything unchanged when the whole history fits the budget', () => {
    const history = [message(1, 'user', 'hi'), message(2, 'assistant', 'hello')];
    const result = boundChatHistoryForReplay(history, 1_000);
    expect(result.messages).toEqual(history);
    expect(result.omittedCount).toBe(0);
  });

  it('keeps the most recent messages and reports how many were omitted when over budget', () => {
    const history = [
      message(1, 'user', 'a'.repeat(50)),
      message(2, 'assistant', 'b'.repeat(50)),
      message(3, 'user', 'c'.repeat(50)),
      message(4, 'assistant', 'd'.repeat(50)),
    ];
    // Budget fits only the last two messages (50 + 50 = 100).
    const result = boundChatHistoryForReplay(history, 100);
    expect(result.messages.map((m) => m.id)).toEqual(['m3', 'm4']);
    expect(result.omittedCount).toBe(2);
  });

  it('never empties the prompt: keeps at least the single most recent message even if it alone exceeds budget', () => {
    const history = [message(1, 'user', 'short'), message(2, 'assistant', 'x'.repeat(500))];
    const result = boundChatHistoryForReplay(history, 10);
    expect(result.messages.map((m) => m.id)).toEqual(['m2']);
    expect(result.omittedCount).toBe(1);
  });

  it('returns nothing omitted for an empty history', () => {
    const result = boundChatHistoryForReplay([], 1_000);
    expect(result.messages).toEqual([]);
    expect(result.omittedCount).toBe(0);
  });

  it('defaults to the exported budget constant when none is passed', () => {
    const history = [message(1, 'user', 'x'.repeat(CHAT_HISTORY_BUDGET_CHARS + 1))];
    const withDefault = boundChatHistoryForReplay(history);
    const withExplicit = boundChatHistoryForReplay(history, CHAT_HISTORY_BUDGET_CHARS);
    expect(withDefault).toEqual(withExplicit);
  });
});
