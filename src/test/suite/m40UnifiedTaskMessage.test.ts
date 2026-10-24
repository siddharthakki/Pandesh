import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { JSDOM } from 'jsdom';
import { readResolvedCss } from '../helpers/resolveCssImports';

const root = path.join(__dirname, '..', '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function send(window: JSDOM['window'], data: Record<string, unknown>): void {
  window.dispatchEvent(new window.MessageEvent('message', { data }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Loads chat.html with the full production script set (matching the loader
 * order in chat.html itself: chat-autonomous, chat-sidebar-ui,
 * everyday-presentation, chat-everyday) so cross-file M40 behavior — the
 * pinned approval slot, the shared task-line writer, and the completion
 * card/recommendation-chip coordination — can be exercised together. */
function setupWebview(
  initialState: Record<string, unknown> = {},
  fullComposerRuntime = false,
  restorationResolved = true,
) {
  const dom = new JSDOM(read('media/chat.html'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://karkedikha.test/',
  });
  const { window } = dom;
  const posted: Array<Record<string, unknown>> = [];
  const scrolled: string[] = [];
  const focusCounts = new Map<string, number>();
  let state: Record<string, unknown> = initialState;

  const vscodeApi = {
      postMessage(message: Record<string, unknown>) { posted.push(message); },
      getState() { return state; },
      setState(next: Record<string, unknown>) { state = next; },
  };
  Object.defineProperty(window, '__ollamaAgentVsCodeApi', {
    value: vscodeApi,
  });
  Object.defineProperty(window, 'acquireVsCodeApi', { value: () => vscodeApi });
  Object.defineProperty(window, '__pandaBaseUri', { value: '' });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'TextDecoder', { value: TextDecoder });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });
  const style = window.document.createElement('style');
  style.textContent = readResolvedCss(path.join(root, 'media/chat-layout-fixes.css'));
  window.document.head.appendChild(style);
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this.id || this.tagName);
  };
  const originalFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function focus(...args: unknown[]) {
    const key = this.id || this.tagName;
    focusCounts.set(key, (focusCounts.get(key) || 0) + 1);
    return originalFocus?.apply(this, args as never);
  };

  if (fullComposerRuntime) {
    window.eval(read('media/chat.js'));
    window.eval(read('media/chat-runtime-fixes.js'));
  }
  window.eval(read('media/chat-autonomous.js'));
  window.eval(read('media/chat-sidebar-ui.js'));
  window.eval(read('media/everyday-presentation.js'));
  window.eval(read('media/chat-everyday.js'));
  if (restorationResolved) send(window, { type: 'workspaceRestorationResolved', workspaceIdentity: 'test-workspace' });
  return { dom, window, posted, scrolled, focusCounts };
}

const pandaWidth = (window: Window, el: HTMLElement): number => Number.parseFloat(window.getComputedStyle(el).width);

