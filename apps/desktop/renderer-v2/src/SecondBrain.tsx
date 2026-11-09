import React, { useEffect, useMemo, useState } from 'react';
import { api, errorText } from './bridge';
import { timeOf } from './ui';

type ItemType = 'fact' | 'note' | 'commitment' | 'artifact' | 'entity' | 'document';
interface Hit { id: string; type: ItemType; title: string; snippet: string; scope: string; date: string | null; score: number }
interface GNode { id: string; type: string; label: string; count?: number }
interface GEdge { from: string; to: string; type: string; origin: string; evidence: string | null }
interface Graph { nodes: GNode[]; edges: GEdge[]; clusters: GNode[]; truncated: boolean }
interface Status { index: { items: number; builtAt: string }; grants: Array<{ id: string; folder: string; grantedAt: string }>; documents: number; facts: number; openConflicts: number; embeddings: string }

const TYPE_LABEL: Record<string, string> = { fact: 'Memories', note: 'Notes', commitment: 'Commitments', artifact: 'Files Pandesh made', entity: 'Things', document: 'Your documents' };
const NODE_TONE: Record<string, string> = { fact: 'var(--pulse)', entity: 'var(--verified)', document: 'var(--attention)', conversation: 'var(--muted)', cluster: 'var(--faint)' };
type Tab = 'search' | 'timeline' | 'graph' | 'sources';

