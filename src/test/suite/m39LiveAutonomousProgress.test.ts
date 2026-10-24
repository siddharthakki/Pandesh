import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const root = path.join(__dirname, '..', '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function send(window: JSDOM['window'], data: Record<string, unknown>): void {
  window.dispatchEvent(new window.MessageEvent('message', { data }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function setupWebview() {
  const dom = new JSDOM(read('media/chat.html'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://karkedikha.test/',
  });
  const { window } = dom;
  let state: Record<string, unknown> = {};

  Object.defineProperty(window, '__ollamaAgentVsCodeApi', {
    value: {
      postMessage() {},
      getState() { return state; },
      setState(next: Record<string, unknown>) { state = next; },
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

  window.eval(read('media/chat-sidebar-ui.js'));
  return { dom, window };
}

// M40 note: chat-sidebar-ui.js no longer builds its own top-of-status
// `#kd-live-progress-card` (which used to fight chat-everyday.js's
// `#everyday-outcome-card` for the same `insertBefore(..., firstChild)`
// slot). It now writes the SAME `#kd-task-line` element inside the single
// `.kd-task-message` wrapper (`#autonomous-status`) in place — these tests
// were updated to assert against that single line instead of the removed
// card's sub-elements, while preserving equivalent behavioral coverage
// (truthful pre-checkpoint heartbeat, checkpoint replacement, no
// duplication on a resent checkpoint, and no updates after a terminal
// state).
describe('M39 live autonomous progress projection', () => {
  it('shows the autonomous surface and a truthful heartbeat even before the first detailed checkpoint arrives', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();

      const status = window.document.getElementById('autonomous-status')!;
      const line = window.document.getElementById('kd-task-line')!;
      expect(status.hidden).toBe(false);
      expect(line.textContent).toContain('Task queued');
      expect(line.textContent).toContain('checked');
    } finally {
      dom.window.close();
    }
  });

  it('replaces generic running text with the latest real checkpoint, updating the same line in place without duplicating rows', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      const line = window.document.getElementById('kd-task-line')!;
      const wrapper = window.document.getElementById('autonomous-status')!;
      const childCountBefore = wrapper.children.length;

      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [
          { eventId: 'event-1', renderedProgress: 'Stage 1/5 — Repository Analyst\nReading the repository and selecting relevant files.' },
          { eventId: 'event-2', renderedProgress: 'Stage 1/5 — Repository Analyst completed\nFinished in 8.2 s.' },
          { eventId: 'event-3', renderedProgress: 'Stage 2/5 — Planner\nDesigning the smallest safe implementation plan.' },
        ],
      });
      await settle();

      expect(window.document.getElementById('kd-task-line')).toBe(line);
      expect(line.textContent).toContain('Stage 2/5 — Planner');
      expect(line.textContent).toContain('smallest safe implementation plan');
      expect(window.document.getElementById('everyday-phase-sentence')?.textContent).toContain('Stage 2/5 — Planner');
      // No new top-level elements were appended to the wrapper for the line update.
      expect(wrapper.children.length).toBe(childCountBefore);

      // Polling may resend a checkpoint. It must refresh the heartbeat text
      // without duplicating anything or reverting to generic "running".
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [{ eventId: 'event-3', renderedProgress: 'Stage 2/5 — Planner\nDesigning the smallest safe implementation plan.' }],
      });
      await settle();
      expect(window.document.getElementById('kd-task-line')).toBe(line);
      expect(line.textContent).toContain('Stage 2/5 — Planner');
      expect(wrapper.children.length).toBe(childCountBefore);
    } finally {
      dom.window.close();
    }
  });

  it('stops updating the task line once a terminal outcome takes over', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [{ eventId: 'event-1', renderedProgress: 'Stage 2/5 — Planner' }],
      });
      await settle();
      const line = window.document.getElementById('kd-task-line')!;
      send(window, { type: 'autonomousTaskStatus', taskId: 'task-1', attemptId: 'attempt-1', state: 'completed', events: [] });
      await settle();
      expect(line.textContent).toBe('Completed');
      expect(window.document.getElementById('stop-btn')?.hidden).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('rejects a late status snapshot from a previous task so the current task line is not overwritten', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-new', attemptId: 'attempt-new' });
      await settle();
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-new',
        attemptId: 'attempt-new',
        state: 'running',
        events: [{ eventId: 'event-new', renderedProgress: '12:01:00  Reading src/activation/M15AutonomousRuntime.ts' }],
      });
      await settle();
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-old',
        attemptId: 'attempt-old',
        state: 'blocked',
        failure: { classification: 'runtime_error', message: '{"blocked":true}' },
        events: [{ eventId: 'event-old', renderedProgress: 'Blocked: runtime_error' }],
      });
      await settle();
      const line = window.document.getElementById('kd-task-line')!;
      expect(line.textContent).toContain('Reading src/activation/M15AutonomousRuntime.ts');
      expect(line.textContent).not.toContain('runtime_error');
      expect(line.textContent).not.toContain('Blocked');
    } finally {
      dom.window.close();
    }
  });

  it('keeps the projection read-only and does not create a second lifecycle authority', () => {
    const source = read('media/chat-sidebar-ui.js');
    expect(source).toContain('checked');
    expect(source).not.toContain("postMessage({ type: 'approveAutonomousDelivery'");
    expect(source).not.toContain("postMessage({ type: 'startAutonomousTask'");
  });
});
