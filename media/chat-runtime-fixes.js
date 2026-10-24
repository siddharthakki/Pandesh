(function () {
  'use strict';

  const vscode = window.__ollamaAgentVsCodeApi;
  if (!vscode) throw new Error('Shared VS Code webview API is unavailable.');

  const stopButton = document.getElementById('stop-btn');
  const modeSelect = document.getElementById('mode-select');
  const modelSelect = document.getElementById('model-select');
  const contextModel = document.getElementById('context-model');
  const modelBadge = document.getElementById('model-badge');
  const modelSuitabilitySummary = document.getElementById('model-suitability-summary');
  let activeConversationId = 'default';
  let workspaceAvailable = true;

  const readState = () => (typeof vscode.getState === 'function' && vscode.getState()) || {};
  const writeState = patch => vscode.setState?.(Object.assign({}, readState(), patch));
  const originalPostMessage = vscode.postMessage.bind(vscode);
  const modeLabels = { chat: 'Baat Kar', ask: 'Auto - Read', plan: 'Auto - Plan', agent: 'Saath Kar', autonomous: 'Karke Dikha' };

  function resetAutonomyModeSelection() {
    const autonomyModeSelect = document.getElementById('autonomy-mode-select');
    if (autonomyModeSelect) autonomyModeSelect.value = 'supervised';
    writeState({ lastAutonomyMode: 'supervised' });
  }

  function installPrimaryNewChatButton() {
    const existing = document.getElementById('new-conversation-toolbar-btn');
    if (existing) {
      existing.addEventListener('click', () => {
        resetAutonomyModeSelection();
        originalPostMessage({ type: 'newConversation' });
      });
      return;
    }
    const toolbar = document.querySelector('.top-bar-right');
    const historyButton = document.getElementById('history-toggle');
    if (!toolbar) return;

    const button = document.createElement('button');
    button.id = 'new-conversation-toolbar-btn';
    button.className = 'btn btn-ghost';
    button.type = 'button';
    button.title = 'Start a new chat';
    button.setAttribute('aria-label', 'Start a new chat');
    button.textContent = '+ New chat';
    button.addEventListener('click', () => {
      resetAutonomyModeSelection();
      originalPostMessage({ type: 'newConversation' });
    });
    toolbar.insertBefore(button, historyButton || toolbar.firstChild);
  }

  function installBoardButton() {
    // Board is routed to overflow menu per visual hierarchy
    const menuBtn = document.getElementById('local-board-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', () => originalPostMessage({ type: 'openLocalBoard' }));
      document.getElementById('local-board-toolbar-btn')?.remove();
      return;
    }
    const toolbar = document.querySelector('.top-bar-right');
    if (!toolbar) return;
    const button = document.createElement('button');
    button.id = 'local-board-toolbar-btn';
    button.className = 'btn btn-ghost';
    button.type = 'button';
    button.title = 'Open local board';
    button.textContent = 'Board';
    button.addEventListener('click', () => originalPostMessage({ type: 'openLocalBoard' }));
    toolbar.appendChild(button);
  }

  function normalizeConversationItems() {
    const items = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('.conversation-item'))
      : [];
    for (const item of items) {
      if (item.querySelector?.('.conversation-title')) continue;
      const rawTitle = String(item.textContent || '').replace(/\s*[\u00d7\u2715]\s*$/, '').trim();
      const title = document.createElement('span');
      title.className = 'conversation-title';
      title.textContent = rawTitle || 'Untitled chat';
      title.title = title.textContent;
      item.textContent = '';
      item.appendChild(title);
    }

    const list = document.getElementById('conversations-list');
    if (list) {
      const empty = document.getElementById('conversation-list-empty');
      if (items.length === 0 && !empty) {
        const message = document.createElement('div');
        message.id = 'conversation-list-empty';
        message.className = 'empty-state';
        message.textContent = 'No chats yet. Start a new chat from the main toolbar.';
        list.appendChild(message);
      } else if (items.length > 0) {
        empty?.remove();
      }
    }
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
    const scrubbed = String(text || '').replace(/\b(?:do not|don't|never|without)\b[^.\n!?]{0,80}\b(?:create|add|update|edit|modify|fix|implement|write|delete|remove|rename|move|refactor|install|commit|push|apply|change)\b/gi, ' ');
    return splitClauses(scrubbed).some(clauseHasMutationIntent);
  }

  function hasLocalOllamaModelListIntent(text) {
    const normalized = String(text || '');
    return /\bollama\b/i.test(normalized)
      && /\bmodels?\b/i.test(normalized)
      && /\b(?:list|show|display|which|what)\b/i.test(normalized);
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
    const repositorySubject =
      /\b(?:repo|repository|workspace|codebase|files?|folders?|director(?:y|ies)|branch(?:es)?|commits?|tests?|package\.json|readme|source code)\b/i.test(text)
      || /\b(?:git|code|file|commit|branch|patch)\s+diff\b/i.test(text)
      || /\bdiff\s+(?:of|for|between)\s+(?:(?:the|these|those|two)\s+)?(?:files?|commits?|branches?|code)\b/i.test(text);

    const readAction =
      /\b(?:read|inspect|check|review|analy[sz]e|find|search|list|show|explain|compare|count|diagnose|look)\b/i.test(text);

    return (repositorySubject && readAction) || hasDiagnosticRequest(text);
  }

  function largeRequestScore(text) {
    const normalized = String(text || '').trim();
    const scopeTerms = normalized.match(/\b(?:api|backend|frontend|database|migration|authentication|authorization|integration|workflow|pipeline|mobile|android|ios|web|ui|ux|tests?|ci|deployment|monitoring|memory|browser|multimodal|audio|video|security|documentation)\b/gi) || [];
    const actionTerms = normalized.match(/\b(?:build|implement|integrate|create|add|replace|migrate|redesign|automate|support)\b/gi) || [];
    const listSeparators = (normalized.match(/[,;]|\band\b/gi) || []).length;
    let score = 0;
    if (normalized.length >= 450) score += 2;
    else if (normalized.length >= 260) score += 1;
    if (scopeTerms.length >= 5) score += 3;
    else if (scopeTerms.length >= 3) score += 2;
    if (actionTerms.length >= 3) score += 1;
    if (listSeparators >= 4) score += 1;
    if (/\b(?:end[- ]to[- ]end|entire|full system|platform|ecosystem|epic|multiple stories|production[- ]ready)\b/i.test(normalized)) score += 2;
    return score;
  }

  function isLargeRequest(text) {
    return hasMutationIntent(text) && largeRequestScore(text) >= 3;
  }

  function storyTitle(text) {
    const cleaned = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^(?:please\s+)?(?:can you\s+|could you\s+|i want (?:you )?to\s+)?/i, '')
      .trim();
    const first = cleaned.split(/[.!?\n]/)[0].slice(0, 96).trim();
    if (!first) return 'New KarkeDikha story';
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  function buildStoryDraft(text) {
    const normalized = String(text || '').trim().replace(/\s+/g, ' ');
    const clauses = normalized
      .split(/(?:,|;|\band\b|\bthen\b)/i)
      .map(value => value.trim())
      .filter(value => value.length >= 12)
      .slice(0, 6);
    const acceptanceCriteria = clauses.length >= 2
      ? clauses.map(value => `The delivered solution supports: ${value.replace(/[.]+$/, '')}.`)
      : [
          'The requested user-visible behavior works end to end.',
          'Existing chat, tool, approval, and autonomous behavior remains intact.',
        ];
    return {
      title: storyTitle(normalized),
      goal: normalized.slice(0, 2000),
      acceptanceCriteria,
      constraints: [
        'Reuse existing KarkeDikha runtime, tool, permission, and Scrum foundations.',
        'Do not bypass approvals or merge automatically.',
        'Keep the implementation bounded to this story.',
      ],
      dependencies: [],
      validation: [
        'TypeScript compilation passes.',
        'Focused automated tests cover the new behavior.',
        'The full test suite and exact-head CI pass.',
      ],
      estimatedPoints: largeRequestScore(normalized) >= 6 ? 8 : 5,
    };
  }

  function classifyAutoMode(text) {
    if (hasLocalOllamaModelListIntent(text)) return { kind: 'local_models' };
    if (hasPlanIntent(text)) return { kind: 'send', mode: 'plan' };
    if (isLargeRequest(text)) return { kind: 'story', draft: buildStoryDraft(text) };
    if (hasMutationIntent(text)) return { kind: 'mutation' };
    if (hasRepositoryReadIntent(text)) return { kind: 'send', mode: 'ask' };
    return { kind: 'send', mode: 'chat' };
  }

  function dispatchLocalMessage(data) {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  function announceExecution(mode) {
    dispatchLocalMessage({ type: 'modeExecutionStarted', mode, modeLabel: modeLabels[mode] || mode });
  }

  function startGovernedTask(message, isAutoRouted) {
    const text = String(message.text || '');
    const submissionId = window.__kdAutonomousSubmission?.begin?.(text) || undefined;
    // Task-Scoped Autonomy: Auto-routing into Karke Dikha must never imply
    // hands-off. Every newly created autonomous task must default to supervised
    // unless the user explicitly selects hands_off for that specific new task.
    const autonomyModeSelect = document.getElementById('autonomy-mode-select');
    const autonomyMode = !isAutoRouted && autonomyModeSelect && autonomyModeSelect.value === 'hands_off'
      ? 'hands_off'
      : 'supervised';
    resetAutonomyModeSelection();
    originalPostMessage({
      type: 'startAutonomousTask',
      text,
      model: String(message.model || modelSelect?.value || ''),
      submissionId,
      autonomyMode,
      conversationId: message.conversationId || activeConversationId || (typeof currentConversationId !== 'undefined' ? currentConversationId : undefined),
    });
  }

  vscode.postMessage = message => {
    if (!message || typeof message !== 'object') {
      originalPostMessage(message);
      return;
    }

    if (message.type === 'classifyAndSend') {
      const text = String(message.text || '');
      const decision = classifyAutoMode(text);
      if (decision.kind === 'local_models') {
        announceExecution('agent');
        originalPostMessage({
          type: 'listLocalModels',
          text: message.text,
          conversationId: message.conversationId,
        });
        return;
      }
      if (decision.kind === 'story') {
        dispatchLocalMessage({
          type: 'storyDraftRequired',
          text,
          draft: decision.draft,
          conversationId: message.conversationId,
          workspaceAvailable,
        });
        return;
      }
      if (decision.kind === 'mutation') {
        dispatchLocalMessage({
          type: 'mutationConfirmationRequired',
          text,
          prompt: workspaceAvailable
            ? 'This request changes the workspace. Start a governed Karke Dikha task with proposal, mutation, validation, and delivery approvals?'
            : 'This request needs project files. Open or create a workspace so Saath Kar can continue it safely.',
        });
        return;
      }
      announceExecution(decision.mode);
      originalPostMessage({
        type: 'sendMessage',
        text: message.text,
        mode: decision.mode,
        model: message.model,
        attachments: message.attachments,
        conversationId: message.conversationId,
      });
      return;
    }

    if (message.type === 'confirmAutoMutation') {
      startGovernedTask(message, true);
      return;
    }

    if (message.type === 'sendMessage' && message.mode === 'autonomous') {
      startGovernedTask(message, false);
      return;
    }

    if (message.type === 'sendMessage') {
      if (message.conversationId) {
        activeConversationId = String(message.conversationId);
        window.__kdActiveConversationId = activeConversationId;
      }
      resetAutonomyModeSelection();
      announceExecution(String(message.mode || 'agent'));
    }
    originalPostMessage(message);
  };

  installPrimaryNewChatButton();
  installBoardButton();
  normalizeConversationItems();

  document.addEventListener('click', event => {
    const conversation = event.target.closest?.('.conversation-item');
    if (conversation?.dataset?.convId) {
      activeConversationId = conversation.dataset.convId;
      resetAutonomyModeSelection();
    }
  }, true);

  // Suppresses chat.js's own bubble-phase `stopGeneration` listener on the
  // same button (stopImmediatePropagation) and replaces it unconditionally
  // with `cancelTask`. `cancelTask` only reaches the legacy Extension-Host
  // `AgentRuntime` task queue (AgentPanel.cancelPersistedTask) — since M32,
  // Baat Kar/Saath Kar turns are Core-owned attempts the legacy runtime has
  // never heard of, so that queue reports "Task not found" and the Core
  // attempt (and its real child process) runs to completion, silently
  // swallowing every Saath Kar/Baat Kar Stop click. `cancelTask` is only
  // correct for autonomous (Karke Dikha) tasks, which really do live in that
  // queue; every other mode must fall through to the original `stopGeneration`
  // dispatch that routes to Core's `cancelAttempt`.
  stopButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    stopButton.disabled = true;
    stopButton.textContent = 'Stopping...';
    if (modeSelect?.value === 'autonomous') {
      const selected = document.querySelector('.conversation-item.active')?.dataset?.convId;
      const taskId = selected || activeConversationId || 'default';
      originalPostMessage({ type: 'cancelTask', taskId });
    } else {
      originalPostMessage({ type: 'stopGeneration' });
    }
  }, true);

  modelSelect?.addEventListener('change', () => {
    const selectedModel = String(modelSelect.value || '');
    writeState({ selectedModel });
    if (contextModel) contextModel.textContent = selectedModel ? `Selected for next turn: ${selectedModel}` : 'Automatic model routing';
    if (modelBadge) {
      modelBadge.textContent = selectedModel || 'auto';
      modelBadge.title = selectedModel ? 'Selected for the next turn; runtime capability checks still apply.' : 'Automatic model routing';
      modelBadge.hidden = false;
    }
  });

  modeSelect?.addEventListener('change', () => {
    writeState({ activeMode: modeSelect.value });
    if (modeSelect.value !== 'autonomous') {
      resetAutonomyModeSelection();
    }
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'workspaceState') {
      workspaceAvailable = Boolean(message.available);
      writeState({ workspaceAvailable, workspaceName: message.name || '' });
    }

    if (message.type === 'newConversation' && message.id) {
      activeConversationId = String(message.id);
      window.__kdActiveConversationId = activeConversationId;
      resetAutonomyModeSelection();
      dispatchLocalMessage({ type: 'clear', conversationId: activeConversationId });
      document.getElementById('user-input')?.focus();
    } else if (message.type === 'conversationSelected' && message.id) {
      activeConversationId = String(message.id);
      window.__kdActiveConversationId = activeConversationId;
      resetAutonomyModeSelection();
    } else if (message.type === 'conversationCreated' && message.conversation?.id) {
      activeConversationId = String(message.conversation.id);
      window.__kdActiveConversationId = activeConversationId;
      resetAutonomyModeSelection();
    }

    if (['persistedConversationsLoaded', 'newConversation', 'conversationCreated', 'conversationUpdated', 'conversationDeleted'].includes(message.type)) {
      normalizeConversationItems();
    }

    if (message.type === 'modelsLoaded' && modelSelect) {
      const persisted = String(readState().selectedModel || '');
      const exists = persisted && Array.from(modelSelect.options).some(option => option.value === persisted);
      if (exists) {
        modelSelect.value = persisted;
        // The restored choice is a real per-turn override, so every projection (Operator Context) must say Manual.
        modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const displayed = exists ? persisted : String(modelSelect.value || message.selectedModel || '');
      if (contextModel) contextModel.textContent = displayed ? `Selected for next turn: ${displayed}` : 'Automatic model routing';
    }

    if (message.type === 'modelSuitability') {
      const summary = String(message.summary || 'Using a model suited to this task');
      if (contextModel) contextModel.textContent = summary;
      if (modelSuitabilitySummary) {
        modelSuitabilitySummary.textContent = summary;
        modelSuitabilitySummary.hidden = false;
      }
      if (modelBadge) {
        modelBadge.textContent = 'suited';
        modelBadge.title = summary;
        modelBadge.hidden = false;
      }
    }

    // A failed selection, or a fresh conversation, has no routed model: the previous turn's suitability line
    // (e.g. "Using a coding model suited to this task") must not keep describing a task it never routed.
    if (message.type === 'modelSelectionFailed' || message.type === 'newConversation') {
      if (contextModel) contextModel.textContent = 'Automatic model routing';
      if (modelSuitabilitySummary) {
        modelSuitabilitySummary.textContent = '';
        modelSuitabilitySummary.hidden = true;
      }
      if (modelBadge) {
        modelBadge.textContent = 'auto';
        modelBadge.title = 'Runtime model selection';
        modelBadge.hidden = true;
      }
    }

    if (message.type === 'modelSelected') {
      const resolved = String(message.model || '');
      writeState({ lastResolvedModel: resolved, lastModelReason: String(message.reason || '') });
      if (contextModel) contextModel.textContent = resolved ? `Using ${resolved}` : 'No model selected';
      if (modelBadge) {
        modelBadge.textContent = resolved || 'auto';
        modelBadge.title = String(message.reason || 'Runtime model selection');
        modelBadge.hidden = !resolved;
      }
    }

    if (message.type === 'taskCancelled') dispatchLocalMessage({ type: 'stopped', taskId: message.taskId });

    if (message.type === 'stopped' || message.type === 'done' || message.type === 'error') {
      if (stopButton) {
        stopButton.disabled = false;
        stopButton.textContent = '\u25a0 Stop';
      }
    }
  });

  window.__karkeDikhaModeController = Object.freeze({ classifyAutoMode, buildStoryDraft, isLargeRequest });
})();
