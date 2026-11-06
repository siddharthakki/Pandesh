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
  | { kind: 'daily_brief' }
  | { kind: 'start_timer'; durationMs: number; label: string; originalUnit: string }
  | { kind: 'stop_timer'; target?: string }
  | { kind: 'pause_timer'; target?: string }
  | { kind: 'resume_timer'; target?: string }
  | { kind: 'query_timer'; target?: string };

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
  // German number words
  ein: 1,
  eine: 1,
  einer: 1,
  einen: 1,
  eins: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  funf: 5,
  fünf: 5,
  fuenf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  zwanzig: 20,
  dreissig: 30,
  dreißig: 30,
  sechzig: 60,
};

function parseCount(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\d+$/.test(text)) return Number(text);
  if (NUMBER_WORDS[text] != null) return NUMBER_WORDS[text];
  return null;
}

export function parseRelativeDuration(raw: string): { ms: number; label: string } | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const match = text.match(/^(?:in\s+|für\s+|fuer\s+)?(.+?)\s*(minutes?|mins?|minuten?|min|hours?|hrs?|stunden?|std|days?|tage?|seconds?|secs?|sekunden?|sek|s)$/i);
  if (!match) return null;
  const count = parseCount(match[1]);
  if (count == null || count <= 0) return null;
  const unit = match[2].toLowerCase();
  let ms = 0;
  if (unit.startsWith('sec') || unit.startsWith('sek') || unit === 's') ms = count * 1_000;
  else if (unit.startsWith('min') || unit === 'm') ms = count * 60_000;
  else if (unit.startsWith('hour') || unit.startsWith('hr') || unit.startsWith('stund') || unit === 'std' || unit === 'h') ms = count * 3_600_000;
  else if (unit.startsWith('day') || unit.startsWith('tag') || unit === 'd') ms = count * 86_400_000;
  else return null;
  const label = `${count} ${unit}`;
  return { ms, label };
}

/**
 * A request for the briefing Pandesh can produce from real sources.
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
 * Recognizes deterministic timer requests (English and German).
 */
export function parseTimerIntent(text: string): EverydayIntent | null {
  const cleaned = text
    .trim()
    .replace(/^(?:hey\s+pandesh|pandesh|please|can\s+you\s+(?:please\s+)?|bitte)\s*[,:]?\s*/i, '')
    .trim();

  // 1. Query timer remaining time / status
  if (
    /^(?:show\s+(?:me\s+)?(?:the\s+)?remaining\s+time|remaining\s+time|how\s+much\s+time\s+(?:is\s+)?left|timer\s+status|timer\s+remaining)\b/i.test(cleaned) ||
    /^(?:what(?:'s| is)\s+(?:the\s+)?remaining\s+time|how\s+long\s+(?:is\s+)?left\s+on\s+(?:the\s+|my\s+)?timer)\b/i.test(cleaned)
  ) {
    return { kind: 'query_timer' };
  }

  // 2. Pause timer
  if (/^(?:pause|freeze)\s+(?:the\s+|my\s+)?timer\b/i.test(cleaned)) {
    return { kind: 'pause_timer' };
  }

  // 3. Resume timer
  if (/^(?:resume|unpause|continue)\s+(?:the\s+|my\s+)?timer\b/i.test(cleaned)) {
    return { kind: 'resume_timer' };
  }

  // 4. Stop / cancel timer
  if (/^(?:stop|cancel|dismiss|abort)\s+(?:the\s+|my\s+)?timer\b/i.test(cleaned)) {
    return { kind: 'stop_timer' };
  }

  // 5. Start timer: e.g. "start a timer for five minutes and show the countdown in the main chat"
  // "start a 30-second timer and leave the chat open"
  // "start a timer for funf Minuten"
  // "set a timer for 10 seconds"
  // "timer for 5 minutes", "5 minute timer"
  const hyphenatedTimer = cleaned.match(/^(?:start\s+(?:a\s+|an\s+)?|set\s+(?:a\s+|an\s+)?|create\s+(?:a\s+|an\s+)?)?(\w+)-(second|sec|minute|min|hour|hr)\s+timer\b/i);
  if (hyphenatedTimer) {
    const count = parseCount(hyphenatedTimer[1]);
    const unit = hyphenatedTimer[2].toLowerCase();
    if (count != null && count > 0) {
      let ms = 0;
      if (unit.startsWith('sec')) ms = count * 1_000;
      else if (unit.startsWith('min')) ms = count * 60_000;
      else if (unit.startsWith('hour') || unit.startsWith('hr')) ms = count * 3_600_000;
      if (ms > 0) {
        return {
          kind: 'start_timer',
          durationMs: ms,
          label: `${count} ${unit}s`,
          originalUnit: unit,
        };
      }
    }
  }

  const startTimerFor = cleaned.match(/^(?:start\s+(?:a\s+|an\s+)?timer|set\s+(?:a\s+|an\s+)?timer|timer)\s+(?:for\s+|für\s+|fuer\s+|on\s+)?(.+?)(?:\s+(?:and\s+show|and\s+leave|in\s+the\s+main|and\s+keep|please)|[.;!]|$)/i);
  if (startTimerFor) {
    const rawDur = startTimerFor[1].trim();
    const parsed = parseRelativeDuration(rawDur);
    if (parsed && parsed.ms > 0) {
      return {
        kind: 'start_timer',
        durationMs: parsed.ms,
        label: parsed.label,
        originalUnit: rawDur,
      };
    }
  }

  return null;
}

/**
 * Parse a user utterance into an Everyday Tools intent, or null when the
 * message should continue through ordinary Core chat.
 */
export function parseEverydayIntent(text: string, nowMs: number = Date.now()): EverydayIntent | null {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  // Timers take precedence for timer-phrased requests
  const timerIntent = parseTimerIntent(trimmed);
  if (timerIntent) {
    return timerIntent;
  }

  if (looksLikeDailyBrief(trimmed)) {
    return { kind: 'daily_brief' };
  }

  const queueAdd = trimmed.match(/^(?:please\s+)?(?:add\s+to\s+(?:the\s+)?queue|queue)[:\s]+(.+)$/i);
  if (queueAdd?.[1]) {
    return { kind: 'queue_add', instruction: queueAdd[1].trim() };
  }

  const remember = trimmed.match(/^(?:please\s+)?remember(?:\s+(?:that|this))?\s+(.+)$/i);
  if (remember?.[1]) {
    const body = remember[1].trim();
    if (isPersonalFact(body)) {
      return null;
    }
    return { kind: 'remember_note', body };
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
