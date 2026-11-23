/**
 * The three places of the v2 window: Home (ask and see what matters), Work (everything Pandesh is doing) and Settings (what it can
 * access). The existing views are unchanged underneath; this file only decides which place and which tab a view belongs to, so the
 * sidebar, the tab bars and navigate_to agree. Pure: no React, no IPC.
 */
import { columnOf, type BoardTask } from './boardModel';

export type Place = 'home' | 'work' | 'settings' | 'app';
export type WorkTab = 'active' | 'completed' | 'scheduled' | 'projects';
export type SettingsTab = 'connections' | 'models' | 'tools' | 'permissions' | 'appearance' | 'diagnostics';
export type BoardShow = 'active' | 'completed';

/** What the shell knows about what is on screen (App's own state, not a second store). */
export interface Shown { view: string; space?: string; boardShow?: BoardShow; settingsSection?: string }

const WORK_VIEWS: ReadonlySet<string> = new Set(['board', 'automations', 'bots']);
const WORK_SPACES: ReadonlySet<string> = new Set(['projects', 'wish']);
const SETTINGS_VIEWS: ReadonlySet<string> = new Set(['settings', 'connections', 'tools', 'processes', 'software']);

export function placeOf(s: Shown): Place {
  if (s.view === 'chat') return 'home';
  if (WORK_VIEWS.has(s.view) || (s.view === 'workspace' && WORK_SPACES.has(s.space ?? ''))) return 'work';
  if (SETTINGS_VIEWS.has(s.view)) return 'settings';
  return 'app';
}

export const WORK_TABS: ReadonlyArray<{ id: WorkTab; label: string; hint: string }> = [
  { id: 'active', label: 'Active', hint: 'Needs you, running, queued or stuck' },
  { id: 'completed', label: 'Completed', hint: 'Finished, failed or stopped, with the result' },
  { id: 'scheduled', label: 'Scheduled', hint: 'Recurring work and the assistants that run it' },
  { id: 'projects', label: 'Projects', hint: 'Projects, repositories and goals' },
];

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; hint: string }> = [
  { id: 'connections', label: 'Connections', hint: 'Providers, Google, phone' },
  { id: 'models', label: 'Models', hint: 'Which model answers' },
  { id: 'tools', label: 'Tools', hint: 'What Pandesh can do, and what each tool may do' },
  { id: 'permissions', label: 'Permissions', hint: 'Ask, Auto or Plan only' },
  { id: 'appearance', label: 'Appearance', hint: 'Theme and labels' },
  { id: 'diagnostics', label: 'Diagnostics', hint: 'Status, updates, processes, software' },
];

export function workTabOf(s: Shown): WorkTab {
  if (s.view === 'board') return s.boardShow === 'completed' ? 'completed' : 'active';
  if (s.view === 'workspace') return 'projects';
  return 'scheduled';
}

export function settingsTabOf(s: Shown): SettingsTab {
  if (s.view === 'connections') return 'connections';
  if (s.view === 'tools') return 'tools';
  if (s.view === 'processes' || s.view === 'software') return 'diagnostics';
  const sec = s.settingsSection ?? 'models';
  if (sec === 'permissions' || sec === 'appearance') return sec;
  return sec === 'diagnostics' || sec === 'updates' ? 'diagnostics' : 'models';
}

/** The second row under a tab: the few pages that share it. `key` is what the shell opens. */
export interface SubLink { key: string; label: string; current: boolean }
export function subLinks(s: Shown): SubLink[] {
  const place = placeOf(s);
  if (place === 'work') {
    const tab = workTabOf(s);
    if (tab === 'scheduled') return [
      { key: 'automations', label: 'Automations', current: s.view === 'automations' },
      { key: 'bots', label: 'Bots', current: s.view === 'bots' },
    ];
    if (tab === 'projects') return [
      { key: 'space:projects', label: 'Projects', current: s.space === 'projects' },
      { key: 'space:wish', label: 'Goals', current: s.space === 'wish' },
    ];
    return [];
  }
  if (place === 'settings' && settingsTabOf(s) === 'diagnostics') return [
    { key: 'settings:diagnostics', label: 'Status', current: s.view === 'settings' && s.settingsSection === 'diagnostics' },
    { key: 'settings:updates', label: 'Updates', current: s.view === 'settings' && s.settingsSection === 'updates' },
    { key: 'processes', label: 'Processes', current: s.view === 'processes' },
    { key: 'software', label: 'Software & Services', current: s.view === 'software' },
  ];
  return [];
}

