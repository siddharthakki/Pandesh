/**
 * Google Calendar `probe`/`executor`/`prepare` for the Jarvis Connector
 * Foundation (`connectorDefinitions.ts`), on the same pinned `gws` transport
 * and the same Google OAuth grant as Gmail (one sign-in, one access token in
 * `gmailAccessTokenStore.ts`; Calendar is only usable when Google actually
 * granted the `calendar.events` scope).
 *
 * Like `gwsGmailAdapter.ts` this file is the static allowlist: five typed
 * tools map to a fixed set of `gws calendar events <method>` invocations on
 * the user's primary calendar. Nothing caller-supplied selects a service,
 * resource or method.
 *
 * Safety shape:
 * - Create / update / delete are `execute`-tier: Core's approval card shows the
 *   exact event in plain language (built by `prepare`) before anything runs.
 * - Update and delete bind the event's `etag` into the approved arguments;
 *   the executor re-reads the event and refuses if it changed since approval.
 * - Every write is re-read afterwards and the result says whether the live
 *   calendar really matches (`verified`), never just "the API returned 200".
 * - Event text (titles, descriptions, attendees) is untrusted data.
 */
import * as path from 'node:path';
import type { ConnectorExecutor, ConnectorPrepare, ConnectorProbe } from './connectorCapability';
import type { ToolExecutionResult } from '../toolRunner';
import { GWS_PINNED_SHA256_WINDOWS_X64, parseGwsJson, resolveGwsBinaryPath, runGws, verifyPinnedBinary } from './gwsTransport';
import { callGws, errorReasonFromParsed, invalidArgs, stringArray, succeeded, trimmedNonEmptyString, type CallDeps } from './gwsGmailAdapter';

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const CALENDAR_ID = 'primary';
const MAX_LIST_EVENTS = 50;
const DEFAULT_LIST_EVENTS = 25;
const MAX_TEXT = 4_000;
const DEFAULT_RANGE_DAYS = 7;

export interface GwsCalendarAdapterConfig {
  getAccessToken: () => string | null;
  getAccountEmail: () => string | null;
  /** True only when Google granted `calendar.events` for the current token. */
  hasCalendarScope: () => boolean;
  configDir: string;
  /** IANA time zone used for times given without an offset. Defaults to the host's. */
  timeZone?: () => string;
  binaryPath?: string;
  expectedSha256?: string;
  timeoutMs?: number;
  runGwsFn?: typeof runGws;
  now?: () => number;
}

export function defaultGwsCalendarConfigDir(dataDir: string): string {
  return path.join(dataDir, 'gws-cache', 'calendar');
}

// ─────────────────────────── time + event helpers ───────────────────────────

export interface CalendarWhen {
  /** RFC 3339 date-time for timed events. */
  dateTime?: string;
  /** YYYY-MM-DD for all-day events. */
  date?: string;
  timeZone?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/;
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** V8 rolls 2026-02-31 over to March; a calendar must not. */
function isRealDate(isoDate: string): boolean {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === isoDate;
}

export function parseWhen(raw: unknown, timeZone: string, field: string): { ok: true; when: CalendarWhen } | { ok: false; reason: string } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: `"${field}" is required` };
  if (DATE_ONLY.test(value)) {
    if (!isRealDate(value)) return { ok: false, reason: `"${field}" is not a real date: ${value}` };
    return { ok: true, when: { date: value } };
  }
  const local = LOCAL_DATE_TIME.exec(value);
  if (local) {
    const dateTime = `${local[1]}T${local[2]}:${local[3] ?? '00'}`;
    if (!isRealDate(local[1]) || Number.isNaN(Date.parse(`${dateTime}Z`))) return { ok: false, reason: `"${field}" is not a real time: ${value}` };
    return { ok: true, when: { dateTime, timeZone } };
  }
  if (OFFSET_DATE_TIME.test(value)) {
    const normalized = value.replace(' ', 'T');
    if (!isRealDate(normalized.slice(0, 10)) || Number.isNaN(Date.parse(normalized))) return { ok: false, reason: `"${field}" is not a real time: ${value}` };
    return { ok: true, when: { dateTime: normalized } };
  }
  return { ok: false, reason: `"${field}" must be ISO 8601, e.g. 2026-11-03T14:00 or 2026-11-03T14:00:00+01:00 (or YYYY-MM-DD for an all-day event)` };
}

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const v: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') v[p.type] = Number(p.value);
  return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - Math.floor(utcMs / 1000) * 1000;
}

