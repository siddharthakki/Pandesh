import React, { useEffect, useMemo, useState } from 'react';
import { api, errorText } from './bridge';
import { Icon, timeOf } from './ui';

// Shapes returned by Core's /v1/software routes (core/runtime/software/*).
interface Upstream { url: string; github: string | null; verified: boolean; basis: string }
interface Item { id: string; kind: string; name: string; version: string | null; installMethod: string; installPath: string | null; packageId: string | null; upstream: Upstream | null; source: string; details: Record<string, string | number | boolean | null>; dependents: { ports: Array<{ port: number; pid: number; process: string | null }>; services: string[] } }
interface Port { port: number; address: string; pid: number; processName: string | null; executablePath: string | null; pandeshService: string | null; windowsService: string | null }
interface Service { name: string; displayName: string; state: string; startMode: string; pid: number | null }
interface Section { id: string; label: string; available: boolean; reason: string | null; count: number; durationMs: number }
interface Inventory { generatedAt: string; sections: Section[]; items: Item[]; ports: Port[]; services: Service[]; scanRoots: string[] }
interface Advisory { id: string; severity: string | null; summary: string; url: string }
interface Update { itemId: string; name: string; source: string; installed: string | null; latestStable: string | null; latestPrerelease: string | null; status: string; summary: string; notesUrl: string | null; publishedAt: string | null; behindBy: number | null; fork: { isFork: boolean; parent: string | null } | null; advisories: Advisory[]; checkedAt: string; stale: boolean; error: string | null }
interface CheckRecord { at: string; trigger: string; checked: number; updates: number; rateLimitedUntil: string | null; errors: string[] }
interface UpdateState { results: Update[]; history: CheckRecord[]; settings: { periodicEnabled: boolean; intervalHours: number }; lastCheckedAt: string | null; github: { rateLimitedUntil: string | null; remaining: number | null }; checking?: boolean }

type Tab = 'ports' | 'tools' | 'github' | 'updates' | 'history';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'ports', label: 'Services & Ports' },
  { id: 'tools', label: 'Installed Tools' },
  { id: 'github', label: 'GitHub Projects' },
  { id: 'updates', label: 'Available Updates' },
  { id: 'history', label: 'Update History' },
];
const METHOD: Record<string, string> = { git: 'Git clone', winget: 'winget', scoop: 'Scoop', choco: 'Chocolatey', pip: 'pip', uv: 'uv', npm: 'npm', docker: 'Docker', installer: 'Installer', ollama: 'Ollama', unknown: 'Unknown' };
const STATUS: Record<string, string> = { up_to_date: 'Up to date', update_available: 'Update available', prerelease_available: 'Prerelease only', behind_development: 'Behind development branch', ahead_or_local: 'Newer than stable / local', unknown: 'Unknown', rate_limited: 'Not checked (rate limit)', error: 'Check failed' };
const MAX_ROWS = 400;

