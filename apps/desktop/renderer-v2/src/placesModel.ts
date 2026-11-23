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