/** The real instant of a wall-clock time (no offset) in an IANA zone. */
function wallToMs(wall: string, timeZone: string): number {
  const asUtc = Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}Z`);
  let ms = asUtc - tzOffsetMs(asUtc, timeZone);
  ms = asUtc - tzOffsetMs(ms, timeZone); // second pass settles DST edges
  return ms;
}

/** Instant (ms) of a calendar time. Times without an offset are read in their own `timeZone` (never as UTC). */
function whenMs(when: CalendarWhen, fallbackZone = 'UTC'): number {
  const zoneName = when.timeZone ?? fallbackZone;
  if (when.date) return wallToMs(`${when.date}T00:00:00`, zoneName);
  const dt = when.dateTime ?? '';
  return HAS_OFFSET.test(dt) ? Date.parse(dt) : wallToMs(dt, zoneName);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface NormalizedEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  attendees: string[];
  status: string;
  htmlLink: string;
  etag: string;
}

interface ApiEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; self?: boolean }>;
}

function clip(text: string | undefined, max = 300): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function normalizeEvent(event: ApiEvent): NormalizedEvent {
  return {
    id: event.id ?? '',
    title: clip(event.summary, 300) || '(no title)',
    start: event.start?.dateTime ?? event.start?.date ?? '',
    end: event.end?.dateTime ?? event.end?.date ?? '',
    allDay: Boolean(event.start?.date && !event.start?.dateTime),
    location: clip(event.location, 200),
    description: clip(event.description, 500),
    attendees: (event.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
    status: event.status ?? 'confirmed',
    htmlLink: event.htmlLink ?? '',
    etag: event.etag ?? '',
  };
}

function instantParts(iso: string, allDay: boolean, timeZone: string): { date: string; time: string } {
  if (!iso) return { date: '?', time: '' };
  try {
    if (allDay || DATE_ONLY.test(iso)) {
      return { date: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)), time: '' };
    }
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
    // A naive local time is already wall-clock in `timeZone`; format it as-is.
    const date = new Date(hasOffset ? iso : `${iso}Z`);
    const tz = hasOffset ? timeZone : 'UTC';
    return {
      date: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(date),
      time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(date),
    };
  } catch {
    return { date: iso, time: '' };
  }
}

function describeRange(event: { start: string; end: string; allDay: boolean }, timeZone: string): string {
  if (event.allDay) {
    const lastDay = event.end ? addDays(event.end, -1) : event.start;
    const first = instantParts(event.start, true, timeZone).date;
    return lastDay > event.start ? `${first} – ${instantParts(lastDay, true, timeZone).date} (all day)` : `${first} (all day)`;
  }
  const s = instantParts(event.start, false, timeZone);
  const e = instantParts(event.end, false, timeZone);
  return s.date === e.date ? `${s.date}, ${s.time}–${e.time} (${timeZone})` : `${s.date} ${s.time} – ${e.date} ${e.time} (${timeZone})`;
}

// ───────────────────────────── command plumbing ─────────────────────────────

function binaryFor(config: GwsCalendarAdapterConfig): { ok: true; path: string } | { ok: false; reason: string } {
  const binaryPath = config.binaryPath ?? resolveGwsBinaryPath();
  if (!binaryPath) return { ok: false, reason: 'gws binary is not staged (KARKEDIKHA_GWS_BIN is not set)' };
  const check = verifyPinnedBinary(binaryPath, config.expectedSha256 ?? GWS_PINNED_SHA256_WINDOWS_X64);
  return check.ok ? { ok: true, path: check.path } : { ok: false, reason: check.reason };
}

function depsFor(config: GwsCalendarAdapterConfig, binaryPath: string, token: string, signal?: AbortSignal): CallDeps {
  return {
    binaryPath,
    accessToken: token,
    configDir: config.configDir,
    signal,
    timeoutMs: config.timeoutMs,
    runGwsFn: config.runGwsFn ?? runGws,
  };
}

const zone = (config: GwsCalendarAdapterConfig): string => config.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

/** An explicit, valid IANA `timeZone` argument wins; otherwise the host's. */
function tzFor(config: GwsCalendarAdapterConfig, args: Record<string, unknown>): string {
  const requested = typeof args.timeZone === 'string' ? args.timeZone.trim() : '';
  if (requested) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: requested });
      return requested;
    } catch { /* fall through to the host zone */ }
  }
  return zone(config);
}

async function listRange(deps: CallDeps, fromIso: string, toIso: string, maxResults: number, category: string) {
  const params = { calendarId: CALENDAR_ID, timeMin: fromIso, timeMax: toIso, singleEvents: true, orderBy: 'startTime', maxResults };
  const outcome = await callGws(deps, ['calendar', 'events', 'list', '--params', JSON.stringify(params)], category);
  if (!outcome.ok) return outcome;
  const items = ((outcome.data as { items?: ApiEvent[] } | null)?.items ?? []).filter((e) => e.status !== 'cancelled');
  return { ok: true as const, events: items.map(normalizeEvent) };
}

async function getEvent(deps: CallDeps, eventId: string, category: string) {
  const outcome = await callGws(deps, ['calendar', 'events', 'get', '--params', JSON.stringify({ calendarId: CALENDAR_ID, eventId })], category);
  if (!outcome.ok) return outcome;
  return { ok: true as const, event: normalizeEvent(outcome.data as ApiEvent) };
}

function toIsoBoundary(when: CalendarWhen, tz: string): string {
  return new Date(whenMs(when, tz)).toISOString();
}

// ─────────────────────── argument validation (shared) ───────────────────────

interface EventFields {
  title?: string;
  start?: CalendarWhen;
  end?: CalendarWhen;
  description?: string;
  location?: string;
  attendees?: string[];
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

function readFields(args: Record<string, unknown>, tz: string, mode: 'create' | 'update'): { ok: true; fields: EventFields } | { ok: false; reason: string } {
  const fields: EventFields = {};
  const title = trimmedNonEmptyString(args.title);
  if (mode === 'create' && !title) return { ok: false, reason: '"title" is required' };
  if (title) fields.title = title.slice(0, 300);
  if (typeof args.description === 'string') fields.description = args.description.slice(0, MAX_TEXT);
  if (typeof args.location === 'string') fields.location = args.location.slice(0, 500);
  if (args.attendees !== undefined) {
    const attendees = stringArray(args.attendees);
    const bad = attendees.find((a) => !EMAIL.test(a));
    if (bad) return { ok: false, reason: `attendee "${bad}" is not a valid email address` };
    fields.attendees = [...new Set(attendees.map((a) => a.toLowerCase()))].slice(0, 50);
  }
  const hasStart = args.start !== undefined && String(args.start).trim() !== '';
  const hasEnd = args.end !== undefined && String(args.end).trim() !== '';
  if (mode === 'create' && !hasStart) return { ok: false, reason: '"start" is required' };
  if (hasStart || hasEnd) {
    if (mode === 'update' && hasStart !== hasEnd) return { ok: false, reason: 'to change the time, give both "start" and "end"' };
    const start = parseWhen(args.start, tz, 'start');
    if (!start.ok) return start;
    let end: ReturnType<typeof parseWhen>;
    if (!hasEnd && start.when.date) end = { ok: true, when: { date: addDays(start.when.date, 1) } };
    else end = parseWhen(args.end, tz, 'end');
    if (!end.ok) return end;
    if (Boolean(start.when.date) !== Boolean(end.when.date)) return { ok: false, reason: '"start" and "end" must both be dates (all-day) or both be times' };
    if (whenMs(end.when, tz) <= whenMs(start.when, tz)) return { ok: false, reason: '"end" must be after "start"' };
    fields.start = start.when;
    fields.end = end.when;
  }
  return { ok: true, fields };
}

function apiBody(fields: EventFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.title !== undefined) body.summary = fields.title;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.location !== undefined) body.location = fields.location;
  if (fields.start) body.start = fields.start;
  if (fields.end) body.end = fields.end;
  if (fields.attendees !== undefined) body.attendees = fields.attendees.map((email) => ({ email }));
  return body;
}

function overlaps(existing: NormalizedEvent, start: CalendarWhen, end: CalendarWhen, tz: string): boolean {
  const s = whenMs(existing.allDay ? { date: existing.start } : { dateTime: existing.start }, tz);
  const e = whenMs(existing.allDay ? { date: existing.end } : { dateTime: existing.end }, tz);
  return s < whenMs(end, tz) && e > whenMs(start, tz);
}

// ───────────────────────────────── tools ────────────────────────────────────

async function runList(args: Record<string, unknown>, deps: CallDeps, tz: string, nowMs: number): Promise<ToolExecutionResult> {
  const from = args.from === undefined ? { ok: true as const, when: { dateTime: new Date(nowMs).toISOString() } } : parseWhen(args.from, tz, 'from');
  if (!from.ok) return invalidArgs(`calendar_list_events: ${from.reason}`);
  // A date-only "from" with no "to" means that one whole local day ("today").
  const to = args.to !== undefined
    ? parseWhen(args.to, tz, 'to')
    : from.when.date
      ? { ok: true as const, when: { date: addDays(from.when.date, 1) } }
      : { ok: true as const, when: { dateTime: new Date(whenMs(from.when, tz) + DEFAULT_RANGE_DAYS * 86_400_000).toISOString() } };
  if (!to.ok) return invalidArgs(`calendar_list_events: ${to.reason}`);
  if (whenMs(to.when, tz) <= whenMs(from.when, tz)) return invalidArgs('calendar_list_events: "to" must be after "from"');
  const requested = Number(args.maxResults);
  const maxResults = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIST_EVENTS) : DEFAULT_LIST_EVENTS;
  const listed = await listRange(deps, toIsoBoundary(from.when, tz), toIsoBoundary(to.when, tz), maxResults, 'calendar_list_failed');
  if (!listed.ok) return listed.result;
  return succeeded('calendar_list_succeeded', { timeZone: tz, events: listed.events.map(({ etag: _etag, ...rest }) => ({ ...rest, when: describeRange(rest, tz) })), count: listed.events.length });
}

// ─────────────────────── read-only meeting-slot suggestion ───────────────────────

const SLOT_STEP_MS = 30 * 60_000;

export interface SuggestedSlot { startMs: number; endMs: number }

/** `YYYY-MM-DDTHH:mm` wall clock of an instant in an IANA zone. */
function wallClock(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  const v: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') v[p.type] = p.value;
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}`;
}

