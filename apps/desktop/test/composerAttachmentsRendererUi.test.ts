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
    pickAttachments: vi.fn(async () => ({ cancelled: false, errors: [] as string[] })),
    stageAttachmentBytes: vi.fn(async () => ({ ok: true })),
    removeAttachment: vi.fn(async () => undefined),
  });
  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = desktopApi;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

async function paint(extra: Partial<DesktopSnapshot> & { stagedAttachments?: unknown[]; modelNote?: string | null }): Promise<void> {
  currentSnapshot = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), { installedModels: [], ...(extra as Partial<DesktopSnapshot>) });
  for (const listener of listeners) listener();
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

const staged = [
  { id: 'stg_1', name: 'quarterly-report.pdf', byteSize: 2_400_000, kind: 'document', mimeType: 'application/pdf' },
  { id: 'stg_2', name: 'screenshot.png', byteSize: 90_000, kind: 'image', mimeType: 'image/png' },
];

describe('composer attachments', () => {
  it('has a real attach button (not decorative) and shows staged files as removable chips from the host snapshot', async () => {
    expect(document.getElementById('composer-attach-btn')).toBeTruthy();
    expect((document.getElementById('composer-attachments') as HTMLElement).hidden).toBe(true);
    await paint({ stagedAttachments: staged });
    const strip = document.getElementById('composer-attachments') as HTMLElement;
    expect(strip.hidden).toBe(false);
    expect(strip.querySelectorAll('.attach-chip')).toHaveLength(2);
    expect(strip.textContent).toContain('quarterly-report.pdf');
    expect(strip.textContent).toContain('2.3 MB');
    expect((document.getElementById('task-input') as HTMLInputElement).placeholder).toContain('your file');
    // the renderer never receives a filesystem path
    expect(strip.innerHTML).not.toMatch(/[A-Za-z]:\\/);
  });

  it('removing a chip asks the host to drop that file', async () => {
    await paint({ stagedAttachments: staged });
    (document.querySelector('#composer-attachments .attach-chip button') as HTMLButtonElement).click();
    await flush();
    expect(desktopApi.removeAttachment).toHaveBeenCalledWith('stg_1');
  });

  it('the attach button opens the host picker and surfaces refusals in plain words', async () => {
    (desktopApi.pickAttachments as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ cancelled: false, errors: ['"setup.exe" is a .exe file, which Panda can\'t read.'] });
    (document.getElementById('composer-attach-btn') as HTMLButtonElement).click();
    await flush();
    expect(desktopApi.pickAttachments).toHaveBeenCalled();
    const banner = document.getElementById('operation-error') as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('.exe file');
    banner.click();
    expect(banner.hidden).toBe(true);
  });

  it('errors are shown in a visible banner above the composer, never in a hidden panel', () => {
    const banner = document.getElementById('operation-error') as HTMLElement;
    expect(banner.closest('.apex-bottom-cluster')).toBeTruthy();
    expect(banner.closest('[style*="display:none"]')).toBeNull();
    expect(document.querySelectorAll('#operation-error').length).toBeGreaterThanOrEqual(1);
  });

  it('pasting an image stages its bytes; pasting plain text is left alone', async () => {
    const input = document.getElementById('task-input') as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'pasted.png', { type: 'image/png' });
    const imageEvent = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    imageEvent.clipboardData = { files: [file] };
    input.dispatchEvent(imageEvent);
    await flush();
    expect(desktopApi.stageAttachmentBytes).toHaveBeenCalledWith('pasted.png', expect.any(Uint8Array));
    expect(imageEvent.defaultPrevented).toBe(true);
    const textEvent = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    textEvent.clipboardData = { files: [] };
    input.dispatchEvent(textEvent);
    expect(textEvent.defaultPrevented).toBe(false);
  });

  it('sending files with no typed text still sends (with a default instruction) and shows the files on the message', async () => {
    await paint({ stagedAttachments: [staged[1]] });
    (document.getElementById('task-input') as HTMLInputElement).value = '';
    (document.getElementById('submit') as HTMLButtonElement).click();
    await flush();
    expect(desktopApi.submitTask).toHaveBeenCalledWith('Please look at the attached file.', expect.anything());
    const userRow = [...document.querySelectorAll('#result .transcript-row-user')].pop() as HTMLElement;
    expect(userRow.textContent).toContain('Please look at the attached file.');
    expect(userRow.querySelector('.transcript-attachments')?.textContent).toContain('screenshot.png');
  });

  it('while a vision model is chosen for an image the header says why', async () => {
    await paint({ running: true, model: 'gemma4:12b', modelIsAuto: false, modelNote: "lfm can't see images, so gemma4:12b is answering this message." });
    expect(document.getElementById('conv-model-badge')?.textContent).toBe('Running on gemma4:12b · chosen for your image');
    expect(document.getElementById('conv-model-badge')?.title).toContain("can't see images");
  });
});

describe('contextual mail workspace and advanced settings', () => {
  it('the Mail button exists only while Google is connected AND verified, and opening it moves the existing Gmail panel beside the conversation', async () => {
    const mailBtn = document.getElementById('btn-open-mail') as HTMLButtonElement;
    await paint({ gmail: { connected: true, accountEmail: 'me@example.com', lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null, verified: false } as never });
    expect(mailBtn.hidden).toBe(true);
    await paint({ gmail: { connected: true, accountEmail: 'me@example.com', lastError: null, lastRefreshedAt: '2026-10-19T12:00:00Z', configBlocker: null, capabilityBlocker: null, verified: true } as never });
    expect(mailBtn.hidden).toBe(false);
    const panelBefore = document.querySelector('#tab-gmail .gmail-panel');
    expect(panelBefore).toBeTruthy();
    mailBtn.click();
    expect((document.getElementById('mail-workspace') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector('#mail-workspace-body .gmail-panel')).toBe(panelBefore); // same element: every binding survives
    expect(document.getElementById('gmail-search-btn')).toBeTruthy();
    // losing verification closes the workspace and hides the button
    await paint({ gmail: { connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null, verified: false } as never });
    expect(mailBtn.hidden).toBe(true);
    expect((document.getElementById('mail-workspace') as HTMLElement).hidden).toBe(true);
  });

  it('engine and provider pickers live only under Details > Advanced, not in the main window', () => {
    const advanced = document.getElementById('advanced-settings') as HTMLDetailsElement;
    expect(advanced).toBeTruthy();
    expect(advanced.closest('#drawer-activity')).toBeTruthy();
    for (const id of ['worker-select', 'inference-provider', 'openrouter-key']) {
      const el = document.getElementById(id);
      expect(el, id).toBeTruthy();
      expect(el!.closest('#advanced-settings'), id).toBeTruthy();
    }
    expect(document.querySelector('.topbar')?.querySelector('#worker-select, #inference-provider')).toBeNull();
  });
});
