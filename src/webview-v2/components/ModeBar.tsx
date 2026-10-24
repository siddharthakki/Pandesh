import React from 'react';
import { MODE_LABELS, type ModeId } from '../state/types';

// 0.1 scope: Ask and Plan are not honest product modes yet (the live
// sendToAgent path doesn't apply the policy/system-prompt machinery that
// would make them read-only/distinct from Saath Kar). Hidden here, not
// deleted — canonical ModeId and backend routing keep supporting them.
const MODES: ModeId[] = ['chat', 'agent', 'autonomous'];

export function ModeBar({ mode, onSelect }: { mode: ModeId; onSelect: (mode: ModeId) => void }) {
  return (
    <div className="kd2-mode-bar" role="radiogroup" aria-label="KarkeDikha mode">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          className={`kd2-mode-bar__btn${m === mode ? ' kd2-mode-bar__btn--active' : ''}`}
          role="radio"
          aria-checked={m === mode}
          data-mode={m}
          onClick={() => onSelect(m)}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}
