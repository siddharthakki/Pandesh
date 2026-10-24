import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { shouldBuildRepositoryContext } from '../../agent/ContextAwareAgentRuntime';
import { buildSystemPrompt } from '../../prompts/systemPrompt';
import { requiresWorkspaceForMode } from '../../ui/AgentPanel';

class FakeElement {
  id = '';
  value = '';
  textContent = '';
  title = '';
  type = '';
  className = '';
  hidden = false;
  disabled = false;
  readonly options: Array<{ value: string }> = [];
  readonly children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(private readonly onInsert?: (element: FakeElement) => void) {}

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(element: FakeElement): FakeElement {
    this.children.push(element);
    this.onInsert?.(element);
    return element;
  }

  insertBefore(element: FakeElement, reference: FakeElement | null): FakeElement {
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index >= 0) this.children.splice(index, 0, element);
    else this.children.push(element);
    this.onInsert?.(element);
    return element;
  }

  focus(): void {}

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({
      preventDefault() {},
      stopImmediatePropagation() {},
      target: this,
    });
  }
}

function loadModeController() {
  const sent: unknown[] = [];
  let state: Record<string, unknown> = {};
  const elements = new Map<string, FakeElement>();
  const register = (element: FakeElement) => {
    if (element.id) elements.set(element.id, element);
  };
  const history = new FakeElement();
  history.id = 'history-toggle';
  const toolbar = new FakeElement(register);
  toolbar.appendChild(history);
  elements.set('history-toggle', history);
  elements.set('top-bar-right', toolbar);
  for (const id of ['stop-btn', 'mode-select', 'model-select', 'context-model', 'model-badge', 'user-input']) {
    const element = new FakeElement();
    element.id = id;
    elements.set(id, element);
  }
  const windowListeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  const vscode = {
    postMessage(message: unknown) { sent.push(message); },
    getState() { return state; },
    setState(value: Record<string, unknown>) { state = value; },
  };
  const fakeWindow: Record<string, unknown> = {
    __ollamaAgentVsCodeApi: vscode,
    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
      const current = windowListeners.get(type) ?? [];
      current.push(listener);
      windowListeners.set(type, current);
    },
    dispatchEvent(event: { type?: string; data?: unknown }) {
      for (const listener of windowListeners.get(event.type ?? 'message') ?? []) listener({ data: event.data });
      return true;
    },
  };
  class FakeMessageEvent {
    readonly type: string;
    readonly data: unknown;
    constructor(type: string, init: { data: unknown }) { this.type = type; this.data = init.data; }
  }
  const document = {
    getElementById(id: string) { return elements.get(id) ?? null; },
    createElement() { return new FakeElement(); },
    addEventListener() {},
    querySelector(selector: string) {
      if (selector === '.top-bar-right') return toolbar;
      return null;
    },
  };
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'chat-runtime-fixes.js'), 'utf8');
  vm.runInNewContext(source, {
    window: fakeWindow,
    document,
    MessageEvent: FakeMessageEvent,
    console,
    Object,
    String,
    Array,
    Boolean,
    RegExp,
    Event,
  });
  return {
    sent,
    vscode,
    elements,
    controller: fakeWindow.__karkeDikhaModeController as {
      classifyAutoMode(text: string): { kind: string; mode?: string; draft?: { title: string; acceptanceCriteria: string[] } };
      isLargeRequest(text: string): boolean;
    },
    getState: () => state,
  };
}

