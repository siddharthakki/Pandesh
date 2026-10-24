/**
 * Deterministic time resolution. The model never computes dates: relative
 * expressions ("tomorrow", "next Friday", "in 8 days") and wall-clock times are
 * resolved here against the real clock and an IANA zone, DST-correct.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const year = n('year'), month = n('month'), day = n('day');
  return { year, month, day, hour: n('hour') % 24, minute: n('minute'), second: n('second'), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function offsetMs(utcMs: number, timeZone: string): number {
  const p = zonedParts(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function weekdayOfYmd(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

/** Instant (ms) for a wall-clock date+time in `timeZone`. A time skipped by a spring-forward gap lands just after the gap. */
export function zonedWallToMs(date: string, time: string, timeZone: string): number {
  const asUtc = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (!Number.isFinite(asUtc)) throw new Error(`invalid date/time ${date} ${time}`);
  let ms = asUtc - offsetMs(asUtc, timeZone);
  ms = asUtc - offsetMs(ms, timeZone);
  return ms;
}

/** Strict local wall time to ISO instant. Accepts YYYY-MM-DD and H:MM / HH:MM. */
export function localWallTimeToIso(date: string, time: string, timeZone: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) throw new Error('date must be YYYY-MM-DD and time HH:MM');
  const hh = Number(t[1]), mm = Number(t[2]);
  if (hh > 23 || mm > 59) throw new Error('time must be a valid 24-hour HH:MM');
  const ymd = `${d[1]}-${d[2]}-${d[3]}`;
  if (new Date(`${ymd}T00:00:00Z`).toISOString().slice(0, 10) !== ymd) throw new Error(`${ymd} is not a real calendar date`);
  return new Date(zonedWallToMs(ymd, `${pad(hh)}:${pad(mm)}`, timeZone)).toISOString();
}

