(function () {
  'use strict';

  const modelSelect = document.getElementById('model-select');
  const modeSelect = document.getElementById('mode-select');
  const messages = document.getElementById('messages');
  const clearButton = document.getElementById('clear-btn');
  const newConversationButton = document.getElementById('new-conversation-btn');
  const autonomousStatus = document.getElementById('autonomous-status');
  const autonomousComposer = document.getElementById('autonomous-composer');
  const taskHeader = autonomousStatus?.querySelector('.task-focus-header');
  const taskTitle = document.getElementById('autonomous-task-title');
  const stageTracker = document.getElementById('autonomous-stage-tracker');
  const requestEntry = document.getElementById('task-request-entry');
  const promptSummary = document.getElementById('autonomous-prompt-summary');

  function ensureAutomaticModelOption() {
    if (!modelSelect) return;
    const existing = modelSelect.querySelector('option[value=""]');
    if (existing) {
      existing.textContent = 'Auto — use mode model';
      modelSelect.value = '';
      return;
    }
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Auto — use mode model';
    modelSelect.insertBefore(option, modelSelect.firstChild);
    modelSelect.value = '';
  }

  function ensureMode(value, label, beforeValue) {
    if (!modeSelect || modeSelect.querySelector(`option[value="${value}"]`)) return;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    const before = beforeValue ? modeSelect.querySelector(`option[value="${beforeValue}"]`) : null;
    modeSelect.insertBefore(option, before);
  }

  function clearVisibleConversation() {
    if (!messages) return;
    messages.querySelectorAll('.bubble, .repository-context-evidence, #everyday-outcome-card, .thinking').forEach(node => node.remove());
    const placeholder = document.getElementById('ambient-placeholder');
    if (placeholder) placeholder.hidden = false;
    const taskEntry = document.getElementById('task-request-entry');
    if (taskEntry) {
      taskEntry.hidden = true;
      const promptSummary = document.getElementById('autonomous-prompt-summary');
      if (promptSummary) promptSummary.textContent = '';
      const promptConstraints = document.getElementById('autonomous-prompt-constraints');
      if (promptConstraints) {
        promptConstraints.innerHTML = '';
        promptConstraints.hidden = true;
      }
    }
    const status = document.getElementById('autonomous-status');
    if (status) status.hidden = true;
    const autonomyModeSelect = document.getElementById('autonomy-mode-select');
    if (autonomyModeSelect) autonomyModeSelect.value = 'supervised';
    const continuity = document.getElementById('everyday-continuity');
    if (continuity) {
      continuity.hidden = true;
      const text = document.getElementById('everyday-continuity-text');
      if (text) text.textContent = '';
    }
  }

  function createCurrentActivity() {
    if (!taskHeader || document.getElementById('autonomous-current-activity')) return null;
    const strip = document.createElement('div');
    strip.id = 'autonomous-current-activity';
    strip.className = 'timeline-fact state-current';
    strip.hidden = true;
    strip.setAttribute('role', 'status');
    strip.setAttribute('aria-live', 'polite');

    const heading = document.createElement('strong');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.id = 'autonomous-current-activity-title';
    title.textContent = 'Preparing the task';
    heading.appendChild(spinner);
    heading.appendChild(document.createTextNode(' '));
    heading.appendChild(title);

    const text = document.createElement('p');
    text.id = 'autonomous-current-activity-text';
    text.textContent = 'Creating a safe isolated workspace.';

    const meta = document.createElement('div');
    meta.id = 'autonomous-current-activity-meta';
    meta.className = 'context-summary';
    meta.textContent = 'Setup · Task elapsed 0:00 · No action needed';

    strip.appendChild(heading);
    strip.appendChild(text);
    strip.appendChild(meta);
    taskHeader.appendChild(strip);
    return strip;
  }

  // Do not relocate `#autonomous-timeline`. M40 owns it inside
  // `#kd-task-details`; moving it into a second Details disclosure created
  // nested scrollbars and reset the live progress view on every update.
  const activityStrip = createCurrentActivity();
  const activityTitle = document.getElementById('autonomous-current-activity-title');
  const activityText = document.getElementById('autonomous-current-activity-text');
  const activityMeta = document.getElementById('autonomous-current-activity-meta');
  const activitySpinner = activityStrip?.querySelector('.spinner');
  let activityStartedAt = 0;
  let activityMode = 'working';
  let activityPhase = 'Setup';
  let activityTimer;
  let autonomousLifecycleTerminal = false;

  function elapsedLabel() {
    if (!activityStartedAt) return '0:00';
    const totalSeconds = Math.max(0, Math.floor((Date.now() - activityStartedAt) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }

  function refreshActivityMeta() {
    if (!activityMeta || !activityStartedAt) return;
    const actionLabels = {
      working: 'No action needed',
      waiting: 'Action required',
      completed: 'Finished',
      stopped: 'Needs attention',
    };
    activityMeta.textContent = `${activityPhase} · Task elapsed ${elapsedLabel()} · ${actionLabels[activityMode] || 'No action needed'}`;
  }

  function setCurrentActivity(activity, mode = 'working', resetElapsed = false) {
    if (!activityStrip || !activityTitle || !activityText) return;
    const value = typeof activity === 'string'
      ? { title: activity, description: '', phase: activityPhase }
      : activity;
    if (!activityStartedAt || resetElapsed) activityStartedAt = Date.now();
    activityMode = mode;
    activityPhase = value.phase || activityPhase;
    activityStrip.hidden = false;
    activityTitle.textContent = value.title || 'Working on the task';
    activityText.textContent = value.description || '';
    activityText.hidden = !value.description;
    if (activitySpinner) activitySpinner.hidden = mode !== 'working';
    refreshActivityMeta();
    if (!activityTimer) activityTimer = setInterval(refreshActivityMeta, 1000);
  }

  function compactTask(rawValue) {
    const raw = String(rawValue || '').replace(/\r/g, '').trim();
    if (!raw) return { title: 'Autonomous task', goal: '' };
    const lines = raw.split('\n').map(line => line.trim());
    const first = lines.find(line => line && !/^#{1,6}\s*$/.test(line)) || 'Autonomous task';
    const title = first.replace(/^#{1,6}\s*/, '').slice(0, 140);

    const goalHeading = lines.findIndex(line => /^#{1,6}\s*goal\s*$/i.test(line));
    let goal = '';
    if (goalHeading >= 0) {
      const goalLines = [];
      for (let index = goalHeading + 1; index < lines.length; index += 1) {
        if (/^#{1,6}\s+/.test(lines[index])) break;
        if (lines[index]) goalLines.push(lines[index]);
      }
      goal = goalLines.join(' ');
    }
    if (!goal) {
      goal = lines.find((line, index) => index > 0 && line && !/^#{1,6}\s+/.test(line) && !/^[-*]\s/.test(line)) || title;
    }
    return { title, goal: goal.slice(0, 360) };
  }

  function applyTaskSummary(rawValue) {
    const summary = compactTask(rawValue);
    if (taskTitle) taskTitle.textContent = summary.title;
    if (requestEntry) {
      requestEntry.hidden = false;
      const label = requestEntry.querySelector('strong');
      if (label) label.textContent = 'Goal';
    }
    if (promptSummary) promptSummary.textContent = summary.goal;
  }

  function firstProgressLine(renderedProgress) {
    return String(renderedProgress || '')
      .split(/\r?\n/, 1)[0]
      .replace(/^\d{2}:\d{2}:\d{2}\s+/, '')
      .trim();
  }

  function activityFromProgress(renderedProgress, state) {
    const full = String(renderedProgress || '');
    const first = firstProgressLine(full);

    if (/target already exists/i.test(full) || /Repairing the proposal/i.test(full)) {
      return {
        title: 'Adjusting the proposal',
        description: 'The target file already exists, so KarkeDikha is changing the operation from create to update.',
        phase: 'Proposal',
      };
    }
    if (/Proposal validation failed/i.test(full)) {
      return {
        title: 'Correcting the proposal',
        description: 'Matching the planned change to the current repository before asking for approval.',
        phase: 'Proposal',
      };
    }
    if (/Structured proposal generated/i.test(full)) {
      return {
        title: 'Checking the proposal',
        description: 'Verifying the intended file changes, validation commands, and current Git snapshot.',
        phase: 'Proposal',
      };
    }
    if (/Proposal scope identified/i.test(full)) {
      return {
        title: 'Confirming the change scope',
        description: 'Checking exactly which files are allowed to change.',
        phase: 'Proposal',
      };
    }
    if (/Stage 1\/5/i.test(first)) {
      return {
        title: 'Reading the repository',
        description: 'Finding the files, project rules, and existing implementation relevant to this task.',
        phase: 'Planning · Specialist 1 of 5',
      };
    }
    if (/Stage 2\/5/i.test(first)) {
      return {
        title: 'Planning the change',
        description: 'Designing the smallest safe implementation that satisfies the request.',
        phase: 'Planning · Specialist 2 of 5',
      };
    }
    if (/Stage 3\/5/i.test(first)) {
      return {
        title: 'Drafting the change',
        description: 'Preparing the exact file operation and content to apply after approval.',
        phase: 'Planning · Specialist 3 of 5',
      };
    }
    if (/Stage 4\/5/i.test(first)) {
      return {
        title: 'Reviewing the proposed change',
        description: 'Checking correctness, scope, and risk before the proposal is finalized.',
        phase: 'Planning · Specialist 4 of 5',
      };
    }
    if (/Stage 5\/5/i.test(first)) {
      return {
        title: 'Preparing the final proposal',
        description: 'Producing the structured change and validation plan that will be shown for approval.',
        phase: 'Planning · Specialist 5 of 5',
      };
    }
    if (/validation command \d+\/\d+.*npm run compile/i.test(full)) {
      return {
        title: 'Compiling the extension',
        description: 'Running npm run compile in the isolated workspace.',
        phase: 'Validation',
      };
    }
    if (/validation command \d+\/\d+.*npm (?:run )?test/i.test(full)) {
      return {
        title: 'Running the full test suite',
        description: 'Running npm test in the isolated workspace. This is usually the longest validation step.',
        phase: 'Validation',
      };
    }
    if (/validating|compile and test/i.test(full)) {
      return {
        title: 'Running validation',
        description: 'Executing the approved compile and test commands in the isolated workspace.',
        phase: 'Validation',
      };
    }
    return activityForState(state);
  }

  function activityForState(state) {
    switch (state) {
      case 'queued':
        return { title: 'Waiting to start', description: 'The task is queued and will begin when resources are available.', phase: 'Queue' };
      case 'preparing':
        return { title: 'Preparing a safe workspace', description: 'Creating and verifying an isolated Git worktree for the task.', phase: 'Setup' };
      case 'running':
        return { title: 'Working on the task', description: 'The next detailed activity will appear here as the workflow advances.', phase: 'In progress' };
      case 'validating':
        return { title: 'Running validation', description: 'Executing the approved compile and test commands in the isolated workspace.', phase: 'Validation' };
      case 'waiting_for_delivery_approval':
        return { title: 'Ready to apply', description: 'Validation and diff review passed. Click Apply to add the verified change to your working files.', phase: 'Delivery' };
      case 'committing':
        return { title: 'Creating the approved commit', description: 'Rechecking scope and recording the validated change in Git.', phase: 'Delivery' };
      case 'creating_pull_request':
        return { title: 'Creating the draft pull request', description: 'Publishing the approved commit for human review.', phase: 'Delivery' };
      case 'monitoring_ci':
        return { title: 'Checking CI', description: 'Waiting for the pull request checks and recording their result.', phase: 'Delivery' };
      case 'waiting_for_review':
        return { title: 'Waiting for human review', description: 'The draft pull request is ready; merge remains a human decision.', phase: 'Delivery' };
      case 'completed':
        return { title: 'Task completed', description: 'The governed workflow finished successfully.', phase: 'Complete' };
      case 'blocked':
        return { title: 'Task blocked', description: 'KarkeDikha cannot continue without resolving the reported problem.', phase: 'Blocked' };
      case 'failed':
        return { title: 'Task failed', description: 'The workflow stopped and diagnostic details are available below.', phase: 'Failed' };
      case 'cancelled':
        return { title: 'Task cancelled', description: 'No further work will be performed for this run.', phase: 'Cancelled' };
      default:
        return { title: 'Preparing the next step', description: 'KarkeDikha is moving the task to the next governed stage.', phase: 'In progress' };
    }
  }

  function stageFor(state, renderedProgress) {
    const progress = String(renderedProgress || '');
    if (state === 'completed') return 6;
    if (['committing', 'creating_pull_request', 'monitoring_ci', 'waiting_for_review'].includes(state)) return 5;
    if (state === 'waiting_for_delivery_approval') return 5;
    if (state === 'validating') return 4;
    if (state === 'waiting_for_mutation_approval' || state === 'waiting_for_proposal_approval') return 2;
    // An active internal graph stage (chat-autonomous.js User Progress Projection) is authoritative over guessing
    // from stage prose: the graph's own Validator runs before approval and is never "Checking the result".
    const graphStage = (state === 'running' || state === 'preparing') ? window.__kdGraphStage?.current?.() : null;
    if (graphStage) return graphStage.step;
    if (/validation|quality gate|diff review/i.test(progress)) return 4;
    if (/mutation|applying the approved repository change/i.test(progress)) return 3;
    if (/proposal|target already exists|Repairing the proposal/i.test(progress)) return 1;
    return 0;
  }

  function setVisibleStage(index) {
    stageTracker?.querySelectorAll('li').forEach((item, itemIndex) => {
      item.classList.toggle('is-complete', itemIndex < index);
      item.classList.toggle('is-current', itemIndex === index);
      if (itemIndex === index) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  function setTaskActive(state) {
    if (!autonomousComposer) return;
    const terminal = ['completed', 'blocked', 'failed', 'cancelled'].includes(String(state || ''));
    autonomousComposer.hidden = !terminal || modeSelect?.value !== 'autonomous';
  }

  function simplifyAfterStatus(message) {
    window.setTimeout(() => {
      applyTaskSummary(message.goal);
      const events = Array.isArray(message.events) ? message.events : [];
      const latestRendered = events.length ? String(events[events.length - 1].renderedProgress || '') : '';
      setVisibleStage(stageFor(String(message.state || ''), latestRendered));
      setTaskActive(String(message.state || ''));
    }, 0);
  }

  ensureAutomaticModelOption();
  ensureMode('ask', 'Ask — read only', 'agent');
  ensureMode('plan', 'Plan — read only', 'agent');

  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'modelsLoaded') ensureAutomaticModelOption();
    if (message?.type === 'newConversation') clearVisibleConversation();
    if (message?.type === 'newConversation' && message.reset === true) {
      // Hard reset of the task header owned here: a fresh conversation must not
      // keep the previous task's activity strip ("Task completed"), elapsed
      // timer, or active stage.
      autonomousLifecycleTerminal = false;
      activityStartedAt = 0;
      if (activityTimer) { clearInterval(activityTimer); activityTimer = undefined; }
      if (activityStrip) activityStrip.hidden = true;
      if (taskTitle) taskTitle.textContent = '';
      if (autonomousComposer) autonomousComposer.hidden = true;
      stageTracker?.querySelectorAll('li').forEach(item => {
        item.classList.remove('is-complete', 'is-current');
        item.removeAttribute('aria-current');
      });
    }

    switch (message?.type) {
      case 'autonomousTaskStarted':
        autonomousLifecycleTerminal = false;
        setTaskActive('running');
        setVisibleStage(0);
        setCurrentActivity({
          title: 'Preparing a safe workspace',
          description: 'Creating and verifying an isolated Git worktree for the task.',
          phase: 'Setup',
        }, 'working', true);
        break;
      case 'autonomousTaskActive': {
        const state = String(message.state || '');
        const terminal = ['completed', 'blocked', 'failed', 'cancelled'].includes(state);
        autonomousLifecycleTerminal = terminal;
        setTaskActive(state);
        setVisibleStage(stageFor(state, ''));
        setCurrentActivity(activityForState(state), terminal ? (state === 'completed' ? 'completed' : 'stopped') : 'working', true);
        break;
      }
      case 'autonomousTaskStatus': {
        const state = String(message.state || '');
        autonomousLifecycleTerminal = ['completed', 'blocked', 'failed', 'cancelled'].includes(state);
        const events = Array.isArray(message.events) ? message.events : [];
        const latestRendered = events.length ? String(events[events.length - 1].renderedProgress || '') : '';
        if (state === 'waiting_for_proposal_approval') {
          setCurrentActivity({
            title: 'Review the coding proposal',
            description: 'Check the planned file changes and choose Approve & Run, Request Revision, or Reject.',
            phase: 'Proposal',
          }, 'waiting');
        } else if (state === 'waiting_for_mutation_approval') {
          setCurrentActivity({
            title: 'Approve the repository change',
            description: 'The proposal is accepted. Confirm that KarkeDikha may apply it in the isolated workspace.',
            phase: 'Approval',
          }, 'waiting');
        } else if (state === 'waiting_for_delivery_approval') {
          setCurrentActivity({
            title: 'Ready to apply',
            description: 'Validation and review are complete. Click Apply to add the verified change to your working files.',
            phase: 'Delivery',
          }, 'waiting');
        } else if (state === 'completed') {
          setCurrentActivity(activityForState(state), 'completed');
        } else if (['blocked', 'failed', 'cancelled'].includes(state)) {
          setCurrentActivity(activityForState(state), 'stopped');
        } else {
          const graphStage = window.__kdGraphStage?.current?.();
          setCurrentActivity(graphStage
            ? { title: graphStage.activity, description: graphStage.detail, phase: 'Preparing the change' }
            : activityFromProgress(latestRendered, state), 'working');
        }
        simplifyAfterStatus(message);
        break;
      }
      case 'proposalApprovalRequest':
        if (autonomousLifecycleTerminal) break;
        setVisibleStage(2);
        setCurrentActivity({
          title: 'Review the coding proposal',
          description: 'Check the planned file changes and choose Approve & Run, Request Revision, or Reject.',
          phase: 'Proposal',
        }, 'waiting');
        break;
      case 'proposalApprovalResolved':
        if (autonomousLifecycleTerminal) break;
        setCurrentActivity(message.decision === 'approved'
          ? { title: 'Proposal approved', description: 'Preparing the bounded repository change for final mutation approval.', phase: 'Approval' }
          : { title: 'Proposal decision recorded', description: 'The workflow will follow your decision.', phase: 'Proposal' },
        message.decision === 'approved' ? 'working' : 'stopped');
        break;
      case 'mutationApprovalRequest':
        if (autonomousLifecycleTerminal) break;
        setVisibleStage(2);
        setCurrentActivity({
          title: 'Approve the repository change',
          description: 'Confirm that KarkeDikha may apply the approved operations in the isolated workspace.',
          phase: 'Approval',
        }, 'waiting');
        break;
      case 'mutationApprovalResolved':
        if (autonomousLifecycleTerminal) break;
        setCurrentActivity(message.decision === 'approved'
          ? { title: 'Applying the approved change', description: 'Writing only the approved paths inside the isolated workspace.', phase: 'Editing' }
          : { title: 'Mutation decision recorded', description: 'The workflow will follow your decision.', phase: 'Approval' },
        message.decision === 'approved' ? 'working' : 'stopped');
        break;
      case 'deliveryApprovalRequest':
        if (autonomousLifecycleTerminal) break;
        setVisibleStage(5);
        setCurrentActivity({
          title: 'Review the validated result',
          description: 'Approve delivery to create the commit, push the branch, and open the draft pull request.',
          phase: 'Delivery',
        }, 'waiting');
        break;
      case 'deliveryApprovalResolved':
        if (autonomousLifecycleTerminal) break;
        setCurrentActivity(message.decision === 'approved'
          ? { title: 'Creating the draft pull request', description: 'Committing and publishing the validated change for human review.', phase: 'Delivery' }
          : { title: 'Delivery decision recorded', description: 'The workflow will follow your decision.', phase: 'Delivery' },
        message.decision === 'approved' ? 'working' : 'stopped');
        break;
      default:
        break;
    }
  });

  newConversationButton?.addEventListener('click', clearVisibleConversation);

  clearButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    clearVisibleConversation();
    newConversationButton?.click();
  }, true);
})();
