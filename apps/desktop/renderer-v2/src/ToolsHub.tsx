import React, { useEffect, useMemo, useState } from 'react';
import { api, errorText } from './bridge';
import { timeOf } from './ui';

interface Tool { name: string; description: string; capabilityId: string; risk: string; executor: 'governed' | 'native'; group?: string; usage: { total: number; byStatus: Record<string, number>; last: string } | null }
interface Capability { id: string; health: { state: string; reason?: string }; tools: string[] }
interface AgentMap { id: string; name: string; enabled: boolean; availability: string; allowed: string[] }
interface Skill { id: string; name: string; description: string; kind: string; source: string; trust: string; version: string }
interface TestRun { at: string; working: number; unverified: number; unreachable: number; missing: number; notConnected: number; durationMs: number }
interface Hub { generatedAt: string; tools: Tool[]; capabilities: Capability[]; agents: AgentMap[]; skills: Skill[]; mcp: { servers: unknown[]; note: string }; testHistory: TestRun[] }
interface InvItem { id: string; label: string; status: string; detail: string; version?: string; driver?: string; category: string }
interface Connector { id: string; label?: string; state?: string; status?: string; detail?: string; reason?: string | null; [k: string]: unknown }

type Tab = 'tools' | 'agents' | 'skills' | 'mcp' | 'tests' | 'connectors';
const TABS: Array<[Tab, string]> = [['tools', 'Tools'], ['agents', 'Agents × Tools'], ['skills', 'Skills'], ['mcp', 'MCP servers'], ['tests', 'Capability tests'], ['connectors', 'Connectors']];
const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--line)', textAlign: 'left', verticalAlign: 'top', fontSize: 14 };
const head: React.CSSProperties = { ...cell, color: 'var(--muted)', fontWeight: 600, fontSize: 12.5, position: 'sticky', top: 0, background: 'var(--canvas)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 13 };
const STATUS_TONE: Record<string, string> = { working: 'var(--verified)', installed_unverified: 'var(--attention)', unreachable: 'var(--danger)', missing: 'var(--muted)', not_connected: 'var(--muted)' };

export function ToolsHub({ narrow }: { narrow: boolean }) {
  const [hub, setHub] = useState<Hub | null>(null);
  const [tab, setTab] = useState<Tab>('tools');
  const [q, setQ] = useState('');
  const [risk, setRisk] = useState('all');
  const [agent, setAgent] = useState('coding');
  const [testing, setTesting] = useState(false);
  const [items, setItems] = useState<InvItem[] | null>(null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => { try { setHub(await api.household('toolHub') as Hub); setError(null); } catch (err) { setError(errorText(err)); } };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (tab === 'connectors' && !connectors) api.household('connectors').then((r) => setConnectors(((r as { connectors?: Connector[] }).connectors) ?? [])).catch((err) => setError(errorText(err))); }, [tab]);

  const runTests = async () => {
    setTesting(true); setError(null);
    try { const r = await api.household('toolTest') as { items: InvItem[] }; setItems(r.items); await load(); } catch (err) { setError(errorText(err)); } finally { setTesting(false); }
  };

  const needle = q.trim().toLowerCase();
  const agentsFor = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of hub?.agents ?? []) for (const t of a.allowed) m.set(t, [...(m.get(t) ?? []), a.name]);
    return m;
  }, [hub]);
  const tools = (hub?.tools ?? []).filter((t) => (risk === 'all' || t.risk === risk) && (!needle || t.name.includes(needle) || t.capabilityId.includes(needle) || t.description.toLowerCase().includes(needle)));
  const sel = hub?.agents.find((a) => a.id === agent) ?? null;

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Tools & Skills</span>
        <span className="grow" />
        <button type="button" className="btn small primary" disabled={testing} onClick={() => void runTests()} title="Probe every capability on this PC now (checks only, changes nothing)">{testing ? 'Testing…' : 'Run capability test'}</button>
      </div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>What Pandesh can use, who may use it, and evidence that it works. Read from Core's registries; permissions come from the same rules Core enforces.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        <div role="tablist" aria-label="Tools & Skills" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} style={{ height: 38, padding: '0 12px', border: 0, borderBottom: `2px solid ${tab === id ? 'var(--pulse)' : 'transparent'}`, background: 'transparent', color: tab === id ? 'var(--ink)' : 'var(--muted)', fontWeight: tab === id ? 600 : 400 }}>{label}</button>
          ))}
        </div>
        {!hub && !error && <div className="notice" role="status">Reading Core's registries…</div>}

        {hub && tab === 'tools' && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <label className="sr-only" htmlFor="th-q">Search tools</label>
              <input id="th-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools or capabilities…" style={{ flex: '1 1 240px', height: 36, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--surface)' }} />
              <label className="sr-only" htmlFor="th-risk">Risk</label>
              <select id="th-risk" value={risk} onChange={(e) => setRisk(e.target.value)} style={{ height: 36, border: '1px solid var(--line)', borderRadius: 9, background: 'var(--surface)' }}>
                <option value="all">All risks</option><option value="read_only">Read only</option><option value="consequential">Changes things</option>
              </select>
            </div>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted)' }}>{tools.length} tools · {hub.capabilities.length} governed capabilities ({hub.capabilities.filter((c) => c.health.state !== 'available').length} not fully available)</p>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={head}>Tool</th><th style={head}>Risk</th>{!narrow && <th style={head}>Runs via</th>}<th style={head}>Used (30 days)</th>{!narrow && <th style={head}>Agents allowed</th>}</tr></thead>
                <tbody>{tools.map((t) => (
                  <tr key={t.name}>
                    <td style={cell}><span style={mono}>{t.name}</span>{t.description && <div style={{ color: 'var(--muted)', fontSize: 13 }}>{t.description}</div>}</td>
                    <td style={{ ...cell, color: t.risk === 'consequential' ? 'var(--attention)' : 'var(--muted)' }}>{t.risk === 'consequential' ? 'Changes things · asks' : t.risk === 'read_only' ? 'Read only' : t.risk}</td>
                    {!narrow && <td style={cell}>{t.executor === 'governed' ? `Governed · ${t.capabilityId}` : 'Chat engine'}</td>}
                    <td style={cell}>{t.usage ? `${t.usage.total} · ${Object.entries(t.usage.byStatus).map(([k, v]) => `${v} ${k}`).join(', ')}` : '—'}{t.usage && <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>last {new Date(t.usage.last).toLocaleDateString()}</div>}</td>
                    {!narrow && <td style={{ ...cell, fontSize: 13 }}>{(agentsFor.get(t.name) ?? []).join(', ') || <span style={{ color: 'var(--muted)' }}>Pandesh chat only</span>}</td>}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}

        {hub && tab === 'agents' && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {hub.agents.map((a) => <button key={a.id} type="button" className="btn small" aria-pressed={agent === a.id} onClick={() => setAgent(a.id)} style={agent === a.id ? { borderColor: 'var(--pulse)' } : undefined}>{a.name}{a.availability !== 'available' ? ' (Phase 3)' : !a.enabled ? ' (off)' : ''}</button>)}
            </div>
            {sel && (
              <div className="card">
                <span className="title">{sel.name} may use {sel.allowed.length} tool{sel.allowed.length === 1 ? '' : 's'} (plus time, arithmetic and its task record)</span>
                <span className="meta">Computed with the same scope rules Core enforces at dispatch; a delegation narrows this further.</span>
                <span style={{ ...mono, lineHeight: 1.8 }}>{sel.allowed.join(' · ') || 'None'}</span>
                <span className="meta">Change this in Team → {sel.name} (tighten only).</span>
              </div>
            )}
          </>
        )}

        {hub && tab === 'skills' && (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {hub.skills.map((s) => <div key={s.id} className="card"><span className="title">{s.name}</span><span className="meta">{s.kind} · {s.source} · {s.trust} · v{s.version}</span><span style={{ fontSize: 14 }}>{s.description}</span></div>)}
            {hub.skills.length === 0 && <div className="notice">No skills are installed.</div>}
          </div>
        )}

        {hub && tab === 'mcp' && <div className="notice" style={{ maxWidth: 'none', margin: 0 }}>{hub.mcp.note}</div>}

        {hub && tab === 'tests' && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)' }}>A capability test asks each tool on this PC to answer (a version flag, a local server, a connector grant). It changes nothing. Items that are installed but no Pandesh tool drives are marked "detected only".</p>
            {!items && <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} disabled={testing} onClick={() => void runTests()}>{testing ? 'Testing…' : 'Run capability test now'}</button>}
            {items && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={head}>Item</th><th style={head}>Result</th><th style={head}>Evidence</th></tr></thead>
                  <tbody>{items.map((i) => (
                    <tr key={i.id}><td style={cell}>{i.label}<div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{i.category}{i.driver === 'detected_only' ? ' · detected only' : i.driver ? ` · ${i.driver}` : ''}</div></td>
                      <td style={{ ...cell, color: STATUS_TONE[i.status] ?? 'var(--muted)' }}>{i.status.replace(/_/g, ' ')}</td>
                      <td style={{ ...cell, fontSize: 13, overflowWrap: 'anywhere' }}>{i.detail}{i.version ? ` · ${i.version}` : ''}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <h2 style={{ margin: 0, fontSize: 15 }}>History</h2>
            {(hub.testHistory ?? []).length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No test has been run yet.</div>}
            {(hub.testHistory ?? []).map((h) => <div key={h.at} className="meta" style={{ fontSize: 14 }}>{new Date(h.at).toLocaleString()} · {h.working} working · {h.unverified} unverified · {h.unreachable} unreachable · {h.missing} missing · {h.notConnected} not connected · {Math.round(h.durationMs / 1000)} s</div>)}
          </section>
        )}

        {tab === 'connectors' && (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {!connectors && <div className="notice" role="status">Reading connectors…</div>}
            {(connectors ?? []).map((c) => <div key={c.id} className="card"><span className="title">{String(c.label ?? c.id)}</span><span className="meta">{String(c.state ?? c.status ?? 'unknown').replace(/_/g, ' ')}</span>{(c.reason || c.detail) && <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>{String(c.reason ?? c.detail)}</span>}</div>)}
          </div>
        )}
        {hub && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--faint)' }}>Read {timeOf(hub.generatedAt)}.</p>}
      </div>
    </>
  );
}
