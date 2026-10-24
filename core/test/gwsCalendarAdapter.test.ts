/**
 * Calendar over the pinned `gws` transport: validation, conflict checks,
 * verified writes, stale-version refusal, and the full governed flow
 * (permission tier -> exact-event approval -> execute -> verified result).
 * `runGwsFn` is a stateful fake of Google Calendar, so nothing here spawns a
 * process or touches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchConnectorAction } from '../domain/connectorDispatch';
import { resolveCapabilityApproval } from '../domain/capabilityDispatch';
import { setConnectorPermission } from '../domain/connectors';
import { listApprovalsForAttempt } from '../domain/approvals';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { buildConnectorAdapters, CONNECTOR_CREDENTIAL_ENV } from '../runtime/connectors/connectorDefinitions';
import {
  createGwsCalendarExecutor,
  createGwsCalendarPrepare,
  createGwsCalendarProbe,
  parseWhen,
  suggestMeetingSlots,
  type GwsCalendarAdapterConfig,
} from '../runtime/connectors/gwsCalendarAdapter';
import { setGmailAccessToken, clearGmailAccessToken, googleScopeGranted, getGmailAccountEmail, getGmailAccessToken } from '../runtime/connectors/gmailAccessTokenStore';
import type { RunGwsResult } from '../runtime/connectors/gwsTransport';
import type { ToolExecutionContext } from '../runtime/toolRunner';
import type { ApprovalRecord } from '../shared/wireTypes';

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TZ = 'Europe/Berlin';

let dir: string;
let binaryPath: string;
let ctx: ToolExecutionContext;
let hasScope: boolean;
let token: string | null;

interface FakeEvent {
  id: string; etag: string; status: string; summary: string; location?: string; description?: string;
  start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string }>; htmlLink: string;
}

/** Minimal stateful Google Calendar: enough fidelity to prove verification, etags and error shapes. */
function fakeCalendar(opts: { dropTitleOnInsert?: boolean; ignoreDelete?: boolean } = {}) {
  const events = new Map<string, FakeEvent>();
  const calls: Array<{ method: string; params: Record<string, unknown>; body?: Record<string, unknown> }> = [];
  let n = 0;
  const withOffset = (w: { dateTime?: string; date?: string; timeZone?: string }) => {
    if (w.date) return { date: w.date };
    const dt = w.dateTime ?? '';
    return { dateTime: /(?:Z|[+-]\d{2}:?\d{2})$/.test(dt) ? dt : `${dt}+01:00` };
  };
  const ok = (data: unknown): RunGwsResult => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: '', timedOut: false, aborted: false });
  const err = (code: number, reason: string): RunGwsResult => ({ exitCode: 1, stdout: JSON.stringify({ error: { code, message: reason, reason } }), stderr: '', timedOut: false, aborted: false });
  const run = async (input: { args: string[] }): Promise<RunGwsResult> => {
    const [svc, res, method] = input.args;
    if (svc !== 'calendar' || res !== 'events') return err(400, 'not allowlisted in this fake');
    const pIdx = input.args.indexOf('--params');
    const bIdx = input.args.indexOf('--json');
    const params = pIdx >= 0 ? JSON.parse(input.args[pIdx + 1]) : {};
    const body = bIdx >= 0 ? JSON.parse(input.args[bIdx + 1]) : undefined;
    calls.push({ method, params, body });
    if (method === 'insert') {
      n += 1;
      const ev: FakeEvent = {
        id: `ev${n}`, etag: `"e${n}"`, status: 'confirmed', summary: opts.dropTitleOnInsert ? 'Something else' : String(body?.summary ?? ''),
        location: body?.location as string | undefined, description: body?.description as string | undefined,
        start: withOffset(body?.start as never), end: withOffset(body?.end as never),
        attendees: body?.attendees as Array<{ email: string }> | undefined, htmlLink: `https://calendar.example/ev${n}`,
      };
      events.set(ev.id, ev);
      return ok(ev);
    }
    if (method === 'get') {
      const ev = events.get(String(params.eventId));
      return ev ? ok(ev) : err(404, 'notFound');
    }
    if (method === 'patch') {
      const ev = events.get(String(params.eventId));
      if (!ev) return err(404, 'notFound');
      const next = { ...ev, etag: `"e${++n}"` } as FakeEvent;
      if (body?.summary !== undefined) next.summary = String(body.summary);
      if (body?.location !== undefined) next.location = String(body.location);
      if (body?.start) next.start = withOffset(body.start as never);
      if (body?.end) next.end = withOffset(body.end as never);
      if (body?.attendees) next.attendees = body.attendees as Array<{ email: string }>;
      events.set(ev.id, next);
      return ok(next);
    }
    if (method === 'delete') {
      if (!opts.ignoreDelete) events.delete(String(params.eventId));
      return ok({});
    }
    if (method === 'list') {
      const min = Date.parse(String(params.timeMin));
      const max = Date.parse(String(params.timeMax ?? '9999-01-01T00:00:00Z'));
      const items = [...events.values()].filter((e) => {
        const s = Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00Z`);
        const en = Date.parse(e.end.dateTime ?? `${e.end.date}T00:00:00Z`);
        return s < max && en > min;
      });
      return ok({ items });
    }
    return err(400, 'unsupported');
  };
  return { events, calls, run: run as unknown as GwsCalendarAdapterConfig['runGwsFn'] };
}

function config(fake: ReturnType<typeof fakeCalendar>, extra: Partial<GwsCalendarAdapterConfig> = {}): GwsCalendarAdapterConfig {
  return {
    getAccessToken: () => token,
    getAccountEmail: () => (token ? 'me@example.com' : null),
    hasCalendarScope: () => hasScope,
    configDir: path.join(dir, 'config'),
    binaryPath,
    expectedSha256: crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'),
    timeZone: () => TZ,
    runGwsFn: fake.run,
    now: () => Date.parse('2026-11-01T09:00:00Z'),
    ...extra,
  };
}

const parse = (r: { output: string }) => JSON.parse(r.output) as Record<string, any>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-calendar-'));
  binaryPath = path.join(dir, 'fake-gws.exe');
  fs.writeFileSync(binaryPath, 'pinned-for-test');
  ctx = { cwd: dir, signal: new AbortController().signal };
  hasScope = true;
  token = 'access-token';
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('calendar time parsing', () => {
  it('accepts dates, local times and offset times, and rejects everything else', () => {
    expect(parseWhen('2026-11-03', TZ, 'start')).toEqual({ ok: true, when: { date: '2026-11-03' } });
    expect(parseWhen('2026-11-03T14:00', TZ, 'start')).toEqual({ ok: true, when: { dateTime: '2026-11-03T14:00:00', timeZone: TZ } });
    expect(parseWhen('2026-11-03T14:00:00+01:00', TZ, 'start')).toEqual({ ok: true, when: { dateTime: '2026-11-03T14:00:00+01:00' } });
    expect(parseWhen('next friday', TZ, 'start').ok).toBe(false);
    expect(parseWhen('2026-02-31', TZ, 'start').ok).toBe(false);
    expect(parseWhen('', TZ, 'start')).toEqual({ ok: false, reason: '"start" is required' });
  });
});

describe('calendar probe: only a real read against Google counts', () => {
  it('fails closed without a token, without the granted scope, and without the helper', async () => {
    const fake = fakeCalendar();
    token = null;
    expect(await createGwsCalendarProbe(config(fake))(new AbortController().signal)).toMatchObject({ ok: false, reason: expect.stringContaining('no Google access token') });
    token = 'x'; hasScope = false;
    expect(await createGwsCalendarProbe(config(fake))(new AbortController().signal)).toMatchObject({ ok: false, reason: expect.stringContaining('Calendar access') });
    hasScope = true;
    expect(await createGwsCalendarProbe(config(fake, { binaryPath: path.join(dir, 'missing.exe') }))(new AbortController().signal)).toMatchObject({ ok: false });
    expect(fake.calls).toHaveLength(0);
  });

  it('is ok only when events.list succeeds, and surfaces Google\'s own error otherwise', async () => {
    const fake = fakeCalendar();
    expect(await createGwsCalendarProbe(config(fake))(new AbortController().signal)).toEqual({ ok: true });
    expect(fake.calls[0].method).toBe('list');
    const failing = createGwsCalendarProbe(config(fake, { runGwsFn: (async () => ({ exitCode: 1, stdout: JSON.stringify({ error: { code: 403, reason: 'accessNotConfigured', message: 'Calendar API has not been used in project 1' } }), stderr: '', timedOut: false, aborted: false })) as never }));
    const result = await failing(new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('accessNotConfigured');
  });
});

describe('calendar tools', () => {
  it('lists events in a window without leaking etags', async () => {
    const fake = fakeCalendar();
    const exec = createGwsCalendarExecutor(config(fake));
    await exec('calendar_create_event', { title: 'Standup', start: '2026-11-03T09:00', end: '2026-11-03T09:15' }, ctx);
    const listed = parse(await exec('calendar_list_events', { from: '2026-11-03', to: '2026-11-04' }, ctx));
    expect(listed.count).toBe(1);
    expect(listed.events[0]).toMatchObject({ title: 'Standup', allDay: false });
    expect(JSON.stringify(listed)).not.toContain('etag');
    expect(listed.timeZone).toBe(TZ);
  });

  it('draft reports clashes and creates nothing', async () => {
    const fake = fakeCalendar();
    const exec = createGwsCalendarExecutor(config(fake));
    await exec('calendar_create_event', { title: 'Dentist', start: '2026-11-03T14:00', end: '2026-11-03T15:00' }, ctx);
    const before = fake.events.size;
    const draft = parse(await exec('calendar_draft_event', { title: 'Lunch', start: '2026-11-03T14:30', end: '2026-11-03T15:30' }, ctx));
    expect(draft.conflicts.map((c: any) => c.title)).toEqual(['Dentist']);
    const free = parse(await exec('calendar_draft_event', { title: 'Lunch', start: '2026-11-03T16:00', end: '2026-11-03T17:00' }, ctx));
    expect(free.conflicts).toEqual([]);
    expect(fake.events.size).toBe(before);
  });

  it('create re-reads the event and reports it as verified, inviting only listed attendees', async () => {
    const fake = fakeCalendar();
    const exec = createGwsCalendarExecutor(config(fake));
    const result = await exec('calendar_create_event', { title: 'Planning', start: '2026-11-03T10:00', end: '2026-11-03T11:00', attendees: ['Bob@Example.com'], location: 'Room 4' }, ctx);
    expect(result.status).toBe('succeeded');
    const out = parse(result);
    expect(out.verified).toBe(true);
    expect(out.event).toMatchObject({ title: 'Planning', location: 'Room 4', attendees: ['bob@example.com'] });
    const insert = fake.calls.find((c) => c.method === 'insert')!;
    expect(insert.params).toMatchObject({ calendarId: 'primary', sendUpdates: 'all' });
    expect(fake.calls.some((c) => c.method === 'get')).toBe(true);
  });

  it('create without attendees sends no invitations', async () => {
    const fake = fakeCalendar();
    await createGwsCalendarExecutor(config(fake))('calendar_create_event', { title: 'Focus', start: '2026-11-03', }, ctx);
    expect(fake.calls.find((c) => c.method === 'insert')!.params.sendUpdates).toBe('none');
    expect([...fake.events.values()][0].end).toEqual({ date: '2026-11-04' }); // all-day defaults to one day
  });

  it('rejects bad input before calling Google', async () => {
    const fake = fakeCalendar();
    const exec = createGwsCalendarExecutor(config(fake));
    for (const args of [
      { title: 'x', start: '2026-11-03T15:00', end: '2026-11-03T14:00' },
      { title: 'x', start: '2026-11-03T15:00', end: '2026-11-03T16:00', attendees: ['not-an-email'] },
      { start: '2026-11-03T15:00', end: '2026-11-03T16:00' },
      { title: 'x', start: 'tomorrow-ish', end: '2026-11-03T16:00' },
      { title: 'x', start: '2026-11-03', end: '2026-11-03T16:00' },
    ]) {
      const result = await exec('calendar_create_event', args, ctx);
      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('gws_invalid_arguments');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('never claims success when the calendar does not contain what was asked', async () => {
    const fake = fakeCalendar({ dropTitleOnInsert: true });
    const result = await createGwsCalendarExecutor(config(fake))('calendar_create_event', { title: 'Real title', start: '2026-11-03T10:00', end: '2026-11-03T11:00' }, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('calendar_create_unverified');
    expect(result.output).toContain('NOT verified');
  });

  it('update and delete refuse to run without an approved event version', async () => {
    const fake = fakeCalendar();
    const exec = createGwsCalendarExecutor(config(fake));
    await exec('calendar_create_event', { title: 'A', start: '2026-11-03T10:00', end: '2026-11-03T11:00' }, ctx);
    expect((await exec('calendar_update_event', { eventId: 'ev1', title: 'B' }, ctx)).resultCategory).toBe('calendar_event_unapproved');
    expect((await exec('calendar_delete_event', { eventId: 'ev1' }, ctx)).resultCategory).toBe('calendar_event_unapproved');
    expect(fake.events.get('ev1')!.summary).toBe('A');
  });

  it('update and delete refuse when the event changed after approval', async () => {
    const fake = fakeCalendar();
    const exec = createGwsCalendarExecutor(config(fake));
    await exec('calendar_create_event', { title: 'A', start: '2026-11-03T10:00', end: '2026-11-03T11:00' }, ctx);
    const stale = '"e-old"';
    const upd = await exec('calendar_update_event', { eventId: 'ev1', expectedEtag: stale, title: 'B' }, ctx);
    expect(upd.resultCategory).toBe('calendar_update_stale');
    const del = await exec('calendar_delete_event', { eventId: 'ev1', expectedEtag: stale }, ctx);
    expect(del.resultCategory).toBe('calendar_delete_stale');
    expect(fake.events.get('ev1')!.summary).toBe('A');
  });

  it('update changes only what was asked and is verified; delete is verified gone', async () => {
    const fake = fakeCalendar();
    const exec = createGwsCalendarExecutor(config(fake));
    await exec('calendar_create_event', { title: 'A', start: '2026-11-03T10:00', end: '2026-11-03T11:00', location: 'Here' }, ctx);
    const etag = fake.events.get('ev1')!.etag;
    const upd = await exec('calendar_update_event', { eventId: 'ev1', expectedEtag: etag, start: '2026-11-03T12:00', end: '2026-11-03T13:00' }, ctx);
    expect(upd.status).toBe('succeeded');
    expect(parse(upd).event).toMatchObject({ title: 'A', location: 'Here', start: '2026-11-03T12:00:00+01:00' });
    expect((await exec('calendar_update_event', { eventId: 'ev1', expectedEtag: fake.events.get('ev1')!.etag, start: '2026-11-03T12:00' }, ctx)).status).toBe('failed'); // time needs both ends
    const del = await exec('calendar_delete_event', { eventId: 'ev1', expectedEtag: fake.events.get('ev1')!.etag }, ctx);
    expect(del.status).toBe('succeeded');
    expect(parse(del)).toMatchObject({ verified: true, deletedEvent: { id: 'ev1', title: 'A' } });
    expect(fake.events.size).toBe(0);
  });

  it('delete that Google accepted but did not apply is reported as not verified', async () => {
    const fake = fakeCalendar({ ignoreDelete: true });
    const exec = createGwsCalendarExecutor(config(fake));
    await exec('calendar_create_event', { title: 'A', start: '2026-11-03T10:00', end: '2026-11-03T11:00' }, ctx);
    const result = await exec('calendar_delete_event', { eventId: 'ev1', expectedEtag: fake.events.get('ev1')!.etag }, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('calendar_delete_unverified');
  });

  it('fails closed when not connected, when Calendar was not granted, and for unknown tools', async () => {
    const fake = fakeCalendar();
    hasScope = false;
    expect((await createGwsCalendarExecutor(config(fake))('calendar_list_events', {}, ctx)).resultCategory).toBe('calendar_scope_missing');
    hasScope = true; token = null;
    expect((await createGwsCalendarExecutor(config(fake))('calendar_list_events', {}, ctx)).resultCategory).toBe('connector_not_configured');
    token = 'x';
    expect((await createGwsCalendarExecutor(config(fake))('calendar_share_calendar', {}, ctx)).resultCategory).toBe('gws_not_allowlisted');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('calendar approval preparation', () => {
  it('create: shows the exact event and any overlap, in plain language', async () => {
    const fake = fakeCalendar();
    const exec = createGwsCalendarExecutor(config(fake));
    await exec('calendar_create_event', { title: 'Dentist', start: '2026-11-03T14:00', end: '2026-11-03T15:00' }, ctx);
    const prepared = await createGwsCalendarPrepare(config(fake))('calendar_create_event', { title: 'Lunch with Bob', start: '2026-11-03T14:30', end: '2026-11-03T15:30', attendees: ['bob@example.com'] });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const card = String(prepared.presentation?.cardText);
    expect(card).toContain('Lunch with Bob');
    expect(card).toContain('Tue, 3 Nov 2026');
    expect(card).toContain('14:30–15:30');
    expect(card).toContain('bob@example.com');
    expect(card).toContain('email invitations');
    expect(card).toContain('Dentist');
    expect(prepared.arguments).toMatchObject({ title: 'Lunch with Bob', timeZone: TZ });
  });

  it('update/delete: bind the live etag, show current event + change, and refuse unknown or deleted events', async () => {
    const fake = fakeCalendar();
    const cfg = config(fake);
    const exec = createGwsCalendarExecutor(cfg);
    await exec('calendar_create_event', { title: 'Review', start: '2026-11-03T10:00', end: '2026-11-03T11:00' }, ctx);
    const prepare = createGwsCalendarPrepare(cfg);
    const upd = await prepare('calendar_update_event', { eventId: 'ev1', title: 'Design review' });
    expect(upd.ok && upd.arguments.expectedEtag).toBe(fake.events.get('ev1')!.etag);
    expect(upd.ok && String(upd.presentation?.cardText)).toContain('“Review” → “Design review”');
    const del = await prepare('calendar_delete_event', { eventId: 'ev1' });
    expect(del.ok && String(del.presentation?.cardText)).toContain('Delete this event');
    expect(await prepare('calendar_delete_event', { eventId: 'nope' })).toMatchObject({ ok: false });
    expect(await prepare('calendar_update_event', { eventId: 'ev1' })).toMatchObject({ ok: false, reason: expect.stringContaining('nothing to change') });
    hasScope = false;
    expect(await prepare('calendar_delete_event', { eventId: 'ev1' })).toMatchObject({ ok: false });
  });

  it('read and draft tools pass straight through', async () => {
    const prepare = createGwsCalendarPrepare(config(fakeCalendar()));
    expect(await prepare('calendar_list_events', { a: 1 })).toEqual({ ok: true, arguments: { a: 1 } });
  });
});

describe('Calendar through Core governed dispatch (permission -> approval -> execute -> verified)', () => {
  let db: CoreDatabase;
  beforeEach(() => {
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    delete process.env[CONNECTOR_CREDENTIAL_ENV.google_calendar];
    setGmailAccessToken('tok', new Date(Date.now() + 3_600_000).toISOString(), 'me@example.com', [CAL_SCOPE]);
  });
  afterEach(() => { db.close(); clearGmailAccessToken(); });

  function decisionFrom(approval: ApprovalRecord) {
    return {
      approvalId: approval.id, resolution: 'approved' as const, attemptId: approval.attemptId,
      expectedAttemptRevision: approval.expectedAttemptRevision, expectedAttemptStatus: approval.expectedAttemptStatus,
      requestedActionDigest: approval.requestedActionDigest, frozenContextHash: approval.frozenContextHash,
      actor: 'client-1', clientId: 'client-1', idempotencyKey: `approve:${approval.id}`,
    };
  }

  function registry(fake: ReturnType<typeof fakeCalendar>) {
    const cfg = config(fake, { getAccessToken: () => getGmailAccessToken(), getAccountEmail: () => getGmailAccountEmail(), hasCalendarScope: () => googleScopeGranted(CAL_SCOPE) });
    const connectors = buildConnectorAdapters({
      google_calendar: {
        isConnected: () => getGmailAccountEmail() !== null && googleScopeGranted(CAL_SCOPE),
        notConfiguredReason: () => (getGmailAccountEmail() !== null ? 'Google did not grant Calendar access for this sign-in.' : 'Google is not connected. Connect Google to use Calendar.'),
        probe: createGwsCalendarProbe(cfg),
        executor: createGwsCalendarExecutor(cfg),
        prepare: createGwsCalendarPrepare(cfg),
      },
    });
    const reg = new GovernedCapabilityRegistry();
    for (const adapter of connectors.values()) reg.register(adapter);
    return { reg, connectors };
  }

  /** Core probes both connectors whenever Desktop pushes a token; the tests do the same. */
  async function probed(fake: ReturnType<typeof fakeCalendar>) {
    const r = registry(fake);
    await r.connectors.get('google_calendar')!.probeHealth();
    return r;
  }

  const base = { correlationId: 'conv-cal', cwd: process.cwd(), actor: 'core', clientId: 'client-1' };

  it('is configured purely from the live token + granted scope (no spawn-time env var needed) and reports available after a real probe', async () => {
    const { connectors } = registry(fakeCalendar());
    const adapter = connectors.get('google_calendar')!;
    expect(adapter.isConfigured()).toBe(true);
    expect((await adapter.probeHealth()).state).toBe('available');
    clearGmailAccessToken();
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.health().reason).toContain('Connect Google');
    setGmailAccessToken('tok', new Date(Date.now() + 3_600_000).toISOString(), 'me@example.com', ['openid']);
    expect(adapter.health().reason).toContain('did not grant Calendar');
  });

  it('create needs the execute tier, then an exact-event approval, then runs and returns a verified result exactly once', async () => {
    const fake = fakeCalendar();
    const { reg, connectors } = await probed(fake);
    const args = { title: 'Team lunch', start: '2026-11-03T12:00', end: '2026-11-03T13:00' };

    const denied = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'calendar_create_event', arguments: args });
    expect(denied.outcome).toBe('denied');
    expect(fake.calls.filter((c) => c.method === 'insert')).toHaveLength(0);

    setConnectorPermission(db, { connectorId: 'google_calendar', tier: 'execute', granted: true, actor: 'operator' });
    const requested = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'calendar_create_event', arguments: args });
    if (requested.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${requested.outcome}`);
    expect(String(requested.approval.presentation?.cardText)).toContain('Team lunch');
    expect(fake.events.size).toBe(0); // nothing happens before approval

    resolveCapabilityApproval(db, decisionFrom(requested.approval));
    const executed = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'calendar_create_event', arguments: args });
    expect(executed.outcome).toBe('executed');
    if (executed.outcome !== 'executed') return;
    expect(executed.toolInvocation.status).toBe('succeeded');
    expect(fake.events.size).toBe(1);
    const again = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'calendar_create_event', arguments: args });
    expect(again.outcome).toBe('executed');
    expect(fake.calls.filter((c) => c.method === 'insert')).toHaveLength(1);
  });

  it('delete: the approval shows the live event; if it changes before approval the old approval cannot delete it', async () => {
    const fake = fakeCalendar();
    const { reg, connectors } = await probed(fake);
    setConnectorPermission(db, { connectorId: 'google_calendar', tier: 'execute', granted: true, actor: 'operator' });
    const exec = createGwsCalendarExecutor(config(fake));
    await exec('calendar_create_event', { title: 'Keep me', start: '2026-11-03T10:00', end: '2026-11-03T11:00' }, ctx);

    const requested = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'calendar_delete_event', arguments: { eventId: 'ev1' } });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    expect(String(requested.approval.presentation?.cardText)).toContain('Keep me');

    // Someone edits the event after the card was shown.
    await exec('calendar_update_event', { eventId: 'ev1', expectedEtag: fake.events.get('ev1')!.etag, title: 'Keep me (edited)' }, ctx);
    resolveCapabilityApproval(db, decisionFrom(requested.approval));

    const next = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'calendar_delete_event', arguments: { eventId: 'ev1' } });
    expect(next.outcome).toBe('approval_required'); // a fresh approval for the CURRENT event, not the stale one
    expect(fake.events.has('ev1')).toBe(true);
  });

  it('read tools need only the read tier; a read grant cannot create', async () => {
    const fake = fakeCalendar();
    const { reg, connectors } = await probed(fake);
    setConnectorPermission(db, { connectorId: 'google_calendar', tier: 'read', granted: true, actor: 'operator' });
    const listed = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'calendar_list_events', arguments: {} });
    expect(listed.outcome).toBe('executed');
    const created = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'calendar_create_event', arguments: { title: 'x', start: '2026-11-03T10:00', end: '2026-11-03T11:00' } });
    expect(created.outcome).toBe('denied');
  });
});

