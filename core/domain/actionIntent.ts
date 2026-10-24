/**
 * Canonical action-intent rule shared by every router and by the mutation policy.
 *
 * Invariant: discussion about a possible change != authorization to propose a mutation.
 * Intent is judged per clause; a question-form or hypothetical clause is advisory; only an affirmative
 * clause (imperative, first-person authorization, explicit polite request) crosses into mutation.
 * An explicit request to inspect or diagnose is its own class: investigation with tools, never mutation.
 *
 * The webview keeps a mirrored JS copy (media/everyday-presentation.js, media/chat-runtime-fixes.js) because
 * the extension host and the webview are separate programs; mutationIntentBoundary.test.ts pins them together.
 */

/** Strips short conversational acknowledgments ("Okay,", "Good. Now") so a verb right after them still opens its clause. */
export function stripLeadingFiller(text: string): string {
  return text.replace(
    /^\s*(?:(?:ok(?:ay)?|yes|sure|please|well|alright|actually|now|good|great|perfect|thanks|thank you)\b(?:\s*[,!.]\s*|\s+|$))+/i,
    '',
  );
}

// Mutation-capable routing needs AFFIRMATIVE action intent. Talking about a possible change
// ("What would you change here?", "Which file would need changing?", "How would you implement
// retries?", "Would you change this function?") is advisory: discussion != authorization.
// The text is judged clause by clause; a question-form clause never authorises a mutation.
const MUTATION_VERBS = 'create|add|update|edit|modify|fix|implement|write|delete|remove|rename|move|refactor|install|commit|push|apply|replace|build|change|improve|adjust|tweak|redesign|restyle|rework|polish|simplify|extend|convert|enable|disable|support|persist|save|store|hide|optimi[sz]e';
const CLAUSE_LEAD = '(?:(?:and|then|also|so|now|please|go ahead(?: and)?)[\\s,]+)*';
const QUESTION_OPENER = /^(?:(?:so|and|but|ok(?:ay)?|well|now|hmm)\b[\s,]*)*(?:what|which|where|why|how|who|when|whether|should|would|could|can|will|do|does|did|is|are|was|were|might|shall)\b/i;
// A second-person yes/no question that asks KKD to act is a request, not a hypothetical: politeness and interrogative
// grammar are not hypothetical intent. can/could/will you = ability/volition addressed to KKD. "would you" is counterfactual
// ("would you change this function?" asks for an opinion) unless it carries a benefactive/politeness marker ("for me", "please").
const POLITE_REQUEST = /^(?:(?:so|and|ok(?:ay)?|well|now|hey)\b[\s,]*)*(?:(?:can|could|will)\s+you\b|would\s+you\s+(?:please|kindly)\b|would\s+you\b[^?]*\b(?:for me|for us|please|kindly)\b)/i;
const HYPOTHETICAL = /\b(?:if|would|might|could|should|whether|maybe|perhaps|suppose|imagine|hypothetically|needs?\s+(?:to\s+be\s+)?(?:chang|modif|updat|fix)\w*)\b/i;
const IMPERATIVE_FIRST = new RegExp('^' + CLAUSE_LEAD + '(?:' + MUTATION_VERBS + ')\\b', 'i');
// Target-first imperative: the clause names the file it acts on before the verb ("ai_news.html edit this html and ...").
const TARGET_FIRST_IMPERATIVE = new RegExp('^' + CLAUSE_LEAD + '(?:(?:in|for|on|to|at)\\s+)?[`"\']?[\\w./\\\\-]+\\.[A-Za-z][A-Za-z0-9]{0,5}[`"\']?\\s*[,:;-]?\\s+(?:please\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');
const CONJOINED_VERB = new RegExp('\\b(?:and|then|also)\\s+(?:please\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');
const FIRST_PERSON_FRAME = new RegExp('\\b(?:let me|let\'s|lets|i want (?:you )?to|i\'d like (?:you )?to|i would like (?:you )?to|i need (?:you )?to|we need to)\\s+(?:please\\s+)?(?:be able to\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');
const POLITE_FRAME = new RegExp('(?:can|could|would|will)\\s+you\\s+(?:please\\s+|kindly\\s+)?(?:be able to\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');

