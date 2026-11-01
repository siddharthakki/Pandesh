/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rendererRoot = path.resolve(__dirname, '../renderer');
let taskCardElapsedMs: (cockpit: unknown, now: number) => number;

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  document.body.innerHTML = (html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  (window as any).jarvisVoiceCapture = { startPushToTalkCapture: () => ({ stop: async () => null, cancel: () => undefined }), bytesToBase64: () => '' };
  (window as any).karkedikhaDesktop = {
    getSnapshot: async () => null, listModels: async () => [], getHostTelemetry: async () => null, onEvent: () => () => undefined, listArtifacts: async () => [],
  };
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
  taskCardElapsedMs = (globalThis as any).taskCardElapsedMs;
});

describe('task card elapsed time', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  it('ticks from the real start while the task runs', () => {
    expect(taskCardElapsedMs({ running: true, terminal: false, startedAt: '2026-10-27T11:59:30Z', elapsedMs: 1 }, now)).toBe(30000);
  });
  it('freezes at the recorded runtime once the task is finished, however long ago it started', () => {
    expect(taskCardElapsedMs({ running: false, terminal: true, startedAt: '2026-10-26T08:00:00Z', elapsedMs: 42000 }, now)).toBe(42000);
  });
  it('never goes negative or NaN for a future, missing or garbage start', () => {
    expect(taskCardElapsedMs({ running: true, terminal: false, startedAt: '2026-10-27T13:00:00Z', elapsedMs: 0 }, now)).toBe(0);
    expect(taskCardElapsedMs({ running: true, terminal: false, startedAt: 'nonsense', elapsedMs: 5000 }, now)).toBe(5000);
    expect(taskCardElapsedMs(undefined, now)).toBe(0);
  });
});
