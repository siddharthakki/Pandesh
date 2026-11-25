import React, { useEffect, useState } from 'react';
import { api, errorText, type BriefAction, type BriefItem, type ConversationEntry, type Snapshot } from './bridge';
import { Icon } from './ui';
import { SETTINGS_TABS, WORK_TABS, isInternalConversation, needsThePerson, needsYouTotal, type HomeCounts, type Place, type SettingsTab, type SubLink, type WorkTab } from './placesModel';
import { NOTE_ISSUES, type NoteIssue, type NoteOutcome, addNote, clearNotes, listNotes, usabilityReport, type UsabilityNote } from './usability';

/** The tab bar of Work and Settings, with the few sibling pages of the current tab on a second row. */
export function PlaceTabs({ place, workTab, settingsTab, subs, needs, onWorkTab, onSettingsTab, onSub }: {
  place: Place; workTab: WorkTab; settingsTab: SettingsTab; subs: SubLink[]; needs: number;
  onWorkTab: (t: WorkTab) => void; onSettingsTab: (t: SettingsTab) => void; onSub: (key: string) => void;
}) {
  if (place !== 'work' && place !== 'settings') return null;
  const tabs = place === 'work' ? WORK_TABS : SETTINGS_TABS;
  const current = place === 'work' ? workTab : settingsTab;
  const pick = (id: string) => (place === 'work' ? onWorkTab(id as WorkTab) : onSettingsTab(id as SettingsTab));
  // Left and right arrows move between tabs, as a tab list should.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === current);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    pick(next.id);
    setTimeout(() => document.getElementById(`v2-place-tab-${next.id}`)?.focus(), 0);
  };
  return (
    <div className="placebar">
      <div className="placebar-row">
        <h1 className="place-title">{place === 'work' ? 'Work' : 'Settings'}</h1>
        <div className="place-tabs" role="tablist" aria-label={place === 'work' ? 'Work' : 'Settings'} onKeyDown={onKey}>
          {tabs.map((t) => (
            <button key={t.id} id={`v2-place-tab-${t.id}`} type="button" role="tab" className="place-tab" title={t.hint} aria-selected={t.id === current} tabIndex={t.id === current ? 0 : -1} onClick={() => pick(t.id)}>
              {t.label}{place === 'work' && t.id === 'active' && needs ? <span className="badge" aria-label={`${needs} need you`}>{needs}</span> : null}
            </button>
          ))}
        </div>
      </div>
      {subs.length > 0 && (
        <div className="place-subs" role="group" aria-label="Pages in this tab">
          {subs.map((s) => <button key={s.key} type="button" className="place-sub" aria-current={s.current ? 'page' : undefined} onClick={() => onSub(s.key)}>{s.label}</button>)}
        </div>
      )}
    </div>
  );
}

/**
 * What needs the person: Core's own assistant brief (approvals waiting, tasks that stopped and can be resumed), with the actions Core
 * offers for each. An approval is resolved through the same host call as before; nothing here decides on the person's behalf.
 */
export function useBrief(snapshot: Snapshot | null, refresh: () => void, onOpenWork: () => void, taskPicture = '') {
  const [items, setItems] = useState<BriefItem[] | null>(null);
  const [note, setNote] = useState('');
  const load = async () => { try { const b = await api.getAssistantBrief({ external: false }); setItems(b.home ?? []); } catch { setItems(null); } };
  // Core may still be starting at mount: read again once it connects, after each turn, and when a decision appears or goes.
  useEffect(() => { if (snapshot?.coreState === 'connected') void load(); }, [snapshot?.coreState, snapshot?.lastTurnOutcome, snapshot?.running, snapshot?.pendingApproval?.approvalId,
    // ...and when the board's numbers move: a task stopped elsewhere takes its approval with it, and the row must go too.
    taskPicture]);
  const run = async (item: BriefItem, action: BriefAction) => {
    try {
      if (action.kind === 'resolve_approval' && action.approvalId) {
        const rejecting = /reject|deny|decline|don't/i.test(action.label);
        await api.resolveAssistantApproval(action.approvalId, rejecting ? 'rejected' : 'approved');
        setNote(`${item.title}: ${rejecting ? 'declined' : 'approved'}.`);
      } else if (action.kind === 'open_conversation' && action.conversationId) {
        await api.openConversation(action.conversationId, true); refresh(); setNote('');
      } else if (action.kind === 'stop_task' && action.attemptId) {
        const r = await api.cancelTask(action.attemptId); setNote(r.requested ? 'Stop requested.' : 'It could not be stopped any more.');
      } else if (action.kind === 'resume_task' && action.attemptId) {
        await api.resumeTask(action.attemptId); setNote('Resumed.');
      } else if (action.kind === 'refresh_brief') {
        setNote('');
      } else { onOpenWork(); return; }
    } catch (err) { setNote(`${item.title}: ${errorText(err)}`); }
    await load();
  };
  return { items, note, run };
}

