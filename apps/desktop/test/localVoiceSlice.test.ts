/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents } from './recordedMissionStream';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
const listeners: Array<() => void> = [];
let submitCalls: string[] = [];
let transcribeCalls = 0;

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
    transcribeUtterance: async () => {
      transcribeCalls += 1;
      return { transcript: 'What is in package.json?', engine: 'whisper-base.en' };
    },
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

describe('Local voice vertical slice (renderer)', () => {
  it('shows exact blocker when local speech is unavailable and never enters listening', async () => {
    const snap = idleSnap({
      localSpeech: {
        capability: 'unavailable_no_local_engine',
        engine: null,
        blocker: 'Bundled whisper-base.en model files are missing.',
      },
    });
    await paint(snap);
    expect(document.getElementById('mic-button')?.hasAttribute('disabled')).toBe(true);
    expect(document.getElementById('mic-hint')?.textContent).toMatch(/whisper-base.en model files are missing/i);
    document.getElementById('mic-button')?.click();
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('idle');
  });

  it('captures push-to-talk, transcribes locally, and submits through the existing path', async () => {
    submitCalls = [];
    transcribeCalls = 0;
    await paint(idleSnap());
    document.getElementById('mic-button')?.click();
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('listening');
    document.getElementById('mic-button')?.click();
    await vi.waitFor(() => expect(transcribeCalls).toBe(1), { timeout: 2000 });
    await vi.waitFor(() => expect(submitCalls.length).toBe(1), { timeout: 2000 });
    expect(submitCalls).toEqual(['What is in package.json?']);
    expect((document.getElementById('task-input') as HTMLTextAreaElement).value).toBe('What is in package.json?');
  });

  it('one Mic click uses local end-of-speech capture and submits without a second click', async () => {
    submitCalls = [];
    transcribeCalls = 0;
    let vadStarts = 0;
    const capture = (window as unknown as { jarvisVoiceCapture: Record<string, unknown> }).jarvisVoiceCapture;
    capture.startVadUtteranceCapture = () => {
      vadStarts += 1;
      return {
        done: Promise.resolve(new Uint8Array(128)),
        stop: async () => new Uint8Array(128),
        cancel: () => undefined,
      };
    };
    await paint(idleSnap());
    document.getElementById('mic-button')?.click();
    await vi.waitFor(() => expect(submitCalls).toEqual(['What is in package.json?']), { timeout: 2000 });
    expect(vadStarts).toBe(1);
    expect(transcribeCalls).toBe(1);
    delete capture.startVadUtteranceCapture;
  });

  it('cancel discards an in-progress capture without transcribing', async () => {
    transcribeCalls = 0;
    let cancelled = false;
    (window as unknown as { jarvisVoiceCapture: { startPushToTalkCapture: () => { stop: () => Promise<Uint8Array | null>; cancel: () => void } } }).jarvisVoiceCapture.startPushToTalkCapture = () => ({
      stop: async () => new Uint8Array(64),
      cancel: () => {
        cancelled = true;
      },
    });
    await paint(idleSnap());
    document.getElementById('mic-button')?.click();
    document.getElementById('cancel')?.click();
    expect(cancelled).toBe(true);
    expect(transcribeCalls).toBe(0);
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('idle');
  });

  it('typed submit remains available when speech is unavailable', async () => {
    submitCalls = [];
    await paint(idleSnap({
      localSpeech: {
        capability: 'unavailable_no_local_engine',
        engine: null,
        blocker: 'ASR runtime missing.',
      },
    }));
    const input = document.getElementById('task-input') as HTMLTextAreaElement;
    input.value = 'Typed fallback question';
    document.getElementById('submit')?.click();
    await vi.waitFor(() => expect(submitCalls).toEqual(['Typed fallback question']), { timeout: 2000 });
  });
});
