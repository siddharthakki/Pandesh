/** @vitest-environment jsdom */
/**
 * v2 had no place to enter Google credentials ("I can't enter google credentials anywhere", owner, 2026-11-10), and
 * the assistant sent the owner to a "Connections → Google Services" menu that v2 did not have. v2 now has Connections
 * (System → Connections) with the Classic Google card's states and actions, through the same host calls. The prompt
 * names only menus that exist.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { googleActions, googleState, serviceRows, type GmailStatus } from '../renderer-v2/src/googleModel';
import { GOOGLE_SETUP_WHERE, navigationPromptLines } from '../../../core/domain/productNavigation';

const base: GmailStatus = { connected: false, accountEmail: null, lastError: null, configBlocker: null, capabilityBlocker: null };
const bridge = {
  connectGmail: vi.fn(async () => base),
  cancelGoogleConnect: vi.fn(async () => base),
  retryGmailProbe: vi.fn(async () => base),
  disconnectGmail: vi.fn(async () => base),
  allowInboxOrganization: vi.fn(async () => base),
  saveGoogleOAuthClient: vi.fn(async (_id: string, _secret: string) => base),
  clearGoogleOAuthClient: vi.fn(async () => base),
  importGoogleOAuthClientFile: vi.fn(async () => ({ cancelled: false })),
  openExternalUrl: vi.fn(async (_url: string) => ({ opened: true })),
  onEvent: () => () => undefined,
};
let Connections: typeof import('../renderer-v2/src/Connections').Connections;

beforeAll(async () => {
  (window as unknown as { desktop: unknown }).desktop = bridge;
  ({ Connections } = await import('../renderer-v2/src/Connections'));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function mount(gmail: GmailStatus, calendarVerified = false) {
  const refresh = vi.fn();
  const snapshot = { gmail, everydayTools: { catalog: calendarVerified ? [{ id: 'calendar', connectorState: 'connected', availability: 'available' }] : [] } };
  render(React.createElement(Connections, { snapshot: snapshot as never, refresh }));
  return refresh;
}

describe('Google states (same rules as the Classic card)', () => {
  it('moves from setup to connected only when Core verified Gmail', () => {
    expect(googleState(base)).toBe('setup');
    expect(googleState({ ...base, clientSource: 'saved', clientHint: '1234…apps' })).toBe('ready');
    expect(googleState({ ...base, clientSource: 'saved', connecting: true })).toBe('connecting');
    expect(googleState({ ...base, clientSource: 'saved', connected: true })).toBe('checking');
    expect(googleState({ ...base, clientSource: 'saved', connected: true, capabilityBlocker: 'probe failed' })).toBe('problem');
    expect(googleState({ ...base, clientSource: 'saved', connected: true, verified: true, accountEmail: 'user@example.com' })).toBe('connected');
    expect(googleState({ ...base, clientSource: 'saved', recovery: { code: 'invalid_client', title: 'x', steps: [] } })).toBe('problem-disconnected');
    expect(googleState({ ...base, clientSource: 'saved', recovery: { code: 'cancelled', title: 'x', steps: [] } })).toBe('ready');
  });

  it('never calls Calendar connected without a live read, and hides developer setup for an app-owned client', () => {
    const connected = { ...base, clientSource: 'saved' as const, connected: true, verified: true, accountEmail: 'user@example.com' };
    expect(serviceRows(connected, 'connected', false)[1]).toMatchObject({ chip: 'Not verified' });
    expect(serviceRows(connected, 'connected', true)[1]).toMatchObject({ chip: 'Connected' });
    expect(googleActions({ ...base, clientSource: 'bundled' }, 'ready').showSetup).toBe(false);
    expect(googleActions(base, 'setup')).toMatchObject({ showSetup: true, connect: true, disconnect: false, clientEditable: true });
  });
});

describe('v2 Connections view', () => {
  it('in setup, offers the one-time OAuth client import and paste, and keeps the secret masked', async () => {
    mount(base);
    expect(screen.getByText('Setup needed').getAttribute('data-state')).toBe('setup');
    expect((screen.getByText('One-time setup: your Google OAuth client').closest('details') as HTMLDetailsElement).open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Import the downloaded JSON file…' }));
    await waitFor(() => expect(bridge.importGoogleOAuthClientFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Imported (encrypted). Now press Connect Google.')).toBeTruthy());

    const secret = screen.getByLabelText('Client secret (optional)') as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: '1234567890-abc.apps.googleusercontent.com' } });
    fireEvent.change(secret, { target: { value: 'not-a-real-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.saveGoogleOAuthClient).toHaveBeenCalledWith('1234567890-abc.apps.googleusercontent.com', 'not-a-real-secret'));
  });

  it('Connect Google without a client points at the setup instead of failing in the browser', () => {
    mount(base);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    expect(bridge.connectGmail).not.toHaveBeenCalled();
    expect(screen.getByText('Add your OAuth Client ID first; the steps are just below.')).toBeTruthy();
  });

  it('with a client, connects; once connected, offers check, disconnect and inbox organization', async () => {
    mount({ ...base, clientSource: 'saved', clientHint: '1234…apps' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    await waitFor(() => expect(bridge.connectGmail).toHaveBeenCalledTimes(1));
    cleanup();
    mount({ ...base, clientSource: 'saved', connected: true, verified: true, accountEmail: 'user@example.com', inboxOrganization: 'not_granted' }, true);
    expect(screen.queryByRole('button', { name: 'Connect Google' })).toBeNull();
    expect(screen.getByText(/user@example\.com · verified/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(bridge.disconnectGmail).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Allow inbox organization' })).toBeTruthy();
  });

  it('opens Google Cloud pages through the host, never inside the app', () => {
    mount(base);
    fireEvent.click(screen.getByRole('button', { name: 'Open credentials' }));
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://console.cloud.google.com/apis/credentials');
  });
});

describe('the assistant names only menus that exist', () => {
  it('v2 System → Connections and Classic Connections → Google are real', () => {
    const app = fs.readFileSync(path.join(__dirname, '../renderer-v2/src/App.tsx'), 'utf8');
    expect(app).toMatch(/\{ name: 'Connections', sub: 'Google \(Gmail, Calendar\): set up and connect', run: \(\) => go\('connections'\) \}/);
    const classic = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
    expect(classic).toContain('<h2 class="integrations-main-title">Connections</h2>');
    expect(classic).toContain('id="integ-card-google"');
    expect(classic).toContain('<h3 class="int-card-title">Google Services</h3>');
    expect(GOOGLE_SETUP_WHERE).toBe('System (bottom of the left rail) → Connections in the v2 interface, or Connections and settings (left sidebar) → Add / Configure → Google Services in the Classic interface');
    expect(classic).toContain('data-conn-tab="configure"');
    expect(navigationPromptLines('v2')).toMatch(/Never ask the user to paste a client secret, password, API key or token into the chat/);
    const engine = fs.readFileSync(path.join(__dirname, '../../../core/runtime/piAgentEngine.ts'), 'utf8');
    expect(engine).not.toContain('Google Services');
  });
});
