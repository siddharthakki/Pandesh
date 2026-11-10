/** @vitest-environment jsdom */
/**
 * navigate_to in the two windows: each opens a registered place with its own navigation (v2 view switch, Classic
 * switchSurface and Connections tabs) and confirms to Core only what it then really shows. The host passes the request
 * on whatever task is running, and only messages typed in the window carry the window's interface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { UI_DESTINATIONS, destinationsFor } from '../../../core/shared/uiDestinations';
import { parseV2Target } from '../renderer-v2/src/navigationTargets';
import { DesktopSession } from '../src/host/desktopSession';

type Listener = (e: Record<string, unknown>) => void;
const navEvent = (target: string, surface: 'v2' | 'classic', id = `uinav_${Math.random().toString(36).slice(2)}`) =>
  ({ kind: 'navigate', at: new Date().toISOString(), navigation: { id, destination: 'x', target, label: 'x', surface } });

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('every registered v2 place is one the v2 window can open', () => {
  it('parses each v2 target and refuses anything else', () => {
    for (const d of destinationsFor('v2')) expect(parseV2Target(d.targets.v2!).kind, d.id).not.toBe('unknown');
    expect(parseV2Target('view:settings')).toEqual({ kind: 'unknown', detail: 'v2 has no view "settings"' });
    expect(parseV2Target('space:bluetooth').kind).toBe('unknown');
    expect(parseV2Target('surface:integrations').kind).toBe('unknown');
  });

  it('every Classic target names a page and tab the Classic window has', () => {
    const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
    for (const d of UI_DESTINATIONS) {
      const t = d.targets.classic;
      if (!t) continue;
      const [kind, rest] = t.split(':');
      if (kind === 'focus') { expect(html).toContain(rest === 'permission' ? 'id="permission-mode-select"' : 'id="model-select"'); continue; }
      const [page, tab] = rest.split('#')[0].split('/');
      expect(html, d.id).toContain(`data-surface="${page}"`);
      if (tab) expect(html, d.id).toContain(`data-conn-panel="${tab}"`);
    }
  });
});

describe('the v2 window', () => {
  it('switches to the place, then confirms what it shows; refuses what it cannot open', async () => {
    let listener: Listener = () => undefined;
    const confirmNavigation = vi.fn(async () => ({ recorded: true }));
    (window as unknown as { desktop: unknown }).desktop = {
      getSnapshot: async () => ({ coreState: 'connected', model: 'gemma4:12b', modelIsAuto: false, installedModels: ['gemma4:12b'], provider: 'ollama', selectedInferenceProvider: 'ollama', running: false, workspaceActivities: [], permission: { conversationId: null, mode: 'ask', authorizations: [], categories: {}, pending: false } }),
      getTaskOverview: async () => ({ tasks: [], queued: [] }),
      getUiVariant: async () => ({ variant: 'v2', forcedByEnv: false }),
      getAssistantBrief: async () => ({ generatedAt: '', home: [] }),
      listConversations: async () => [],
      household: async () => ({}),
      onEvent: (fn: Listener) => { listener = fn; return () => undefined; },
      confirmNavigation,
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { App } = await import('../renderer-v2/src/App');
    render(React.createElement(App));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const main = () => document.querySelector('.main')?.getAttribute('data-view');
    expect(main()).toBe('chat');

    await act(async () => { listener(navEvent('view:connections', 'v2', 'uinav_a')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(main()).toBe('connections');
    expect(confirmNavigation).toHaveBeenLastCalledWith('uinav_a', true, undefined, 'v2');

    await act(async () => { listener(navEvent('space:projects', 'v2', 'uinav_b')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(main()).toBe('workspace');
    expect(confirmNavigation).toHaveBeenLastCalledWith('uinav_b', true, undefined, 'v2');

    await act(async () => { listener(navEvent('menu:system', 'v2', 'uinav_c')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(document.querySelector('[role="dialog"][aria-label="System"]')).not.toBeNull();
    expect(confirmNavigation).toHaveBeenLastCalledWith('uinav_c', true, undefined, 'v2');

    await act(async () => { listener(navEvent('view:nowhere', 'v2', 'uinav_d')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(confirmNavigation).toHaveBeenLastCalledWith('uinav_d', false, 'v2 has no view "nowhere"', 'v2');

    await act(async () => { listener(navEvent('surface:integrations', 'classic', 'uinav_e')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(confirmNavigation).toHaveBeenLastCalledWith('uinav_e', false, 'this window shows the v2 interface', 'v2');
    vi.useRealTimers();
  });
});

describe('the Classic window', () => {
  it('opens Connections → Add / Configure with the Google setup, and confirms it', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
    document.body.innerHTML = (html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    (window as unknown as { jarvisVoiceCapture: unknown }).jarvisVoiceCapture = { startPushToTalkCapture: () => ({ stop: async () => null, cancel: () => undefined }), bytesToBase64: () => '' };
    const listeners: Listener[] = [];
    const confirmNavigation = vi.fn(async () => ({ recorded: true }));
    (window as unknown as { karkedikhaDesktop: unknown }).karkedikhaDesktop = {
      getSnapshot: async () => null, pickFolder: async () => null, submitTask: vi.fn(), cancel: vi.fn(), selectWorker: async () => null, selectProvider: async () => null,
      listModels: async () => [], selectModel: async () => null, transcribeUtterance: async () => ({ transcript: '', engine: 'whisper' }), getHostTelemetry: async () => null,
      onEvent: (fn: Listener) => { listeners.push(fn); return () => undefined; }, listArtifacts: async () => [], confirmNavigation,
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    (0, eval)(fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8'));
    const google = UI_DESTINATIONS.find((d) => d.id === 'google_setup')!.targets.classic!;
    for (const l of listeners) l(navEvent(google, 'classic', 'uinav_g'));
    await vi.waitFor(() => expect(confirmNavigation).toHaveBeenCalledWith('uinav_g', true, undefined, 'classic'));
    expect((document.querySelector('.app') as HTMLElement).dataset.activeSurface).toBe('integrations');
    expect((document.querySelector('[data-conn-panel="configure"]') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('google-setup') as HTMLDetailsElement).open).toBe(true);

    for (const l of listeners) l(navEvent('view:software', 'classic', 'uinav_h'));
    await vi.waitFor(() => expect(confirmNavigation).toHaveBeenCalledWith('uinav_h', false, 'the Classic interface cannot open "view:software"', 'classic'));
  });
});

describe('the desktop host', () => {
  it('passes a navigation request to the window even while another task runs, and tells Core the window', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-nav-host-'));
    try {
      let surface: 'v2' | 'classic' | null = 'v2';
      const host = new DesktopSession({ productRoot: process.cwd(), dataDir, uiSurface: () => surface });
      const internal = host as unknown as { active: unknown; client: unknown; coreState: string; handleRuntimeEvent(e: unknown): Promise<void>; uiSurfaceField(o?: string): Record<string, unknown> };
      const events: Array<Record<string, unknown>> = [];
      host.onEvent((e) => events.push(e as unknown as Record<string, unknown>));
      internal.active = { attemptId: 'att_long_task', requestId: 'r', conversationId: 'c', goal: 'long task', tokenBuffer: '', terminal: false };
      await internal.handleRuntimeEvent({ domain: 'ui_navigation', entityId: 'uinav_1', eventType: 'ui_navigation_requested', createdAt: new Date().toISOString(), metadata: { attemptId: 'att_side', destination: 'tools_skills', target: 'view:tools', label: 'Tools & Skills', surface: 'v2' } });
      expect(events.at(-1)).toMatchObject({ kind: 'navigate', attemptId: 'att_side', navigation: { id: 'uinav_1', target: 'view:tools', surface: 'v2' } });
      expect((internal.active as { terminal: boolean }).terminal).toBe(false);

      // The turn that asked is the running one: its event joins the task's own events, and the snapshot must still
      // build (a navigate event without a summary once broke every snapshot after "take me there").
      await internal.handleRuntimeEvent({ domain: 'ui_navigation', entityId: 'uinav_2', eventType: 'ui_navigation_requested', createdAt: new Date().toISOString(), metadata: { attemptId: 'att_long_task', destination: 'google_setup', target: 'view:connections', label: 'Google account setup (Gmail, Calendar)', surface: 'v2' } });
      expect(events.at(-1)).toMatchObject({ kind: 'navigate', summary: 'Opening Google account setup (Gmail, Calendar) in this window' });
      expect(() => host.snapshot()).not.toThrow();

      // Core replays earlier runtime events when the host connects: an old request must never move the window.
      const before = events.length;
      await internal.handleRuntimeEvent({ domain: 'ui_navigation', entityId: 'uinav_old', eventType: 'ui_navigation_requested', createdAt: new Date(Date.now() - 60_000).toISOString(), metadata: { attemptId: 'att_old', destination: 'projects', target: 'space:projects', label: 'Projects', surface: 'v2' } });
      expect(events.length).toBe(before);

      expect(internal.uiSurfaceField('desktop')).toEqual({ uiSurface: 'v2' });
      expect(internal.uiSurfaceField('mobile')).toEqual({});
      surface = null;
      expect(internal.uiSurfaceField('desktop')).toEqual({});

      const confirm = vi.fn(async () => ({ recorded: true }));
      internal.client = { confirmUiNavigation: confirm };
      internal.coreState = 'connected';
      await host.confirmNavigation('uinav_1', true, undefined, 'v2');
      expect(confirm).toHaveBeenCalledWith('uinav_1', { ok: true, surface: 'v2' });
      await expect(host.confirmNavigation('../../v1/attempts', true)).rejects.toThrow('unknown navigation');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