/** "Fri 23 Oct 2026, 09:00" in the user's zone, fixed locale so the text never depends on the machine's region. */
function formatLocal(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(/,/g, '');
}

function parseHm(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return fallback;
  const h = Number(m[1]); const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? `${String(h).padStart(2, '0')}:${m[2]}` : fallback;
}

/**
 * Deterministic meeting suggestions from the busy periods: weekdays only, inside working hours, on a 30-minute grid,
 * never in the past, spread across days before a second slot is taken from a day that already has one.
 */
export function suggestMeetingSlots(input: {
  busy: Array<{ startMs: number; endMs: number }>;
  rangeStartMs: number;
  rangeEndMs: number;
  timeZone: string;
  durationMinutes: number;
  count: number;
  workdayStart: string;
  workdayEnd: string;
  nowMs: number;
}): SuggestedSlot[] {
  const durationMs = input.durationMinutes * 60_000;
  const floor = Math.max(input.rangeStartMs, input.nowMs);
  const firstDay = wallClock(floor, input.timeZone).slice(0, 10);
  const lastDay = wallClock(input.rangeEndMs - 1, input.timeZone).slice(0, 10);
  const perDay: SuggestedSlot[][] = [];
  for (let day = firstDay, guard = 0; day <= lastDay && guard < 60; day = addDays(day, 1), guard += 1) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const winStart = wallToMs(`${day}T${input.workdayStart}:00`, input.timeZone);
    const winEnd = Math.min(wallToMs(`${day}T${input.workdayEnd}:00`, input.timeZone), input.rangeEndMs);
    let cursor = winStart;
    if (floor > cursor) cursor = winStart + Math.ceil((floor - winStart) / SLOT_STEP_MS) * SLOT_STEP_MS;
    const slots: SuggestedSlot[] = [];
    while (cursor + durationMs <= winEnd) {
      const end = cursor + durationMs;
      const clash = input.busy.find((b) => b.startMs < end && b.endMs > cursor);
      if (clash) {
        cursor = winStart + Math.ceil((Math.max(clash.endMs, cursor + SLOT_STEP_MS) - winStart) / SLOT_STEP_MS) * SLOT_STEP_MS;
        continue;
      }
      slots.push({ startMs: cursor, endMs: end });
      cursor = end;
    }
    if (slots.length) perDay.push(slots);
  }
  const picked: SuggestedSlot[] = [];
  for (let round = 0; picked.length < input.count; round += 1) {
    let any = false;
    for (const slots of perDay) {
      if (round < slots.length && picked.length < input.count) { picked.push(slots[round]); any = true; }
    }
    if (!any) break;
  }
  return picked.sort((a, b) => a.startMs - b.startMs);
}

