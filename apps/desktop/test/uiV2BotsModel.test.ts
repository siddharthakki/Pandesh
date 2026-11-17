import { describe, expect, it } from 'vitest';
import {
  automationKind, botStatus, createProblem, credentialWords, permissionSummary, proposalRequest, runWords, scheduleWords, sortAutomations, validDailyTime,
  type Automation, type Bot, type BotRun,
} from '../renderer-v2/src/botsModel';

const bot = (over: Partial<Bot> = {}): Bot => ({
  id: 'bot_1', profile: 'pandeshpcmanager', name: 'PC Manager', responsibility: 'Watch this PC.', kind: 'pc', sources: ['pc_software'], model: 'gemma4:12b', status: 'active', settings: {}, conversationId: null,
  sourcesDetail: [{ id: 'pc_software', label: 'This PC', reads: 'Installed software', privateData: false, needsApproval: 'Installing or updating software' }], routines: [], lastRun: null, running: false, profileOk: true, profileProblem: null, ...over,
});
const hermes = { available: true, version: '0.22.4', reason: null };
const run = (over: Partial<BotRun> = {}): BotRun => ({ id: 'r', trigger: 'schedule', question: null, startedAt: '2026-11-17T08:00:00Z', finishedAt: '2026-11-17T08:01:00Z', status: 'completed', reason: 'Reported 2 new item(s).', report: 'x', proposals: [], notified: true, evidence: [], hermes: null, ...over });
const auto = (over: Partial<Automation> = {}): Automation => ({ id: 'a', title: 'A', purpose: null, enabled: true, dailyTime: '09:00', timezone: 'Europe/Berlin', nextRunAt: '2026-11-18T08:00:00Z', lastRunAt: null, routine: 'bot_routine', recurrence: null, owner: 'Pandesh Core scheduler', kind: 'bot', conversationId: null, bot: { id: 'bot_1', name: 'PC Manager', status: 'active' }, lastResult: null, ...over });

describe('My Bots: what a card says', () => {
  it('says the real state: cannot run, working, paused, ready, active', () => {
    expect(botStatus(bot(), { available: false, version: null, reason: 'Hermes is not installed on this PC' })).toEqual({ text: 'Cannot run: Hermes is not installed on this PC', tone: 'bad' });
    expect(botStatus(bot({ profileOk: false, profileProblem: 'its profile is not pinned to a local model' }), hermes).tone).toBe('bad');
    expect(botStatus(bot({ running: true }), hermes).text).toBe('Working now…');
    expect(botStatus(bot({ status: 'paused' }), hermes)).toEqual({ text: 'Paused', tone: 'warn' });
    expect(botStatus(bot(), hermes).text).toBe('Ready · no routine switched on');
    const on = bot({ routines: [{ id: 's', title: 't', purpose: null, enabled: true, dailyTime: '09:00', timezone: 'Europe/Berlin', nextRunAt: '2030-01-01T08:00:00Z', lastRunAt: null, recurrence: null }] });
    expect(botStatus(on, hermes)).toMatchObject({ tone: 'ok' });
    expect(botStatus(on, hermes).text).toMatch(/^Active · next run /);
  });

  it('words a run by what happened, never as done when it was not', () => {
    expect(runWords(null).text).toBe('Never run');
    expect(runWords(run()).tone).toBe('ok');
    expect(runWords(run({ status: 'failed', reason: 'Hermes is not available.' }))).toMatchObject({ tone: 'bad' });
    expect(runWords(run({ status: 'failed', reason: 'Hermes is not available.' })).text).toMatch(/failed: Hermes is not available\.$/);
    expect(runWords(run({ status: 'interrupted', reason: 'Pandesh stopped.' })).tone).toBe('warn');
    expect(runWords(run({ status: 'skipped', reason: 'The Bot is paused.' })).text).toMatch(/skipped: The Bot is paused\.$/);
  });

  it('describes a schedule and checks a time', () => {
    expect(scheduleWords({ dailyTime: '07:30', recurrence: null, enabled: true })).toBe('every day at 07:30');
    expect(scheduleWords({ dailyTime: '09:00', recurrence: { kind: 'interval_days', every: 2, anchor: '2026-11-17' }, enabled: false })).toBe('Off · every 2 days at 09:00');
    expect(scheduleWords({ dailyTime: '08:00', recurrence: { kind: 'weekly', weekdays: [1, 5] }, enabled: true })).toBe('Mon, Fri at 08:00');
    expect(validDailyTime('07:30')).toBe(true);
    expect(validDailyTime('7:30')).toBe(false);
    expect(validDailyTime('24:00')).toBe(false);
  });

  it('refuses an incomplete new Bot with a reason, and states what a Bot may read and what always asks', () => {
    expect(createProblem({ name: '', responsibility: 'x', sources: [] }, [])).toBe('Give the Bot a name.');
    expect(createProblem({ name: 'pc manager', responsibility: 'Watch this PC closely.', sources: ['pc_software'] }, [{ name: 'PC Manager' }])).toMatch(/already exists/);
    expect(createProblem({ name: 'New', responsibility: 'short', sources: ['pc_software'] }, [])).toMatch(/responsible for/);
    expect(createProblem({ name: 'New', responsibility: 'Watch this PC closely.', sources: [] }, [])).toMatch(/Tick at least one/);
    expect(createProblem({ name: 'New', responsibility: 'Watch this PC closely.', sources: ['pc_software'] }, [])).toBeNull();
    expect(permissionSummary(bot().sourcesDetail)).toEqual({ reads: ['This PC: Installed software'], asks: ['Installing or updating software'] });
    expect(proposalRequest('PC Manager', 'Update Git to 2.56')).toBe('PC Manager proposed this. Please do it, and ask me for approval where it changes anything: Update Git to 2.56');
  });
});

describe('Automations: one list, failures first', () => {
  it('puts a failed routine first, then what runs next, then what is paused', () => {
    const list = sortAutomations([
      auto({ id: 'off', title: 'Off', enabled: false, nextRunAt: null }),
      auto({ id: 'later', title: 'Later', nextRunAt: '2026-11-19T08:00:00Z' }),
      auto({ id: 'failed', title: 'Failed', lastResult: { status: 'failed', reason: 'Hermes is not available.', at: '2026-11-17T08:00:00Z' } }),
      auto({ id: 'soon', title: 'Soon', nextRunAt: '2026-11-18T05:00:00Z' }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['failed', 'soon', 'later', 'off']);
    expect(automationKind(auto())).toBe('Bot · PC Manager');
    expect(automationKind(auto({ kind: 'built_in', bot: null }))).toBe('Built into Pandesh');
    expect(automationKind(auto({ kind: 'instruction', bot: null }))).toBe('Your instruction');
  });
});

describe('Connections: a credential is described, never shown', () => {
  it('says where a key is kept and nothing of the key', () => {
    expect(credentialWords(false, null)).toBe('No key stored');
    expect(credentialWords(true, 'credential-manager')).toBe('Key stored in Windows Credential Manager');
    expect(credentialWords(true, 'legacy-encrypted-file')).toBe('Key stored in an older encrypted file on this PC');
  });
});
