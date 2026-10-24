import type { ConversationMessageRecord } from '../shared/wireTypes';

/**
 * Generic safety net for the ordinary Baat Kar / Saath Kar chat loop, which
 * (unlike the mission ledger — see `missionCompaction.ts`) otherwise replays
 * a conversation's full message history verbatim every turn with no bound.
 * Not a tokenizer or a per-model measurement (see `ollamaChatControls.ts`'s
 * own caveat) — a conservative character budget so an old, very long
 * conversation degrades to "the most recent messages, with the rest
 * disclosed as omitted" instead of growing the prompt without limit.
 */
export const CHAT_HISTORY_BUDGET_CHARS = 80_000;

export interface BoundedChatHistory {
  messages: ConversationMessageRecord[];
  omittedCount: number;
}

/**
 * Keeps the most recent messages that fit within `budgetChars` (always
 * keeping at least the single most recent message, even if it alone exceeds
 * budget, so the prompt is never emptied). Older messages are dropped from
 * the raw replay; the continuity working-state summary already carries the
 * conversation's objective/constraints forward independently of this replay.
 */
export function boundChatHistoryForReplay(
  history: readonly ConversationMessageRecord[],
  budgetChars: number = CHAT_HISTORY_BUDGET_CHARS,
): BoundedChatHistory {
  const kept: ConversationMessageRecord[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    const length = message.content.length;
    if (kept.length > 0 && total + length > budgetChars) break;
    kept.unshift(message);
    total += length;
  }
  return { messages: kept, omittedCount: history.length - kept.length };
}
