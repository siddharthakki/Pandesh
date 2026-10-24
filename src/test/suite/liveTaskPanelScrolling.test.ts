import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
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
  const posted: Array<Record<string, unknown>> = [];
  const scrolled: string[] = [];
  let state: Record<string, unknown> = {};

  const vscodeApi = {
    postMessage(message: Record<string, unknown>) { posted.push(message); },
    getState() { return state; },
    setState(next: Record<string, unknown>) { state = next; },
  };
  Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: vscodeApi });
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
  style.textContent = `${read('media/chat.css')}\n${read('media/chat-layout-fixes.css')}`;
  window.document.head.appendChild(style);
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this.id || this.tagName);
  };

  window.eval(read('media/chat-fixes.js'));
  window.eval(read('media/chat-dashboard.js'));
  window.eval(read('media/chat-operations.js'));
  window.eval(read('media/chat-autonomous.js'));
  window.eval(read('media/chat-sidebar-ui.js'));
  window.eval(read('media/everyday-presentation.js'));
  window.eval(read('media/chat-everyday.js'));
  send(window, { type: 'workspaceRestorationResolved', workspaceIdentity: 'test-workspace' });
  return { dom, window, posted, scrolled };
}

function mockMessagesScroll(window: JSDOM['window'], initialScrollHeight = 900) {
  const el = window.document.getElementById('messages') as HTMLElement;
  let scrollHeight = initialScrollHeight;
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  return {
    el,
    grow(px: number) { scrollHeight += px; },
  };
}

function userScroll(el: HTMLElement, top: number): void {
  el.dispatchEvent(new el.ownerDocument.defaultView!.WheelEvent('wheel', { deltaY: -80, bubbles: true }));
  el.scrollTop = top;
  el.dispatchEvent(new el.ownerDocument.defaultView!.Event('scroll'));
}

describe('live task panel scrolling', () => {
  it('keeps the production timeline inside #kd-task-details instead of a second nested Details panel', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      await settle();

      const timeline = window.document.getElementById('autonomous-timeline');
      const details = window.document.getElementById('kd-task-details');
      expect(details?.contains(timeline)).toBe(true);
      expect(window.document.getElementById('autonomous-technical-details')).toBeNull();
      expect(window.document.querySelectorAll('#task-request-entry details')).toHaveLength(0);
      expect(window.document.querySelectorAll('.kd-task-message details#kd-task-details')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it('updates progress in place, preserves Details, and pins to latest until the user scrolls up', async () => {
    const { dom, window, scrolled } = setupWebview();
    try {
      const scroller = mockMessagesScroll(window);
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        goal: 'Investigate the delivery classification',
        events: [{ eventId: 'e1', seq: 1, renderedProgress: 'Reading src/activation/M15AutonomousRuntime.ts' }],
      });
      await settle();

      const details = window.document.getElementById('kd-task-details') as HTMLDetailsElement;
      const timeline = window.document.getElementById('autonomous-timeline')!;
      const jump = window.document.getElementById('kd-jump-latest') as HTMLButtonElement;
      details.open = true;
      const firstEntry = timeline.querySelector('.autonomous-timeline-entry');
      expect(firstEntry).toBeTruthy();
      expect(jump.hidden).toBe(true);
      expect(scroller.el.scrollTop).toBe(scroller.el.scrollHeight);
      expect(scrolled).not.toContain('autonomous-status');

      scroller.grow(240);
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [
          { eventId: 'e1', seq: 1, renderedProgress: 'Reading src/activation/M15AutonomousRuntime.ts' },
          { eventId: 'e2', seq: 2, renderedProgress: 'Searching classifyRuntimeError in src/activation' },
        ],
      });
      await settle();

      expect(details.open).toBe(true);
      expect(timeline.querySelector('.autonomous-timeline-entry')).toBe(firstEntry);
      expect(timeline.querySelectorAll('.autonomous-timeline-entry').length).toBeGreaterThanOrEqual(3);
      expect(scroller.el.scrollTop).toBe(scroller.el.scrollHeight);
      expect(jump.hidden).toBe(true);

      userScroll(scroller.el, 70);
      expect(jump.hidden).toBe(false);
      const frozenTop = scroller.el.scrollTop;

      scroller.grow(180);
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [
          { eventId: 'e3', seq: 3, renderedProgress: 'Reading core/domain/approvals.ts 1-80' },
        ],
      });
      await settle();

      expect(details.open).toBe(true);
      expect(scroller.el.scrollTop).toBe(frozenTop);
      expect(jump.hidden).toBe(false);
      expect(scrolled.filter(id => id === 'autonomous-status')).toHaveLength(0);

      jump.click();
      await settle();
      expect(scroller.el.scrollTop).toBe(scroller.el.scrollHeight);
      expect(jump.hidden).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('binds timeline activity to the current task/attempt and ignores stale snapshots', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [{ eventId: 'e1', seq: 1, renderedProgress: 'Current-attempt read' }],
      });
      await settle();

      send(window, {
        type: 'autonomousRetryStarted',
        taskId: 'task-1',
        attemptId: 'attempt-2',
        predecessorAttemptId: 'attempt-1',
        message: 'Retrying with cloud recovery',
      });
      await settle();

      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'running',
        events: [{ eventId: 'stale', seq: 99, renderedProgress: 'STALE-ATTEMPT-CONTENT' }],
      });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-other',
        attemptId: 'attempt-9',
        state: 'running',
        events: [{ eventId: 'other', seq: 1, renderedProgress: 'STALE-TASK-CONTENT' }],
      });
      await settle();

      const timeline = window.document.getElementById('autonomous-timeline')!;
      expect(timeline.textContent).not.toContain('STALE-ATTEMPT-CONTENT');
      expect(timeline.textContent).not.toContain('STALE-TASK-CONTENT');
      expect(timeline.textContent).not.toContain('Current-attempt read');
      expect(timeline.textContent).toContain('Retrying with cloud recovery');
      expect(window.document.getElementById('autonomous-attempt-id')?.textContent).toContain('attempt-2');
    } finally {
      dom.window.close();
    }
  });

  it('keeps long technical diagnostics collapsible instead of stretching the main progress view', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'blocked',
        failure: { classification: 'validation_failed', message: 'tests failed' },
        validationFailure: {
          commandLabel: 'npm test',
          exitCode: 1,
          durationMs: 1200,
          stdoutStderrTail: `${'error line\n'.repeat(20)}Output tail:\n${'stack\n'.repeat(12)}`,
        },
      });
      await settle();

      const diag = window.document.querySelector('#autonomous-timeline .kd-timeline-diagnostics') as HTMLDetailsElement | null;
      expect(diag).toBeTruthy();
      expect(diag?.open).toBe(false);
      expect(diag?.querySelector('summary')?.textContent).toBe('Technical details');
      expect(diag?.textContent).toContain('Output tail:');
    } finally {
      dom.window.close();
    }
  });

  it('does not relocate the live timeline in chat-fixes.js', () => {
    const source = read('media/chat-fixes.js');
    expect(source).not.toContain('autonomous-technical-details');
    expect(source).not.toContain('createTechnicalDetails');
    expect(source).not.toContain('details.appendChild(timeline)');
  });
});