export function utcOffsetLabel(ms: number, timeZone: string): string {
  const m = Math.round(offsetMs(ms, timeZone) / 60_000);
  const sign = m >= 0 ? '+' : '-';
  const a = Math.abs(m);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function formatZoned(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString('en-GB', { timeZone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface ResolvedTime {
  /** Local calendar date in `timeZone`. */
  date: string;
  weekday: string;
  /** Local HH:MM, or null when the expression named a day only. */
  time: string | null;
  timeZone: string;
  /** ISO 8601 with the zone's real UTC offset at that instant, e.g. 2026-10-20T15:00:00-07:00 (only when a time is known). */
  iso: string | null;
  utc: string | null;
  utcOffset: string;
  /** How the answer was derived, for the model to quote. */
  basis: string;
}

function parseClock(text: string): { time: string | null; rest: string } | { error: string } {
  let rest = text;
  let time: string | null = null;
  const m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/.exec(rest)
    ?? /\bat\s+(\d{1,2}):(\d{2})\b/.exec(rest)
    ?? /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(rest);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const mer = (m[3] ?? '').replace(/\./g, '');
    if (mer) {
      if (h < 1 || h > 12) return { error: `"${m[0]}" is not a valid 12-hour time` };
      if (mer === 'pm' && h < 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
    }
    if (h > 23 || min > 59) return { error: `"${m[0]}" is not a valid time` };
    time = `${pad(h)}:${pad(min)}`;
    rest = rest.replace(m[0], ' ');
  } else if (/\bnoon\b/.test(rest)) { time = '12:00'; rest = rest.replace(/\bnoon\b/, ' '); }
  else if (/\bmidnight\b/.test(rest)) { time = '00:00'; rest = rest.replace(/\bmidnight\b/, ' '); }
  return { time, rest: rest.replace(/\bat\b/g, ' ').replace(/\s+/g, ' ').trim() };
}

/**
 * Resolve a natural relative date/time expression against `nowMs` in `timeZone`.
 * Returns an error string for anything it cannot resolve unambiguously, so the
 * caller can ask the user instead of guessing.
 */
export function resolveTimeExpression(expression: string, nowMs: number, timeZone: string): ResolvedTime | { error: string } {
  if (!isValidTimeZone(timeZone)) return { error: `unknown time zone '${timeZone}'` };
  const raw = expression.toLowerCase().replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return { error: 'empty expression' };
  const now = zonedParts(nowMs, timeZone);
  const today = `${pad(now.year, 4)}-${pad(now.month)}-${pad(now.day)}`;
  const nowHm = `${pad(now.hour)}:${pad(now.minute)}`;

  const clock = parseClock(raw);
  if ('error' in clock) return clock;
  const text = clock.rest;
  let time = clock.time;
  let date: string | null = null;
  let basis = '';

  const finish = (): ResolvedTime => {
    const wd = WEEKDAYS[weekdayOfYmd(date!)];
    const ms = time ? zonedWallToMs(date!, time, timeZone) : null;
    return {
      date: date!, weekday: wd, time, timeZone,
      iso: ms === null ? null : `${date}T${time}:00${utcOffsetLabel(ms, timeZone)}`,
      utc: ms === null ? null : new Date(ms).toISOString(),
      utcOffset: utcOffsetLabel(ms ?? zonedWallToMs(date!, '12:00', timeZone), timeZone),
      basis,
    };
  };

  // Explicit ISO date (optionally with time already extracted).
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) {
    const ymd = iso[0];
    if (new Date(`${ymd}T00:00:00Z`).toISOString().slice(0, 10) !== ymd) return { error: `${ymd} is not a real calendar date` };
    date = ymd; basis = `explicit date ${ymd}`;
    return finish();
  }

  if (text === '' || text === 'now' || text === 'right now' || text === 'today' || text === 'tonight' || text === 'this evening') {
    date = today;
    if (text === '' || text === 'now' || text === 'right now') { time = time ?? nowHm; basis = `now in ${timeZone}`; }
    else basis = `today in ${timeZone}`;
    return finish();
  }
  if (text === 'tomorrow' || text === 'day after tomorrow' || text === 'yesterday' || text === 'day before yesterday') {
    const delta = { tomorrow: 1, 'day after tomorrow': 2, yesterday: -1, 'day before yesterday': -2 }[text]!;
    date = addDaysYmd(today, delta); basis = `${text} = today (${today}) ${delta > 0 ? '+' : ''}${delta} day(s)`;
    return finish();
  }

  const rel = /^(?:in\s+)?(an?|\d+)\s+(minute|min|hour|hr|day|week|month)s?(?:\s+(?:from\s+(?:now|today)|later|ago|from\s+now))?$/.exec(text);
  if (rel) {
    const n = rel[1].startsWith('a') ? 1 : Number(rel[1]);
    const unit = rel[2];
    const back = /\bago$/.test(text);
    const sign = back ? -1 : 1;
    if (unit === 'minute' || unit === 'min' || unit === 'hour' || unit === 'hr') {
      const ms = nowMs + sign * n * (unit.startsWith('h') ? 3_600_000 : 60_000);
      const p = zonedParts(ms, timeZone);
      date = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`; time = `${pad(p.hour)}:${pad(p.minute)}`;
      basis = `${back ? '' : 'in '}${n} ${unit}(s)${back ? ' ago' : ''} from now (${nowHm} ${timeZone})`;
      return finish();
    }
    if (unit === 'month') {
      const total = now.year * 12 + (now.month - 1) + sign * n;
      const y = Math.floor(total / 12), mo = (total % 12) + 1;
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      date = `${pad(y, 4)}-${pad(mo)}-${pad(Math.min(now.day, last))}`; basis = `${n} month(s) ${back ? 'before' : 'after'} today (${today}), clamped to month length`;
      return finish();
    }
    const days = n * (unit === 'week' ? 7 : 1) * sign;
    date = addDaysYmd(today, days); basis = `today (${today}) ${days >= 0 ? '+' : ''}${days} day(s)`;
    return finish();
  }

  const wk = /^(?:(next|this|last|coming|upcoming|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)$/.exec(text);
  if (wk) {
    const qual = wk[1] ?? '';
    const target = WEEKDAYS.indexOf(wk[2]) >= 0 ? WEEKDAYS.indexOf(wk[2]) : WEEKDAY_SHORT[wk[2]];
    if (qual === 'last') {
      const back = ((now.weekday - target + 7) % 7) || 7;
      date = addDaysYmd(today, -back); basis = `most recent ${WEEKDAYS[target]} before today (${WEEKDAYS[now.weekday]} ${today})`;
    } else if (qual === 'next') {
      // "next Friday" = the Friday of the following calendar week (Mon-based), unless that is simply the nearest upcoming one more than a week away.
      const ahead = ((target - now.weekday + 7) % 7) || 7;
      const daysToNextMonday = ((1 - now.weekday + 7) % 7) || 7;
      const targetFromMonday = (target + 6) % 7;
      const nextWeek = daysToNextMonday + targetFromMonday;
      const useNextWeek = ahead < daysToNextMonday; // nearest occurrence is still this week -> "next" means the following week
      const delta = useNextWeek ? nextWeek : ahead;
      date = addDaysYmd(today, delta);
      basis = `"next ${WEEKDAYS[target]}" = ${WEEKDAYS[target]} of the following week from today (${WEEKDAYS[now.weekday]} ${today}) = +${delta} day(s); the nearest upcoming ${WEEKDAYS[target]} is ${addDaysYmd(today, ahead)}`;
    } else {
      const ahead = (target - now.weekday + 7) % 7;
      date = addDaysYmd(today, ahead);
      basis = ahead === 0 ? `today is ${WEEKDAYS[target]}` : `nearest upcoming ${WEEKDAYS[target]} from today (${WEEKDAYS[now.weekday]} ${today}) = +${ahead} day(s)`;
    }
    return finish();
  }

  return { error: `could not resolve "${expression}" deterministically; ask the user for an exact date (YYYY-MM-DD)` };
}

/** Short deterministic calendar the model can read instead of counting days. */
export function upcomingDaysTable(nowMs: number, timeZone: string, days = 14): string {
  const p = zonedParts(nowMs, timeZone);
  const today = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYmd(today, i);
    out.push(`${i === 0 ? 'today' : i === 1 ? 'tomorrow' : `+${i}d`}=${WEEKDAYS[weekdayOfYmd(ymd)].slice(0, 3)} ${ymd}`);
  }
  return out.join('; ');
}