async function runAvailability(args: Record<string, unknown>, deps: CallDeps, tz: string, nowMs: number = Date.now()): Promise<ToolExecutionResult> {
  const from = args.from === undefined ? { ok: true as const, when: { dateTime: new Date(nowMs).toISOString() } } : parseWhen(args.from, tz, 'from');
  if (!from.ok) return invalidArgs(`calendar_check_availability: ${from.reason}`);
  const to = args.to !== undefined
    ? parseWhen(args.to, tz, 'to')
    : { ok: true as const, when: { dateTime: new Date(whenMs(from.when, tz) + DEFAULT_RANGE_DAYS * 86_400_000).toISOString() } };
  if (!to.ok) return invalidArgs(`calendar_check_availability: ${to.reason}`);
  if (whenMs(to.when, tz) <= whenMs(from.when, tz)) return invalidArgs('calendar_check_availability: "to" must be after "from"');

  const timeMin = toIsoBoundary(from.when, tz);
  const timeMax = toIsoBoundary(to.when, tz);

  const params = {
    timeMin,
    timeMax,
    timeZone: tz,
    items: [{ id: 'primary' }],
  };

  const result = await callGws(deps, ['calendar', 'freebusy', 'query', '--params', JSON.stringify(params)], 'calendar_freebusy_failed');
  if (!result.ok) return result.result;

  const data = result.data as { calendars: { primary: { busy: Array<{ start: string; end: string }> } } };
  const busy = data?.calendars?.primary?.busy ?? [];

  // Convert busy periods to a more readable format
  const busyPeriods = busy.map((b) => ({
    start: b.start,
    end: b.end,
    startLocal: formatLocal(new Date(b.start).getTime(), tz),
    endLocal: formatLocal(new Date(b.end).getTime(), tz),
  }));

  // Also compute free slots (gaps between busy periods within the range)
  const rangeStartMs = new Date(timeMin).getTime();
  const rangeEndMs = new Date(timeMax).getTime();
  const freeSlots: Array<{ start: string; end: string; startLocal: string; endLocal: string }> = [];
  let currentMs = rangeStartMs;
  for (const b of busy) {
    const busyStartMs = new Date(b.start).getTime();
    const busyEndMs = new Date(b.end).getTime();
    if (busyStartMs > currentMs) {
      freeSlots.push({
        start: new Date(currentMs).toISOString(),
        end: new Date(Math.min(busyStartMs, rangeEndMs)).toISOString(),
        startLocal: formatLocal(currentMs, tz),
        endLocal: formatLocal(Math.min(busyStartMs, rangeEndMs), tz),
      });
    }
    currentMs = Math.max(currentMs, busyEndMs);
    if (currentMs >= rangeEndMs) break;
  }
  if (currentMs < rangeEndMs) {
    freeSlots.push({
      start: new Date(currentMs).toISOString(),
      end: new Date(rangeEndMs).toISOString(),
      startLocal: formatLocal(currentMs, tz),
      endLocal: formatLocal(rangeEndMs, tz),
    });
  }

  const durationRaw = Number(args.durationMinutes);
  const durationMinutes = Number.isFinite(durationRaw) && durationRaw >= 5 ? Math.min(Math.floor(durationRaw), 480) : 30;
  const countRaw = Number(args.count);
  const count = Number.isFinite(countRaw) && countRaw >= 1 ? Math.min(Math.floor(countRaw), 10) : 3;
  const workdayStart = parseHm(args.workdayStart, '09:00');
  const workdayEnd = parseHm(args.workdayEnd, '18:00');
  const suggested = suggestMeetingSlots({
    busy: busy.map((b) => ({ startMs: new Date(b.start).getTime(), endMs: new Date(b.end).getTime() })),
    rangeStartMs, rangeEndMs, timeZone: tz, durationMinutes, count, workdayStart, workdayEnd, nowMs,
  }).map((slot) => ({
    start: new Date(slot.startMs).toISOString(),
    end: new Date(slot.endMs).toISOString(),
    startLocal: wallClock(slot.startMs, tz),
    label: `${formatLocal(slot.startMs, tz)}–${wallClock(slot.endMs, tz).slice(11)} (${tz})`,
  }));

  return succeeded('calendar_availability_succeeded', {
    timeZone: tz,
    range: { from: timeMin, to: timeMax },
    busy: busyPeriods,
    free: freeSlots,
    suggestedSlots: suggested,
    suggestionRules: `${durationMinutes}-minute slots, weekdays ${workdayStart}-${workdayEnd} ${tz}, 30-minute grid, none in the past, spread across days. Read-only: nothing was created.`,
    summary: `${freeSlots.length} free slot${freeSlots.length === 1 ? '' : 's'} found in range; ${busyPeriods.length} busy period${busyPeriods.length === 1 ? '' : 's'}`,
  });
}

