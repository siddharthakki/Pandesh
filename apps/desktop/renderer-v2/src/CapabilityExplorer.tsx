import React, { useEffect, useMemo, useState } from 'react';
import { api, errorText } from './bridge';
import {
  TRUST_WORDS, abilityText, authorizationText, modelChips, needIcon, sortModels, toolCounts, toolUsable,
  type ExplorerData, type HubCapability, type HubTool, type Mode,
} from './explorerModel';

const TONE = { ok: 'var(--verified)', muted: 'var(--muted)', warn: 'var(--attention)', ask: 'var(--attention)', blocked: 'var(--danger)' } as const;
const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--line)', textAlign: 'left', verticalAlign: 'top', fontSize: 14 };
const head: React.CSSProperties = { ...cell, color: 'var(--muted)', fontWeight: 600, fontSize: 12.5 };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 13 };

interface HubSlice { tools: HubTool[]; capabilities: HubCapability[] }

/**
 * What Pandesh can do right now, with three different facts kept apart: installed (it is on this PC), usable (it can
 * do the job now) and authorized (your rules let it act). Read-only: it asks Core and the host, and changes nothing.
 */
export function CapabilityExplorer({ narrow }: { narrow: boolean }) {
  const [data, setData] = useState<ExplorerData | null>(null);
  const [hub, setHub] = useState<HubSlice | null>(null);
  const [mode, setMode] = useState<Mode>('ask');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'read_only' | 'asks' | 'not_ready'>('all');

  const load = async () => {
    setBusy(true);
    try {
      const snap = await api.getSnapshot();
      setMode(snap?.permission?.mode ?? 'ask');
      const cloud = Boolean(snap?.cloud?.selectedModel);
      const [explorer, toolHub] = await Promise.all([
        api.household('capabilityExplorer', { model: cloud ? undefined : snap?.model ?? undefined, cloud }) as Promise<ExplorerData>,
        api.household('toolHub') as Promise<HubSlice>,
      ]);
      setData(explorer); setHub(toolHub); setError(null);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);

  const models = useMemo(() => sortModels(data?.models.models ?? []), [data]);
  const counts = hub ? toolCounts(hub.tools, hub.capabilities) : null;
  const needle = q.trim().toLowerCase();
  const tools = (hub?.tools ?? []).filter((t) => {
    if (needle && !(t.name.includes(needle) || t.capabilityId.includes(needle) || t.description.toLowerCase().includes(needle))) return false;
    if (filter === 'read_only') return t.risk === 'read_only';
    if (filter === 'asks') return t.risk !== 'read_only';
    if (filter === 'not_ready') return toolUsable(t, hub!.capabilities).state === 'not_ready';
    return true;
  });

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-label="What Pandesh can do now">
      <div className="card" aria-label="How to read this page">
        <span className="meta"><strong>Installed</strong> means it is on this PC. <strong>Usable</strong> means it can do the job right now. <strong>Authorized</strong> means your rules let it act: only the approval gates and your permission mode decide that, never a model or a skill.</span>
        <div className="actions"><button type="button" className="btn small" disabled={busy} onClick={() => void load()}>{busy ? 'Reading…' : 'Refresh'}</button></div>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!data && !error && <div className="notice" role="status">Asking Core and the model server…</div>}

      {data && (
        <section aria-label="Models" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Models on this PC</h2>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)' }}>
            {data.models.serverAnswering ? `${models.length} installed in Ollama${data.models.gpu ? ` · ${data.models.gpu.name}, ${Math.round(data.models.gpu.totalVramMb / 1024)} GB graphics memory` : ''}.` : 'The model server is not answering, so what is installed or loaded is unknown.'}
            {data.models.selectedKind === 'cloud' ? ' A free cloud model is selected; its abilities are not listed here.' : ''}
          </p>
          {models.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={head}>Model</th><th style={head}>State</th><th style={head}>Can do</th>{!narrow && <th style={head}>Usable?</th>}</tr></thead>
                <tbody>{models.map((m) => (
                  <tr key={m.name}>
                    <td style={cell}><span style={mono}>{m.name}</span>{m.manualOnly && !m.embedding && <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>Chosen only by hand, never automatically</div>}</td>
                    <td style={cell}>{modelChips(m).map((c) => <div key={c.label} style={{ color: TONE[c.tone], fontSize: 13.5 }}>{c.label}</div>)}</td>
                    <td style={cell}>{abilityText(m)}</td>
                    {!narrow && <td style={{ ...cell, fontSize: 13, color: 'var(--muted)' }}>{m.note}</td>}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {hub && counts && (
        <section aria-label="Tools" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Tools and their authorization</h2>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)' }}>
            {counts.total} tools: {counts.readOnly} read only, {counts.asks} change things and ask first{counts.notReady ? `, ${counts.notReady} whose capability is not ready` : ''}.
            {' '}This conversation is in <strong>{mode === 'plan' ? 'Plan only' : mode === 'auto' ? 'Auto' : 'Ask'}</strong> mode.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label className="sr-only" htmlFor="ce-q">Search tools</label>
            <input id="ce-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" style={{ flex: '1 1 220px', height: 34, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--surface)' }} />
            <label className="sr-only" htmlFor="ce-f">Show</label>
            <select id="ce-f" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ height: 34, border: '1px solid var(--line)', borderRadius: 9, background: 'var(--surface)' }}>
              <option value="all">All tools</option><option value="read_only">Read only</option><option value="asks">Ask first</option><option value="not_ready">Not ready</option>
            </select>
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 420 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={head}>Tool</th><th style={head}>Usable now?</th><th style={head}>Authorized?</th></tr></thead>
              <tbody>{tools.map((t) => {
                const u = toolUsable(t, hub.capabilities); const a = authorizationText(t.risk, mode);
                return (
                  <tr key={t.name}>
                    <td style={cell}><span style={mono}>{t.name}</span></td>
                    <td style={{ ...cell, color: u.state === 'not_ready' ? 'var(--attention)' : 'var(--muted)' }}>{u.text}</td>
                    <td style={{ ...cell, color: TONE[a.tone], fontSize: 13.5 }}>{a.text}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            {tools.length === 0 && <div className="empty" style={{ padding: 10, color: 'var(--faint)' }}>No tool matches.</div>}
          </div>
        </section>
      )}

      {data && (
        <section aria-label="Skills" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Skills</h2>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)' }}>
            {data.skills.length} installed. A skill is guidance Pandesh follows; it never authorizes anything, so every action it leads to still passes the approval gates.
            {data.skillsFolder ? ` Your own skills are read from ${data.skillsFolder}.` : ''}
          </p>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {data.skills.map((s) => (
              <div key={`${s.source}:${s.id}`} className="card" aria-label={`Skill ${s.name}`}>
                <span className="title">{s.name}</span>
                <span className="meta">{TRUST_WORDS[s.trust] ?? s.trust} · v{s.version}</span>
                <span style={{ fontSize: 14 }}>{s.description}</span>
                <span style={{ fontSize: 13.5, color: s.usable === 'ready' ? 'var(--verified)' : 'var(--attention)' }}>
                  {s.usable === 'ready' ? 'Usable now' : s.blockedBy ? `Blocked: ${s.blockedBy}` : `Blocked: needs ${s.missing.join(', ')}`}
                </span>
                {s.needs.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--muted)' }}>{s.needs.map((n) => <li key={n.need}>{n.need}: {needIcon(n.status)}</li>)}</ul>}
              </div>
            ))}
          </div>
          {data.rejectedSkills.length > 0 && (
            <div className="notice" role="status">{data.rejectedSkills.length} skill file{data.rejectedSkills.length === 1 ? ' was' : 's were'} not loaded: {data.rejectedSkills.map((r) => `${r.origin} (${r.reason})`).join('; ')}</div>
          )}
        </section>
      )}

      {data && (
        <section aria-label="Agent Reach" className="card">
          <span className="title" style={{ fontSize: 16 }}>Agent Reach</span>
          <span style={{ fontSize: 14, color: data.agentReach.installed ? 'var(--verified)' : 'var(--attention)' }}>{data.agentReach.installed ? 'Installed and usable' : 'Not installed'}</span>
          <span style={{ fontSize: 14 }}>{data.agentReach.detail}</span>
          <span className="meta">Reads: {data.agentReach.channels.map((c) => `${c.channel} (${c.actions.join(', ')})`).join(' · ')}</span>
          <span className="meta">Authorized: {data.agentReach.authorized}</span>
        </section>
      )}
    </section>
  );
}
