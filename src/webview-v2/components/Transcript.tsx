import React, { useEffect, useRef } from 'react';
import type { ConversationMessage } from '../state/types';
import { Message } from './Message';

export function Transcript({ messages }: { messages: ConversationMessage[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  return (
    <div className="kd2-transcript" role="log" aria-live="polite">
      {messages.map((m) => (
        <Message key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
