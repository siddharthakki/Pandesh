/**
 * "No tool result, no claim." A model's reply may only say a real-world action happened (a timer paused, a
 * reminder set, a message sent, a memory stored, a file saved or deleted) when a tool of the matching kind
 * actually succeeded in the same turn. Build 159 audit D1: gemma replied "I've paused the tea timer, while the
 * pasta timer continues to run" with zero tool calls and the timer state unchanged.
 *
 * Pure and deterministic: it inspects the final reply and the names of tools that succeeded in this attempt,
 * replaces each unsupported completion sentence with an explicit marker, and appends one plain statement that
 * the action was not performed. It never calls a model and never executes anything.
 */

export interface ActionClaimCategory {
  kind: string;
  /** What the claim is about (must appear in the same sentence as a completion verb). */
  object: RegExp;
  /** Completion verbs, past tense / passive (matched only in a completion construction, see claimPattern). */
  verbs: string;
  /** A succeeded tool whose name matches this supports the claim. */
  tools: RegExp;
  /** Human wording for the footer. */
  label: string;
  /** Overrides the completion construction built from `verbs` (used for state reports). */
  claim?: RegExp;
}

const CATEGORIES: ActionClaimCategory[] = [
  {
    kind: 'timer',
    object: /\b(?:timers?|countdowns?|alarms?)\b/i,
    verbs: 'paused|resumed|stopped|cancell?ed|started|set|created|restarted|unpaused|dismissed|reset',
    tools: /timer|alarm|countdown/i,
    label: 'timer change',
  },
  {
    // A timer's live state ("the tea timer is paused with 4 minutes remaining") is only known from the timer
    // manager; a model that never queried it is guessing (audit M5 p3).
    kind: 'timer_state',
    object: /\b(?:timers?|countdowns?)\b/i,
    verbs: '',
    claim: /\b(?:is|are)\s+(?:now\s+|currently\s+|still\s+)?(?:paused|running|stopped|cancell?ed|active)\b|\b(?:has\s+)?\d+\s*(?:minutes?|mins?|seconds?|secs?|m|s)\s+(?:remaining|left)\b|\bcontinues?\s+to\s+run\b/i,
    tools: /timer|alarm|countdown/i,
    label: 'timer check',
  },
  {
    kind: 'reminder',
    object: /\b(?:reminders?|remind you|scheduled task|routine)\b/i,
    verbs: 'set|created|added|scheduled|cancell?ed|dismissed|removed|deleted|updated|snoozed',
    tools: /reminder|schedul|routine|commitment/i,
    label: 'reminder change',
  },
  {
    kind: 'calendar',
    object: /\b(?:calendar|events?|appointments?|meetings?)\b/i,
    verbs: 'added|created|scheduled|booked|moved|rescheduled|updated|cancell?ed|deleted|removed',
    tools: /^calendar_(?:create|update|delete)|event/i,
    label: 'calendar change',
  },
  {
    kind: 'message',
    object: /\b(?:e-?mails?|messages?|mail|repl(?:y|ies)|comments?|sms|text|it|them)\b/i,
    verbs: 'sent|emailed|forwarded|delivered|posted|replied|messaged|texted',
    tools: /send|reply|comment|post|jugaad/i,
    label: 'message send',
  },
  {
    kind: 'memory',
    object: /\b(?:memor(?:y|ies)|remember|preferences?|profile)\b/i,
    verbs: 'saved|stored|remembered|noted|added|recorded|forgotten|deleted|removed|updated',
    tools: /^memory_(?:remember|forget|resolve)|remember/i,
    label: 'memory change',
  },
  {
    // "Since pandoc was not available, I installed the utility" while every install attempt failed (re-run of audit M4).
    kind: 'install',
    object: /\b(?:utility|utilities|tools?|apps?|application|program|software|package|driver|pandoc|libreoffice|converter)\b/i,
    verbs: 'installed|set up|downloaded|added|enabled',
    tools: /install|setup|download/i,
    label: 'installation',
  },
  {
    kind: 'file',
    // Only concrete artefacts: a reply that "created a summary below" is prose, not a file claim.
    // "I have prepared a test document" (printer re-run P1, no tool ran) is a concrete artefact claim too.
    object: /[\w.-]+\.(?:pdf|docx?|xlsx?|pptx?|md|txt|csv|html?|json|png|jpe?g|zip)\b|\b(?:files?|folders?|pdfs?)\b|\btest\s+(?:documents?|pages?)\b/i,
    verbs: 'saved|created|written|wrote|exported|generated|converted|moved|renamed|copied|deleted|removed|downloaded|printed|organi[sz]ed|prepared',
    // Tools that produce or change files; read-only tools (read_file, document_read, list_directory, list_printers)
    // never support it.
    tools: /write|propose_|edit|create_note|export|build_|image_generate|comfyui_generate|media_|download|print_|organize_apply|pdf|file_change|delegate_to_opencode/i,
    label: 'file change',
  },
  {
    kind: 'execution',
    object: /\b(?:commands?|actions?|steps?|tasks?|requests?|instructions?|changes?)\b/i,
    verbs: 'executed|carried out|completed|performed|applied|run|ran|done|finished',
    tools: /./,
    label: 'action',
  },
];

