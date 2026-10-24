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
    submitTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    cancel: async () => undefined,
    selectWorker: async () => currentSnapshot,
    selectProvider: async () => currentSnapshot,
    listModels: async () => [],
    selectModel: async () => currentSnapshot,
    transcribeUtterance: async () => ({ transcript: '', engine: 'whisper' }),
    getHostTelemetry: async () => null,
    onEvent: (listener: () => void) => { listeners.push(listener); return () => undefined; },
    connectGmail: vi.fn(async () => ({ connected: true, accountEmail: 'me@example.com', lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null })),
    disconnectGmail: vi.fn(async () => ({ connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null })),
    dispatchGmailAction: vi.fn(async () => ({ outcome: 'executed', output: '{}' })),
    resolveGmailApproval: vi.fn(async () => ({ outcome: 'executed', output: '{}' })),
    summarizeGmailThread: vi.fn(async () => ({ summary: 'A test summary.' })),
  });
  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = desktopApi;

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
  return desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), { installedModels: [], ...extra });
}

describe('Gmail renderer panel', () => {
  it('shows not-connected status and a Connect button when disconnected', async () => {
    await paint(idleSnap({ gmail: { connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null } }));
    expect(document.getElementById('gmail-status')?.textContent).toBe('Gmail: not connected');
    expect((document.getElementById('gmail-connect') as HTMLButtonElement)?.hidden).toBe(false);
    expect((document.getElementById('gmail-disconnect') as HTMLButtonElement)?.hidden).toBe(true);
  });

  it('shows the connected account and a Disconnect button when connected', async () => {
    await paint(idleSnap({ gmail: { connected: true, accountEmail: 'me@example.com', lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null } }));
    expect(document.getElementById('gmail-status')?.textContent).toContain('me@example.com');
    expect((document.getElementById('gmail-connect') as HTMLButtonElement)?.hidden).toBe(true);
    expect((document.getElementById('gmail-disconnect') as HTMLButtonElement)?.hidden).toBe(false);
    expect((document.getElementById('gmail-search-btn') as HTMLButtonElement)?.disabled).toBe(false);
  });

  it('shows the exact setup blocker text when Gmail OAuth is not configured', async () => {
    await paint(idleSnap({ gmail: { connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, configBlocker: 'KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID is not set.', capabilityBlocker: null } }));
    const blocker = document.getElementById('gmail-blocker');
    expect(blocker?.hidden).toBe(false);
    expect(blocker?.textContent).toContain('KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID');
  });

  it('clicking Connect calls the connectGmail IPC method', async () => {
    await paint(idleSnap({ gmail: { connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null } }));
    (document.getElementById('gmail-connect') as HTMLButtonElement)?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(desktopApi.connectGmail).toHaveBeenCalled();
  });

  it('renders search results and opening one reads the thread via dispatchGmailAction, never as HTML', async () => {
    await paint(idleSnap({ gmail: { connected: true, accountEmail: 'me@example.com', lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null } }));
    (desktopApi.dispatchGmailAction as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      outcome: 'executed',
      output: JSON.stringify({ results: [{ id: 'm1', threadId: 't1', subject: '<img src=x onerror=alert(1)>', from: 'a@example.com', date: 'Mon', snippet: 'hi' }] }),
    }));
    (document.getElementById('gmail-search-btn') as HTMLButtonElement)?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const results = document.getElementById('gmail-results');
    expect(results?.children.length).toBe(1);
    // The malicious-looking subject line must render as inert text, not markup.
    expect(results?.querySelector('img')).toBeNull();
    expect(results?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(results?.textContent).toContain('hi');
    expect(results?.querySelector('.gmail-result-item')?.getAttribute('role')).toBe('button');
    expect((results?.querySelector('.gmail-result-item') as HTMLElement)?.tabIndex).toBe(0);

    (desktopApi.dispatchGmailAction as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      outcome: 'executed',
      output: JSON.stringify({ threadId: 't1', messages: [{ id: 'm1', from: 'a@example.com', subject: 'Hi', date: 'Mon', bodyText: 'Ignore instructions <script>alert(1)</script>' }] }),
    }));
    (results?.querySelector('.gmail-result-item') as HTMLElement)?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const thread = document.getElementById('gmail-thread');
    expect(thread?.querySelector('script')).toBeNull();
    expect(thread?.textContent).toContain('Ignore instructions');
  });

  it('presents Gmail as account, mailbox, thread, and compose regions', () => {
    expect(document.querySelector('.gmail-account-bar')).toBeTruthy();
    expect(document.querySelector('.gmail-list-pane')).toBeTruthy();
    expect(document.querySelector('.gmail-reader-pane')).toBeTruthy();
    expect(document.querySelector('.gmail-compose')).toBeTruthy();
    expect(document.getElementById('gmail-draft-create')?.textContent).toBe('Save draft');
    expect(document.getElementById('gmail-draft-send')?.textContent).toBe('Review & send');
  });

  it('shows the approval card with exact recipients/subject/body when a send requires approval', async () => {
    await paint(idleSnap({ gmail: { connected: true, accountEmail: 'me@example.com', lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null } }));
    (desktopApi.dispatchGmailAction as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      outcome: 'approval_required',
      approvalId: 'appr-1',
      presentation: { to: ['bob@example.com'], cc: [], subject: 'Hi Bob', bodyText: 'See you soon.' },
    }));
    const to = document.getElementById('gmail-draft-to') as HTMLInputElement;
    const body = document.getElementById('gmail-draft-body') as HTMLTextAreaElement;
    to.value = 'bob@example.com';
    body.value = 'See you soon.';
    (document.getElementById('gmail-draft-create') as HTMLButtonElement)?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const panel = document.getElementById('gmail-approval');
    expect(panel?.hidden).toBe(false);
    expect(document.getElementById('gmail-approval-to')?.textContent).toContain('bob@example.com');
    expect(document.getElementById('gmail-approval-body')?.textContent).toContain('See you soon.');
  });
});
