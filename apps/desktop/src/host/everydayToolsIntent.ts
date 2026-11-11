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
  | { kind: 'start_timer'; durationMs: number; label: string; originalUnit: string; secondary?: { durationMs: number; label: string } }
  | { kind: 'stop_timer'; target?: string; also?: TimerActionIntent[] }
  | { kind: 'pause_timer'; target?: string; also?: TimerActionIntent[] }
  | { kind: 'resume_timer'; target?: string; also?: TimerActionIntent[] }
  | { kind: 'query_timer'; target?: string; also?: TimerActionIntent[] };

/** A single pause/resume/stop/query timer action (compound commands carry the rest in `also`). */
export type TimerActionIntent = {
  kind: 'stop_timer' | 'pause_timer' | 'resume_timer' | 'query_timer';
  target?: string;
};

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

/**
 * Alpha e2e T5: "Remember this harmless test fact: Project Firefly's review meeting is on Tuesday … Save it with source
 * provenance. Confirm what you actually stored." became a plain host note (no Core memory, no provenance, nothing
 * shown in v2). A message that asks for memory itself, a fact, provenance or a confirmation, or carries more than one
 * sentence, is a request for the assistant, not a one-line jotting.
 */
export function wantsAssistantMemory(body: string): boolean {
  const text = body.trim();
  if (/^to\s+/i.test(text)) return false;
  return /\b(?:memor(?:y|ies|i[sz]e)|provenance|facts?|save\s+(?:it|this|that)|store\s+(?:it|this|that)|confirm|verify|recall)\b/i.test(text)
    || /[.!?;]\s+\S/.test(text)
    // Micro-test EDU-018: "Remember my new vocabulary only in this study session" asks for scoped memory, not a note.
    || /\b(?:only|just)\s+(?:in|for|during)\s+(?:this|the|our)\s+(?:session|conversation|chat|exercise|lesson|study session)\b/i.test(text);
}