describe('KarkeDikha modes', () => {
  it('keeps Baat Kar on the fast no-repository-context path while repository modes remain contextual', () => {
    expect(shouldBuildRepositoryContext('chat')).toBe(false);
    expect(shouldBuildRepositoryContext('ask')).toBe(true);
    expect(shouldBuildRepositoryContext('plan')).toBe(true);
    expect(shouldBuildRepositoryContext('agent')).toBe(true);
  });

  it('gives Baat Kar and Saath Kar distinct, user-facing execution contracts', () => {
    const chat = buildSystemPrompt('/workspace/repo', 'chat');
    expect(chat).toContain('BAAT KAR');
    expect(chat).toContain('friendly, direct conversational assistant');
    expect(chat).toContain('No repository tools');
    expect(chat).not.toContain('Use replace_in_file');

    const agent = buildSystemPrompt('/workspace/repo', 'agent');
    expect(agent).toContain('SAATH KAR');
    expect(agent).toContain('interactive coding partner');
    expect(agent).toContain('approval prompts');
    expect(agent).toContain('do not create hidden worktrees');
  });

  it('makes Auto deterministic and sends mutations only to the governed Karke Dikha confirmation path', () => {
    const harness = loadModeController();
    expect(harness.controller.classifyAutoMode('Hello, how are you?')).toEqual({ kind: 'send', mode: 'chat' });
    expect(harness.controller.classifyAutoMode('list my ollama models')).toEqual({ kind: 'local_models' });
    expect(harness.controller.classifyAutoMode('Inspect package.json and explain the scripts')).toEqual({ kind: 'send', mode: 'ask' });
    expect(harness.controller.classifyAutoMode('Create a plan for improving CI')).toEqual({ kind: 'send', mode: 'plan' });
    expect(harness.controller.classifyAutoMode('Edit package.json and add a script')).toEqual({ kind: 'mutation' });
    expect(harness.controller.classifyAutoMode('explain diff between ram and vram')).toEqual({ kind: 'send', mode: 'chat' });
    expect(harness.controller.classifyAutoMode('explain the git diff')).toEqual({ kind: 'send', mode: 'ask' });
    expect(harness.controller.classifyAutoMode('compare the diff between these files')).toEqual({ kind: 'send', mode: 'ask' });
    const large = harness.controller.classifyAutoMode('Build an end-to-end local assistant platform with API, mobile UI, database, browser integration, multimodal support, tests, CI, and deployment automation.');
    expect(large.kind).toBe('story');
    expect(large.draft?.title).toContain('Build an end-to-end');
    expect(large.draft?.acceptanceCriteria.length).toBeGreaterThan(1);

    harness.vscode.postMessage({
      type: 'classifyAndSend',
      text: 'Inspect package.json and explain the scripts',
      model: 'qwen-local',
      attachments: [],
      conversationId: 'conversation-1',
    });
    expect(harness.sent).toEqual([expect.objectContaining({ type: 'sendMessage', mode: 'ask', model: 'qwen-local' })]);

    harness.vscode.postMessage({
      type: 'classifyAndSend',
      text: 'list my ollama models',
      model: '',
      attachments: [],
      conversationId: 'conversation-1',
    });
    expect(harness.sent.at(-1)).toEqual({
      type: 'listLocalModels',
      text: 'list my ollama models',
      conversationId: 'conversation-1',
    });

    harness.vscode.postMessage({ type: 'confirmAutoMutation', text: 'Edit package.json' });
    expect(harness.sent.at(-1)).toEqual(expect.objectContaining({
      type: 'startAutonomousTask',
      text: 'Edit package.json',
      model: '',
      autonomyMode: 'supervised',
    }));
  });

  it('persists the selected model and keeps autonomous messages out of ordinary AgentRuntime', () => {
    const harness = loadModeController();
    const model = harness.elements.get('model-select')!;
    model.value = 'qwen3-coder:30b';
    model.dispatch('change');
    expect(harness.getState()).toMatchObject({ selectedModel: 'qwen3-coder:30b' });
    expect(harness.elements.get('context-model')?.textContent).toContain('qwen3-coder:30b');

    harness.vscode.postMessage({ type: 'sendMessage', mode: 'autonomous', text: 'Change README' });
    // Task-Scoped Autonomy V1 — see the matching comment above.
    expect(harness.sent.at(-1)).toEqual(expect.objectContaining({
      type: 'startAutonomousTask',
      text: 'Change README',
      model: 'qwen3-coder:30b',
      autonomyMode: 'supervised',
    }));
  });

  it('keeps Baat Kar available without a workspace and blocks only workspace-dependent modes', () => {
    expect(requiresWorkspaceForMode('chat', false)).toBe(false);
    expect(requiresWorkspaceForMode('agent', false)).toBe(true);
    expect(requiresWorkspaceForMode('ask', false)).toBe(true);
    expect(requiresWorkspaceForMode('plan', false)).toBe(true);
    expect(requiresWorkspaceForMode('agent', true)).toBe(false);
  });

  it('shows the local Board action in the primary toolbar', () => {
    const harness = loadModeController();
    const button = harness.elements.get('local-board-toolbar-btn');
    expect(button?.textContent).toBe('Board');
    button?.dispatch('click');
    expect(harness.sent.at(-1)).toEqual({ type: 'openLocalBoard' });
  });

  it('shows a primary New chat action and starts a fresh conversation', () => {
    const harness = loadModeController();
    const button = harness.elements.get('new-conversation-toolbar-btn');
    expect(button?.textContent).toBe('+ New chat');

    button?.dispatch('click');
    expect(harness.sent.at(-1)).toEqual({ type: 'newConversation' });
  });
});
