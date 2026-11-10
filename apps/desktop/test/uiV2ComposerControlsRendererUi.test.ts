/** @vitest-environment jsdom */
/**
 * The v2 composer has the two choices the Classic composer has: the model for the next message and the
 * conversation's permission mode (Ask / Auto / Plan only, with Auto's scope, expiry and Revoke). Before this, v2
 * had neither, so a person using v2 could not pick a model or turn on Auto at all.
 *
 * Renders the real controls against a mocked host bridge and checks the calls they make.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AUTHORIZATION_CATEGORIES } from '../../../core/domain/permissionModes';

type Snap = Record<string, any>;
const bridge = {
  selectModel: vi.fn(async (_model: string) => null),
  setPermissionMode: vi.fn(async (_mode: string, _grant?: unknown) => ({})),
  revokeAuthorization: vi.fn(async (_id: string) => ({})),
  onEvent: () => () => undefined,
};

let useComposerControls: typeof import('../renderer-v2/src/ComposerControls').useComposerControls;

beforeAll(async () => {
  // bridge.ts reads window.desktop when it loads, as it does in the app.
  (window as unknown as { desktop: unknown }).desktop = bridge;
  ({ useComposerControls } = await import('../renderer-v2/src/ComposerControls'));
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function snapshot(over: Snap = {}): Snap {
  return {
    coreState: 'connected', model: 'gemma4:12b', modelIsAuto: false, installedModels: ['gemma4:12b', 'qwen3:8b'], running: false, folder: null,
    permission: { conversationId: 'conv_1', mode: 'ask', authorizations: [], categories: { ...AUTHORIZATION_CATEGORIES }, pending: false, activeTurnMode: null },
    ...over,
  };
}

function Harness({ snap, refresh, onNotice }: { snap: Snap; refresh: () => void; onNotice: (n: unknown) => void }) {
  const c = useComposerControls({ snapshot: snap as never, refresh, onNotice, disabled: false });
  return React.createElement('div', null, c.panel, c.controls);
}

function mount(snap: Snap) {
  const refresh = vi.fn();
  const onNotice = vi.fn();
  render(React.createElement(Harness, { snap, refresh, onNotice }));
  return { refresh, onNotice };
}

describe('UI v2 composer — model menu', () => {
  it('lists Auto and the installed models and switches the model through the host', async () => {
    const { refresh } = mount(snapshot());
    const select = screen.getByLabelText('Model for your next message') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['__auto__', 'gemma4:12b', 'qwen3:8b']);
    expect(select.value).toBe('gemma4:12b');
    fireEvent.change(select, { target: { value: 'qwen3:8b' } });
    await waitFor(() => expect(bridge.selectModel).toHaveBeenCalledWith('qwen3:8b'));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    fireEvent.change(select, { target: { value: '__auto__' } });
    await waitFor(() => expect(bridge.selectModel).toHaveBeenLastCalledWith('__auto__'));
  });

  it('cannot be changed while a task runs, and reports a refused switch', async () => {
    mount(snapshot({ running: true }));
    expect((screen.getByLabelText('Model for your next message') as HTMLSelectElement).disabled).toBe(true);
    cleanup();
    bridge.selectModel.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:selectModel': Error: model 'x' is not installed in Ollama"));
    const { onNotice } = mount(snapshot());
    fireEvent.change(screen.getByLabelText('Model for your next message'), { target: { value: 'qwen3:8b' } });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith({ text: "model 'x' is not installed in Ollama", error: true }));
  });
});

describe('UI v2 composer — Ask / Auto / Plan only', () => {
  it('switches to Plan only and back to Ask without a form', async () => {
    mount(snapshot());
    const mode = screen.getByLabelText('Permission mode') as HTMLSelectElement;
    expect([...mode.options].map((o) => o.text)).toEqual(['Ask permission', 'Auto (governed)', 'Plan only']);
    fireEvent.change(mode, { target: { value: 'plan' } });
    await waitFor(() => expect(bridge.setPermissionMode).toHaveBeenCalledWith('plan'));
    expect(screen.queryByRole('form', { name: 'Turn on Auto' })).toBeNull();
  });

  it('turns on Auto only with what the person ticked, for the expiry they chose', async () => {
    mount(snapshot());
    fireEvent.change(screen.getByLabelText('Permission mode'), { target: { value: 'auto' } });
    const form = screen.getByRole('form', { name: 'Turn on Auto' });
    expect(form.textContent).toMatch(/Still asks you: outbound email and messages/);
    expect(bridge.setPermissionMode).not.toHaveBeenCalled();

    // Nothing ticked: refused here, nothing sent to the host.
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Auto' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Tick at least one thing Auto may do/);
    expect(bridge.setPermissionMode).not.toHaveBeenCalled();

    // Workspace categories need a folder; public web research does not.
    const git = screen.getByRole('checkbox', { name: /git add and git commit/ }) as HTMLInputElement;
    expect(git.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Public web searches/ }));
    fireEvent.change(screen.getByLabelText(/^For/), { target: { value: '480' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Auto' }));
    await waitFor(() => expect(bridge.setPermissionMode).toHaveBeenCalledWith('auto', { categories: ['web_research_public'], expiresInMinutes: 480 }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Turn on Auto' })).toBeNull());
  });

  it('Cancel leaves the mode as it was', () => {
    mount(snapshot());
    fireEvent.change(screen.getByLabelText('Permission mode'), { target: { value: 'auto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Turn on Auto' })).toBeNull();
    expect((screen.getByLabelText('Permission mode') as HTMLSelectElement).value).toBe('ask');
    expect(bridge.setPermissionMode).not.toHaveBeenCalled();
  });

  it('in Auto with nothing granted, says so and offers to choose what Auto may do', () => {
    mount(snapshot({ permission: { conversationId: 'conv_1', mode: 'auto', authorizations: [], categories: { ...AUTHORIZATION_CATEGORIES }, pending: false, activeTurnMode: null } }));
    expect((screen.getByLabelText('Permission mode') as HTMLSelectElement).selectedOptions[0].text).toBe('Auto · nothing granted');
    expect(screen.getByText('Auto has no active authorization, so everything still asks you.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose what Auto may do…' }));
    expect(screen.getByRole('form', { name: 'Turn on Auto' })).toBeTruthy();
  });

  it('shows an active Auto grant with its expiry, what it covers, and Revoke', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    mount(snapshot({
      folder: 'C:\\work\\demo',
      permission: { conversationId: 'conv_1', mode: 'auto', categories: { ...AUTHORIZATION_CATEGORIES }, pending: false, activeTurnMode: null,
        authorizations: [{ id: 'auth_7', categories: ['workspace_read_commands'], workspaceRoot: 'C:\\work\\demo', expiresAt, pinnedScripts: [] }] },
    }));
    const mode = screen.getByLabelText('Permission mode') as HTMLSelectElement;
    expect(mode.value).toBe('auto');
    expect(mode.selectedOptions[0].text).toMatch(/^Auto · until /);
    expect(screen.getByText(/^Auto until .+ in C:\\work\\demo\. Everything else still asks you\.$/)).toBeTruthy();
    expect(screen.getByText(AUTHORIZATION_CATEGORIES.workspace_read_commands)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(bridge.revokeAuthorization).toHaveBeenCalledWith('auth_7'));
  });
});
