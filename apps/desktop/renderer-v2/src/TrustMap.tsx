import React, { useEffect, useMemo, useState } from 'react';
import { api, onDesktopEvent, type Snapshot } from './bridge';
import { buildTrust, type TrustArea, type TrustInputs, type TrustLevel } from './trustModel';
import type { AgentStatus } from './agentsModel';

const LEVEL_TEXT: Record<TrustLevel, string> = { free: 'Acts without asking', asks: 'Asks you first', never: 'Cannot' };
const RING: Record<TrustLevel, number> = { free: 0.3, asks: 0.58, never: 0.86 };
type Extra = Omit<TrustInputs, 'permission' | 'workspace' | 'provider' | 'now'>;
type Loose = Record<string, unknown>;

async function settle<T>(p: Promise<unknown> | undefined, pick: (r: Loose) => T): Promise<T | null> {
  try { return p ? pick((await p) as Loose) : null; } catch { return null; }
}

/**
 * Trust Map: you at the centre; every area that can act for you sits on the ring its real permission puts it on —
 * inside "acts without asking", the middle "asks you first", outside "cannot". Read only: each area names the screen
 * where it is changed, and nothing here grants, widens or revokes anything. Static: it moves only when a record changes.
 */
export function TrustMap({ snapshot, onOpen }: { snapshot: Snapshot | null; onOpen: (view: string) => void }) {
  const [extra, setExtra] = useState<Extra>({ projects: null, pairings: null, phone: null, agents: null, connectors: null, routines: null });
  const [sel, setSel] = useState<string>('chat');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const load = async () => {
    const loose = api as unknown as Record<string, (() => Promise<unknown>) | undefined>;
    const [projects, pairings, phone, agents, connectors, routines] = await Promise.all([
      settle(api.household('bridgeProjects'), (r) => r.projects as Extra['projects']),
      settle(api.household('bridgePairings'), (r) => r.pairings as Extra['pairings']),
      settle(loose.getMobilePairing?.(), (r) => r as unknown as Extra['phone']),
      settle(api.household('agents'), (r) => r.agents as AgentStatus[]),
      settle(api.household('connectors'), (r) => r.connectors as Extra['connectors']),
      settle(loose.listRoutineWriteGrants?.(), (r) => r.routines as Extra['routines']),
    ]);
    setExtra({ projects, pairings, phone, agents, connectors, routines });
    setLoadedAt(Date.now());
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    const off = onDesktopEvent((e) => { if (e.kind === 'result') void load(); });
    return () => { clearInterval(t); off(); };
  }, []);

  const snap = snapshot as unknown as { permission?: TrustInputs['permission']; workspace?: TrustInputs['workspace']; selectedInferenceProvider?: TrustInputs['provider'] } | null;
  const areas = useMemo(() => buildTrust({
    ...extra, permission: snap?.permission ?? null, workspace: snap?.workspace ?? null, provider: snap?.selectedInferenceProvider ?? null, now: Date.now(),
  }), [extra, snap?.permission, snap?.workspace, snap?.selectedInferenceProvider]);
  const selected = areas.find((a) => a.id === sel) ?? areas[0];
  const count = (l: TrustLevel) => areas.filter((a) => a.known && a.level === l).length;

  // Even angles around the centre, starting at the top; radius from the area's real level.
  const place = (i: number, a: TrustArea) => {
    const th = (-70 + (i * 360) / areas.length) * (Math.PI / 180);
    const r = a.known ? RING[a.level] : RING.never;
    return { x: 50 + 46 * r * Math.cos(th), y: 50 + 46 * r * Math.sin(th) };
  };

  return (
    <div className="jv-trust">
      <header className="jv-missions-head">
        <h1>Trust Map</h1>
        <span className="jv-hint">{count('free')} act without asking · {count('asks')} ask you · {count('never')} cannot{areas.some((a) => !a.known) ? ` · ${areas.filter((a) => !a.known).length} not answering` : ''}{loadedAt ? ` · read ${new Date(loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
        <button type="button" className="btn small" onClick={() => void load()}>Read again</button>
      </header>

      <div className="jv-trust-grid">
        <section className="jv-trust-map" aria-label="Trust map">
          <svg viewBox="0 0 100 100" className="jv-trust-rings" aria-hidden="true">
            {(['never', 'asks', 'free'] as TrustLevel[]).map((l) => <circle key={l} cx="50" cy="50" r={46 * RING[l] + (l === 'never' ? 6 : 6.5)} className={`jv-ring ${l}`} />)}
            {areas.map((a, i) => { const p = place(i, a); return <line key={a.id} x1="50" y1="50" x2={p.x} y2={p.y} className={`jv-tie ${a.level}${a.known ? '' : ' unknown'}${sel === a.id ? ' on' : ''}`} />; })}
          </svg>
          <span className="jv-ring-label free">acts without asking</span>
          <span className="jv-ring-label asks">asks you first</span>
          <span className="jv-ring-label never">cannot</span>
          <div className="jv-you" aria-hidden="true"><span>You</span></div>
          {areas.map((a, i) => {
            const p = place(i, a);
            return (
              <button key={a.id} type="button" className={`jv-trust-node ${a.level}${a.known ? '' : ' unknown'}${sel === a.id ? ' on' : ''}`} style={{ left: `${p.x}%`, top: `${p.y}%` }}
                onClick={() => setSel(a.id)} aria-label={`${a.name}: ${a.known ? LEVEL_TEXT[a.level] : 'not answering'}. ${a.summary}`}>
                <strong>{a.name}</strong><span className="jv-src">{a.known ? LEVEL_TEXT[a.level] : 'not answering'}</span>
              </button>
            );
          })}
        </section>

        <aside className="jv-trust-side">
        <section className="jv-trust-detail" aria-label={`${selected.name} details`} aria-live="polite">
          <span className={`jv-src ${selected.level}`}>{selected.known ? LEVEL_TEXT[selected.level] : 'Not answering'}</span>
          <h2>{selected.name}</h2>
          <p className="jv-detail">{selected.summary}</p>
          <ul className="jv-trust-facts">
            {selected.facts.map((f) => <li key={f.text} className={f.level}><span className="jv-lvl">{LEVEL_TEXT[f.level]}</span>{f.text}</li>)}
          </ul>
          {selected.where
            ? <button type="button" className="btn small" onClick={() => onOpen(selected.where!.view)}>{selected.where.label}</button>
            : <p className="jv-empty">Only you change this registry, outside the app. This map shows it as Core reads it.</p>}
          <p className="jv-empty">This map only reads. Granting, tightening and revoking happen on the screen named above, under the same rules Core enforces.</p>
        </section>

        <section className="jv-trust-ledger" aria-label="Everything by level">
        {(['free', 'asks', 'never'] as TrustLevel[]).map((l) => (
          <div key={l} className={`jv-ledger-col ${l}`}>
            <h2 className="jv-tag">{LEVEL_TEXT[l]}</h2>
            {areas.flatMap((a) => a.facts.filter((f) => f.level === l).map((f) => (
              <button key={`${a.id}:${f.text}`} type="button" className="jv-ledger-row" onClick={() => setSel(a.id)}><span className="jv-src">{a.name}</span>{f.text}</button>
            )))}
          </div>
        ))}
      </section>
        </aside>
      </div>
    </div>
  );
}
