import React, { useEffect, useRef, useState } from 'react';
import { api, errorText, onDesktopEvent, type ConversationEntry, type ConversationSearchResult } from './bridge';
import { Icon } from './ui';

/**
 * The chats drawer inside Home (v2 plan: past chats are a toggle drawer, not another page). Every chat Core keeps: search (titles, messages, attachments, sources), pinned first, then by day, archived on
 * request. Rename, pin, archive / restore and export call Core through the host; the list shown is the one Core returns.
 */
const STATE_LABELS: Record<string, string> = { active: 'Running', needs_approval: 'Needs your OK', completed: 'Done', failed: 'Failed', stopped: 'Stopped' };

export function dayBucket(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return 'Today';
  if (t >= start - 86_400_000) return 'Yesterday';
  if (t >= start - 6 * 86_400_000) return 'Previous 7 days';
  return 'Earlier';
}

/** Pinned chats first, then the rest grouped by the day they were last updated (newest first). */
export function groupConversations(list: ConversationEntry[], now = new Date()): Array<{ label: string; items: ConversationEntry[] }> {
  const live = list.filter((c) => !c.archivedAt);
  const pinned = live.filter((c) => c.pinnedAt).sort((a, b) => Date.parse(b.pinnedAt!) - Date.parse(a.pinnedAt!));
  const rest = live.filter((c) => !c.pinnedAt).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const groups: Array<{ label: string; items: ConversationEntry[] }> = [];
  if (pinned.length) groups.push({ label: 'Pinned', items: pinned });
  for (const c of rest) {
    const label = dayBucket(c.updatedAt, now);
    const g = groups.find((x) => x.label === label);
    if (g) g.items.push(c); else groups.push({ label, items: [c] });
  }
  return groups;
}

