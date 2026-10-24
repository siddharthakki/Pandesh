import React from 'react';
import type { ConversationSummary } from '../state/types';

export function HistoryDrawer({
  open,
  conversations,
  selectedConversationId,
  onSelect,
}: {
  open: boolean;
  conversations: ConversationSummary[];
  selectedConversationId?: string;
  onSelect: (id: string) => void;
}) {
  if (!open) return null;
  return (
    <div id="kd2-history-drawer" className="kd2-drawer" role="region" aria-label="Conversation history">
      {conversations.length === 0 ? (
        <div className="kd2-drawer__empty">No conversations yet</div>
      ) : (
        <ul className="kd2-drawer__list">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`kd2-drawer__item${c.id === selectedConversationId ? ' kd2-drawer__item--active' : ''}`}
                onClick={() => onSelect(c.id)}
              >
                {c.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