describe('M40 unified task message', () => {
  it('honors an explicit Saath Kar choice for a mutation-shaped request', async () => {
    const { dom, window, posted } = setupWebview({}, true);
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      const baatKar = window.document.querySelector(
        '.everyday-mode-option[data-mode="chat"]',
      ) as HTMLButtonElement;
      input.value = 'Explain what this repository contains.';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
      baatKar.click();
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();
      send(window, { type: 'done', content: 'Repository explanation.' });
      await settle();
      expect(posted.filter(message => message.type === 'sendMessage').at(-1)).toEqual(expect.objectContaining({
        type: 'sendMessage',
        mode: 'chat',
      }));

      input.value = 'Create note-saath.txt containing Hello from Saath Kar';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));

      const saathKar = window.document.querySelector(
        '.everyday-mode-option[data-mode="agent"]',
      ) as HTMLButtonElement;
      saathKar.click();
      expect(saathKar.getAttribute('aria-pressed')).toBe('true');

      (window.document.getElementById('send-btn') as HTMLButtonElement).click();
      await settle();

      expect(posted.filter(message => message.type === 'sendMessage').at(-1)).toEqual(expect.objectContaining({
        type: 'sendMessage',
        mode: 'agent',
      }));
      expect(posted).not.toContainEqual(expect.objectContaining({
        type: 'startAutonomousTask',
      }));
    } finally {
      dom.window.close();
    }
  });

  it('updates one compact panda image in place, rendered at the compact 42px size in every state', async () => {
    const { dom, window } = setupWebview();
    try {
      const panda = window.document.getElementById('autonomous-panda') as HTMLElement;
      const image = panda.querySelector('img')!;
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'attempt-1', state: 'running', pandaState: 'planning', goal: 'Plan safely', events: [] });
      await settle();
      // The status panda is deliberately compact (42px) in every state; what must hold is that it is one image,
      // updated in place, at that compact size.
      expect(pandaWidth(window, panda)).toBe(42);
      expect(panda.dataset.state).toBe('planning');

      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'attempt-1', state: 'waiting_for_delivery_approval', pandaState: 'waiting_for_delivery_approval', goal: 'Plan safely', events: [] });
      await settle();
      expect(window.document.querySelector('#autonomous-panda img')).toBe(image);
      expect(pandaWidth(window, panda)).toBe(42);
      expect(panda.dataset.state).toBe('waiting_for_delivery_approval');

      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'attempt-1', state: 'cancelled', pandaState: 'cancelled', goal: 'Plan safely', events: [] });
      await settle();
      expect(window.document.querySelector('#autonomous-panda img')).toBe(image);
      expect(pandaWidth(window, panda)).toBe(42);
      expect(panda.dataset.state).toBe('cancelled');
      expect(window.document.querySelectorAll('.kd-task-message #autonomous-panda')).toHaveLength(1);
      expect(window.document.querySelectorAll('.kd-task-message .kd-panda-icon--approval')).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });

  it('renders one chronological user request and one simplified evolving response with one Details owner', async () => {
    const { dom, window, scrolled } = setupWebview();
    try {
      const goal = 'Create the uniquely-named conversation-order.txt file';
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        goal,
        events: [{ eventId: 'e1', seq: 1, renderedProgress: 'Planning the smallest safe change…', pandaState: 'planning' }],
      });
      await settle();

      const messages = window.document.getElementById('messages')!;
      const request = window.document.getElementById('task-request-entry')!;
      const response = window.document.getElementById('autonomous-status')!;
      expect(messages.querySelectorAll('#task-request-entry')).toHaveLength(1);
      expect(messages.querySelectorAll('.kd-task-message')).toHaveLength(1);
      expect(request.compareDocumentPosition(response) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(request.textContent).toContain(goal);
      expect(response.textContent).not.toContain(goal);
      expect(response.querySelectorAll('#kd-task-line')).toHaveLength(1);
      expect(response.querySelectorAll('details')).toHaveLength(1);
      expect(response.querySelector('details > summary')?.textContent).toBe('Details');
      expect(response.querySelector('details')?.contains(window.document.getElementById('autonomous-provider-model'))).toBe(true);
      expect(window.document.getElementById('everyday-phase')?.hidden).toBe(true);
      expect(window.document.getElementById('workbench-actions')).toBeNull();
      expect(window.document.getElementById('overflow-menu')?.contains(window.document.getElementById('export-markdown-btn'))).toBe(true);
      expect(scrolled).toEqual([]);
    } finally {
      dom.window.close();
    }
  });

  it('drives Send, Stop, Steer plus compact Stop, Update task, and terminal Send from one composer', async () => {
    const { dom, window, posted } = setupWebview();
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      const primary = window.document.getElementById('send-btn') as HTMLButtonElement;
      const compactStop = window.document.getElementById('unified-task-stop-btn') as HTMLButtonElement;
      expect(primary.textContent).toBe('Send');

      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'task-1' });
      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'task-1', state: 'running', goal: 'Create note.txt', events: [] });
      await settle();
      expect(primary.textContent).toBe('Stop');
      expect(compactStop.hidden).toBe(true);

      input.value = 'Use greeting.txt instead.';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      expect(primary.textContent).toBe('Steer');
      expect(compactStop.hidden).toBe(false);
      primary.click();
      expect(posted.at(-1)).toMatchObject({ type: 'steerTask', taskId: 'task-1', message: 'Use greeting.txt instead.' });

      send(window, { type: 'taskSteered', taskId: 'task-1', messageId: posted.at(-1)?.messageId });
      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'task-1', state: 'waiting_for_proposal_approval', goal: 'Create note.txt', events: [] });
      input.value = 'Also validate the new filename.';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      expect(primary.textContent).toBe('Update task');
      expect(compactStop.hidden).toBe(false);

      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'task-1', state: 'cancelled', goal: 'Create note.txt', events: [] });
      await settle();
      expect(primary.textContent).toBe('Send');
      expect(compactStop.hidden).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('keeps the literal user message and Karke Dikha\'s carried-forward objective visually and semantically distinct (Step 10)', async () => {
    const { dom, window, posted } = setupWebview({}, true);
    try {
      const typed = 'Continue and run the relevant validation.';
      // The frozen M15 goal Core requires can differ from the literal typed
      // text: ConversationContinuity.ts#formatCarriedConstraints appends a
      // deterministic suffix when a constraint carries forward from an
      // earlier turn in the same objective.
      const frozenGoal = `${typed}\n\nConstraints carried forward from this conversation: Do not change tests.`;
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      const sendButton = window.document.getElementById('send-btn') as HTMLButtonElement;
      input.value = typed;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      sendButton.click();

      const submission = posted.find(message => message.type === 'startAutonomousTask');
      expect(submission).toMatchObject({ text: typed });

      send(window, {
        type: 'autonomousTaskStarted',
        taskId: 'task-continuity',
        attemptId: 'task-continuity',
        submissionId: submission?.submissionId,
        state: 'queued',
        goal: frozenGoal,
      });
      await settle();

      // Exactly one literal user bubble, containing exactly what the user
      // typed — never rewritten, never carrying the derived suffix.
      const userBubbles = window.document.querySelectorAll('.bubble.user');
      expect(userBubbles).toHaveLength(1);
      expect(userBubbles[0].textContent?.trim()).toBe(typed);
      expect(userBubbles[0].id).not.toBe('task-request-entry');

      // Karke Dikha's own objective card is visually and semantically
      // distinct: no `.bubble`/`.user` class, and the carried constraint is
      // rendered as its own labeled line rather than folded into the goal.
      const objectiveCard = window.document.getElementById('task-request-entry')!;
      expect(objectiveCard.classList.contains('user')).toBe(false);
      expect(objectiveCard.classList.contains('bubble')).toBe(false);
      expect(objectiveCard.classList.contains('kd-objective-card')).toBe(true);
      expect(window.document.getElementById('autonomous-prompt-summary')?.textContent).toBe(typed);
      const constraints = window.document.getElementById('autonomous-prompt-constraints')!;
      expect(constraints.hidden).toBe(false);
      expect(constraints.textContent).toContain('Do not change tests');
    } finally {
      dom.window.close();
    }
  });

  it('projects durable acknowledgement into the real conversation before any progress event', async () => {
    const { dom, window, posted } = setupWebview({}, true);
    try {
      const goal = 'Create note.txt containing Hello, then verify it was written.';
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      const sendButton = window.document.getElementById('send-btn') as HTMLButtonElement;
      input.value = goal;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      sendButton.click();

      const submission = posted.find(message => message.type === 'startAutonomousTask');
      expect(submission).toMatchObject({ text: goal });
      expect(submission?.submissionId).toMatch(/^submission-/);

      send(window, {
        type: 'autonomousTaskStarted',
        taskId: 'task-accepted',
        attemptId: 'task-accepted',
        submissionId: submission?.submissionId,
        state: 'queued',
        goal,
      });
      await settle();

      const messages = window.document.getElementById('messages')!;
      const request = window.document.getElementById('task-request-entry')!;
      const response = window.document.getElementById('autonomous-status')!;
      const panda = window.document.getElementById('autonomous-panda') as HTMLElement;
      // The literal optimistic bubble is an exact duplicate of the frozen
      // goal here (no carried constraints), so it collapses away and
      // Karke Dikha's own (non-`.bubble.user`) objective card is the sole
      // display — see the Step 10 test above for the carried-constraints case.
      expect(messages.querySelectorAll('.bubble.user')).toHaveLength(0);
      expect(messages.querySelectorAll('.kd-task-message')).toHaveLength(1);
      expect(request.compareDocumentPosition(response) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(request.textContent).toContain(goal);
      expect(response.hidden).toBe(false);
      expect(response.querySelectorAll('details#kd-task-details')).toHaveLength(1);
      expect((response.querySelector('details') as HTMLDetailsElement).open).toBe(false);
      expect(response.querySelector('#kd-task-line')?.textContent).toMatch(/Starting the task safely|Task queued/);
      expect(panda.dataset.state).toBe('thinking');
      expect(pandaWidth(window, panda)).toBe(42);
      expect(sendButton.textContent).toBe('Stop');
      expect(sendButton.disabled).toBe(false);
      expect(sendButton.dataset.taskId).toBe('task-accepted');

      sendButton.click();
      expect(posted.at(-1)).toMatchObject({ type: 'cancelTask', taskId: 'task-accepted' });
    } finally {
      dom.window.close();
    }
  });

  it('merges progress that wins the acknowledgement race without losing events or duplicating the shell', async () => {
    const { dom, window, posted } = setupWebview({}, true);
    try {
      const goal = 'Create note.txt containing Hello, then verify it was written.';
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      input.value = goal;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();
      const submissionId = posted.find(message => message.type === 'startAutonomousTask')?.submissionId;

      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-race',
        attemptId: 'task-race',
        state: 'running',
        goal,
        events: [{ eventId: 'progress-1', seq: 1, renderedProgress: 'Preparing the safe change.', pandaState: 'planning' }],
      });
      send(window, {
        type: 'autonomousTaskStarted',
        taskId: 'task-race',
        attemptId: 'task-race',
        submissionId,
        state: 'queued',
        goal,
      });
      send(window, {
        type: 'autonomousTaskStarted',
        taskId: 'task-race',
        attemptId: 'task-race',
        submissionId,
        state: 'queued',
        goal,
      });
      await settle();

      expect(window.document.querySelectorAll('.kd-task-message')).toHaveLength(1);
      // No carried constraints here either, so the literal duplicate
      // collapses into Karke Dikha's own (non-`.bubble.user`) objective card.
      expect(window.document.querySelectorAll('.bubble.user')).toHaveLength(0);
      expect(window.document.querySelectorAll('#autonomous-timeline .autonomous-timeline-entry')).toHaveLength(2);
      expect(window.document.getElementById('autonomous-timeline')?.textContent).toContain('Preparing the safe change.');
      expect(window.document.getElementById('send-btn')?.textContent).toBe('Stop');
    } finally {
      dom.window.close();
    }
  });

  it('restores the acknowledgement shell immediately and rejects stale task-created control', async () => {
    const { dom, window, posted } = setupWebview();
    try {
      send(window, {
        type: 'autonomousTaskActive',
        taskId: 'task-current',
        attemptId: 'task-current',
        state: 'preparing',
        goal: 'create note.txt containing Hello',
        restored: true,
      });
      send(window, {
        type: 'autonomousTaskStarted',
        taskId: 'task-old',
        attemptId: 'task-old',
        submissionId: 'submission-old',
        state: 'queued',
        goal: 'old task',
      });
      await settle();

      const response = window.document.getElementById('autonomous-status') as HTMLElement;
      expect(response.dataset.kdTaskMessage).toBe('kd-task-message-task-current');
      expect(window.document.getElementById('task-request-entry')?.textContent).toContain('create note.txt containing Hello');
      expect(window.document.getElementById('send-btn')?.textContent).toBe('Stop');
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();
      expect(posted.at(-1)).toMatchObject({ type: 'cancelTask', taskId: 'task-current' });
    } finally {
      dom.window.close();
    }
  });

  it('routes the visible unified composer only to the exact active task and clears it after durable acknowledgement', async () => {
    const { dom, window, posted } = setupWebview({}, true);
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'task-1' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'task-1',
        state: 'running',
        goal: 'create note.txt containing Hello',
        events: [],
      });
      await settle();

      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      const sendButton = window.document.getElementById('send-btn') as HTMLButtonElement;
      input.value = 'Use greeting.txt instead';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      sendButton.click();

      const steering = posted.filter(message => message.type === 'steerTask');
      expect(steering).toHaveLength(1);
      expect(steering[0]).toMatchObject({
        taskId: 'task-1',
        message: 'Use greeting.txt instead',
      });
      expect(posted.some(message => message.type === 'sendMessage' || message.type === 'startAutonomousTask')).toBe(false);
      expect(input.value).toBe('Use greeting.txt instead');
      expect(sendButton.disabled).toBe(true);
      // #task-request-entry is Karke Dikha's own objective card, not a
      // literal user chat bubble (Progress & Completion UX V1, Step 10) — it
      // is never `.bubble.user`, and none exists here since no real user
      // bubble was created via chat.js's send flow in this scenario.
      expect(window.document.querySelectorAll('.bubble.user')).toHaveLength(0);
      expect(window.document.getElementById('task-request-entry')?.classList.contains('kd-objective-card')).toBe(true);
      expect(window.document.querySelectorAll('.message-workbench-actions')).toHaveLength(0);

      send(window, { type: 'taskSteered', taskId: 'task-1', messageId: steering[0].messageId });
      await settle();
      expect(input.value).toBe('');
      expect(sendButton.disabled).toBe(false);
      expect(window.document.querySelectorAll('#task-request-entry')).toHaveLength(1);
      expect(window.document.querySelectorAll('.kd-task-message')).toHaveLength(1);
      expect(window.document.querySelectorAll('details#kd-task-details')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it('keeps ordinary classification disabled until workspace task ownership restoration resolves', async () => {
    const { dom, window, posted } = setupWebview({}, true, false);
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      const sendButton = window.document.getElementById('send-btn') as HTMLButtonElement;
      input.value = 'Use greeting.txt instead';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      expect(sendButton.disabled).toBe(true);
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(posted.some(message =>
        message.type === 'sendMessage'
        || message.type === 'classifyAndSend'
        || message.type === 'startAutonomousTask')).toBe(false);

      send(window, {
        type: 'autonomousTaskActive',
        taskId: 'task-restored',
        attemptId: 'task-restored',
        state: 'running',
        goal: 'create note.txt containing Hello',
        restored: true,
      });
      send(window, { type: 'workspaceRestorationResolved', workspaceIdentity: 'workspace-a' });
      await settle();
      expect(sendButton.textContent).toBe('Steer');
      sendButton.click();
      expect(posted.filter(message => message.type === 'steerTask')).toEqual([
        expect.objectContaining({
          taskId: 'task-restored',
          message: 'Use greeting.txt instead',
        }),
      ]);
      expect(posted.some(message => message.type === 'sendMessage' || message.type === 'startAutonomousTask')).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('contains one correctly encoded active-answer marker and no known mojibake literal', () => {
    const source = read('media/chat.js');
    expect(source).toContain('`Answer ${index + 1} ✓`');
    expect(source).not.toContain('Ã¢Å“â€œ');
    expect(source).not.toContain('âœ“');
  });

  it('binds Stop to the exact rendered task and restores Send after every terminal state', async () => {
    const { dom, window, posted } = setupWebview();
    try {
      const primary = window.document.getElementById('autonomous-start-btn') as HTMLButtonElement;
      for (const terminal of ['completed', 'failed', 'cancelled', 'blocked']) {
        const taskId = `task-${terminal}`;
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId });
        send(window, { type: 'autonomousTaskStatus', taskId, attemptId: taskId, state: 'running', goal: 'Work', events: [] });
        primary.click();
        expect(posted.at(-1)).toMatchObject({ type: 'cancelTask', taskId });
        send(window, { type: 'autonomousTaskStatus', taskId, attemptId: taskId, state: terminal, goal: 'Work', events: [] });
        await settle();
        expect(primary.textContent).toBe('Send');
        primary.disabled = false;
      }
      expect(posted.filter(message => message.type === 'cancelTask').map(message => message.taskId))
        .toEqual(['task-completed', 'task-failed', 'task-cancelled', 'task-blocked']);
    } finally {
      dom.window.close();
    }
  });

  it('keeps a live completed projection terminal when a late delivery resolution arrives', async () => {
    const { dom, window } = setupWebview();
    try {
      const primary = window.document.getElementById('send-btn') as HTMLButtonElement;
      const compactStop = window.document.getElementById('unified-task-stop-btn') as HTMLButtonElement;
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'task-1' });
      send(window, { type: 'deliveryApprovalRequest', taskId: 'task-1', attemptId: 'task-1' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'task-1',
        state: 'completed',
        goal: 'create note.txt containing Hello',
        events: [],
      });
      send(window, { type: 'deliveryApprovalResolved', taskId: 'task-1', decision: 'approved' });
      await settle();

      expect(window.document.getElementById('kd-task-line')?.textContent).toBe('Completed');
      expect(primary.textContent).toBe('Send');
      expect(primary.dataset.taskId).toBe('');
      expect(compactStop.hidden).toBe(true);
      expect(window.document.body.dataset.autonomousTaskActive).toBe('false');
      expect(window.document.querySelectorAll('#messages .kd-task-message')).toHaveLength(1);
      expect(window.document.querySelectorAll('#everyday-outcome-card.is-success')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it('resends one durable unacknowledged steering message with the same id after restart', async () => {
    const pending = { taskId: 'task-1', messageId: 'steer-durable-1', message: 'Use greeting.txt instead.' };
    const { dom, window, posted } = setupWebview({ pendingAutonomousSteer: pending });
    try {
      send(window, { type: 'autonomousTaskActive', taskId: 'task-1', attemptId: 'task-1', state: 'running' });
      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'task-1', state: 'running', goal: 'Create note.txt', events: [] });
      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'task-1', state: 'running', goal: 'Create note.txt', events: [] });
      await settle();
      expect(posted.filter(message => message.type === 'steerTask')).toEqual([{
        type: 'steerTask',
        taskId: 'task-1',
        messageId: 'steer-durable-1',
        message: 'Use greeting.txt instead.',
      }]);
    } finally {
      dom.window.close();
    }
  });

  it('starting a task creates exactly one .kd-task-message element', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      expect(window.document.querySelectorAll('.kd-task-message')).toHaveLength(1);
      const wrapper = window.document.querySelector('.kd-task-message')!;
      expect(wrapper.id).toBe('autonomous-status');
      expect((wrapper as HTMLElement).dataset.kdTaskMessage).toBe('kd-task-message-task-1');
    } finally {
      dom.window.close();
    }
  });

  it('updates the same .kd-task-line textContent across multiple status polls instead of adding new rows', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      const wrapper = window.document.getElementById('autonomous-status')!;
      const line = window.document.getElementById('kd-task-line')!;
      const childCountBefore = wrapper.children.length;

      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [{ eventId: 'e1', renderedProgress: 'Stage 1/5 — Repository Analyst' }],
      });
      await settle();
      expect(window.document.getElementById('kd-task-line')).toBe(line);
      expect(wrapper.children.length).toBe(childCountBefore);
      expect(line.textContent).toContain('Stage 1/5');

      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [{ eventId: 'e2', renderedProgress: 'Stage 2/5 — Planner' }],
      });
      await settle();
      expect(window.document.getElementById('kd-task-line')).toBe(line);
      expect(wrapper.children.length).toBe(childCountBefore);
      expect(line.textContent).toContain('Stage 2/5');
    } finally {
      dom.window.close();
    }
  });

  it('.kd-task-details has no open attribute by default after task start', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      const details = window.document.getElementById('kd-task-details') as HTMLDetailsElement;
      expect(details.hasAttribute('open')).toBe(false);
      expect(details.open).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('proposal, mutation, and delivery approval cards all mount inside the SAME .kd-task-message wrapper, and there is no independent nested-scroll trap while pending', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      const wrapper = window.document.getElementById('autonomous-status')!;

      send(window, {
        type: 'proposalApprovalRequest', taskId: 'task-1', attemptId: 'attempt-1', proposalId: 'p1', version: 1,
        taskSummary: 'sum', operations: [], validationCommands: [], warnings: [],
      });
      await settle();
      const proposal = window.document.getElementById('proposal-approval-card')!;
      expect(wrapper.contains(proposal)).toBe(true);
      // No ancestor of the pending card between it and the wrapper enforces a
      // fixed-height scroll trap.
      let node: HTMLElement | null = proposal.parentElement as HTMLElement | null;
      while (node && node !== wrapper) {
        const inlineOverflow = node.style.overflowY;
        expect(['scroll', 'auto'].includes(inlineOverflow) && node.style.maxHeight && node.style.maxHeight !== 'none').toBeFalsy();
        node = node.parentElement;
      }

      send(window, { type: 'proposalApprovalResolved', taskId: 'task-1', proposalId: 'p1', decision: 'approved' });
      await settle();

      send(window, {
        type: 'mutationApprovalRequest', taskId: 'task-1', attemptId: 'attempt-1', requestId: 'm1',
        operationCount: 1, targets: ['a.ts'], elevatedConfirmationRequired: false,
      });
      await settle();
      const mutation = window.document.getElementById('mutation-approval-card')!;
      expect(wrapper.contains(mutation)).toBe(true);

      send(window, { type: 'mutationApprovalResolved', taskId: 'task-1', requestId: 'm1', decision: 'approved' });
      await settle();

      send(window, { type: 'deliveryApprovalRequest', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      const delivery = window.document.getElementById('delivery-approval-card')!;
      expect(wrapper.contains(delivery)).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('focuses the primary action button exactly once when a gate newly becomes pending, and does not re-focus on a duplicate event', async () => {
    const { dom, window, focusCounts } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      send(window, {
        type: 'proposalApprovalRequest', taskId: 'task-1', attemptId: 'attempt-1', proposalId: 'p1', version: 1,
        taskSummary: 'sum', operations: [], validationCommands: [], warnings: [],
      });
      await settle();

      const before = focusCounts.get('proposal-approve-btn') || 0;
      expect(before).toBeGreaterThanOrEqual(1);

      // A duplicate/ordinary status poll while the SAME gate is still
      // pending must not focus again.
      send(window, {
        type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'attempt-1', state: 'waiting_for_proposal_approval', events: [],
      });
      await settle();
      send(window, {
        type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'attempt-1', state: 'waiting_for_proposal_approval', events: [],
      });
      await settle();
      expect(focusCounts.get('proposal-approve-btn')).toBe(before);
    } finally {
      dom.window.close();
    }
  });

  it('completion event updates the SAME wrapper, the completion content is the last child and is not hidden, and the text does not say "shown below"', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      const wrapper = window.document.getElementById('autonomous-status')!;

      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'completed',
        goal: 'Do the thing',
        approvedScopePaths: ['a.ts'],
        events: [],
      });
      await settle();

      expect(window.document.getElementById('autonomous-status')).toBe(wrapper);
      const outcome = window.document.getElementById('everyday-outcome-card')!;
      expect(wrapper.contains(outcome)).toBe(true);
      expect(wrapper.lastElementChild).toBe(outcome);
      expect(outcome.hidden).toBe(false);
      expect(outcome.textContent).not.toContain('shown below');
    } finally {
      dom.window.close();
    }
  });

  it('hides #everyday-reco-row while a task is active and keeps it hidden after completion until a fresh submission', async () => {
    const { dom, window } = setupWebview();
    try {
      const reco = window.document.getElementById('everyday-reco-row')!;
      const userInput = window.document.getElementById('user-input') as HTMLTextAreaElement;

      userInput.value = 'Fix the settings page crash';
      userInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(reco.hidden).toBe(false);

      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      expect(reco.hidden).toBe(true);

      send(window, {
        type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'attempt-1', state: 'completed', goal: 'Fix it', events: [],
      });
      await settle();
      expect(reco.hidden).toBe(true);

      // Composing a fresh request after the terminal state un-hides it again.
      userInput.value = 'What does this function do?';
      userInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(reco.hidden).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('reload/reconnect (autonomousTaskActive) never produces a duplicate .kd-task-message', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskActive', taskId: 'task-1', attemptId: 'attempt-1', state: 'running' });
      await settle();
      send(window, { type: 'autonomousTaskActive', taskId: 'task-1', attemptId: 'attempt-1', state: 'running' });
      await settle();
      expect(window.document.querySelectorAll('.kd-task-message')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it('does not attach a previous task\'s blocked outcome to the current task label', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-old', attemptId: 'attempt-old' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-old',
        attemptId: 'attempt-old',
        state: 'blocked',
        goal: 'old goal',
        failure: { classification: 'runtime_error', message: '{"error":"stale-blocked-json"}' },
        events: [],
      });
      await settle();
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-new', attemptId: 'attempt-new' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-new',
        attemptId: 'attempt-new',
        state: 'running',
        goal: 'new goal',
        events: [{ eventId: 'e1', renderedProgress: 'Reading helper.js' }],
      });
      await settle();
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-old',
        attemptId: 'attempt-old',
        state: 'blocked',
        goal: 'old goal',
        failure: { classification: 'runtime_error', message: '{"error":"stale-blocked-json"}' },
        events: [],
      });
      await settle();

      expect(window.document.getElementById('autonomous-task-id')?.textContent).toContain('task-new');
      const outcome = window.document.getElementById('everyday-outcome-card');
      expect(outcome?.hidden).toBe(true);
      expect(outcome?.textContent || '').not.toContain('stale-blocked-json');
      expect(window.document.getElementById('kd-task-line')?.textContent || '').not.toContain('stale-blocked-json');
    } finally {
      dom.window.close();
    }
  });
});