const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--line)', textAlign: 'left', verticalAlign: 'top', fontSize: 14 };
const head: React.CSSProperties = { ...cell, color: 'var(--muted)', fontWeight: 600, fontSize: 12.5, letterSpacing: '0.03em', position: 'sticky', top: 0, background: 'var(--canvas)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 13 };

export function Software({ narrow }: { narrow: boolean }) {
  const [tab, setTab] = useState<Tab>('ports');
  const [inv, setInv] = useState<Inventory | null>(null);
  const [upd, setUpd] = useState<UpdateState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('all');

  const scan = async (refresh: boolean) => {
    setScanning(true); setError(null);
    try { setInv(await api.household('softwareInventory', { refresh }) as Inventory); } catch (err) { setError(errorText(err)); } finally { setScanning(false); }
  };
  const loadUpdates = async () => { try { setUpd(await api.household('softwareUpdates') as UpdateState); } catch (err) { setError(errorText(err)); } };
  const check = async () => {
    setChecking(true); setError(null);
    try { setUpd(await api.household('softwareCheckUpdates') as UpdateState); setTab('updates'); } catch (err) { setError(errorText(err)); } finally { setChecking(false); }
  };
  const saveSettings = async (patch: { periodicEnabled?: boolean; intervalHours?: number }) => {
    try { await api.household('softwareSettings', patch); await loadUpdates(); } catch (err) { setError(errorText(err)); }
  };
  useEffect(() => { void scan(false); void loadUpdates(); }, []);

  const needle = q.trim().toLowerCase();
  const match = (...parts: Array<string | number | null | undefined>) => !needle || parts.some((p) => p != null && String(p).toLowerCase().includes(needle));
  const updatesById = useMemo(() => new Map((upd?.results ?? []).map((u) => [u.itemId, u])), [upd]);
  const itemsById = useMemo(() => new Map((inv?.items ?? []).map((i) => [i.id, i])), [inv]);

  const openUrl = (url: string) => { void api.openExternalUrl(url).catch(() => undefined); };
  const unavailable = (inv?.sections ?? []).filter((s) => !s.available);
  const available = upd?.results.filter((u) => ['update_available', 'prerelease_available', 'behind_development'].includes(u.status)) ?? [];

  const toolItems = (inv?.items ?? []).filter((i) => i.kind !== 'git_repo' && (method === 'all' || i.installMethod === method) && match(i.name, i.version, i.installPath, i.packageId, i.upstream?.github));
  const repos = (inv?.items ?? []).filter((i) => i.kind === 'git_repo' && match(i.name, i.installPath, i.upstream?.url, i.details.branch as string));

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Software & Services</span>
        <span className="grow" />
        <button type="button" className="btn small" disabled={scanning} onClick={() => void scan(true)} title="Read the installed software, ports and services again">{scanning ? 'Scanning…' : 'Rescan'}</button>
        <button type="button" className="btn small primary" disabled={checking || !inv} onClick={() => void check()} title="Ask package managers and GitHub (public metadata only) for newer versions">{checking ? 'Checking…' : 'Check for updates'}</button>
      </div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>
          Read-only. Pandesh lists what is installed and what is newer; it does not install, update, start or stop anything here.
          {inv ? ` Scanned ${timeOf(inv.generatedAt)}.` : ''}{upd?.lastCheckedAt ? ` Updates checked ${timeOf(upd.lastCheckedAt)}.` : ' Updates not checked yet.'}
        </p>
        {error && <div className="notice error" role="alert">{error}</div>}
        {unavailable.length > 0 && (
          <details className="notice">
            <summary>{unavailable.length} source{unavailable.length > 1 ? 's' : ''} could not be read</summary>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>{unavailable.map((s) => <li key={s.id}>{s.label}: {s.reason}</li>)}</ul>
          </details>
        )}
        {upd?.github.rateLimitedUntil && <div className="notice" role="status">GitHub's hourly limit for unauthenticated checks was reached; GitHub checks resume after {timeOf(upd.github.rateLimitedUntil)}.</div>}

        <div role="tablist" aria-label="Software & Services" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              style={{ height: 38, padding: '0 12px', border: 0, borderBottom: `2px solid ${tab === t.id ? 'var(--pulse)' : 'transparent'}`, background: 'transparent', color: tab === t.id ? 'var(--ink)' : 'var(--muted)', fontWeight: tab === t.id ? 600 : 400 }}>
              {t.label}{t.id === 'updates' && available.length ? ` · ${available.length}` : ''}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="sr-only" htmlFor="sw-search">Search</label>
          <input id="sw-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, path, version, repository…" style={{ flex: '1 1 260px', height: 36, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--surface)' }} />
          {tab === 'tools' && (
            <>
              <label className="sr-only" htmlFor="sw-method">Installation method</label>
              <select id="sw-method" value={method} onChange={(e) => setMethod(e.target.value)} style={{ height: 36, padding: '0 8px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--surface)' }}>
                <option value="all">All methods</option>
                {Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </>
          )}
        </div>

        {!inv && scanning && <div className="notice" role="status">Reading installed software, ports and services… this can take a minute the first time.</div>}

        {inv && tab === 'ports' && (
          <section aria-label="Services and ports" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={head}>Port</th>{!narrow && <th style={head}>Address</th>}<th style={head}>Process</th>{!narrow && <th style={head}>Belongs to</th>}{!narrow && <th style={head}>Executable</th>}</tr></thead>
                <tbody>
                  {inv.ports.filter((p) => match(p.port, p.processName, p.executablePath, p.pandeshService, p.windowsService)).slice(0, MAX_ROWS).map((p) => {
                    const owner = p.pandeshService ? `Pandesh: ${p.pandeshService}` : p.windowsService ? `Service: ${p.windowsService}` : null;
                    return (
                      <tr key={`${p.address}:${p.port}:${p.pid}`}>
                        <td style={{ ...cell, ...mono }}>{p.port}{narrow && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{p.address}</div>}</td>
                        {!narrow && <td style={{ ...cell, ...mono }}>{p.address}</td>}
                        <td style={cell}>{p.processName ?? 'Unknown'} <span style={{ color: 'var(--muted)', ...mono }}>pid {p.pid}</span>{narrow && owner && <div style={{ color: 'var(--muted)', fontSize: 13, overflowWrap: 'anywhere' }}>{owner}</div>}</td>
                        {!narrow && <td style={cell}>{owner ?? '—'}</td>}
                        {!narrow && <td style={{ ...cell, ...mono, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{p.executablePath ?? 'Not disclosed'}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <h2 style={{ margin: 0, fontSize: 15 }}>Running Windows services ({inv.services.filter((s) => s.state === 'Running').length} of {inv.services.length})</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={head}>Service</th><th style={head}>State</th><th style={head}>Start</th><th style={head}>pid</th></tr></thead>
                <tbody>{inv.services.filter((s) => s.state === 'Running' && match(s.name, s.displayName)).slice(0, MAX_ROWS).map((s) => (
                  <tr key={s.name}><td style={cell}>{s.displayName} <span style={{ color: 'var(--muted)', ...mono }}>{s.name}</span></td><td style={cell}>{s.state}</td><td style={cell}>{s.startMode}</td><td style={{ ...cell, ...mono }}>{s.pid ?? '—'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}

        {inv && tab === 'tools' && (
          <div style={{ overflowX: 'auto' }}>
            <p style={{ margin: '0 0 8px', fontSize: 13.5, color: 'var(--muted)' }}>{toolItems.length} item{toolItems.length === 1 ? '' : 's'}{toolItems.length > MAX_ROWS ? ` · showing the first ${MAX_ROWS}; search to narrow` : ''}</p>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={head}>Name</th><th style={head}>Installed</th><th style={head}>Method</th><th style={head}>Upstream</th>{!narrow && <th style={head}>Path</th>}<th style={head}>Update</th></tr></thead>
              <tbody>{toolItems.slice(0, MAX_ROWS).map((i) => {
                const u = updatesById.get(i.id);
                return (
                  <tr key={i.id}>
                    <td style={cell}>{i.name}{i.dependents.ports.length ? <div style={{ fontSize: 12.5, color: 'var(--attention)' }}>In use: port {i.dependents.ports.map((p) => p.port).join(', ')}</div> : null}</td>
                    <td style={{ ...cell, ...mono }}>{i.version ?? '—'}</td>
                    <td style={cell}>{METHOD[i.installMethod] ?? i.installMethod}</td>
                    <td style={cell}><UpstreamCell upstream={i.upstream} onOpen={openUrl} /></td>
                    {!narrow && <td style={{ ...cell, ...mono, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{i.installPath ?? '—'}</td>}
                    <td style={cell}>{u ? <StatusPill u={u} /> : <span style={{ color: 'var(--muted)' }}>{upd?.lastCheckedAt ? 'No newer version reported' : 'Not checked'}</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}

        {inv && tab === 'github' && (
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {repos.length === 0 && <div className="notice">No Git repositories found under {inv.scanRoots.join(', ') || 'the scan folders'}.</div>}
            {repos.map((r) => {
              const u = updatesById.get(r.id);
              const d = r.details;
              return (
                <article key={r.id} className="card">
                  <span className="title">{r.name}</span>
                  <span className="evidence">{r.installPath}</span>
                  <UpstreamCell upstream={r.upstream} onOpen={openUrl} />
                  <span className="meta">Branch {String(d.branch ?? 'detached HEAD')}{d.head ? ` · ${String(d.head).slice(0, 10)}` : ''}{r.version && d.head && !String(d.head).startsWith(r.version) ? ` · nearest tag ${r.version}` : ''}</span>
                  <span className="meta">
                    {Number(d.modified) ? `${d.modified} changed` : 'No uncommitted changes'}{Number(d.untracked) ? ` · ${d.untracked} untracked` : ''}
                    {d.ahead != null ? ` · ${d.ahead} unpushed` : ' · no upstream branch'}{d.behind ? ` · ${d.behind} behind (last fetch)` : ''}
                    {Number(d.worktrees) > 1 ? ` · ${d.worktrees} worktrees` : ''}
                  </span>
                  {u?.fork && <span className="meta">{u.fork.isFork ? `Fork of ${u.fork.parent ?? 'another repository'}` : 'Upstream repository (not a fork)'}</span>}
                  {u ? <StatusPill u={u} /> : <span className="meta">{upd?.lastCheckedAt ? 'Not checked (no verified GitHub upstream)' : 'Not checked yet'}</span>}
                  {u?.summary && <span className="meta">{u.summary}</span>}
                </article>
              );
            })}
          </div>
        )}

        {tab === 'updates' && (
          <section aria-label="Available updates" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="notice" style={{ margin: 0, maxWidth: 'none' }}>
              Updating is not enabled yet: this milestone only finds updates. Periodic checks:{' '}
              <label><input type="checkbox" checked={Boolean(upd?.settings.periodicEnabled)} onChange={(e) => void saveSettings({ periodicEnabled: e.target.checked })} /> on</label>{' '}
              <label>every <select value={upd?.settings.intervalHours ?? 24} onChange={(e) => void saveSettings({ intervalHours: Number(e.target.value) })} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6 }}>{[6, 12, 24, 72, 168].map((h) => <option key={h} value={h}>{h < 24 ? `${h} h` : `${h / 24} day${h > 24 ? 's' : ''}`}</option>)}</select></label>
            </div>
            {!upd?.lastCheckedAt && <div className="notice">No check has run yet. Use “Check for updates”.</div>}
            {upd?.lastCheckedAt && available.length === 0 && <div className="notice">No newer versions were reported in the last check.</div>}
            {available.filter((u) => match(u.name, u.installed, u.latestStable, u.source)).map((u) => {
              const item = itemsById.get(u.itemId);
              return (
                <article key={`${u.source}:${u.itemId}`} className={`card${u.advisories.length ? ' needs-you' : ''}`}>
                  <span className="title">{u.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {u.source}</span></span>
                  <span className="meta" style={mono}>{u.installed ?? '?'} → {u.latestStable ?? u.latestPrerelease ?? `${u.behindBy} commits`}</span>
                  <StatusPill u={u} />
                  <span className="meta">{u.summary}</span>
                  {item?.installPath && <span className="evidence">{item.installPath}</span>}
                  {item && (item.dependents.ports.length > 0 || item.dependents.services.length > 0) && (
                    <span className="failure">Updating may interrupt: {[...item.dependents.ports.map((p) => `${p.process ?? 'process'} on port ${p.port}`), ...item.dependents.services].join(', ')}</span>
                  )}
                  {u.advisories.map((a) => <span key={a.id} className="failure">Security advisory {a.id}{a.severity ? ` (${a.severity})` : ''}: {a.summary}</span>)}
                  <div className="actions">{u.notesUrl && <button type="button" className="btn small" onClick={() => openUrl(u.notesUrl!)}>Release notes</button>}</div>
                </article>
              );
            })}
          </section>
        )}

        {tab === 'history' && (
          <section aria-label="Update history" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="notice" style={{ margin: 0, maxWidth: 'none' }}>Pandesh has not installed any update: update execution is not enabled. Below are the checks it ran.</div>
            {(upd?.history ?? []).length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No checks yet.</div>}
            {(upd?.history ?? []).map((h) => (
              <div key={h.at} className="card">
                <span className="title">{new Date(h.at).toLocaleString()} · {h.trigger}</span>
                <span className="meta">{h.checked} result{h.checked === 1 ? '' : 's'} · {h.updates} update{h.updates === 1 ? '' : 's'} available{h.rateLimitedUntil ? ` · GitHub rate-limited until ${timeOf(h.rateLimitedUntil)}` : ''}</span>
                {h.errors.map((e, i) => <span key={i} className="failure">{e}</span>)}
              </div>
            ))}
          </section>
        )}
      </div>
    </>
  );
}

function UpstreamCell({ upstream, onOpen }: { upstream: Upstream | null; onOpen: (url: string) => void }) {
  if (!upstream) return <span style={{ color: 'var(--muted)' }}>Not identified</span>;
  const label = upstream.github ?? upstream.url.replace(/^https?:\/\//, '');
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <button type="button" className="btn link" style={{ minHeight: 0, padding: 0, textAlign: 'left' }} title={upstream.url} onClick={() => onOpen(upstream.url)}>{label}</button>
      <span style={{ fontSize: 12.5, color: upstream.verified ? 'var(--muted)' : 'var(--attention)' }}>{upstream.verified ? `Verified · ${upstream.basis}` : `Unverified · ${upstream.basis}`}</span>
    </span>
  );
}

function StatusPill({ u }: { u: Update }) {
  const tone = u.status === 'update_available' || u.status === 'behind_development' ? 'var(--attention)' : u.status === 'error' || u.status === 'rate_limited' ? 'var(--danger)' : 'var(--muted)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: tone }}>
      {u.status === 'up_to_date' ? <Icon name="check" size={13} /> : <span className={`dot ${u.status === 'update_available' || u.status === 'behind_development' ? 'attention' : u.status === 'error' || u.status === 'rate_limited' ? 'danger' : 'muted'}`} aria-hidden="true" />}{STATUS[u.status] ?? u.status}{u.stale ? ' (last known)' : ''}{u.latestStable && u.status === 'update_available' ? ` · ${u.latestStable}` : ''}
    </span>
  );
}
