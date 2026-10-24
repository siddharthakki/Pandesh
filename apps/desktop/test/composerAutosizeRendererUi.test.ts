/** @vitest-environment jsdom */
// The Panda composer is a real multi-line, auto-growing textarea: long
// instructions and pasted text are readable and stay intact, Enter submits,
// Shift+Enter inserts a newline, and the field grows (field-sizing: content)
// up to a cap before scrolling internally. The old single-line <input> clipped
// pasted/multiline content.
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
    cancel: async () => undefined,
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

async function paint(): Promise<void> {
  currentSnapshot = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), { installedModels: [] });
  for (const listener of listeners) listener();
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const composer = () => document.getElementById('task-input') as HTMLTextAreaElement;

describe('Panda composer is a multi-line textarea', () => {
  it('is a TEXTAREA (not a single-line <input>), one visible row at rest', async () => {
    await paint();
    const input = composer();
    expect(input).toBeTruthy();
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.rows).toBe(1);
    expect(input.closest('.composer-capsule-wrap')).toBeTruthy();
  });

  it('Enter submits like the old input did; Shift+Enter inserts a newline instead', async () => {
    await paint();
    const input = composer();
    (desktopApi.submitTask as ReturnType<typeof vi.fn>).mockClear();

    input.value = 'keep me';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(desktopApi.submitTask).not.toHaveBeenCalled();
    expect(input.value).toBe('keep me');

    input.value = 'go';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(desktopApi.submitTask).toHaveBeenCalledWith('go', expect.anything());
    expect(input.value).toBe('');
  });

  it('sends multi-line instructions verbatim, with line breaks kept in the turn', async () => {
    await paint();
    const input = composer();
    input.value = 'line one\nline two\nline three';
    (document.getElementById('submit') as HTMLButtonElement).click();
    await flush();
    expect(desktopApi.submitTask).toHaveBeenCalledWith('line one\nline two\nline three', expect.anything());
    const userRow = [...document.querySelectorAll('#result .transcript-row-user')].pop() as HTMLElement;
    const body = userRow.querySelector('.transcript-body') as HTMLElement;
    expect(body.textContent).toBe('line one\nline two\nline three');
    expect(input.value).toBe('');
  });

  it('grows to fit content (field-sizing) and scrolls internally once capped', () => {
    const css = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
    expect(css).toMatch(/#task-input\s*\{[^}]*field-sizing:\s*content/);
    expect(css).toMatch(/#task-input\s*\{[^}]*resize:\s*none/);
    expect(css).toMatch(/#task-input\s*\{[^}]*max-height:\s*7\.5rem/);
    expect(css).toMatch(/#task-input\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('keeps the composer capsule anchored so the send/mic buttons ride at the bottom edge as it grows', () => {
    const css = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.composer-capsule-wrap\s*\{[^}]*align-items:\s*flex-end/);
  });
});