const BEHAVIOUR_ASK = /^\s*(?:(?:also|and|then)\s+)?(?:ask|warn|prompt|require)\s+(?:me|the user|users?)\s+(?:before|to confirm|for confirmation|first)\b/i;
const BEHAVIOUR_MAKE = /^\s*(?:(?:also|and|then)\s+)?(?:make|keep)\s+(?:it|this|that)\s+\S/i;
// M55: a copy request creates a file; verbs like make/create only counted before it/this/that, so "Make a new copy of x.html" stayed in Baat Kar.
const COPY_REQUEST = /^\s*(?:(?:and|then|also|so|now|please|go ahead(?: and)?)[\s,]+)*(?:(?:make|create|save|produce)\s+(?:me\s+)?(?:a|an|another|one)?\s*(?:(?:new|separate|backup|duplicate)\s+)*(?:copy|duplicate|clone|backup)\b|(?:copy|duplicate|clone)\s+(?:the\s+|this\s+|that\s+)?(?:file\s+)?[`"']?[\w./\-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b)/i;

export function splitClauses(text: string): string[] {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(part => part.trim()).filter(Boolean);
}

const NEGATIVE_IMPERATIVE = /^(?:(?:so|and|but|ok(?:ay)?|well|now|hmm)\b[\s,]*)*(?:do(?:es)?\s+not|don't|never|must\s+not|mustn't)\b/i;

function isAdvisoryClause(clause: string): boolean {
  if (POLITE_REQUEST.test(clause)) return false;
  if (NEGATIVE_IMPERATIVE.test(clause)) return false;
  return /\?\s*$/.test(clause) || QUESTION_OPENER.test(clause);
}

// A change verb whose object is the conversation itself ("fix your explanation", "correct your previous answer",
// "improve your recommendation") edits the reply, not the workspace. A file/code noun in the clause keeps it a mutation.
const CONVERSATIONAL_OBJECT = /\b(?:your|my|the|that|this)\s+(?:(?:previous|prior|earlier|last|above|original|own)\s+)*(?:answers?|explanations?|responses?|repl(?:y|ies)|recommendations?|inferences?|analys[ie]s|summar(?:y|ies)|claims?|assessments?|findings|reasoning|instructions|conclusions?|wording|phrasing)\b/i;
const WORKSPACE_NOUN = /\b(?:files?|code|repo(?:sitory)?|codebase|workspace|readme|package\.json|config|tests?|scripts?|functions?|methods?|classes|modules?|[\w.-]+\.(?:md|json|ya?ml|toml|tsx?|jsx?|mjs|cjs|py|java|c|cc|cpp|h|hpp|cs|go|rs|html|css|bat|sh|ps1|txt))\b/i;
function isConversationalEdit(clause: string): boolean {
  return CONVERSATIONAL_OBJECT.test(clause) && !WORKSPACE_NOUN.test(clause);
}

const INSTRUMENT_FIRST_FRAME = new RegExp('^' + CLAUSE_LEAD + '(?:use|using|with)\\s+[^.\\n!?]{0,80}\\b(?:to\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');
// A verb form right after a determiner is a noun or modifier ("the update function", "a change proposal", "this patch"),
// not an instruction to act.
const NOT_AFTER_DETERMINER = '(?<!\\b(?:the|a|an|this|that|these|those|its|their|our|your|my|his|her)\\s+)';
const DIRECT_MUTATION_DIRECTIVE = new RegExp(
  NOT_AFTER_DETERMINER + '\\b(?:create|add|write|implement|modify|edit|change|update|patch|generate|make)\\b[^.\\n!?]{0,100}\\b(?:file|files|code|config|test|readme|package\\.json|workflow|application|feature|method|function|validation|message|[\\w.-]+\\.[A-Za-z][A-Za-z0-9]{0,7})\\b',
  'i',
);

// M50: a clause that opens by asking for an explanation, comparison or inspection is ABOUT something. Mutation vocabulary
// inside it ("Explain how the update function works", "Describe how to write a new file") is subject matter, never a
// directive. Such a clause carries a directive only through a coordinated, unconditional imperative of its own ("Review
// a.txt and fix it", "Read the config, then update the timeout"). A verb coordinated with another verb ("between create
// and update", "create, update and delete") names operations; it does not order one.
const EXPLANATORY_LEAD = new RegExp('^' + CLAUSE_LEAD + '(?:explain|describe|summari[sz]e|review|read|compare|contrast|analy[sz]e|inspect|investigate|examine|study|clarify|assess|evaluate|outline|list|check|look\\s+(?:at|over|into|through)|go\\s+(?:over|through)|walk\\s+(?:me|us)\\s+through|tell\\s+(?:me|us)|show\\s+(?:me|us)|help\\s+(?:me|us)\\s+understand|teach\\s+(?:me|us))\\b', 'i');
const COORDINATED_DIRECTIVE = new RegExp(
  '(?<!\\b(?:' + MUTATION_VERBS + ')\\s*)(?:\\b(?:and|then|also)\\b|[,;])\\s*(?:(?:then|and|also)\\s+)*(?:please\\s+)?(?:' + MUTATION_VERBS + ')\\b(?!\\s*(?:,|\\band\\b|\\bor\\b|operations?\\b|methods?\\b|functions?\\b|endpoints?\\b|calls?\\b))',
  'i',
);

function clauseHasMutationIntent(clause: string): boolean {
  if (isAdvisoryClause(clause)) return false;
  if (isConversationalEdit(clause)) return false;
  if (EXPLANATORY_LEAD.test(clause)) return COORDINATED_DIRECTIVE.test(clause) && !HYPOTHETICAL.test(clause);
  return IMPERATIVE_FIRST.test(clause)
    || TARGET_FIRST_IMPERATIVE.test(clause)
    || INSTRUMENT_FIRST_FRAME.test(clause)
    || CONJOINED_VERB.test(clause)
    || FIRST_PERSON_FRAME.test(clause)
    || POLITE_FRAME.test(clause)
    // Behaviour-change instructions with no code verb: "ask me before it deletes", "make it export Excel".
    || BEHAVIOUR_ASK.test(clause)
    || BEHAVIOUR_MAKE.test(clause)
    || COPY_REQUEST.test(clause)
    || (!HYPOTHETICAL.test(clause) && DIRECT_MUTATION_DIRECTIVE.test(clause));
}

export function hasAffirmativeMutationIntent(text: string): boolean {
  // A negation only shields its own clause: "do not modify X" as a constraint inside a larger
  // "Fix …" request must not veto the request's separate positive imperatives.
  const scrubbed = stripLeadingFiller(String(text ?? '')).replace(NEGATED_MUTATION, ' ');
  return splitClauses(scrubbed).some(clauseHasMutationIntent);
}

const NEGATED_MUTATION = /\b(?:do not|don't|never|without)\b[^.\n!?]{0,80}\b(?:create|add|update|edit|modify|fix|implement|write|delete|remove|rename|move|refactor|install|commit|push|apply|change)\b/gi;

/**
 * Mutation words appear only as subject matter: the text has no affirmative mutation clause, and every clause that uses
 * such a word is a question, an explanation/inspection request, a conditional, or a negated constraint. Callers that
 * detect change requests by keyword (task classification) use this so "Describe how to write a file" or "If tests fail,
 * fix the code" are not recorded as tasks whose completion requires a change. It never grants or denies a tool.
 */
export function mentionsMutationOnlyAsSubjectMatter(text: string, mutationWord: RegExp): boolean {
  const value = stripLeadingFiller(String(text ?? ''));
  if (hasAffirmativeMutationIntent(value)) return false;
  return splitClauses(value).every((clause) => {
    const remaining = clause.replace(NEGATED_MUTATION, ' ');
    if (!mutationWord.test(remaining)) return true;
    return isAdvisoryClause(clause) || EXPLANATORY_LEAD.test(clause) || HYPOTHETICAL.test(clause);
  });
}

/**
 * A change the objective authorizes only under a condition ("Fix only if tests fail", "If validation fails, repair the
 * code", "Investigate; fix only if tests demonstrate the defect"). Such an objective does not mandate a change, and the
 * model's own claim that the condition held (or did not) is not evidence: completion is decided from recorded tool
 * evidence by `evaluateConditionalCompletion` (core/runtime/completionGate.ts).
 */
export interface ConditionalMutation {
  /** The sub-clause that gates the change. */
  clause: string;
  /** `validation`: the condition is a test/build/lint outcome, established only by a recorded validation run.
   *  `inspection`: any other condition, established by recorded inspection of the workspace. */
  kind: 'validation' | 'inspection';
  /** For a validation condition: whether the change is authorized by a failing (`failure`) or passing (`success`) run. */
  polarity: 'failure' | 'success';
  /** The objective ALSO directs a change unconditionally ("Fix only if tests fail. Update README."). */
  unconditionalChange: boolean;
  /** Why the objective cannot be judged deterministically, or null. A conflict is never completed. */
  conflict: string | null;
}

const CONDITIONAL_VERBS = MUTATION_VERBS + '|repair|correct|resolve|patch|address';
// "even if" and "as if" are not conditions; "if possible" / "if you like" are politeness, not a gate on the change.
const conditionWord = (words: string) => '(?<!\\b(?:even|as)\\s)\\b(?:' + words + ')\\b(?!\\s+(?:possible|you\\s+(?:can|could|like|want|wish|prefer|have\\s+time|are\\s+able|would\\s+like|\'d\\s+like|don\'t\\s+mind)|please)\\b)';
const CONDITION_WORD = conditionWord('only\\s+if|if|unless|in\\s+case');
// A leading "when" gates the change ("When tests fail, fix the code"); a trailing one is usually temporal ("... when done").
const LEADING_CONDITION_WORD = conditionWord('only\\s+if|if|unless|in\\s+case|when(?:ever)?');
// Within one clause; a dot inside a file name (`README.md`) does not end it.
const IN_CLAUSE = '(?:[^.!?\\n]|\\.(?=\\w))';
const LEADING_CONDITION = new RegExp('^' + CLAUSE_LEAD + '(?:but\\s+)?(?:only\\s+)?' + LEADING_CONDITION_WORD + IN_CLAUSE + '{1,160}?(?:,|\\bthen\\b)\\s*(?:then\\s+)?(?:please\\s+)?(?:' + CONDITIONAL_VERBS + ')\\b', 'i');
const TRAILING_CONDITION = new RegExp('^' + CLAUSE_LEAD + '(?:only\\s+)?(?:' + CONDITIONAL_VERBS + ')\\b' + IN_CLAUSE + '{0,120}?' + CONDITION_WORD, 'i');
const VALIDATION_SUBJECT = /\b(?:tests?|test\s+suite|specs?|validation|build|compil\w*|lint\w*|type-?check\w*|tsc|pytest|vitest|jest|ci)\b/i;
const FAILURE_WORD = /\b(?:fail\w*|broken|red|errors?|defects?|bugs?|regress\w*|(?:do(?:es)?\s*n[o']t|not|never)\s+pass\w*)\b/i;
const SUCCESS_WORD = /\b(?:pass(?:es|ed|ing)?|green|succeed\w*)\b/i;
const FORBIDS_VALIDATION_RUN = /\b(?:do not|don't|dont|never|must not|mustn't|without)\s+(?:re-?)?(?:run(?:ning)?|execut\w*|invok\w*)\s+(?:the\s+|any\s+)?(?:tests?|test\s+suite|validation|build|checks?)\b/i;

/** Clauses, further split at semicolons: "Investigate; fix only if ..." is an inspection step then a conditional change. */
function subClauses(text: string): string[] {
  return splitClauses(text).flatMap((clause) => clause.split(/;\s*/)).map((part) => part.trim()).filter(Boolean);
}

function isConditionalMutationClause(clause: string): boolean {
  if (isConversationalEdit(clause)) return false;
  const value = clause.replace(NEGATED_MUTATION, ' ');
  // "When the build breaks, fix it." opens like a question but is a condition; only a real question stays advisory.
  if (LEADING_CONDITION.test(value)) return !/\?\s*$/.test(clause);
  return !isAdvisoryClause(clause) && TRAILING_CONDITION.test(value);
}

/**
 * The objective's conditional change, or null when no change in it is conditional. When a conditional change is combined
 * with an unconditional one, or the condition depends on validation the objective forbids running, `conflict` says so.
 */
export function conditionalMutationDirective(text: string): ConditionalMutation | null {
  const value = stripLeadingFiller(String(text ?? ''));
  const clauses = subClauses(value);
  const conditional = clauses.find(isConditionalMutationClause);
  if (!conditional) return null;
  const validation = FAILURE_WORD.test(conditional) || SUCCESS_WORD.test(conditional)
    ? VALIDATION_SUBJECT.test(conditional) || VALIDATION_SUBJECT.test(value)
    : VALIDATION_SUBJECT.test(conditional);
  const inverted = /\bunless\b/i.test(conditional);
  const success = SUCCESS_WORD.test(conditional) && !FAILURE_WORD.test(conditional);
  const polarity: ConditionalMutation['polarity'] = success !== inverted ? 'success' : 'failure';
  const unconditional = clauses.some((clause) => !isConditionalMutationClause(clause)
    && clauseHasMutationIntent(clause.replace(NEGATED_MUTATION, ' ')));
  const conflict = unconditional
    ? 'the objective combines a conditional change with an unconditional change directive'
    : validation && FORBIDS_VALIDATION_RUN.test(value)
      ? 'the condition depends on a validation run that the objective forbids'
      : null;
  return { clause: conditional, kind: validation ? 'validation' : 'inspection', polarity, unconditionalChange: unconditional, conflict };
}

// Explicit diagnosis request: an investigative verb about a problem. Inspection intent, never mutation intent.
export function hasDiagnosticRequest(text: string): boolean {
  return /\b(?:inspect|investigate|diagnose|debug|troubleshoot|figure out|find out|look into)\b/i.test(text)
    && /\b(?:why|what(?:'s| is)? (?:wrong|going on|happening)|wrong|happening|issue|bug|problem|error|fail(?:s|ed|ing|ure)?|broken|crash(?:es|ing)?|not working|instead of)\b/i.test(text);
}


/**
 * The turn asks to look at / think about something and never crosses into action: an explicit diagnosis request or
 * a question-form clause, with no affirmative mutation clause. Mutating tools must not be offered for such a turn.
 */
export function isInspectionOrAdvisoryOnly(text: string): boolean {
  const value = String(text ?? '');
  if (hasAffirmativeMutationIntent(value)) return false;
  return hasDiagnosticRequest(value) || splitClauses(stripLeadingFiller(value)).some(isAdvisoryClause);
}

/**
 * The model ended its turn by announcing an action it never performed ("I'll submit the complete changed file as one
 * proposal instead."). A first-person future commitment to a workspace action, that is not an offer or a question.
 * Used only to grant the single corrective turn; never to fail an attempt.
 */
export function announcesUnperformedAction(text: string): boolean {
  const value = String(text ?? '');
  const commitment = /\b(?:i'll|i will|i am going to|i'm going to|let me|next,? i(?:'ll| will))\b[^.\n!?]{0,80}\b(?:submit|propose|apply|add|create|write|make|update|edit|change|implement|insert|rewrite|redo|retry)\b/i;
  const offerOrQuestion = /\b(?:if you(?:'d| would)? (?:like|want|prefer)|would you like|do you want|want me to|shall i|should i|let me know|say the word|happy to)\b|\?\s*$/i;
  const doneMarker = /\b(?:i(?:'ve| have)? (?:now )?(?:added|created|updated|applied|submitted|made|changed)|all (?:the )?(?:changes|requested changes) (?:are|have been)|is now (?:added|in place|done))\b/i;
  return commitment.test(value) && !offerOrQuestion.test(value) && !doneMarker.test(value);
}
