// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { hasAffirmativeMutationIntent } from '../../../core/domain/actionIntent';
import { ExecutionProjection } from '../../ui/executionProjection';

const media = path.join(__dirname, '../../../media');
const read = (name: string) => fs.readFile(path.join(media, name), 'utf8');

const posted: unknown[] = [];

// Each mount runs the script again; drop the previous mount's window listeners so one test's still-active run
// cannot react to the next test's messages.
const messageListeners: EventListenerOrEventListenerObject[] = [];
const nativeAddEventListener = window.addEventListener.bind(window);
window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  if (type === 'message') messageListeners.push(listener);
  nativeAddEventListener(type, listener, options);
}) as typeof window.addEventListener;

async function mount(): Promise<void> {
  for (const listener of messageListeners.splice(0)) window.removeEventListener('message', listener);
  document.body.innerHTML = '<div id="messages"></div><span id="oc-mode"></span><span id="oc-status"></span><select id="mode-select"><option value="chat">c</option></select>';
  posted.length = 0;
  (window as unknown as { __ollamaAgentVsCodeApi: unknown }).__ollamaAgentVsCodeApi = { postMessage: (m: unknown) => posted.push(m), getState: () => ({}), setState: () => undefined };
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => (window as unknown as { __ollamaAgentVsCodeApi: unknown }).__ollamaAgentVsCodeApi;
  (window as unknown as { __pandaBaseUri: string }).__pandaBaseUri = 'vscode-resource://panda';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(await read('chat-dhaaga.js'))();
}

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function snapshot(p: ExecutionProjection) {
  return { type: 'dhaaga', op: 'snapshot', state: p.snapshot() };
}

describe('Kaam ka Dhaaga webview', () => {
  beforeEach(mount);

  it('renders the request as the root and only the stages that happened, with exactly one current node', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'Check and update the README' });
    p.repositoryEvidence(['README.md', 'pyproject.toml']);
    p.toolStarted('c1', 'read_file', { path: 'results.py' });
    send(snapshot(p));
    const section = document.querySelector('.kd-dhaaga')!;
    expect(section.querySelector('.kd-dhaaga-root-text')!.textContent).toBe('Check and update the README');
    const titles = [...section.querySelectorAll('.kd-dhaaga-item:not(.kd-dhaaga-root) .kd-dhaaga-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Repo dekh raha hoon...', 'File padh raha hoon...']);
    expect(section.querySelectorAll('.kd-dhaaga-item.is-current')).toHaveLength(1);
    expect(section.querySelector('.kd-dhaaga-item.is-current')!.getAttribute('data-status')).toBe('active');
    expect(section.querySelector('.kd-dhaaga-live')!.textContent).toContain('Reading results.py');
    expect(section.getAttribute('data-mode')).toBe('saath_kar');
  });

  it('never shows raw tool JSON in the primary text; raw payload sits behind Show details', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    p.toolStarted('c1', 'run_command', { command: 'npm run compile' });
    send(snapshot(p));
    const node = document.querySelector('.kd-dhaaga-item[data-stage="building"]')!;
    expect(node.querySelector('.kd-dhaaga-facts')!.textContent).toBe('· npm run compile'.replace('· ', ''));
    expect(node.querySelector('.kd-dhaaga-title')!.textContent).not.toMatch(/run_command|\{/);
    expect(node.querySelector('.kd-dhaaga-details summary')!.textContent).toBe('Show details');
  });

  it('updates nodes in place from patches without rebuilding existing nodes', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    send(snapshot(p));
    const first = p.toolStarted('c1', 'read_file', { path: 'a.ts' })!;
    send({ type: 'dhaaga', op: 'patch', runId: 'r1', patch: first });
    const li = document.querySelector('.kd-dhaaga-item[data-stage="reading_files"]')!;
    const second = p.toolStarted('c2', 'read_file', { path: 'b.ts' })!;
    send({ type: 'dhaaga', op: 'patch', runId: 'r1', patch: second });
    expect(document.querySelector('.kd-dhaaga-item[data-stage="reading_files"]')).toBe(li);
    expect(li.querySelector('.kd-dhaaga-facts')!.textContent).toBe('a.tsb.ts');
  });

  it('asks the host to resync when a patch skips a revision', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    send(snapshot(p));
    p.toolStarted('c1', 'read_file', { path: 'a.ts' });
    const skipped = p.toolStarted('c2', 'read_file', { path: 'b.ts' })!;
    send({ type: 'dhaaga', op: 'patch', runId: 'r1', patch: skipped });
    expect(posted).toContainEqual({ type: 'dhaagaResync', runId: 'r1' });
  });

  it('shows the waiting node with a Review reference and publishes one authoritative current state', () => {
    const events: Array<{ mode: string; phase: string; statusText: string }> = [];
    document.addEventListener('kd:execution-state', (event) => events.push((event as CustomEvent).detail));
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'update README' });
    p.toolStarted('c1', 'propose_text_edit', { path: 'README.md' });
    p.approvalRequested();
    send(snapshot(p));
    const waiting = document.querySelector('.kd-dhaaga-item[data-stage="waiting_approval"]')!;
    expect(waiting.getAttribute('data-status')).toBe('waiting');
    expect(waiting.querySelector('.kd-dhaaga-action button')!.textContent).toBe('Review');
    const last = events[events.length - 1];
    expect(last.mode).toBe('saath_kar');
    expect(last.phase).toBe('waiting_approval');
    expect(last.statusText).toBe('Waiting for your approval');
    expect((window as unknown as { __kdExecutionState: { modeSelector: string } }).__kdExecutionState.modeSelector).toBe('agent');
  });

  it('renders branches attached to the delegating parent', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'karke_dikha', request: 'x' });
    p.branch('Parallel work', { id: 'a', label: 'HTML restructuring', status: 'done' });
    p.branch('Parallel work', { id: 'b', label: 'UI validation', status: 'active' });
    send(snapshot(p));
    const parent = document.querySelector('.kd-dhaaga-item[data-stage="delegated"]')!;
    const branches = [...parent.querySelectorAll('.kd-dhaaga-branch')];
    expect(branches.map((b) => b.getAttribute('data-status'))).toEqual(['done', 'active']);
    expect(branches[0].querySelector('.kd-dhaaga-branch-label')!.textContent).toBe('HTML restructuring');
  });

  it('removes the live row and the animated tail once the run is terminal', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    p.toolStarted('c1', 'read_file', { path: 'a.ts' });
    p.terminal('completed');
    send(snapshot(p));
    const section = document.querySelector('.kd-dhaaga')!;
    expect(section.getAttribute('data-active')).toBe('false');
    expect((section.querySelector('.kd-dhaaga-live') as HTMLElement).hidden).toBe(true);
    expect(section.querySelector('.kd-dhaaga-item:last-child .kd-dhaaga-title')!.textContent).toBe('Ho gaya boss.');
  });
});

