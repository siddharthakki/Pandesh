/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents } from './recordedMissionStream';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
let taskOverview: { tasks: Array<Record<string, unknown>>; queued: Array<Record<string, unknown>> } = { tasks: [], queued: [] };
let eventListener: ((event: unknown) => void) | null = null;
const listeners: Array<() => void> = [];
const desktopApi: Record<string, (...args: unknown[]) => unknown> = {};
const newConversation = vi.fn(async () => {
  currentSnapshot = currentSnapshot
    ? ({ ...currentSnapshot, selectedConversationId: null } as DesktopSnapshot)
    : null;
});
const resolveApproval = vi.fn(async () => undefined);

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  (window as unknown as { jarvisVoiceCapture: Record<string, unknown> }).jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({ stop: async () => null, cancel: () => undefined }),
    bytesToBase64: () => '',
  };
  Object.assign(desktopApi, {
    getSnapshot: async () => currentSnapshot,
    pickFolder: async () => currentSnapshot,
    submitTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    cancel: async () => undefined,
    selectWorker: async () => currentSnapshot,
    selectProvider: async () => currentSnapshot,
    listModels: async () => [],
    selectModel: async () => currentSnapshot,
    transcribeUtterance: async () => ({ transcript: '', engine: 'whisper' }),
    getHostTelemetry: async () => null,
    onEvent: (listener: (event: unknown) => void) => {
      eventListener = listener;
      listeners.push(() => listener({ kind: 'state_changed' }));
      return () => undefined;
    },
    listArtifacts: async () => [{
      id: 'art-1',
      title: 'Generated Report',
      description: 'Report summary',
      kind: 'document',
      createdAt: new Date().toISOString(),
      path: '/path/to/report.pdf',
    }],
    listConversations: async () => [
      { id: 'conv-1', title: 'Conversation 1', updatedAt: new Date().toISOString() },
    ],
    searchConversations: async () => ({ results: [] }),
    openConversation: async (id: string) => ({
      id,
      title: 'Conversation 1',
      messages: [
        { role: 'user', content: 'Hello Pandesh' },
        { role: 'assistant', content: 'Hello! How can I help you today?' },
      ],
      context: null,
    }),
    newConversation,
    resolveApproval,
    getTaskOverview: async () => taskOverview,
    cancelTask: async () => ({ requested: true }),
    connectGmail: vi.fn(async () => ({})),
    retryGmailProbe: vi.fn(async () => ({})),
    disconnectGmail: vi.fn(async () => ({})),
    cancelGoogleConnect: vi.fn(async () => ({})),
    saveGoogleOAuthClient: vi.fn(async () => ({})),
    openExternalUrl: vi.fn(async () => ({ opened: true })),
  });
  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = desktopApi;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

async function paint(snapshot: DesktopSnapshot): Promise<void> {
  currentSnapshot = snapshot;
  for (const listener of listeners) listener();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function snap(extra: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  const base = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), { installedModels: [], ...extra });
  return base;
}

const el = (id: string) => document.getElementById(id) as HTMLElement | null;

