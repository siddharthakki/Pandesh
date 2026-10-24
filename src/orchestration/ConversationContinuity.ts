/**
 * Durable Conversational Continuity V1 — the deterministic, explainable rules
 * that turn one turn of plain text plus the durable working state into:
 *
 *   1. an objective boundary decision  (same objective / new objective / ask)
 *   2. the explicit constraints the user set, and which prior ones they just
 *      overrode
 *   3. whether a referential follow-up ("continue", "fix it") can be resolved
 *      at all, or must ask instead
 *
 * Everything here is a pure function of the current message and the small
 * persisted record — no model call, no embeddings, no classifier, no
 * repository access. That is the milestone's Step 5/Step 10 requirement:
 * V1 is working conversational state, not "AI memory", and when the rules
 * are uncertain the correct output is a question, never a guess.
 *
 * This module deliberately does NOT decide the execution policy. That stays
 * with `ExecutionPolicyRouter.decideExecutionPolicy`, which is fed the
 * bounded continuity summary this module helps assemble. Continuity may
 * resolve WHAT a follow-up refers to; it may never grant more autonomy than
 * the new wording itself permits (milestone Step 3).
 */

import type {
  ConversationConstraint,
  ConversationWorkingStateRecord,
} from '../../core/shared/wireTypes';
import { hasAffirmativeMutationIntent, splitClauses } from '../../core/domain/actionIntent';

export type ObjectiveBoundary = 'same_objective' | 'new_objective' | 'ambiguous';

export type ResumptionState = 'none' | 'restored' | 'dismissed' | 'reset';

export interface ContinuationAnchor {
  taskId?: string;
  objective: string;
  lastRelevantTurn?: string;
}

export interface ConversationControlState {
  id: string;
  repository: string;
  continuationAnchor?: ContinuationAnchor;
  resumptionState: ResumptionState;
}

/**
 * Explicit fresh-chat / reset intent patterns.
 * An explicit instruction to start fresh must override continuation inference deterministically.
 */
