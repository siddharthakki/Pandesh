import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { JSDOM } from 'jsdom';

/**
 * User Progress Projection: the internal five-stage graph is projected onto the existing lifecycle stepper,
 * one product-owned task line and the existing panda states, without ever outranking approval/terminal truth.
 */
const root = path.join(__dirname, '..', '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function send(window: JSDOM['window'], data: Record<string, unknown>): void {
  window.dispatchEvent(new window.MessageEvent('message', { data }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  // The task line is written on the next animation frame (chat-sidebar-ui.js scheduleLiveProgress).
  await new Promise(resolve => setTimeout(resolve, 60));
}

function setupWebview() {
  const dom = new JSDOM(read('media/chat.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://karkedikha.test/' });
  const { window } = dom;
  const vscodeApi = { postMessage() {}, getState: () => ({}), setState() {} };
  Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: vscodeApi });
  Object.defineProperty(window, 'acquireVsCodeApi', { value: () => vscodeApi });
  Object.defineProperty(window, '__pandaBaseUri', { value: '' });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'TextDecoder', { value: TextDecoder });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  window.eval(read('media/chat-autonomous.js'));
  window.eval(read('media/chat-sidebar-ui.js'));
  window.eval(read('media/everyday-presentation.js'));
  window.eval(read('media/chat-everyday.js'));
  window.eval(read('media/chat-fixes.js'));
  send(window, { type: 'workspaceRestorationResolved', workspaceIdentity: 'test-workspace' });
  return { dom, window };
}

const TASK = 'task-progress-projection';
let seq = 0;
const stage = (name: string, index: number) => ({
  seq: ++seq,
  rawProgress: `graph_stage_started stage=${name} index=${index}/5 model=qwen3-coder provider=ollama`,
  // Host-rendered prose (model/stage wording) that must NOT become the user-facing line.
  renderedProgress: `Stage ${index}/5 — ${name}\nProducing the final proposal that the host can verify and execute (RAW_STAGE_PROSE)`,
  pandaState: 'delegating',
  kind: 'graph_stage_started',
});

function status(window: JSDOM['window'], state: string, events: unknown[], extra: Record<string, unknown> = {}): void {
  send(window, { type: 'autonomousTaskStatus', taskId: TASK, attemptId: TASK, state, goal: 'Add a Duplicate Event feature', autonomyMode: 'supervised', events, ...extra });
}

function view(window: JSDOM['window']) {
  const doc = window.document;
  return {
    step: doc.querySelector('#autonomous-stage-tracker li.is-current')?.textContent?.trim() ?? null,
    line: doc.getElementById('kd-task-line')?.textContent ?? '',
    panda: doc.getElementById('autonomous-panda-label')?.textContent ?? '',
    progress: doc.getElementById('autonomous-conversational-progress')?.textContent ?? '',
    body: doc.body.textContent ?? '',
  };
}

async function start(window: JSDOM['window']) {
  send(window, { type: 'autonomousTaskStarted', taskId: TASK, attemptId: TASK, autonomyMode: 'supervised' });
  status(window, 'running', [{ seq: ++seq, rawProgress: 'graph_execution', renderedProgress: 'Starting the work', kind: 'graph_execution' }]);
  await settle();
}

describe('User Progress Projection (legacy task card)', () => {
  it('Repository Analyst -> Understanding your request, reading activity, reading panda', async () => {
    const { dom, window } = setupWebview();
    try {
      await start(window);
      status(window, 'running', [stage('repository-analyst', 1)]);
      await settle();
      const v = view(window);
      expect(v.step).toBe('Understanding your request');
      expect(v.line).toContain('Reading the existing implementation…');
      expect(v.panda).toBe('reading');
    } finally { dom.window.close(); }
  });

  it('Planner/Implementer/Reviewer/Validator -> Preparing the change with live activity and panda', async () => {
    const { dom, window } = setupWebview();
    try {
      await start(window);
      const expected: Array<[string, number, string, string]> = [
        ['planner', 2, 'Planning the smallest safe change…', 'thinking'],
        ['implementer', 3, 'Preparing the change…', 'working'],
        ['reviewer', 4, 'Reviewing the proposed change…', 'thinking'],
        ['validator', 5, 'Checking the proposed change…', 'working'],
      ];
      for (const [name, index, activity, panda] of expected) {
        status(window, 'running', [stage(name, index)]);
        await settle();
        const v = view(window);
        expect(v.step, name).toBe('Preparing the change');
        expect(v.line, name).toContain(activity);
        expect(v.panda, name).toBe(panda);
      }
      // Reviewer/Validator leave visible milestones instead of a stale "Understanding" card.
      const v = view(window);
      expect(v.progress).toContain('Reviewing the proposed change…');
      expect(v.progress).toContain('Checking the proposed change…');
      expect(v.step).not.toBe('Understanding your request');
    } finally { dom.window.close(); }
  });

  it('the proposal approval gate overrides a stale graph stage', async () => {
    const { dom, window } = setupWebview();
    try {
      await start(window);
      status(window, 'running', [stage('reviewer', 4)]);
      await settle();
      status(window, 'waiting_for_proposal_approval', [], { pandaState: 'waiting_for_delivery_approval' });
      await settle();
      const v = view(window);
      expect(v.step).toBe('Waiting for your approval');
      expect(v.panda).toBe('waiting');
    } finally { dom.window.close(); }
  });

  it('proposal/mutation events end the graph projection so the real lifecycle takes over', async () => {
    const { dom, window } = setupWebview();
    try {
      await start(window);
      status(window, 'running', [stage('validator', 5), { seq: ++seq, rawProgress: 'proposal_ready', kind: 'proposal_ready' }]);
      await settle();
      expect((window as unknown as { __kdGraphStage: { current: () => unknown } }).__kdGraphStage.current()).toBeNull();
      status(window, 'running', [{ seq: ++seq, rawProgress: 'mutating', kind: 'mutating', renderedProgress: 'Applying the approved repository change\nWriting only the approved paths inside the isolated worktree.' }], { resolvedGates: { proposal: true, mutation: true } });
      await settle();
      expect(view(window).step).toBe('Making the change');
    } finally { dom.window.close(); }
  });

  it('terminal and blocked states override graph progress', async () => {
    for (const [state, panda] of [['blocked', 'blocked'], ['completed', 'success']] as const) {
      const { dom, window } = setupWebview();
      try {
        await start(window);
        status(window, 'running', [stage('planner', 2)]);
        await settle();
        status(window, state, [], { pandaState: state === 'completed' ? 'completed' : 'blocked' });
        await settle();
        const v = view(window);
        expect(v.panda, state).toBe(panda);
        expect(v.line, state).not.toContain('Planning the smallest safe change');
      } finally { dom.window.close(); }
    }
  });

  it('never surfaces raw stage/model prose in the task line', async () => {
    const { dom, window } = setupWebview();
    try {
      await start(window);
      status(window, 'running', [stage('reviewer', 4)]);
      await settle();
      expect(view(window).line).not.toContain('RAW_STAGE_PROSE');
      expect(view(window).line).not.toContain('Producing the final proposal');
    } finally { dom.window.close(); }
  });
});
