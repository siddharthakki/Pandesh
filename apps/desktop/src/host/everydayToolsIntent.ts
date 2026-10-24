/**
 * Deterministic Everyday Tools intents for text and voice (no repository).
 * Ambiguous dates fall back to null so Core chat can still handle them.
 */

export type EverydayIntent =
  | { kind: 'remember_note'; body: string }
  | { kind: 'find_notes'; query: string }
  | { kind: 'create_reminder'; title: string; dueAt: string; relativeLabel: string }
  | { kind: 'list_reminders' }
  | { kind: 'complete_reminder'; query: string }
  | { kind: 'cancel_reminder'; query: string }
  | { kind: 'queue_add'; instruction: string }
  | { kind: 'daily_brief' };

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fortyfive: 45,
  'forty-five': 45,
  sixty: 60,
};

function parseCount(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\d+$/.test(text)) return Number(text);
  if (NUMBER_WORDS[text] != null) return NUMBER_WORDS[text];
  return null;
}

function parseRelativeDuration(raw: string): { ms: number; label: string } | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const match = text.match(/^(?:in\s+)?(.+?)\s*(minutes?|mins?|hours?|hrs?|days?|seconds?|secs?)$/i);
  if (!match) return null;
  const count = parseCount(match[1]);
  if (count == null || count <= 0) return null;
  const unit = match[2].toLowerCase();
  let ms = 0;
  if (unit.startsWith('sec')) ms = count * 1_000;
  else if (unit.startsWith('min')) ms = count * 60_000;
  else if (unit.startsWith('hour') || unit.startsWith('hr')) ms = count * 3_600_000;
  else if (unit.startsWith('day')) ms = count * 86_400_000;
  else return null;
  const label = `${count} ${unit}`;
  return { ms, label };
}

/**
 * A request for the briefing Pandesh can produce from real sources.
 *
 * Deliberately narrow and anchored: a message that asks for a brief, a plate,
 * an agenda or a daily summary. A long instruction that merely mentions the
 * word "brief" (for example a coding task about a design brief) is never
 * hijacked — a real request for the briefing is short.
 */