const RESET_INTENT_PATTERNS: RegExp[] = [
  /\b(?:do not|don'?t)\s+resume\s+(?:the\s+)?(?:previous|prior|old|last)?\s*(?:conversation|chat|task|context)\b/i,
  /\b(?:start|begin)\s+(?:fresh|afresh|anew)\b/i,
  /\b(?:start|begin)\s+(?:a\s+)?new\s+(?:conversation|chat|topic)\b/i,
  /^\s*(?:new\s+(?:conversation|chat|topic)|fresh\s+chat)\s*[.!]?\s*$/i,
  /\b(?:ignore|drop|disregard)\s+(?:the\s+)?(?:previous|prior|old|last)\s+(?:task|conversation|chat|context|objective)\b/i,
  /\bforget\s+(?:the\s+)?(?:previous|prior|old|last)\s+(?:task|conversation|chat|context|objective)(?:\s+for\s+this\s+chat)?\b/i,
  /\b(?:do not|don'?t)\s+continue\s+(?:that|the\s+previous|the\s+prior|the\s+old|the\s+last)\s*(?:task|conversation|objective)?\b/i,
  /\bstop\s+using\s+(?:the\s+)?(?:previous|prior|old|last)\s+(?:conversation|chat|task|context)\b/i,
  /\b(?:reset|clear)\s+(?:the\s+)?(?:conversation\s+context|context|conversation|chat)\b/i,
];

export function isExplicitResetIntent(text: string): boolean {
  const normalized = stripLeadingFiller(String(text ?? '').trim());
  if (!normalized) return false;
  return RESET_INTENT_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Standalone greeting / conversational openers.
 * Greetings must not resurrect stale task context or old engineering next-steps.
 */
const GREETING_PATTERN = /^\s*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|what'?s\s+up|howdy|greetings|sup|yo|namaste)(?:\s+(?:there|karkedikha|agent|friend))?\s*[.!?]*\s*$/i;

export function isGreetingIntent(text: string): boolean {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;
  return GREETING_PATTERN.test(trimmed);
}

/**
 * Repository-understanding queries.
 * Broad architectural or code-understanding questions are independent turns,
 * not continuations of a prior specific coding task.
 */
const REPO_UNDERSTANDING_PATTERNS: RegExp[] = [
  /\bwhat\s+does\s+(?:this|the)\s+(?:repo|repository|project|codebase|app|application)\s+do\b/i,
  /\bexplain\s+(?:this|the)\s+(?:repo|repository|project|codebase|app|application)\b/i,
  /\b(?:what\s+are\s+the|describe\s+the)\s+(?:main\s+)?(?:components|modules|packages|features|parts)\b/i,
  /\bwhere\s+should\s+i\s+start\b/i,
  /\bwhat\s+does\s+(?:this|the)\s+(?:folder|directory)\s+contain\b/i,
  /\b(?:how\s+does\s+this\s+(?:codebase|repo|project|app)\s+work|overview\s+of\s+(?:this|the)\s+(?:repo|repository|project|codebase))\b/i,
  /\btell\s+me\s+about\s+(?:this|the)\s+(?:repo|repository|project|codebase)\b/i,
  /\bwhat\s+is\s+(?:this|the)\s+(?:repo|repository|project|codebase)\b/i,
];

export function isRepositoryUnderstandingQuery(text: string): boolean {
  const normalized = stripLeadingFiller(String(text ?? '').trim());
  if (!normalized) return false;
  return REPO_UNDERSTANDING_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Phrases that explicitly announce a topic change. Deliberately narrow and
 * literal: a general "does this sound like a different subject?" judgement is
 * exactly the semantic classifier Step 10 rules out. Anything not matched
 * here falls through to the conservative rules below.
 */
const NEW_OBJECTIVE_MARKERS: RegExp[] = [
  /\b(?:different|separate|another|unrelated|new)\s+(?:issue|problem|topic|task|question|thing|bug)\b/i,
  /\bnow\s+let'?s\s+(?:work on|look at|move on to|switch to)\b/i,
  /\blet'?s\s+(?:work on|move on to|switch to|turn to)\b/i,
  /\b(?:forget|drop|abandon|never mind|nevermind)\s+(?:that|this|it|the previous|the last)\b/i,
  /\bchanging\s+(?:the\s+)?(?:subject|topic)\b/i,
  /\bmoving\s+on\b/i,
  /\bon\s+a\s+different\s+note\b/i,
  /\binstead,?\s+(?:inspect|look at|investigate|work on)\b/i,
];

/**
 * Phrases that explicitly continue the active objective. These win over the
 * length/novelty heuristic below, so "add the tests too" stays on the same
 * objective even though it names a new noun.
 */
const SAME_OBJECTIVE_MARKERS: RegExp[] = [
  /^\s*(?:ok(?:ay)?|yes|sure|please|well|alright|actually|now)?[,.!]?\s*(?:continue|carry on|keep going|go on|resume|proceed|go ahead)\b/i,
  // A referential imperative still refers to the stored objective when the
  // turn goes on to add a constraint — "Fix it, but don't change the tests."
  // is one follow-up, not a new subject, and is the milestone's Step 4 case.
  /^\s*(?:fix|do|try|implement|continue|resume|proceed)\s+(?:it|that|this|again)\b/i,
  /\b(?:also|too|as well)\s*[.!]?\s*$/i,
  // "now update the tests" / "and add the tests" — a short imperative that
  // extends the active objective rather than announcing a new one. The
  // new-objective markers are tested first, so "Now let's work on the payment
  // module." is still classified as a topic change.
  /^\s*(?:and|also|then|now)\b/i,
  /\b(?:same|that)\s+(?:issue|problem|bug|thing|task)\b/i,
  /\bwhat did you find\b/i,
  /\bwhy did (?:that|it) fail\b/i,
  /\btry (?:again|the other approach|a different approach)\b/i,
];

/**
 * A bare referential follow-up carries no subject of its own. It is the
 * canonical "continue" case: its referent MUST come from the durable working
 * state, and if there is none the user has to be asked.
 */
const BARE_REFERENTIAL = [
  /^(?:fix|do|try|implement|continue|resume|go ahead|proceed|carry on|keep going)(?:\s+(?:it|that|this|again|with (?:it|that|the other approach)))?[.!]?$/i,
  /^what did you find\??$/i,
  /^why did (?:that|it) fail\??$/i,
  /^try the other approach[.!]?$/i,
];

/** Strips a short leading acknowledgment so the clause after it is visible.
 * Kept behaviourally identical to `ExecutionPolicyRouter.stripLeadingFiller`. */
function stripLeadingFiller(text: string): string {
  return text.replace(/^\s*(?:ok(?:ay)?|yes|sure|please|well|alright|actually|now|good|great|perfect|thanks|thank you)[,.!]?\s*/i, '');
}

export function isReferentialFollowUp(text: string): boolean {
  const trimmed = stripLeadingFiller(String(text ?? '').trim());
  return BARE_REFERENTIAL.some(pattern => pattern.test(trimmed));
}

/**
 * Control acknowledgements — the vocabulary a user answers a system CONTROL
 * QUESTION with ("Should I treat it as a new task?", "Continue?"), never the
 * vocabulary of a real objective. Each pattern is anchored start-to-end
 * (`^...$`) so it only matches a message that is ENTIRELY the control
 * phrase — a real objective that happens to contain the word "continue" or
 * "new task" as part of a longer sentence never matches here, satisfying the
 * rule that classification must compare substantive objectives, not control
 * acknowledgements.
 *
 * This is deliberately a small closed vocabulary, not a hack for the literal
 * string "Yes new task": every equivalent affirmative selection ("new task",
 * "start new", "new chat", "new conversation") is one pattern, matching
 * anything the New Task UI action would also send programmatically.
 */
const CONTROL_NEW_TASK_PATTERN = /^(?:yes|yep|yeah|sure|ok(?:ay)?)?[,.!]?\s*(?:start\s+)?new\s+(?:task|chat|conversation|topic)\s*[.!]?$/i;
const CONTROL_CONTINUE_PATTERN = /^(?:yes|yep|yeah|sure|ok(?:ay)?)?[,.!]?\s*(?:continue|resume|keep\s+going|carry\s+on|go\s+ahead|proceed)\s*[.!]?$/i;
const CONTROL_RETRY_PATTERN = /^retry\s*[.!]?$/i;
const CONTROL_BARE_AFFIRMATION_PATTERN = /^(?:yes|yep|yeah|sure|ok(?:ay)?)\s*[.!]?$/i;

export type ControlAcknowledgement = 'confirm_new' | 'confirm_continue' | 'retry' | 'affirmation' | null;

/**
 * Classifies a message as a bare control acknowledgement, or `null` when it
 * carries any substantive content of its own (and must go through the
 * ordinary objective-boundary classifier instead).
 */
export function classifyControlAcknowledgement(text: string): ControlAcknowledgement {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (CONTROL_NEW_TASK_PATTERN.test(trimmed)) return 'confirm_new';
  if (CONTROL_CONTINUE_PATTERN.test(trimmed)) return 'confirm_continue';
  if (CONTROL_RETRY_PATTERN.test(trimmed)) return 'retry';
  if (CONTROL_BARE_AFFIRMATION_PATTERN.test(trimmed)) return 'affirmation';
  return null;
}

/**
 * Decides whether this turn continues the stored objective or starts a new
 * one.
 *
 * Enforces strict precedence:
 *   1. explicit reset/new-topic intent
 *   2. greetings & repository-understanding queries (independent turns)
 *   3. explicit continue/resume intent
 *   4. strong semantic continuation (including deictic references to active context)
 *   5. ambiguous continuation clarification
 *   6. fresh independent task
 */
const ACKNOWLEDGEMENT_LED_FOLLOW_ON = /^(?:good|great|nice|perfect|thanks|thank you|okay|ok|cool|alright|got it|makes sense)\b[.!,]?\s+\S/i;

const ASSISTANT_DIRECTED_FOLLOW_UP = /\b(?:why (?:did|would|do) you|how did you|did you|have you|you just (?:made|wrote|changed|implemented|added|removed|said)|your (?:change|changes|implementation|answer|last|previous)|that way)\b/i;

export function detectObjectiveBoundary(
  text: string,
  state: ConversationWorkingStateRecord | null,
  context?: ContinuityContext,
): ObjectiveBoundary {
  const raw = String(text ?? '').trim();
  if (!state || !raw) return 'new_objective';

  // 1. Explicit reset / new-topic intent wins unconditionally.
  if (isExplicitResetIntent(raw)) return 'new_objective';
  if (NEW_OBJECTIVE_MARKERS.some(pattern => pattern.test(raw))) return 'new_objective';

  // 1.5 Greetings and standalone repository-understanding queries are fresh independent turns.
  if (isGreetingIntent(raw)) return 'new_objective';
  if (isRepositoryUnderstandingQuery(raw)) return 'new_objective';

  // 2. Explicit continue / resume intent.
  if (isReferentialFollowUp(raw)) return 'same_objective';

  // 3. Strong semantic continuation markers.
  if (SAME_OBJECTIVE_MARKERS.some(pattern => pattern.test(raw))) return 'same_objective';

  // 3.4 An acknowledgement-led transition ("Good. Now let me…", "Okay. Ask me
  // before…") responds to the exchange that just happened; it is the next step
  // of this conversation, not an unrelated request that needs confirming.
  if (ACKNOWLEDGEMENT_LED_FOLLOW_ON.test(raw)) return 'same_objective';
  // 3.45 A question about what the assistant itself just did or said is, by
  // definition, about this conversation ("Why did you implement it that way?").
  if (ASSISTANT_DIRECTED_FOLLOW_UP.test(raw)) return 'same_objective';

  // 3.45b An anaphoric instruction to act on the assistant's previous proposal continues that exchange.
  if (hasProposalAnaphor(raw)) return 'same_objective';
  // 3.5 Deictic conversational references ("those two cases", "that bug", "the second option", etc.)
  if (hasDeicticReference(raw)) return 'same_objective';

  // 3.6 Refining existing work: an affirmative modification request ("Looks good. Add dark mode.") that is not itself
  // a fresh self-contained objective ("Build me a calculator app."), in a conversation that already produced or inspected
  // workspace work, evolves that work. Asking "is this a new task?" here breaks the natural build -> refine flow.
  if (
    hasExistingWork(state)
    && hasAffirmativeMutationIntent(raw)
    && !namesUnrelatedTarget(raw, state)
    && !splitClauses(raw).some(clause => SELF_CONTAINED_OBJECTIVE_VERB.test(stripLeadingFiller(clause.trim())))
  ) return 'same_objective';

  // A short imperative with no subject of its own is still this objective,
  // but only if it is not a greeting.
  if (raw.length <= 60 && !hasOwnSubject(raw)) return 'same_objective';

  // 4. Strong semantic subject sharing.
  if (sharesSubjectWithObjective(raw, state)) return 'same_objective';

  // 5. Follow-up affinity: a turn can continue the conversation while sharing
  // almost no vocabulary with the stored objective string ("Which file would I
  // open first and why?" after "What does this workspace contain?"). Judge it
  // against the exchange that just happened, not only the objective label.
  if (followUpAffinity(raw, state, context).affinity === 'strong') return 'same_objective';

  return 'ambiguous';
}

/** The exchange the new turn is answering — the continuity evidence beyond
 * the stored objective label. Both fields are optional and best-effort. */
export interface ContinuityContext {
  /** The assistant's most recent answer in this conversation. */
  previousAssistantText?: string | null;
  /** The user's previous message in this conversation. */
  previousUserText?: string | null;
}

export interface FollowUpAffinityDecision {
  affinity: 'strong' | 'none';
  /** Names of the structural signals that fired (explainable, testable). */
  signals: string[];
}

const NOUN_REFERENT = '(?:one|ones|file|files|option|options|approach|approaches|design|choice|part|step|steps|function|class|module|section|thing|item|reason|case|point|example|change|result|error|issue|test|tests)';
const ORDINAL = '(?:first|second|third|fourth|last|other|next|previous|following|latter|former|main|same|top|remaining)';

/** Structural cues that tie a turn to what was JUST said. Each is a pattern of
 * conversation (referent, elaboration, ranking, next-step), never a match on
 * the objective's own words. */
const FOLLOW_UP_SIGNALS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'ordinal-referent', pattern: new RegExp(String.raw`\b(?:the\s+)?${ORDINAL}\s+(?:${NOUN_REFERENT})\b`, 'i') },
  { name: 'demonstrative-referent', pattern: new RegExp(String.raw`\b(?:that|this|those|these|such)\s+(?:${NOUN_REFERENT})\b`, 'i') },
  { name: 'which-referent', pattern: new RegExp(String.raw`\bwhich\s+(?:${NOUN_REFERENT})\b`, 'i') },
  { name: 'what-about', pattern: /\b(?:what|how)\s+about\b/i },
  { name: 'why-question', pattern: /(?:^|[\s,;])(?:and\s+)?why\b/i },
  { name: 'ranking-or-next-step', pattern: /\b(?:(?:open|read|start|begin|look at|check|try|do|tackle|fix)\s+(?:with\s+)?(?:first|next)|where\s+(?:should|do|would)\s+(?:i|we)\s+(?:start|begin))\b|\b(?:first|next|best|most important|priority)\b.*\?/i },
  { name: 'elaboration-request', pattern: /\b(?:elaborate|expand on|explain\s+(?:that|it|this|more|further|why|how)|tell me more|walk me through|go deeper|in more detail|clarify|say more|more (?:detail|about))\b/i },
  { name: 'pronoun-object', pattern: /\b(?:below|above|under|beneath|after|before|beside|inside|next to|alongside|to|in|into|on|from|for|with|about)\s+(?:it|that|them|those|this one)\b/i },
  { name: 'pronoun-verb-object', pattern: /\b(?:fix|change|update|rename|remove|delete|move|make|explain|show|use|improve|extend|test|run)\s+(?:it|that|them|those)\b/i },
  // Wrap-up / recap of the work just done ("Summarize the final workspace", "recap what we changed").
  // Tied to the outcome of THIS conversation (final/current/resulting state, "so far", "what we did"),
  // so "Summarize the codebase architecture" with no such anchor is still a fresh request.
  { name: 'wrap-up-request', pattern: /\b(?:(?:final|current|resulting|updated|end)\s+(?:state|workspace|result|version|files?|project|code|outcome)|so far|what\s+(?:we|you)(?:'ve|\s+have)?\s+(?:did|done|changed|made|built|added|created)|(?:everything|all)\s+(?:we|you)(?:'ve|\s+have)?\s+(?:did|done|changed|made|built)|(?:changes|work)\s+(?:we|you)\s+(?:just\s+)?made|recap|wrap(?:ping)?\s+(?:it\s+)?up)\b/i },
  { name: 'answer-directed-question', pattern: /^\s*(?:so|then|and|but|ok(?:ay)?|right)[,\s]+(?:which|what|why|how|where|is|are|does|do|can|could|should|would)\b/i },
];

const GENERIC_SCOPE_TERMS = new Set([
  'file', 'files', 'folder', 'directory', 'workspace', 'project', 'repo', 'repository', 'code', 'codebase',
  'first', 'open', 'read', 'start', 'main', 'important', 'purpose', 'work', 'works', 'thing', 'things',
]);

const SELF_CONTAINED_OBJECTIVE_VERB = /^\s*(?:please\s+)?(?:build|create|implement|write|generate|design|scaffold|set up|migrate|refactor|inspect|analy[sz]e|audit|review|investigate|develop|make me)\b/i;

/**
 * Deterministic follow-up affinity: does this turn read as the next turn of the
 * exchange that just happened? Combines structural conversation cues with — when
 * available — overlap against the previous assistant answer. Pure and
 * explainable; it never guesses without a signal, and a self-contained
 * imperative (a fresh build/inspect request) needs a real referent cue, never
 * mere overlap, to count as a follow-up.
 */
export function followUpAffinity(
  text: string,
  state: ConversationWorkingStateRecord | null,
  context?: ContinuityContext,
): FollowUpAffinityDecision {
  const raw = String(text ?? '').trim();
  const signals: string[] = [];
  if (!raw || !state) return { affinity: 'none', signals };

  for (const { name, pattern } of FOLLOW_UP_SIGNALS) {
    if (pattern.test(raw)) signals.push(name);
  }

  const isQuestion = /\?\s*$/.test(raw) || /^\s*(?:which|what|why|how|where|who|when|is|are|does|do|can|could|should|would)\b/i.test(raw);
  const short = raw.length <= 140;
  const selfContained = SELF_CONTAINED_OBJECTIVE_VERB.test(raw) || raw.length > 160;

  // A short question about the subject the conversation is already on: its
  // (non-generic) terms appear in what the assistant just said or in the
  // objective's known files/symbols.
  if (isQuestion && short && !selfContained) {
    const evidence = [
      context?.previousAssistantText ?? '',
      context?.previousUserText ?? '',
      state.latestFindingsSummary ?? '',
      (state.relevantSymbols ?? []).join(' '),
      (state.relevantFiles ?? []).map((file: unknown) => (typeof file === 'string' ? file : (file as { path?: string })?.path || '')).join(' '),
    ].join(' ');
    const evidenceTerms = significantTerms(evidence);
    for (const term of significantTerms(raw)) {
      if (!GENERIC_SCOPE_TERMS.has(term) && evidenceTerms.has(term)) {
        signals.push('answer-term-overlap');
        break;
      }
    }
  }

  if (signals.length === 0) return { affinity: 'none', signals };
  // A fresh, self-contained imperative is only a follow-up when it points back
  // at something ("...below it"); overlap alone never turns it into one.
  const referential = signals.some(name => name !== 'answer-term-overlap');
  if (selfContained && !referential) return { affinity: 'none', signals };
  return { affinity: 'strong', signals };
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'that', 'this',
  'it', 'its', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'so', 'if', 'then', 'now',
  'you', 'your', 'we', 'i', 'me', 'my', 'not', 'no', 'don', 'dont', 'why', 'what', 'how', 'when',
  'where', 'which', 'can', 'should', 'would', 'could', 'please', 'also', 'too', 'as', 'well',
  'fix', 'change', 'update', 'add', 'make', 'run', 'let', 'lets', 'work', 'look', 'again',
]);

function significantTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const token of String(text).toLowerCase().match(/[a-z][a-z0-9_./-]{2,}/g) ?? []) {
    const normalized = token.replace(/[.\-_/]+$/, '');
    if (normalized.length < 3 || STOP_WORDS.has(normalized)) continue;
    terms.add(normalized);
  }
  return terms;
}

