/** @vitest-environment jsdom */
/**
 * The Stop button must reflect the real state of the task.
 *
 * It used to sit on "Stopping…" for ever when the host accepted the stop
 * request but the task never confirmed it stopped. The button now says "Stop
 * again" (the stop is still outstanding) and the banner states plainly that the
 * stop was not confirmed.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents } from './recordedMissionStream';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
const listeners: Array<() => void> = [];
const desktopApi: Record<string, (...args: unknown[]) => unknown> = {};

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
    submitTask: vi.fn(async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' })),
    cancel: vi.fn(async () => undefined),
    selectWorker: async () => currentSnapshot,
    selectProvider: async () => currentSnapshot,
    listModels: async () => [],
    selectModel: async () => currentSnapshot,
    transcribeUtterance: async () => ({ transcript: '', engine: 'whisper' }),
    getHostTelemetry: async () => null,
    onEvent: (listener: () => void) => { listeners.push(listener); return () => undefined; },
    listArtifacts: async () => [],
  });
  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = desktopApi;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

async function paint(running: boolean): Promise<void> {
  currentSnapshot = desktopSnapshotFromEvents([], cockpitInput({ running, terminal: false }), {
    installedModels: [],
    attemptId: running ? 'att-1' : null,
  } as Partial<DesktopSnapshot>);
  for (const listener of listeners) listener();
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const cancelButton = () => document.getElementById('cancel') as HTMLButtonElement;
const stopLabel = () => cancelButton().querySelector('.composer-cancel-label')?.textContent ?? '';
const banner = () => document.getElementById('operation-error') as HTMLElement;

describe('the Stop button reflects the real state of the task', () => {
  it('is hidden while nothing is running', async () => {
    await paint(false);
    expect(cancelButton().hidden).toBe(true);
    expect(stopLabel()).toBe('Stop');
  });

  it('offers Stop while a task runs', async () => {
    await paint(true);
    expect(cancelButton().hidden).toBe(false);
    expect(stopLabel()).toBe('Stop');
  });

  it('says "Stop again" and states plainly that the stop was not confirmed when the task is still running', async () => {
    await paint(true);
    (desktopApi.cancel as ReturnType<typeof vi.fn>).mockClear();
    cancelButton().click();
    await flush();

    expect(desktopApi.cancel).toHaveBeenCalled();
    expect(stopLabel()).toBe('Stop again');
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toMatch(/has not confirmed it stopped/i);
  });

  it('clears itself when the task actually stopped', async () => {
    await paint(true);
    // The task finishes while the stop is being processed.
    (desktopApi.cancel as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await paint(false);
    });
    cancelButton().click();
    await flush();

    expect(cancelButton().hidden).toBe(true);
    expect(stopLabel()).toBe('Stop');
    expect(banner().hidden).toBe(true);
  });
});