function claimPattern(verbs: string): RegExp {
  // "I've paused", "I have now sent", "I just saved", "has been sent", "have been cancelled", "is now paused".
  return new RegExp(
    `\\b(?:i(?:'ve|\\s+have)?\\s+(?:(?:now|just|already|successfully|also)\\s+)*(?:${verbs})\\b` +
      `|\\b(?:has|have)\\s+(?:now\\s+|already\\s+|successfully\\s+)*been\\s+(?:successfully\\s+)?(?:${verbs})\\b` +
      `|\\b(?:is|are)\\s+now\\s+(?:${verbs})\\b)`,
    'i',
  );
}

const COMPILED = CATEGORIES.map((category) => ({ ...category, claim: category.claim ?? claimPattern(category.verbs) }));

export interface ActionClaimResult {
  text: string;
  withheld: Array<{ kind: string; claim: string }>;
}

const MAX_ECHO = 160;
const echo = (value: string): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ECHO ? `${flat.slice(0, MAX_ECHO)}…` : flat;
};

/** The first category whose completion claim in `sentence` is not supported by a succeeded tool, if any. */
export function unsupportedActionClaim(sentence: string, succeededTools: readonly string[]): ActionClaimCategory | null {
  for (const category of COMPILED) {
    if (!category.claim.test(sentence) || !category.object.test(sentence)) continue;
    if (succeededTools.some((tool) => category.tools.test(tool))) continue;
    return category;
  }
  return null;
}

/**
 * Replaces each sentence that claims a completed action no succeeded tool supports. `succeededTools` must be the
 * names of tool invocations recorded as succeeded for this attempt (never model text).
 */
export interface ActionClaimOptions {
  /**
   * Resolves an output file the reply names (a bare name, relative or absolute path) and says whether it exists now.
   * When given, a reply that presents a file as created/saved/available is withheld if the file does not exist,
   * whatever tools ran: a successful write of report.md is not evidence for report.pdf.
   */
  fileExists?: (reference: string) => boolean;
}

const OUTPUT_FILE = /(?:[A-Za-z]:[\\/][^\s`*"'<>|]+|[\w.\\/-]+)\.(?:pdf|docx?|xlsx?|pptx?|md|txt|csv|html?|json|png|jpe?g|zip|odt|rtf)\b/gi;
const OUTPUT_CONTEXT = /\b(?:created|generated|saved|exported|written|wrote|converted|produced|built|stored|ready)\b|\b(?:file\s*path|file|location|saved\s+(?:to|as|at)|output)\s*:|\b(?:you\s+can\s+)?open\s+(?:it|this|the\s+file)\b/i;
const NEGATED = /\b(?:not|never|unable|failed|cannot)\b|n't\b|\bno\s+longer\b/i;

/** Output files a line presents as existing ("File Path: …report.pdf", "I saved it as notes.txt"). */
export function claimedOutputFiles(line: string): string[] {
  if (!OUTPUT_CONTEXT.test(line) || NEGATED.test(line)) return [];
  return [...new Set([...line.matchAll(OUTPUT_FILE)].map((m) => m[0].replace(/^[`*"'(]+|[`*"').,:;]+$/g, '')))];
}

export function withholdUnsupportedActionClaims(message: string, succeededTools: readonly string[], options: ActionClaimOptions = {}): ActionClaimResult {
  const withheld: ActionClaimResult['withheld'] = [];
  const out: string[] = [];
  let inFence = false;
  for (const line of message.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence || !line.trim()) { out.push(line); continue; }
    const sentences = line.split(/(?<=[.!?])\s+/);
    let changed = false;
    const kept = sentences.map((sentence) => {
      if (options.fileExists) {
        const missing = claimedOutputFiles(sentence).filter((file) => !options.fileExists!(file));
        if (missing.length > 0) {
          changed = true;
          withheld.push({ kind: 'missing_file', claim: echo(sentence) });
          return `[Not done: ${missing.join(', ')} does not exist — it was not created.]`;
        }
      }
      const category = unsupportedActionClaim(sentence, succeededTools);
      if (!category) return sentence;
      changed = true;
      withheld.push({ kind: category.kind, claim: echo(sentence) });
      return `[Not done: no ${category.label} was performed — no tool confirmed it.]`;
    });
    out.push(changed ? kept.join(' ') : line);
  }
  if (withheld.length === 0) return { text: message, withheld };
  const performed = succeededTools.length > 0 ? `Tools that actually succeeded this turn: ${[...new Set(succeededTools)].join(', ')}.` : 'No tool ran this turn.';
  out.push('', `**Not performed:** the reply above claimed an action that no tool carried out, so nothing changed. ${performed}`);
  return { text: out.join('\n'), withheld };
}
