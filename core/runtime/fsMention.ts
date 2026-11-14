/**
 * Shared, deliberately small: which words in a request are paths. Used by the pre-model status shortcut (to decline
 * filesystem questions) and by the disk-observation guard (to know which folder or file the request names).
 */

/** Words that make "a/b" a slash-separated alternative or a date, not a path ("Gmail/Calendar", "and/or", "Q3/Q4", "Nov/Dec"). */
const NOT_PATH_WORDS = new Set(['and', 'or', 'gmail', 'email', 'emails', 'mail', 'mails', 'calendar', 'notification', 'notifications', 'reminder', 'reminders', 'task', 'tasks', 'status', 'progress', 'update', 'yes', 'no', 'he', 'she', 'his', 'her', 'either', 'read', 'write', 'input', 'output', 'w', 'o', 'n', 'a', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'am', 'pm']);

function cleanToken(raw: string): string {
  return raw.replace(/^[("'`‘“]+|[)"'`’”?!,;:]+$/g, '').replace(/\.$/, '');
}

/** True for a drive path, a UNC path, a ./ ~/ relative path, or a slash-joined name that is not an alternative or a date. */
export function isPathToken(raw: string): boolean {
  const t = cleanToken(raw);
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URLs are not local paths
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('\\\\') || /^(?:~|\.{1,2})[\\/]/.test(t)) return true;
  if (!/[\\/]/.test(t)) return false;
  const segments = t.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 2 && !/[\\/]$/.test(t) && !/^[\\/]/.test(t)) return false;
  if (segments.every((s) => /^\d+$/.test(s) || /^q[1-4]$/i.test(s) || NOT_PATH_WORDS.has(s.toLowerCase()))) return false;
  return segments.some((s) => /[A-Za-z]/.test(s));
}

/** Path tokens in the text, as written. */
export function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text || '').split(/\s+/)) {
    if (isPathToken(raw)) out.push(cleanToken(raw));
  }
  return out;
}
