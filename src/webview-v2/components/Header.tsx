import React from 'react';

export function Header({
  onNewChat,
  onToggleHistory,
  onToggleActivity,
  historyOpen,
  activityOpen,
}: {
  onNewChat: () => void;
  onToggleHistory: () => void;
  onToggleActivity: () => void;
  historyOpen: boolean;
  activityOpen: boolean;
}) {
  return (
    <header className="kd2-header">
      <span className="kd2-header__brand">KarkeDikha</span>
      <div className="kd2-header__actions">
        <button type="button" className="kd2-header__btn" onClick={onNewChat}>
          ＋ New chat
        </button>
        <button
          type="button"
          className="kd2-header__btn"
          aria-pressed={historyOpen}
          aria-controls="kd2-history-drawer"
          onClick={onToggleHistory}
        >
          History
        </button>
        <button
          type="button"
          className="kd2-header__btn"
          aria-pressed={activityOpen}
          aria-controls="kd2-activity-panel"
          onClick={onToggleActivity}
        >
          Activity
        </button>
        <button type="button" className="kd2-header__btn kd2-header__btn--icon" aria-haspopup="true" title="More">
          ⋯
        </button>
      </div>
    </header>
  );
}
