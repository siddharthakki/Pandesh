import React, { useEffect, useState } from 'react';
import { api, errorText } from './bridge';
import { timeOf } from './ui';

interface Proc { pid: number; source: string; recordedAt: string | null; executablePath: string | null; port: number | null; serviceName: string | null; state: 'running' | 'ended' | 'pid_reused' | 'unknown'; reason: string; live: { executablePath: string | null; startedAt: string | null; commandLine: string | null } | null }
const LABEL: Record<Proc['state'], string> = { running: 'Running', ended: 'Ended', pid_reused: 'Id reused by another program', unknown: 'Running, identity unconfirmed' };

export function Processes({ narrow }: { narrow: boolean }) {
  const [data, setData] = useState<{ checkedAt: string; processes: Proc[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const load = async () => { try { setData(await api.household('processes') as { checkedAt: string; processes: Proc[] }); setError(null); } catch (err) { setError(errorText(err)); } };
  useEffect(() => { void load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);
  const shown = (data?.processes ?? []).filter((p) => showEnded || p.state !== 'ended');
  const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--line)', textAlign: 'left', verticalAlign: 'top', fontSize: 14 };
  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Processes Pandesh started</span>
        <span className="grow" />
        <button type="button" className="btn small" onClick={() => void load()}>Check again</button>
      </div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>Only processes Pandesh recorded launching, each checked against Windows right now. Pandesh never moves, stops or controls programs it did not start; running work is stopped from its task.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        <label style={{ fontSize: 14 }}><input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show ended processes</label>
        {data && shown.length === 0 && <div className="notice">No process Pandesh started is running right now.</div>}
        {data && shown.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>{['Process', 'State', ...(narrow ? [] : ['Started by', 'Port'])].map((h) => <th key={h} style={{ ...cell, color: 'var(--muted)', fontSize: 12.5 }}>{h}</th>)}</tr></thead>
              <tbody>{shown.map((p) => (
                <tr key={p.pid}>
                  <td style={cell}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, overflowWrap: 'anywhere' }}>{(p.live?.executablePath ?? p.executablePath ?? 'unknown').split('\\').pop()}</span> <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>pid {p.pid}</span>{p.live?.commandLine && <div style={{ color: 'var(--muted)', fontSize: 12.5, overflowWrap: 'anywhere' }}>{p.live.commandLine}</div>}</td>
                  <td style={{ ...cell, color: p.state === 'running' ? 'var(--verified)' : p.state === 'pid_reused' ? 'var(--attention)' : 'var(--muted)' }}>{LABEL[p.state]}<div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{p.reason}</div></td>
                  {!narrow && <td style={cell}>{p.serviceName ? `Service ${p.serviceName}` : p.source}<div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{p.recordedAt ? new Date(p.recordedAt).toLocaleString() : ''}</div></td>}
                  {!narrow && <td style={{ ...cell, fontFamily: 'var(--font-mono)' }}>{p.port ?? '—'}</td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {data && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--faint)' }}>Checked {timeOf(data.checkedAt)}.</p>}
      </div>
    </>
  );
}
