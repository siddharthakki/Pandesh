/**
 * Alpha e2e (T3, T4, T8, T9, T12): the user named a specialist ("Ask your Research specialist…", "Ask Coding to…"),
 * but gemma4:12b answered itself, credited an agent that never ran, or was not even offered `delegate_to_agent`
 * (the public-research route offers web_research only). 0 of 5 requested hand-offs happened.
 *
 * When the request itself addresses an agent, Core starts the hand-off deterministically instead of hoping a small
 * model chooses the tool. Only an explicit instruction counts: a question about the agents ("what can the Coding
 * agent do?"), a negation ("don't ask Coding") or a hypothetical stays an ordinary turn. Pure and deterministic.
 */

export type SpecialistId = 'coding' | 'research' | 'operations' | 'personal';

const AGENT_WORD: Record<string, SpecialistId> = {
  coding: 'coding', code: 'coding', coder: 'coding', developer: 'coding',
  research: 'research', researcher: 'research',
  operations: 'operations', ops: 'operations',
  personal: 'personal',
};

const NAME = '(coding|code|coder|developer|research|researcher|operations|ops|personal)';
const ROLE = '(?:\\s+(?:specialist|agent|assistant|team))';
/** "ask/have/get/let/tell/use (your|the|my) Research specialist", "ask Coding to …" (bare name needs "to"). */
const DIRECT = new RegExp(
  `\\b(?:ask|have|get|let|tell|use|send|assign|delegate(?:\\s+(?:this|it|that))?\\s+to|hand\\s+(?:this|it|that)\\s+(?:off\\s+|over\\s+)?to|give\\s+(?:this|it|that)\\s+to)\\s+(?:(?:your|the|my|our)\\s+)?(?:${NAME}${ROLE}\\b|(coding|research|operations|personal)\\s+to\\b)`,
  'i',
);
/** "Delegate coding to Coding", "delegate the build to the Coding agent". */
const DELEGATE_TO = new RegExp(`\\bdelegate\\s+(?:[\\w-]+\\s+){0,3}?to\\s+(?:(?:your|the|my|our)\\s+)?${NAME}${ROLE}?\\b`, 'i');
const NEGATED = /\b(?:don'?t|do\s+not|never|without|instead\s+of|rather\s+than|no\s+need\s+to)\s+(?:\w+\s+){0,2}(?:ask|have|get|let|tell|use|send|assign|delegate|hand|give)\b/i;
const QUESTION = /^\s*(?:what|which|who|how|can|could|would|should|is|are|does|do|why|when)\b[^.!]*\?\s*$/i;

/** The specialist the user explicitly asked to do this work, or null. */
export function explicitSpecialistRequest(text: string | null | undefined): SpecialistId | null {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || QUESTION.test(t)) return null;
  const m = DIRECT.exec(t) ?? DELEGATE_TO.exec(t);
  if (!m) return null;
  // A negation in the same sentence, before the instruction, cancels it ("Don't ask Coding to …").
  const sentenceStart = Math.max(t.lastIndexOf('.', m.index), t.lastIndexOf('!', m.index), t.lastIndexOf('?', m.index)) + 1;
  if (NEGATED.test(t.slice(sentenceStart, m.index + m[0].length))) return null;
  return AGENT_WORD[(m[1] ?? m[2] ?? '').toLowerCase()] ?? null;
}

export const SPECIALIST_NAMES: Record<SpecialistId, string> = { coding: 'Coding', research: 'Research', operations: 'Operations', personal: 'Personal' };
