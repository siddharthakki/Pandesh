/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConversationOpenResult, ConversationRailEntryView, ConversationSearchResultView, DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents, eventFromSummary, RECORDED_START } from './recordedMissionStream';

declare global {
  interface Window {
    karkedikhaDesktop: {
      getSnapshot: () => Promise<DesktopSnapshot | null>;
      pickFolder: () => Promise<DesktopSnapshot | null>;
      submitTask: (goal: string, worker?: string) => Promise<{ requestId: string; attemptId: string; model: string }>;
      continueTask: (predecessorAttemptId: string, guidance: string) => Promise<{ requestId: string; attemptId: string; model: string }>;
      cancel: () => Promise<void>;
      resolveApproval: (approvalId: string, resolution: string) => Promise<void>;
      setOpenRouterApiKey: (apiKey: string) => Promise<{ keyConfigured: boolean }>;
      clearOpenRouterApiKey: () => Promise<{ keyConfigured: boolean }>;
      selectProvider: (provider: 'ollama' | 'openrouter') => Promise<DesktopSnapshot | null>;
      selectWorker: (worker: string) => Promise<DesktopSnapshot | null>;
      listModels: () => Promise<string[]>;
      selectModel: (model: string) => Promise<DesktopSnapshot | null>;
      transcribeUtterance: (wavBase64: string) => Promise<{ transcript: string; engine: string }>;
      getHostTelemetry: () => Promise<unknown>;
      onEvent: (listener: (event?: unknown) => void) => () => void;
      listConversations: (includeArchived?: boolean) => Promise<ConversationRailEntryView[]>;
      openConversation: (conversationId: string) => Promise<ConversationOpenResult>;
      newConversation: () => Promise<void>;
      renameConversation: (conversationId: string, title: string) => Promise<ConversationRailEntryView[]>;
      pinConversation: (conversationId: string) => Promise<ConversationRailEntryView[]>;
      unpinConversation: (conversationId: string) => Promise<ConversationRailEntryView[]>;
      archiveConversation: (conversationId: string) => Promise<ConversationRailEntryView[]>;
      unarchiveConversation: (conversationId: string) => Promise<ConversationRailEntryView[]>;
      searchConversations: (query: string) => Promise<ConversationSearchResultView[]>;
      exportConversation?: (conversationId: string) => Promise<{ saved: boolean; path: string | null }>;
      listArtifacts?: () => Promise<import('../src/ipc').DesktopArtifactView[]>;
      loadArtifactPreview?: (artifactId: string) => Promise<import('../src/ipc').DesktopArtifactPreview>;
      openArtifactFolder?: (artifactId: string) => Promise<{ opened: boolean }>;
      saveArtifactCopy?: (artifactId: string) => Promise<{ saved: boolean; path: string | null }>;
      probeImageStudio?: () => Promise<import('../src/ipc').DesktopImageStudioStatus>;
      generateImage?: (input: Record<string, unknown>) => Promise<import('../src/ipc').DesktopImageGenerationResult>;
      resolveImageApproval?: (approvalId: string, resolution: import('../src/ipc').DesktopApprovalResolution) => Promise<import('../src/ipc').DesktopImageGenerationResult>;
      cancelImageGeneration?: () => Promise<void>;
    };
    jarvisVoiceCapture: {
      startPushToTalkCapture: () => { stop: () => Promise<Uint8Array | null>; cancel: () => void };
      bytesToBase64: (bytes: Uint8Array) => string;
    };
  }
}

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
const listeners: Array<() => void> = [];

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  window.jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({
      stop: async () => null,
      cancel: () => undefined,
    }),
    bytesToBase64: () => '',
  };
  window.karkedikhaDesktop = {
    getSnapshot: async () => currentSnapshot,
    pickFolder: async () => currentSnapshot,
    submitTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    continueTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    cancel: async () => undefined,
    resolveApproval: async () => undefined,
    setOpenRouterApiKey: async () => ({ keyConfigured: true }),
    clearOpenRouterApiKey: async () => ({ keyConfigured: false }),
    selectProvider: async () => currentSnapshot,
    selectWorker: async () => currentSnapshot,
    listModels: async () => ['qwen2.5-coder:1.5b'],
    selectModel: async () => currentSnapshot,
    transcribeUtterance: async () => ({ transcript: 'mock', engine: 'whisper' }),
    getHostTelemetry: async () => currentSnapshot?.hostTelemetry ?? null,
    onEvent: (listener: () => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    listConversations: async () => [],
    openConversation: async (conversationId: string) => ({
      conversation: {
        id: conversationId, title: null, preview: null, state: 'active', repositoryName: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null, pinnedAt: null,
      },
      messages: [],
      context: { state: 'no_workspace', repositoryName: null, objective: null, latestUserIntent: null, executionPolicy: null, pendingAction: null, relevantFiles: [], relevantSymbols: [], constraints: [], findings: null, validation: null, attachmentNames: [], citationCount: 0, researchSourceCount: 0, messageCount: 0, updatedAt: new Date().toISOString() },
    }),
    newConversation: async () => undefined,
    renameConversation: async () => [],
    pinConversation: async () => [],
    unpinConversation: async () => [],
    archiveConversation: async () => [],
    unarchiveConversation: async () => [],
    searchConversations: async () => [],
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

async function paint(snapshot: DesktopSnapshot): Promise<void> {
  currentSnapshot = snapshot;
  for (const listener of listeners) listener();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Jarvis control center renderer', () => {
  it('starts idle with Talk to Jarvis and mic off', async () => {
    const snap = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }));
    await paint(snap);
    expect(document.querySelector('.brand')?.textContent).toBe('J.A.R.V.I.S.');
    expect(document.body.textContent || '').not.toMatch(/Mark\s*VII|MARK-VII PROTOCOL/i);
    const versionBadge = document.getElementById('app-version-badge');
    expect(versionBadge?.hidden).toBe(true);
    expect(versionBadge?.textContent || '').toBe('');
    expect(document.getElementById('jarvis-state-label')?.textContent).toBe('Idle');
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('idle');
    expect(document.getElementById('mic-button')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById('mic-hint')?.textContent).toMatch(/tap the mic/i);
    expect(document.getElementById('task-input')).toBeTruthy();
    expect(document.querySelector('.three-col')).toBeTruthy();
    expect(document.querySelector('.reactor-core')).toBeTruthy();
  });

  it('enters listening only after explicit mic press and never claims always-on', async () => {
    const snap = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }));
    await paint(snap);
    document.getElementById('mic-button')?.click();
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('listening');
    expect(document.getElementById('mic-button')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('mic-hint')?.textContent).toMatch(/Listening|Stop listening/i);
    document.getElementById('mic-button')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('idle');
    }, { timeout: 2000 });
  });

  it('maps running missions to working and terminal outcomes to completed', async () => {
    await paint(desktopSnapshotFromEvents([], cockpitInput({ running: true, terminal: false })));
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('working');

    const terminal = desktopSnapshotFromEvents([
      eventFromSummary('Final answer from Core conversation', RECORDED_START, {
        kind: 'result',
        text: 'Verified local answer.',
      }),
    ], cockpitInput({ running: false, terminal: true }));
    await paint(terminal);
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('completed');
    expect(document.getElementById('result')?.textContent).toContain('Verified local answer');
  });

  it('keeps OpenRouter not ready and Local Core worker selectable', async () => {
    const snap = desktopSnapshotFromEvents([], cockpitInput());
    await paint(snap);
    expect(document.getElementById('openrouter-status')?.textContent).toMatch(/not ready/i);
    const worker = document.getElementById('worker-select') as HTMLSelectElement | null;
    expect(worker).toBeTruthy();
    expect(Array.from(worker!.options).some((option) => option.value === 'local-core')).toBe(true);
    expect(Array.from(worker!.options).some((option) => option.value === 'autonomous-mission')).toBe(true);
  });

  it('offers Core-owned Auto routing ahead of installed Ollama models', async () => {
    const snap = desktopSnapshotFromEvents([], cockpitInput(), {
      modelIsAuto: true,
      model: 'qwen3.8:27b-mtp-q4_K_M',
      installedModels: ['qwen3.8:27b-mtp-q4_K_M', 'jarvis-qwen3.8:27b-gsq'],
    });
    await paint(snap);
    const picker = document.getElementById('model-select') as HTMLSelectElement;
    expect(picker.options[0].value).toBe('__auto__');
    expect(picker.options[0].textContent).toBe('Auto (recommended)');
    expect(picker.value).toBe('__auto__');
  });

  it('puts token and cost metrics behind progressive disclosure', async () => {
    await paint(desktopSnapshotFromEvents([], cockpitInput()));
    const diagnostics = document.getElementById('diagnostics') as HTMLDetailsElement;
    expect(diagnostics.open).toBe(false);
    expect(document.getElementById('cockpit-prompt-tokens')).toBeTruthy();
    expect(document.getElementById('cockpit-cost')).toBeTruthy();
  });

  it('renders real host telemetry and Not connected connectors without fabricating content', async () => {
    const telemetry = {
      collectedAt: '2026-09-15T09:00:00.000Z',
      clock: { iso: '2026-09-15T09:00:00.000Z', localTime: '11:00:00', timeZone: 'Europe/Berlin' },
      cpu: { value: 12, unit: '%', detail: '24 logical processors', available: true, model: 'Test CPU', cores: 24 },
      memory: { available: true, usedBytes: 32 * 1024 ** 3, totalBytes: 64 * 1024 ** 3, usedPercent: 50 },
      disk: {
        available: true,
        mount: 'C:\\',
        freeBytes: 100 * 1024 ** 3,
        totalBytes: 500 * 1024 ** 3,
        usedPercent: 80,
        blocker: '',
      },
      gpu: {
        available: false,
        name: null,
        usagePercent: null,
        temperatureC: null,
        vramUsedBytes: null,
        vramTotalBytes: null,
        blocker: 'Windows did not expose GPU utilization',
      },
      ollama: {
        reachable: false,
        apiBase: 'http://127.0.0.1:11434',
        detail: 'Ollama unreachable: fetch failed',
      },
      repository: {
        available: true,
        branch: 'dev/current',
        dirty: true,
        changedFileCount: 3,
        blocker: '',
      },
      connectors: [
        { id: 'weather' as const, label: 'Weather', status: 'not_connected' as const, detail: 'No weather connector configured.' },
        { id: 'news' as const, label: 'News', status: 'not_connected' as const, detail: 'No news connector configured.' },
        { id: 'email' as const, label: 'Email', status: 'not_connected' as const, detail: 'No email connector configured.' },
        { id: 'calendar' as const, label: 'Calendar', status: 'not_connected' as const, detail: 'No calendar connector configured.' },
      ],
    };
    await paint(desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), {
      hostTelemetry: telemetry,
      folder: 'C:\\Projects\\ollama-agent',
      taskScope: {
        repository: 'ollama-agent',
        permittedActions: ['read_file'],
        deliveryDestination: 'local git commit',
        pushAuthorized: false,
        authorized: true,
      },
    }));
    expect(document.getElementById('host-clock')?.textContent).toBe('11:00:00');
    expect(document.getElementById('host-timezone')?.textContent).toBe('Europe/Berlin');
    expect(document.getElementById('telem-cpu')?.textContent).toBe('12%');
    expect(document.getElementById('telem-memory')?.textContent).toMatch(/50%/);
    expect(document.getElementById('telem-disk')?.textContent).toMatch(/free/i);
    expect(document.getElementById('telem-disk-detail')?.textContent).toMatch(/80%/);
    expect(document.getElementById('telem-gpu')?.textContent).toBe('Unavailable');
    expect(document.getElementById('telem-vram')?.textContent).toBe('Unavailable');
    expect(document.getElementById('telem-ollama-status')?.textContent).toBe('Disconnected');
    expect(document.getElementById('telem-ollama-endpoint')?.textContent).toMatch(/Unavailable/);
    expect(document.getElementById('repo-name')?.textContent).toBe('ollama-agent');
    expect(document.getElementById('repo-branch')?.textContent).toBe('dev/current');
    expect(document.getElementById('repo-dirty')?.textContent).toBe('Dirty');
    expect(document.getElementById('repo-changed')?.textContent).toBe('3');
    expect(document.getElementById('mission-phase-brief')?.textContent).toBeTruthy();
    expect(document.querySelector('.weather-panel')?.textContent).toMatch(/Not connected/i);
    for (const state of Array.from(document.querySelectorAll('#connector-list .conn-state'))) {
      expect(state.textContent).toBe('Not connected');
    }
  });
});
