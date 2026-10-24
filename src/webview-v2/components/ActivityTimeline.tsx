import React, { useState } from 'react';
import type { TaskActivityEvent } from '../state/types';

/** Renders only real supplied events — never synthesized model reasoning.
 * Raw technical detail (rawProgress) is behind an expandable disclosure so
 * it is not default-visible developer diagnostics. */
export function ActivityTimeline({ events }: { events: TaskActivityEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (events.length === 0) return null;
  return (
    <div className="kd2-activity-timeline" data-testid="activity-timeline">
      <button type="button" className="kd2-activity-timeline__toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? 'Hide details' : 'Show details'} ({events.length})
      </button>
      <ol className="kd2-activity-timeline__list">
        {events.map((event) => (
          <li key={event.id} className="kd2-activity-timeline__item" data-testid="activity-item">
            <span className="kd2-activity-timeline__title">{event.title}</span>
            {event.detail ? <span className="kd2-activity-timeline__detail"> — {event.detail}</span> : null}
            {expanded && event.rawProgress ? (
              <div className="kd2-activity-timeline__raw">{event.rawProgress}</div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
