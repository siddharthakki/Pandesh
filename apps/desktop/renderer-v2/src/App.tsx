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
import { HistoryPanel, HomeStatus, PlaceTabs, UsabilityDialog, useBrief } from './Places';
import { APPS, HISTORY_BESIDE_CHAT_MIN_WIDTH, homeCounts, isInternalConversation, placeOf, settingsTabOf, subLinks, workTabOf, type BoardShow, type SettingsTab, type WorkTab } from './placesModel';
import { countVisit } from './usability';

export type View = 'chat' | 'bots' | 'automations' | 'board' | 'team' | 'space' | 'system' | 'software' | 'tools' | 'brain' | 'processes' | 'workspace' | 'radar' | 'revenue' | 'mailhub' | 'connections' | 'settings';

interface PaletteEntry { group: string; label: string; /** Extra words the search also matches. */ words?: string; run: () => void }

export function App() {
  const narrow = useNarrow();
  // Too little room for the conversation list beside the chat (see HISTORY_BESIDE_CHAT_MIN_WIDTH).
  const tight = useNarrow(HISTORY_BESIDE_CHAT_MIN_WIDTH);
  const { snapshot, error, refresh } = useSnapshot();
  const overview = useTaskOverview();
  const [view, setView] = useState<View>('chat');
  const [placeholder, setPlaceholder] = useState<{ title: string; text: string } | null>(null);
  const [pop, setPop] = useState<null | 'palette' | 'feedback'>(null);
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

  const openPop = (name: 'palette' | 'feedback') => {
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
  const [boardShow, setBoardShow] = useState<BoardShow>('active');
  const [historyOpen, setHistoryOpen] = useState<boolean>(() => { try { return localStorage.getItem('pandesh.v2.history') !== '0'; } catch { return true; } });
  const showHistory = (on: boolean) => { setHistoryOpen(on); try { localStorage.setItem('pandesh.v2.history', on ? '1' : '0'); } catch { /* ignore */ } };
  const shown = { view, space, boardShow, settingsSection: settingsSection?.id ?? 'models' };
  const place = placeOf(shown);
  const openWork = (tab: WorkTab) => {
    try { localStorage.setItem('pandesh.v2.workTab', tab); } catch { /* ignore */ }
    if (tab === 'active' || tab === 'completed') { setBoardShow(tab); go('board'); }
    else if (tab === 'scheduled') go('automations');
    else openSpace('projects');
  };
  const openSettingsTab = (tab: SettingsTab) => {
    if (tab === 'connections') go('connections');
    else if (tab === 'tools') go('tools');
    else openSettings(tab);
  };
  // Work opens where it was left, so a person who lives in Scheduled or Projects gets there in one click; a waiting decision wins.
  const lastWorkTab = (): WorkTab => { try { const t = localStorage.getItem('pandesh.v2.workTab'); return t === 'completed' || t === 'scheduled' || t === 'projects' ? t : 'active'; } catch { return 'active'; } };
  /** Opens a page by the key the tab rows and the palette use: a view, `space:<id>` or `settings:<section>`. */
  const openKey = (key: string) => {
    const [kind, rest] = key.split(':');
    if (kind === 'space' && rest) openSpace(rest as SpaceId);
    else if (kind === 'settings' && rest) openSettings(rest as SettingsSection);
    else go(key as View);
  };
  // The three places that are always in the sidebar. Every other page is still here: under a tab, in the palette (Ctrl K), or by asking.
  const rail: Array<{ id: string; label: string; text: string; icon: IconName; current: boolean; badge?: number; onClick: () => void }> = [
    { id: 'home', label: 'Home — ask Pandesh and see what matters', text: 'Home', icon: 'chat', current: place === 'home', onClick: () => go('chat') },
    { id: 'work', label: needs ? `Work — ${needs} need you` : 'Work — everything Pandesh is doing', text: 'Work', icon: 'board', current: place === 'work', badge: needs, onClick: () => openWork(needs ? 'active' : lastWorkTab()) },
    { id: 'settings', label: 'Settings — connections, models, tools, permissions, diagnostics', text: 'Settings', icon: 'gear', current: place === 'settings', onClick: () => openSettings() },
  ];
  // Daily-use counts for the navigation trial (local to this window; see usability.ts).
  useEffect(() => { countVisit(place === 'app' ? (view === 'workspace' ? `app:${space}` : `app:${view}`) : place); }, [place, view, space]);
  useEffect(() => { if (pop === 'palette') countVisit('palette'); }, [pop]);

  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  useEffect(() => { if (pop === 'palette') api.listConversations(false).then(setConversations).catch(() => setConversations([])); }, [pop]);
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  const [toolsTab, setToolsTab] = useState<{ tab: 'connectors'; n: number } | null>(null);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  // The Workshop lives beside the chat: a Workshop command that arrives while another view is showing brings the chat
  // back, where the Workshop carries it out and confirms what it really shows (like navigate_to).
  useEffect(() => startWorkshopIntake(() => { setPop(null); setView('chat'); }), []);

  // navigate_to: the assistant asked this window to open a registered place. The app's own navigation does it, and the
  // window confirms only what it then really shows, so Pandesh never says "opened" when it was not. A running task is
  // not touched: only the view changes.
  useEffect(() => onDesktopEvent((e) => {
    const nav = e.navigation;
    if (e.kind !== 'navigate' || !nav) return;
    const action = nav.surface === 'v2' ? parseV2Target(nav.target) : { kind: 'unknown' as const, detail: 'this window shows the v2 interface' };
    if (action.kind === 'view' && action.view === 'board') setBoardShow('active');
    if (action.kind === 'view') { if (action.toolsTab) setToolsTab({ tab: action.toolsTab, n: Date.now() }); if (action.view === 'mailhub' && action.screen) setMailScreen({ screen: action.screen, n: Date.now() }); setPop(null); setView(action.view); }
    else if (action.kind === 'space') { setSpace(action.space); setPop(null); setView('workspace'); }
    else if (action.kind === 'menu') setPop('palette'); // the More menu is gone: the palette lists every page
    else if (action.kind === 'focus') { setPop(null); setView('chat'); }
    // Confirm from what the window shows once it has re-rendered (checked for up to a second).
    const shows = (): boolean => {
      const shown = document.querySelector('.main')?.getAttribute('data-view');
      if (action.kind === 'view') return shown === action.view;
      if (action.kind === 'space') return shown === 'workspace';
      if (action.kind === 'menu') return Boolean(document.querySelector('[role="dialog"][aria-label="Command palette"]'));
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
    { group: 'GO TO', label: 'Home (chat)', run: () => go('chat') },
    { group: 'WORK', label: 'Work: Active tasks (board)', run: () => openWork('active') },
    { group: 'WORK', label: 'Work: Completed tasks and results', run: () => openWork('completed') },
    { group: 'WORK', label: 'Work: Scheduled (automations)', run: () => openWork('scheduled') },
    { group: 'WORK', label: 'Work: My Bots', run: () => go('bots') },
    { group: 'WORK', label: 'Work: Projects', run: () => openWork('projects') },
    ...APPS.map((a) => ({ group: 'APPS', label: a.label, words: a.words, run: () => openKey(a.key) })),
    { group: 'SETTINGS', label: 'Settings: Connections (Google, phone, provider keys)', run: () => go('connections') },
    { group: 'SETTINGS', label: 'Settings: Models and providers', run: () => openSettings('models') },
    { group: 'SETTINGS', label: 'Settings: Tools & Skills', run: () => go('tools') },
    { group: 'SETTINGS', label: 'Settings: Permissions (Ask, Auto, Plan only)', run: () => openSettings('permissions') },
    { group: 'SETTINGS', label: 'Settings: Appearance', run: () => openSettings('appearance') },
    { group: 'SETTINGS', label: 'Settings: Diagnostics', run: () => openSettings('diagnostics') },
    { group: 'SETTINGS', label: 'Settings: Updates', run: () => openSettings('updates') },
    { group: 'SETTINGS', label: 'Diagnostics: Processes', run: () => go('processes') },
    { group: 'SETTINGS', label: 'Diagnostics: Software & Services', run: () => go('software') },
    { group: 'ACTIONS', label: 'New chat', run: () => { void api.newConversation().then(refresh); setOpenConversationId(null); go('chat'); } },
    { group: 'ACTIONS', label: 'Feedback: note something that was hard to find', run: () => openPop('feedback') },
    { group: 'ACTIONS', label: 'Change theme', run: cycleTheme },
    { group: 'ACTIONS', label: labels ? 'Hide navigation labels' : 'Show navigation labels', run: toggleLabels },
    ...conversations.filter((c) => !isInternalConversation(c.title)).slice(0, 12).map((c) => ({ group: 'RECENT CHATS', label: c.title || c.preview || 'Untitled chat', run: () => { setOpenConversationId(c.id); go('chat'); } })),
  ], [conversations, theme, labels]);

  const navButtons = rail.map((r) => (
    <button key={r.id} type="button" className="rail-btn" title={r.label} aria-label={r.label} aria-current={r.current ? 'page' : undefined} onClick={r.onClick}>
      <Icon name={r.icon} />
      {(labels || narrow) && <span className="label">{r.text}</span>}
      {r.badge ? <span className="badge" aria-hidden="true">{r.badge}</span> : null}
    </button>
  ));
  const searchButton = (
    <button type="button" className="rail-btn rail-more" title="Find any page, chat or action (Ctrl K)" aria-label="Search everything" aria-expanded={pop === 'palette'} onClick={() => openPop('palette')}>
      <Icon name="search" />{(labels || narrow) && <span className="label">Search</span>}
    </button>
  );
  const counts = overview.data ? homeCounts(overview.data.tasks ?? [], (overview.data.queued ?? []).length, needs) : null;
  const openChat = (id: string | null) => { setOpenConversationId(id); go('chat'); };
  const brief = useBrief(snapshot, refresh, () => openWork('active'), counts ? `${counts.needsYou}:${counts.inProgress}:${counts.stuck}:${counts.doneToday}:${counts.failedToday}` : '');

  return (
    <div className={`app${narrow ? ' narrow' : ''}`}>
      {!narrow && (
        <nav className={`rail${labels ? ' labels' : ''}`} aria-label="Main">
          {navButtons}
          <div className="spacer" />
          {searchButton}
        </nav>
      )}

      <div className="main" data-view={view} data-place={place}>
        <PlaceTabs place={place} workTab={workTabOf(shown)} settingsTab={settingsTabOf(shown)} subs={subLinks(shown)} needs={needs} onWorkTab={openWork} onSettingsTab={openSettingsTab} onSub={openKey} />
        {view === 'chat' && (
          <div className="home">
            {historyOpen && !tight && <HistoryPanel currentId={snapshot?.selectedConversationId ?? null} reloadKey={`${snapshot?.coreState}:${snapshot?.running}`} onOpen={(id) => openChat(id)} onClose={() => showHistory(false)} />}
            <div className="home-main">
              <HomeStatus counts={counts} loading={!overview.data && !overview.error} error={overview.error ?? null} brief={brief} onOpen={openWork} onNote={() => openPop('feedback')} />
              <Chat snapshot={snapshot} snapshotError={error} refresh={refresh} narrow={narrow} openConversationId={openConversationId} onOpenPalette={() => openPop('palette')} onOpenBoard={() => openWork('active')} onOpenSettings={() => openSettings()} draft={draft} onDraftUsed={() => setDraft(null)}
                briefInShell onNewChat={() => setOpenConversationId(null)} onToggleHistory={tight ? undefined : () => showHistory(!historyOpen)} historyOpen={historyOpen && !tight}
                wake={wake} wakeTurn={wakeTurn} onWakeTurnTaken={() => setWakeTurn(null)} onVoiceBusy={setVoiceBusy} />
            </div>
          </div>
        )}
        {view === 'bots' && <Bots onOpenConversation={(id) => { setOpenConversationId(id); go('chat'); }} onAskPandesh={(t) => { setDraft(t); go('chat'); }} />}
        {view === 'automations' && <Automations onOpenConversation={(id) => { setOpenConversationId(id); go('chat'); }} onOpenBot={() => go('bots')} />}
        {view === 'board' && <Board overview={overview} narrow={narrow} show={boardShow} onOpenPalette={() => openPop('palette')} onOpenConversation={(id) => { setOpenConversationId(id); go('chat'); }} />}
        {view === 'software' && <Software narrow={narrow} />}
        {view === 'radar' && <Radar onOpenChat={() => { setOpenConversationId(null); refresh(); go('chat'); }} />}
        {view === 'revenue' && <Revenue />}
        {view === 'mailhub' && <MailHub narrow={narrow} initial={mailScreen} onAskPandesh={(t) => { setDraft(t); go('chat'); }} onOpenBots={() => go('bots')} onOpenAutomations={() => go('automations')} />}
        {view === 'tools' && <ToolsHub narrow={narrow} initialTab={toolsTab} onOpenView={go} />}
        {view === 'connections' && <Connections snapshot={snapshot} refresh={refresh} />}
        {view === 'settings' && <Settings snapshot={snapshot} refresh={refresh} narrow={narrow} initialSection={settingsSection?.id} hideNav theme={theme} setTheme={applyTheme} labels={labels} setLabels={setLabelsTo}
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

        {pop === 'palette' && <Palette entries={paletteEntries} onClose={closePop} />}
        {pop === 'feedback' && <UsabilityDialog where={place === 'app' ? view : `${place}/${view}`} onClose={closePop} />}
      </div>

      {narrow && (
        <nav className="bottom-bar" aria-label="Main">
          {navButtons}
          {searchButton}
        </nav>
      )}
    </div>
  );
}

function Palette({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const shown = entries.filter((e) => `${e.label} ${e.words ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
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
