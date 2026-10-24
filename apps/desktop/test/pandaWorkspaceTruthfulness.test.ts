/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents } from './recordedMissionStream';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
let taskOverview: { tasks: Array<Record<string, unknown>>; queued: Array<Record<string, unknown>> } = { tasks: [], queued: [] };
const listeners: Array<() => void> = [];
const desktopApi: Record<string, (...args: unknown[]) => unknown> = {};
const newConversation = vi.fn(async () => {
  currentSnapshot = currentSnapshot
    ? ({ ...currentSnapshot, selectedConversationId: null } as DesktopSnapshot)
    : null;
});

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
    onEvent: (listener: () => void) => { listeners.push(listener); return () => undefined; },
    listArtifacts: async () => [],
    listConversations: async () => [],
    searchConversations: async () => ({ results: [] }),
    newConversation,
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
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function snap(extra: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  const base = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), { installedModels: [], ...extra });
  return base;
}

const el = (id: string) => document.getElementById(id) as HTMLElement | null;
const text = (id: string) => el(id)?.textContent ?? '';

describe('a genuinely new conversation', () => {
  it('shows the panda, the suggestions and the composer — and nothing from an earlier task', async () => {
    // A finished task in the conversation the app had open.
    await paint(snap({
      running: false,
      terminal: true,
      attemptId: 'att_old',
      lastTurnOutcome: 'completed',
      activeConversationId: 'conv_old',
      selectedConversationId: 'conv_old',
      task: 'sent with the button',
    } as Partial<DesktopSnapshot>));
    // The conversation is opened, so the pane is showing it.
    await paint(snap({
      running: false,
      attemptId: 'att_old',
      lastTurnOutcome: 'completed',
      activeConversationId: 'conv_old',
      selectedConversationId: 'conv_old',
    } as Partial<DesktopSnapshot>));

    // "+ New" starts an empty conversation.
    el('conversations-new')?.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await paint(snap({
      running: false,
      attemptId: 'att_old',
      lastTurnOutcome: 'completed',
      activeConversationId: 'conv_old',
      selectedConversationId: null,
    } as Partial<DesktopSnapshot>));

    expect(newConversation).toHaveBeenCalled();
    expect(el('workspace-task-card')?.hidden).toBe(true);
    expect(el('conversation-results')?.hidden).toBe(true);
    expect(el('assistant-main')?.dataset.mode).toBe('idle');
  });

  it('keeps the task card for the conversation it belongs to', async () => {
    await paint(snap({
      running: true,
      attemptId: 'att_live',
      activeConversationId: 'conv_live',
      selectedConversationId: 'conv_live',
      task: 'summarise the notes',
    } as Partial<DesktopSnapshot>));
    expect(el('workspace-task-card')?.hidden).toBe(false);
    expect(text('task-card-title')).toBe('summarise the notes');
  });
});

describe('the Tasks screen tells the truth', () => {
  const liveTask = {
    attemptId: 'att_live',
    status: 'running',
    title: 'Summarise the notes',
    worker: 'Pi assistant',
    model: 'qwen3.8:27b',
    activity: 'Running read_file',
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    lastEventAt: new Date(Date.now() - 2_000).toISOString(),
    lastEventType: 'Running read_file',
    elapsedMs: 30_000,
    live: true,
    interrupted: false,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    cancellable: true,
  };
  const staleTask = {
    attemptId: 'att_stale',
    status: 'running',
    title: 'Old task',
    worker: 'Core assistant',
    model: 'qwen3.8:27b',
    activity: 'Interrupted — the worker stopped; this task is not running',
    startedAt: new Date(Date.now() - 18 * 3600_000).toISOString(),
    createdAt: new Date(Date.now() - 18 * 3600_000).toISOString(),
    lastEventAt: new Date(Date.now() - 18 * 3600_000 + 60_000).toISOString(),
    lastEventType: 'attempt transitioned',
    elapsedMs: 60_000,
    live: false,
    interrupted: true,
    leaseExpiresAt: new Date(Date.now() - 18 * 3600_000).toISOString(),
    cancellable: true,
  };

  it('counts only the tasks a worker actually holds as running', async () => {
    taskOverview = { tasks: [liveTask, staleTask], queued: [] };
    document.querySelector('.app')?.setAttribute('data-active-surface', 'tasks');
    const panel = el('active-tasks-panel');
    expect(panel).not.toBeNull();
    // Trigger the panel refresh the same way the surface switch does.
    await (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop.getTaskOverview();
    document.getElementById('btn-refresh-tasks')?.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    const rows = [...document.querySelectorAll('#active-tasks-list .dev-story')] as HTMLElement[];
    expect(rows.length).toBe(2);
    const live = rows.find((r) => r.dataset.attemptId === 'att_live')!;
    const stale = rows.find((r) => r.dataset.attemptId === 'att_stale')!;
    expect(live.dataset.live).toBe('true');
    expect(stale.dataset.live).toBe('false');
    expect(stale.dataset.phase).toBe('interrupted');
    // The stale task keeps the runtime it really had; it does not keep counting.
    expect(stale.textContent).not.toContain('18h');
    expect(stale.textContent).toContain('Interrupted');
    taskOverview = { tasks: [], queued: [] };
  });
});