describe('Issue #75 Regression Tests', () => {
  beforeEach(() => {
    newConversation.mockClear();
    resolveApproval.mockClear();
  });

  it('1. Both New buttons (rail and top-right header) trigger reliable conversation clearing', async () => {
    const btnRail = el('conversations-new');
    const btnHeader = el('btn-new-chat-header');
    expect(btnRail).not.toBeNull();
    expect(btnHeader).not.toBeNull();

    // Populate conversation with turns
    const resultNode = el('result');
    expect(resultNode).not.toBeNull();
    resultNode!.innerHTML = '<p>Old message</p>';
    resultNode!.hidden = false;

    // Test top-right header + New button
    btnHeader!.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(newConversation).toHaveBeenCalledTimes(1);
    expect(resultNode!.hidden).toBe(true);
    expect(resultNode!.childElementCount).toBe(0);
    expect(el('assistant-main')?.dataset.mode).toBe('idle');

    // Populate again
    resultNode!.innerHTML = '<p>Another old message</p>';
    resultNode!.hidden = false;

    // Test rail + New button
    btnRail!.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(newConversation).toHaveBeenCalledTimes(2);
    expect(resultNode!.hidden).toBe(true);
    expect(resultNode!.childElementCount).toBe(0);
    expect(el('assistant-main')?.dataset.mode).toBe('idle');
  });

  it('2. Prevents stale terminal outcomes and previous turn outputs from repopulating in a new conversation', async () => {
    // Start new conversation
    el('btn-new-chat-header')?.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    // Snapshot arrives with terminal outcome from past mission, but selectedConversationId is null
    const pastMissionSnapshot = snap({
      running: false,
      attemptId: 'att_completed',
      lastTurnOutcome: 'completed',
      activeConversationId: 'conv_old',
      selectedConversationId: null,
      task: 'Previous completed task',
      cockpit: {
        ...cockpitInput({ running: false, terminal: true }),
        terminal: true,
        finalOutcome: '### Task Outcome\nThis was completed previously.',
      },
    } as Partial<DesktopSnapshot>);

    await paint(pastMissionSnapshot);

    const resultNode = el('result');
    expect(resultNode!.hidden).toBe(true);
    expect(resultNode!.childElementCount).toBe(0);
    expect(resultNode!.textContent).not.toContain('Task Outcome');
    expect(el('assistant-main')?.dataset.mode).toBe('idle');
  });

  it('3. In-flight token streams do not append to a newly cleared conversation', async () => {
    // Start new conversation
    el('btn-new-chat-header')?.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    // Late token arrives from background / previous turn
    if (eventListener) {
      eventListener({ kind: 'token', attemptId: 'att_stale', text: 'Stale token text' });
    }
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const resultNode = el('result');
    expect(resultNode!.textContent).not.toContain('Stale token text');
    expect(resultNode!.hidden).toBe(true);
  });

  it('4. Tasks and Results are directly accessible through separate tabs without scrolling past history', () => {
    const tabTasks = el('btn-tasks-tab-tasks');
    const tabResults = el('btn-tasks-tab-results');
    const paneTasks = el('tasks-pane-tasks');
    const paneResults = el('tasks-pane-results');

    expect(tabTasks).not.toBeNull();
    expect(tabResults).not.toBeNull();
    expect(paneTasks).not.toBeNull();
    expect(paneResults).not.toBeNull();

    // Default: Tasks tab is active
    expect(tabTasks!.classList.contains('is-active')).toBe(true);
    expect(paneTasks!.hidden).toBe(false);
    expect(paneResults!.hidden).toBe(true);

    // Switch to Results tab
    tabResults!.click();
    expect(tabResults!.classList.contains('is-active')).toBe(true);
    expect(tabTasks!.classList.contains('is-active')).toBe(false);
    expect(paneTasks!.hidden).toBe(true);
    expect(paneResults!.hidden).toBe(false);

    // Switch back to Tasks tab
    tabTasks!.click();
    expect(tabTasks!.classList.contains('is-active')).toBe(true);
    expect(tabResults!.classList.contains('is-active')).toBe(false);
    expect(paneTasks!.hidden).toBe(false);
    expect(paneResults!.hidden).toBe(true);
  });

  it('5. Pending approvals remain visible and actionable above both tabs', async () => {
    const approvalSnapshot = snap({
      pendingApproval: {
        approvalId: 'appr-42',
        toolName: 'shell_execution',
        gate: 'COMMAND',
        detail: 'Run build command',
      },
    } as unknown as Partial<DesktopSnapshot>);

    await paint(approvalSnapshot);

    const approvalsContainer = el('tasks-approvals-container');
    expect(approvalsContainer).not.toBeNull();
    expect(approvalsContainer!.hidden).toBe(false);

    const approveBtn = approvalsContainer!.querySelector('.btn-task-approve') as HTMLButtonElement | null;
    expect(approveBtn).not.toBeNull();
    approveBtn!.click();

    expect(resolveApproval).toHaveBeenCalledWith('appr-42', 'approved');
  });
});