/** True when the text names something concrete of its own (an identifier, a
 * path, or a capitalised/camelCase symbol) rather than only pronouns. */
/**
 * "...to the reporting dashboard exporter": the request aims at a specific target, and nothing the conversation has
 * produced or discussed mentions it. A refinement has no such target ("Add dark mode.") or names one the work already has.
 */
function namesUnrelatedTarget(text: string, state: ConversationWorkingStateRecord): boolean {
  const evidence = significantTerms([
    state.currentObjective || '',
    state.latestFindingsSummary ?? '',
    (state.relevantSymbols ?? []).join(' '),
    (state.relevantFiles ?? []).map((file: unknown) => (typeof file === 'string' ? file : (file as { path?: string })?.path || '')).join(' '),
  ].join(' '));
  const target = /\b(?:to|in|for|on|of|into|inside|within)\s+the\s+([a-z][\w-]*(?:\s+[a-z][\w-]*){0,3})/gi;
  for (const match of text.matchAll(target)) {
    const terms = [...significantTerms(match[1])].filter(term => !GENERIC_SCOPE_TERMS.has(term));
    if (terms.length > 0 && !terms.some(term => evidence.has(term))) return true;
  }
  return false;
}

export function hasExistingWork(state: ConversationWorkingStateRecord): boolean {
  return (state.relevantFiles?.length ?? 0) > 0 || Boolean(state.latestFindingsSummary) || Boolean(state.latestTaskId);
}