/** Home's one line of status. Each part opens the Work tab that lists those tasks; nothing here is a second source of truth. */
export function HomeStatus({ counts, loading, error, brief, onOpen, onNote }: {
  counts: HomeCounts | null; loading: boolean; error: string | null; brief: ReturnType<typeof useBrief>; onOpen: (tab: 'active' | 'completed') => void; onNote: () => void;
}) {
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const [open, setOpen] = useState(false);
  // Only what asks something of the person: a running task and a finished result are in the other chips.
  const items = (brief.items ?? []).filter((i) => needsThePerson(i));
  const total = needsYouTotal(items.map((i) => i.kind), counts?.needsYou ?? 0);
  const timeOf = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  return (
    <>
    <div className="home-status" role="region" aria-label="What Pandesh is doing">
      {total > 0
        ? <button type="button" className="home-chip attention" aria-expanded={open} aria-controls="v2-needs-you" onClick={() => (items.length ? setOpen(!open) : onOpen('active'))}>{part(total, 'thing needs you', 'things need you')}{items.length ? ` · ${open ? 'Hide' : 'Show'}` : ''}</button>
        : brief.items && <span className="home-chip quiet">Nothing needs you</span>}
      {error && <span className="home-chip warn" role="status">Task status is not available: Core is not answering.</span>}
      {!error && loading && <span className="home-chip" role="status">Reading tasks…</span>}
      {!error && counts && (
        <>
          <button type="button" className="home-chip" onClick={() => onOpen('active')}>{counts.inProgress ? part(counts.inProgress, 'task in progress', 'tasks in progress') : 'Nothing running'}</button>
          {counts.stuck > 0 && <button type="button" className="home-chip warn" onClick={() => onOpen('active')}>{part(counts.stuck, 'task is stuck', 'tasks are stuck')}</button>}
          <button type="button" className="home-chip" onClick={() => onOpen('completed')}>{part(counts.doneToday, 'task done today', 'tasks done today')}</button>
          {counts.failedToday > 0 && <button type="button" className="home-chip warn" onClick={() => onOpen('completed')}>{part(counts.failedToday, 'did not finish today', 'did not finish today')}</button>}
        </>
      )}
      <span className="grow" />
      <button type="button" className="home-chip quiet" title="Write down something that was hard to find or use (kept on this PC only)" onClick={onNote}>Feedback</button>
    </div>
    {open && items.length > 0 && (
      <ul id="v2-needs-you" className="needs-list" aria-label="Things that need you">
        {items.map((item) => (
          <li key={item.id}>
            <span className={`dot ${item.stance === 'fact' && /fail|error/i.test(item.state) ? 'danger' : 'attention'}`} aria-hidden="true" />
            <div className="needs-text">
              <span className="needs-title">{item.title}</span>
              <span className="needs-detail">{item.detail} · {item.source.label}, checked {timeOf(item.source.checkedAt)}</span>
            </div>
            <div className="needs-actions">
              {item.actions.map((a) => <button key={a.kind + a.label} type="button" className="btn small" onClick={() => void brief.run(item, a)}>{a.label}</button>)}
            </div>
          </li>
        ))}
        {total > items.length && <li><div className="needs-text"><span className="needs-detail">{total - items.length} more waiting for a decision.</span></div><div className="needs-actions"><button type="button" className="btn small" onClick={() => onOpen('active')}>See all in Work</button></div></li>}
      </ul>
    )}
    {brief.note && <p className="needs-note" role="status" aria-live="polite">{brief.note}</p>}
    </>
  );
}

