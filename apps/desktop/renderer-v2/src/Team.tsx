import React, { useEffect, useState } from 'react';
import { api, errorText, onDesktopEvent } from './bridge';
import { timeOf } from './ui';

// Shapes from Core /v1/agents (core/domain/agents.ts).
interface Agent {
  id: string; kind: string; name: string; role: string; version: number; instructions: string; tools: string[]; toolDenylist: string[];
  memoryScopes: Array<{ scope: string; access: string }>; workspaceRoots: string[]; egress: string | { domains: string[] }; alwaysAsk: string[];
  modelPolicy: { localOnly: boolean; models: string[] }; limits: { maxSteps: number; maxToolCalls: number; maxWallSeconds: number; maxDelegationDepth: number };
  enabled: boolean; availability: 'available' | 'phase3';
}
interface Status { agent: Agent; state: 'idle' | 'working' | 'needs_you' | 'off' | 'phase3'; activeRuns: number; runs: number; completed: number; failed: number; refusals: number; lastRun: { attemptId: string; title: string; status: string; at: string } | null }
interface Detail { agent: Agent; history: Array<{ attemptId: string; title: string; status: string; createdAt: string; conversationId: string | null; handoffId: string | null; agentVersion: number }>; refusals: Array<{ attemptId: string; toolName: string; reason: string; createdAt: string }> }

const STATE: Record<Status['state'], string> = { needs_you: 'Needs you', working: 'Working', idle: 'Idle', off: 'Turned off', phase3: 'Arrives in Phase 3' };
const ORDER: Status['state'][] = ['needs_you', 'working', 'idle', 'off', 'phase3'];
type Tab = 'overview' | 'activity' | 'capabilities' | 'memory' | 'model' | 'refusals';