function hasOwnSubject(text: string): boolean {
  return /[\w@.-]+[/\\][\w@.-]+/.test(text)
    || /\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(text)
    || /\b\w+\.[a-z]{1,4}\b/.test(text)
    || significantTerms(text).size > 0;
}

function sharesSubjectWithObjective(text: string, state: ConversationWorkingStateRecord): boolean {
  const symbols = Array.isArray(state.relevantSymbols) ? state.relevantSymbols.join(' ') : '';
  const files = Array.isArray(state.relevantFiles)
    ? state.relevantFiles.map((file: unknown) => (typeof file === 'string' ? file : (file as { path?: string })?.path || '')).join(' ')
    : '';
  const objectiveTerms = significantTerms(
    [state.currentObjective || '', symbols, files].join(' '),
  );
  if (objectiveTerms.size === 0) return false;
  for (const term of significantTerms(text)) {
    if (objectiveTerms.has(term)) return true;
  }
  return false;
}

// ── Constraints ────────────────────────────────────────────────────────────

/**
 * Explicit constraint forms only. A constraint is something the user stated
 * as a rule for this piece of work ("don't change the tests", "keep it
 * minimal", "don't commit yet"). Casual prose is deliberately NOT harvested:
 * Step 4 forbids treating an offhand remark as a standing preference, and a
 * wrong constraint silently narrows every later turn.
 */
const CONSTRAINT_PATTERNS: RegExp[] = [
  /\b(?:do not|don'?t|never|please don'?t|avoid)\s+((?:touch|change|modify|edit|update|rewrite|delete|remove|refactor|commit|push|install|add)\b(?:[^.\n!?;]|\.(?=\w)){0,80})/gi,
  /\b(?:keep|make)\s+(the\s+)?(?:change|diff|patch|edit)s?\s+(minimal|small|focused|tight)\b/gi,
  /\bwithout\s+(changing|touching|modifying|editing|breaking)\s+((?:[^.\n!?;]|\.(?=\w)){1,60})/gi,
  /\buse\s+the\s+existing\s+((?:[^.\n!?;]|\.(?=\w)){1,60})/gi,
  /\bonly\s+(?:change|touch|modify|edit)\s+((?:[^.\n!?;]|\.(?=\w)){1,60})/gi,
  /\bstick\s+to\s+((?:[^.\n!?;]|\.(?=\w)){1,60})/gi,
];

function normalizeConstraintText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[,;:]+$/, '');
}

export function extractConstraints(text: string): string[] {
  const raw = String(text ?? '');
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of CONSTRAINT_PATTERNS) {
    // Each pattern is global; reset lastIndex so repeated calls are pure.
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      const constraint = normalizeConstraintText(match[0]);
      if (constraint.length < 4 || constraint.length > 200) continue;
      const key = constraint.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(constraint);
    }
  }
  return found;
}

/**
 * The subject a constraint is about — used to tell "actually, update the
 * tests too" (which overrides "don't change the tests") from an unrelated
 * later instruction (which must leave the constraint standing).
 */
function constraintSubjects(constraintText: string): Set<string> {
  return significantTerms(constraintText.replace(/^\s*(?:do not|don'?t|never|please don'?t|avoid|without|only|stick to|use the existing|keep|make)\b/i, ''));
}

/**
 * The actions a constraint typically forbids. An override must ask for one of
 * these on the constrained subject — "run the tests" does not lift "don't
 * change the tests", but "update the tests" does.
 */
const POSITIVE_ACTION = /\b(?:change|update|modify|edit|touch|rewrite|refactor|delete|remove|commit|push|install|add|adjust)\b/i;

/**
 * Identifies temporary/provisional constraints or broad mutation-blocking constraints
 * (e.g. "do not change any files yet", "don't touch files for now", "no changes yet").
 * When followed by an explicit instruction to add/modify files or tests, latest explicit
 * user intent supersedes earlier temporary constraints.
 */
