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
    importGoogleOAuthClientFile: vi.fn(async () => ({ cancelled: false, status: baseGmail })),
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

describe('Google Services card: status is only ever claimed when verified', () => {
  it('always shows a visible Connect Google button, and explains setup when no OAuth client exists', async () => {
    await paint(snap({ configBlocker: 'Google is not set up yet' }));
    expect(hidden('google-connect')).toBe(false);
    expect(text('google-connect')).toBe('Connect Google');
    expect(text('integ-google-badge')).toBe('Setup needed');
    expect(text('google-gmail-chip')).toBe('Not connected');
    expect(text('google-gmail-detail')).toContain('OAuth client');
    expect((document.getElementById('google-setup') as HTMLDetailsElement).open).toBe(true);
    // The setup instructions name the exact Google pages and client type to use.
    expect(document.getElementById('google-setup')?.textContent).toContain('Desktop app');
    expect(document.getElementById('google-setup')?.textContent).toContain('Test users');
    expect(document.querySelectorAll('#integ-card-google [data-open-url]').length).toBeGreaterThanOrEqual(4);
  });

  it('clicking Connect without a client sends the user to setup instead of starting a browser sign-in', async () => {
    await paint(snap({}));
    (desktopApi.connectGmail as ReturnType<typeof vi.fn>).mockClear();
    (document.getElementById('google-connect') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(desktopApi.connectGmail).not.toHaveBeenCalled();
    expect(text('google-action-note')).toContain('Client ID');
  });

  it('with a client saved, Connect starts the real sign-in', async () => {
    await paint(snap({ clientSource: 'saved', clientHint: '1234…xyz.apps.googleusercontent.com' }));
    expect(text('integ-google-badge')).toBe('Not connected');
    (document.getElementById('google-connect') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(desktopApi.connectGmail).toHaveBeenCalled();
  });

  it('with an app-owned client, developer setup is hidden and Connect starts sign-in directly', async () => {
    await paint(snap({ clientSource: 'bundled', clientHint: '1234…xyz.apps.googleusercontent.com' }));
    expect((document.getElementById('google-setup') as HTMLElement).hidden).toBe(true);
    (document.getElementById('google-connect') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(desktopApi.connectGmail).toHaveBeenCalled();
  });

  it('a stored credential alone (connected, not yet verified) is shown as Checking, never Connected', async () => {
    await paint(snap({ clientSource: 'saved', connected: true, accountEmail: null, verified: false }));
    expect(text('integ-google-badge')).toBe('Checking…');
    expect(text('google-gmail-chip')).toBe('Checking…');
    expect(text('google-gmail-chip')).not.toBe('Connected');
  });

  it('signed in but Core could not verify Gmail: warns with the exact fix, not Connected', async () => {
    await paint(snap({
      clientSource: 'saved', connected: true, accountEmail: 'me@example.com', lastRefreshedAt: '2026-10-19T12:00:00Z',
      capabilityBlocker: 'gws binary is not staged (KARKEDIKHA_GWS_BIN is not set)',
      recovery: { code: 'helper_missing', title: "Panda's Google helper is not installed", steps: ['Install it with: node scripts/fetch-gws.mjs'] },
    }));
    expect(text('integ-google-badge')).toBe('Needs attention');
    expect(text('google-gmail-chip')).toBe('Not verified');
    expect(hidden('google-recovery')).toBe(false);
    expect(text('google-recovery-title')).toContain('helper');
    expect(text('google-recovery-steps')).toContain('fetch-gws');
    expect(hidden('google-connect')).toBe(true);
    expect(hidden('google-check')).toBe(false);
  });

  it('only a verified status reads Connected, with the account and a Disconnect button', async () => {
    await paint(snap({ clientSource: 'saved', connected: true, verified: true, accountEmail: 'me@example.com', lastRefreshedAt: '2026-10-19T12:00:00Z' }));
    expect(text('integ-google-badge')).toBe('Gmail connected');
    expect(text('google-gmail-chip')).toBe('Connected');
    expect(text('google-gmail-detail')).toContain('me@example.com');
    expect(hidden('google-disconnect')).toBe(false);
    expect(hidden('google-connect')).toBe(true);
    expect(hidden('google-recovery')).toBe(true);
  });

  it('Calendar is never marked connected from the Google sign-in alone', async () => {
    const signedIn = { clientSource: 'saved' as const, connected: true, verified: true, accountEmail: 'me@example.com', lastRefreshedAt: '2026-10-19T12:00:00Z' };
    // Not granted in the consent screen: says so and how to fix it.
    await paint(snap({ ...signedIn, calendarAccess: 'not_granted' }, [{ id: 'calendar', label: 'Calendar', availability: 'not_connected', detail: 'x', connectorState: 'not_configured' }]));
    expect(text('google-calendar-chip')).toBe('Not granted');
    expect(text('google-calendar-detail')).toContain('connect again');
    // Granted but Core could not read the calendar: not verified, with Core's reason.
    await paint(snap({ ...signedIn, calendarAccess: 'granted', calendarBlocker: 'gws accessNotConfigured (403): Calendar API has not been used' }, [{ id: 'calendar', label: 'Calendar', availability: 'not_connected', detail: 'x', connectorState: 'unavailable' }]));
    expect(text('google-calendar-chip')).toBe('Not verified');
    expect(text('google-calendar-detail')).toContain('accessNotConfigured');
    // Granted, no blocker yet, and Core has not reported it connected: "Not verified", never "Connected" and never an endless "Checking".
    await paint(snap({ ...signedIn, calendarAccess: 'granted', calendarBlocker: null }, [{ id: 'calendar', label: 'Calendar', availability: 'not_connected', detail: 'x', connectorState: 'unavailable' }]));
    expect(text('google-calendar-chip')).toBe('Not verified');
    expect(text('google-calendar-detail')).toContain('Press Check');
    // A failed token refresh is shown as the reason, not hidden behind a spinner.
    await paint(snap({ ...signedIn, calendarAccess: 'granted', calendarBlocker: null, lastError: 'access token refresh failed: network down' }, [{ id: 'calendar', label: 'Calendar', availability: 'not_connected', detail: 'x', connectorState: 'unavailable' }]));
    expect(text('google-calendar-chip')).toBe('Not verified');
    expect(text('google-calendar-detail')).toContain('network down');
  });

  it('Calendar reads Connected only when Core reports a connected, available connector', async () => {
    await paint(snap({ clientSource: 'saved', connected: true, verified: true, accountEmail: 'me@example.com', lastRefreshedAt: '2026-10-19T12:00:00Z' },
      [{ id: 'calendar', label: 'Calendar', availability: 'available', detail: 'Connected', connectorState: 'connected' }]));
    expect(text('google-calendar-chip')).toBe('Connected');
  });

  it('shows a Cancel button only while a sign-in is waiting on the browser', async () => {
    await paint(snap({ clientSource: 'saved', connecting: true }));
    expect(text('integ-google-badge')).toBe('Waiting for sign-in…');
    expect(hidden('google-cancel')).toBe(false);
    (document.getElementById('google-cancel') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(desktopApi.cancelGoogleConnect).toHaveBeenCalled();
    await paint(snap({ clientSource: 'saved' }));
    expect(hidden('google-cancel')).toBe(true);
  });

  it('a cancelled sign-in is explained but is not painted as a failure', async () => {
    await paint(snap({ clientSource: 'saved', recovery: { code: 'cancelled', title: 'Sign-in cancelled', steps: ['Nothing was connected.'] } }));
    expect(text('google-recovery-title')).toBe('Sign-in cancelled');
    expect(document.getElementById('integ-google-badge')?.className).not.toContain('warn');
  });

  it('offers a file import for Googles downloaded client JSON and surfaces its errors verbatim', async () => {
    await paint(snap({}));
    expect(document.getElementById('google-client-import')).toBeTruthy();
    (document.getElementById('google-client-import') as HTMLButtonElement).click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(desktopApi.importGoogleOAuthClientFile).toHaveBeenCalled();
    expect(text('google-client-status')).toContain('Imported');
    (desktopApi.importGoogleOAuthClientFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Error invoking remote method 'x': Error: That is a Web application client."));
    (document.getElementById('google-client-import') as HTMLButtonElement).click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(text('google-client-status')).toBe('That is a Web application client.');
  });

  it('saving the OAuth client passes the pasted values to the host and surfaces validation errors verbatim', async () => {
    await paint(snap({}));
    (document.getElementById('google-client-id') as HTMLInputElement).value = 'bad';
    (desktopApi.saveGoogleOAuthClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:saveGoogleOAuthClient': Error: That does not look like a Google Client ID."));
    (document.getElementById('google-client-form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(desktopApi.saveGoogleOAuthClient).toHaveBeenCalledWith('bad', '');
    expect(text('google-client-status')).toBe('That does not look like a Google Client ID.');
  });
});
