import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPS, BOARD_COLUMNS, homeCounts, isMissionStepConversation, placeOf, settingsTabOf, subLinks, workTabOf } from '../renderer-v2/src/placesModel';
import { parseV2Target } from '../renderer-v2/src/navigationTargets';
import { addNote, usabilityReport } from '../renderer-v2/src/usability';

describe('three places', () => {
  it('every view navigate_to can open belongs to Home, Work, Settings or is a specialist app', () => {
    const want: Record<string, string> = {
      chat: 'home', board: 'work', automations: 'work', bots: 'work',
      settings: 'settings', connections: 'settings', tools: 'settings', processes: 'settings', software: 'settings',
      team: 'app', brain: 'app', radar: 'app', revenue: 'app', mailhub: 'app',
    };
    for (const [view, place] of Object.entries(want)) {
      expect(parseV2Target(`view:${view}`).kind, view).toBe('view');
      expect(placeOf({ view }), view).toBe(place);
    }
    expect(placeOf({ view: 'workspace', space: 'projects' })).toBe('work');
    expect(placeOf({ view: 'workspace', space: 'wish' })).toBe('work');
    expect(placeOf({ view: 'workspace', space: 'media' })).toBe('app');
  });

  it('Work has four tabs and each existing page sits under exactly one', () => {
    expect(workTabOf({ view: 'board' })).toBe('active');
    expect(workTabOf({ view: 'board', boardShow: 'completed' })).toBe('completed');
    expect(workTabOf({ view: 'automations' })).toBe('scheduled');
    expect(workTabOf({ view: 'bots' })).toBe('scheduled');
    expect(workTabOf({ view: 'workspace', space: 'wish' })).toBe('projects');
    // The two halves of the board show every column once.
    expect([...BOARD_COLUMNS.active, ...BOARD_COLUMNS.completed].sort()).toEqual(['blocked', 'completed', 'failed', 'needs', 'queued', 'running']);
    expect(subLinks({ view: 'bots' }).map((s) => [s.label, s.current])).toEqual([['Automations', false], ['Bots', true]]);
    expect(subLinks({ view: 'board' })).toEqual([]);
  });

  it('Settings tabs cover connections, models, tools, permissions, appearance and a nested diagnostics area', () => {
    expect(settingsTabOf({ view: 'connections' })).toBe('connections');
    expect(settingsTabOf({ view: 'tools' })).toBe('tools');
    expect(settingsTabOf({ view: 'settings' })).toBe('models');
    expect(settingsTabOf({ view: 'settings', settingsSection: 'permissions' })).toBe('permissions');
    expect(settingsTabOf({ view: 'settings', settingsSection: 'appearance' })).toBe('appearance');
    for (const s of [{ view: 'settings', settingsSection: 'diagnostics' }, { view: 'settings', settingsSection: 'updates' }, { view: 'processes' }, { view: 'software' }]) {
      expect(settingsTabOf(s)).toBe('diagnostics');
      expect(subLinks(s).filter((x) => x.current)).toHaveLength(1);
    }
    expect(subLinks({ view: 'settings', settingsSection: 'models' })).toEqual([]);
  });

  it('every specialist page that left the sidebar is in the palette list, with a target the window can open', () => {
    expect(APPS.map((a) => a.label)).toEqual(['Mail Hub', 'AI Radar', 'Second Brain', 'Media Studio', 'Social Studio', 'Wish to Reality', 'Revenue', 'Team']);
    for (const a of APPS) expect(parseV2Target(a.key.includes(':') ? a.key : `view:${a.key}`).kind, a.label).not.toBe('unknown');
  });

  it('Home counts come from the board columns; only today counts as today', () => {
    const now = new Date(2026, 10, 23, 15, 0, 0);
    const at = (h: number, day = 23) => new Date(2026, 10, day, h).toISOString();
    const t = (status: string, extra: Record<string, unknown> = {}) => ({ status, live: true, interrupted: false, ...extra }) as never;
    const c = homeCounts([
      t('running'), t('queued'), t('running', { live: false }), t('paused'),
      t('completed', { completedAt: at(9) }), t('completed', { completedAt: at(9, 22) }), t('failed', { completedAt: at(11) }), t('waiting_for_approval'),
    ], 1, 1, now);
    expect(c).toEqual({ needsYou: 1, inProgress: 3, stuck: 2, doneToday: 1, failedToday: 1 });
  });
});

describe('daily-use notes', () => {
  it('keeps a note with where it was written, and reports notes and per-day counts as plain text', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    try {
      expect(addNote('work/board', '   ')).toEqual([]);
      const notes = addNote('work/board', ' looked for the backup automation under Projects ', new Date('2026-11-23T10:00:00Z'));
      expect(notes).toEqual([{ at: '2026-11-23T10:00:00.000Z', where: 'work/board', text: 'looked for the backup automation under Projects' }]);
      const report = usabilityReport(notes, { '2026-11-23': { home: 4, work: 2, palette: 1 } });
      expect(report).toMatch(/1 day\(s\) with use, 1 note\(s\)/);
      expect(report).toMatch(/2026-11-23: home 4, work 2, palette 1/);
      expect(report).toMatch(/\[work\/board\] looked for the backup automation/);
    } finally { delete (globalThis as { localStorage?: unknown }).localStorage; }
  });
});

describe('new chat after opening an earlier conversation', () => {
  // Live finding 2026-11-23: with an earlier conversation opened from the list, "+" started a new chat, the answer was
  // stored there, and the window then jumped back to the earlier conversation.
  it('the chat tells the shell, and the shell forgets the conversation it had opened', () => {
    const src = (name: string) => fs.readFileSync(path.join(__dirname, '../renderer-v2/src', name), 'utf8');
    expect(src('Chat.tsx')).toContain('api.newConversation().then(() => { onNewChat?.();');
    expect(src('App.tsx')).toContain('onNewChat={() => setOpenConversationId(null)}');
  });
});

describe('the Home conversation list', () => {
  it('leaves out the conversations Pandesh held with its own specialists for mission steps', () => {
    expect(isMissionStepConversation('Reviewer · Mission step 2 of 2 (run 5bg2a). Review the checklist')).toBe(true);
    expect(isMissionStepConversation('Skill Engineering · Mission step 2 of 4 (run 4if0q). Find or draft')).toBe(true);
    expect(isMissionStepConversation('Make me a short checklist for backing up my phone photos')).toBe(false);
    expect(isMissionStepConversation('What was mission step 2 of 2 about?')).toBe(false);
    expect(isMissionStepConversation('ChatGPT → Panda: Fix the typo')).toBe(false);
    expect(isMissionStepConversation(null)).toBe(false);
    const places = fs.readFileSync(path.join(__dirname, '../renderer-v2/src/Places.tsx'), 'utf8');
    expect(places).toContain('!isMissionStepConversation(c.title)');
  });
});
