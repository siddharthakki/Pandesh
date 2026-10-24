/** @vitest-environment jsdom */
/**
 * The approval card must be visible and actionable in the conversation while a
 * governed action is waiting for the user.
 *
 * The card is driven by the desktop's snapshot: `pendingApproval` carries the
 * action, and `cockpit.authState === 'pending'` says it is still live. A card
 * that is not rendered is the same as no approval request at all.
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

async function paint(extra: Record<string, unknown>): Promise<void> {
  currentSnapshot = desktopSnapshotFromEvents([], cockpitInput({ running: true, terminal: false }), {
    installedModels: [],
    ...extra,
  } as Partial<DesktopSnapshot>);
  for (const listener of listeners) listener();
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

const panel = () => document.getElementById('approval-panel') as HTMLElement;
const text = (id: string) => document.getElementById(id)?.textContent ?? '';

describe('the approval card is visible while an action waits for the user', () => {
  it('shows the tool, the scope and the detail, with Approve and Deny enabled', async () => {
    const card = {
      approvalId: 'appr-1',
      gate: 'mutation',
      toolName: 'governed_research',
      scope: 'governed_research latest local AI news',
      paths: [],
      detail: 'Pandesh wants to search the web for: "latest local AI news".',
    };
    await paint({
      awaitingApproval: true,
      pendingApproval: card,
      cockpit: { authState: 'pending', pendingApproval: card, approvedApproval: null },
    });

    expect(panel().hidden).toBe(false);
    expect(text('approval-tool')).toContain('governed_research');
    expect(text('approval-scope')).toContain('governed_research');
    expect(text('approval-detail')).toContain('Pandesh wants to search the web');
    expect((document.getElementById('approve') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('reject') as HTMLButtonElement).disabled).toBe(false);
  });

  it('hides the card once the approval is no longer pending', async () => {
    await paint({
      awaitingApproval: false,
      pendingApproval: null,
      cockpit: { authState: 'none', pendingApproval: null, approvedApproval: null },
    });
    expect(panel().hidden).toBe(true);
    expect((document.getElementById('approve') as HTMLButtonElement).disabled).toBe(true);
  });
});