async function runDraft(args: Record<string, unknown>, deps: CallDeps, tz: string): Promise<ToolExecutionResult> {
  const read = readFields(args, tz, 'create');
  if (!read.ok) return invalidArgs(`calendar_draft_event: ${read.reason}`);
  const { fields } = read;
  const listed = await listRange(deps, toIsoBoundary(fields.start!, tz), toIsoBoundary(fields.end!, tz), MAX_LIST_EVENTS, 'calendar_draft_conflicts_failed');
  if (!listed.ok) return listed.result;
  const conflicts = listed.events.filter((e) => overlaps(e, fields.start!, fields.end!, tz)).map(({ etag: _etag, description: _d, ...rest }) => rest);
  return succeeded('calendar_draft_succeeded', {
    draft: { title: fields.title, start: fields.start, end: fields.end, location: fields.location ?? '', description: fields.description ?? '', attendees: fields.attendees ?? [] },
    timeZone: tz,
    conflicts,
    note: 'Nothing was created. To create it, call calendar_create_event with the same details; the user will be asked to approve.',
  });
}

function matchesRequested(actual: NormalizedEvent, fields: EventFields, tz: string): string[] {
  const problems: string[] = [];
  if (fields.title !== undefined && actual.title !== (fields.title.length > 300 ? `${fields.title.slice(0, 300)}…` : fields.title)) problems.push('title');
  if (fields.start && fields.end) {
    // Compare real instants: Google may answer with the same moment in another offset.
    const aStart = whenMs(actual.allDay ? { date: actual.start } : { dateTime: actual.start }, tz);
    const aEnd = whenMs(actual.allDay ? { date: actual.end } : { dateTime: actual.end }, tz);
    if (aStart !== whenMs(fields.start, tz)) problems.push('start');
    if (aEnd !== whenMs(fields.end, tz)) problems.push('end');
  }
  if (fields.location !== undefined && actual.location !== clip(fields.location, 200)) problems.push('location');
  if (fields.attendees !== undefined) {
    const have = [...actual.attendees].map((a) => a.toLowerCase()).sort().join(',');
    const want = [...fields.attendees].sort().join(',');
    if (have !== want) problems.push('attendees');
  }
  return problems;
}

async function runCreate(args: Record<string, unknown>, deps: CallDeps, tz: string): Promise<ToolExecutionResult> {
  const read = readFields(args, tz, 'create');
  if (!read.ok) return invalidArgs(`calendar_create_event: ${read.reason}`);
  const { fields } = read;
  const params = { calendarId: CALENDAR_ID, sendUpdates: (fields.attendees?.length ?? 0) > 0 ? 'all' : 'none' };
  const created = await callGws(deps, ['calendar', 'events', 'insert', '--params', JSON.stringify(params), '--json', JSON.stringify(apiBody(fields))], 'calendar_create_failed');
  if (!created.ok) return created.result;
  const createdId = (created.data as ApiEvent | null)?.id;
  if (!createdId) return { status: 'failed', exitCode: null, output: 'Google accepted the request but returned no event id; check the calendar before retrying', resultCategory: 'calendar_create_no_id' };
  const reread = await getEvent(deps, createdId, 'calendar_create_reread_failed');
  if (!reread.ok) {
    return { status: 'failed', exitCode: null, output: `the event was created (id ${createdId}) but reading it back failed, so it is NOT verified: ${reread.result.output}`, resultCategory: 'calendar_create_unverified' };
  }
  const problems = reread.event.status === 'cancelled' ? ['status'] : matchesRequested(reread.event, fields, tz);
  if (problems.length) {
    return { status: 'failed', exitCode: null, output: `the event was created (id ${createdId}) but the calendar does not match the request (${problems.join(', ')}); NOT verified`, resultCategory: 'calendar_create_unverified' };
  }
  const { etag: _etag, ...event } = reread.event;
  return succeeded('calendar_create_succeeded', { verified: true, event, timeZone: tz });
}

