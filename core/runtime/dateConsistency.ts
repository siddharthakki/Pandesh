/**
 * A reply that names a weekday and a date that do not belong together (re-run C2: the reminder tool said "due Tue 10 Nov,
 * 14:00", the reply said "Tuesday, November 11th" — 11 November 2026 is a Wednesday) is corrected from the dates the
 * turn's tools actually reported. Only a confident correction is made: the tool results must contain exactly one date in
 * that month with the stated weekday.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?';
const WEEKDAY_RE = '(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
// "Tuesday, November 11th" / "Tuesday November 11" and "Tuesday, 11 November" / "Tuesday the 11th of November"
const WEEKDAY_MONTH_DAY = new RegExp(`\\b${WEEKDAY_RE},?\\s+${MONTH_RE}\\s+(\\d{1,2})(st|nd|rd|th)?\\b`, 'g');
const WEEKDAY_DAY_MONTH = new RegExp(`\\b${WEEKDAY_RE},?\\s+(?:the\\s+)?(\\d{1,2})(st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'g');

function monthIndex(name: string): number {
  const n = name.toLowerCase().replace('.', '');
  return MONTHS.findIndex((m) => m.startsWith(n.slice(0, 3)));
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
}

/** Dates (year, month, day) the tools reported: ISO dates and "Tue 10 Nov" style. */
export function toolReportedDates(toolTexts: string[], fallbackYear: number): Array<{ y: number; m: number; d: number }> {
  const out: Array<{ y: number; m: number; d: number }> = [];
  const text = toolTexts.join('\n');
  for (const m of text.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) out.push({ y: +m[1], m: +m[2] - 1, d: +m[3] });
  for (const m of text.matchAll(new RegExp(`\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\w*,?\\s+(\\d{1,2})\\s+${MONTH_RE}(?:\\s+(20\\d\\d))?`, 'g'))) {
    out.push({ y: m[3] ? +m[3] : fallbackYear, m: monthIndex(m[2]), d: +m[1] });
  }
  return out;
}

function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m, d, 12)).getUTCDay();
}

export interface DateFix { text: string; corrections: Array<{ from: string; to: string }> }

export function correctWeekdayDates(reply: string, toolTexts: string[], now: Date = new Date()): DateFix {
  const year = now.getUTCFullYear();
  const reported = toolReportedDates(toolTexts, year);
  if (reported.length === 0) return { text: reply, corrections: [] };
  const corrections: Array<{ from: string; to: string }> = [];
  const fix = (whole: string, weekdayName: string, monthName: string, dayText: string, style: 'md' | 'dm') => {
    const wd = WEEKDAYS.indexOf(weekdayName.toLowerCase());
    const mi = monthIndex(monthName);
    const day = Number(dayText);
    const candidatesYear = reported.filter((r) => r.m === mi).map((r) => r.y);
    const y = candidatesYear[0] ?? year;
    if (mi < 0 || day < 1 || day > 31 || weekdayOf(y, mi, day) === wd) return whole;
    const matches = [...new Map(reported.filter((r) => r.m === mi && weekdayOf(r.y, r.m, r.d) === wd).map((r) => [`${r.y}-${r.m}-${r.d}`, r])).values()];
    if (matches.length !== 1) return whole;
    const right = matches[0].d;
    const to = style === 'md'
      ? whole.replace(new RegExp(`\\b${dayText}(st|nd|rd|th)?\\b`), (_m, suf) => `${right}${suf ? ordinal(right) : ''}`)
      : whole.replace(new RegExp(`\\b${dayText}(st|nd|rd|th)?\\b`), (_m, suf) => `${right}${suf ? ordinal(right) : ''}`);
    corrections.push({ from: whole, to });
    return to;
  };
  let text = reply.replace(WEEKDAY_MONTH_DAY, (whole, wd, mon, day) => fix(whole, wd, mon, day, 'md'));
  text = text.replace(WEEKDAY_DAY_MONTH, (whole, wd, day, _suf, mon) => fix(whole, wd, mon, day, 'dm'));
  return { text, corrections };
}
