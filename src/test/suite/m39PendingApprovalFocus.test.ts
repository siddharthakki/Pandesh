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

function setupWebview() {
  const dom = new JSDOM(read('media/chat.html'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://karkedikha.test/',
  });
  const { window } = dom;
  const posted: Array<Record<string, unknown>> = [];
  const scrolled: Array<{ id: string; options?: ScrollIntoViewOptions }> = [];
  const focused: string[] = [];
  let state: Record<string, unknown> = {};

  Object.defineProperty(window, '__ollamaAgentVsCodeApi', {
    value: {
      postMessage(message: Record<string, unknown>) { posted.push(message); },
      getState() { return state; },
      setState(next: Record<string, unknown>) { state = next; },
    },
  });
  Object.defineProperty(window, '__pandaBaseUri', { value: '' });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'TextDecoder', { value: TextDecoder });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });

  const nativeFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function focus() {
    focused.push(this.id);
    nativeFocus.call(this);
  };
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options?: ScrollIntoViewOptions) {
    scrolled.push({ id: this.id, options });
  };

  window.eval(read('media/chat-autonomous.js'));
  window.eval(read('media/chat-sidebar-ui.js'));
  return { dom, window, posted, scrolled, focused };
}

describe('M39 pending approval viewport priority', () => {
  it('removes the nested-scroll trap, aligns the pending card to the viewport end, and focuses its primary action', () => {
    const { dom, window, scrolled, focused } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      send(window, { type: 'deliveryApprovalRequest', taskId: 'task-1', attemptId: 'attempt-1' });

      const card = window.document.getElementById('delivery-approval-card')!;
      const timeline = card.parentElement as HTMLElement;
      const actions = card.querySelector('.autonomous-actions') as HTMLElement;

      expect(card.dataset.inlineApprovalState).toBe('pending');
      expect(timeline.dataset.pendingActionVisible).toBe('true');
      expect(timeline.style.maxHeight).toBe('none');
      expect(timeline.style.overflowY).toBe('visible');
      expect(actions.style.position).toBe('sticky');
      expect(actions.style.bottom).toBe('0px');
      expect(scrolled).toContainEqual(expect.objectContaining({
        id: 'delivery-approval-card',
        options: expect.objectContaining({ block: 'end' }),
      }));
      expect(window.document.activeElement?.id).toBe('delivery-approve-btn');
      expect(focused.filter(id => id === 'delivery-approve-btn')).toHaveLength(1);

      // Status polling and a duplicate request must not repeatedly steal focus.
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'waiting_for_delivery_approval',
      });
      send(window, { type: 'deliveryApprovalRequest', taskId: 'task-1', attemptId: 'attempt-1' });
      expect(focused.filter(id => id === 'delivery-approve-btn')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it('restores normal timeline scrolling after the gate is resolved', () => {
    const { dom, window, focused } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      send(window, { type: 'deliveryApprovalRequest', taskId: 'task-1', attemptId: 'attempt-1' });

      const card = window.document.getElementById('delivery-approval-card')!;
      const timeline = card.parentElement as HTMLElement;
      const actions = card.querySelector('.autonomous-actions') as HTMLElement;
      expect(timeline.style.maxHeight).toBe('none');

      send(window, { type: 'deliveryApprovalResolved', taskId: 'task-1', decision: 'approved' });

      expect(card.dataset.inlineApprovalState).toBe('resolved');
      expect(timeline.dataset.pendingActionVisible).toBeUndefined();
      expect(timeline.style.maxHeight).toBe('');
      expect(timeline.style.overflowY).toBe('');
      expect(actions.style.position).toBe('');
      expect(actions.style.bottom).toBe('');
      expect(focused.filter(id => id === 'delivery-approve-btn')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it('keeps approval authority in chat-autonomous and limits the sidebar correction to presentation', () => {
    const source = read('media/chat-sidebar-ui.js');
    expect(source).toContain("document.querySelector('[data-inline-approval-state=\"pending\"]:not([hidden])')");
    expect(source).toContain("block: 'end'");
    expect(source).toContain('primary.focus({ preventScroll: true })');
    expect(source).not.toContain("postMessage({ type: 'approve");
    expect(source).not.toContain("postMessage({ type: 'reject");
  });
});