export function SecondBrain({ narrow }: { narrow: boolean }) {
  const [tab, setTab] = useState<Tab>('search');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [sel, setSel] = useState<{ type: ItemType; id: string } | null>(null);
  const [item, setItem] = useState<Record<string, unknown> | null>(null);
  const [timeline, setTimeline] = useState<Array<{ id: string; type: ItemType; title: string; date: string; detail: string }> | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [folder, setFolder] = useState('');
  const [correction, setCorrection] = useState('');
  const [impact, setImpact] = useState<{ impact: { entries: unknown[] } } | null>(null);

  const call = async <T,>(action: string, args?: Record<string, unknown>): Promise<T | null> => { try { setError(null); return await api.household(action, args) as T; } catch (err) { setError(errorText(err)); return null; } };
  const loadStatus = async () => setStatus(await call<Status>('brainStatus'));
  useEffect(() => { void loadStatus(); }, []);
  useEffect(() => { if (tab === 'timeline') void call<{ items: typeof timeline }>('brainTimeline').then((r) => setTimeline(r?.items ?? [])); if (tab === 'graph' && !graph) void call<Graph>('brainGraph').then(setGraph); if (tab === 'sources') void loadStatus(); }, [tab]);
  useEffect(() => {
    const t = setTimeout(() => { if (q.trim().length >= 2) void call<{ hits: Hit[] }>('brainSearch', { q }).then((r) => setHits(r?.hits ?? [])); else setHits(null); }, 220);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => { setImpact(null); setCorrection(''); setNote(''); if (sel) void call<Record<string, unknown>>('brainItem', { type: sel.type, id: sel.id }).then(setItem); else setItem(null); }, [sel?.id]);

  const focus = async (type: ItemType, id: string) => { setSel({ type, id }); if (['fact', 'entity', 'document'].includes(type)) { const g = await call<Graph>('brainGraph', { focusType: type, id, hops: 1 }); if (g) setGraph(g); } };
  const forget = async () => {
    if (!sel || sel.type !== 'fact') return;
    if (!impact) { setImpact(await call('brainImpact', { id: sel.id })); return; }
    const r = await call('brainForget', { id: sel.id });
    if (r) { setNote('Forgotten. It no longer appears in search, the timeline or the graph.'); setSel(null); setHits(null); setQ(q + ' '); void loadStatus(); }
  };
  const correct = async () => {
    if (!sel || sel.type !== 'fact' || !correction.trim()) return;
    const r = await call<{ corrected: { id: string } }>('brainCorrect', { id: sel.id, value: correction });
    if (r) { setNote('Corrected. The new value is backed by your correction message; the old one was forgotten.'); setSel({ type: 'fact', id: r.corrected.id }); }
  };
  const addFolder = async () => { if (await call('allowDocumentReading', { folder: folder.trim() })) { setFolder(''); await call('brainReindex'); void loadStatus(); setNote('Folder added. Markdown and text files in it are now searchable; nothing else is read.'); } };
  const revoke = async (id: string) => { if (await call('revokeDocumentReading', { id })) { await call('brainReindex'); void loadStatus(); } };

  const grouped = useMemo(() => { const m = new Map<string, Hit[]>(); for (const h of hits ?? []) m.set(h.type, [...(m.get(h.type) ?? []), h]); return [...m.entries()]; }, [hits]);

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Second Brain</span>
        <span className="grow" />
        {status && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{status.facts} memories · {status.documents} documents{status.openConflicts ? ` · ${status.openConflicts} conflicts` : ''}</span>}
      </div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <div className="notice error" role="alert">{error}</div>}
        <div role="tablist" aria-label="Second Brain" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
          {([['search', 'Search'], ['timeline', 'Timeline'], ['graph', 'Graph'], ['sources', 'Sources']] as Array<[Tab, string]>).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} style={{ height: 38, padding: '0 12px', border: 0, borderBottom: `2px solid ${tab === id ? 'var(--pulse)' : 'transparent'}`, background: 'transparent', color: tab === id ? 'var(--ink)' : 'var(--muted)', fontWeight: tab === id ? 600 : 400 }}>{label}</button>
          ))}
        </div>
        {note && <p role="status" style={{ margin: 0, fontSize: 14 }}>{note}</p>}

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexDirection: narrow ? 'column' : 'row' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
            {tab === 'search' && (
              <>
                <label className="sr-only" htmlFor="sb-q">Search your Second Brain</label>
                <input id="sb-q" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories, notes, commitments and your documents…" style={{ height: 44, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface)', fontSize: 16 }} />
                {hits === null && <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>Everything here comes from your own records, each with its source. Nothing is invented and nothing leaves this PC.</p>}
                {hits && hits.length === 0 && <div className="notice">Nothing matches “{q.trim()}”. Pandesh will say so rather than guess.</div>}
                {grouped.map(([type, list]) => (
                  <section key={type} aria-label={TYPE_LABEL[type]} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <h2 style={{ margin: 0, fontSize: 13, letterSpacing: '0.04em', color: 'var(--muted)', textTransform: 'uppercase' }}>{TYPE_LABEL[type]} · {list.length}</h2>
                    {list.map((h) => (
                      <button key={h.type + h.id} type="button" className="card" onClick={() => void focus(h.type, h.id)} style={{ textAlign: 'left', cursor: 'pointer', borderColor: sel?.id === h.id ? 'var(--pulse)' : undefined }}>
                        <span className="title">{h.title}</span>
                        <span style={{ fontSize: 14 }}>{renderSnippet(h.snippet)}</span>
                        <span className="meta">{h.scope} scope{h.date ? ` · ${new Date(h.date).toLocaleDateString()}` : ''}</span>
                      </button>
                    ))}
                  </section>
                ))}
              </>
            )}
            {tab === 'timeline' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {timeline === null && <div className="notice" role="status">Reading…</div>}
                {timeline?.length === 0 && <div className="notice">No dated items yet.</div>}
                {timeline?.map((t) => (
                  <button key={t.type + t.id} type="button" className="card" onClick={() => void focus(t.type, t.id)} style={{ textAlign: 'left', cursor: 'pointer' }}>
                    <span className="meta">{new Date(t.date).toLocaleString()} · {TYPE_LABEL[t.type]}</span>
                    <span className="title">{t.title}</span>
                    <span style={{ fontSize: 14, color: 'var(--muted)' }}>{t.detail}</span>
                  </button>
                ))}
              </div>
            )}
            {tab === 'graph' && (
              <>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)' }}>Only real links: relationships Core recorded with evidence, links written in your documents, and where a memory came from. Pick an item in Search to see its neighbourhood.</p>
                {graph ? <GraphView graph={graph} onPick={(n) => { const [t, id] = n.id.split(':'); if (t === 'fact' || t === 'entity') void focus(t as ItemType, id); }} /> : <div className="notice" role="status">Reading…</div>}
              </>
            )}
            {tab === 'sources' && status && (
              <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ margin: 0, fontSize: 14 }}>Index: {status.index.items} items, built {timeOf(status.index.builtAt)}. Semantic search (embeddings): {status.embeddings}.</p>
                <h2 style={{ margin: 0, fontSize: 15 }}>Folders you allowed</h2>
                {status.grants.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>None. Pandesh reads no folder unless you add it here.</div>}
                {status.grants.map((g) => <div key={g.id} className="card" style={{ flexDirection: 'row', alignItems: 'center' }}><span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13, overflowWrap: 'anywhere' }}>{g.folder}</span><button type="button" className="btn small" onClick={() => void revoke(g.id)}>Stop reading</button></div>)}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <label className="sr-only" htmlFor="sb-folder">Folder path</label>
                  <input id="sb-folder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="D:\\Notes\\Vault" style={{ flex: '1 1 260px', height: 38, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--surface)' }} />
                  <button type="button" className="btn small" disabled={!/^[A-Za-z]:[\\/]/.test(folder.trim())} onClick={() => void addFolder()}>Allow reading this folder</button>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Only .md and .txt files up to 512 KB are indexed. The files stay where they are; the index is a cache that can be rebuilt.</p>
              </section>
            )}
          </div>

          {item && sel && (
            <aside aria-label="Item details" className="card" style={{ flex: narrow ? '1 1 auto' : '0 0 380px', width: narrow ? '100%' : undefined, gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center' }}><span className="title">{TYPE_LABEL[sel.type]}</span><span style={{ flex: 1 }} /><button type="button" className="btn small" onClick={() => setSel(null)}>Close</button></div>
              <Inspector item={item} />
              {sel.type === 'fact' && (
                <>
                  <label htmlFor="sb-correct" style={{ fontSize: 13, color: 'var(--muted)' }}>Correct this memory</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input id="sb-correct" value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="The right value" style={{ flex: 1, minWidth: 0, height: 34, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--canvas)' }} />
                    <button type="button" className="btn small" disabled={!correction.trim()} onClick={() => void correct()}>Correct</button>
                  </div>
                  {impact && <p role="status" style={{ margin: 0, fontSize: 13.5, color: 'var(--attention)' }}>{impact.impact.entries.length ? `${impact.impact.entries.length} linked item(s) depend on this memory.` : 'Nothing else depends on this memory.'} Press Forget again to confirm.</p>}
                  <button type="button" className="btn small" onClick={() => void forget()}>{impact ? 'Forget — confirm' : 'Forget…'}</button>
                </>
              )}
            </aside>
          )}
        </div>
      </div>
    </>
  );
}

function renderSnippet(s: string) {
  const parts = s.split(/(«[^»]*»)/g);
  return parts.map((p, i) => (p.startsWith('«') ? <mark key={i} style={{ background: 'var(--attention-wash)', color: 'var(--ink)', borderRadius: 3 }}>{p.slice(1, -1)}</mark> : <React.Fragment key={i}>{p}</React.Fragment>));
}

function Inspector({ item }: { item: Record<string, unknown> }) {
  const t = item.type as string;
  const row = (k: string, v: unknown) => v == null || v === '' ? null : <div key={k} style={{ display: 'flex', gap: 8, fontSize: 14 }}><span style={{ flex: '0 0 90px', color: 'var(--muted)' }}>{k}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{String(v)}</span></div>;
  if (t === 'fact') {
    const f = item.fact as Record<string, string>;
    const ev = item.evidence as Array<{ id: string; sourceType: string; conversationTitle: string | null; createdAt: string }>;
    const hist = item.history as Array<{ id: string; displayValue: string; state: string; createdAt: string }>;
    const contra = item.contradictions as unknown[];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {row('Subject', f.subject)}{row('Says', `${f.predicate} ${f.displayValue}`)}{row('Scope', `${f.scopeType}${f.scopeId ? ` · ${f.scopeId}` : ''}`)}{row('Since', new Date(f.validFrom ?? f.createdAt).toLocaleString())}
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Source</span>
        {ev.map((e) => <span key={e.id} style={{ fontSize: 13.5 }}>{e.sourceType.replace(/_/g, ' ')}{e.conversationTitle ? ` in “${e.conversationTitle}”` : ''} · {new Date(e.createdAt).toLocaleString()}</span>)}
        {hist.length > 1 && <><span style={{ fontSize: 13, color: 'var(--muted)' }}>History</span>{hist.map((h) => <span key={h.id} style={{ fontSize: 13.5, textDecoration: h.state === 'active' ? undefined : 'line-through' }}>{h.displayValue} · {h.state} · {new Date(h.createdAt).toLocaleDateString()}</span>)}</>}
        {contra.length > 0 && <span style={{ fontSize: 13.5, color: 'var(--attention)' }}>{contra.length} unresolved conflict(s) with another memory.</span>}
      </div>
    );
  }
  if (t === 'note') { const n = item.note as Record<string, string>; return <div>{row('Title', n.title)}<p style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{n.body}</p>{row('Updated', new Date(n.updatedAt).toLocaleString())}</div>; }
  if (t === 'document') {
    const c = item.chunk as Record<string, string>;
    const links = item.links as Array<{ target: string }>; const back = item.backlinks as Array<{ source: string }>;
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{row('File', c.locator)}{row('Section', c.heading)}<p style={{ whiteSpace: 'pre-wrap', fontSize: 14, margin: 0, maxHeight: 280, overflow: 'auto' }}>{c.text}</p>{links.length > 0 && row('Links to', links.map((l) => l.target.split(/[\\/]/).pop()).join(', '))}{back.length > 0 && row('Linked from', back.map((l) => l.source.split(/[\\/]/).pop()).join(', '))}</div>;
  }
  const obj = (item.commitment ?? item.artifact ?? item.entity ?? {}) as Record<string, unknown>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{Object.entries(obj).filter(([, v]) => typeof v !== 'object').slice(0, 10).map(([k, v]) => row(k, v))}</div>;
}

