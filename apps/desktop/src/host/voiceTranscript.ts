/**
 * Post-recognition text handling for voice input. Runs on the host so the
 * renderer and tests share one decision:
 *
 * - `correctVoiceVocabulary` snaps near-miss spellings of the product's own
 *   vocabulary (Gmail, Calendar, Pandesh, Promotions, …) to the canonical
 *   form. It only touches words that are one or two edits away from a term,
 *   never words that are common English on their own ("email", "panda").
 * - `voiceTranscriptReview` decides whether a transcript may be sent straight
 *   to the assistant. Anything that asks for a change (send, delete, archive,
 *   label, …), is very short, or was altered by vocabulary correction goes to
 *   the composer for the person to read and confirm first.
 */

export const VOICE_VOCABULARY = ['Gmail', 'Calendar', 'Pandesh', 'Promotions', 'Inbox', 'Newsletters', 'Google'] as const;

/** Real words one edit away from a vocabulary term; left alone. */
const PROTECTED_WORDS = new Set(['email', 'emails', 'mail', 'mails', 'promotion', 'newsletter', 'panda', 'calendars', 'inboxes']);

const CONSEQUENTIAL_VERBS = [
  'send', 'sending', 'delete', 'deleting', 'remove', 'removing', 'archive', 'archiving', 'move', 'moving',
  'label', 'labels', 'labelling', 'labeling', 'categorize', 'categorise', 'categorizing', 'sort', 'sorting',
  'apply', 'create', 'add', 'book', 'schedule', 'cancel', 'reply', 'forward', 'approve', 'reject', 'pay',
  'buy', 'transfer', 'empty', 'trash', 'unsubscribe', 'invite', 'update', 'change', 'edit', 'post', 'publish',
  'print', 'restart', 'shutdown', 'shut', 'kill', 'mark', 'undo', 'reschedule', 'accept', 'decline',
];

export interface VoiceTranscriptReview {
  /** True when the person must read and confirm the text before it is submitted. */
  required: boolean;
  reasons: string[];
  /** The vocabulary-corrected text the composer should show. */
  text: string;
  /** Each word that was changed, as `heard -> corrected`. */
  corrections: string[];
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diagonal : 1 + Math.min(diagonal, prev[j], prev[j - 1]);
      diagonal = saved;
    }
  }
  return prev[b.length];
}

function canonicalFor(word: string): string | null {
  const lower = word.toLowerCase();
  if (lower.length < 4 || PROTECTED_WORDS.has(lower)) return null;
  for (const term of VOICE_VOCABULARY) {
    if (lower === term.toLowerCase()) return null;
  }
  const allowed = lower.length <= 7 ? 1 : 2;
  let best: { term: string; distance: number } | null = null;
  for (const term of VOICE_VOCABULARY) {
    const distance = editDistance(lower, term.toLowerCase());
    if (distance <= allowed && (!best || distance < best.distance)) best = { term, distance };
  }
  return best?.term ?? null;
}

export function correctVoiceVocabulary(text: string): { text: string; corrections: string[] } {
  const corrections: string[] = [];
  const corrected = text.replace(/[A-Za-z]+/g, (word) => {
    const canonical = canonicalFor(word);
    if (!canonical) return word;
    corrections.push(`${word} -> ${canonical}`);
    return canonical;
  });
  return { text: corrected, corrections };
}

export function voiceTranscriptReview(transcript: string): VoiceTranscriptReview {
  const { text, corrections } = correctVoiceVocabulary(transcript.trim());
  const reasons: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) reasons.push('very short');
  const verbs = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z]/g, '')));
  const verb = CONSEQUENTIAL_VERBS.find((candidate) => verbs.has(candidate));
  if (verb) reasons.push(`asks to change something ("${verb}")`);
  if (corrections.length) reasons.push('some words were corrected');
  return { required: reasons.length > 0, reasons, text, corrections };
}