/** Which board columns each Work tab shows. */
export const BOARD_COLUMNS: Record<BoardShow, ReadonlyArray<string>> = {
  active: ['needs', 'running', 'queued', 'blocked'],
  completed: ['completed', 'failed'],
};

export interface HomeCounts { needsYou: number; inProgress: number; stuck: number; doneToday: number; failedToday: number }
type CountTask = BoardTask & { completedAt?: string | null };

/** Home's one-line status, from the same Core task records the Work board shows. `needsYou` is the board's own count. */
export function homeCounts(tasks: CountTask[], queuedCommands: number, needsYou: number, now: Date = new Date()): HomeCounts {
  const today = (iso: string | null | undefined): boolean => {
    if (!iso) return false;
    const d = new Date(iso);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  };
  let inProgress = queuedCommands; let stuck = 0; let doneToday = 0; let failedToday = 0;
  for (const t of tasks) {
    const c = columnOf(t);
    if (c === 'running' || c === 'queued') inProgress++;
    else if (c === 'blocked') stuck++;
    else if (c === 'completed' && today(t.completedAt)) doneToday++;
    else if (c === 'failed' && today(t.completedAt)) failedToday++;
  }
  return { needsYou, inProgress, stuck, doneToday, failedToday };
}

/** Every specialist page that left the sidebar, for the command palette. `key` is what the shell opens. */
export const APPS: ReadonlyArray<{ key: string; label: string; words: string }> = [
  { key: 'mailhub', label: 'Mail Hub', words: 'email outlook inbox bills' },
  { key: 'radar', label: 'AI Radar', words: 'releases advisories models news' },
  { key: 'brain', label: 'Second Brain', words: 'memory notes documents search' },
  { key: 'space:media', label: 'Media Studio', words: 'images pictures video' },
  { key: 'space:social', label: 'Social Studio', words: 'posts drafts' },
  { key: 'space:wish', label: 'Wish to Reality', words: 'goals offers wishes' },
  { key: 'revenue', label: 'Revenue', words: 'leads offers money' },
  { key: 'team', label: 'Team', words: 'agents specialists' },
];

/**
 * A conversation Pandesh held with one of its own specialists while carrying out a mission step ("Reviewer · Mission step 2 of 2
 * (run 5bg2a). …"). Core titles them this way (missionRunner); the person never typed them, so the Home list leaves them out
 * unless the person searches. Their results are reachable from the mission's own conversation and from Work.
 */
/**
 * A task ChatGPT sent through the Panda connector. Core creates its conversation with exactly this title prefix
 * (core/domain/pandaBridge.ts); it is the transcript of that task, not a chat the person held in this window.
 * LIMITATION: the conversation list carries no origin field, so this is recognised by the title. Only the exact prefix at the
 * start counts, so a chat that merely mentions ChatGPT or Panda stays in the list.
 */
export function isConnectorConversation(title: string | null | undefined): boolean {
  return (title ?? '').startsWith('ChatGPT → Panda: ');
}
/** Execution transcripts (mission steps, connector tasks): out of the default Home list, still found by its search. Never deleted. */
export function isInternalConversation(title: string | null | undefined): boolean {
  return isMissionStepConversation(title) || isConnectorConversation(title);
}

/**
 * Which of Core's home brief items ask something of the person. Core's brief also carries a running task and a recent result
 * (assistantBrief.ts buildAssistantHomeItems) to show progress; those are not requests. Only a pending approval and a task that
 * failed or was interrupted are.
 */
export function asksThePerson(kind: string): boolean {
  return kind === 'approval' || kind === 'task_failed' || kind === 'task_interrupted';
}
/**
 * The number on Home's "needs you" chip. Core's brief shows at most one approval, so when the board knows of more tasks waiting
 * for a decision, the larger number counts. A running or finished task never adds to it.
 */
export function needsYouTotal(briefKinds: string[], boardNeeds: number): number {
  const asking = briefKinds.filter(asksThePerson);
  const approvals = asking.filter((k) => k === 'approval').length;
  return (asking.length - approvals) + Math.max(approvals, boardNeeds);
}

/**
 * Below this window width the conversation list is not placed beside the chat: with the Activity panel open the chat column
 * was left about 250 px wide (seen live at the default 1086 px window). The list is then reached from the chat's button, which
 * opens the search with recent chats.
 */
export const HISTORY_BESIDE_CHAT_MIN_WIDTH = 1200;

export function isMissionStepConversation(title: string | null | undefined): boolean {
  return /^.{1,60} · Mission step \d+ of \d+ \(run [a-z0-9]+\)/.test(title ?? '');
}