const DAILY_BRIEF_PATTERNS: RegExp[] = [
  /^(?:please\s+)?(?:give|show|send|read)\s+me\s+(?:my\s+|the\s+|a\s+)?(?:daily\s+|today'?s\s+)?brief(?:ing)?(?:\s+for\s+today)?\s*[.!?]?$/i,
  /^(?:please\s+)?what(?:'s| is)\s+on\s+(?:my\s+)?(?:plate|agenda)(?:\s+(?:today|right\s+now))?\s*[.!?]?$/i,
  /^(?:what(?:'s| is)\s+)?(?:on\s+)?my\s+plate\s+(?:today|right\s+now|for\s+today)\s*[.!?]?$/i,
  /^(?:what\s+do\s+i\s+have\s+(?:on\s+)?today)\s*[.!?]?$/i,
  /^(?:what(?:'s| is)\s+)?(?:today'?s|today)\s+(?:schedule|agenda)\s*[.!?]?$/i,
  /^(?:please\s+)?(?:refresh|update|rerun)\s+(?:my\s+|the\s+)?(?:daily\s+)?brief(?:ing)?\s*[.!?]?$/i,
  /^(?:daily\s+brief(?:ing)?|my\s+brief(?:ing)?|the\s+brief(?:ing)?)\s*[.!?]?$/i,
  /^(?:summar(?:y|ise|ize)\s+(?:my\s+)?day)\s*[.!?]?$/i,
  /^(?:brief\s+me)\s*[.!?]?$/i,
];

function looksLikeDailyBrief(text: string): boolean {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > 120) return false;
  return DAILY_BRIEF_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** "my home is Ulm", "about me: ...", "I live in ...", "I prefer ...", "not Karlsruhe": statements about the person themself. */
export function isPersonalFact(body: string): boolean {
  const text = body.trim();
  if (/^to\s+/i.test(text)) return false; // "remember to call John" is a jotting
  return /\b(?:about me|my\s+\w+(?:\s+\w+){0,3}\s+(?:is|are|was|were)|i\s+(?:am|live|work|prefer|like|use|speak|moved)|i['\u2019]m|(?:is|are)\s+(?:in|at)\s+\w+,?\s+not|correction)\b/i.test(text)
    || /\bmy\s+(?:home|address|city|name|birthday|timezone|time zone|language|job|company|email|phone)\b/i.test(text);
}

/**
 * Parse a user utterance into an Everyday Tools intent, or null when the
 * message should continue through ordinary Core chat.
 */
export function parseEverydayIntent(text: string, nowMs: number = Date.now()): EverydayIntent | null {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  if (looksLikeDailyBrief(trimmed)) {
    return { kind: 'daily_brief' };
  }

  const queueAdd = trimmed.match(/^(?:please\s+)?(?:add\s+to\s+(?:the\s+)?queue|queue)[:\s]+(.+)$/i);
  if (queueAdd?.[1]) {
    return { kind: 'queue_add', instruction: queueAdd[1].trim() };
  }

  const remember = trimmed.match(/^(?:please\s+)?remember(?:\s+(?:that|this))?\s+(.+)$/i);
  if (remember?.[1]) {
    // A fact about the person (where they live, what they prefer, a correction) is durable memory, not a loose note:
    // it goes to the assistant's governed memory so it is recalled in later conversations. Only a plain "remember to ..."
    // style jotting stays a note.
    if (isPersonalFact(remember[1])) return null;
    return { kind: 'remember_note', body: remember[1].trim() };
  }

  const findAbout = trimmed.match(
    /^(?:what\s+(?:did|do)\s+i\s+(?:say|note|remember|write).*?(?:about|for|regarding)\s+|find\s+notes?(?:\s+about|\s+for|\s+regarding)?\s+|recall\s+(?:notes?\s+)?(?:about\s+)?)(.+)$/i,
  );
  if (findAbout?.[1]) {
    return { kind: 'find_notes', query: findAbout[1].trim().replace(/[?.!]+$/, '') };
  }

  const listRem = /^(?:list|show|what are)\s+(?:my\s+)?reminders?\b/i.test(trimmed);
  if (listRem) return { kind: 'list_reminders' };

  const complete = trimmed.match(/^(?:complete|done|finish|mark\s+(?:as\s+)?done)\s+reminder\s+(.+)$/i);
  if (complete?.[1]) return { kind: 'complete_reminder', query: complete[1].trim() };

  const cancel = trimmed.match(/^(?:cancel|dismiss)\s+reminder\s+(.+)$/i);
  if (cancel?.[1]) return { kind: 'cancel_reminder', query: cancel[1].trim() };

  // Remind me in two minutes to check the oven
  const remindInTo = trimmed.match(
    /^(?:please\s+)?remind(?:\s+me)?\s+in\s+(.+?)\s+to\s+(.+)$/i,
  );
  if (remindInTo) {
    const duration = parseRelativeDuration(remindInTo[1]);
    if (!duration) return null;
    return {
      kind: 'create_reminder',
      title: remindInTo[2].trim().replace(/[?.!]+$/, ''),
      dueAt: new Date(nowMs + duration.ms).toISOString(),
      relativeLabel: duration.label,
    };
  }

  // Remind me to check the oven in two minutes
  const remindToIn = trimmed.match(
    /^(?:please\s+)?remind(?:\s+me)?\s+to\s+(.+?)\s+in\s+(.+)$/i,
  );
  if (remindToIn) {
    const duration = parseRelativeDuration(remindToIn[2]);
    if (!duration) return null;
    return {
      kind: 'create_reminder',
      title: remindToIn[1].trim().replace(/[?.!]+$/, ''),
      dueAt: new Date(nowMs + duration.ms).toISOString(),
      relativeLabel: duration.label,
    };
  }

  return null;
}

export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function formatLocalInstant(isoUtc: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(isoUtc));
  } catch {
    return isoUtc;
  }
}