export function Team({ narrow, onMessage, latestAttemptId }: { narrow: boolean; onMessage: (agentId: string) => void; latestAttemptId: string | null }) {
  const [list, setList] = useState<Status[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [brief, setBrief] = useState('');

  const load = async () => { try { const r = await api.household('agents') as { agents: Status[] }; setList(r.agents); setError(null); } catch (err) { setError(errorText(err)); } };
  const loadDetail = async (id: string) => { try { setDetail(await api.household('agent', { id }) as Detail); } catch (err) { setError(errorText(err)); } };
  useEffect(() => { void load(); const off = onDesktopEvent((e) => { if (e.kind !== 'token') { void load(); if (sel) void loadDetail(sel); } }); return off; }, [sel]);
  useEffect(() => { if (sel) void loadDetail(sel); }, [sel]);

  const toggle = async (a: Agent) => {
    try { await api.household('agentUpdate', { id: a.id, enabled: !a.enabled }); setNote(`${a.name} ${a.enabled ? 'turned off' : 'turned on'}.`); await load(); await loadDetail(a.id); } catch (err) { setNote(errorText(err)); }
  };
  const delegate = async (a: Agent) => {
    if (!latestAttemptId) { setNote('Start a task in chat first; a delegation hangs off the task it serves.'); return; }
    try {
      const r = await api.household('agentDelegate', { parentAttemptId: latestAttemptId, toAgentId: a.id, brief }) as { handoff: { id: string; status: string }; duplicate?: boolean };
      setNote(r.duplicate ? 'That delegation already exists; nothing new was started.' : `Delegated to ${a.name}. It runs with at most the scope of the task it serves.`);
      setBrief('');
      await load(); await loadDetail(a.id);
    } catch (err) { setNote(`Not delegated: ${errorText(err)}`); }
  };

  const sorted = [...(list ?? [])].sort((x, y) => ORDER.indexOf(x.state) - ORDER.indexOf(y.state));
  const current = sorted.find((s) => s.agent.id === sel) ?? null;
  const a = detail?.agent ?? current?.agent ?? null;

  return (
    <>
      <div className="topbar">
        {narrow && sel ? <button type="button" className="btn small" onClick={() => setSel(null)}>All agents</button> : <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Team</span>}
        <span className="grow" />
      </div>
      <div className="board" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {(!narrow || !sel) && (
          <section aria-label="Agents" style={{ flex: narrow ? '1 1 auto' : '0 0 340px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>Agents run on demand in Pandesh's own executor, each limited to its own tools, folders and memory. Delegation can only narrow what a task may do.</p>
            {error && <div className="notice error" role="alert">{error}</div>}
            {!list && !error && <div className="notice" role="status">Reading agents from Core…</div>}
            {sorted.map((s) => (
              <button key={s.agent.id} type="button" onClick={() => { setSel(s.agent.id); setTab('overview'); setNote(''); }} aria-current={sel === s.agent.id ? 'true' : undefined}
                className="card" style={{ textAlign: 'left', cursor: 'pointer', borderColor: s.state === 'needs_you' ? 'var(--attention)' : sel === s.agent.id ? 'var(--pulse)' : undefined, opacity: s.state === 'phase3' ? 0.7 : 1 }}>
                <span className="title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`dot ${s.state === 'needs_you' ? 'attention' : s.state === 'working' ? '' : 'muted'}`} aria-hidden="true" />{s.agent.name}
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>{STATE[s.state]}{s.activeRuns ? ` · ${s.activeRuns}` : ''}</span>
                </span>
                <span className="meta">{s.agent.role}</span>
                {s.lastRun && <span className="evidence">Last: {s.lastRun.title.slice(0, 60)} · {s.lastRun.status} {timeOf(s.lastRun.at)}</span>}
              </button>
            ))}
          </section>
        )}
        {a && (!narrow || sel) && (
          <section aria-label={`${a.name} details`} style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: 22 }}>{a.name}</h1>
              <span style={{ color: 'var(--muted)', fontSize: 14 }}>v{a.version} · {a.kind === 'template' ? 'template' : a.kind}</span>
              <span className="grow" style={{ flex: 1 }} />
              {a.availability === 'available' && a.id !== 'voice' && <button type="button" className="btn primary small" disabled={!a.enabled} onClick={() => onMessage(a.id)}>Message {a.name}</button>}
              {a.availability === 'available' && a.id !== 'chief' && <button type="button" className="btn small" onClick={() => void toggle(a)}>{a.enabled ? 'Turn off' : 'Turn on'}</button>}
            </div>
            {note && <p role="status" style={{ margin: 0, fontSize: 14 }}>{note}</p>}
            <div role="tablist" aria-label={`${a.name} sections`} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
              {(['overview', 'activity', 'capabilities', 'memory', 'model', 'refusals'] as Tab[]).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} style={{ height: 36, padding: '0 10px', border: 0, borderBottom: `2px solid ${tab === t ? 'var(--pulse)' : 'transparent'}`, background: 'transparent', color: tab === t ? 'var(--ink)' : 'var(--muted)' }}>
                  {{ overview: 'Overview', activity: 'Activity', capabilities: 'Capabilities', memory: 'Memory', model: 'Model & limits', refusals: `Refusals${current?.refusals ? ` · ${current.refusals}` : ''}` }[t]}
                </button>
              ))}
            </div>
            {tab === 'overview' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ margin: 0 }}>{a.role}</p>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>{a.instructions}</p>
                {current && <p style={{ margin: 0, fontSize: 14 }}>{current.runs} run{current.runs === 1 ? '' : 's'} · {current.completed} completed · {current.failed} failed{current.refusals ? ` · ${current.refusals} scope refusal${current.refusals === 1 ? '' : 's'}` : ''}</p>}
                {a.availability === 'phase3' && <div className="notice">This specialist is a template. Its tools and business/brand scopes arrive in Phase 3; it cannot run before then.</div>}
                {a.availability === 'available' && a.enabled && a.id !== 'chief' && a.id !== 'voice' && (
                  <div className="card">
                    <span className="title">Delegate from your latest task</span>
                    <span className="meta">Write the objective yourself. {a.name} will get at most what that task may do, and never more.</span>
                    <label className="sr-only" htmlFor="v2-brief">Brief for {a.name}</label>
                    <textarea id="v2-brief" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={`What should ${a.name} do, and what counts as done?`} style={{ width: '100%', padding: 10, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--canvas)', resize: 'vertical' }} />
                    <div className="actions"><button type="button" className="btn small" disabled={brief.trim().length < 8} onClick={() => void delegate(a)}>Delegate to {a.name}</button></div>
                  </div>
                )}
              </div>
            )}
            {tab === 'activity' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(detail?.history ?? []).length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No runs yet.</div>}
                {(detail?.history ?? []).map((h) => (
                  <div key={h.attemptId} className="card"><span className="title">{h.title}</span><span className="meta">{h.status} · {new Date(h.createdAt).toLocaleString()} · definition v{h.agentVersion}{h.handoffId ? ' · delegated' : ''}</span></div>
                ))}
              </div>
            )}
            {tab === 'capabilities' && (
              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: narrow ? '1fr' : '160px 1fr', gap: '8px 16px', fontSize: 14 }}>
                <dt style={{ color: 'var(--muted)' }}>Tools</dt><dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{a.tools.length ? a.tools.join(', ') : 'None (speaks for other agents only)'}</dd>
                <dt style={{ color: 'var(--muted)' }}>Never</dt><dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{a.toolDenylist.join(', ') || '—'}</dd>
                <dt style={{ color: 'var(--muted)' }}>Folders</dt><dd style={{ margin: 0 }}>{a.workspaceRoots.length ? a.workspaceRoots.map((r) => (r === 'conversation' ? 'The chat\'s selected folder' : r)).join(', ') : 'No file access'}</dd>
                <dt style={{ color: 'var(--muted)' }}>Network</dt><dd style={{ margin: 0 }}>{typeof a.egress === 'object' ? `Only ${a.egress.domains.join(', ')}` : a.egress === 'none' ? 'No outbound requests' : 'Only with approval (existing rules)'}</dd>
                <dt style={{ color: 'var(--muted)' }}>Always asks</dt><dd style={{ margin: 0 }}>{a.alwaysAsk.length ? a.alwaysAsk.join(', ') : 'Global rules only'}</dd>
              </dl>
            )}
            {tab === 'memory' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
                {a.memoryScopes.length === 0 && <span>No memory of its own.</span>}
                {a.memoryScopes.map((m) => <span key={m.scope}><strong>{m.scope}</strong> · {m.access === 'read_write' ? 'read and write' : 'read only'}</span>)}
                <span style={{ color: 'var(--muted)' }}>Memory tools are limited to this agent's allowlist now; per-scope recall filtering arrives with the Second Brain (2d).</span>
              </div>
            )}
            {tab === 'model' && (
              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: narrow ? '1fr' : '160px 1fr', gap: '8px 16px', fontSize: 14 }}>
                <dt style={{ color: 'var(--muted)' }}>Models</dt><dd style={{ margin: 0 }}>{a.modelPolicy.localOnly ? 'Local models only' : 'Local or an enabled cloud provider'}{a.modelPolicy.models.length ? ` · ${a.modelPolicy.models.join(', ')}` : ' · the model selected in Pandesh'}</dd>
                <dt style={{ color: 'var(--muted)' }}>Limits</dt><dd style={{ margin: 0 }}>{a.limits.maxSteps} steps · {a.limits.maxToolCalls} tool calls · {Math.round(a.limits.maxWallSeconds / 60)} min · delegation depth {a.limits.maxDelegationDepth}</dd>
                <dt style={{ color: 'var(--muted)' }}>Runs</dt><dd style={{ margin: 0 }}>On demand in the shared executor; no model is kept loaded for an idle agent.</dd>
              </dl>
            )}
            {tab === 'refusals' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(detail?.refusals ?? []).length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>Core has not refused anything for this agent.</div>}
                {(detail?.refusals ?? []).map((r, i) => <div key={i} className="card"><span className="title" style={{ fontFamily: 'var(--font-mono)' }}>{r.toolName}</span><span className="failure">{r.reason}</span><span className="meta">{new Date(r.createdAt).toLocaleString()}</span></div>)}
              </div>
            )}
          </section>
        )}
        {!a && !narrow && list && <div className="notice">Choose an agent to see what it may do.</div>}
      </div>
    </>
  );
}
