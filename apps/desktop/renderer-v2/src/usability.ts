/**
 * Daily-use notes for the navigation trial: what the person writes down when something was hard to find, plus a per-day count of
 * which places were opened. Kept in this window's own local storage only (nothing is sent anywhere, Core is not involved), so the
 * owner can copy it out after a week. It records where the person was, never what they typed to Pandesh.
 */
export interface UsabilityNote { at: string; where: string; text: string }
export type DayCounts = Record<string, number>;

const NOTES = 'pandesh.v2.usabilityNotes';
const COUNTS = 'pandesh.v2.usabilityCounts';
const MAX_NOTES = 300;
const MAX_DAYS = 31;

const read = <T,>(key: string, fallback: T): T => { try { const v = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; return v ?? fallback; } catch { return fallback; } };
const write = (key: string, value: unknown): void => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: the note is simply not kept */ } };
const dayOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function listNotes(): UsabilityNote[] { const v = read<UsabilityNote[]>(NOTES, []); return Array.isArray(v) ? v : []; }
export function addNote(where: string, text: string, now: Date = new Date()): UsabilityNote[] {
  const t = text.trim();
  if (!t) return listNotes();
  const next = [...listNotes(), { at: now.toISOString(), where, text: t.slice(0, 1000) }].slice(-MAX_NOTES);
  write(NOTES, next);
  return next;
}
export function clearNotes(): void { write(NOTES, []); write(COUNTS, {}); }

export function allCounts(): Record<string, DayCounts> { const v = read<Record<string, DayCounts>>(COUNTS, {}); return v && typeof v === 'object' ? v : {}; }
/** One more visit to `what` (a place, an app page, or `palette`) today. */
export function countVisit(what: string, now: Date = new Date()): void {
  const all = allCounts();
  const day = dayOf(now);
  all[day] = { ...(all[day] ?? {}), [what]: (all[day]?.[what] ?? 0) + 1 };
  const keep = Object.keys(all).sort().slice(-MAX_DAYS);
  write(COUNTS, Object.fromEntries(keep.map((k) => [k, all[k]])));
}

/** Plain text of everything collected, for copying into a message or a file. */
export function usabilityReport(notes: UsabilityNote[] = listNotes(), counts: Record<string, DayCounts> = allCounts()): string {
  const days = Object.keys(counts).sort();
  const lines = [`Pandesh navigation trial: ${days.length} day(s) with use, ${notes.length} note(s).`, '', 'Opened per day:'];
  for (const d of days) lines.push(`  ${d}: ${Object.entries(counts[d]!).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (!days.length) lines.push('  (nothing recorded yet)');
  lines.push('', 'Notes:');
  for (const n of notes) lines.push(`  ${n.at.slice(0, 16).replace('T', ' ')} [${n.where}] ${n.text}`);
  if (!notes.length) lines.push('  (none)');
  return lines.join('\n');
}