export function Chats({ currentId, onOpen, onNew, onClose, narrow }: { currentId: string | null; onOpen: (id: string) => void; onNew: () => void; onClose: () => void; narrow: boolean }) {
  const [list, setList] = useState<ConversationEntry[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSearchResult[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const latestQuery = useRef('');

  const load = async () => {
    try { setList(await api.listConversations(showArchived)); } catch (err) { setNote({ text: errorText(err), error: true }); }
  };
  useEffect(() => { void load(); }, [showArchived]);
  useEffect(() => onDesktopEvent((e) => { if (e.kind === 'result' || e.kind === 'conversation_message' || e.kind === 'cancelled' || e.kind === 'error') void load(); }), [showArchived]);

  useEffect(() => {
    const q = query.trim();
    latestQuery.current = q;
    if (!q) { setResults(null); return undefined; }
    const t = setTimeout(() => {
      api.searchConversations(q).then((r) => { if (latestQuery.current === q) setResults(r); }).catch((err) => setNote({ text: errorText(err), error: true }));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  /** Runs one change and shows the list Core returns (the archived view keeps archived chats in it). */
  const change = async (work: () => Promise<ConversationEntry[]>, done: string) => {
    setNote(null);
    try { await work(); await load(); setNote({ text: done }); } catch (err) { setNote({ text: errorText(err), error: true }); }
  };
  const exportChat = async (c: ConversationEntry) => {
    setNote(null);
    try {
      const r = await api.exportConversation(c.id);
      setNote({ text: r.saved ? `Saved to ${r.path}` : 'Export cancelled. Nothing was saved.' });
    } catch (err) { setNote({ text: errorText(err), error: true }); }
  };
  const saveRename = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (!title) { setRenaming(null); return; }
    const id = renaming.id;
    setRenaming(null);
    await change(() => api.renameConversation(id, title.slice(0, 200)), 'Renamed.');
  };

  const row = (c: ConversationEntry) => {
    const title = c.title?.trim() || c.preview?.trim() || 'Untitled chat';
    const archived = Boolean(c.archivedAt);
    return (
      <li key={c.id} className={`chat-row${c.id === currentId ? ' current' : ''}`}>
        {renaming?.id === c.id ? (
          <form className="chat-rename" onSubmit={(e) => { e.preventDefault(); void saveRename(); }}>
            <label className="sr-only" htmlFor={`rn-${c.id}`}>New name for this chat</label>
            <input id={`rn-${c.id}`} className="field" autoFocus maxLength={200} value={renaming.title} onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); } }} />
            <button type="submit" className="btn small primary">Save</button>
            <button type="button" className="btn small" onClick={() => setRenaming(null)}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="chat-open" onClick={() => onOpen(c.id)} aria-current={c.id === currentId ? 'true' : undefined}>
            <span className="chat-title">{c.pinnedAt ? <span className="sr-only">Pinned: </span> : null}{title}</span>
            {c.preview && c.title ? <span className="chat-preview">{c.preview}</span> : null}
            <span className="chat-meta">
              <span className={`chat-state s-${c.state}`}>{STATE_LABELS[c.state] ?? c.state}</span>
              {c.repositoryName ? <span>{c.repositoryName}</span> : null}
              <span>{new Date(c.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </span>
          </button>
        )}
        {renaming?.id !== c.id && (
          <span className="chat-actions">
            {archived ? (
              <button type="button" className="btn small" onClick={() => void change(() => api.unarchiveConversation(c.id), 'Restored.')}>Restore</button>
            ) : (
              <>
                <button type="button" className="btn small" onClick={() => setRenaming({ id: c.id, title: c.title ?? '' })}>Rename</button>
                <button type="button" className="btn small" aria-pressed={Boolean(c.pinnedAt)} onClick={() => void change(() => (c.pinnedAt ? api.unpinConversation(c.id) : api.pinConversation(c.id)), c.pinnedAt ? 'Unpinned.' : 'Pinned.')}>{c.pinnedAt ? 'Unpin' : 'Pin'}</button>
                <button type="button" className="btn small" onClick={() => void exportChat(c)}>Export</button>
                <button type="button" className="btn small" onClick={() => void change(() => api.archiveConversation(c.id), 'Archived. Turn on “Show archived” to find it again.')}>Archive</button>
              </>
            )}
          </span>
        )}
      </li>
    );
  };

  const groups = list ? groupConversations(list) : [];
  const archived = (list ?? []).filter((c) => c.archivedAt);

  return (
    <aside className={`chats-drawer${narrow ? ' narrow' : ''}`} aria-label="Chats" onKeyDown={(e) => { if (e.key === 'Escape' && !renaming) { e.preventDefault(); onClose(); } }}>
      <div className="chats-head">
        <span style={{ fontWeight: 600 }}>Chats</span>
        <span className="grow" />
        <button type="button" className="btn small primary" onClick={onNew}><Icon name="plus" size={15} /> New</button>
        <button type="button" className="btn small" onClick={onClose} aria-label="Close chats">Close</button>
      </div>
      <div className="chats-body">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5 }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        <div className="palette-input" style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)' }}>
          <Icon name="search" size={17} />
          <label className="sr-only" htmlFor="chats-search">Search chats</label>
          <input id="chats-search" autoFocus value={query} placeholder="Search your chats…" onChange={(e) => setQuery(e.target.value)} />
          {query && <button type="button" className="btn small" onClick={() => setQuery('')}>Clear</button>}
        </div>
        {note && <div className={`notice${note.error ? ' error' : ''}`} role={note.error ? 'alert' : 'status'} style={{ margin: 0, maxWidth: 'none' }}>{note.text}</div>}
        {results ? (
          <section aria-label="Search results">
            {results.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No chat matches “{query.trim()}”.</div>}
            <ul className="chat-list">
              {results.map((r) => (
                <li key={`${r.conversationId}:${r.messageId ?? 't'}`} className="chat-row">
                  <button type="button" className="chat-open" onClick={() => onOpen(r.conversationId)}>
                    <span className="chat-title">{r.title?.trim() || 'Untitled chat'}</span>
                    <span className="chat-preview">{r.snippet}</span>
                    <span className="chat-meta"><span>Matched in {r.matchedKinds.join(', ')}</span><span>{new Date(r.updatedAt).toLocaleDateString()}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <>
            {list === null && <div className="notice" role="status">Reading your chats from Core…</div>}
            {list && groups.length === 0 && archived.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No chats yet. Start one with New chat.</div>}
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="chat-group">{g.label}</h2>
                <ul className="chat-list">{g.items.map(row)}</ul>
              </section>
            ))}
            {showArchived && (
              <section aria-label="Archived">
                <h2 className="chat-group">Archived ({archived.length})</h2>
                {archived.length === 0 ? <div className="empty" style={{ color: 'var(--faint)' }}>Nothing archived.</div> : <ul className="chat-list">{archived.map(row)}</ul>}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