function etagRefusal(tool: string, args: Record<string, unknown>): ToolExecutionResult | null {
  if (!trimmedNonEmptyString(args.expectedEtag)) {
    return { status: 'failed', exitCode: null, output: `${tool}: no approved event version is bound to this request; it must be re-proposed and re-approved`, resultCategory: 'calendar_event_unapproved' };
  }
  return null;
}

async function runUpdate(args: Record<string, unknown>, deps: CallDeps, tz: string): Promise<ToolExecutionResult> {
  const eventId = trimmedNonEmptyString(args.eventId);
  if (!eventId) return invalidArgs('calendar_update_event: "eventId" is required');
  const refusal = etagRefusal('calendar_update_event', args);
  if (refusal) return refusal;
  const read = readFields(args, tz, 'update');
  if (!read.ok) return invalidArgs(`calendar_update_event: ${read.reason}`);
  const { fields } = read;
  if (!Object.keys(apiBody(fields)).length) return invalidArgs('calendar_update_event: nothing to change');

  const current = await getEvent(deps, eventId, 'calendar_update_read_failed');
  if (!current.ok) return current.result;
  if (current.event.etag !== String(args.expectedEtag)) {
    return { status: 'failed', exitCode: null, output: 'the event changed after it was shown to you; nothing was modified. Ask again to see the current version.', resultCategory: 'calendar_update_stale' };
  }
  const attendeesTouched = fields.attendees !== undefined || current.event.attendees.length > 0;
  const params = { calendarId: CALENDAR_ID, eventId, sendUpdates: attendeesTouched ? 'all' : 'none' };
  const patched = await callGws(deps, ['calendar', 'events', 'patch', '--params', JSON.stringify(params), '--json', JSON.stringify(apiBody(fields))], 'calendar_update_failed');
  if (!patched.ok) return patched.result;
  const reread = await getEvent(deps, eventId, 'calendar_update_reread_failed');
  if (!reread.ok) {
    return { status: 'failed', exitCode: null, output: `the update was sent but reading the event back failed, so it is NOT verified: ${reread.result.output}`, resultCategory: 'calendar_update_unverified' };
  }
  const problems = matchesRequested(reread.event, fields, tz);
  if (problems.length) {
    return { status: 'failed', exitCode: null, output: `the update was sent but the calendar does not show it (${problems.join(', ')}); NOT verified`, resultCategory: 'calendar_update_unverified' };
  }
  const { etag: _etag, ...event } = reread.event;
  return succeeded('calendar_update_succeeded', { verified: true, event, timeZone: tz });
}

const GONE = /\b(404|410)\b|not ?found|has been deleted|deleted/i;

async function runDelete(args: Record<string, unknown>, deps: CallDeps): Promise<ToolExecutionResult> {
  const eventId = trimmedNonEmptyString(args.eventId);
  if (!eventId) return invalidArgs('calendar_delete_event: "eventId" is required');
  const refusal = etagRefusal('calendar_delete_event', args);
  if (refusal) return refusal;
  const current = await getEvent(deps, eventId, 'calendar_delete_read_failed');
  if (!current.ok) return current.result;
  if (current.event.etag !== String(args.expectedEtag)) {
    return { status: 'failed', exitCode: null, output: 'the event changed after it was shown to you; nothing was deleted. Ask again to see the current version.', resultCategory: 'calendar_delete_stale' };
  }
  const params = { calendarId: CALENDAR_ID, eventId, sendUpdates: current.event.attendees.length > 0 ? 'all' : 'none' };
  const deleted = await callGws(deps, ['calendar', 'events', 'delete', '--params', JSON.stringify(params)], 'calendar_delete_failed', { allowEmptyOutput: true });
  if (!deleted.ok) return deleted.result;
  const reread = await getEvent(deps, eventId, 'calendar_delete_reread');
  const gone = reread.ok ? reread.event.status === 'cancelled' : GONE.test(reread.result.output);
  if (!gone) {
    return { status: 'failed', exitCode: null, output: 'the delete was sent but the event still appears on the calendar; NOT verified', resultCategory: 'calendar_delete_unverified' };
  }
  return succeeded('calendar_delete_succeeded', { verified: true, deletedEvent: { id: eventId, title: current.event.title, start: current.event.start, end: current.event.end } });
}

// ───────────────────────────── probe / executor / prepare ────────────────────

