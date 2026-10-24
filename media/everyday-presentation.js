/**
 * M33 — the ONE central presentation mapping from internal states to the
 * fixed user-facing phase vocabulary, plus the deterministic mode
 * recommendation rules for the unified composer.
 *
 * Loaded by the webview (media/chat.html) and importable by Node tests via
 * the CommonJS export at the bottom. No DOM access, no side effects.
 *
 * Fixed phase vocabulary (docs/m33-plan.md §2). Every observable internal
 * state maps to exactly one of these; unknown states map to the neutral
 * 'Processing task' and are reported through the diagnostic callback so an
 * unmapped state can never silently masquerade as progress or success.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    try {
      Object.defineProperty(root, '__kdEveryday', { value: api, configurable: false, enumerable: false, writable: false });
    } catch {
      root.__kdEveryday = api;
    }
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const PHASES = Object.freeze({
    UNDERSTANDING: 'Understanding your request',
    PREPARING: 'Preparing the work',
    WAITING_APPROVAL: 'Waiting for your approval',
    MAKING_CHANGES: 'Making changes',
    CHECKING: 'Checking the result',
    DELIVERING: 'Preparing delivery',
    COMPLETED: 'Completed',
    STOPPED: 'Stopped',
    BLOCKED: 'Blocked',
    PROCESSING: 'Processing task',
  });

  /** Diagnostic sink for unknown states — replaceable by the host page. */
  let onUnknownState = function (context, state) {
    if (typeof console !== 'undefined') console.warn('[M33] unmapped internal state (rendered as neutral Processing task):', context, state);
  };

  // M15 autonomous (Karke Dikha) lifecycle states → phase.
  const LIFECYCLE_PHASE = Object.freeze({
    queued: PHASES.PREPARING,
    scheduled: PHASES.PREPARING,
    waiting_for_resources: PHASES.PREPARING,
    preparing: PHASES.PREPARING,
    waiting_for_approval: PHASES.WAITING_APPROVAL,
    running: PHASES.MAKING_CHANGES,
    waiting_for_proposal_approval: PHASES.WAITING_APPROVAL,
    waiting_for_mutation_approval: PHASES.WAITING_APPROVAL,
    // Paused is a truthful "not moving, not terminal" state — neutral, never
    // Completed/Stopped (it can resume) and never Blocked (nothing failed).
    paused: PHASES.PROCESSING,
    cancelling: PHASES.STOPPED,
    validating: PHASES.CHECKING,
    waiting_for_delivery_approval: PHASES.WAITING_APPROVAL,
    committing: PHASES.DELIVERING,
    creating_pull_request: PHASES.DELIVERING,
    monitoring_ci: PHASES.DELIVERING,
    waiting_for_review: PHASES.DELIVERING,
    updating_pull_request: PHASES.DELIVERING,
    blocked: PHASES.BLOCKED,
    recovery_required: PHASES.BLOCKED,
    completed: PHASES.COMPLETED,
    failed: PHASES.BLOCKED,
    cancelled: PHASES.STOPPED,
  });

  // Core attempt statuses (baat_kar / saath_kar / karke_dikha attempts as
  // recorded by Core) → phase. `running` reads differently per kind: a chat
  // or tool-assisted answer is "understanding", a governed coding attempt is
  // "making changes".
  const ATTEMPT_PHASE = Object.freeze({
    created: PHASES.UNDERSTANDING,
    queued: PHASES.PREPARING,
    waiting_for_approval: PHASES.WAITING_APPROVAL,
    validating: PHASES.CHECKING,
    paused: PHASES.PROCESSING,
    blocked: PHASES.BLOCKED,
    cancelling: PHASES.STOPPED,
    completed: PHASES.COMPLETED,
    failed: PHASES.BLOCKED,
    cancelled: PHASES.STOPPED,
    recovery_required: PHASES.BLOCKED,
  });

  function phaseForLifecycleState(state) {
    const phase = LIFECYCLE_PHASE[String(state || '')];
    if (phase) return phase;
    onUnknownState('lifecycle', state);
    return PHASES.PROCESSING;
  }

  function phaseForAttemptStatus(status, kind) {
    const key = String(status || '');
    if (key === 'running') {
      return kind === 'karke_dikha' ? PHASES.MAKING_CHANGES : PHASES.UNDERSTANDING;
    }
    const phase = ATTEMPT_PHASE[key];
    if (phase) return phase;
    onUnknownState('attempt', status);
    return PHASES.PROCESSING;
  }

  /** One concise progress sentence per phase — shown next to the phase label. */
  const PHASE_SENTENCES = Object.freeze({
    [PHASES.UNDERSTANDING]: 'KarkeDikha is reading your request and working out an answer.',
    [PHASES.PREPARING]: 'KarkeDikha is setting up a safe place to do the work.',
    [PHASES.WAITING_APPROVAL]: 'KarkeDikha is waiting for your decision before continuing.',
    [PHASES.MAKING_CHANGES]: 'KarkeDikha is doing the work you asked for.',
    [PHASES.CHECKING]: 'KarkeDikha is verifying the result before showing it to you.',
    [PHASES.DELIVERING]: 'KarkeDikha is packaging the approved result.',
    [PHASES.COMPLETED]: 'The task finished — the result is in this task message.',
    [PHASES.STOPPED]: 'The task was stopped and no further work will happen.',
    [PHASES.BLOCKED]: 'The task cannot continue without attention.',
    [PHASES.PROCESSING]: 'KarkeDikha is processing the task.',
  });

  function sentenceForPhase(phase) {
    return PHASE_SENTENCES[phase] || PHASE_SENTENCES[PHASES.PROCESSING];
  }

  const TERMINAL_PHASES = Object.freeze([PHASES.COMPLETED, PHASES.STOPPED, PHASES.BLOCKED]);
  function isTerminalPhase(phase) {
    return TERMINAL_PHASES.indexOf(phase) !== -1;
  }

  // ── Deterministic mode recommendation (unified composer) ────────────────
  // Unified Conversation V1: this is the execution-POLICY router (READ_ONLY /
  // COLLABORATIVE_EDIT / AUTONOMOUS_EXECUTION), mirrored from the
  // authoritative, unit-tested source at src/orchestration/ExecutionPolicyRouter.ts
  // (extension host and webview are separate TS/JS programs — see that
  // file's header for why this is mirrored rather than imported). It
  // deliberately does NOT fully agree with Core's server-owned router
  // (core/domain/routing.ts's classifyRequest) any more: that function
  // collapses every mutation request straight to Karke Dikha, which is
  // correct for its other callers but wrong for this composer's default —
  // a bounded edit must default to a governed Saath Kar proposal, not
  // unattended autonomous execution (see src/orchestration/ExecutionPolicyRouter.ts).
  // Purely local and explainable — never a model call. Core remains the
  // submission authority; this only picks which existing requestedMode the
  // composer sends.

  // Strips one or more short conversational acknowledgments/fillers ("Okay,",
  // "Good. Now", "Thanks.") so a mutation verb immediately after them is still
  // seen at the clause boundary. Only the filler is removed: remaining text
  // must independently contain mutation intent before routing can escalate.
  // Kept identical to src/orchestration/ExecutionPolicyRouter.ts.
  function stripLeadingFiller(text) {
    return text.replace(/^\s*(?:(?:ok(?:ay)?|yes|sure|please|well|alright|actually|now|good|great|perfect|thanks|thank you)\b(?:\s*[,!.]\s*|\s+|$))+/i, '');
  }

  // Mutation-capable routing needs AFFIRMATIVE action intent. Talking about a possible change
  // ("What would you change here?", "Which file would need changing?", "How would you implement
  // retries?", "Would you change this function?") is advisory: discussion != authorization.
  // The text is judged clause by clause; a question-form clause never authorises a mutation.
  const MUTATION_VERBS = 'create|add|update|edit|modify|fix|implement|write|delete|remove|rename|move|refactor|install|commit|push|apply|replace|build|change|improve|adjust|tweak|redesign|restyle|rework|polish|simplify|extend|convert|enable|disable|support|persist|save|store|hide|optimi[sz]e';
  const CLAUSE_LEAD = '(?:(?:and|then|also|so|now|please|go ahead(?: and)?)[\\s,]+)*';
  const QUESTION_OPENER = /^(?:(?:so|and|but|ok(?:ay)?|well|now|hmm)\b[\s,]*)*(?:what|which|where|why|how|who|when|whether|should|would|could|can|will|do|does|did|is|are|was|were|might|shall)\b/i;
  // A second-person yes/no question that asks KKD to act is a request, not a hypothetical (see core/domain/actionIntent.ts).
  const POLITE_REQUEST = /^(?:(?:so|and|ok(?:ay)?|well|now|hey)\b[\s,]*)*(?:(?:can|could|will)\s+you\b|would\s+you\s+(?:please|kindly)\b|would\s+you\b[^?]*\b(?:for me|for us|please|kindly)\b)/i;
  const HYPOTHETICAL = /\b(?:if|would|might|could|should|whether|maybe|perhaps|suppose|imagine|hypothetically|needs?\s+(?:to\s+be\s+)?(?:chang|modif|updat|fix)\w*)\b/i;
  const IMPERATIVE_FIRST = new RegExp('^' + CLAUSE_LEAD + '(?:' + MUTATION_VERBS + ')\\b', 'i');
  const TARGET_FIRST_IMPERATIVE = new RegExp('^' + CLAUSE_LEAD + '(?:(?:in|for|on|to|at)\\s+)?[`"\']?[\\w./\\\\-]+\\.[A-Za-z][A-Za-z0-9]{0,5}[`"\']?\\s*[,:;-]?\\s+(?:please\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');
  const CONJOINED_VERB = new RegExp('\\b(?:and|then|also)\\s+(?:please\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');
  const FIRST_PERSON_FRAME = new RegExp('\\b(?:let me|let\'s|lets|i want (?:you )?to|i\'d like (?:you )?to|i would like (?:you )?to|i need (?:you )?to|we need to)\\s+(?:please\\s+)?(?:be able to\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');
  const POLITE_FRAME = new RegExp('(?:can|could|would|will)\\s+you\\s+(?:please\\s+|kindly\\s+)?(?:be able to\\s+)?(?:' + MUTATION_VERBS + ')\\b', 'i');

  const BEHAVIOUR_ASK = /^\s*(?:(?:also|and|then)\s+)?(?:ask|warn|prompt|require)\s+(?:me|the user|users?)\s+(?:before|to confirm|for confirmation|first)\b/i;
  const BEHAVIOUR_MAKE = /^\s*(?:(?:also|and|then)\s+)?(?:make|keep)\s+(?:it|this|that)\s+\S/i;
  // M55: a copy request creates a file; verbs like make/create only counted before it/this/that, so "Make a new copy of x.html" stayed in Baat Kar.
  const COPY_REQUEST = /^\s*(?:(?:and|then|also|so|now|please|go ahead(?: and)?)[\s,]+)*(?:(?:make|create|save|produce)\s+(?:me\s+)?(?:a|an|another|one)?\s*(?:(?:new|separate|backup|duplicate)\s+)*(?:copy|duplicate|clone|backup)\b|(?:copy|duplicate|clone)\s+(?:the\s+|this\s+|that\s+)?(?:file\s+)?[`"']?[\w./\-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b)/i;

  function splitClauses(text) {
    return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(part => part.trim()).filter(Boolean);
  }

  function isAdvisoryClause(clause) {
    if (POLITE_REQUEST.test(clause)) return false;
    return /\?\s*$/.test(clause) || QUESTION_OPENER.test(clause);
  }

  // A change verb whose object is the conversation itself ("fix your explanation", "correct your previous answer",
  // "improve your recommendation") edits the reply, not the workspace. A file/code noun in the clause keeps it a mutation.
  const CONVERSATIONAL_OBJECT = /\b(?:your|my|the|that|this)\s+(?:(?:previous|prior|earlier|last|above|original|own)\s+)*(?:answers?|explanations?|responses?|repl(?:y|ies)|recommendations?|inferences?|analys[ie]s|summar(?:y|ies)|claims?|assessments?|findings|reasoning|instructions|conclusions?|wording|phrasing)\b/i;
  const WORKSPACE_NOUN = /\b(?:files?|code|repo(?:sitory)?|codebase|workspace|readme|package\.json|config|tests?|scripts?|functions?|methods?|classes|modules?|[\w.-]+\.(?:md|json|ya?ml|toml|tsx?|jsx?|mjs|cjs|py|java|c|cc|cpp|h|hpp|cs|go|rs|html|css|bat|sh|ps1|txt))\b/i;
  function isConversationalEdit(clause) {
    return CONVERSATIONAL_OBJECT.test(clause) && !WORKSPACE_NOUN.test(clause);
  }

  function clauseHasMutationIntent(clause) {
    if (isAdvisoryClause(clause)) return false;
    if (isConversationalEdit(clause)) return false;
    return IMPERATIVE_FIRST.test(clause)
      || TARGET_FIRST_IMPERATIVE.test(clause)
      || CONJOINED_VERB.test(clause)
      || FIRST_PERSON_FRAME.test(clause)
      || POLITE_FRAME.test(clause)
      // Behaviour-change instructions with no code verb: "ask me before it deletes", "make it export Excel".
      || BEHAVIOUR_ASK.test(clause)
      || BEHAVIOUR_MAKE.test(clause)
      || COPY_REQUEST.test(clause)
      || (!HYPOTHETICAL.test(clause) && /\b(?:change|update)\b[^.\n!?]{0,100}\b(?:file|code|config|test|readme|package\.json|workflow|application|feature|method|function|validation|message)\b/i.test(clause));
  }

  function hasMutationIntent(text) {
    // A negation only shields its own clause: "do not modify X" as a constraint inside a larger
    // "Fix …" request must not veto the request's separate positive imperatives.
    const scrubbed = stripLeadingFiller(String(text || '')).replace(/\b(?:do not|don't|never|without)\b[^.\n!?]{0,80}\b(?:create|add|update|edit|modify|fix|implement|write|delete|remove|rename|move|refactor|install|commit|push|apply|change)\b/gi, ' ');
    return splitClauses(scrubbed).some(clauseHasMutationIntent);
  }

  function hasPlanIntent(text) {
    return /\b(?:make|create|give|draft|produce|write)\b[^.\n!?]{0,60}\b(?:plan|roadmap|design|architecture|proposal)\b/i.test(text)
      || /\b(?:plan|roadmap|architecture)\s+(?:for|to)\b/i.test(text);
  }

  // Explicit diagnosis request: an investigative verb about a problem. Inspection intent, never mutation intent.
  function hasDiagnosticRequest(text) {
    return /\b(?:inspect|investigate|diagnose|debug|troubleshoot|figure out|find out|look into)\b/i.test(text)
      && /\b(?:why|what(?:'s| is)? (?:wrong|going on|happening)|wrong|happening|issue|bug|problem|error|fail(?:s|ed|ing|ure)?|broken|crash(?:es|ing)?|not working|instead of)\b/i.test(text);
  }

  function hasRepositoryReadIntent(text) {
    const repositorySubject = /\b(?:repo|repository|workspace|codebase|files?|folders?|director(?:y|ies)|branch(?:es)?|commits?|tests?|package\.json|readme|source code)\b/i.test(text)
      || /\b(?:git|code|file|commit|branch|patch)\s+diff\b/i.test(text)
      || /\bdiff\s+(?:of|for|between)\s+(?:(?:the|these|those|two)\s+)?(?:files?|commits?|branches?|code)\b/i.test(text);
    const readAction = /\b(?:read|inspect|check|review|analy[sz]e|find|search|list|show|explain|compare|count|diagnose|look|where|why)\b/i.test(text);
    return (repositorySubject && readAction) || hasDiagnosticRequest(text);
  }

  // Explicit end-to-end delegation. The ONLY signal that can push the
  // recommendation to Karke Dikha on its own — "take care of this" has no
  // mutation verb of its own but is unambiguous delegation. Kept identical
  // to src/orchestration/ExecutionPolicyRouter.ts's hasAutonomousDelegationIntent.
  function hasAutonomousDelegationIntent(text) {
    return /\b(?:run|execute)\b[^.\n!?]{0,60}\b(?:tests?|validation|suite|the relevant tests?|the relevant validation)\b/i.test(text)
      || (/\b(?:verify|validate)\b/i.test(text) && hasMutationIntent(text))
      || /\bend[- ]to[- ]end\b/i.test(text)
      || /\btake care of\b/i.test(text)
      || /\brepair\b/i.test(text)
      || /\bmake sure it works\b/i.test(text)
      || /\bhandle (?:everything|this end.to.end)\b/i.test(text);
  }

  function largeRequestScore(text) {
    const scopeTerms = text.match(/\b(?:api|backend|frontend|database|migration|authentication|authorization|integration|workflow|pipeline|mobile|android|ios|web|ui|ux|tests?|ci|deployment|monitoring|memory|browser|multimodal|audio|video|security|documentation)\b/gi) || [];
    const actionTerms = text.match(/\b(?:build|implement|integrate|create|add|replace|migrate|redesign|automate|support)\b/gi) || [];
    const listSeparators = (text.match(/[,;]|\band\b/gi) || []).length;
    let score = 0;
    if (text.length >= 450) score += 2;
    else if (text.length >= 260) score += 1;
    if (scopeTerms.length >= 5) score += 3;
    else if (scopeTerms.length >= 3) score += 2;
    if (actionTerms.length >= 3) score += 1;
    if (listSeparators >= 4) score += 1;
    if (/\b(?:end[- ]to[- ]end|entire|full system|platform|ecosystem|epic|multiple stories|production[- ]ready)\b/i.test(text)) score += 2;
    return score;
  }

  function isLargeRequest(text) {
    return hasMutationIntent(text) && largeRequestScore(text) >= 3;
  }

  // A bare referential follow-up ("fix it", "do that", "continue") carries no
  // intent signal of its own — its policy comes entirely from continuity.
  function isBareReferentialFollowUp(text) {
    const trimmed = stripLeadingFiller(text.trim());
    return /^(?:fix|do|try|implement|continue|go ahead|proceed)(?:\s+(?:it|that|this|with (?:it|that|the other approach)))?[.!]?$/i.test(trimmed);
  }

  const MODE_META = Object.freeze({
    chat: Object.freeze({ mode: 'chat', name: 'Baat Kar', hint: 'answers without touching your files' }),
    agent: Object.freeze({ mode: 'agent', name: 'Saath Kar', hint: 'inspects the workspace with bounded tools' }),
    autonomous: Object.freeze({ mode: 'autonomous', name: 'Karke Dikha', hint: 'makes governed changes with your approval' }),
  });

  /**
   * Recommend exactly one existing mode for the drafted request text.
   * `previousMode` (optional — 'chat' | 'agent' | 'autonomous') is the small,
   * bounded continuity input for bare follow-ups ("fix it", "continue");
   * never a full transcript. Returns { mode, name, hint, reason } — reason is
   * the short explainable routing rule that fired.
   */
  // `previousMode` may be either a live in-session value or one restored from
  // Core's durable conversation working state. `previousModeIsRestored` marks
  // the latter: a restored autonomous policy must NOT re-grant autonomy to a
  // bare "continue" after a restart (Durable Conversational Continuity V1,
  // Step 3). Kept identical to src/orchestration/ExecutionPolicyRouter.ts's
  // `previousPolicyIsRestored`.
  function recommendMode(rawText, previousMode, previousModeIsRestored) {
    const text = String(rawText || '');
    if (hasPlanIntent(text)) {
      return Object.assign({}, MODE_META.agent, { reason: 'planning or design request' });
    }
    if (hasAutonomousDelegationIntent(text)) {
      return Object.assign({}, MODE_META.autonomous, { reason: 'explicit end-to-end delegation, so it needs governed autonomous execution' });
    }
    if (isLargeRequest(text)) {
      return Object.assign({}, MODE_META.autonomous, { reason: 'a broad multi-scope goal, so it needs governed autonomous execution' });
    }
    if (hasMutationIntent(text)) {
      return Object.assign({}, MODE_META.agent, { reason: 'a bounded change, so it needs your approval before anything is touched' });
    }
    // Continuation inertia: a Baat conversation stays Baat unless this turn clearly asks to change the workspace.
    if (previousMode === 'chat') {
      return Object.assign({}, MODE_META.chat, { reason: 'continuing the conversation; no file changes requested' });
    }
    if (hasRepositoryReadIntent(text)) {
      return Object.assign({}, MODE_META.agent, { reason: 'asks to inspect the repository' });
    }
    if (isBareReferentialFollowUp(text)) {
      if (previousMode === 'autonomous' && !previousModeIsRestored) {
        return Object.assign({}, MODE_META.autonomous, { reason: 'continuing the active autonomous task' });
      }
      return Object.assign({}, MODE_META.agent, { reason: 'a short follow-up to the previous turn' });
    }
    return Object.assign({}, MODE_META.chat, { reason: 'a question or explanation with no file changes' });
  }

  return {
    PHASES,
    phaseForLifecycleState,
    phaseForAttemptStatus,
    sentenceForPhase,
    isTerminalPhase,
    recommendMode,
    MODE_META,
    setUnknownStateReporter: function (fn) { if (typeof fn === 'function') onUnknownState = fn; },
  };
});

/**
 * Post-M39 correction for two webview-only projection gaps discovered during
 * packaged manual acceptance:
 *
 * 1. Everyday Auto stamped the hidden mode selector immediately before send,
 *    but did not emit the selector's change event. The autonomous submission
 *    reached Core while the Karke Dikha composer/timeline stayed hidden.
 * 2. Activity consumed only the legacy AgentRuntime operations snapshot, while
 *    Karke Dikha attempts are Core-owned. A real blocked autonomous attempt
 *    therefore produced "Needs attention" and a blocker card while Activity
 *    incorrectly rendered "No durable tasks yet."
 *
 * This browser-only bridge reuses the existing mode-change, Core history and
 * retryBlockedAttempt contracts. It creates no task state and performs no
 * lifecycle mutation beyond an explicit user retry click.
 */
(function installAutonomousProjectionCorrection(root) {
  'use strict';
  if (!root || typeof document === 'undefined') return;

  const vscode = root.__ollamaAgentVsCodeApi;
  if (!vscode) return;

  const modeSelect = document.getElementById('mode-select');
  const sendButton = document.getElementById('send-btn');
  const userInput = document.getElementById('user-input');
  const activityToggle = document.getElementById('activity-toggle');
  const activeViewButton = document.getElementById('task-view-active-btn');
  const historyViewButton = document.getElementById('task-view-history-btn');
  const taskList = document.getElementById('operations-task-list');
  const taskCount = document.getElementById('metric-tasks');
  const blockedCount = document.getElementById('metric-blocked');

  let legacyTotals = { tasks: 0, blocked: 0 };
  let legacyTaskIds = new Set();
  let coreKarkeTasks = [];
  let historyRequestTimer;

  const scheduleMicrotask = typeof root.queueMicrotask === 'function'
    ? callback => root.queueMicrotask(callback)
    : callback => root.setTimeout(callback, 0);

  function reconcileProgrammaticModeStamp() {
    if (!modeSelect) return;
    const before = modeSelect.value;
    scheduleMicrotask(() => {
      const after = modeSelect.value;
      if (!after || after === before) return;
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Registered before chat-everyday.js's capture listener. The deferred check
  // runs after that listener stamps the effective Auto mode and after chat.js
  // posts the one authoritative submission, then reveals the matching surface.
  sendButton?.addEventListener('click', reconcileProgrammaticModeStamp, true);
  userInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) reconcileProgrammaticModeStamp();
  }, true);

  function requestCoreHistory() {
    clearTimeout(historyRequestTimer);
    historyRequestTimer = setTimeout(() => {
      vscode.postMessage({ type: 'getEverydayHistory' });
    }, 25);
  }

  function normalizeCoreTaskStatus(task) {
    const value = String(task?.status || '').toLowerCase();
    if (value === 'completed') return 'completed';
    if (value === 'cancelled' || value === 'cancelling') return 'cancelled';
    if (value === 'blocked' || value === 'failed' || value === 'recovery_required') return 'blocked';
    if (value === 'waiting_for_approval') return 'waiting_for_approval';
    if (value === 'paused') return 'paused';
    return 'running';
  }

  function relative(value) {
    const parsed = Date.parse(String(value || ''));
    if (!Number.isFinite(parsed)) return 'now';
    const delta = Math.max(0, Date.now() - parsed);
    if (delta < 60_000) return 'now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return `${Math.floor(delta / 86_400_000)}d ago`;
  }

  function shortModel(value) {
    const model = String(value || 'automatic');
    return model.length > 24 ? `${model.slice(0, 21)}…` : model;
  }

  function openKarkeDikha() {
    if (!modeSelect) return;
    modeSelect.value = 'autonomous';
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function openDurableHistory() {
    document.getElementById('history-toggle')?.click();
  }

  function makeActionButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost compact-btn';
    button.textContent = label;
    button.addEventListener('click', event => {
      event.stopPropagation();
      action(button);
    });
    return button;
  }

  function renderCoreKarkeTasks() {
    if (!taskList) return;

    taskList.querySelectorAll('[data-core-karke-task="true"]').forEach(node => node.remove());

    const activeViewSelected = !historyViewButton || historyViewButton.getAttribute('aria-selected') !== 'true';
    if (!activeViewSelected) return;

    const visibleTasks = coreKarkeTasks
      .filter(task => !legacyTaskIds.has(String(task.attemptId || '')))
      .sort((left, right) => String(right.completedAt || right.createdAt || '').localeCompare(String(left.completedAt || left.createdAt || '')))
      .slice(0, 50);

    if (visibleTasks.length > 0) {
      taskList.querySelectorAll('.empty-state').forEach(node => node.remove());
    }

    for (const task of visibleTasks) {
      const attemptId = String(task.attemptId || '');
      if (!attemptId) continue;
      const statusValue = normalizeCoreTaskStatus(task);

      const row = document.createElement('div');
      row.className = 'task-row';
      row.tabIndex = 0;
      row.dataset.coreKarkeTask = 'true';
      row.dataset.taskId = attemptId;
      row.title = String(task.failureReason || task.currentMessage || attemptId);

      const info = document.createElement('div');
      info.className = 'task-info';
      const name = document.createElement('span');
      name.className = 'task-name';
      const rawTitle = String(task.currentMessage || 'Karke Dikha task').trim();
      name.textContent = rawTitle.length > 90 ? `${rawTitle.slice(0, 87)}…` : rawTitle;
      const details = document.createElement('span');
      details.className = 'task-details';
      details.textContent = `${shortModel(task.selectedModel)} · Core Karke Dikha · ${relative(task.completedAt || task.createdAt)}`;
      info.append(name, details);

      const actions = document.createElement('div');
      actions.className = 'task-row-actions';
      const status = document.createElement('span');
      status.className = `badge-pill ${statusValue === 'waiting_for_approval' ? 'blocked' : statusValue}`;
      status.textContent = statusValue;
      actions.appendChild(status);

      if (statusValue === 'blocked') {
        actions.appendChild(makeActionButton('Retry', button => {
          button.disabled = true;
          button.textContent = 'Retrying…';
          vscode.postMessage({ type: 'retryBlockedAttempt', attemptId, strategy: 'same_model' });
        }));
      } else if (statusValue === 'running' || statusValue === 'waiting_for_approval' || statusValue === 'paused') {
        actions.appendChild(makeActionButton(statusValue === 'waiting_for_approval' ? 'Review' : 'Open', () => openKarkeDikha()));
      } else {
        actions.appendChild(makeActionButton('History', () => openDurableHistory()));
      }

      const activate = () => {
        if (statusValue === 'running' || statusValue === 'waiting_for_approval' || statusValue === 'paused') openKarkeDikha();
        else openDurableHistory();
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });

      row.append(info, actions);
      taskList.appendChild(row);
    }

    if (taskCount) taskCount.textContent = String(legacyTotals.tasks + visibleTasks.length);
    if (blockedCount) {
      const coreBlocked = visibleTasks.filter(task => normalizeCoreTaskStatus(task) === 'blocked').length;
      blockedCount.textContent = String(legacyTotals.blocked + coreBlocked);
    }
  }

  activityToggle?.addEventListener('click', requestCoreHistory);
  activeViewButton?.addEventListener('click', () => setTimeout(renderCoreKarkeTasks, 0));
  historyViewButton?.addEventListener('click', () => setTimeout(renderCoreKarkeTasks, 0));

  root.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'operationsSnapshot' && message.snapshot) {
      const totals = message.snapshot.totals || {};
      legacyTotals = {
        tasks: Number(totals.tasks || 0),
        blocked: Number(totals.blocked || 0),
      };
      legacyTaskIds = new Set((Array.isArray(message.snapshot.tasks) ? message.snapshot.tasks : [])
        .map(task => String(task?.taskId || ''))
        .filter(Boolean));
      renderCoreKarkeTasks();
      return;
    }

    if (message.type === 'everydayHistory') {
      coreKarkeTasks = (Array.isArray(message.tasks) ? message.tasks : [])
        .filter(task => task && task.kind === 'karke_dikha');
      renderCoreKarkeTasks();
      return;
    }

    if (message.type === 'autonomousRetryStarted') {
      openKarkeDikha();
      requestCoreHistory();
      return;
    }

    if (message.type === 'autonomousTaskStarted' || message.type === 'autonomousTaskStatus') {
      requestCoreHistory();
    }
  });

  requestCoreHistory();
})(typeof window !== 'undefined' ? window : null);