/** A small deterministic force layout (≤ 150 nodes), rendered as SVG. */
function GraphView({ graph, onPick }: { graph: Graph; onPick: (n: GNode) => void }) {
  const W = 760, H = 460;
  const layout = useMemo(() => {
    const nodes = graph.nodes.map((n, i) => ({ ...n, x: W / 2 + 180 * Math.cos(i * 2.399), y: H / 2 + 150 * Math.sin(i * 2.399), vx: 0, vy: 0 }));
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const edges = graph.edges.map((e) => [idx.get(e.from), idx.get(e.to)] as const).filter(([a, b]) => a !== undefined && b !== undefined) as Array<readonly [number, number]>;
    const k = Math.sqrt((W * H) / Math.max(nodes.length, 1)) * 0.6;
    for (let it = 0; it < 250; it++) {
      for (const n of nodes) { n.vx = 0; n.vy = 0; }
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y; const d2 = Math.max(dx * dx + dy * dy, 0.01); const f = (k * k) / d2;
        nodes[i].vx += dx * f; nodes[i].vy += dy * f; nodes[j].vx -= dx * f; nodes[j].vy -= dy * f;
      }
      for (const [a, b] of edges) { const dx = nodes[a].x - nodes[b].x, dy = nodes[a].y - nodes[b].y; const d = Math.max(Math.hypot(dx, dy), 0.01); const f = (d * d) / k / d; nodes[a].vx -= dx * f; nodes[a].vy -= dy * f; nodes[b].vx += dx * f; nodes[b].vy += dy * f; }
      const temp = 12 * (1 - it / 250) + 0.5;
      for (const n of nodes) { const v = Math.hypot(n.vx, n.vy) || 1; n.x = Math.min(W - 40, Math.max(40, n.x + (n.vx / v) * Math.min(v, temp) + (W / 2 - n.x) * 0.01)); n.y = Math.min(H - 30, Math.max(30, n.y + (n.vy / v) * Math.min(v, temp) + (H / 2 - n.y) * 0.01)); }
    }
    return { nodes, edges };
  }, [graph]);
  if (graph.nodes.length === 0) return <div className="notice">No linked items yet. Links appear when Core records a relationship or your documents link to each other.</div>;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface)', overflow: 'hidden' }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Knowledge graph with ${graph.nodes.length} items and ${graph.edges.length} links`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {layout.edges.map(([a, b], i) => <line key={i} x1={layout.nodes[a].x} y1={layout.nodes[a].y} x2={layout.nodes[b].x} y2={layout.nodes[b].y} stroke="var(--line)" strokeWidth={1.5} />)}
        {layout.nodes.map((n) => (
          <g key={n.id} onClick={() => onPick(n)} style={{ cursor: n.type === 'fact' || n.type === 'entity' ? 'pointer' : 'default' }}>
            <title>{`${n.type}: ${n.label}`}</title>
            <circle cx={n.x} cy={n.y} r={n.type === 'fact' ? 7 : 6} fill={NODE_TONE[n.type] ?? 'var(--muted)'} />
            {graph.nodes.length <= 40 && <text x={n.x > W * 0.65 ? n.x - 10 : n.x + 10} y={n.y + 4} textAnchor={n.x > W * 0.65 ? 'end' : 'start'} fontSize={11} fill="var(--muted)">{n.label.slice(0, 28)}</text>}
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 12px', fontSize: 12.5, color: 'var(--muted)', borderTop: '1px solid var(--line)' }}>
        {['fact', 'entity', 'document', 'conversation'].map((t) => <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 5, background: NODE_TONE[t] }} />{t}</span>)}
        <span>{graph.nodes.length} items · {graph.edges.length} links{graph.truncated ? ` · ${graph.clusters.map((c) => c.label).join(', ')}` : ''}</span>
      </div>
    </div>
  );
}
