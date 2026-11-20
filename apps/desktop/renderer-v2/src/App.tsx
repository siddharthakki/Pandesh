import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, onDesktopEvent, useSnapshot, type ConversationEntry } from './bridge';
import { parseV2Target } from './navigationTargets';
import { Icon, useNarrow, type IconName } from './ui';
import { Chat } from './Chat';
import { Board, useTaskOverview, needsYouCount } from './Board';
import { Software } from './Software';
import { Radar } from './Radar';
import { Revenue } from './Revenue';
import { Team } from './Team';
import { ToolsHub } from './ToolsHub';
import { SecondBrain } from './SecondBrain';
import { Processes } from './Processes';
import { Workspace, type SpaceId } from './Workspaces';
import { Connections } from './Connections';
import { Settings } from './Settings';
import { Bots } from './Bots';
import { Automations } from './Automations';
import { MailHub } from './MailHub';
import type { SettingsSection } from './settingsModel';
import { useWakeWord } from './wake';
import { startWorkshopIntake } from './workshop/useWorkshop';

export type View = 'chat' | 'bots' | 'automations' | 'board' | 'team' | 'space' | 'system' | 'software' | 'tools' | 'brain' | 'processes' | 'workspace' | 'radar' | 'revenue' | 'mailhub' | 'connections' | 'settings';

interface PaletteEntry { group: string; label: string; run: () => void }