describe('Kaam ka Dhaaga styles', () => {
  it('encodes the connector state semantics, branch connectors and reduced motion', async () => {
    const css = await read('chat-dhaaga.css');
    for (const status of ['queued', 'active', 'delegated', 'waiting', 'done', 'failed', 'cancelled']) {
      expect(css).toContain(`.kd-dhaaga-item[data-status="${status}"]`);
    }
    expect(css).toMatch(/\[data-status="queued"\]::after \{ border-left-style: dashed/);
    expect(css).toContain('.kd-dhaaga-branch::before');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
    // The pinned actionable card is the same DOM object the thread points at: sticky, not a duplicate.
    expect(css).toContain('position: sticky');
    expect(css).toContain('.mode-change-card:not(.resolved)');
  });
});

describe('mode contract: Baat Kar mutation intent', () => {
  it('flags the observed request as an edit request, and leaves questions alone', () => {
    expect(hasAffirmativeMutationIntent('Check and update the README with missing info')).toBe(true);
    expect(hasAffirmativeMutationIntent('What would you change in the README?')).toBe(false);
    expect(hasAffirmativeMutationIntent('How does model routing work?')).toBe(false);
  });
});

describe('trivial Baat Kar and single-source status', () => {
  beforeEach(mount);

  it('shows no card for plain Baat Kar and keeps the legacy thinking indicator', () => {
    const p = new ExecutionProjection({ runId: 'b1', mode: 'baat_kar', request: 'What is 2+2?' });
    p.terminal('completed');
    send(snapshot(p));
    expect((document.querySelector('.kd-dhaaga') as HTMLElement).hidden).toBe(true);
    expect(document.body.classList.contains('kd-dhaaga-active')).toBe(false);
    // The authoritative state is still published, so status never goes stale.
    expect((window as unknown as { __kdExecutionState: { phase: string } }).__kdExecutionState.phase).toBe('completed');
  });

  it('shows the card as soon as Baat Kar does real repository work', () => {
    const p = new ExecutionProjection({ runId: 'b2', mode: 'baat_kar', request: 'Is the readme up to date?' });
    send(snapshot(p));
    expect((document.querySelector('.kd-dhaaga') as HTMLElement).hidden).toBe(true);
    const patch = p.repositoryEvidence(['README.md', 'package.json'])!;
    send({ type: 'dhaaga', op: 'patch', runId: 'b2', patch });
    expect((document.querySelector('.kd-dhaaga') as HTMLElement).hidden).toBe(false);
    expect(document.body.classList.contains('kd-dhaaga-active')).toBe(true);
  });

  it('never hides the card for Saath Kar or Karke Dikha', () => {
    const p = new ExecutionProjection({ runId: 's1', mode: 'saath_kar', request: 'hi' });
    send(snapshot(p));
    expect((document.querySelector('.kd-dhaaga') as HTMLElement).hidden).toBe(false);
  });

  it('no longer renders the legacy work-state card, and loads the Dhaaga stylesheet', async () => {
    const dashboard = await read('chat-dashboard.js');
    expect(dashboard).not.toContain("createElement('section')");
    expect(dashboard).not.toContain('Reading your request and repository context');
    expect(dashboard).not.toMatch(/messages\.dataset\.kdWorkState\s*=/);
    const html = await read('chat.html');
    expect(html).toContain('data-layout-fixes="chat-dhaaga.css"');
    expect(html).toContain("querySelectorAll('[data-layout-fixes]')");
  });

  it('publishes blocked and needs-input endings as terminal, never as Working or Completed', () => {
    const w = window as unknown as { __kdExecutionState: { phase: string; active: boolean; statusText: string } };
    const blocked = new ExecutionProjection({ runId: 'x1', mode: 'baat_kar', request: 'count files in each project' });
    blocked.repositoryFacts({ recognised: 3, computing: 'Counting tracked files by project' });
    send(snapshot(blocked));
    expect(w.__kdExecutionState.active).toBe(true);
    send({ type: 'dhaaga', op: 'patch', runId: 'x1', patch: blocked.terminal('blocked', 'The repository information needed was not obtained') });
    expect(w.__kdExecutionState).toMatchObject({ phase: 'blocked', active: false, statusText: 'Needs attention' });
    expect(document.querySelector('.kd-dhaaga')!.getAttribute('data-phase')).toBe('blocked');
    expect(document.querySelector('.kd-dhaaga-item[data-stage="blocked"] .kd-dhaaga-title')!.textContent).toBe('Ruk gaya...');
    expect([...document.querySelectorAll('.kd-dhaaga-item[data-stage="computing"] .kd-dhaaga-title')].map(n => n.textContent)).toEqual(['Hisab kar raha hoon...']);
    expect(document.querySelector('.kd-dhaaga-item[data-stage="reading_files"]')).toBeNull();
  });

  it('transport done never settles an active run as Completed; it recovers the host projection, and error/stopped still settle', () => {
    const w = window as unknown as { __kdExecutionState: { phase: string; active: boolean; statusText: string } };
    const p = new ExecutionProjection({ runId: 'x2', mode: 'saath_kar', request: 'x' });
    p.toolStarted('c1', 'read_file', { path: 'a.ts' });
    send(snapshot(p));
    expect(w.__kdExecutionState.active).toBe(true);
    // The terminal patch has not arrived (webview recreated mid-run, or more approved work is still to come): the
    // turn's transport `done` cannot say the objective was met. It asks the host for the authoritative projection.
    send({ type: 'done', content: 'ok' });
    expect(w.__kdExecutionState).toMatchObject({ phase: 'running', active: true });
    expect(posted).toContainEqual({ type: 'dhaagaResync', runId: 'x2' });
    // An error or a stop ends the turn for certain, so the header must not keep saying Working.
    send({ type: 'stopped' });
    expect(w.__kdExecutionState).toMatchObject({ phase: 'cancelled', active: false });
    expect(document.querySelector('.kd-dhaaga')!.getAttribute('data-active')).toBe('false');
    expect((document.querySelector('.kd-dhaaga-live') as HTMLElement).hidden).toBe(true);
  });

  it('does not overwrite an authoritative blocked ending when the done message follows', () => {
    const w = window as unknown as { __kdExecutionState: { phase: string } };
    const p = new ExecutionProjection({ runId: 'x3', mode: 'baat_kar', request: 'x' });
    p.repositoryFacts({ recognised: 2 });
    send(snapshot(p));
    send({ type: 'dhaaga', op: 'patch', runId: 'x3', patch: p.terminal('needs_input', 'Waiting for your answer') });
    send({ type: 'done', content: 'Which project do you mean?' });
    expect(w.__kdExecutionState.phase).toBe('needs_input');
  });

  it('never lets the legacy INVESTIGATING / WORKING banners render, however the DOM looks after a restore', async () => {
    const css = await read('chat-dhaaga.css');
    expect(css).toMatch(/#messages#messages::before[\s\S]{0,120}\{\s*content: none !important;\s*display: none !important;/);
    const sidebar = await read('chat-sidebar-ui.js');
    expect(sidebar).toMatch(/message\.type === 'restoreTranscript'[\s\S]{0,400}statusFlags\.running = false/);
  });

  it('lets the execution projection override the legacy status flags', async () => {
    const sidebar = await read('chat-sidebar-ui.js');
    expect(sidebar).toMatch(/if \(run && run\.runId\) \{[\s\S]*run\.phase === 'completed'\) return 'Completed'/);
    const operator = await read('chat-operator-context.js');
    expect(operator).toMatch(/kd:status-changed[\s\S]{0,200}if \(state\.run && state\.run\.runId !== state\.staleRunId\) return;/);
  });
});