/** "my home is Ulm", "about me: ...", "I live in ...", "I prefer ...", "not Karlsruhe": statements about the person themself. */
export function isPersonalFact(body: string): boolean {
  const text = body.trim();
  if (/^to\s+/i.test(text)) return false; // "remember to call John" is a jotting
  // "our flour supplier is \u2026" / "we deliver on Tuesdays" are facts about the user's own household or business (live demo
  // 2026-11-09: they were saved as a plain note, so memory recall and the Second Brain never found them).
  return /\b(?:about (?:me|us)|(?:my|our)\s+\w+(?:\s+\w+){0,3}\s+(?:is|are|was|were)|i\s+(?:am|live|work|prefer|like|use|speak|moved)|we\s+(?:are|live|work|prefer|like|use|sell|deliver|open|close|run|own|charge|offer)|i['\u2019]m|we['\u2019]re|(?:is|are)\s+(?:in|at)\s+\w+,?\s+not|correction)\b/i.test(text)
    || /\bmy\s+(?:home|address|city|name|birthday|timezone|time zone|language|job|company|email|phone)\b/i.test(text)
    // Micro-test FIN-021: "Remember my synthetic test stock watchlist: NVDA and SAP" became a note the next question never
    // found. "my/our <thing>: <value>" is a fact about the user's own things.
    || /^(?:my|our)\s+[\w\s'-]{1,60}?:\s*\S/i.test(text);
}

/**
 * Recognizes deterministic timer requests (English and German).
 */
export function parseTimerIntent(text: string): EverydayIntent | null {
  const compound = parseCompoundTimerIntent(text);
  if (compound) return compound;
  return parseSingleTimerIntent(text);
}

/** "keep/leave the pasta timer running" — an explicit instruction to NOT touch a timer. */
const TIMER_KEEP_CLAUSE = /^(?:leave|keep)\s+(?:the\s+|my\s+)?(?:[\w-]+\s+){0,3}?timer\s+(?:running|going|as\s+it\s+is|alone)$/i;

/**
 * Compound timer commands such as "Pause the tea timer, but leave the pasta timer running" or
 * "Resume the tea timer and cancel the pasta timer". Every clause must be a recognised
 * pause/resume/stop/query action (or an explicit keep-running clause); otherwise this returns null
 * and the caller falls back to single-command parsing, so nothing is half-understood.
 */
function parseCompoundTimerIntent(text: string): EverydayIntent | null {
  if (!/\btimers?\b/i.test(text)) return null;
  const clauses = text
    .trim()
    .split(/\s*(?:,\s*)?\b(?:and(?:\s+then)?|but|then)\b\s+|\s*;\s*/i)
    .map((c) => c.trim().replace(/[.!?]+$/, '').trim())
    .filter(Boolean);
  if (clauses.length < 2) return null;
  const actions: TimerActionIntent[] = [];
  for (const clause of clauses) {
    if (TIMER_KEEP_CLAUSE.test(clause)) continue;
    const parsed = parseSingleTimerIntent(clause);
    if (!parsed || parsed.kind === 'start_timer' || !['stop_timer', 'pause_timer', 'resume_timer', 'query_timer'].includes(parsed.kind)) return null;
    actions.push({ kind: parsed.kind as TimerActionIntent['kind'], target: (parsed as TimerActionIntent).target });
  }
  if (actions.length === 0) return null;
  const [first, ...rest] = actions;
  return rest.length ? { ...first, also: rest } : first;
}

function parseSingleTimerIntent(text: string): EverydayIntent | null {
  const cleaned = text
    .trim()
    .replace(/^(?:hey\s+pandesh|pandesh|please|can\s+you\s+(?:please\s+)?|bitte)\s*[,:]?\s*/i, '')
    .replace(/[.!?]+$/, '')
    .trim();

  // 1. Query timer remaining time / status
  const queryText = cleaned.replace(/^(?:(?:tell|show)\s+me|let\s+me\s+know)\s+/i, '');
  if (
    /^(?:show\s+(?:me\s+)?(?:the\s+)?remaining\s+time|remaining\s+time|how\s+much\s+time\s+(?:is\s+)?left|timer\s+status|timer\s+remaining)\b/i.test(queryText) ||
    /^(?:what(?:'s| is)\s+(?:the\s+)?remaining\s+time|how\s+long\s+(?:is\s+)?left\s+on\s+(?:the\s+|my\s+)?timer)\b/i.test(queryText)
  ) {
    const targetMatch = queryText.match(/(?:for|on)\s+(.+)$/i);
    let target = targetMatch ? targetMatch[1].trim() : undefined;
    // "on each timer", "on all timers", "on both timers", "on my timers" mean every active timer.
    if (target && /^(?:(?:each|every|all|both)(?:\s+(?:of\s+)?(?:the\s+|my\s+)?)?|(?:the\s+|my\s+))?timers?$/i.test(target)) target = undefined;
    else if (target) target = target.replace(/^(?:the|my)\s+/i, '').replace(/\s+timer$/i, '').trim() || undefined;
    return { kind: 'query_timer', target };
  }

  // 2. Pause timer
  const pauseMatch = cleaned.match(/^(?:pause|freeze)\s+(?:the\s+|my\s+)?(?:timer\s*(?:for\s+|id:)?|countdown\s*(?:for\s+|id:)?)(.*)$/i);
  if (pauseMatch) {
    const target = pauseMatch[1]?.trim() || undefined;
    return { kind: 'pause_timer', target };
  }
  if (/^(?:pause|freeze)\s+(?:the\s+|my\s+)?(short|long|first|second)\s+timer\b/i.test(cleaned)) {
    const m = cleaned.match(/^(?:pause|freeze)\s+(?:the\s+|my\s+)?(short|long|first|second)\s+timer\b/i);
    return { kind: 'pause_timer', target: m ? m[1].trim() : undefined };
  }
  // "pause the tea timer" — a timer named by its label.
  const pauseLabelled = cleaned.match(/^(?:pause|freeze)\s+(?:the\s+|my\s+)?((?:[\w-]+\s+){0,2}[\w-]+)\s+timer$/i);
  if (pauseLabelled) return { kind: 'pause_timer', target: pauseLabelled[1].trim() };

  // 3. Resume timer
  const resumeMatch = cleaned.match(/^(?:resume|unpause|continue)\s+(?:the\s+|my\s+)?(?:timer\s*(?:for\s+|id:)?|countdown\s*(?:for\s+|id:)?)(.*)$/i);
  if (resumeMatch) {
    const target = resumeMatch[1]?.trim() || undefined;
    return { kind: 'resume_timer', target };
  }
  if (/^(?:resume|unpause|continue)\s+(?:the\s+|my\s+)?(short|long|first|second)\s+timer\b/i.test(cleaned)) {
    const m = cleaned.match(/^(?:resume|unpause|continue)\s+(?:the\s+|my\s+)?(short|long|first|second)\s+timer\b/i);
    return { kind: 'resume_timer', target: m ? m[1].trim() : undefined };
  }
  const resumeLabelled = cleaned.match(/^(?:resume|unpause|continue)\s+(?:the\s+|my\s+)?((?:[\w-]+\s+){0,2}[\w-]+)\s+timer$/i);
  if (resumeLabelled) return { kind: 'resume_timer', target: resumeLabelled[1].trim() };

  // 4. Stop / cancel timer
  const stopMatch = cleaned.match(/^(?:stop|cancel|dismiss|abort)\s+(?:the\s+|my\s+)?(?:timer\s*(?:for\s+|id:)?|countdown\s*(?:for\s+|id:)?)(.*)$/i);
  if (stopMatch) {
    const target = stopMatch[1]?.trim() || undefined;
    return { kind: 'stop_timer', target };
  }
  if (/^(?:stop|cancel|dismiss|abort)\s+(?:the\s+|my\s+)?(short|long|first|second)\s+timer\b/i.test(cleaned)) {
    const m = cleaned.match(/^(?:stop|cancel|dismiss|abort)\s+(?:the\s+|my\s+)?(short|long|first|second)\s+timer\b/i);
    return { kind: 'stop_timer', target: m ? m[1].trim() : undefined };
  }
  const stopLabelled = cleaned.match(/^(?:stop|cancel|dismiss|abort)\s+(?:the\s+|my\s+)?((?:[\w-]+\s+){0,2}[\w-]+)\s+timer$/i);
  if (stopLabelled) return { kind: 'stop_timer', target: stopLabelled[1].trim() };

  // 5. Multi-timer / compound timers (RWTS-322):
  // e.g. "start a 3-minute tea timer and a 10-minute pasta timer"
  const multiTimerMatch = cleaned.match(/(?:start|set)\s+(?:a\s+|an\s+)?(\w+)-(second|sec|minute|min|hour|hr)\s+([a-zA-Z]+)?\s*timer\s+and\s+(?:a\s+|an\s+)?(\w+)-(second|sec|minute|min|hour|hr)\s+([a-zA-Z]+)?\s*timer/i);
  if (multiTimerMatch) {
    const c1 = parseCount(multiTimerMatch[1]);
    const u1 = multiTimerMatch[2].toLowerCase();
    const l1 = multiTimerMatch[3] ? `${c1}m ${multiTimerMatch[3]} timer` : `${c1} ${u1}s`;
    let ms1 = 0;
    if (u1.startsWith('sec')) ms1 = (c1 || 1) * 1000;
    else if (u1.startsWith('min')) ms1 = (c1 || 1) * 60000;
    else if (u1.startsWith('hour') || u1.startsWith('hr')) ms1 = (c1 || 1) * 3600000;

    const c2 = parseCount(multiTimerMatch[4]);
    const u2 = multiTimerMatch[5].toLowerCase();
    const l2 = multiTimerMatch[6] ? `${c2}m ${multiTimerMatch[6]} timer` : `${c2} ${u2}s`;
    let ms2 = 0;
    if (u2.startsWith('sec')) ms2 = (c2 || 1) * 1000;
    else if (u2.startsWith('min')) ms2 = (c2 || 1) * 60000;
    else if (u2.startsWith('hour') || u2.startsWith('hr')) ms2 = (c2 || 1) * 3600000;

    return {
      kind: 'start_timer',
      durationMs: ms1,
      label: l1,
      originalUnit: u1,
      secondary: {
        durationMs: ms2,
        label: l2,
      },
    };
  }

  // 6. When timer finishes (RWTS-283)
  const whenTimerFinishes = cleaned.match(/^(?:when|after)\s+(?:my\s+|the\s+)?(\w+)-(second|sec|minute|min|hour|hr)\s+timer\s+(?:finishes|ends|expires|completes)\b/i);
  if (whenTimerFinishes) {
    const count = parseCount(whenTimerFinishes[1]);
    const unit = whenTimerFinishes[2].toLowerCase();
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

  // 7. Start timer: e.g. "start a timer for five minutes and show the countdown in the main chat"
  // "start a 30-second timer and leave the chat open"
  // "start a timer for funf Minuten"
  // "set a timer for 10 seconds"
  // "timer for 5 minutes", "5 minute timer", "start a timer; switch conversations"
  const hyphenatedTimer = cleaned.match(/(?:^|then\s+|;\s*)\s*(?:start\s+(?:a\s+|an\s+)?|set\s+(?:a\s+|an\s+)?|create\s+(?:a\s+|an\s+)?)?(\w+)-(second|sec|minute|min|hour|hr)\s+timer\b/i);
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

  const startTimerFor = cleaned.match(/(?:^|then\s+|;\s*)\s*(?:start\s+(?:a\s+|an\s+)?timer|set\s+(?:a\s+|an\s+)?timer|timer)(?:\s+(?:for\s+|für\s+|fuer\s+|on\s+)?(.+?))?(?:\s+(?:and\s+show|and\s+leave|in\s+the\s+main|and\s+keep|while|switch|please)|[.;!]|$)/i);
  if (startTimerFor) {
    const rawDur = startTimerFor[1]?.trim();
    if (rawDur) {
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
    // If no duration provided (e.g. "Start a timer; switch conversations"), default to 5 minutes
    return {
      kind: 'start_timer',
      durationMs: 300_000,
      label: '5 minutes',
      originalUnit: '5 minutes',
    };
  }

  return null;
}

/** Intents whose shortcut creates, changes or runs something. A Plan only conversation never takes these shortcuts. */
const ACTING_INTENTS: ReadonlySet<EverydayIntent['kind']> = new Set<EverydayIntent['kind']>([
  'remember_note', 'create_reminder', 'complete_reminder', 'cancel_reminder', 'queue_add',
  'start_timer', 'stop_timer', 'pause_timer', 'resume_timer',
]);

export function everydayIntentActs(intent: EverydayIntent): boolean {
  return ACTING_INTENTS.has(intent.kind);
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
    if (isPersonalFact(body) || wantsAssistantMemory(body)) {
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