describe('calendar read: today and readable times', () => {
  it('a date-only "from" reads exactly that local day, with offset times shown in the user zone', async () => {
    const fake = fakeCalendar();
    fake.events.set('brief', {
      id: 'brief', etag: '"b1"', status: 'confirmed', summary: 'Standup', htmlLink: '',
      start: { dateTime: '2026-11-02T09:30:00+01:00' }, end: { dateTime: '2026-11-02T10:00:00+01:00' },
    });
    const result = await createGwsCalendarExecutor(config(fake))('calendar_list_events', { from: '2026-11-02' }, ctx);
    expect(result.status).toBe('succeeded');
    const listed = fake.calls.find((c) => c.method === 'list');
    expect(listed?.params.timeMin).toBe('2026-11-01T23:00:00.000Z');
    expect(listed?.params.timeMax).toBe('2026-11-02T23:00:00.000Z');
    const body = parse(result);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].when).toContain('09:30');
    expect(body.events[0].when).not.toContain('+01:00');
  });
});

describe('calendar suggestions are read-only and computed, not guessed', () => {
  const berlin = (wall: string) => Date.parse(`${wall}:00+01:00`);
  it('proposes weekday slots inside working hours, never in the past, spread across days', () => {
    const slots = suggestMeetingSlots({
      busy: [{ startMs: berlin('2026-11-02T09:00'), endMs: berlin('2026-11-02T12:00') }],
      rangeStartMs: berlin('2026-11-01T10:00'),
      rangeEndMs: berlin('2026-11-08T10:00'),
      timeZone: TZ, durationMinutes: 30, count: 3, workdayStart: '09:00', workdayEnd: '18:00',
      nowMs: berlin('2026-11-01T10:00'),
    });
    expect(slots.map((s) => new Date(s.startMs).toISOString())).toEqual([
      '2026-11-02T11:00:00.000Z', // Mon 12:00 Berlin: the first free half hour after the 09-12 block
      '2026-11-03T08:00:00.000Z', // Tue 09:00
      '2026-11-04T08:00:00.000Z', // Wed 09:00
    ]);
    for (const slot of slots) expect(slot.endMs - slot.startMs).toBe(30 * 60_000);
  });

  it('skips weekends, and never offers a slot that overlaps a busy period or the past', () => {
    const slots = suggestMeetingSlots({
      busy: [{ startMs: berlin('2026-11-06T09:00'), endMs: berlin('2026-11-06T18:00') }],
      rangeStartMs: berlin('2026-11-06T08:00'), rangeEndMs: berlin('2026-11-10T18:00'),
      timeZone: TZ, durationMinutes: 60, count: 2, workdayStart: '09:00', workdayEnd: '18:00',
      nowMs: berlin('2026-11-06T08:00'),
    });
    expect(slots.map((s) => new Date(s.startMs).toISOString())).toEqual(['2026-11-09T08:00:00.000Z', '2026-11-10T08:00:00.000Z']);
  });

  it('calendar_check_availability returns suggestedSlots in the user zone and creates nothing', async () => {
    const calls: string[][] = [];
    const runGwsFn = (async (input: { args: string[] }) => {
      calls.push(input.args);
      return { exitCode: 0, stdout: JSON.stringify({ calendars: { primary: { busy: [{ start: '2026-11-02T08:00:00Z', end: '2026-11-02T11:00:00Z' }] } } }), stderr: '', timedOut: false, aborted: false };
    }) as unknown as GwsCalendarAdapterConfig['runGwsFn'];
    const result = await createGwsCalendarExecutor(config(fakeCalendar(), { runGwsFn }))('calendar_check_availability', { from: '2026-11-02', to: '2026-11-07' }, ctx);
    expect(result.status).toBe('succeeded');
    const body = parse(result);
    expect(body.suggestedSlots).toHaveLength(3);
    expect(body.suggestedSlots[0].label).toBe('Mon 2 Nov 2026 12:00–12:30 (Europe/Berlin)');
    expect(body.suggestionRules).toContain('nothing was created');
    expect(calls.every((args) => args[1] === 'freebusy')).toBe(true);
  });

  it('Core refuses calendar_draft_event for a suggestion-only request, before any approval exists', async () => {
    const db = openCoreDatabase(path.join(dir, 'core-intent.db')).db;
    try {
      delete process.env[CONNECTOR_CREDENTIAL_ENV.google_calendar];
      setGmailAccessToken('tok', new Date(Date.now() + 3_600_000).toISOString(), 'me@example.com', [CAL_SCOPE]);
      const fake = fakeCalendar();
      const cfg = config(fake, { getAccessToken: () => getGmailAccessToken(), getAccountEmail: () => getGmailAccountEmail(), hasCalendarScope: () => googleScopeGranted(CAL_SCOPE) });
      const connectors = buildConnectorAdapters({
        google_calendar: {
          isConnected: () => true,
          probe: createGwsCalendarProbe(cfg),
          executor: createGwsCalendarExecutor(cfg),
          prepare: createGwsCalendarPrepare(cfg),
        },
      });
      await connectors.get('google_calendar')!.probeHealth();
      const reg = new GovernedCapabilityRegistry();
      for (const adapter of connectors.values()) reg.register(adapter);
      setConnectorPermission(db, { connectorId: 'google_calendar', tier: 'read', granted: true, actor: 'op' });
      setConnectorPermission(db, { connectorId: 'google_calendar', tier: 'draft', granted: true, actor: 'op' });
      setConnectorPermission(db, { connectorId: 'google_calendar', tier: 'execute', granted: true, actor: 'op' });
      const callsBefore = fake.calls.length;
      const refused = await dispatchConnectorAction(db, reg, connectors as any, {
        correlationId: 'conv-intent', cwd: process.cwd(), actor: 'core', clientId: 'client-1',
        toolName: 'calendar_draft_event',
        arguments: { title: 'Meeting', start: '2026-11-03T10:00', end: '2026-11-03T10:30' },
        requestText: 'Give me three available meeting slots next week without creating any events.',
      });
      expect(refused.outcome).toBe('denied');
      if (refused.outcome === 'denied') expect(refused.reason).toMatch(/no approval was requested/);
      expect(listApprovalsForAttempt(db, refused.attemptId)).toHaveLength(0);
      expect(fake.calls.length).toBe(callsBefore);
    } finally {
      db.close();
      clearGmailAccessToken();
    }
  });
});