export function isTemporaryConstraint(constraintText: string): boolean {
  const normalized = String(constraintText ?? '').toLowerCase().trim();
  if (/\b(?:yet|for now|right now|at the moment|temporarily|until)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(?:do not|don'?t|never|avoid|please don'?t)\s+(?:touch|change|modify|edit|write|update)\s+(?:any\s+)?files?\b/i.test(normalized)) {
    return true;
  }
  return false;
}

export function hasPositiveMutationIntent(text: string): boolean {
  const normalized = String(text ?? '').toLowerCase();
  return /\b(?:add|create|write|implement|fix|update|edit|modify|change|patch|refactor|delete|remove)\b/i.test(normalized)
    || /\b(?:regression|test|coverage|tests)\b/i.test(normalized);
}

/**
 * Returns the ids of constraints this turn explicitly overrides.
 *
 * A later explicit instruction beats an earlier constraint (Step 4), but
 * ONLY when the new instruction is unmistakably about that same subject and
 * unmistakably permits the thing the constraint forbade.
 *
 * Precedence rule:
 * latest explicit instruction > earlier conflicting temporary constraint > inferred context
 *
 * When the user gives an explicit mutation instruction (e.g. "add regression coverage", "add tests"),
 * any earlier temporary constraint (e.g. "do not change any files yet") is superseded.
 * Non-conflicting constraints (e.g. "don't touch production code", "use the existing test framework")
 * remain standing.
 */
export function detectConstraintOverrides(
  text: string,
  constraints: readonly ConversationConstraint[],
): string[] {
  const raw = String(text ?? '');
  if (!constraints.length) return [];
  const overridden: string[] = [];
  const hasMutation = hasPositiveMutationIntent(raw);

  for (const constraint of constraints) {
    // 1. Temporary constraints (e.g. "do not change any files yet") conflict with explicit mutation instructions.
    // Precedence: latest explicit instruction > earlier conflicting temporary constraint.
    if (isTemporaryConstraint(constraint.text)) {
      if (hasMutation) {
        const restates = extractConstraints(raw).some(c => isTemporaryConstraint(c));
        if (!restates) {
          overridden.push(constraint.id);
          continue;
        }
      }
    }

    // 2. Subject-specific overrides:
    const subjects = constraintSubjects(constraint.text);
    if (subjects.size === 0) continue;
    const mentionsSubject = [...subjects].some(subject => new RegExp(`\\b${escapeRegExp(subject)}\\b`, 'i').test(raw));
    if (!mentionsSubject) continue;
    // The new turn must both name the subject AND ask for the action the
    // constraint forbade. "Don't change the tests" is not lifted by "run the
    // tests"; it is lifted by "actually, update the tests too".
    if (!POSITIVE_ACTION.test(raw)) continue;
    // Guard against a restated constraint ("still don't change the tests")
    // being read as its own override.
    if (extractConstraints(raw).some(item => constraintSubjects(item).has([...subjects][0]))) continue;
    overridden.push(constraint.id);
  }
  return overridden;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Merges the constraints already stored for this objective with the ones this
 * turn adds, minus the ones this turn explicitly overrode.
 */
export function reconcileConstraints(
  text: string,
  existing: readonly ConversationConstraint[],
  now: string,
): { constraints: ConversationConstraint[]; added: string[]; overriddenIds: string[] } {
  const overriddenIds = detectConstraintOverrides(text, existing);
  const kept = existing.filter(item => !overriddenIds.includes(item.id));
  const added = extractConstraints(text).filter(
    candidate => !kept.some(item => item.text.toLowerCase() === candidate.toLowerCase()),
  );
  const constraints = [
    ...kept,
    ...added.map((constraintText, index) => ({
      id: `cons_${now.replace(/[^0-9]/g, '')}_${index}`,
      text: constraintText,
      createdAt: now,
    })),
  ];
  return { constraints, added, overriddenIds };
}

// ── Objective summary ──────────────────────────────────────────────────────

/**
 * A short, human-readable label for the objective, derived from the request
 * text alone. Used for the durable record and for the "Continuing: …" cue.
 */
export function summarizeObjective(text: string): string {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  const firstSentence = normalized.split(/(?<=[.!?])\s/)[0] || normalized;
  const trimmed = firstSentence.replace(/^\s*(?:ok(?:ay)?|yes|sure|please|well|alright|actually|now)[,.!]\s*/i, '');
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}

/**
 * camelCase / PascalCase / snake_case identifiers named in the text.
 *
 * Used for two things, both of which CONFIRM the token against the repository
 * before trusting it: deciding whether a plain question is really about this
 * codebase (`AgentPanel.isRepositoryContextQuestion`), and recording which
 * symbols an objective is about. There is deliberately no equivalent
 * path-from-prose extractor — `relevantFiles` is populated only from files the
 * system authoritatively used, never from a path the user or the model typed.
 */
export function extractReferencedSymbols(text: string): string[] {
  const matches = String(text ?? '').match(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]+_[a-z0-9_]+)\b/g) ?? [];
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const match of matches) {
    if (seen.has(match)) continue;
    seen.add(match);
    symbols.push(match);
    if (symbols.length >= 12) break;
  }
  return symbols;
}

// ── Follow-up resolution ───────────────────────────────────────────────────

export type RepositoryRevalidation =
  | { status: 'unchanged' }
  | { status: 'changed'; changedPaths: string[]; missingPaths: string[] }
  | { status: 'unknown' };

export type FollowUpResolution =
  | { status: 'not_referential' }
  | { status: 'resolved'; objective: string; objectiveId: string }
  | { status: 'needs_clarification'; message: string };

/**
 * Resolves a referential follow-up against the durable working state.
 *
 * The three refusals are the milestone's safety rule (Step 3 + Step 6):
 *  - nothing persisted        -> ask what to continue;
 *  - the objective belongs to another workspace/objective -> ask;
 *  - the repository moved while we were closed -> offer to re-inspect first,
 *    because the persisted narrative is explicitly NOT evidence that the
 *    bytes still look the way the summary describes.
 */
export function resolveFollowUp(input: {
  text: string;
  state: ConversationWorkingStateRecord | null;
  revalidation: RepositoryRevalidation;
}): FollowUpResolution {
  if (!isReferentialFollowUp(input.text)) return { status: 'not_referential' };
  const state = input.state;
  if (!state || !state.currentObjective) {
    return {
      status: 'needs_clarification',
      message: "I don't have a previous task in this conversation to continue. What would you like me to work on?",
    };
  }
  if (input.revalidation.status === 'changed') {
    const changed = [...input.revalidation.changedPaths, ...input.revalidation.missingPaths];
    const detail = changed.length ? ` (${changed.slice(0, 3).join(', ')})` : '';
    return {
      status: 'needs_clarification',
      message: `I remember we were working on: ${state.currentObjective}. The repository has changed since then${detail}.`
        + ' Should I re-inspect it before continuing?',
    };
  }
  return { status: 'resolved', objective: state.currentObjective, objectiveId: state.objectiveId };
}

