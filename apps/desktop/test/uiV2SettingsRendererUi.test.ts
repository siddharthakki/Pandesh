/** @vitest-environment jsdom */
/** Settings against a mocked host bridge: each control makes the existing host call and shows what comes back. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AUTHORIZATION_CATEGORIES } from '../../../core/domain/permissionModes';

const bridge = {
  selectModel: vi.fn(async (_m: string) => null),
  setPermissionMode: vi.fn(async () => ({})),
  revokeAuthorization: vi.fn(async () => ({})),
  getAppMetadata: vi.fn(async () => ({ productName: 'Pandesh', version: '0.1.8', buildNumber: 171, buildKind: 'release', releaseChannel: 'stable', commit: '5ee336c0aaaa', builtAt: null, coreVersion: '0.1.8', coreVersionMismatch: false })),
  getDiagnosticsReport: vi.fn(async () => 'Pandesh diagnostics\ncore: connected'),
  copyToClipboard: vi.fn(async () => ({ copied: true })),
  retryCoreConnection: vi.fn(async () => null),
  getUpdateStatus: vi.fn(async () => ({ available: true, installedRevision: 171, version: '0.1.8', lastResult: null })),
  startUpdate: vi.fn(async () => ({ status: 'cancelled', message: 'No update package was chosen.' })),
  acknowledgeUpdateResult: vi.fn(async () => undefined),
  onEvent: () => () => undefined,
};
let Settings: typeof import('../renderer-v2/src/Settings').Settings;
beforeAll(async () => {
  (window as unknown as { desktop: unknown }).desktop = bridge;
  ({ Settings } = await import('../renderer-v2/src/Settings'));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const snap = (over: Record<string, unknown> = {}) => ({
  coreState: 'connected', model: 'gemma4:12b', modelIsAuto: false, installedModels: ['gemma4:12b'], running: false, folder: null, modelServerReachable: true,
  permission: { conversationId: 'c', mode: 'ask', authorizations: [], categories: { ...AUTHORIZATION_CATEGORIES }, pending: false, activeTurnMode: null },
  cloud: { selectedModel: null, providers: [{ id: 'groq', displayName: 'Groq', enabled: true, configured: true }], listings: { groq: { pool: [{ id: 'llama', displayName: 'Llama', vision: false, tools: true }] } } },
  ...over,
});
const mount = (s: Record<string, unknown>, initialSection?: 'models' | 'diagnostics' | 'updates' | 'permissions' | 'appearance') => {
  const props = { snapshot: s as never, refresh: vi.fn(), narrow: false, initialSection, theme: 'system', setTheme: vi.fn(), labels: false, setLabels: vi.fn(), variantForced: false, onUseClassic: vi.fn(), onGo: vi.fn() };
  render(React.createElement(Settings, props));
  return props;
};

describe('UI v2 Settings', () => {
  it('chooses a verified free cloud model through the host and states the boundary', async () => {
    const p = mount(snap());
    expect(screen.getByText(/never reads your images, files, email/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Llama/ }));
    await waitFor(() => expect(bridge.selectModel).toHaveBeenCalledWith('groq::llama'));
    await waitFor(() => expect(p.refresh).toHaveBeenCalled());
  });

  it('points to Connections when no provider is set up, instead of inventing choices', () => {
    const p = mount(snap({ cloud: { selectedModel: null, providers: [], listings: {} } }));
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Connections' }));
    expect(p.onGo).toHaveBeenCalledWith('connections');
  });

  it('shows Ask/Auto/Plan from the shared control', async () => {
    mount(snap(), 'permissions');
    fireEvent.change(screen.getByLabelText('Permission mode'), { target: { value: 'plan' } });
    await waitFor(() => expect(bridge.setPermissionMode).toHaveBeenCalledWith('plan'));
  });

  it('loads and copies the diagnostics report', async () => {
    mount(snap(), 'diagnostics');
    await screen.findByText(/build b171/);
    fireEvent.click(screen.getByRole('button', { name: 'Show report' }));
    await screen.findByText(/core: connected/);
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => expect(bridge.copyToClipboard).toHaveBeenCalledWith('Pandesh diagnostics\ncore: connected'));
  });

  it('starts an update only through the host dialog and shows its answer', async () => {
    mount(snap(), 'updates');
    await screen.findByText('Installed build b171.');
    fireEvent.click(screen.getByRole('button', { name: /Choose an update package/ }));
    await screen.findByText('No update package was chosen.');
    expect(bridge.startUpdate).toHaveBeenCalledTimes(1);
  });
});
