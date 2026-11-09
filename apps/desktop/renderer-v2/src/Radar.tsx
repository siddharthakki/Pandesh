import React, { useEffect, useMemo, useState } from 'react';
import { api, errorText } from './bridge';
import { timeOf } from './ui';

// Shapes returned by Core's /v1/radar routes (core/runtime/aiRadar.ts).
type RadarClass = 'already_implemented' | 'update_available' | 'worth_testing' | 'missing_capability' | 'not_relevant';
interface Finding {
  id: string; name: string; repo: string; region: string; category: string; kind: 'release' | 'security'; title: string; url: string;
  publishedAt: string | null; installed: string | null; available: string | null; classification: RadarClass; urgent: boolean;
  why: string; action: string; status: 'new' | 'seen' | 'investigating' | 'update_prepared' | 'dismissed'; firstSeenAt: string;
  decisions: Array<{ at: string; action: string; note: string | null }>;
}
interface RadarResponse { findings: Finding[]; scans: Array<{ at: string; newFindings: number; errors: string[]; urgent: number }> }

const CLASS_LABEL: Record<RadarClass, string> = {
  update_available: 'Update available', missing_capability: 'Missing capability', worth_testing: 'Worth testing',
  already_implemented: 'Already implemented', not_relevant: 'Not relevant',
};
const ORDER: RadarClass[] = ['update_available', 'missing_capability', 'worth_testing', 'already_implemented', 'not_relevant'];
const STATUS_LABEL: Record<Finding['status'], string> = { new: 'New', seen: 'Seen', investigating: 'Investigating', update_prepared: 'Update plan requested', dismissed: 'Dismissed' };

export function Radar({ onOpenChat }: { onOpenChat: () => void }) {
  const [data, setData] = useState<RadarResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = async () => { try { setData(await api.household('radar') as RadarResponse); } catch (err) { setError(errorText(err)); } };
  const scan = async () => {
    setScanning(true); setError(null); setNote(null);
    try {
      const r = await api.household('radarScan') as { newFindings: number; urgent: number; errors: string[] };
      setNote(`Scan finished: ${r.newFindings} new finding${r.newFindings === 1 ? '' : 's'}${r.urgent ? `, ${r.urgent} urgent` : ''}${r.errors.length ? `; ${r.errors.length} source(s) could not be read` : ''}.`);
      await load();
    } catch (err) { setError(errorText(err)); } finally { setScanning(false); }
  };
  // Investigate / Prepare update open a normal chat request: Core governs it (research consent, approvals) like any message.
  const decide = async (f: Finding, action: 'investigate' | 'prepare_update' | 'dismiss') => {
    setError(null);
    try {
      const r = await api.household('radarDecide', { id: f.id, action }) as { request: string | null };
      if (r.request) { await api.newConversation(); await api.submitTask(r.request); onOpenChat(); return; }
      setNote(`Dismissed ${f.title}.`);
      await load();
    } catch (err) { setError(errorText(err)); }
  };
  useEffect(() => { void load(); }, []);

  const open = useMemo(() => (data?.findings ?? []).filter((f) => showClosed || f.status !== 'dismissed'), [data, showClosed]);
  const lastScan = data?.scans?.[0];

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>AI Radar</span>
        <span className="grow" />
        <label style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show dismissed
        </label>
        <button type="button" className="btn small primary" disabled={scanning} onClick={() => void scan()} title="Read official GitHub releases and security advisories for the watchlist (public data only)">{scanning ? 'Scanning…' : 'Scan now'}</button>
      </div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>
          Official releases and security advisories of local-AI tools, compared with what is installed on this PC and with what Pandesh already does.
          Nothing is installed automatically. {lastScan ? `Last scan ${timeOf(lastScan.at)}.` : 'Not scanned yet.'}
        </p>
        {error && <div className="notice error" role="alert">{error}</div>}
        {note && <div className="notice" role="status">{note}</div>}
        {lastScan && lastScan.errors.length > 0 && (
          <details className="notice"><summary>{lastScan.errors.length} source(s) could not be read in the last scan</summary>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>{lastScan.errors.map((e) => <li key={e}>{e}</li>)}</ul></details>
        )}
        {data && open.length === 0 && <div className="empty">No findings yet. Run a scan.</div>}
        {ORDER.map((cls) => {
          const group = open.filter((f) => f.classification === cls);
          if (!group.length) return null;
          return (
            <section key={cls} aria-label={CLASS_LABEL[cls]} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h2 style={{ fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: '8px 0 0' }}>{CLASS_LABEL[cls]} · {group.length}</h2>
              {group.map((f) => (
                <article key={f.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: f.status === 'dismissed' ? 0.6 : 1 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    {f.urgent && <span style={{ color: 'var(--danger, #b3261e)', fontWeight: 700 }}>Security</span>}
                    <a href={f.url} onClick={(e) => { e.preventDefault(); void api.openExternalUrl(f.url); }} style={{ fontWeight: 600, color: 'var(--ink)' }}>{f.title}</a>
                    <span className="meta">{f.publishedAt ? f.publishedAt.slice(0, 10) : 'date unknown'} · {f.region} · {f.repo}</span>
                    <span className="grow" />
                    <span className="meta">{STATUS_LABEL[f.status]}</span>
                  </div>
                  <div className="meta">Installed: {f.installed ?? 'not installed'}{f.available ? ` · Available: ${f.available}` : ''}</div>
                  <div style={{ fontSize: 14 }}>{f.why}</div>
                  <div style={{ fontSize: 14 }}><b>Smallest useful action:</b> {f.action}</div>
                  {f.decisions.length > 0 && <div className="meta">History: {f.decisions.map((d) => `${d.action.replace('_', ' ')} ${timeOf(d.at)}`).join(' · ')}</div>}
                  {f.status !== 'dismissed' && (
                    <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" className="btn small" onClick={() => void decide(f, 'investigate')} title="Opens a chat that asks the Research specialist (internet consent applies)">Investigate</button>
                      {f.classification === 'update_available' && <button type="button" className="btn small" onClick={() => void decide(f, 'prepare_update')} title="Opens a chat that prepares an update plan; nothing is installed">Prepare update</button>}
                      <button type="button" className="btn small" onClick={() => void decide(f, 'dismiss')}>Dismiss</button>
                    </div>
                  )}
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