function when(iso: string): string {
  const d = new Date(iso); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Recent conversations beside the chat. Collapsible; the list is Core's own conversation list. */
export function HistoryPanel({ currentId, reloadKey, onOpen, onClose }: { currentId: string | null; reloadKey: unknown; onOpen: (id: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<ConversationEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  const [retry, setRetry] = useState(0);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout> | undefined;
    api.listConversations(false).then((list) => { if (live) { setItems(list); setFailed(false); } })
      // Core may still be starting when the window opens: keep trying quietly instead of leaving an error up.
      .catch(() => { if (live) { setFailed(true); timer = setTimeout(() => setRetry((n) => n + 1), 3000); } });
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [reloadKey, currentId, retry]);
  const want = q.trim().toLowerCase();
  // Execution transcripts (mission steps, connector tasks) stay out of the list; a search or "Show" brings them back.
  const internal = (items ?? []).filter((c) => isInternalConversation(c.title)).length;
  const shown = (items ?? []).filter((c) => (want ? `${c.title ?? ''} ${c.preview ?? ''}`.toLowerCase().includes(want) : all || !isInternalConversation(c.title)));
  return (
    <aside className="history" aria-label="Conversations">
      <div className="history-head">
        <span className="history-title">Conversations</span>
        <button type="button" className="ghost-icon" title="Hide conversations" aria-label="Hide conversations" onClick={onClose}><Icon name="collapse" size={18} /></button>
      </div>
      <label className="sr-only" htmlFor="v2-history-filter">Filter conversations</label>
      <input id="v2-history-filter" className="history-filter" value={q} placeholder="Find a conversation…" onChange={(e) => setQ(e.target.value)} />
      <div className="history-list">
        {failed && !items && <div className="history-empty" role="status">Waiting for Core to list your conversations…</div>}
        {!failed && !items && <div className="history-empty" role="status">Reading…</div>}
        {items && shown.length === 0 && <div className="history-empty">{want ? 'Nothing matches.' : 'No conversations yet.'}</div>}
        {shown.slice(0, 200).map((c) => (
          <button key={c.id} type="button" className="history-item" aria-current={c.id === currentId ? 'true' : undefined} onClick={() => onOpen(c.id)}>
            <span className="history-name">{c.title || c.preview || 'Untitled chat'}</span>
            <span className="history-when">{when(c.updatedAt)}</span>
          </button>
        ))}
      </div>
      {/* Below the scrolling list, so it stays in reach when the transcripts are showing. */}
      {items && !want && internal > 0 && (
        <button type="button" className="history-more" aria-pressed={all} onClick={() => setAll(!all)}>{all ? 'Hide task transcripts' : `Show ${internal} task transcript${internal === 1 ? '' : 's'}`}</button>
      )}
    </aside>
  );
}

/** Write a daily-use note, and review or copy what was collected. Local to this window. */
export function UsabilityDialog({ where, onClose }: { where: string; onClose: () => void }) {
  const [notes, setNotes] = useState<UsabilityNote[]>(() => listNotes());
  const [text, setText] = useState('');
  const [said, setSaid] = useState('');
  const [task, setTask] = useState('');
  const [outcome, setOutcome] = useState<NoteOutcome | ''>('');
  const [issues, setIssues] = useState<NoteIssue[]>([]);
  const canSave = Boolean(text.trim() || task.trim());
  const save = () => {
    if (!canSave) return;
    setNotes(addNote(where, text, new Date(), { task, outcome: outcome || undefined, issues }));
    setText(''); setTask(''); setOutcome(''); setIssues([]); setSaid('Saved on this PC.');
  };
  const copy = async () => { try { await navigator.clipboard.writeText(usabilityReport()); setSaid('Copied.'); } catch { setSaid('Could not copy; select the text below instead.'); } };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette usability" role="dialog" aria-label="Feedback">
        <div className="usability-body">
          <h2>What did you try, and how did it go?</h2>
          <p className="settings-note">One line is enough; everything here is optional. It stays on this PC, with a count of which places you opened each day. It never records what you asked Pandesh.</p>
          <label className="sr-only" htmlFor="v2-usability-task">What you were trying to do</label>
          <input id="v2-usability-task" className="history-filter" style={{ margin: 0 }} value={task} placeholder="What you were trying to do (for example: find yesterday's report)" onChange={(e) => setTask(e.target.value)} />
          <div className="usability-actions" role="group" aria-label="How it went">
            {(['completed', 'blocked'] as const).map((o) => (
              <button key={o} type="button" className="btn small" aria-pressed={outcome === o} onClick={() => setOutcome(outcome === o ? '' : o)}>{o === 'completed' ? 'Completed' : 'Blocked'}</button>
            ))}
            {NOTE_ISSUES.map((i) => (
              <label key={i.id} className="usability-check"><input type="checkbox" checked={issues.includes(i.id)} onChange={(e) => setIssues(e.target.checked ? [...issues, i.id] : issues.filter((x) => x !== i.id))} /> {i.label}</label>
            ))}
          </div>
          <label className="sr-only" htmlFor="v2-usability-text">Your note</label>
          <textarea id="v2-usability-text" autoFocus rows={3} value={text} placeholder="What happened, or what should be better. For example: I looked for the backup automation under Projects first." onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } }} />
          <div className="usability-actions">
            <button type="button" className="btn small" disabled={!canSave} onClick={save}>Save note</button>
            <button type="button" className="btn small" onClick={() => void copy()}>Copy everything</button>
            <button type="button" className="btn small" disabled={!notes.length} onClick={() => { if (confirm('Delete all notes and counts on this PC?')) { clearNotes(); setNotes([]); setSaid('Deleted.'); } }}>Delete all</button>
            <span className="grow" />
            <span className="muted" role="status">{said}</span>
            <button type="button" className="btn small" onClick={onClose}>Close</button>
          </div>
          <pre className="usability-report" aria-label="Collected so far">{usabilityReport(notes)}</pre>
        </div>
      </div>
    </div>
  );
}