/**
 * The one-line cue shown when a conversation resumes with a live objective
 * (Step 7). Returns `undefined` when there is nothing worth saying, so the
 * normal experience stays quiet.
 */
export function continuityCue(
  state: ConversationWorkingStateRecord | null,
  revalidation: RepositoryRevalidation,
): string | undefined {
  if (!state?.currentObjective) return undefined;
  if (revalidation.status === 'changed') {
    return `Resumed previous conversation — the repository changed since we last worked on: ${state.currentObjective}`;
  }
  return `Continuing: ${state.currentObjective}`;
}

/**
 * The bounded constraint block carried into an autonomous (Karke Dikha) goal.
 *
 * Karke Dikha's context policy deliberately excludes conversation history
 * (`core/domain/contextPolicy.ts`), and Core's frozen-context invariant
 * requires the M15 task goal to equal the submitted `currentMessage`
 * verbatim. So the only correct way for a carried-forward constraint to reach
 * an autonomous run is to be part of the request the user actually submits —
 * which is also the honest way: the user sees exactly the goal that executes.
 * Returns `''` when there is nothing to carry.
 */
/**
 * The bounded constraint block carried into an autonomous (Karke Dikha) goal.
 *
 * Karke Dikha's context policy deliberately excludes conversation history
 * (`core/domain/contextPolicy.ts`), and Core's frozen-context invariant
 * requires the M15 task goal to equal the submitted `currentMessage`
 * verbatim. So the only correct way for a carried-forward constraint to reach
 * an autonomous run is to be part of the request the user actually submits —
 * which is also the honest way: the user sees exactly the goal that executes.
 * Returns `''` when there is nothing to carry.
 */
export function formatCarriedConstraints(
  input: readonly ConversationConstraint[] | ConversationWorkingStateRecord | null,
): string {
  if (!input) return '';
  const constraints: readonly ConversationConstraint[] = 'userConstraints' in input
    ? (input.userConstraints ?? [])
    : input;
  if (!constraints.length) return '';
  return `\n\nConstraints carried forward from this conversation: ${constraints.map(item => item.text).join('; ')}.`;
}

// ── Deictic reference resolution & Autonomous objective compilation ──────

const TWO_CASES_DEICTIC_PATTERN = /\b(?:those|these|the)\s+(?:two|2)\s+(?:cases|scenarios|examples|edge\s+cases|mechanisms|reasons|factors|approaches|options)\b/i;
const GENERIC_CASES_DEICTIC_PATTERN = /\b(?:those|these)\s+(?:cases|scenarios|examples|edge\s+cases|mechanisms|reasons|factors|approaches|options)\b/i;
const ORDINAL_OPTION_DEICTIC_PATTERN = /\b(?:the\s+)?(first|second|third|1st|2nd|3rd)\s+option\b/i;
const NUMBERED_OPTION_DEICTIC_PATTERN = /\boption\s+(1|2|3|one|two|three)\b/i;
const SUGGESTION_DEICTIC_PATTERN = /\b(?:what\s+you\s+(?:just\s+)?(?:suggested|proposed|recommended)|your\s+(?:suggestion|proposal|recommendation)|as\s+you\s+(?:suggested|proposed|recommended))\b/i;
const BARE_BUG_DEICTIC_PATTERN = /\b(?:that|this|the)\s+bug\b(?!\s+(?:where|in|when|with|that|which))\b/i;
const BARE_FILES_DEICTIC_PATTERN = /\b(?:those|these)\s+files\b(?!\s+(?:in|under|matching|with))\b/i;
const BARE_FILE_DEICTIC_PATTERN = /\b(?:that|this)\s+file\b(?!\s+(?:in|under|called|named))\b/i;

/**
 * An anaphoric instruction to ACT on what the assistant just said ("build it", "apply those fixes", "fix what you
 * found", "make those changes"). Every alternative needs a pronoun/demonstrative or a "what you <verb>" clause, so a
 * self-contained objective ("Build me a calculator app") can never match.
 */
const ACTION_VERB = String.raw`(?:implement|build|apply|do|make|fix|add|ship|use|go\s+with|execute|carry\s+out|land|code|write)`;
const PROPOSAL_NOUN = '(?:changes|fixes|improvements|suggestions|edits|updates|recommendations|proposals?|plan|steps|items|ideas|points|findings)';
const PROPOSAL_ANAPHOR_PATTERN = new RegExp(
  String.raw`^\s*(?:(?:ok(?:ay)?|yes|yeah|sure|please|alright|now|go ahead and|and)[,.!]?\s+)*${ACTION_VERB}\s+(?:`
  + String.raw`(?:it|that|this|them|those|these)(?:\s+${PROPOSAL_NOUN})?(?:\s+(?:now|please|all))?`
  + String.raw`|(?:all\s+)?(?:of\s+)?(?:the\s+)?${PROPOSAL_NOUN}(?:\s+(?:you|we)\s+(?:found|proposed|suggested|listed|discussed|mentioned|recommended))?`
  + String.raw`|what\s+(?:you|we)\s+(?:just\s+)?(?:found|proposed|suggested|listed|discussed|mentioned|recommended|said)`
  + String.raw`)\s*[.!]?\s*$`,
  'i',
);

export function hasProposalAnaphor(text: string): boolean {
  const trimmed = String(text ?? '').trim();
  return trimmed.length > 0 && trimmed.length <= 120 && PROPOSAL_ANAPHOR_PATTERN.test(trimmed);
}

const MAX_REFERENT_CHARS = 1800;

/**
 * Resolves a proposal anaphor against the assistant answer it points at. The concrete objective is the assistant's own
 * proposal (bounded), so the user never has to restate it. Returns null when there is nothing to resolve against.
 */
export function resolveProposalAnaphor(text: string, precedingAssistantMessage: string | null | undefined): string | null {
  if (!hasProposalAnaphor(text)) return null;
  const referent = String(precedingAssistantMessage ?? '').trim();
  if (referent.length < 20) return null;
  const bounded = referent.length > MAX_REFERENT_CHARS ? `${referent.slice(0, MAX_REFERENT_CHARS)}…` : referent;
  return `${String(text).trim()}

Referent — what you previously proposed, to be implemented now:
${bounded}`;
}

export function hasDeicticReference(text: string): boolean {
  return TWO_CASES_DEICTIC_PATTERN.test(text)
    || GENERIC_CASES_DEICTIC_PATTERN.test(text)
    || ORDINAL_OPTION_DEICTIC_PATTERN.test(text)
    || NUMBERED_OPTION_DEICTIC_PATTERN.test(text)
    || SUGGESTION_DEICTIC_PATTERN.test(text)
    || BARE_BUG_DEICTIC_PATTERN.test(text)
    || BARE_FILES_DEICTIC_PATTERN.test(text)
    || BARE_FILE_DEICTIC_PATTERN.test(text);
}

