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
  const workers = data.bridge.filter((b) => b.storyId || b.executor);
  const [logId, setLogId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { if (focusId && workers.some((w) => w.id === focusId)) setLogId(focusId); }, [focusId]);
  const selected = workers.find((w) => w.id === logId) ?? workers[0] ?? null;
  const live = workers.some((w) => !['completed', 'failed', 'cancelled'].includes(w.state));
  const now = useTicker(live && tab === 'events', 2000);

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
          <MissionDock conversationId={null} narrow={narrow} onReport={() => undefined} />
          {!data.missions.some((m) => m.status === 'running') && !workers.length && !data.approvals.length && <p className="jv-empty">No mission or worker is running. Finished work is on the Board.</p>}
        </div>
      )}

      {tab === 'board' && <Board overview={overview} narrow={narrow} onOpenPalette={onOpenPalette} onOpenConversation={onOpenConversation} />}

      {tab === 'events' && (
        <div className="jv-events">
          {!workers.length ? <p className="jv-empty">No worker has recorded events yet.</p> : (
            <>
              <div className="jv-events-bar">
                <label className="sr-only" htmlFor="jv-worker">Worker task</label>
                <select id="jv-worker" value={selected?.id ?? ''} onChange={(e) => setLogId(e.target.value)}>
                  {workers.map((w) => <option key={w.id} value={w.id}>{engineLabel(w.executor)} · {w.stateLabel} · {w.instruction.slice(0, 70)}</option>)}
                </select>
                <label className="sr-only" htmlFor="jv-filter">Filter events</label>
                <input id="jv-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter (edit, ran, permission…)" />
              </div>
              {selected && (
                <>
                  <p className="jv-events-meta mono">{selected.eventCount} events · {eventLine(selected, now).text}{selected.branch ? ` · branch ${selected.branch}` : ''}</p>
                  <WorkerLog taskId={selected.id} eventCount={selected.eventCount} filter={filter} />
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
