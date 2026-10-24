/**
 * M33 — Everyday Product Experience webview layer.
 *
 * One unified composer with a deterministic, overridable mode-recommendation
 * chip; a central human-readable progress strip; outcome-first completion and
 * honest blocker cards; and a durable task History view sourced from Core's
 * read-only history projection.
 *
 * Layering contract: this file is presentation only. It never invents a
 * second submission path — every send still goes through the exact existing
 * webview messages (`sendMessage` for Baat/Saath, `startAutonomousTask` via
 * chat-runtime-fixes' rewrite for Karke Dikha), so Core remains the single
 * submission authority. Explicit mode-button selection (still present in the
 * DOM for compatibility and diagnostics) bypasses the recommendation exactly
 * as before — all pre-M33 flows are unchanged when a mode is explicitly set.
 */
(function () {
  'use strict';

  const vscode = window.__ollamaAgentVsCodeApi;
  const everyday = window.__kdEveryday;
  if (!vscode || !everyday) return;

  const userInput = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn');
  const modeSelect = document.getElementById('mode-select');
  const modelSelect = document.getElementById('model-select');
  const messages = document.getElementById('messages');
  const autonomousStatus = document.getElementById('autonomous-status');
  const historyToggle = document.getElementById('history-toggle');
  const historyDrawer = document.getElementById('history-drawer');
  if (!userInput || !sendBtn || !modeSelect) return;

  const MODE_KIND = { chat: 'baat_kar', agent: 'saath_kar', autonomous: 'karke_dikha' };
  const KIND_NAME = { baat_kar: 'Baat Kar', saath_kar: 'Saath Kar', karke_dikha: 'Karke Dikha' };

  // ── Panda identity (approved production assets under media/panda/) ───────
  // Same URI plumbing and fallback contract as chat-autonomous.js: point the
  // surface's <img> at the approved WebP; on any failure the inline
  // currentColor SVG fallback (already in the DOM, theme-aware) keeps showing.
  const pandaBaseUri = typeof window.__pandaBaseUri === 'string' && window.__pandaBaseUri
    ? window.__pandaBaseUri.replace(/\/+$/, '')
    : '';

  function applyPandaFile(container, filename) {
    if (!container) return;
    const img = container.querySelector('.kd-panda-img');
    if (!img || !pandaBaseUri || !filename) {
      if (container.classList) container.classList.remove('kd-img-ready');
      return;
    }
    img.onload = () => container.classList.add('kd-img-ready');
    img.onerror = () => container.classList.remove('kd-img-ready');
    img.src = `${pandaBaseUri}/${filename}`;
  }

  // Static surfaces owned by this layer: welcoming panda on the empty chat,
  // small panda in the History drawer.
  applyPandaFile(document.getElementById('everyday-welcome-panda'), 'mascot-idle.webp');
  applyPandaFile(document.getElementById('everyday-history-panda'), 'worker-mini.webp');

  // ── Explicit-mode tracking ────────────────────────────────────────────────
  // A real click on a legacy mode button is an explicit user/API selection and
  // disables everyday routing until the chip is used again. The sidebar's
  // programmatic auto-switch to `autonomous` (active-task reconnect) does NOT
  // set this — it calls setMode() without a button click event.
  let explicitMode = null;
  document.addEventListener('click', (event) => {
    const btn = event.target.closest?.('.mode-button');
    if (btn?.dataset?.mode) {
      explicitMode = btn.dataset.mode === 'auto' ? null : btn.dataset.mode;
      renderChip();
    }
  }, true);

  // ── Recommendation chip & Compact Mode Selector ─────────────────────────
  const chipRow = document.getElementById('everyday-reco-row');
  const chipLabel = document.getElementById('everyday-reco-label');
  const chipReason = document.getElementById('everyday-reco-reason');
  const overrideButtons = Array.from(document.querySelectorAll('.everyday-mode-option'));

  const compactModeBtn = document.getElementById('compact-mode-btn');
  const compactModeLabel = document.getElementById('compact-mode-label');
  const compactModePopover = document.getElementById('compact-mode-popover');
  const compactModeOptions = Array.from(document.querySelectorAll('.compact-mode-option'));

  function updateCompactModeDisplay() {
    if (!compactModeLabel) return;
    const active = effectiveMode();
    const meta = everyday.MODE_META[active] || everyday.MODE_META.chat;
    // This control chooses the mode of the NEXT message. The current turn's effective mode is shown only by the
    // Operator Context and the Dhaaga header (one projection), so this never masquerades as the running mode.
    let labelText = explicitMode || overrideMode ? meta.name : `Next: ${meta.name}`;
    let titleText = `${meta.name}`;
    if (explicitMode) {
      titleText = `Next message: ${meta.name} (Direct selection) — ${meta.hint}`;
    } else if (overrideMode) {
      titleText = `Next message: ${meta.name} (Your choice) — ${meta.hint}`;
    } else {
      titleText = `Next message: ${meta.name} (Recommended: ${recommendation.reason}) — ${meta.hint}`;
    }
    compactModeLabel.textContent = labelText;
    if (compactModeBtn) {
      compactModeBtn.title = titleText;
      compactModeBtn.setAttribute('aria-label', titleText);
    }
    const compactModeRecoTitle = document.getElementById('compact-mode-reco-title');
    const compactModeRecoDesc = document.getElementById('compact-mode-reco-desc');
    if (compactModeRecoTitle) {
      compactModeRecoTitle.textContent = overrideMode ? `${meta.name} — your choice` : `${meta.name} — recommended`;
    }
    if (compactModeRecoDesc) {
      compactModeRecoDesc.textContent = overrideMode ? `KarkeDikha ${meta.hint}.` : `Because this looks like ${recommendation.reason}. KarkeDikha ${meta.hint}.`;
    }
    compactModeOptions.forEach((btn) => {
      const mode = btn.dataset.mode;
      const isSelected = mode === 'auto' ? (!explicitMode && !overrideMode) : (mode === active && (explicitMode || overrideMode));
      btn.classList.toggle('active', Boolean(isSelected));
      btn.setAttribute('aria-selected', String(Boolean(isSelected)));
    });
  }

  if (compactModeBtn && compactModePopover) {
    compactModeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = compactModePopover.hidden;
      compactModePopover.hidden = !willShow;
      compactModeBtn.setAttribute('aria-expanded', String(willShow));
    });

    document.addEventListener('click', (e) => {
      if (!compactModePopover.contains(e.target) && e.target !== compactModeBtn) {
        compactModePopover.hidden = true;
        compactModeBtn.setAttribute('aria-expanded', 'false');
      }
    });

    compactModeOptions.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === 'auto') {
          explicitMode = null;
          overrideMode = null;
        } else {
          explicitMode = null;
          overrideMode = mode;
          if (modeSelect) modeSelect.value = mode;
        }
        compactModePopover.hidden = true;
        compactModeBtn.setAttribute('aria-expanded', 'false');
        renderChip();
        userInput.focus();
      });
    });
  }

  // Unified Conversation V1 — bounded follow-up continuity (Step 3 of the
  // milestone): the ONLY prior-turn state fed into the recommender is which
  // resolved mode the last Auto turn in this conversation actually used.
  // Persisted via the standard webview state API (survives a panel
  // reload/restart, same durability as everything else stored this way; see
  // AgentPanel's own restoreWorkspaceConversationState for the Core-side
  // equivalent) — never a full transcript dump.
  function readPreviousPolicyMode() {
    try { return (vscode.getState && vscode.getState()?.lastPolicyMode) || null; } catch { return null; }
  }
  function writePreviousPolicyMode(mode) {
    try { vscode.setState?.(Object.assign({}, (vscode.getState && vscode.getState()) || {}, { lastPolicyMode: mode })); } catch { /* best-effort only */ }
    restoredPolicyMode = null; // a live turn supersedes any restored value
  }

  // Durable Conversational Continuity V1: `vscode.setState` is per-webview and
  // is lost when the panel's state is discarded, so it cannot be the authority
  // for continuity across a real VS Code restart. The extension host posts
  // `conversationContinuity` from Core's durable working state; that value is
  // preferred, and is flagged as RESTORED so a bare "continue" cannot inherit
  // autonomy granted in a previous session (see everyday-presentation.js).
  let restoredPolicyMode = null;
  function previousPolicyMode() {
    return restoredPolicyMode || readPreviousPolicyMode();
  }
  function previousPolicyIsRestored() {
    return Boolean(restoredPolicyMode);
  }

  let recommendation = everyday.recommendMode('', previousPolicyMode(), previousPolicyIsRestored());
  let overrideMode = null; // 'chat' | 'agent' | 'autonomous' | null

  function effectiveMode() {
    if (explicitMode) return explicitMode;
    return overrideMode || recommendation.mode;
  }

  // B — the recommendation chip must not compete for attention while a task
  // is active or while a completion/blocker card is showing for the current
  // turn; it only reappears once the user starts a fresh submission (see
  // stampEffectiveMode, which clears this).
  let taskActiveOrJustFinished = false;

  function renderChip() {
    updateCompactModeDisplay();
    if (!chipRow) return;
    if (explicitMode || taskActiveOrJustFinished) {
      chipRow.hidden = true;
      return;
    }
    chipRow.hidden = false;
    const active = effectiveMode();
    const meta = everyday.MODE_META[active] || everyday.MODE_META.chat;
    if (chipLabel) chipLabel.textContent = overrideMode ? `${meta.name} — your choice` : `${meta.name} — recommended`;
    if (chipReason) chipReason.textContent = overrideMode ? `KarkeDikha ${meta.hint}.` : `Because this looks like ${recommendation.reason}. KarkeDikha ${meta.hint}.`;
    overrideButtons.forEach((button) => {
      const selected = button.dataset.mode === active;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  let recoTimer;
  userInput.addEventListener('input', () => {
    clearTimeout(recoTimer);
    recoTimer = setTimeout(() => {
      const previous = recommendation.mode;
      recommendation = everyday.recommendMode(userInput.value, previousPolicyMode(), previousPolicyIsRestored());
      // A materially different draft resets a stale manual override so the
      // chip never silently submits an old choice for new text.
      if (!userInput.value.trim()) overrideMode = null;
      if (previous !== recommendation.mode && overrideMode === recommendation.mode) overrideMode = null;
      // B — composing a fresh request (no task active, or the previous one
      // reached a terminal state) is exactly the "before submitting a new
      // request" moment that un-hides the chip again.
      if (userInput.value.trim() && (!currentPhase || everyday.isTerminalPhase(currentPhase))) {
        taskActiveOrJustFinished = false;
      }
      renderChip();
    }, 120);
  });

  overrideButtons.forEach((button) => {
    button.addEventListener('click', () => {
      explicitMode = null;
      // The cached recommendation may still describe the previous draft while
      // the debounced input classifier catches up. A visible mode click is an
      // explicit choice for the current submission even when it happens to
      // match that stale recommendation; submit-time recomputation must not be
      // allowed to silently replace it with a different mode.
      overrideMode = button.dataset.mode;
      renderChip();
      userInput.focus();
    });
  });

  // ── Unified submission (capture phase, before chat.js's own handlers) ───
  // chat.js reads modeSelect.value synchronously inside its send handler, so
  // stamping the effective mode here — in the capture pass, which runs first
  // at the event target — routes the very same send through the existing
  // production path with exactly one posted submission message.
  function stampEffectiveMode(event) {
    const text = userInput.value.trim();
    if (!text || sendBtn.disabled) return;
    const steering = window.__kdActiveTaskSteering;
    if (steering?.isActive?.()) {
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      sendBtn.disabled = true;
      if (!steering.submit(text)) sendBtn.disabled = false;
      return;
    }
    if (explicitMode) return; // legacy behavior untouched
    recommendation = everyday.recommendMode(text, previousPolicyMode(), previousPolicyIsRestored());
    if (overrideMode === recommendation.mode) overrideMode = null;
    const selected = effectiveMode();
    modeSelect.value = selected;
    writePreviousPolicyMode(selected);
    vscode.postMessage({
      type: 'everydayModeDecision',
      recommendedMode: MODE_KIND[recommendation.mode],
      selectedMode: MODE_KIND[selected],
      overridden: selected !== recommendation.mode,
      reason: recommendation.reason,
    });
    setPhase(selected === 'autonomous' ? everyday.PHASES.PREPARING : everyday.PHASES.UNDERSTANDING);
    overrideMode = null;
    renderChip();
  }

  sendBtn.addEventListener('click', stampEffectiveMode, true);
  userInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) stampEffectiveMode(event);
  }, true);

  window.addEventListener('kdSteeringAcknowledged', () => {
    userInput.value = '';
    userInput.style.height = '';
    sendBtn.disabled = false;
    userInput.dispatchEvent(new Event('input', { bubbles: true }));
    userInput.focus();
  });

  // ── Human-readable progress strip ───────────────────────────────────────
  const phaseStrip = document.getElementById('everyday-phase');
  const phaseLabel = document.getElementById('everyday-phase-label');
  const phaseSentence = document.getElementById('everyday-phase-sentence');
  let currentPhase = null;

  function setPhase(phase) {
    if (!phaseStrip || !phase) return;
    currentPhase = phase;
    phaseStrip.hidden = false;
    phaseStrip.dataset.phase = phase;
    phaseStrip.classList.toggle('is-terminal', everyday.isTerminalPhase(phase));
    phaseStrip.classList.toggle('is-blocked', phase === everyday.PHASES.BLOCKED);
    phaseStrip.classList.toggle('is-completed', phase === everyday.PHASES.COMPLETED);
    if (phaseLabel) phaseLabel.textContent = phase;
    if (phaseSentence) phaseSentence.textContent = everyday.sentenceForPhase(phase);
  }

  function hidePhase() {
    if (phaseStrip) phaseStrip.hidden = true;
    currentPhase = null;
  }

  // Maps the execution projection's terminal phase onto the phase strip. Returns null while there is no settled projection
  // (no run, or the run is still active), in which case the legacy message-driven phase applies.
  function terminalPhaseFromProjection() {
    const run = window.__kdExecutionState;
    if (!run || !run.runId || run.active) return null;
    switch (run.phase) {
      case 'completed': return everyday.PHASES.COMPLETED;
      case 'cancelled': return everyday.PHASES.STOPPED;
      case 'failed':
      case 'blocked':
      case 'needs_input': return everyday.PHASES.BLOCKED;
      default: return null;
    }
  }

  // stopped / error messages never become Completed, even if an older run's projection says so.
  function nonCompletedProjection() {
    const projected = terminalPhaseFromProjection();
    return projected && projected !== everyday.PHASES.COMPLETED ? projected : null;
  }

  // The terminal patch and the turn's `done` can arrive in either order: once the projection settles, a visible terminal
  // footer is re-derived from it so the two surfaces can never disagree.
  document.addEventListener('kd:execution-state', () => {
    const projected = terminalPhaseFromProjection();
    if (projected && projected !== currentPhase) setPhase(projected);
  });

  // ── Outcome-first completion / honest blocker cards ─────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // M40 — the completion/outcome region is the LAST child of the single
  // `.kd-task-message` wrapper (`#autonomous-status`), not inserted above it.
  // This used to `insertBefore(card, autonomousStatus.firstChild)`, which
  // fought chat-sidebar-ui.js's (now-removed) live-progress card for the
  // exact same top-of-status slot and rendered the completion card ABOVE the
  // timeline while the user was scrolled to the bottom — making it look
  // "missing" even though the phase sentence claimed it was "shown below".
  function ensureOutcomeCard() {
    let card = document.getElementById('everyday-outcome-card');
    if (!card) {
      card = el('section', 'everyday-outcome-card');
      card.id = 'everyday-outcome-card';
      card.setAttribute('aria-live', 'polite');
      if (autonomousStatus) autonomousStatus.appendChild(card);
      else if (messages) messages.appendChild(card);
    } else if (autonomousStatus && card.parentElement === autonomousStatus && autonomousStatus.lastElementChild !== card) {
      // Keep it pinned as the last child even if other content was appended
      // to the wrapper after this card was first created (e.g. late timeline
      // entries arriving after completion).
      autonomousStatus.appendChild(card);
    }
    card.hidden = false;
    card.innerHTML = '';
    return card;
  }

  function shortSha(sha) {
    return typeof sha === 'string' && sha ? sha.slice(0, 10) : null;
  }

  function firstLine(text, max) {
    const line = String(text || '').split(/\r?\n/, 1)[0].trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }

  function addEvidenceRow(list, label, value) {
    const row = el('div', 'everyday-evidence-row');
    row.appendChild(el('span', 'everyday-evidence-label', label));
    row.appendChild(el('span', 'everyday-evidence-value', value));
    list.appendChild(row);
  }

  function renderDetails(card, payload) {
    const details = el('details', 'everyday-details');
    details.appendChild(el('summary', '', 'Details'));
    const pre = el('pre', 'everyday-details-json');
    try {
      pre.textContent = JSON.stringify(payload, null, 2);
    } catch {
      pre.textContent = String(payload);
    }
    details.appendChild(pre);
    card.appendChild(details);
  }

  function storeTaskDetails(payload) {
    const details = document.getElementById('kd-task-details');
    if (!details) return;
    const target = details.querySelector('#kd-developer-diagnostics-content') || details;
    let pre = target.querySelector('#kd-outcome-diagnostics');
    if (!pre) {
      pre = el('pre', 'everyday-details-json');
      pre.id = 'kd-outcome-diagnostics';
      target.appendChild(pre);
    }
    try {
      pre.textContent = JSON.stringify(payload, null, 2);
    } catch {
      pre.textContent = String(payload);
    }
  }

  let renderedOutcomeForTask = null;

  function renderCompletionCard(message) {
    const key = `${message.taskId}:completed`;
    if (renderedOutcomeForTask === key) return;
    renderedOutcomeForTask = key;
    const card = ensureOutcomeCard();
    card.className = 'everyday-outcome-card is-success';
    // The primary active-stage panda (#autonomous-panda) already shows the
    // completed pose for this task message; a second panda here would
    // duplicate the mascot within the same task message.

    const files = Array.isArray(message.approvedScopePaths) ? message.approvedScopePaths : [];
    const validation = message.validationTotals;
    const commit = shortSha(message.deliveryCommitSha);
    const targetBranch = message.destinationBranch || message.deliveryEvidence?.destinationBranch || (message.branchName && !message.branchName.startsWith('forge/') ? message.branchName : 'working branch');
    const taskBranch = message.taskBranchName || message.deliveryEvidence?.taskBranchName;
    const changedCount = files.length || (Number.isInteger(message.deliveryEvidence?.changedFileCount) ? message.deliveryEvidence.changedFileCount : 1);
    const headline = `Completed: ${firstLine(message.goal, 120)} — changed ${changedCount} file${changedCount === 1 ? '' : 's'} and applied to ${targetBranch}.`;
    card.appendChild(el('strong', 'everyday-outcome-headline', message.terminalSummary ? firstLine(message.terminalSummary, 160) : headline));

    const evidence = el('div', 'everyday-evidence');
    addEvidenceRow(evidence, 'Files changed', `✓ Changed ${changedCount} file${changedCount === 1 ? '' : 's'}${files.length ? ` (${files.join(', ')})` : ''}`);
    if (validation && validation.failed === 0) {
      addEvidenceRow(evidence, 'Verification', `✓ ${validation.commands} check${validation.commands === 1 ? '' : 's'} passed`);
    } else if (Number.isInteger(message.deliveryEvidence?.validationPassCount)) {
      addEvidenceRow(evidence, 'Verification', `✓ ${message.deliveryEvidence.validationPassCount} check${message.deliveryEvidence.validationPassCount === 1 ? '' : 's'} passed`);
    } else if (validation) {
      addEvidenceRow(evidence, 'Verification', `${validation.failed} of ${validation.commands} checks failed`);
    } else {
      addEvidenceRow(evidence, 'Verification', 'Validation passed');
    }
    if (message.diffReview?.verdict === 'pass') {
      addEvidenceRow(evidence, 'Diff review', '✓ Diff review passed');
    }
    addEvidenceRow(evidence, 'Delivery', `✓ Applied to ${targetBranch}${commit ? ` (${commit})` : ''}`);
    if (taskBranch) {
      addEvidenceRow(evidence, 'Task branch', taskBranch);
    }
    card.appendChild(evidence);

    storeTaskDetails({
      taskId: message.taskId,
      attemptId: message.attemptId,
      deliveryCommitSha: message.deliveryCommitSha ?? null,
      branchName: message.branchName ?? null,
      approvedScopePaths: files,
      validationTotals: validation ?? null,
      qualityGate: message.qualityGate ?? null,
      diffReview: message.diffReview ?? null,
      terminalSummary: message.terminalSummary ?? null,
    });
  }

  // Progress & Completion UX V1 (Step 9 closure pass): every classification
  // Core/M15 can actually produce (GovernedCodingExecutionStatus,
  // classifyRuntimeError, and the explicit overrides in
  // M15AutonomousRuntime.ts/M15AutonomousWork.ts) must resolve to a plain,
  // truthful sentence here. An unmapped classification used to fall through
  // to `failure.message` as the card's PRIMARY headline — raw exception text
  // on the main surface, which Step 9 forbids. Once mapped, that same raw
  // text still appears, but only as a bounded secondary "What failed" row.
  function humanizeClassification(classification) {
    const map = {
      recovery_required: 'The task was interrupted (for example by a restart) and needs explicit recovery.',
      commit_scope_reconciliation_failed: 'KarkeDikha could not preserve a valid delivery candidate for the approved request.',
      validation_failed: 'A validation command failed, so the change was not delivered.',
      pre_delivery_validation_failed: 'The candidate commit failed validation under destination checkout rules, so the destination was not changed.',
      delivery_candidate_materialization_failed: 'KarkeDikha could not materialize the candidate commit safely for pre-delivery validation.',
      proposal_rejected: 'The proposal was rejected, so no changes were made.',
      mutation_denied: 'Permission to change files was denied, so no changes were made.',
      delivery_rejected: 'Delivery was rejected, so the change stays in the isolated worktree.',
      m15_worker_enqueue_failed: 'The task could not be handed to the worker after submission.',
      mutation_evidence_missing: 'KarkeDikha could not produce a deliverable change for the approved request.',
      empty_delivery_candidate: 'KarkeDikha could not produce a deliverable change for the approved request.',
      // Deterministic host-review rejection — an ACCEPTABLE governed outcome,
      // not a crash (milestone Step 7's own example wording).
      diff_review_rejected: 'The implementation did not pass final review, so nothing was delivered.',
      // Blocked-safely: the workspace or repository state was not what the
      // approved change expected, so nothing was applied.
      workspace_delivery_conflict: 'The verified change is ready, but it could not be applied because the open workspace contains conflicting uncommitted changes. Your existing changes were left untouched.',
      workspace_changed_after_review: 'The workspace changed after the change was reviewed, so nothing was applied. Your existing changes were left untouched.',
      dirty_document_blocked: 'An open, unsaved file conflicted with the approved change, so nothing was applied. Your existing changes were left untouched.',
      git_state_changed: "The repository's Git state changed while the task was working, so nothing was applied. Your existing changes were left untouched.",
      workspace_lease_held: 'Another task already owns this workspace, so this task could not proceed.',
      delivery_diff_changed: 'The change no longer matched what was approved by the time delivery ran, so nothing was delivered. Your existing changes were left untouched.',
      task_input_integrity_mismatch: "The task's original request no longer matched its recorded goal, so it was stopped for safety.",
      worktree_identity_mismatch: 'The isolated workspace no longer matched what the task expected, so it was stopped for safety.',
      // Failed: the workflow could not produce or apply a valid change.
      proposal_unavailable: 'KarkeDikha could not produce a usable coding proposal, so no changes were made.',
      invalid_proposal: 'The generated proposal did not meet the required structure, so no changes were made.',
      grounding_failed: 'The proposal edited a file without current evidence of its content, so no changes were made.',
      operation_content_required: 'The proposed edit was incomplete. KarkeDikha tried to repair the proposal but it was still invalid.',
      execution_rejected: 'Permission to apply the change was denied, so no changes were made.',
      graph_incomplete: 'The governed workflow did not finish all of its steps, so no changes were delivered.',
      readiness_blocked: 'A repository safety check failed before the task could start, so nothing was changed.',
      // Git environment prerequisites — the user's setup, never the request or the model.
      git_prerequisite_unavailable: 'this folder is not a Git repository (or its HEAD cannot be read), so nothing was changed.',
      git_author_identity_unavailable: 'Git does not know who you are, so the delivery commit could not be created.',
      file_missing_at_binding: 'A file the proposal expected to change was missing, so no changes were made.',
      create_target_exists: 'A file the proposal expected to create already exists, so no changes were made.',
      validation_side_effect_detected: 'Validation modified files outside the approved scope, so the change was not delivered.',
      approval_replay_rejected: 'The approval no longer matched the current proposal, so nothing was applied.',
      snapshot_read_failed: 'The repository snapshot could not be read, so the task could not verify its change.',
      path_rejected: 'The proposal targeted a path outside what is allowed, so no changes were made.',
      duplicate_proposal_target: 'The proposal listed the same file twice, so no changes were made.',
      mutation_failed: 'Applying the approved change failed, so no changes were made.',
      execution_profile_missing: "The task's execution settings were missing, so it could not run.",
      execution_profile_invalid: "The task's execution settings were invalid, so it could not run.",
      delivery_superseded_after_commit: 'A newer task already delivered a change for this objective, so this one was superseded.',
      core_authority_missing: 'The task lost its governing authority record, so it could not continue safely.',
      runtime_error: 'An unexpected internal error stopped the task before it could finish.',
      // Honest, non-completing investigation outcomes — the model looked and
      // said so, rather than fabricating a change.
      insufficient_context_reported: 'KarkeDikha investigated but could not find the specific information it needed, so no changes were made.',
      no_change_claim_reported: 'KarkeDikha believes no change is required and stopped for review instead of modifying the repository.',
    };
    return map[classification] || null;
  }

  function renderBlockerCard(message) {
    const key = `${message.taskId}:${message.state}`;
    if (renderedOutcomeForTask === key) return;
    renderedOutcomeForTask = key;
    const card = ensureOutcomeCard();
    card.className = 'everyday-outcome-card is-blocked';
    // The primary active-stage panda (#autonomous-panda) already reflects the
    // blocked/cancelled pose (see PandaStateMapping.ts) for this task message;
    // a second, state-blind panda here would duplicate and could contradict it
    // (it previously always showed the "blocked" pose even when cancelled).

    const failure = message.failure || {};
    const friendly = humanizeClassification(failure.classification);
    const stoppedByUser = message.state === 'cancelled';
    const isTrackedRuntime = failure.classification === 'workspace_delivery_conflict' && (/(\.ollama-agent|tracked)/i.test(String(failure.message || '')) || /(\.ollama-agent|tracked)/i.test(String(failure.detail || '')));
    const friendlyHeadline = isTrackedRuntime
      ? 'Task blocked: KarkeDikha runtime files are tracked by Git in this repository. This can block safe delivery.'
      : failure.classification === 'validation_failed'
        ? 'Task blocked: validation failed.'
        : failure.classification === 'workspace_delivery_conflict'
          ? 'Task blocked: the verified change could not be safely applied because the working repository contains unrelated changes.'
          : friendly
            ? `Task blocked: ${friendly}`
            : failure.message
              ? `Task blocked: ${firstLine(failure.message, 160)}`
              : `Task blocked: the task could not continue.`;
    const headline = stoppedByUser
      ? `Stopped: ${firstLine(message.goal, 120)} — you cancelled this task.`
      : friendlyHeadline;
    card.appendChild(el('strong', 'everyday-outcome-headline', headline));

    const evidence = el('div', 'everyday-evidence');
    const completedSteps = [];
    const isHandsOff = message.autonomyMode === 'hands_off';
    const isValidationFailure = failure.classification === 'validation_failed' || failure.classification === 'pre_delivery_validation_failed' || Boolean(message.validationFailure) || (message.validationTotals && message.validationTotals.failed > 0);
    const internalLifecycleFailure = [
      'mutation_evidence_missing',
      'commit_scope_reconciliation_failed',
      'empty_delivery_candidate',
    ].includes(failure.classification);

    if (failure.classification === 'workspace_delivery_conflict') {
      completedSteps.push('✓ Change prepared', '✓ Validation passed', '✓ Diff review passed');
    } else {
      if (message.resolvedGates?.proposal) {
        completedSteps.push(isHandsOff ? '✓ Proposal automatically authorized' : '✓ Proposal approved');
      }
      if (message.resolvedGates?.mutation) {
        completedSteps.push('✓ Approved changes applied in isolated worktree');
      }
      if (!isValidationFailure && message.deliveryEvidence?.validationPassCount) {
        completedSteps.push(`✓ ${message.deliveryEvidence.validationPassCount} check${message.deliveryEvidence.validationPassCount === 1 ? '' : 's'} passed`);
      } else if (!isValidationFailure && message.qualityGate?.status === 'passed' && !message.failure) {
        completedSteps.push('✓ Validation passed');
      }
    }
    addEvidenceRow(evidence, 'What completed', completedSteps.length ? completedSteps.join('; ') : 'No approval or validation step had completed yet.');

    if (failure.classification === 'validation_failed' || failure.classification === 'pre_delivery_validation_failed' || message.validationFailure?.commandLabel) {
      const cmd = message.validationFailure?.commandLabel || 'Validation check';
      const exitInfo = typeof message.validationFailure?.exitCode === 'number'
        ? ` (exit code ${message.validationFailure.exitCode})`
        : message.validationFailure?.timedOut ? ' (timed out)' : '';
      addEvidenceRow(evidence, 'What failed', `✗ ${cmd}${exitInfo}`);
    } else if (failure.classification === 'workspace_delivery_conflict') {
      addEvidenceRow(evidence, 'What failed', '✗ Working repository contains unrelated changes');
    } else if (failure.message && friendly && !isTrackedRuntime) {
      addEvidenceRow(evidence, 'What failed', firstLine(failure.message, 200));
    }

    // Recovery stopped after the approved change WAS applied: say so, and never imply the change failed to apply.
    const recoverySubcode = String((failure.recovery && failure.recovery.subcode) || '');
    if (failure.classification === 'validation_failed' && recoverySubcode.startsWith('validation_repair')) {
      addEvidenceRow(
        evidence,
        'Recovery',
        recoverySubcode === 'validation_repair_unavailable'
          ? 'The approved change was applied, but validation still fails and automatic repair could not produce a usable correction. Nothing was delivered; the changed files remain only in the isolated worktree.'
          : 'The approved change was applied, but validation still fails and automatic repair stopped. Nothing was delivered; the changed files remain only in the isolated worktree.',
      );
    }

    if (message.validationRepairAttempts) {
      addEvidenceRow(evidence, 'Repair attempts', `${message.validationRepairAttempts} of 2 automatic repair cycles used`);
    }

    if (failure.classification === 'validation_failed' || failure.classification === 'workspace_delivery_conflict') {
      addEvidenceRow(evidence, 'Your repository', 'Untouched');
    } else {
      const changed = Number.isInteger(message.deliveryEvidence?.changedFileCount) ? message.deliveryEvidence.changedFileCount : null;
      const mutationApproved = message.resolvedGates?.mutation === true;
      addEvidenceRow(
        evidence,
        'Your repository',
        internalLifecycleFailure
          ? 'Your repository was not modified.'
          : mutationApproved && changed && changed > 0
          ? `Untouched — ${changed} changed file${changed === 1 ? '' : 's'} exist only in KarkeDikha's isolated worktree.`
          : 'Untouched — no changes were made to your files.',
      );
    }

    const nextStepText = isTrackedRuntime
      ? 'Untrack KarkeDikha runtime state using: git rm -r --cached .ollama-agent'
      : failure.classification === 'git_prerequisite_unavailable'
        ? 'Run git init in this folder and commit your current files, then start the task again.'
      : failure.classification === 'git_author_identity_unavailable'
        ? 'Set your Git identity (git config --global user.name "Your Name" and git config --global user.email "you@example.com"), then choose Retry Delivery.'
      : failure.classification === 'validation_failed' || failure.classification === 'pre_delivery_validation_failed'
        ? 'Review the validation failure or provide guidance.'
        : failure.classification === 'workspace_delivery_conflict'
          ? 'Review or clean the conflicting workspace changes, then retry delivery.'
          : failure.classification === 'recovery_required'
            ? 'Review the diagnostics under Details, then start the task again if you still want the change.'
        : internalLifecycleFailure
          ? 'Retry the same request. If it fails again, open Details and report the lifecycle diagnostic.'
        : message.validationFailure?.retryAvailable
          ? 'Fix the reported validation problem or adjust the request, then submit it again.'
          : stoppedByUser
            ? 'Submit the request again whenever you want to continue.'
            : 'Adjust the request based on the reason above and submit it again.';
    addEvidenceRow(evidence, 'Next step', nextStepText);
    card.appendChild(evidence);

    if (failure.message || failure.classification || message.validationFailure?.stdoutStderrTail) {
      const techDetails = el('details', 'everyday-technical-details');
      const techSummary = el('summary', '', 'Show technical details');
      techDetails.appendChild(techSummary);
      const techContent = el('div', 'everyday-technical-content');
      if (failure.classification) {
        techContent.appendChild(el('div', 'technical-code-row', `Code: ${failure.classification}`));
      }
      if (failure.message) {
        techContent.appendChild(el('div', 'technical-msg-row', failure.message));
      }
      if (message.validationFailure?.stdoutStderrTail) {
        const pre = el('pre', 'everyday-details-json', message.validationFailure.stdoutStderrTail);
        techContent.appendChild(pre);
      }
      techDetails.appendChild(techContent);
      card.appendChild(techDetails);
    }

    if (!stoppedByUser && message.retryEligibility?.eligible) {
      const actions = el('div', 'everyday-blocker-actions');
      let guidanceContainer = null;

      const disableAllActionButtons = () => {
        for (const item of actions.querySelectorAll('button')) item.disabled = true;
        if (guidanceContainer) {
          for (const item of guidanceContainer.querySelectorAll('button, textarea')) item.disabled = true;
        }
      };

      const retry = (label, strategy) => {
        const button = el('button', 'btn btn-secondary', label);
        button.type = 'button';
        button.dataset.everydayRetryStrategy = strategy;
        button.addEventListener('click', () => {
          if (button.disabled) return;
          if (strategy === 'with_guidance') {
            if (!guidanceContainer) {
              guidanceContainer = el('div', 'everyday-guidance-form');
              const textarea = document.createElement('textarea');
              textarea.className = 'everyday-guidance-input';
              textarea.placeholder = 'Add concise guidance for the next attempt…';
              textarea.rows = 2;
              textarea.dataset.everydayGuidanceInput = 'true';

              const guidanceActions = el('div', 'everyday-guidance-actions');
              const submitBtn = el('button', 'btn btn-primary', 'Retry with guidance');
              submitBtn.type = 'button';
              submitBtn.dataset.everydayGuidanceSubmit = 'true';

              const cancelBtn = el('button', 'btn btn-secondary', 'Cancel');
              cancelBtn.type = 'button';
              cancelBtn.dataset.everydayGuidanceCancel = 'true';

              submitBtn.addEventListener('click', () => {
                if (submitBtn.disabled) return;
                const guidance = textarea.value.trim();
                if (!guidance) {
                  textarea.focus();
                  return;
                }
                disableAllActionButtons();
                vscode.postMessage({ type: 'retryBlockedAttempt', attemptId: message.attemptId, strategy: 'with_guidance', guidance });
              });

              cancelBtn.addEventListener('click', () => {
                guidanceContainer.remove();
                guidanceContainer = null;
                button.disabled = false;
              });

              guidanceActions.appendChild(submitBtn);
              guidanceActions.appendChild(cancelBtn);
              guidanceContainer.appendChild(textarea);
              guidanceContainer.appendChild(guidanceActions);
              card.appendChild(guidanceContainer);
            }
            const input = guidanceContainer.querySelector('textarea');
            input?.focus();
            return;
          }
          disableAllActionButtons();
          vscode.postMessage({ type: 'retryBlockedAttempt', attemptId: message.attemptId, strategy });
        });
        actions.appendChild(button);
        return button;
      };
      retry('Try again', 'same_model');
      const stronger = retry('Try with a stronger model', 'stronger_model');
      stronger.disabled = !message.retryEligibility.strongerModelAvailable;
      retry('Add guidance and retry', 'with_guidance');
      card.appendChild(actions);
    }

    storeTaskDetails({
      taskId: message.taskId,
      attemptId: message.attemptId,
      state: message.state,
      failure: message.failure ?? null,
      validationFailure: message.validationFailure ?? null,
      validationRepairAttempts: message.validationRepairAttempts ?? 0,
      qualityGate: message.qualityGate ?? null,
      diffReview: message.diffReview ?? null,
      retryEligibility: message.retryEligibility ?? null,
    });
  }

  // ── Durable task history (Core-owned projection) ────────────────────────
  const historyList = document.getElementById('everyday-history-list');
  const historyStatus = document.getElementById('everyday-history-status');
  const expandedDetails = new Map(); // attemptId -> container element awaiting detail

  function requestHistory() {
    if (historyStatus) historyStatus.textContent = 'Loading tasks…';
    vscode.postMessage({ type: 'getEverydayHistory' });
  }

  // The drawer itself toggles in chat-sidebar-ui.js (registered earlier, so
  // it has already flipped `hidden` by the time this runs). Refresh on every
  // toggle click — a redundant refresh while closing is a harmless read.
  historyToggle?.addEventListener('click', () => requestHistory());

  function formatTime(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
  }

  function outcomeSummaryFor(task) {
    const phase = everyday.phaseForAttemptStatus(task.status, task.kind);
    if (phase === everyday.PHASES.COMPLETED) return 'Completed successfully.';
    if (phase === everyday.PHASES.STOPPED) return 'Stopped before completion.';
    if (phase === everyday.PHASES.BLOCKED) return task.failureReason ? `Blocked: ${firstLine(task.failureReason, 140)}` : 'Blocked.';
    return 'Still in progress.';
  }

  function renderHistory(tasks, available) {
    if (!historyList) return;
    historyList.innerHTML = '';
    expandedDetails.clear();
    const historyPanda = document.getElementById('everyday-history-panda');
    if (!available) {
      if (historyPanda) historyPanda.hidden = false;
      if (historyStatus) historyStatus.textContent = 'Task history is unavailable while KarkeDikha Core is disconnected.';
      return;
    }
    if (!tasks.length) {
      if (historyPanda) historyPanda.hidden = false;
      if (historyStatus) historyStatus.textContent = 'No tasks yet. Everything you ask KarkeDikha to do will appear here.';
      return;
    }
    if (historyPanda) historyPanda.hidden = true;
    if (historyStatus) historyStatus.textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
    for (const task of tasks) {
      const item = el('div', 'everyday-history-item');
      item.dataset.attemptId = task.attemptId;
      const phase = everyday.phaseForAttemptStatus(task.status, task.kind);

      const header = el('button', 'everyday-history-header');
      header.type = 'button';
      header.setAttribute('aria-expanded', 'false');
      header.appendChild(el('span', 'everyday-history-request', firstLine(task.currentMessage, 90) || '(empty request)'));
      const metaRow = el('span', 'everyday-history-meta');
      metaRow.appendChild(el('span', `everyday-history-phase phase-${phase.replace(/\s+/g, '-').toLowerCase()}`, phase));
      metaRow.appendChild(el('span', 'everyday-history-mode', KIND_NAME[task.kind] || task.kind));
      const started = formatTime(task.createdAt);
      const finished = formatTime(task.completedAt);
      if (started) metaRow.appendChild(el('span', 'everyday-history-time', finished ? `${started} → ${finished}` : `started ${started}`));
      header.appendChild(metaRow);
      header.appendChild(el('span', 'everyday-history-outcome', outcomeSummaryFor(task)));
      item.appendChild(header);

      const body = el('div', 'everyday-history-body');
      body.hidden = true;
      item.appendChild(body);

      header.addEventListener('click', () => {
        const opening = body.hidden;
        body.hidden = !opening;
        header.setAttribute('aria-expanded', String(opening));
        if (opening && !body.dataset.loaded) {
          body.textContent = 'Loading timeline…';
          expandedDetails.set(task.attemptId, { body, task });
          vscode.postMessage({ type: 'getEverydayHistoryDetail', attemptId: task.attemptId });
        }
      });

      historyList.appendChild(item);
    }
  }

  function describeApproval(approval) {
    const kindText = { proposal: 'Plan approval', mutation: 'File-change approval', delivery: 'Delivery approval' }[approval.kind] || 'Approval';
    const statusText = {
      pending: 'waiting for you',
      approved: 'you approved it',
      rejected: 'you rejected it',
      expired: 'expired unanswered',
      superseded: 'replaced by a newer version',
    }[approval.status] || approval.status;
    return `${kindText} — ${statusText}`;
  }

  function renderHistoryDetail(attemptId, detail) {
    const pendingEntry = expandedDetails.get(attemptId);
    if (!pendingEntry) return;
    const { body, task } = pendingEntry;
    body.dataset.loaded = 'true';
    body.innerHTML = '';
    if (!detail) {
      body.textContent = 'The timeline for this task could not be loaded.';
      return;
    }

    const timeline = el('div', 'everyday-history-timeline');
    const addStep = (when, text, cls) => {
      const step = el('div', `everyday-history-step${cls ? ` ${cls}` : ''}`);
      const time = formatTime(when);
      if (time) step.appendChild(el('span', 'everyday-history-step-time', time));
      step.appendChild(el('span', 'everyday-history-step-text', text));
      timeline.appendChild(step);
    };

    addStep(detail.entry.createdAt, `You asked: ${firstLine(detail.entry.currentMessage, 160)}`);
    if (detail.entry.predecessorAttemptId) addStep(detail.entry.createdAt, 'Previous attempt blocked. A linked retry was created.');
    let lastPhase = null;
    for (const event of detail.events || []) {
      if (event.domain === 'attempt' && event.eventType === 'attempt_transitioned') {
        const to = event.metadata?.to;
        const phase = everyday.phaseForAttemptStatus(to, detail.entry.kind);
        if (phase !== lastPhase) {
          addStep(event.createdAt, phase);
          lastPhase = phase;
        }
      }
      if (event.domain === 'execution_quality') {
        const qualityText = {
          model_selection_decided: event.metadata?.suitabilitySummary || 'Selected a model suited to this task.',
          repository_path_corrected: 'Corrected a repository path.',
          repository_path_blocked: 'Blocked an unsafe or ambiguous repository path.',
          loop_detected: 'Detected repeated work that was not making progress.',
          strategy_changed: 'Changed strategy after repeated failures.',
          model_escalated: 'Switched to a stronger configured model.',
          validation_failed: 'A real validation check failed.',
          validation_repair_started: `Repairing a failing validation check (cycle ${event.metadata?.cycle || '?'}).`,
          validation_repair_completed: event.metadata?.passed ? 'Repaired a failing test.' : 'The repair ran; validation still failed.',
          validation_repair_exhausted: 'Automatic validation repair reached its safe limit.',
          retry_created: event.metadata?.strategy === 'stronger_model' ? 'Retried with a stronger model.' : 'Created a safe linked retry.',
          final_verification_recorded: 'Recorded final verification evidence.',
        }[event.eventType];
        if (qualityText) addStep(event.createdAt, String(qualityText));
      }
    }
    for (const approval of detail.approvals || []) {
      addStep(approval.resolvedAt || approval.requestedAt, describeApproval(approval), 'is-approval');
    }
    for (const checkpoint of detail.checkpoints || []) {
      if (checkpoint.kind === 'karke_dikha_validation') addStep(checkpoint.createdAt, 'Result checked with the approved validation commands.');
      if (checkpoint.kind === 'karke_dikha_delivery') {
        const sha = shortSha(checkpoint.metadata?.commitSha);
        addStep(checkpoint.createdAt, sha ? `Delivered commit ${sha}.` : 'Delivery recorded.');
      }
    }
    const finalPhase = everyday.phaseForAttemptStatus(detail.entry.status, detail.entry.kind);
    addStep(detail.entry.completedAt, finalPhase === everyday.PHASES.BLOCKED && detail.entry.failureReason
      ? `${finalPhase}: ${firstLine(detail.entry.failureReason, 160)}`
      : finalPhase, everyday.isTerminalPhase(finalPhase) ? `is-${finalPhase === everyday.PHASES.COMPLETED ? 'completed' : finalPhase === everyday.PHASES.BLOCKED ? 'blocked' : 'stopped'}` : undefined);

    body.appendChild(timeline);
    renderDetails(body, {
      attemptId: detail.entry.attemptId,
      requestId: detail.entry.requestId,
      conversationId: detail.entry.conversationId,
      status: detail.entry.status,
      resolvedMode: detail.entry.resolvedMode,
      predecessorAttemptId: detail.entry.predecessorAttemptId,
      successorAttemptId: detail.entry.successorAttemptId,
      selectedProvider: detail.entry.selectedProvider,
      selectedModel: detail.entry.selectedModel,
      modelSelection: detail.entry.modelSelection,
      retryGuidance: detail.entry.retryGuidance,
      routeReason: detail.entry.routeReason,
      approvals: detail.approvals,
      checkpoints: detail.checkpoints,
      events: detail.events,
    });
    expandedDetails.delete(attemptId);
    void task;
  }

  // ── Message handling ────────────────────────────────────────────────────
  // ── Resumed-objective cue (Step 7) ───────────────────────────────────────
  const continuityRow = document.getElementById('everyday-continuity');
  const continuityText = document.getElementById('everyday-continuity-text');
  const continuityDismiss = document.getElementById('everyday-continuity-dismiss');

  if (continuityDismiss && continuityRow) {
    continuityDismiss.addEventListener('click', () => {
      continuityRow.hidden = true;
      vscode.postMessage({ type: 'dismissContinuityNotice' });
    });
  }

  function startFreshChatDefaults() {
    explicitMode = 'chat';
    overrideMode = null;
    taskActiveOrJustFinished = false;
    try {
      vscode.setState?.(Object.assign({}, (vscode.getState && vscode.getState()) || {}, { lastPolicyMode: null, activeMode: 'chat', selectedModel: '' }));
    } catch { /* best-effort only */ }
    if (modeSelect.value !== 'chat') modeSelect.value = 'chat';
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const modelSelect = document.getElementById('model-select');
    if (modelSelect && modelSelect.value) {
      modelSelect.value = '';
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function renderContinuity(text, stale) {
    if (!continuityRow) return;
    if (!text) {
      continuityRow.hidden = true;
      if (continuityText) continuityText.textContent = '';
      else continuityRow.textContent = '';
      return;
    }
    continuityRow.hidden = false;
    if (continuityText) continuityText.textContent = text;
    else continuityRow.textContent = text;
    continuityRow.classList.toggle('is-stale', Boolean(stale));
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'conversationContinuity':
        if (message.reset) {
          restoredPolicyMode = null;
          renderContinuity('', false);
          recommendation = everyday.recommendMode(userInput.value || '', previousPolicyMode(), previousPolicyIsRestored());
          renderChip();
          break;
        }
        // Restored durable working state for this conversation. `cue` is the
        // only user-visible part; the internal schema is never exposed.
        restoredPolicyMode = message.previousMode || null;
        renderContinuity(message.cue || '', message.repositoryChanged);
        recommendation = everyday.recommendMode(userInput.value || '', previousPolicyMode(), previousPolicyIsRestored());
        renderChip();
        break;
      case 'done':
        // The execution projection (chat-dhaaga.js) is the only authority on how a run ended: a blocked / failed /
        // needs-input / cancelled run must never render a generic "Completed" footer just because the turn's `done` arrived.
        if (terminalPhaseFromProjection()) setPhase(terminalPhaseFromProjection());
        else if (!window.__kdExecutionState?.runId) setPhase(everyday.PHASES.COMPLETED);
        break;
      case 'stopped':
        setPhase(nonCompletedProjection() || everyday.PHASES.STOPPED);
        break;
      case 'error':
        setPhase(nonCompletedProjection() || everyday.PHASES.BLOCKED);
        break;
      case 'clear':
      case 'newConversation':
        restoredPolicyMode = null;
        // A host-confirmed New Chat always starts as Baat Kar + Auto model: nothing from the previous
        // conversation (mode, per-message recommendation memory, a manually picked model) carries over.
        if (message.type === 'newConversation' && message.reset === true) startFreshChatDefaults();
        renderContinuity('', false);
        hidePhase();
        renderedOutcomeForTask = null;
        taskActiveOrJustFinished = false;
        renderChip();
        break;
      case 'coreExecutionRestored':
        setPhase(everyday.phaseForAttemptStatus(message.status, message.mode === 'chat' ? 'baat_kar' : 'saath_kar'));
        break;
      case 'autonomousTaskStarted':
        renderedOutcomeForTask = null;
        taskActiveOrJustFinished = true;
        renderChip();
        {
          const outcomeCard = document.getElementById('everyday-outcome-card');
          if (outcomeCard) {
            outcomeCard.hidden = true;
            outcomeCard.replaceChildren();
            delete outcomeCard.dataset.taskId;
            delete outcomeCard.dataset.attemptId;
            outcomeCard.classList.remove('is-historical', 'is-blocked', 'is-success');
          }
        }
        hidePhase();
        break;
      case 'autonomousRetryStarted':
        renderedOutcomeForTask = null;
        taskActiveOrJustFinished = true;
        renderChip();
        hidePhase();
        {
          const card = ensureOutcomeCard();
          card.className = 'everyday-outcome-card';
          card.appendChild(el('strong', 'everyday-outcome-headline', `Previous attempt blocked. ${message.message || 'Retrying safely.'}`));
          storeTaskDetails({ predecessorAttemptId: message.predecessorAttemptId, attemptId: message.attemptId });
        }
        break;
      case 'autonomousTaskRejected':
        hidePhase();
        break;
      case 'autonomousTaskActive':
      case 'autonomousTaskStatus': {
        const state = String(message.state ?? '');
        const statusTaskId = String(message.taskId ?? '');
        const stamped = document.getElementById('autonomous-status')?.dataset.kdTaskMessage || '';
        const expected = statusTaskId ? `kd-task-message-${statusTaskId}` : '';
        if (stamped && expected && stamped !== expected) break;
        hidePhase();
        // B — stays hidden through active work AND through a rendered
        // completion/blocker card; only a fresh submission (see the
        // composer 'input' listener above) clears this again.
        taskActiveOrJustFinished = true;
        renderChip();
        if (message.type === 'autonomousTaskStatus') {
          const outcomeCard = document.getElementById('everyday-outcome-card');
          if (outcomeCard && statusTaskId) {
            const previous = outcomeCard.dataset.taskId;
            if (previous && previous !== statusTaskId) {
              outcomeCard.hidden = true;
              outcomeCard.replaceChildren();
              renderedOutcomeForTask = null;
            }
            outcomeCard.dataset.taskId = statusTaskId;
            if (outcomeCard.dataset.attemptId && message.attemptId && outcomeCard.dataset.attemptId !== String(message.attemptId)) {
              outcomeCard.classList.add('is-historical');
            }
            if (message.attemptId) outcomeCard.dataset.attemptId = String(message.attemptId);
          }
          if (state === 'completed') renderCompletionCard(message);
          else if (state === 'failed' || state === 'blocked' || state === 'cancelled') renderBlockerCard(message);
        }
        break;
      }
      case 'proposalApprovalRequest':
      case 'mutationApprovalRequest':
      case 'deliveryApprovalRequest':
        hidePhase();
        break;
      case 'everydayHistory':
        renderHistory(Array.isArray(message.tasks) ? message.tasks : [], message.available !== false);
        break;
      case 'everydayHistoryDetail':
        renderHistoryDetail(String(message.attemptId ?? ''), message.detail ?? null);
        break;
      default:
        break;
    }
  });

  renderChip();
})();