export function createGwsCalendarProbe(config: GwsCalendarAdapterConfig): ConnectorProbe {
  return async (signal) => {
    const token = config.getAccessToken();
    if (!token) return { ok: false, reason: 'no Google access token available' };
    if (!config.hasCalendarScope()) {
      return { ok: false, reason: 'Google did not grant Calendar access for this sign-in. Disconnect and connect Google again to add it.' };
    }
    const binary = binaryFor(config);
    if (!binary.ok) return { ok: false, reason: binary.reason };
    const now = (config.now ?? Date.now)();
    const result = await (config.runGwsFn ?? runGws)({
      binaryPath: binary.path,
      args: ['calendar', 'events', 'list', '--params', JSON.stringify({ calendarId: CALENDAR_ID, maxResults: 1, timeMin: new Date(now).toISOString(), singleEvents: true, orderBy: 'startTime' })],
      accessToken: token,
      configDir: config.configDir,
      signal,
      timeoutMs: config.timeoutMs ?? 8_000,
    });
    if (result.aborted) return { ok: false, reason: 'probe cancelled' };
    if (result.timedOut) return { ok: false, reason: 'probe timed out' };
    const parsed = parseGwsJson(result.stdout);
    if (result.exitCode === 0 && parsed.ok && !(parsed.data as { error?: unknown } | null)?.error) return { ok: true };
    return { ok: false, reason: errorReasonFromParsed(parsed, result.stderr, result.exitCode) };
  };
}

