/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents } from './recordedMissionStream';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
const listeners: Array<() => void> = [];
const desktopApi: Record<string, (...args: unknown[]) => unknown> = {};

type Gmail = NonNullable<DesktopSnapshot['gmail']>;
const baseGmail: Gmail = {
  connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null,
  connecting: false, clientSource: null, clientHint: null, verified: false, helperStaged: true, recovery: null,
};

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
    connectGmail: vi.fn(async () => baseGmail),
    retryGmailProbe: vi.fn(async () => baseGmail),
    disconnectGmail: vi.fn(async () => baseGmail),
    cancelGoogleConnect: vi.fn(async () => baseGmail),
    saveGoogleOAuthClient: vi.fn(async () => baseGmail),
    openExternalUrl: vi.fn(async () => ({ opened: true })),
  });
  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = desktopApi;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

async function paint(snapshot: DesktopSnapshot): Promise<void> {
  currentSnapshot = snapshot;
  for (const listener of listeners) listener();
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function snap(gmail: Partial<Gmail>, catalog: Array<Record<string, unknown>> = [], extra: Partial<DesktopSnapshot> = {}) {
  const base = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), { installedModels: [], ...extra });
  return {
    ...base,
    gmail: { ...baseGmail, ...gmail },
    everydayTools: { ...(base.everydayTools as object), catalog },
  } as unknown as DesktopSnapshot;
}

const text = (id: string) => document.getElementById(id)?.textContent ?? '';
const hidden = (id: string) => (document.getElementById(id) as HTMLElement | null)?.hidden ?? true;

describe('One assistant workspace', () => {
  it('has a single sidebar (history) and the three top-level sections, with no Home/Conversations duplicate', () => {
    expect(document.querySelectorAll('aside.panda-sidebar').length).toBe(0);
    expect(document.querySelectorAll('.topbar-nav-tabs .nav-tab').length).toBe(3);
    expect(document.getElementById('home-suggestions')).toBeNull();
    expect(document.getElementById('btn-drawer-conversations')).toBeNull();
    expect(document.getElementById('btn-open-workbench')).toBeNull();
  });

  it('shows the large mascot when idle and moves the same mascot element into the header once a conversation is active', async () => {
    await paint(snap({}));
    const anchor = document.getElementById('panda-hero-anchor');
    expect(document.getElementById('assistant-main')?.dataset.mode).toBe('idle');
    expect(anchor?.parentElement?.id).toBe('assistant-hero-slot');
    await paint(snap({}, [], { running: true, task: 'hello' } as Partial<DesktopSnapshot>));
    expect(document.getElementById('assistant-main')?.dataset.mode).toBe('active');
    expect(document.getElementById('panda-hero-anchor')).toBe(anchor);
    expect(anchor?.parentElement?.id).toBe('assistant-mascot-slot');
  });

  it('shows the selected model and the model actually executing without conflating them', async () => {
    await paint(snap({}, [], { running: true, model: 'qwen3-coder:30b', modelIsAuto: true, provider: 'ollama' } as Partial<DesktopSnapshot>));
    expect(text('conv-model-badge')).toBe('Running on qwen3-coder:30b · picked by Auto');
    await paint(snap({}, [], { running: false, model: 'gpt-oss:20b', modelIsAuto: false, provider: 'ollama' } as Partial<DesktopSnapshot>));
    expect(text('conv-model-badge')).toBe('gpt-oss:20b');
    await paint(snap({}, [], { running: false, model: 'gpt-oss:20b', modelIsAuto: true, provider: 'ollama' } as Partial<DesktopSnapshot>));
    expect(text('conv-model-badge')).toContain('Auto');
    expect(text('conv-model-badge')).not.toContain('gpt-oss');
  });

  describe('full-height conversation and history scrolling', () => {
    const css = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');

    it('lifts the 480px cap on the conversation turns region and makes it scroll on its own within the assistant layout', () => {
      expect(css).toMatch(/\.assistant-layout\s+#result:not\(\[hidden\]\)\s*\{[^}]*max-height:\s*none/);
      expect(css).toMatch(/\.assistant-layout\s+#result:not\(\[hidden\]\)\s*\{[^}]*overflow-y:\s*auto/);
    });

    it('lets the conversation history rail list scroll on its own', () => {
      expect(css).toMatch(/\.assistant-layout\s+\.conversations-history-rail\s+#conversations-rail-groups[^{]*\{[^}]*overflow-y:\s*auto/);
    });

    it('keeps the page itself non-scrolling', () => {
      expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/);
    });
  });
});