export function App() {
  const narrow = useNarrow();
  const { snapshot, error, refresh } = useSnapshot();
  const overview = useTaskOverview();
  const [view, setView] = useState<View>('chat');
  const [placeholder, setPlaceholder] = useState<{ title: string; text: string } | null>(null);
  const [pop, setPop] = useState<null | 'spaces' | 'system' | 'palette'>(null);
  const [labels, setLabels] = useState<boolean>(() => { try { return localStorage.getItem('pandesh.v2.labels') !== '0'; } catch { return true; } });
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? 'system');
  const opener = useRef<HTMLElement | null>(null);
  const [variantForced, setVariantForced] = useState(false);
  useEffect(() => { api.getUiVariant().then((v) => setVariantForced(v.forcedByEnv)).catch(() => setVariantForced(false)); }, []);

  const needs = needsYouCount(overview.data?.tasks ?? [], snapshot);

  // The wake word listens on every view: a detection opens the chat and starts a voice turn there.
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [wakeTurn, setWakeTurn] = useState<{ id: number } | null>(null);
  const wake = useWakeWord({ snapshot, refresh, voiceBusy, onWake: () => { setWakeTurn({ id: Date.now() }); setView('chat'); setPop(null); } });

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
  const applyTheme = (next: 'system' | 'light' | 'dark') => {
    setTheme(next);
    if (next === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    try { if (next === 'system') localStorage.removeItem('pandesh.v2.theme'); else localStorage.setItem('pandesh.v2.theme', next); } catch { /* ignore */ }
  };
  const cycleTheme = () => applyTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark');
  const setLabelsTo = (on: boolean) => { setLabels(on); try { localStorage.setItem('pandesh.v2.labels', on ? '1' : '0'); } catch { /* ignore */ } };
  const [settingsSection, setSettingsSection] = useState<{ id: SettingsSection; n: number } | null>(null);
  const openSettings = (id: SettingsSection = 'models') => { setSettingsSection({ id, n: Date.now() }); go('settings'); };
  const showPlaceholder = (title: string, text: string) => { setPlaceholder({ title, text }); setView('space'); setPop(null); };
  const useClassic = async () => { try { await api.setUiVariant('classic'); } catch (err) { alert(errorText(err)); } };

  const [space, setSpace] = useState<SpaceId>('projects');
  const go = (v: View) => { setView(v); setPop(null); };
  const openSpace = (id: SpaceId) => { setSpace(id); go('workspace'); };
  // The seven places that are always in the sidebar, in the order a day uses them.
  const rail: Array<{ id: string; label: string; text: string; icon: IconName; current: boolean; onClick: () => void }> = [
    { id: 'chat', label: 'Chat — talk to Pandesh', text: 'Chat', icon: 'chat', current: view === 'chat', onClick: () => go('chat') },
    { id: 'bots', label: 'My Bots — assistants with their own job and memory', text: 'My Bots', icon: 'bots', current: view === 'bots', onClick: () => go('bots') },
    { id: 'automations', label: 'Automations — recurring work, next run and last result', text: 'Automations', icon: 'clock', current: view === 'automations', onClick: () => go('automations') },
    { id: 'projects', label: 'Projects — projects, repositories and tasks', text: 'Projects', icon: 'folder', current: view === 'workspace' && space === 'projects', onClick: () => openSpace('projects') },
    { id: 'connections', label: 'Connections — providers, Google, phone', text: 'Connections', icon: 'plug', current: view === 'connections', onClick: () => go('connections') },
    { id: 'tools', label: 'Tools & Skills — what Pandesh can do', text: 'Tools & Skills', icon: 'tools', current: view === 'tools', onClick: () => go('tools') },
    { id: 'settings', label: 'Settings — models, permissions, diagnostics, updates, appearance', text: 'Settings', icon: 'gear', current: view === 'settings', onClick: () => openSettings() },
  ];

  // Everything else stays one click away, out of the everyday sidebar.
  const spaces = [
    { name: needs ? `Board · ${needs} need you` : 'Board', sub: 'Every task and its real status', run: () => go('board') },
    { name: 'Team', sub: 'Specialist agents', run: () => go('team') },
    { name: 'Mail Hub', sub: 'Read-only Outlook mail: inbox, bills, recruiters, dates', run: () => go('mailhub') },
    { name: 'Second Brain', sub: 'Search your memories, notes and documents', run: () => go('brain') },
    { name: 'AI Radar', sub: 'New local-AI releases and advisories vs this PC', run: () => go('radar') },
    { name: 'Media Studio', sub: 'Local image studio and media Pandesh made', run: () => openSpace('media') },
    { name: 'Social Studio', sub: 'Drafts and your decisions (no publishing)', run: () => openSpace('social') },
    { name: 'Wish to Reality', sub: 'Goals and offers (feature-frozen)', run: () => openSpace('wish') },
    { name: 'Revenue', sub: 'Leads, offers, drafts awaiting you, verified results', run: () => go('revenue') },
    { name: 'Processes', sub: 'Diagnostics: what Pandesh started, checked against Windows now', run: () => go('processes') },
    { name: 'Software & Services', sub: 'Diagnostics: ports, installed tools, updates (read-only)', run: () => go('software') },
  ];
  // On a narrow window the bottom bar holds three places; the rest of the seven lead the More list.
  const narrowExtra = rail.slice(3).map((r) => ({ name: r.text, sub: r.label.split(' — ')[1] ?? '', run: r.onClick }));

  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  useEffect(() => { if (pop === 'palette') api.listConversations(false).then(setConversations).catch(() => setConversations([])); }, [pop]);
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  const [toolsTab, setToolsTab] = useState<{ tab: 'connectors'; n: number } | null>(null);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  // The Workshop lives beside the chat: a Workshop command that arrives while another view is showing brings the chat
  // back, where the Workshop carries it out and confirms what it really shows (like navigate_to).
  useEffect(() => startWorkshopIntake(() => { setPop(null); setView('chat'); }), []);

  // "Open in Pandesh" from the browser bridge: the single-instance handler focuses the window and sends this event with the task's
  // conversation id; the window opens exactly that conversation (the one holding the task's instruction, progress and result).
  useEffect(() => onDesktopEvent((e) => {
    if (e.eventType !== 'panda_bridge_open') return;
    const id = (e.text ?? '').trim();
    if (!/^[\w-]{1,80}$/.test(id)) return;
    setPop(null);
    setView('chat');
    void api.openConversation(id, true).then(() => setOpenConversationId(id)).catch(() => undefined);
  }), []);

  // navigate_to: the assistant asked this window to open a registered place. The app's own navigation does it, and the
  // window confirms only what it then really shows, so Pandesh never says "opened" when it was not. A running task is
  // not touched: only the view changes.
  useEffect(() => onDesktopEvent((e) => {
    const nav = e.navigation;
    if (e.kind !== 'navigate' || !nav) return;
    const action = nav.surface === 'v2' ? parseV2Target(nav.target) : { kind: 'unknown' as const, detail: 'this window shows the v2 interface' };
    if (action.kind === 'view') { if (action.toolsTab) setToolsTab({ tab: action.toolsTab, n: Date.now() }); if (action.view === 'mailhub' && action.screen) setMailScreen({ screen: action.screen, n: Date.now() }); setPop(null); setView(action.view); }
    else if (action.kind === 'space') { setSpace(action.space); setPop(null); setView('workspace'); }
    else if (action.kind === 'menu') setPop('spaces');
    else if (action.kind === 'focus') { setPop(null); setView('chat'); }
    // Confirm from what the window shows once it has re-rendered (checked for up to a second).
    const shows = (): boolean => {
      const shown = document.querySelector('.main')?.getAttribute('data-view');
      if (action.kind === 'view') return shown === action.view;
      if (action.kind === 'space') return shown === 'workspace';
      if (action.kind === 'menu') return Boolean(document.querySelector('[role="dialog"][aria-label="More"]'));
      if (action.kind === 'focus') { const el = document.getElementById(action.id); el?.focus(); return Boolean(el) && document.activeElement === el; }
      return false;
    };
    let tries = 0;
    const check = () => {
      const ok = action.kind !== 'unknown' && shows();
      if (!ok && action.kind !== 'unknown' && ++tries < 20) { setTimeout(check, 50); return; }
      const detail = action.kind === 'unknown' ? action.detail : ok ? undefined : 'the window did not switch';
      void api.confirmNavigation(nav.id, ok, detail, 'v2').catch(() => undefined);
    };
    setTimeout(check, 50);
  }), []);
  const [draft, setDraft] = useState<string | null>(null);
  const [mailScreen, setMailScreen] = useState<{ screen: string; n: number } | null>(null);

  const paletteEntries: PaletteEntry[] = useMemo(() => [
    { group: 'GO TO', label: 'Chat', run: () => go('chat') },
    { group: 'GO TO', label: 'My Bots', run: () => go('bots') },
    { group: 'GO TO', label: 'Automations', run: () => go('automations') },
    { group: 'GO TO', label: 'Projects', run: () => openSpace('projects') },
    { group: 'GO TO', label: 'Board', run: () => go('board') },
    { group: 'GO TO', label: 'Mail Hub', run: () => go('mailhub') },
    { group: 'GO TO', label: 'Software & Services', run: () => go('software') },
    { group: 'GO TO', label: 'AI Radar', run: () => go('radar') },
    { group: 'GO TO', label: 'Team', run: () => go('team') },
    { group: 'GO TO', label: 'Tools & Skills', run: () => go('tools') },
    { group: 'GO TO', label: 'Settings', run: () => openSettings() },
    { group: 'GO TO', label: 'Settings: Models and providers', run: () => openSettings('models') },
    { group: 'GO TO', label: 'Settings: Permissions (Ask, Auto, Plan only)', run: () => openSettings('permissions') },
    { group: 'GO TO', label: 'Settings: Diagnostics', run: () => openSettings('diagnostics') },
    { group: 'GO TO', label: 'Settings: Updates', run: () => openSettings('updates') },
    { group: 'GO TO', label: 'Connections (Google, phone, provider keys)', run: () => go('connections') },
    { group: 'GO TO', label: 'Second Brain', run: () => go('brain') },
    { group: 'GO TO', label: 'Processes', run: () => go('processes') },
    { group: 'ACTIONS', label: 'New chat', run: () => { void api.newConversation().then(refresh); setOpenConversationId(null); go('chat'); } },
    { group: 'ACTIONS', label: 'Change theme', run: cycleTheme },
    { group: 'ACTIONS', label: labels ? 'Hide navigation labels' : 'Show navigation labels', run: toggleLabels },
    ...conversations.slice(0, 12).map((c) => ({ group: 'RECENT CHATS', label: c.title || c.preview || 'Untitled chat', run: () => { setOpenConversationId(c.id); go('chat'); } })),
  ], [conversations, theme, labels]);

  const navButtons = (narrow ? rail.slice(0, 3) : rail).map((r) => (
    <button key={r.id} type="button" className="rail-btn" title={r.label} aria-label={r.label} aria-current={r.current ? 'page' : undefined} onClick={r.onClick}>
      <Icon name={r.icon} />
      {(labels || narrow) && <span className="label">{r.text}</span>}
    </button>
  ));
  const moreCurrent = ['mailhub', 'board', 'team', 'brain', 'radar', 'revenue', 'processes', 'software'].includes(view) || (view === 'workspace' && space !== 'projects');

  return (
    <div className={`app${narrow ? ' narrow' : ''}`}>
      {!narrow && (
        <nav className={`rail${labels ? ' labels' : ''}`} aria-label="Main">
          {navButtons}
          <div className="spacer" />
          <button type="button" className="rail-btn rail-more" title={needs ? `More — ${needs} task${needs === 1 ? '' : 's'} need you on the Board` : 'More — Board, Team, Second Brain, studios, diagnostics'} aria-label={needs ? `More, ${needs} need you` : 'More'} aria-expanded={pop === 'spaces'} aria-current={moreCurrent ? 'page' : undefined} onClick={() => openPop('spaces')}>
            <Icon name="more" />{labels && <span className="label">More</span>}
            {needs ? <span className="badge" aria-hidden="true">{needs}</span> : null}
          </button>
        </nav>
      )}

      <div className="main" data-view={view}>
        {view === 'chat' && <Chat snapshot={snapshot} snapshotError={error} refresh={refresh} narrow={narrow} openConversationId={openConversationId} onOpenPalette={() => openPop('palette')} onOpenBoard={() => go('board')} onOpenSettings={() => openSettings()} draft={draft} onDraftUsed={() => setDraft(null)}
          wake={wake} wakeTurn={wakeTurn} onWakeTurnTaken={() => setWakeTurn(null)} onVoiceBusy={setVoiceBusy} />}
        {view === 'bots' && <Bots onOpenConversation={(id) => { setOpenConversationId(id); go('chat'); }} onAskPandesh={(t) => { setDraft(t); go('chat'); }} />}
        {view === 'automations' && <Automations onOpenConversation={(id) => { setOpenConversationId(id); go('chat'); }} onOpenBot={() => go('bots')} />}
        {view === 'board' && <Board overview={overview} narrow={narrow} onOpenPalette={() => openPop('palette')} onOpenConversation={(id) => { setOpenConversationId(id); go('chat'); }} />}
        {view === 'software' && <Software narrow={narrow} />}
        {view === 'radar' && <Radar onOpenChat={() => { setOpenConversationId(null); refresh(); go('chat'); }} />}
        {view === 'revenue' && <Revenue />}
        {view === 'mailhub' && <MailHub narrow={narrow} initial={mailScreen} onAskPandesh={(t) => { setDraft(t); go('chat'); }} onOpenBots={() => go('bots')} onOpenAutomations={() => go('automations')} />}
        {view === 'tools' && <ToolsHub narrow={narrow} initialTab={toolsTab} onOpenView={go} />}
        {view === 'connections' && <Connections snapshot={snapshot} refresh={refresh} />}
        {view === 'settings' && <Settings snapshot={snapshot} refresh={refresh} narrow={narrow} initialSection={settingsSection?.id} theme={theme} setTheme={applyTheme} labels={labels} setLabels={setLabelsTo}
          variantForced={variantForced} onUseClassic={() => void useClassic()} onGo={(v) => go(v)} />}
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
          <div className="popover" role="dialog" aria-label="More" style={narrow ? { left: 16, right: 16, bottom: 8, width: 'auto', maxHeight: '70vh', overflow: 'auto' } : { left: labels ? 192 : 64, bottom: 16, maxHeight: '80vh', overflow: 'auto' }}>
            {narrow && <>{narrowExtra.map((s, i) => <button key={s.name} type="button" className="menu-item" autoFocus={i === 0} onClick={s.run}><span>{s.name}</span><span className="sub">{s.sub}</span></button>)}<h2>MORE</h2></>}
            {!narrow && <h2>MORE</h2>}
            {spaces.map((s, i) => <button key={s.name} type="button" className="menu-item" autoFocus={!narrow && i === 0} onClick={s.run}><span>{s.name}</span><span className="sub">{s.sub}</span></button>)}
          </div>
        )}
        {pop === 'palette' && <Palette entries={paletteEntries} onClose={closePop} />}
      </div>

      {narrow && (
        <nav className="bottom-bar" aria-label="Main">
          {navButtons}
          <button type="button" className="rail-btn" aria-label={needs ? `More, ${needs} need you` : 'More'} aria-expanded={pop === 'spaces'} onClick={() => openPop('spaces')}><Icon name="more" /><span className="label">{needs ? `More · ${needs}` : 'More'}</span></button>
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
