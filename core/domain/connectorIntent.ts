/**
 * Request-intent guard for connector mutations, enforced at the dispatch boundary.
 *
 * Invariant: a request that asks only to READ or SUGGEST (availability, free slots, "without creating events")
 * never reaches an approval for a calendar mutation. The model may propose `calendar_draft_event` for a
 * suggestion-only request; Core refuses it before any approval exists, so the user is never asked to authorize
 * something they explicitly excluded.
 *
 * The guard fails open for ambiguous follow-ups ("yes, go ahead", "the second one"): those still need the human
 * approval card. It only closes the case where the user's own words are read-only.
 */

const CALENDAR_MUTATION_TOOLS = new Set([
  'calendar_draft_event',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
]);

const MUTATING_STEM = '(?:creat|book|schedul|add|mak|send|invit|chang|modif|updat|delet|put|mutat|writ|sav)\\w*';

/** "without creating events", "don't book anything", "do not schedule", "no events", "read-only". */
const NEGATED = new RegExp(
  `\\b(?:without|don'?t|do not|never|no need to|avoid|instead of|rather than|not to|stop)\\s+(?:(?:actually|yet|really|even|just|any|an?|the|new|calendar|forget)\\s+){0,2}${MUTATING_STEM}`
  + '|\\bno\\s+(?:new\\s+)?(?:events?|meetings?|invites?|appointments?|bookings?)\\b'
  + '|\\bread[- ]only\\b',
  'i',
);

/** "when am I free", "suggest three slots", "find a time", "what's my availability". */
const ADVISORY = new RegExp(
  '\\bwhen\\s+(?:am\\s+i|are\\s+we|is\\s+\\w+)\\s+(?:free|available)\\b'
  + '|\\b(?:am\\s+i|are\\s+we)\\s+(?:free|available)\\b'
  + '|\\b(?:free|available|open)\\s+(?:slots?|times?|windows?|time)\\b'
  + '|\\bavailability\\b'
  + '|\\b(?:suggest|propose|recommend|find|show|list|check|give|offer|pick)\\b[^.!?\\n]{0,60}\\b(?:slots?|times?|windows?|options?|availability|free|available)\\b',
  'i',
);

/** An imperative that really orders a change: at a clause start, or joined by "and/then/also/please". */
const AFFIRMATIVE = /(?:^|[.!?\n,;]\s*|\b(?:and|then|also|please)\s+)(?:go ahead and\s+)?(?:book|schedule|create|add|reserve|block|reschedule|cancel|delete|remove|move|invite|put|set\s+up|update|change)\b/i;

const GMAIL_MUTATION_TOOLS = new Set(['gmail_apply_plan', 'gmail_undo_plan']);

/** "analyze my inbox", "how many", "group by sender", "preview" - looking, not changing. */
const GMAIL_ADVISORY = /\b(?:analy[sz]e|analysis|summari[sz]e|how many|count|group|classify|break ?down|overview|which|what|show|list|preview|report)\b/i;
const GMAIL_AFFIRMATIVE = /(?:^|[.!?\n,;]\s*|\b(?:and|then|also|please)\s+)(?:go ahead and\s+)?(?:organi[sz]e|archive|move|label|categori[sz]e|recategori[sz]e|apply|clean\s*up|sort|tidy|undo|restore|revert|put|mark|tag|file)\b/i;

export type ConnectorIntentVerdict = { allowed: true } | { allowed: false; reason: string };

export function isCalendarMutationTool(toolName: string): boolean {
  return CALENDAR_MUTATION_TOOLS.has(toolName);
}

/** Decides, from the user's own request text, whether a calendar mutation tool may even ask for approval. */
export function judgeCalendarMutationIntent(toolName: string, requestText: string | null | undefined): ConnectorIntentVerdict {
  if (!isCalendarMutationTool(toolName)) return { allowed: true };
  const text = String(requestText ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { allowed: true };
  const negated = NEGATED.test(text);
  const advisoryOnly = !negated && ADVISORY.test(text) && !AFFIRMATIVE.test(text);
  if (!negated && !advisoryOnly) return { allowed: true };
  return {
    allowed: false,
    reason:
      `REFUSED, nothing was created or changed and no approval was requested: the user asked only for availability or suggestions `
      + `(or said not to create events), so ${toolName} was not allowed. Use calendar_check_availability or calendar_list_events `
      + 'and answer in text. Ask before creating anything.',
  };
}

/** Inbox changes need the user to have asked for a change; an analysis or preview request never reaches an approval. */
export function judgeGmailMutationIntent(toolName: string, requestText: string | null | undefined): ConnectorIntentVerdict {
  if (!GMAIL_MUTATION_TOOLS.has(toolName)) return { allowed: true };
  const text = String(requestText ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { allowed: true };
  const negated = NEGATED.test(text) || /\b(?:don'?t|do not|without)\s+(?:\w+\s+){0,2}(?:organi[sz]|archiv|mov|label|categori[sz]|chang|touch|modif)\w*/i.test(text);
  const advisoryOnly = !negated && GMAIL_ADVISORY.test(text) && !GMAIL_AFFIRMATIVE.test(text);
  if (!negated && !advisoryOnly) return { allowed: true };
  return {
    allowed: false,
    reason:
      `REFUSED, nothing in Gmail was changed and no approval was requested: the user asked only to look at or analyze mail `
      + `(or said not to change it), so ${toolName} was not allowed. Present the analysis or preview as text and ask before changing anything.`,
  };
}

/** One entry point for the dispatch boundary: every connector's mutation tools are judged against the user's own words. */
export function judgeConnectorMutationIntent(toolName: string, requestText: string | null | undefined): ConnectorIntentVerdict {
  const calendar = judgeCalendarMutationIntent(toolName, requestText);
  if (!calendar.allowed) return calendar;
  return judgeGmailMutationIntent(toolName, requestText);
}
