/**
 * Conversation relevance — the latest user request is authoritative.
 *
 * Durable tasks stay stored and resumable, but they are only offered to the model when the
 * current request clearly refers to them. Prior turns are bounded and, when the request is a
 * new topic, reduced to a short tail so an old answer (a contract table, say) is not available
 * to be echoed back as the answer to an unrelated question.
 *
 * Deterministic and request-text-only: no model is consulted.
 */

/** Words that explicitly ask to pick a previous piece of work back up. */
const EXPLICIT_RESUME = /\b(?:continue|resume|carry on|keep going|pick (?:it|that|this) back up|go on with)\b|\b(?:what(?:'s| is| was) the (?:status|progress)|what happened (?:with|to)|any (?:updates?|progress)|status (?:of|on|update)|next steps?)\b|^\s*(?:status|updates?|progress)\s*\??\s*$/i;

/** Nouns that only point back at earlier work ("continue that task", "show the earlier results"). */
const BACK_REFERENCE_WORDS = stemmed(['task', 'workflow', 'extraction', 'inventory', 'result', 'results', 'table', 'job', 'earlier', 'previous', 'last', 'those', 'these']);

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'my', 'me', 'all', 'from', 'with', 'is', 'it', 'this', 'that', 'please', 'can', 'you', 'i', 'do', 'what', 'how', 'are', 'was', 'be', 'at', 'by', 'as']);

function stemmed(words: string[]): Set<string> {
  return new Set(words.map(stem));
}

/** Crude suffix stripping so "contracts"/"contract" and "extraction"/"extract" meet. */
function stem(word: string): string {
  return word.length > 5 ? word.replace(/(?:ions?|ing|ed|es|s)$/, '') : word.replace(/s$/, '');
}

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (!STOPWORDS.has(w)) out.add(stem(w));
  }
  return out;
}

const RESUME_FILLER = stemmed(['continue', 'resume', 'status', 'update', 'updates', 'progress', 'next', 'steps', 'happened', 'going', 'where', 'left', 'off', 'carry', 'keep', 'back', 'pick', 'pickup', 'details', 'there', 'stopped']);

/** True when the request asks to resume/inspect earlier work (as opposed to starting something new). */
export function isExplicitResumeRequest(text: string): boolean {
  return EXPLICIT_RESUME.test(text);
}

export interface RelevantTaskCandidate {
  objective: string;
  status: string;
}

/**
 * Returns the task the request clearly refers to, or undefined.
 *
 * A task is relevant when the request shares subject words with its objective, or when it is an
 * explicit resume request that is not itself about some other subject. A bare "continue" resumes
 * the most recent open task; "continue printing the report" does not hijack an unrelated one.
 */
export function selectRelevantTask<T extends RelevantTaskCandidate>(tasks: readonly T[], requestText: string): T | undefined {
  const open = tasks.filter((t) => t.status === 'in_progress' || t.status === 'partial');
  if (open.length === 0) return undefined;
  const request = contentWords(requestText);

  let best: { task: T; overlap: number } | undefined;
  for (const task of open) {
    const objective = contentWords(task.objective);
    let overlap = 0;
    for (const w of request) if (objective.has(w)) overlap += 1;
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { task, overlap };
  }
  if (best) return best.task;

  if (isExplicitResumeRequest(requestText)) {
    // Resume words with no subject of their own ("continue", "status?") refer to the latest open task.
    const subject = [...request].filter((w) => !RESUME_FILLER.has(w));
    if (subject.every((w) => BACK_REFERENCE_WORDS.has(w))) return open[0];
  }
  return undefined;
}

export interface ContextTurn {
  role: string;
  content: string;
}

export interface BoundedContext<T extends ContextTurn> {
  turns: T[];
  omitted: number;
  /** True when the request was treated as a new topic and history was reduced to a short tail. */
  newTopic: boolean;
}

export const MAX_RELEVANT_TURNS = 10;
export const MAX_NEW_TOPIC_TURNS = 4;
export const MAX_TURN_CHARS = 1_500;

/**
 * Bounds the prior turns offered to the model. Relevant requests (resume, or sharing subject
 * words with recent history) keep up to MAX_RELEVANT_TURNS; a new topic keeps only the last
 * MAX_NEW_TOPIC_TURNS, so long structured answers from earlier topics fall out of context.
 * Every kept turn is length-capped.
 */
export function boundConversationContext<T extends ContextTurn>(turns: readonly T[], requestText: string): BoundedContext<T> {
  const request = contentWords(requestText);
  const recent = turns.slice(-MAX_RELEVANT_TURNS);
  const related = isExplicitResumeRequest(requestText) || recent.some((t) => {
    if (t.role !== 'user') return false;
    const words = contentWords(t.content);
    for (const w of request) if (words.has(w)) return true;
    return false;
  });
  const kept = related ? recent : turns.slice(-MAX_NEW_TOPIC_TURNS);
  const capped = kept.map((t) => (t.content.length > MAX_TURN_CHARS ? { ...t, content: `${t.content.slice(0, MAX_TURN_CHARS)}\n[earlier message truncated]` } : t));
  return { turns: capped, omitted: Math.max(0, turns.length - capped.length), newTopic: !related };
}

/** Appended to the system prompt so the model answers the latest request and never re-answers history. */
export const LATEST_REQUEST_AUTHORITATIVE = `LATEST REQUEST IS AUTHORITATIVE (STRICT RULE):
- Answer only the user's most recent message. Earlier messages are background; never repeat, summarize or re-deliver an earlier answer unless the latest message asks for it.
- Earlier workflows are not active unless the latest message refers to them.`;
