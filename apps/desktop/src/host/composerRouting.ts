/**
 * What a message typed while a task is working should do.
 *
 * - stop:          handled before this (Stop wording acts immediately).
 * - correct:       it changes what the person asked for ("No wait, make it for RTX 5090"). It replaces the wording of
 *                  the latest request: a request still waiting in the queue is edited in place, a run that has not acted
 *                  yet is restarted on the same task with the correction, and a run that already acted is steered
 *                  (never re-run, so no tool action is repeated).
 * - steer:         it adjusts the running task ("also include the totals", "use Berlin time instead"). It is handed to
 *                  that run and the task keeps going.
 * - side_question: an unrelated quick question. It gets its own answer right away, next to the running task, which is
 *                  not stopped and not restarted.
 * - queue:         anything else is a separate request that starts after the current task.
 *
 * Deliberately conservative: when in doubt the message is queued, which is the safe, previous behaviour. A correction
 * needs an explicit marker ("no wait", "I meant", "scratch that", "make that…") plus new content, and a standalone
 * question after "no," is still a quick question. Nothing here decides to cancel work.
 */
export type RunningSendRoute = 'correct' | 'steer' | 'side_question' | 'queue';

const CORRECTION_MARKER = /^(?:(?:oh|ok(?:ay)?|hmm+|um+|uh+)[\s,]+)*(?:(?:no|nope|nah)\b[\s,.!-]*(?:(?:wait|sorry|actually|i meant|i mean|hold on)\b[\s,.!-]*)?|(?:wait|hold on)[\s,.!-]+(?=(?:no|sorry|i meant|i mean|make|change|it'?s|that'?s|for)\b)|sorry\b[\s,.!-]*|scratch that\b[\s,.!-]*|never ?mind\b[\s,.!-]*|correction\b[\s,:.!-]*|i meant\b[\s,:.!-]*|i mean\b[\s,:.!-]*|make that\b[\s,:.!-]*|change (?:that|it) to\b[\s,:.!-]*|let me rephrase\b[\s,:.!-]*)/i;
/** A question that does not point back at the request ("no, what is 17 times 23?") is a new question, not a fix. */
const POINTS_BACK = /\b(it|that|this|them|those|instead|rather|mean|meant|for|to)\b/i;
const STEER_START = /^(?:(?:and|also|oh|ok(?:ay)?|btw|actually|wait|hold on|one more thing|additionally|please)[\s,]+)*(?:also|instead|actually|additionally|change|switch|make (?:it|them|the|this)|use|don'?t|do not|only|add|include|exclude|skip|ignore|focus|prioriti[sz]e|remember to|keep|rename|but)\b/i;
const STEER_ANYWHERE = /\b(?:also|instead|additionally|as well|while you'?re at it|for this task|for that task|the current task|in the summary|in the report|in that file|in the same)\b/i;
const QUESTION_START = /^(?:(?:quick question|btw|by the way|hey|hi|ok(?:ay)?|so|and)[\s,:]*)*(?:what|who|when|where|why|how|which|is|are|can|could|do|does|did|will|would|should|whats|what's|tell me|give me)\b/i;

/** Longer than a quick question: that is a new piece of work, not an aside. */
const QUICK_QUESTION_MAX_CHARS = 280;
/** A correction is a short sentence; a long message is a new request. */
const CORRECTION_MAX_CHARS = 400;

/** True when the text explicitly corrects the request before it, and says what the correction is. */
export function isExplicitCorrection(text: string): boolean {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value || value.length > CORRECTION_MAX_CHARS) return false;
  const marker = CORRECTION_MARKER.exec(value);
  if (!marker) return false;
  const rest = value.slice(marker[0].length).trim();
  if (rest.split(/\s+/).filter(Boolean).length < 2) return false;
  if (/^(?:thanks|thank you|thx|please don'?t|it'?s fine|it'?s ok(?:ay)?|that'?s fine)\b/i.test(rest)) return false;
  if (/\?\s*$/.test(rest) && !POINTS_BACK.test(rest)) return false;
  return true;
}

export function routeSendWhileRunning(text: string): RunningSendRoute {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return 'queue';
  if (isExplicitCorrection(value)) return 'correct';
  if (/^(?:steer|update)\s*:/i.test(value)) return 'steer';
  if (STEER_START.test(value) || STEER_ANYWHERE.test(value)) return 'steer';
  const questionLike = /\?\s*$/.test(value) || QUESTION_START.test(value);
  if (questionLike && value.length <= QUICK_QUESTION_MAX_CHARS) return 'side_question';
  return 'queue';
}
