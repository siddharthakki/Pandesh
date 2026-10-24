/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents, eventFromSummary, RECORDED_START } from './recordedMissionStream';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
const listeners: Array<() => void> = [];
let submitCalls: string[] = [];

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });

  (window as unknown as {
    jarvisVoiceCapture: {
      startPushToTalkCapture: () => { stop: () => Promise<Uint8Array | null>; cancel: () => void };
      bytesToBase64: (bytes: Uint8Array) => string;
    };
    karkedikhaDesktop: Record<string, unknown>;
  }).jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({
      stop: async () => new Uint8Array(128),
      cancel: () => undefined,
    }),
    bytesToBase64: () => 'dGVzdA==',
  };

  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = {
    getSnapshot: async () => currentSnapshot,
    submitTask: async (goal: string) => {
      submitCalls.push(goal);
      return { requestId: 'req-voice', attemptId: 'att-voice', model: 'qwen' };
    },
    transcribeUtterance: async () => ({ transcript: 'What is in package.json?', engine: 'whisper-base.en' }),
    getHostTelemetry: async () => currentSnapshot?.hostTelemetry ?? null,
    cancel: async () => undefined,
    onEvent: (listener: () => void) => {
      listeners.push(listener);
      return () => undefined;
    },
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

function idleSnap(extra: Partial<DesktopSnapshot> = {}) {
  return desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), {
    installedModels: ['qwen3.8:27b-mtp-q4_K_M'],
    ...extra,
  });
}

describe('Jarvis voice experience polish', () => {
  it('keeps the primary voice surface to one mic and hides diagnostics in voice settings', async () => {
    await paint(idleSnap());
    expect(document.getElementById('mic-button')).toBeTruthy();
    expect(document.getElementById('mic-toggle-btn')).toBeNull();
    expect(document.getElementById('mic-hint')?.textContent).toMatch(/tap the mic/i);
    const settings = document.getElementById('voice-settings') as HTMLDetailsElement | null;
    expect(settings).toBeTruthy();
    expect(settings?.open ?? false).toBe(false);
    expect(settings?.textContent).toContain('Wake diagnostics');
  });

  it('shows a live transcript near the composer after Whisper returns', async () => {
    submitCalls = [];
    await paint(idleSnap());
    document.getElementById('mic-button')?.click();
    expect(document.getElementById('voice-transcript')?.textContent).toMatch(/Listening/i);
    document.getElementById('mic-button')?.click();
    await vi.waitFor(() => {
      expect(document.getElementById('voice-transcript')?.textContent).toMatch(/What is in package\.json/i);
    }, { timeout: 2000 });
    expect(document.getElementById('voice-transcript')?.hasAttribute('hidden')).toBe(false);
  });

  it('keeps authorization collapsed and collapses long repository paths', async () => {
    const longPath = 'C:\\Projects\\very\\long\\nested\\workspace\\path\\voice-experience-fixture';
    await paint(idleSnap({
      folder: longPath,
      taskScope: {
        repository: 'voice-experience-fixture',
        permittedActions: ['read_file', 'search', 'answer'],
        deliveryDestination: 'local git commit',
        pushAuthorized: false,
        authorized: true,
      },
    }));
    const scope = document.getElementById('task-scope') as HTMLDetailsElement | null;
    expect(scope?.open).toBe(false);
    expect(document.getElementById('scope-state')?.textContent).toMatch(/Mission authorized/i);
    expect(document.getElementById('folder-path')?.textContent).toBe('voice-experience-fixture');
    expect(document.getElementById('pick-folder')?.getAttribute('title')).toBe(longPath);
  });

  it('shows one activity summary with expandable details', async () => {
    const snap = desktopSnapshotFromEvents([
      eventFromSummary('tool start: read_file', RECORDED_START),
      eventFromSummary('tool succeeded: read_file', RECORDED_START, { kind: 'activity' }),
    ], cockpitInput({ running: false, terminal: true }));
    await paint(snap);
    expect(document.getElementById('activity-summary')?.textContent).toMatch(/Thinking|Working|mission|Ready|steps|read/i);
    const details = document.getElementById('activity-details') as HTMLDetailsElement | null;
    expect(details?.hidden).toBe(false);
    expect(details?.open ?? false).toBe(false);
  });

  it('makes Listening, Processing, and Completed visually distinct', async () => {
    await paint(idleSnap());
    document.getElementById('mic-button')?.click();
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('listening');
    expect(document.getElementById('jarvis-state-label')?.getAttribute('data-state')).toBe('listening');

    document.getElementById('mic-button')?.click();
    await vi.waitFor(() => {
      const state = document.querySelector('.app')?.getAttribute('data-jarvis-state');
      expect(['processing', 'working', 'idle', 'completed']).toContain(state);
    }, { timeout: 2000 });

    await paint(desktopSnapshotFromEvents([
      eventFromSummary('Final answer from Core conversation', RECORDED_START, {
        kind: 'result',
        text: 'Verified local answer.',
      }),
    ], cockpitInput({ running: false, terminal: true })));
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('completed');
    expect(document.getElementById('jarvis-state-label')?.getAttribute('data-state')).toBe('completed');
  });

  it('typed submit still works after a cancelled voice capture', async () => {
    submitCalls = [];
    let cancelled = false;
    (window as unknown as { jarvisVoiceCapture: { startPushToTalkCapture: () => { stop: () => Promise<Uint8Array | null>; cancel: () => void } } }).jarvisVoiceCapture.startPushToTalkCapture = () => ({
      stop: async () => new Uint8Array(64),
      cancel: () => { cancelled = true; },
    });
    await paint(idleSnap());
    document.getElementById('mic-button')?.click();
    document.getElementById('cancel')?.click();
    expect(cancelled).toBe(true);
    expect(document.getElementById('voice-transcript')?.textContent || '').toBe('');
    const input = document.getElementById('task-input') as HTMLTextAreaElement;
    input.value = 'Typed after cancel';
    document.getElementById('submit')?.click();
    await vi.waitFor(() => expect(submitCalls).toEqual(['Typed after cancel']), { timeout: 2000 });
  });
});