const CALENDAR_TOOL_NAMES = new Set(['calendar_list_events', 'calendar_check_availability', 'calendar_draft_event', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event']);

export function createGwsCalendarExecutor(config: GwsCalendarAdapterConfig): ConnectorExecutor {
  return async (toolName, rawArgs, ctx) => {
    const args = (rawArgs && typeof rawArgs.arguments === 'object' && rawArgs.arguments !== null && !Array.isArray(rawArgs.arguments))
      ? (rawArgs.arguments as Record<string, unknown>)
      : rawArgs;
    if (!CALENDAR_TOOL_NAMES.has(toolName)) {
      return { status: 'failed', exitCode: null, output: `gws transport has no allowlisted mapping for '${toolName}'; no action was taken`, resultCategory: 'gws_not_allowlisted' };
    }
    const token = config.getAccessToken();
    if (!token || !config.getAccountEmail()) {
      return { status: 'failed', exitCode: null, output: 'Google Calendar is not connected; no action was taken', resultCategory: 'connector_not_configured' };
    }
    if (!config.hasCalendarScope()) {
      return { status: 'failed', exitCode: null, output: 'Google did not grant Calendar access for this sign-in; disconnect and connect Google again to add it', resultCategory: 'calendar_scope_missing' };
    }
    const binary = binaryFor(config);
    if (!binary.ok) return { status: 'failed', exitCode: null, output: binary.reason, resultCategory: 'gws_binary_unavailable' };
    const deps = depsFor(config, binary.path, token, ctx.signal);
    const tz = tzFor(config, args);
    try {
      switch (toolName) {
        case 'calendar_list_events': return await runList(args, deps, tz, (config.now ?? Date.now)());
        case 'calendar_check_availability': return await runAvailability(args, deps, tz, (config.now ?? Date.now)());
        case 'calendar_draft_event': return await runDraft(args, deps, tz);
        case 'calendar_create_event': return await runCreate(args, deps, tz);
        case 'calendar_update_event': return await runUpdate(args, deps, tz);
        case 'calendar_delete_event': return await runDelete(args, deps);
        default: return { status: 'failed', exitCode: null, output: `unreachable: '${toolName}'`, resultCategory: 'gws_not_allowlisted' };
      }
    } catch (err) {
      return { status: 'failed', exitCode: null, output: err instanceof Error ? err.message : String(err), resultCategory: 'gws_invalid_arguments' };
    }
  };
}

function eventCard(event: NormalizedEvent, tz: string): string[] {
  return [
    `“${event.title}”`,
    describeRange(event, tz),
    ...(event.location ? [`Where: ${event.location}`] : []),
    ...(event.attendees.length ? [`With: ${event.attendees.join(', ')}`] : []),
  ];
}

/**
 * Builds what the human is asked to approve. Create: the exact event plus any
 * clashes. Update/delete: the live event as it is now, the change, and an
 * `expectedEtag` that the executor re-checks at run time.
 */
export function createGwsCalendarPrepare(config: GwsCalendarAdapterConfig): ConnectorPrepare {
  return async (toolName, rawArgs, signal) => {
    const args = (rawArgs && typeof rawArgs.arguments === 'object' && rawArgs.arguments !== null && !Array.isArray(rawArgs.arguments))
      ? (rawArgs.arguments as Record<string, unknown>)
      : rawArgs;
    if (toolName === 'calendar_list_events' || toolName === 'calendar_check_availability' || toolName === 'calendar_draft_event') return { ok: true, arguments: args };
    const token = config.getAccessToken();
    if (!token || !config.getAccountEmail()) return { ok: false, reason: 'Google Calendar is not connected' };
    if (!config.hasCalendarScope()) return { ok: false, reason: 'Google did not grant Calendar access for this sign-in; disconnect and connect Google again to add it' };
    const binary = binaryFor(config);
    if (!binary.ok) return { ok: false, reason: binary.reason };
    const deps = depsFor(config, binary.path, token, signal);
    const tz = tzFor(config, args);

    if (toolName === 'calendar_create_event') {
      const read = readFields(args, tz, 'create');
      if (!read.ok) return { ok: false, reason: `calendar_create_event: ${read.reason}` };
      const { fields } = read;
      const listed = await listRange(deps, toIsoBoundary(fields.start!, tz), toIsoBoundary(fields.end!, tz), MAX_LIST_EVENTS, 'calendar_prepare_conflicts_failed');
      const conflicts = listed.ok ? listed.events.filter((e) => overlaps(e, fields.start!, fields.end!, tz)) : [];
      const when = { start: fields.start!.date ?? fields.start!.dateTime ?? '', end: fields.end!.date ?? fields.end!.dateTime ?? '', allDay: Boolean(fields.start!.date) };
      const lines = [
        'Add this to your Google Calendar:',
        ...eventCard({ ...normalizeEvent({}), title: fields.title ?? '', ...when, location: fields.location ?? '', attendees: fields.attendees ?? [] }, tz),
        ...(fields.attendees?.length ? ['Google will email invitations to the people listed.'] : []),
        ...(conflicts.length ? ['', `Heads up — this overlaps: ${conflicts.map((c) => `“${c.title}” (${describeRange(c, tz)})`).join('; ')}`] : []),
        ...(!listed.ok ? ['', 'Could not check your calendar for clashes.'] : []),
      ];
      return {
        ok: true,
        arguments: {
          title: fields.title,
          start: fields.start!.date ?? fields.start!.dateTime,
          end: fields.end!.date ?? fields.end!.dateTime,
          ...(fields.location !== undefined ? { location: fields.location } : {}),
          ...(fields.description !== undefined ? { description: fields.description } : {}),
          ...(fields.attendees ? { attendees: fields.attendees } : {}),
          ...(fields.start!.dateTime && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(fields.start!.dateTime) ? { timeZone: tz } : {}),
        },
        presentation: { cardText: lines.join('\n'), action: 'calendar_create_event', timeZone: tz },
      };
    }

    const eventId = trimmedNonEmptyString(args.eventId);
    if (!eventId) return { ok: false, reason: `${toolName}: "eventId" is required (get it from calendar_list_events)` };
    const current = await getEvent(deps, eventId, 'calendar_prepare_read_failed');
    if (!current.ok) return { ok: false, reason: `could not read that event, so nothing was proposed: ${current.result.output}` };
    if (current.event.status === 'cancelled') return { ok: false, reason: 'that event is already deleted' };

    if (toolName === 'calendar_delete_event') {
      return {
        ok: true,
        arguments: { eventId, expectedEtag: current.event.etag },
        presentation: {
          cardText: ['Delete this event from your Google Calendar:', ...eventCard(current.event, tz), ...(current.event.attendees.length ? ['Google will notify the attendees that it was cancelled.'] : [])].join('\n'),
          action: 'calendar_delete_event',
          timeZone: tz,
        },
      };
    }

    // calendar_update_event
    const read = readFields(args, tz, 'update');
    if (!read.ok) return { ok: false, reason: `calendar_update_event: ${read.reason}` };
    const { fields } = read;
    if (!Object.keys(apiBody(fields)).length) return { ok: false, reason: 'calendar_update_event: nothing to change' };
    const changes: string[] = [];
    if (fields.title !== undefined && fields.title !== current.event.title) changes.push(`Title: “${current.event.title}” → “${fields.title}”`);
    if (fields.start && fields.end) {
      const next = { start: fields.start.date ?? fields.start.dateTime ?? '', end: fields.end.date ?? fields.end.dateTime ?? '', allDay: Boolean(fields.start.date) };
      changes.push(`When: ${describeRange(current.event, tz)} → ${describeRange(next, tz)}`);
    }
    if (fields.location !== undefined && fields.location !== current.event.location) changes.push(`Where: ${current.event.location || '(none)'} → ${fields.location || '(none)'}`);
    if (fields.description !== undefined) changes.push('Description will be replaced.');
    if (fields.attendees !== undefined) changes.push(`Attendees: ${current.event.attendees.join(', ') || '(none)'} → ${fields.attendees.join(', ') || '(none)'}`);
    if (!changes.length) return { ok: false, reason: 'that would not change anything on the event' };
    return {
      ok: true,
      arguments: {
        eventId,
        expectedEtag: current.event.etag,
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.start ? { start: fields.start.date ?? fields.start.dateTime } : {}),
        ...(fields.end ? { end: fields.end.date ?? fields.end.dateTime } : {}),
        ...(fields.location !== undefined ? { location: fields.location } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
        ...(fields.attendees !== undefined ? { attendees: fields.attendees } : {}),
        ...(fields.start?.dateTime && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(fields.start.dateTime) ? { timeZone: tz } : {}),
      },
      presentation: {
        cardText: ['Change this event on your Google Calendar:', ...eventCard(current.event, tz), '', ...changes, ...((fields.attendees !== undefined || current.event.attendees.length) ? ['Google will notify the attendees.'] : [])].join('\n'),
        action: 'calendar_update_event',
        timeZone: tz,
      },
    };
  };
}
