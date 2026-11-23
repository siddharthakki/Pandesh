import React, { useEffect, useMemo, useState } from 'react';
import { api, errorText, onDesktopEvent } from './bridge';
import { buildAgents, type AgentStatus, type ExecutorListing, type SpecialistView } from './agentsModel';
import { useTicker, type OperatorData } from './useOperatorData';

/**
 * Agents: the orchestra. Pandesh (Chief of Staff) above an arc of its specialists, the Kandev coding engines beside it, and
 * the review gate everything passes before it reaches the owner. Every state is Core's: /v1/agents for specialists,
 * /v1/bridge/executors for engines, bridge activity (shared with Home and Missions) for tasks and events. A line glows
 * only from the Chief to a specialist Core reports as working.
 */
export function Agents({ data, onOpenTeam, onOpenTask }: { data: OperatorData; onOpenTeam: () => void; onOpenTask: (id: string) => void }) {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [listing, setListing] = useState<ExecutorListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string>('chief');
  const load = async () => {
    try { const r = await api.household('agents') as { agents: AgentStatus[] }; setAgents(r.agents ?? []); setError(null); } catch (err) { setError(errorText(err)); }
    try { setListing(await api.household('bridgeExecutors') as ExecutorListing); } catch { setListing(null); }
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    const off = onDesktopEvent((e) => { if (e.kind === 'result' || e.kind === 'activity') void load(); });
    return () => { clearInterval(t); off(); };
  }, []);
  const anyLive = data.bridge.some((b) => !['completed', 'failed', 'cancelled'].includes(b.state));
  const now = useTicker(anyLive, 2000);
  const m = useMemo(() => buildAgents(agents, listing, data.bridge, now), [agents, listing, data.bridge, now]);

  const n = m.specialists.length;
  const pos = (i: number) => {
    const th = ((174 - i * (168 / Math.max(1, n - 1))) * Math.PI) / 180;
    return { x: 500 + 440 * Math.cos(th), y: 70 + 420 * Math.sin(th) };
  };
  const selected: SpecialistView | null = sel === 'chief' ? m.chief : sel === 'reviewer' ? m.reviewer : m.specialists.find((s) => s.id === sel) ?? null;
  const working = m.specialists.filter((s) => s.state === 'working' || s.state === 'needs_you');

  return (
    <div className="jv-agents">
      <header className="jv-missions-head">
        <h1>Agents</h1>
        <span className="jv-hint">{working.length} specialist{working.length === 1 ? '' : 's'} working · {m.engines.filter((e) => e.status === 'busy').length} engine{m.engines.filter((e) => e.status === 'busy').length === 1 ? '' : 's'} busy · Kandev {m.kandevRunning === null ? 'not answering' : m.kandevRunning ? 'running' : 'stopped'}</span>
        {error && <span className="jv-note error" role="alert">{error}</span>}
      </header>

      <div className="jv-agents-grid">
        <section className="jv-orchestra" aria-label="Pandesh specialists">
          <svg viewBox="0 0 1000 560" preserveAspectRatio="none" className="jv-orch-lines" aria-hidden="true">
            <ellipse cx="500" cy="70" rx="440" ry="420" className="jv-orch-orbit" />
            {/* A line exists only while Core reports the specialist as working or waiting for the owner. */}
            {m.specialists.filter((s) => s.state === 'working' || s.state === 'needs_you').map((s) => { const p = pos(m.specialists.indexOf(s)); return <line key={s.id} x1="500" y1="96" x2={p.x} y2={p.y} className={`jv-thread live${s.state === 'needs_you' ? ' need' : ''}`} />; })}
          </svg>
          {m.chief && (
            <button type="button" className={`jv-chief${sel === 'chief' ? ' on' : ''}`} onClick={() => setSel('chief')} aria-label={`${m.chief.name}, Chief of Staff, ${m.chief.stateText}`}>
              <span className="jv-chief-orb" aria-hidden="true" />
              <span><strong>{m.chief.name}</strong> · Chief of Staff</span>
              <span className="jv-src">{m.chief.stateText}{m.chief.activeRuns ? ` · ${m.chief.activeRuns} running` : ''}</span>
            </button>
          )}
          {m.specialists.map((s, i) => {
            const p = pos(i);
            return (
              <button key={s.id} type="button" className={`jv-node ${s.state}${sel === s.id ? ' on' : ''}`} style={{ left: `${p.x / 10}%`, top: `${(p.y / 560) * 100}%` }} onClick={() => setSel(s.id)} aria-label={`${s.name}, ${s.stateText}`}>
                <span className="jv-node-orb" aria-hidden="true">{s.name.slice(0, 2).toUpperCase()}</span>
                <span className="jv-node-name">{s.name}</span>
                <span className="jv-src">{s.stateText}</span>
              </button>
            );
          })}
          {!m.specialists.length && <p className="jv-empty" style={{ position: 'absolute', top: '45%', width: '100%', textAlign: 'center' }}>{error ? 'Core did not answer.' : 'Loading the agent registry…'}</p>}
        </section>

        <aside className="jv-engines" aria-label="Coding engines">
          <h2 className="jv-tag">Kandev coding engines</h2>
          {listing === null && <p className="jv-empty">Kandev's engine list is not available (Kandev not answering).</p>}
          {m.engines.map((e) => (
            <div key={e.id} className={`jv-engine ${e.status}${e.primary ? '' : ' minor'}`}>
              <div className="jv-engine-head">
                <span className={`jv-dot${e.live ? ' live' : ''}${e.status === 'waiting_gpu' ? ' need' : ''}`} aria-hidden="true" />
                <strong>{e.label}</strong><span className="jv-src">{e.where}</span>
                <span className="jv-engine-status">{e.statusText}</span>
              </div>
              {e.reason && <p className="jv-detail">{e.reason}</p>}
              {e.tasks.map((t) => (
                <button key={t.id} type="button" className="jv-engine-task" onClick={() => onOpenTask(t.id)}>
                  <span className="jv-src">{t.stateLabel}</span>
                  <span className="jv-events-title">{t.title}</span>
                  <span className={`jv-detail mono${t.live ? '' : ' quiet'}`}>{t.eventText}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="jv-gpu">
            <h2 className="jv-tag">Local GPU</h2>
            <p className="jv-detail">{m.gpu.name ?? 'GPU not reported'} · {m.gpu.lanes} lane{m.gpu.lanes === 1 ? '' : 's'} · {m.gpu.busy} busy · {m.gpu.queued} waiting{m.gpu.freeVramMb !== null && m.gpu.totalVramMb ? ` · ${Math.round(m.gpu.freeVramMb / 1024)} of ${Math.round(m.gpu.totalVramMb / 1024)} GB free` : ''}</p>
            <div className="jv-lanes">{Array.from({ length: Math.max(1, m.gpu.lanes) }, (_, i) => <span key={i} className={`jv-lane${i < m.gpu.busy ? ' busy' : ''}`} />)}</div>
          </div>
        </aside>

        <section className="jv-agent-detail" aria-label="Selected agent">
          {selected ? (
            <>
              <span className="jv-src">{selected.stateText}{selected.activeRuns ? ` · ${selected.activeRuns} running now` : ''}</span>
              <h2>{selected.name}</h2>
              <p className="jv-detail" style={{ WebkitLineClamp: 'unset' }}>{selected.role}</p>
              <dl className="jv-facts">
                <dt>Runs</dt><dd>{selected.runs} · {selected.completed} completed · {selected.failed} failed</dd>
                <dt>Refused</dt><dd>{selected.refusals} tool call{selected.refusals === 1 ? '' : 's'} blocked by its limits</dd>
                <dt>Internet</dt><dd>{selected.egress === 'none' ? 'Never' : selected.egress === 'approval' ? 'Only with your approval' : selected.egress}</dd>
                <dt>Always asks</dt><dd>{selected.alwaysAsk.length ? selected.alwaysAsk.join(', ').replace(/_/g, ' ') : 'nothing extra'}</dd>
                <dt>Models</dt><dd>{selected.localOnly ? 'Local only' : 'Local first; cloud only with your OK'}</dd>
                <dt>Last run</dt><dd>{selected.lastRun ? `${selected.lastRun.title} · ${selected.lastRun.status} · ${new Date(selected.lastRun.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'none yet'}</dd>
              </dl>
              <button type="button" className="btn small" onClick={onOpenTeam}>Configure in Team</button>
            </>
          ) : <p className="jv-empty">Select an agent.</p>}
        </section>

        <section className={`jv-gate${m.gate.awaitingOwner.length ? ' need' : ''}`} aria-label="Review gate">
          <button type="button" className="jv-gate-ring" onClick={() => setSel('reviewer')} aria-label="Reviewer"><span>Reviewer</span><span className="jv-src">{m.reviewer?.stateText ?? 'not in the registry'}</span></button>
          <div className="jv-gate-body">
            <h2 className="jv-tag">Review gate · last 24 h</h2>
            <p className="jv-detail mono">{m.gate.independent} verified independently · {m.gate.humanReviewed} reviewed by you · {m.gate.workerOnly} worker’s own report · {m.gate.failedChecks} failed</p>
            {m.gate.awaitingOwner.length ? m.gate.awaitingOwner.map((g) => (
              <button key={g.id} type="button" className="jv-engine-task need" onClick={() => onOpenTask(g.id)}>
                <span className="jv-src">waiting for your review</span><span className="jv-events-title">{g.title}</span><span className="jv-detail">{g.summary}</span>
              </button>
            )) : <p className="jv-empty">No change is waiting for your review.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