export function hasUnresolvedDeicticReference(text: string): boolean {
  if (/\b(?:those|these)\s+(?:two\s+|2\s+)?(?:cases|scenarios|examples|edge\s+cases)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:the\s+(?:two|2)\s+(?:cases|scenarios|examples|edge\s+cases))\b(?!\s*[:(])/i.test(text)) {
    return true;
  }
  if (/\b(?:the\s+)?(?:first|second|third|1st|2nd|3rd)\s+option\b(?!\s*[:(])/i.test(text)) {
    return true;
  }
  if (/\boption\s+(?:1|2|3|one|two|three)\b(?!\s*[:(])/i.test(text)) {
    return true;
  }
  if (/\b(?:what\s+you\s+(?:just\s+)?(?:suggested|proposed|recommended)|your\s+(?:suggestion|proposal|recommendation)|as\s+you\s+(?:suggested|proposed|recommended))\b(?!\s*[:(])/i.test(text)) {
    return true;
  }
  if (/\b(?:that|this)\s+bug\b(?!\s*[:(])(?!\s+(?:where|in|when|with|that|which))\b/i.test(text)) {
    return true;
  }
  if (/\b(?:those|these)\s+files\b(?!\s*[:(])(?!\s+(?:in|under|matching|with))\b/i.test(text)) {
    return true;
  }
  if (/\b(?:that|this)\s+file\b(?!\s*[:(])(?!\s+(?:in|under|called|named))\b/i.test(text)) {
    return true;
  }
  return false;
}

function cleanCandidateText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[*_~`]+|[*_~`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;:]+$/, '');
}

export function extractEnumeratedCases(contextText: string): string[] {
  if (!contextText) return [];
  const lines = contextText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const labeled: string[] = [];
  const numbered: string[] = [];
  const bulleted: string[] = [];

  for (const line of lines) {
    // Assistant answers commonly present ranked cases as Markdown headings
    // (`### 1. ...`). Treat the heading marker as presentation only; the
    // numbered case remains the authoritative content.
    const candidateLine = line.replace(/^#{1,6}\s+/, '');
    const caseMatch = candidateLine.match(/^(?:case\s*\d+[:.-]|scenario\s*\d+[:.-])\s*(.+)$/i);
    if (caseMatch) {
      labeled.push(caseMatch[1].trim());
      continue;
    }
    const numMatch = candidateLine.match(/^(?:\d+[.):]|\(\d+\))\s*(.+)$/);
    if (numMatch) {
      numbered.push(numMatch[1].trim());
      continue;
    }
    const bulletMatch = candidateLine.match(/^[-*•]\s*(.+)$/);
    if (bulletMatch) {
      bulleted.push(bulletMatch[1].trim());
      continue;
    }
  }

  let candidates = labeled.length > 0 ? labeled : numbered.length > 0 ? numbered : bulleted;

  if (candidates.length === 0) {
    let afterHeader = false;
    for (const line of lines) {
      if (/(?:cases|scenarios|boundary\s+conditions|concrete\s+cases|two\s+cases|following):\s*$/i.test(line)) {
        afterHeader = true;
        continue;
      }
      if (afterHeader) {
        if (!line || /^[A-Z][a-z]+:/.test(line)) break;
        candidates.push(line);
      }
    }
  }

  if (candidates.length === 0) {
    const nonHeaders = lines.filter(l => !l.endsWith(':') && !l.endsWith('?') && l.length >= 8);
    if (nonHeaders.length === 2) {
      candidates = nonHeaders;
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates.map(cleanCandidateText).filter(c => c.length >= 5)) {
    const key = c.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }
  return unique;
}

export function extractNumberedOptions(contextText: string): string[] {
  if (!contextText) return [];
  const lines = contextText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const labeled: string[] = [];
  const numbered: string[] = [];

  for (const line of lines) {
    const optMatch = line.match(/^(?:option\s*(?:\d+|[a-c]|one|two|three)[:.-]|approach\s*(?:\d+|[a-c]|one|two|three)[:.-])\s*(.+)$/i);
    if (optMatch) {
      labeled.push(optMatch[1].trim());
      continue;
    }
    const numMatch = line.match(/^(?:\d+[.):]|\(\d+\))\s*(.+)$/);
    if (numMatch) {
      numbered.push(numMatch[1].trim());
      continue;
    }
  }

  const candidates = labeled.length > 0 ? labeled : numbered;
  return candidates.map(cleanCandidateText).filter(c => c.length >= 5);
}

export function extractAssistantSuggestion(contextText: string): string | undefined {
  if (!contextText) return undefined;
  const match = contextText.match(/(?:I\s+(?:suggest|propose|recommend)|suggestion:|recommendation:|suggested\s+(?:fix|approach):)\s*([^\r\n]+)/i);
  if (match) {
    const raw = match[1].trim();
    const sentenceEnd = raw.match(/^(.+?\.(?=\s+[A-Z]|\s*$))/);
    const candidate = sentenceEnd ? sentenceEnd[1] : raw;
    return cleanCandidateText(candidate);
  }
  return undefined;
}

export function extractAssistantBugDescription(
  contextText: string,
  objective?: string,
): string | undefined {
  if (contextText) {
    const match = contextText.match(/(?:bug|defect|issue|error|failure):\s*([^\r\n]+)/i)
      || contextText.match(/(?:the\s+bug\s+is\s+|found\s+a\s+bug\s+in\s+)([^\r\n]+)/i);
    if (match) {
      const raw = match[1].trim();
      const sentenceEnd = raw.match(/^(.+?\.(?=\s+[A-Z]|\s*$))/);
      const candidate = sentenceEnd ? sentenceEnd[1] : raw;
      return cleanCandidateText(candidate);
    }
  }
  if (objective && /\b(?:bug|defect|fix|issue|error)\b/i.test(objective)) {
    return cleanCandidateText(objective);
  }
  return undefined;
}

export function extractRelevantFilePaths(
  contextText: string,
  state?: ConversationWorkingStateRecord | null,
): string[] {
  const found = new Set<string>();
  if (state?.relevantFiles) {
    for (const f of state.relevantFiles) {
      const p = typeof f === 'string' ? f : (f as { path?: string })?.path;
      if (p) found.add(p.replace(/\\/g, '/'));
    }
  }
  const fileRegex = /(?:^|\s|["'`(])([\w.-]+(?:[/\\][\w.-]+)+\.[a-zA-Z0-9]+)\b/g;
  for (const match of (contextText ?? '').matchAll(fileRegex)) {
    found.add(match[1].replace(/\\/g, '/'));
  }
  const list = [...found];
  return list.filter(p => !list.some(other => other !== p && other.endsWith('/' + p)));
}

export interface AutonomousObjectiveCompilationInput {
  text: string;
  state: ConversationWorkingStateRecord | null;
  precedingAssistantMessage?: string;
  recentMessages?: Array<{ role: string; content: string }>;
}

export type AutonomousObjectiveCompilationResult =
  | { status: 'compiled'; objective: string }
  | { status: 'needs_clarification'; message: string };

/**
 * Compiles a self-contained execution objective from the active conversation context
 * before an Auto-routed conversational request becomes a KarkeDikha task.
 *
 * Applies precedence:
 *   latest explicit instruction > earlier conflicting temporary constraint > inferred context
 *
 * Preserves non-conflicting constraints.
 * Fails closed with needs_clarification if conversational references are ambiguous.
 */
export function compileAutonomousObjective(
  input: AutonomousObjectiveCompilationInput,
): AutonomousObjectiveCompilationResult {
  const rawText = String(input.text ?? '').trim();
  if (!rawText) {
    return { status: 'needs_clarification', message: 'What would you like Karke Dikha to work on?' };
  }

  // Combine available context sources: preceding assistant turn, working state findings, etc.
  const contextSources = [
    input.precedingAssistantMessage ?? '',
    input.state?.latestFindingsSummary ?? '',
  ].filter(Boolean);
  const contextText = [...new Set(contextSources)].join('\n\n');

  let resolved = rawText;

  // 1. Resolve "those two cases" / "these two cases" / "the two cases"
  if (TWO_CASES_DEICTIC_PATTERN.test(resolved)) {
    const cases = extractEnumeratedCases(contextText);
    if (cases.length === 2) {
      resolved = resolved.replace(
        TWO_CASES_DEICTIC_PATTERN,
        `the two cases: (1) ${cases[0]}, and (2) ${cases[1]}`,
      );
    } else {
      return {
        status: 'needs_clarification',
        message: "I couldn't identify the two cases to cover from the previous conversation. Please specify the cases directly.",
      };
    }
  } else if (GENERIC_CASES_DEICTIC_PATTERN.test(resolved)) {
    const cases = extractEnumeratedCases(contextText);
    if (cases.length > 0) {
      resolved = resolved.replace(
        GENERIC_CASES_DEICTIC_PATTERN,
        `the cases: ${cases.map((c, i) => `(${i + 1}) ${c}`).join(', ')}`,
      );
    } else {
      return {
        status: 'needs_clarification',
        message: "I couldn't identify the cases to cover from the previous conversation. Please specify the cases directly.",
      };
    }
  }

  // 2. Resolve "the second option" / "option 2" / "the first option"
  const ordMatch = resolved.match(ORDINAL_OPTION_DEICTIC_PATTERN);
  const numMatch = resolved.match(NUMBERED_OPTION_DEICTIC_PATTERN);
  if (ordMatch || numMatch) {
    const options = extractNumberedOptions(contextText);
    const ordinalWord = (ordMatch?.[1] || numMatch?.[1] || '').toLowerCase();
    const targetIndex = (ordinalWord === 'first' || ordinalWord === '1st' || ordinalWord === '1' || ordinalWord === 'one') ? 0
      : (ordinalWord === 'second' || ordinalWord === '2nd' || ordinalWord === '2' || ordinalWord === 'two') ? 1
      : (ordinalWord === 'third' || ordinalWord === '3rd' || ordinalWord === '3' || ordinalWord === 'three') ? 2
      : -1;

    if (targetIndex >= 0 && options[targetIndex]) {
      const patternToReplace = ordMatch ? ORDINAL_OPTION_DEICTIC_PATTERN : NUMBERED_OPTION_DEICTIC_PATTERN;
      resolved = resolved.replace(
        patternToReplace,
        `option ${targetIndex + 1} (${options[targetIndex]})`,
      );
    } else {
      return {
        status: 'needs_clarification',
        message: "I couldn't identify the requested option from the previous conversation. Please clarify which option to proceed with.",
      };
    }
  }

  // 3. Resolve "what you just suggested" / "your suggestion"
  if (SUGGESTION_DEICTIC_PATTERN.test(resolved)) {
    const suggestion = extractAssistantSuggestion(contextText);
    if (suggestion) {
      resolved = resolved.replace(
        SUGGESTION_DEICTIC_PATTERN,
        `the suggestion (${suggestion})`,
      );
    } else {
      return {
        status: 'needs_clarification',
        message: "I'm not sure which suggestion you're referring to. Please specify what you'd like me to implement.",
      };
    }
  }

  // 3b. Anaphoric "build it" / "apply those fixes": the referent is the assistant's previous proposal.
  if (hasProposalAnaphor(resolved) && !SUGGESTION_DEICTIC_PATTERN.test(rawText)) {
    const anaphorResolved = resolveProposalAnaphor(resolved, input.precedingAssistantMessage);
    if (anaphorResolved) {
      resolved = anaphorResolved;
    } else {
      return {
        status: 'needs_clarification',
        message: "I'm not sure which proposal you're referring to. Please specify what you'd like me to implement.",
      };
    }
  }

  // 4. Resolve "that bug" / "this bug"
  if (BARE_BUG_DEICTIC_PATTERN.test(resolved)) {
    const bug = extractAssistantBugDescription(contextText, input.state?.currentObjective);
    if (bug) {
      resolved = resolved.replace(
        BARE_BUG_DEICTIC_PATTERN,
        `the bug (${bug})`,
      );
    } else {
      return {
        status: 'needs_clarification',
        message: "I'm not sure which bug you are referring to. Please specify the bug details.",
      };
    }
  }

  // 5. Resolve "those files" / "these files"
  if (BARE_FILES_DEICTIC_PATTERN.test(resolved)) {
    const files = extractRelevantFilePaths(contextText, input.state);
    if (files.length > 0) {
      resolved = resolved.replace(
        BARE_FILES_DEICTIC_PATTERN,
        `the files (${files.join(', ')})`,
      );
    } else {
      return {
        status: 'needs_clarification',
        message: "I'm not sure which files you are referring to. Please specify the file paths.",
      };
    }
  } else if (BARE_FILE_DEICTIC_PATTERN.test(resolved)) {
    const files = extractRelevantFilePaths(contextText, input.state);
    if (files.length === 1) {
      resolved = resolved.replace(
        BARE_FILE_DEICTIC_PATTERN,
        `the file (${files[0]})`,
      );
    } else {
      return {
        status: 'needs_clarification',
        message: "I'm not sure which file you are referring to. Please specify the file path.",
      };
    }
  }

  // Verify that no unresolved deictic references remain
  if (hasUnresolvedDeicticReference(resolved)) {
    return {
      status: 'needs_clarification',
      message: "The request contains references to previous conversation context that could not be resolved. Please provide a self-contained instruction.",
    };
  }

  // Precedence & constraint conflict resolution:
  // latest explicit instruction > earlier conflicting temporary constraint > inferred context
  // Preserve non-conflicting constraints.
  const existingConstraints = input.state?.userConstraints ?? [];
  const overriddenIds = detectConstraintOverrides(resolved, existingConstraints);
  const kept = existingConstraints.filter(c => !overriddenIds.includes(c.id));
  const nonConflicting = hasPositiveMutationIntent(resolved)
    ? kept.filter(c => !isTemporaryConstraint(c.text))
    : kept;

  const carried = formatCarriedConstraints(nonConflicting);
  const compiledObjective = carried ? `${resolved}${carried}` : resolved;

  return { status: 'compiled', objective: compiledObjective };
}
