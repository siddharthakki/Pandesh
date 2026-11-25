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

export const VOICE_VOCABULARY = [
  'Gmail', 'Calendar', 'Pandesh', 'Promotions', 'Inbox', 'Newsletters', 'Google',
  // Names and German business words the owner says in English sentences. whisper-base.en has never seen them:
  // measured on Piper speech, "Rechnung" came back as "Rich Nunn", "Ummeldung" as "Ummel dung", "Conficars" as "configars".
  'Conficars', 'Rechnung', 'Rechnungen', 'Ummeldung',
] as const;

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

/** Letters an English-only recognizer swaps when it guesses at a foreign or invented name (k/c, u/o). */
function soundFold(word: string): string {
  return word.toLowerCase().replace(/k/g, 'c').replace(/u/g, 'o');
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
    const distance = Math.min(editDistance(lower, term.toLowerCase()), editDistance(soundFold(lower), soundFold(term)));
    if (distance <= allowed && (!best || distance < best.distance)) best = { term, distance };
  }
  return best?.term ?? null;
}

/**
 * The recognizer also splits an unknown name into two or three words ("Ummel dung", "Rich Nunn"). Try the words
 * joined; short joins ("a mail" -> "amail") are never tried because they collide with ordinary English.
 */
function correctSplitNames(text: string, corrections: string[]): string {
  // Words separated by single spaces only: a comma or full stop is a real boundary.
  const parts = text.split(/( +)/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    let done = false;
    for (const size of [3, 2]) {
      const words = parts.slice(i, i + 2 * size - 1).filter((_, k) => k % 2 === 0);
      // Every piece must be a real chunk (not "my" in "my calendar") and none may already be a vocabulary term.
      if (words.length < size || !words.every((w) => /^[A-Za-z]{3,}$/.test(w))) continue;
      if (words.some((w) => VOICE_VOCABULARY.some((term) => term.toLowerCase() === w.toLowerCase()))) continue;
      const joinedWords = words.join('');
      const exact = VOICE_VOCABULARY.find((term) => term.toLowerCase() === joinedWords.toLowerCase());
      const canonical = joinedWords.length >= 7 ? (exact ?? canonicalFor(joinedWords)) : null;
      if (!canonical) continue;
      corrections.push(`${words.join(' ')} -> ${canonical}`);
      out.push(canonical);
      i += 2 * (size - 1);
      done = true;
      break;
    }
    if (!done) out.push(parts[i]);
    if (i + 1 < parts.length) out.push(parts[i + 1]);
  }
  return out.join('');
}

export function correctVoiceVocabulary(text: string): { text: string; corrections: string[] } {
  const corrections: string[] = [];
  const corrected = correctSplitNames(text, corrections).replace(/[A-Za-z]+(?:-[A-Za-z]+)*/g, (token) => {
    // Whisper sometimes splits a name it does not know with a hyphen ("Pan-dish"): try the joined word first.
    const joined = token.includes('-') ? canonicalFor(token.replace(/-/g, '')) : null;
    if (joined) {
      corrections.push(`${token} -> ${joined}`);
      return joined;
    }
    return token.replace(/[A-Za-z]+/g, (word) => {
      const canonical = canonicalFor(word);
      if (!canonical) return word;
      corrections.push(`${word} -> ${canonical}`);
      return canonical;
    });
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
