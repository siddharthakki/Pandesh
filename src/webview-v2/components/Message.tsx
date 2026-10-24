import React from 'react';
import { Streamdown } from 'streamdown';
import type { ConversationMessage } from '../state/types';

export function Message({ message }: { message: ConversationMessage }) {
  const isUser = message.role === 'user';

  function copy() {
    void navigator.clipboard?.writeText(message.content);
  }

  return (
    <div className={`kd2-message kd2-message--${message.role}`} data-message-id={message.id}>
      <div className="kd2-message__role">{isUser ? 'You' : 'KarkeDikha'}</div>
      {isUser ? (
        <div className="kd2-message__body kd2-message__body--plain">{message.content}</div>
      ) : (
        <div className="kd2-message__body">
          <Streamdown>{message.content}</Streamdown>
        </div>
      )}
      {message.error ? <div className="kd2-message__error">{message.error}</div> : null}
      {!isUser && message.content ? (
        <button type="button" className="kd2-message__copy" onClick={copy} aria-label="Copy response">
          Copy
        </button>
      ) : null}
    </div>
  );
}
