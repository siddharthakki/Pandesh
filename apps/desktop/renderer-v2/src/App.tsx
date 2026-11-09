import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, useSnapshot, type ConversationEntry } from './bridge';
import { Icon, useNarrow, type IconName } from './ui';
import { Chat } from './Chat';
import { Board, useTaskOverview, needsYouCount } from './Board';
import { Software } from './Software';
import { Revenue } from './Revenue';
import { Team } from './Team';
import { ToolsHub } from './ToolsHub';
import { SecondBrain } from './SecondBrain';
import { Processes } from './Processes';
import { Workspace, type SpaceId } from './Workspaces';

export type View = 'chat' | 'board' | 'team' | 'space' | 'system' | 'software' | 'tools' | 'brain' | 'processes' | 'workspace' | 'revenue';

interface PaletteEntry { group: string; label: string; run: () => void }

export function App() {
  const narrow = useNarrow();
  const { snapshot, error, refresh } = useSnapshot();
  const overview = useTaskOverview();
  const [view, setView] = useState<View>('chat');
  const [placeholder, setPlaceholder] = useState<{ title: string; text: string } | null>(null);
  const [pop, setPop] = useState<null | 'spaces' | 'system' | 'palette'>(null);
  const [labels, setLabels] = useState<boolean>(() => { try { return localStorage.getItem('pandesh.v2.labels') === '1'; } catch { return false; } });
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? 'system');
  const opener = useRef<HTMLElement | null>(null);
  const [variantForced, setVariantForced] = useState(false);
  useEffect(() => { api.getUiVariant().then((v) => setVariantForced(v.forcedByEnv)).catch(() => setVariantForced(false)); }, []);

  const needs = needsYouCount(overview.data?.tasks ?? [], snapshot);

  const openPop = (name: 'spaces' | 'system' | 'palette') => {
    if (pop === name) { closePop(); return; }
    if (!pop) opener.current = document.activeElement as HTMLElement | null;
    setPop(name);
  };
  const closePop = () => {
    setPop(null);
    const back = opener.current;
    opener.current = null;
    if (back?.focus) setTimeout(() => back.focus(), 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPop('palette'); }
      else if (e.key === 'Escape' && pop) { e.preventDefault(); closePop(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggleLabels = () => { const next = !labels; setLabels(next); try { localStorage.setItem('pandesh.v2.labels', next ? '1' : '0'); } catch { /* ignore */ } };
  const cycleTheme = () => {
    const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    setTheme(next);
    if (next === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    try { if (next === 'system') localStorage.removeItem('pandesh.v2.theme'); else localStorage.setItem('pandesh.v2.theme', next); } catch { /* ignore */ }
  };
  const showPlaceholder = (title: string, text: string) => { setPlaceholder({ title, text }); setView('space'); setPop(null); };
  const useClassic = async () => { try { await api.setUiVariant('classic'); } catch (err) { alert(errorText(err)); } };

  const go = (v: View) => { setView(v); setPop(null); };
  const openSpace = (id: SpaceId) => { setSpace(id); go('workspace'); };
  const rail: Array<{ id: View; label: string; text: string; icon: IconName; badge?: number; onClick: () => void }> = [
    { id: 'chat', label: 'Pandesh — home and chats', text: 'Pandesh', icon: 'home', onClick: () => go('chat') },
    { id: 'board', label: needs ? `Board — ${needs} need you` : 'Board — tasks and their real status', text: 'Board', icon: 'board', badge: needs || undefined, onClick: () => go('board') },
    { id: 'team', label: 'Team — specialist agents', text: 'Team', icon: 'team', onClick: () => go('team') },
  ];

  const spaces = [
    { name: 'Second Brain', sub: 'Search your memories, notes and documents', run: () => go('brain') },
    { name: 'Projects', sub: 'Projects, repositories and stories', run: () => openSpace('projects') },
    { name: 'Wish to Reality', sub: 'Goals and offers (feature-frozen)', run: () => openSpace('wish') },
    { name: 'Social Studio', sub: 'Drafts and your decisions (no publishing)', run: () => openSpace('social') },
    { name: 'Media Studio', sub: 'Local image studio and media Pandesh made', run: () => openSpace('media') },
    { name: 'Automations', sub: 'Routines, daily brief, command queue', run: () => openSpace('automations') },
    { name: 'Revenue', sub: 'Leads, offers, drafts awaiting you, verified results', run: () => go('revenue') },
  ];
  const system = [
    variantForced
      ? { name: 'Classic UI is locked off', sub: 'PANDESH_UI_V2=1 is set for this launch; start without it to switch', run: () => {} }
      : { name: 'Use the Classic UI', sub: 'Reloads the window in the existing interface', run: () => void useClassic() },
    { name: 'Tools & Skills', sub: 'Capabilities, agents × tools, skills, MCP, capability tests', run: () => go('tools') },
    { name: 'Processes', sub: 'What Pandesh started, checked against Windows now', run: () => go('processes') },
    { name: 'Software & Services', sub: 'Ports, installed tools, GitHub projects, updates (read-only)', run: () => go('software') },
    { name: `Theme: ${theme}`, sub: 'Cycle dark → light → follow Windows', run: cycleTheme },
    { name: labels ? 'Hide rail labels' : 'Show rail labels', sub: 'Names next to the navigation icons', run: toggleLabels },
  ];

  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  useEffect(() => { if (pop === 'palette') api.listConversations(false).then(setConversations).catch(() => setConversations([])); }, [pop]);
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  const [space, setSpace] = useState<SpaceId>('projects');
  const [draft, setDraft] = useState<string | null>(null);

  const paletteEntries: PaletteEntry[] = useMemo(() => [
    { group: 'GO TO', label: 'Pandesh (chat)', run: () => go('chat') },
    { group: 'GO TO', label: 'Board', run: () => go('board') },
    { group: 'GO TO', label: 'Software & Services', run: () => go('software') },
    { group: 'GO TO', label: 'Team', run: () => go('team') },
    { group: 'GO TO', label: 'Tools & Skills', run: () => go('tools') },
    { group: 'GO TO', label: 'Second Brain', run: () => go('brain') },
    { group: 'GO TO', label: 'Processes', run: () => go('processes') },
    { group: 'ACTIONS', label: 'New chat', run: () => { void api.newConversation().then(refresh); setOpenConversationId(null); go('chat'); } },
    { group: 'ACTIONS', label: 'Use the Classic UI', run: () => void useClassic() },
    { group: 'ACTIONS', label: 'Change theme', run: cycleTheme },
    ...conversations.slice(0, 12).map((c) => ({ group: 'RECENT CHATS', label: c.title || c.preview || 'Untitled chat', run: () => { setOpenConversationId(c.id); go('chat'); } })),
  ], [conversations, theme, labels]);

  const navButtons = rail.map((r) => (
    <button key={r.id} type="button" className="rail-btn" title={r.label} aria-label={r.label} aria-current={view === r.id ? 'page' : undefined} onClick={r.onClick}>
      <Icon name={r.icon} />
      {(labels || narrow) && <span className="label">{narrow && r.badge ? `${r.text} · ${r.badge}` : r.text}</span>}
      {!narrow && r.badge ? <span className="badge" aria-hidden="true">{r.badge}</span> : null}
    </button>
  ));

  return (
    <div className={`app${narrow ? ' narrow' : ''}`}>
      {!narrow && (
        <nav className={`rail${labels ? ' labels' : ''}`} aria-label="Main">
          {navButtons}
          <button type="button" className="rail-btn" title="Spaces — Second Brain, Projects, Studios" aria-label="Spaces" aria-expanded={pop === 'spaces'} onClick={() => openPop('spaces')}>
            <Icon name="spaces" />{labels && <span className="label">Spaces</span>}
          </button>
          <div className="spacer" />
          <button type="button" className="rail-btn" title="System — Classic UI, theme, labels" aria-label="System" aria-expanded={pop === 'system'} onClick={() => openPop('system')}>
            <Icon name="system" />{labels && <span className="label">System</span>}
          </button>
          <button type="button" className="rail-btn" title={labels ? 'Hide labels' : 'Show labels'} aria-label={labels ? 'Hide labels' : 'Show labels'} aria-pressed={labels} onClick={toggleLabels}>
            <Icon name={labels ? 'collapse' : 'expand'} size={18} />{labels && <span className="label">Hide labels</span>}
          </button>
        </nav>
      )}

      <div className="main">
        {view === 'chat' && <Chat snapshot={snapshot} snapshotError={error} refresh={refresh} narrow={narrow} openConversationId={openConversationId} onOpenPalette={() => openPop('palette')} onOpenBoard={() => go('board')} draft={draft} onDraftUsed={() => setDraft(null)} />}
        {view === 'board' && <Board overview={overview} narrow={narrow} onOpenPalette={() => openPop('palette')} onOpenConversation={(id) => { setOpenConversationId(id); go('chat'); }} />}
        {view === 'software' && <Software narrow={narrow} />}
        {view === 'revenue' && <Revenue />}
        {view === 'tools' && <ToolsHub narrow={narrow} />}
        {view === 'brain' && <SecondBrain narrow={narrow} />}
        {view === 'processes' && <Processes narrow={narrow} />}
        {view === 'workspace' && <Workspace space={space} narrow={narrow} onAskPandesh={(t) => { setDraft(t); go('chat'); }} />}
        {view === 'team' && <Team narrow={narrow} latestAttemptId={(overview.data?.tasks ?? []).find((t) => t.conversationId === snapshot?.selectedConversationId)?.attemptId ?? overview.data?.tasks?.[0]?.attemptId ?? null}
          onMessage={(agentId) => { void (async () => { await api.household('selectAgent', { agentId }); await api.newConversation(); setOpenConversationId(null); refresh(); go('chat'); })(); }} />}
        {view === 'space' && placeholder && (
          <div className="placeholder" role="region" aria-label={placeholder.title}>
            <h1>{placeholder.title}</h1>
            <p>{placeholder.text}</p>
            <button type="button" className="btn" onClick={() => void useClassic()}>Open the Classic UI</button>{' '}
            <button type="button" className="btn" onClick={() => go('chat')}>Back to chat</button>
          </div>
        )}

        {pop === 'spaces' && (
          <div className="popover" role="dialog" aria-label="Spaces" style={narrow ? { left: 16, right: 16, bottom: 8, width: 'auto' } : { left: labels ? 192 : 64, top: 150 }}>
            <h2>SPACES</h2>
            {spaces.map((s, i) => <button key={s.name} type="button" className="menu-item" autoFocus={i === 0} onClick={s.run}><span>{s.name}</span><span className="sub">{s.sub}</span></button>)}
            {narrow && <><h2>SYSTEM</h2>{system.map((s) => <button key={s.name} type="button" className="menu-item" onClick={() => { s.run(); }}><span>{s.name}</span><span className="sub">{s.sub}</span></button>)}</>}
          </div>
        )}
        {pop === 'system' && (
          <div className="popover" role="dialog" aria-label="System" style={{ left: labels ? 192 : 64, bottom: 56 }}>
            <h2>SYSTEM</h2>
            {system.map((s, i) => <button key={s.name} type="button" className="menu-item" autoFocus={i === 0} onClick={() => { s.run(); }}><span>{s.name}</span><span className="sub">{s.sub}</span></button>)}
          </div>
        )}
        {pop === 'palette' && <Palette entries={paletteEntries} onClose={closePop} />}
      </div>

      {narrow && (
        <nav className="bottom-bar" aria-label="Main">
          {navButtons}
          <button type="button" className="rail-btn" aria-label="More: spaces and system" aria-expanded={pop === 'spaces'} onClick={() => openPop('spaces')}><Icon name="more" /><span className="label">More</span></button>
        </nav>
      )}
    </div>
  );
}

function Palette({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const shown = entries.filter((e) => e.label.toLowerCase().includes(q.trim().toLowerCase()));
  const run = (e: PaletteEntry | undefined) => { if (!e) return; onClose(); e.run(); };
  let lastGroup = '';
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={17} />
          <label className="sr-only" htmlFor="v2-palette">Search commands and chats</label>
          <input id="v2-palette" autoFocus value={q} placeholder="Go to, open a chat, or run an action…" role="combobox" aria-expanded="true" aria-controls="v2-palette-list"
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(shown[sel]); }
            }} />
          <button type="button" className="btn small" onClick={onClose}>Close</button>
        </div>
        <div className="palette-list" id="v2-palette-list" role="listbox" aria-label="Results">
          {shown.length === 0 && <div className="palette-group">NOTHING MATCHES</div>}
          {shown.map((e, i) => {
            const head = e.group !== lastGroup ? <div className="palette-group" role="presentation">{e.group}</div> : null;
            lastGroup = e.group;
            return <React.Fragment key={`${e.group}:${e.label}:${i}`}>{head}<button type="button" role="option" aria-selected={i === sel} className="palette-item" onMouseEnter={() => setSel(i)} onClick={() => run(e)}>{e.label}</button></React.Fragment>;
          })}
        </div>
      </div>
    </div>
  );
}
