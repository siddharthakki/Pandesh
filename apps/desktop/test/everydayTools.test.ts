import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEverydayIntent } from '../src/host/everydayToolsIntent';
import { EverydayReminderScheduler } from '../src/host/everydayReminderScheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('everyday tools intent parsing', () => {
  it('parses remember / find / relative remind phrases', () => {
    const now = Date.parse('2026-09-15T12:00:00.000Z');
    expect(parseEverydayIntent('Remember that my printer uses A4', now)).toEqual({
      kind: 'remember_note',
      body: 'my printer uses A4',
    });
    expect(parseEverydayIntent('What did I remember about printer', now)).toEqual({
      kind: 'find_notes',
      query: 'printer',
    });
    const remind = parseEverydayIntent('Remind me in two minutes to check the oven', now);
    expect(remind).toEqual({
      kind: 'create_reminder',
      title: 'check the oven',
      dueAt: new Date(now + 120_000).toISOString(),
      relativeLabel: '2 minutes',
    });
    const alt = parseEverydayIntent('Remind me to stretch in 5 minutes', now);
    expect(alt?.kind).toBe('create_reminder');
    if (alt?.kind === 'create_reminder') {
      expect(alt.title).toBe('stretch');
      expect(alt.relativeLabel).toBe('5 minutes');
    }
  });

  it('returns null for ordinary chat', () => {
    expect(parseEverydayIntent('Hello Jarvis, how are you?')).toBeNull();
  });

  it('parses add-to-queue phrases', () => {
    expect(parseEverydayIntent('Add to queue Remember that my printer uses A4')).toEqual({
      kind: 'queue_add',
      instruction: 'Remember that my printer uses A4',
    });
    expect(parseEverydayIntent('queue: Remind me in two minutes to check the oven')).toEqual({
      kind: 'queue_add',
      instruction: 'Remind me in two minutes to check the oven',
    });
  });
});

describe('everyday reminder scheduler', () => {
  it('fires notify and markNotified when due while open', async () => {
    vi.useFakeTimers();
    const notify = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const scheduler = new EverydayReminderScheduler({ notify, markNotified });
    const dueAt = new Date(Date.now() + 100).toISOString();
    scheduler.sync([{
      id: 'reminder_1',
      title: 'check the oven',
      dueAt,
      status: 'scheduled',
      notifiedAt: null,
    }]);
    await vi.advanceTimersByTimeAsync(150);
    expect(notify).toHaveBeenCalledTimes(1);
    const calls = notify.mock.calls as unknown as Array<[{ body?: string }]>;
    expect(calls[0]?.[0]?.body).toContain('check the oven');
    expect(markNotified).toHaveBeenCalledWith('reminder_1');
    scheduler.dispose();
  });
});

describe('everyday tool catalog', () => {
  it('separates available read-only PC health from the planned storage advisor', async () => {
    const { everydayToolCatalog } = await import('../src/host/everydayToolCatalog');
    const health = everydayToolCatalog().find((item) => item.id === 'pc-health');
    expect(health?.availability).toBe('available');
    const entry = everydayToolCatalog().find((item) => item.id === 'pc-health-storage');
    expect(entry).toEqual({
      id: 'pc-health-storage',
      label: 'Storage Advisor',
      availability: 'not_connected',
      detail: expect.stringMatching(/bounded storage scan/i),
    });
    expect(everydayToolCatalog().find((item) => item.id === 'web-research')?.availability).toBe('not_connected');
    expect(everydayToolCatalog().find((item) => item.id === 'image-generation-studio')?.availability).toBe(
      'available',
    );
  });

  it('defaults every Jarvis connector to not_connected when no live status is supplied (Core unreachable / offline snapshot)', async () => {
    const { everydayToolCatalog } = await import('../src/host/everydayToolCatalog');
    const catalog = everydayToolCatalog();
    for (const id of ['gmail', 'calendar', 'whatsapp', 'printer']) {
      const entry = catalog.find((item) => item.id === id);
      expect(entry?.availability).toBe('not_connected');
      expect(entry?.connectorState).toBeUndefined();
    }
  });

  it('never fabricates "available" for a connector that has not truthfully reported connected', async () => {
    const { everydayToolCatalog } = await import('../src/host/everydayToolCatalog');
    const now = new Date().toISOString();
    const catalog = everydayToolCatalog([
      { id: 'gmail', label: 'Gmail', state: 'not_configured', reason: 'Gmail credential is not configured', checkedAt: now, permissions: { read: false, draft: false, execute: false } },
      { id: 'google_calendar', label: 'Google Calendar', state: 'degraded', reason: 'rate limited', checkedAt: now, permissions: { read: true, draft: false, execute: false } },
      { id: 'whatsapp', label: 'WhatsApp', state: 'unavailable', reason: 'probe failed', checkedAt: now, permissions: { read: false, draft: false, execute: false } },
      { id: 'printer', label: 'Printer', state: 'connecting', reason: null, checkedAt: now, permissions: { read: false, draft: false, execute: false } },
    ]);
    expect(catalog.find((item) => item.id === 'gmail')?.availability).toBe('not_connected');
    expect(catalog.find((item) => item.id === 'calendar')?.availability).toBe('not_connected');
    expect(catalog.find((item) => item.id === 'whatsapp')?.availability).toBe('not_connected');
    expect(catalog.find((item) => item.id === 'printer')?.availability).toBe('not_connected');
  });

  it('reports available only once a connector truthfully reports connected, and carries its permissions', async () => {
    const { everydayToolCatalog } = await import('../src/host/everydayToolCatalog');
    const now = new Date().toISOString();
    const catalog = everydayToolCatalog([
      { id: 'gmail', label: 'Gmail', state: 'connected', reason: null, checkedAt: now, permissions: { read: true, draft: true, execute: false } },
    ]);
    const gmail = catalog.find((item) => item.id === 'gmail');
    expect(gmail?.availability).toBe('available');
    expect(gmail?.connectorState).toBe('connected');
    expect(gmail?.permissions).toEqual({ read: true, draft: true, execute: false });
  });
});

describe('Jarvis Tools UI entry', () => {
  it('includes Tools tab and proof phrases in the control-center HTML', () => {
    const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
    expect(html).toContain('data-tab="tab-tools"');
    expect(html).toContain('id="tab-tools"');
    expect(html).toContain('id="tools-catalog"');
    expect(html).toContain('id="today-due-list"');
    expect(html).toContain('id="queue-confirm"');
    expect(html).toContain('id="queue-waiting"');
    expect(html).toContain('id="research-query"');
    expect(html).toContain('id="research-approval"');
    expect(html).toContain('id="tools-health-cpu"');
    expect(html).toMatch(/Approval before access/);
    expect(html).toMatch(/Remember that my printer uses A4/);
    expect(html).toMatch(/Remind me in two minutes to check the oven/);
    expect(html).toMatch(/Add to queue/);
  });
});
