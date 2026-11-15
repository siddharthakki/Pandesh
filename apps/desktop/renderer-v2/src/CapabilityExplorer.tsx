import React, { useEffect, useMemo, useState } from 'react';
import { api, errorText } from './bridge';
import {
  TRUST_WORDS, abilityText, activeGrants, approvalState, connectAction, explorerSummary, groupTools, memoryRows, modelChips, needIcon, sortModels, toolUsable,
  type ActiveGrant, type ExplorerData, type ExplorerModelRow, type HubCapability, type HubTool, type Mode,
} from './explorerModel';

interface HubSlice { tools: HubTool[]; capabilities: HubCapability[] }
type ToolFilter = 'all' | 'read_only' | 'asks' | 'not_ready';

const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
const shortTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * What Pandesh can do right now, with three different facts kept apart: installed (it is on this PC), usable (it can
 * do the job now) and authorized (your rules let it act). It reads Core and the host. The only things it does are the
 * ones the rest of the app already offers: choose a model, and open Connections for Google. It grants nothing.
 */
export function CapabilityExplorer({ onOpenView }: { narrow?: boolean; onOpenView?: (view: 'connections') => void }) {
  const [data, setData] = useState<ExplorerData | null>(null);
  const [hub, setHub] = useState<HubSlice | null>(null);
  const [mode, setMode] = useState<Mode>('ask');
  const [grants, setGrants] = useState<ActiveGrant[]>([]);
  const [categoryText, setCategoryText] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<ToolFilter>('all');

  const load = async () => {
    setBusy(true);
    try {
      const snap = await api.getSnapshot();
      setMode(snap?.permission?.mode ?? 'ask');
      setGrants(activeGrants(snap?.permission?.authorizations));
      setCategoryText(snap?.permission?.categories ?? {});
      const cloud = Boolean(snap?.cloud?.selectedModel);
      const [explorer, toolHub] = await Promise.all([
        api.household('capabilityExplorer', { model: cloud ? undefined : snap?.model ?? undefined, cloud }) as Promise<ExplorerData>,
        api.household('toolHub') as Promise<HubSlice>,
      ]);
      setData(explorer); setHub(toolHub); setError(null);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);

  const useModel = async (name: string) => {
    setSwitching(name); setNotice(null);
    try { await api.selectModel(name); setNotice(`Pandesh will use ${name} for new messages.`); await load(); }
    catch (err) { setError(errorText(err)); } finally { setSwitching(null); }
  };

  const models = useMemo(() => sortModels(data?.models.models ?? []), [data]);
  const summary = data ? explorerSummary(data, hub) : null;
  const needle = q.trim().toLowerCase();
  const searching = needle !== '' || filter !== 'all';
  const shown = (hub?.tools ?? []).filter((t) => {
    if (needle && !(t.name.includes(needle) || t.capabilityId.includes(needle) || t.description.toLowerCase().includes(needle))) return false;
    if (filter === 'read_only') return t.risk === 'read_only';
    if (filter === 'asks') return t.risk !== 'read_only';
    if (filter === 'not_ready') return toolUsable(t, hub!.capabilities).state === 'not_ready';
    return true;
  });
  const groups = hub ? groupTools(shown, hub.capabilities) : [];

  return (
    <section className="ex" aria-label="What Pandesh can do now">
      <div className="ex-key" aria-label="How to read this page">
        <span><strong>Installed</strong> means it is on this PC. <strong>Usable</strong> means it can do the job right now. <strong>Authorized</strong> means your rules let it act: only the approval gates and your permission mode decide that, never a model or a skill.</span>
        <button type="button" className="btn small" disabled={busy} onClick={() => void load()}>{busy ? 'Reading…' : 'Refresh'}</button>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {!data && !error && <div className="notice" role="status">Asking Core and the model server…</div>}

      {summary && (
        <div className="ex-stats" role="group" aria-label="Summary">
          <button type="button" className="ex-stat" onClick={() => jump('ex-models')}>
            <span className="ex-stat-n">{summary.models.usable}<small> of {summary.models.installed}</small></span>
            <span className="ex-stat-l">models usable</span>
            <span className="ex-stat-s">{summary.models.selected ? `${summary.models.selected} selected` : 'none selected'}</span>
          </button>
          <button type="button" className="ex-stat" onClick={() => jump('ex-tools')} disabled={!hub}>
            <span className="ex-stat-n">{hub ? summary.tools.ready : '…'}<small>{hub ? ` of ${summary.tools.total}` : ''}</small></span>
            <span className="ex-stat-l">tools usable</span>
            <span className="ex-stat-s">{hub ? `${summary.tools.asks} ask first${summary.tools.notReady ? ` · ${summary.tools.notReady} not ready` : ''}` : 'reading…'}</span>
          </button>
          <button type="button" className="ex-stat" onClick={() => jump('ex-skills')}>
            <span className={`ex-stat-n${summary.skills.blocked ? ' warn' : ''}`}>{summary.skills.blocked}<small> of {summary.skills.total}</small></span>
            <span className="ex-stat-l">skills blocked</span>
            <span className="ex-stat-s">{summary.skills.blocked ? 'see what each needs' : 'nothing is stopping them'}</span>
          </button>
        </div>
      )}

      {data && (
        <section id="ex-models" aria-label="Models" className="ex-sec">
          <h2>Models on this PC</h2>
          <p className="ex-sub">
            {data.models.serverAnswering ? `${models.length} installed in Ollama${data.models.gpu ? ` · ${data.models.gpu.name}, ${Math.round(data.models.gpu.totalVramMb / 1024)} GB graphics memory` : ''}.` : 'The model server is not answering, so what is installed or loaded is unknown.'}
            {data.models.selectedKind === 'cloud' ? ' A free cloud model is selected; its abilities are not listed here.' : ''}
          </p>
          <div className="ex-list">
            {models.map((m) => <ModelRow key={m.name} m={m} busy={switching === m.name} locked={switching !== null} onUse={() => void useModel(m.name)} />)}
          </div>
        </section>
      )}

      {hub && summary && (
        <section id="ex-tools" aria-label="Tools" className="ex-sec">
          <h2>Tools and their authorization</h2>
          <p className="ex-sub">
            {summary.tools.total} tools: {summary.tools.total - summary.tools.asks} read only, {summary.tools.asks} change things and need approval{summary.tools.notReady ? `, ${summary.tools.notReady} whose capability is not ready` : ''}.
            {' '}This conversation is in <strong>{mode === 'plan' ? 'Plan only' : mode === 'auto' ? 'Auto' : 'Ask'}</strong> mode.
          </p>
          <div className="ex-grants" aria-label="Already authorized">
            {grants.length === 0
              ? <span><strong>Already authorized:</strong> nothing. Every tool that changes something asks first{mode === 'plan' ? ', and Plan only blocks them' : ''}.</span>
              : <span><strong>Already authorized</strong> (Auto grants running now): {grants.map((g) => `${g.categories.map((c) => categoryText[c] || c).join(', ')}${g.workspaceRoot ? ` in ${g.workspaceRoot}` : ''}, until ${shortTime(g.expiresAt)}`).join('; ')}. Everything else still asks.</span>}
          </div>
          <div className="ex-controls">
            <label className="sr-only" htmlFor="ce-q">Search tools</label>
            <input id="ce-q" className="ex-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" />
            <label className="sr-only" htmlFor="ce-f">Show</label>
            <select id="ce-f" className="ex-input" value={filter} onChange={(e) => setFilter(e.target.value as ToolFilter)}>
              <option value="all">All tools</option><option value="read_only">Read only</option><option value="asks">Needs approval</option><option value="not_ready">Not ready</option>
            </select>
          </div>
          {groups.map((g) => (
            <details key={`${g.category}-${searching ? 'o' : 'c'}`} className="ex-group" open={searching}>
              <summary>
                <span className="ex-group-name">{g.category}</span>
                <span className="ex-group-meta">{g.tools.length} tool{g.tools.length === 1 ? '' : 's'} · {g.asks} need approval{g.notReady ? ` · ${g.notReady} not ready` : ''}</span>
              </summary>
              <div className="ex-tools">
                {(() => {
                  const act = g.tools.map((t) => connectAction(t, hub.capabilities)).find((x) => x !== null) ?? null;
                  return act && onOpenView ? (
                    <div className="ex-group-act">
                      <span>{g.tools.filter((t) => connectAction(t, hub.capabilities)).length} of these tools need Google connected first. Connecting opens the Google page; every action still asks.</span>
                      <button type="button" className="btn small" onClick={() => onOpenView(act.view)}>{act.label}</button>
                    </div>
                  ) : null;
                })()}
                {g.tools.map((t) => {
                  const u = toolUsable(t, hub.capabilities); const a = approvalState(t.risk, mode, grants);
                  return (
                    <div key={t.name} className="ex-tool">
                      <span className="ex-mono ex-tool-name">{t.name}</span>
                      <span className={`ex-tool-use ${u.state === 'not_ready' ? 'warn' : ''}`}>{u.state === 'ready' ? 'Usable now' : u.state === 'chat_engine' ? 'Usable: part of the chat engine' : `Not usable: ${u.text}`}</span>
                      <span className={`ex-tone ${a.tone}`}>{a.text}</span>
                    </div>
                  );
                })}
              </div>
            </details>
          ))}
          {groups.length === 0 && <div className="empty ex-empty">No tool matches.</div>}
        </section>
      )}

      {data && (
        <section id="ex-skills" aria-label="Skills" className="ex-sec">
          <h2>Skills</h2>
          <p className="ex-sub">
            {data.skills.length} installed. A skill is guidance Pandesh follows; it never authorizes anything, so every action it leads to still passes the approval gates.
            {data.skillsFolder ? ` Your own skills are read from ${data.skillsFolder}.` : ''}
          </p>
          <div className="ex-cards">
            {data.skills.map((s) => (
              <div key={`${s.source}:${s.id}`} className="card" aria-label={`Skill ${s.name}`}>
                <span className="title">{s.name}</span>
                <span className="meta">{TRUST_WORDS[s.trust] ?? s.trust} · v{s.version}</span>
                <span className="ex-body">{s.description}</span>
                <span className={`ex-tone ${s.usable === 'ready' ? 'ok' : 'ask'}`}>
                  {s.usable === 'ready' ? 'Usable now' : s.blockedBy ? `Blocked: ${s.blockedBy}` : `Blocked: needs ${s.missing.join(', ')}`}
                </span>
                {s.needs.length > 0 && <ul className="ex-needs">{s.needs.map((n) => <li key={n.need}>{n.need}: {needIcon(n.status)}</li>)}</ul>}
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
          <span className="title">Agent Reach</span>
          <span className={`ex-tone ${data.agentReach.installed ? 'ok' : 'ask'}`}>{data.agentReach.installed ? 'Installed and usable' : 'Not installed'}</span>
          <span className="ex-body">{data.agentReach.detail}</span>
          <span className="meta">Reads: {data.agentReach.channels.map((c) => `${c.channel} (${c.actions.join(', ')})`).join(' · ')}</span>
          <span className="meta">Authorized: {data.agentReach.authorized}</span>
        </section>
      )}
    </section>
  );
}

function ModelRow({ m, busy, locked, onUse }: { m: ExplorerModelRow; busy: boolean; locked: boolean; onUse: () => void }) {
  const rows = memoryRows(m.fit);
  const blockedReason = m.embedding ? 'An embedding model is for search, not chat' : !m.usable ? 'Too large for this GPU at any context size' : null;
  return (
    <article className={`ex-model${m.selected ? ' selected' : ''}`} aria-label={`Model ${m.name}`}>
      <div className="ex-model-head">
        <div className="ex-model-id">
          <span className="ex-mono">{m.name}</span>
          <span className="ex-chips">{modelChips(m).map((c) => <span key={c.label} className={`ex-chip ${c.tone}`}>{c.label}</span>)}</span>
        </div>
        <button type="button" className="btn small" disabled={m.selected || locked || blockedReason !== null} title={blockedReason ?? (m.selected ? 'Already selected' : `Use ${m.name} for new messages`)} onClick={onUse}>
          {busy ? 'Switching…' : m.selected ? 'In use' : 'Use this model'}
        </button>
      </div>
      <div className="ex-model-line">{abilityText(m)}<span className="ex-dim"> · {m.note}</span>{m.manualOnly && !m.embedding ? <span className="ex-dim"> · chosen only by hand, never automatically</span> : null}</div>
      {m.fit && !m.embedding && <div className="ex-fit">{m.fit.summary}</div>}
      {rows.length > 0 && (
        <details className="ex-more">
          <summary>Memory and fit details</summary>
          <dl className="ex-dl">
            {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}{r.note ? <span className="ex-dim"> · {r.note}</span> : null}</dd></div>)}
          </dl>
          {m.fit && m.fit.uncertainty.length > 0 && <ul className="ex-uncertain">{m.fit.uncertainty.map((u) => <li key={u}>{u}</li>)}</ul>}
        </details>
      )}
    </article>
  );
}
