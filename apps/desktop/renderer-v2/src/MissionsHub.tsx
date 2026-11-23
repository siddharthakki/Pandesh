import React, { useEffect, useState } from 'react';
import { MissionDock } from './Missions';
import { Board, type Overview } from './Board';
import { WorkerLog } from './MissionControlPane';
import { engineLabel, eventLine } from './jarvisModel';
import { useTicker, type OperatorData } from './useOperatorData';

export type MissionsTab = 'flight' | 'board' | 'events';

/**
 * Missions: one workspace, three views of the same records. Flight is the live mission and worker cards (real Stop, Pause,
 * Resume, Allow once, View diff, Approve change, Continue); Board is the existing task board; Events is the plain-text
 * execution log Core stored for a worker. No second store, no decorative motion.
 */
export function MissionsHub({ tab, onTab, data, overview, narrow, onOpenPalette, onOpenConversation, focusId }: {
  tab: MissionsTab; onTab: (t: MissionsTab) => void; data: OperatorData; overview: Overview; narrow: boolean;
  onOpenPalette: () => void; onOpenConversation: (id: string) => void; focusId?: string | null;
}) {
  // Agent workers only: service sub-steps (service:*) are plumbing with no event log of their own.
  const workers = data.bridge.filter((b) => (b.storyId || b.executor) && !(b.executor ?? '').startsWith('service:'));
  const [logId, setLogId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { if (focusId && workers.some((w) => w.id === focusId)) setLogId(focusId); }, [focusId]);
  const selected = workers.find((w) => w.id === logId) ?? workers[0] ?? null;
  const live = workers.some((w) => !['completed', 'failed', 'cancelled'].includes(w.state));
  const now = useTicker(live, 2000);
  // The log beside Flight follows the focused task, else the worker that sent an event most recently.
  const byRecent = [...workers].filter((w) => w.executor && !w.executor.startsWith('service:')).sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''));
  const logTarget = workers.find((w) => w.id === focusId) ?? byRecent[0] ?? null;

  return (
    <div className="jv-missions">
      <header className="jv-missions-head">
        <h1>Missions</h1>
        <div className="jv-tabs" role="tablist" aria-label="Mission view">
          {(['flight', 'board', 'events'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`jv-tab${tab === t ? ' on' : ''}`} onClick={() => onTab(t)}>{t === 'flight' ? 'Flight' : t === 'board' ? 'Board' : 'Events'}</button>
          ))}
        </div>
        <span className="jv-hint">Drawn from Core’s records. No event, no movement.</span>
      </header>

      {tab === 'flight' && (
        <div className="jv-flight">
          <div className="jv-flight-main">
            <MissionDock conversationId={null} narrow={narrow} onReport={() => undefined} />
            {!data.missions.some((m) => m.status === 'running') && !workers.length && !data.approvals.length && <p className="jv-empty">No mission or worker is running. Finished work is on the Board.</p>}
          </div>
          {!narrow && logTarget && (
            <aside className="jv-flight-log" aria-label="Live execution log">
              <header>
                <span className={`jv-dot${eventLine(logTarget, now).live ? ' live' : ''}`} aria-hidden="true" />
                <span className="jv-portal-title"><strong>{engineLabel(logTarget.executor)} · {logTarget.stateLabel}</strong><span className="jv-src">{logTarget.eventCount} events · {eventLine(logTarget, now).text}</span></span>
                <button type="button" className="btn link small" onClick={() => onTab('events')}>Full log</button>
              </header>
              <p className="jv-detail">{logTarget.instruction}</p>
              {logTarget.outcome?.summary && <p className="jv-outcome">{logTarget.outcome.summary}</p>}
              <WorkerLog taskId={logTarget.id} eventCount={logTarget.eventCount} />
            </aside>
          )}
        </div>
      )}

      {tab === 'board' && <Board overview={overview} narrow={narrow} onOpenPalette={onOpenPalette} onOpenConversation={onOpenConversation} />}

      {tab === 'events' && (
        <div className="jv-events">
          {!workers.length ? <p className="jv-empty">No worker has recorded events yet.</p> : (
            <>
              <nav className="jv-events-list" aria-label="Worker tasks">
                {workers.map((w) => (
                  <button key={w.id} type="button" className={`jv-events-item${selected?.id === w.id ? ' on' : ''}`} aria-current={selected?.id === w.id ? 'true' : undefined} onClick={() => setLogId(w.id)}>
                    <span className="jv-src">{engineLabel(w.executor)} · {w.stateLabel} · {w.eventCount} ev</span>
                    <span className="jv-events-title">{w.instruction}</span>
                  </button>
                ))}
              </nav>
              <div className="jv-events-log">
                <div className="jv-events-bar">
                  <label className="sr-only" htmlFor="jv-filter">Filter events</label>
                  <input id="jv-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter (edit, ran, permission…)" />
                </div>
                {selected && (
                  <>
                    <p className="jv-events-meta mono">{selected.eventCount} events · {eventLine(selected, now).text}{selected.branch ? ` · branch ${selected.branch}` : ''}</p>
                    {selected.outcome?.summary && <p className="jv-outcome">{selected.outcome.summary}</p>}
                    <WorkerLog taskId={selected.id} eventCount={selected.eventCount} filter={filter} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
