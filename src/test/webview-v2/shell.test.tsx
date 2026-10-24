import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

afterEach(() => {
  cleanup();
  // @ts-expect-error test-only cleanup of the global the bridge caches
  delete window.acquireVsCodeApi;
});

async function renderAppWithFakeVsCodeApi() {
  const posted: unknown[] = [];
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => posted.push(msg),
    getState: () => undefined,
    setState: () => undefined,
  });
  vi.resetModules();
  const { App } = await import('../../webview-v2/App');
  render(<App />);
  return posted;
}

describe('UI v2 shell', () => {
  it('renders the header with KarkeDikha branding and New chat/History/Activity controls', async () => {
    await renderAppWithFakeVsCodeApi();
    expect(screen.getByText('KarkeDikha')).toBeTruthy();
    expect(screen.getByRole('button', { name: /New chat/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'History' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeTruthy();
  });

  it('renders the mode bar with exactly the three truthful 0.1 product modes (Ask/Plan hidden)', async () => {
    await renderAppWithFakeVsCodeApi();
    const group = screen.getByRole('radiogroup', { name: 'KarkeDikha mode' });
    for (const label of ['Baat Kar', 'Saath Kar', 'Karke Dikha']) {
      expect(within(group, label)).toBeTruthy();
    }
    for (const label of ['Ask', 'Plan']) {
      expect(within(group, label)).toBeFalsy();
    }
  });

  function within(group: HTMLElement, text: string) {
    return Array.from(group.querySelectorAll('button')).find((b) => b.textContent === text);
  }

  it('selecting Baat Kar emits webviewModeChanged with mode "chat"', async () => {
    const posted = await renderAppWithFakeVsCodeApi();
    fireEvent.click(screen.getByRole('radio', { name: 'Baat Kar' }));
    const msg = posted.find((m) => (m as { type: string }).type === 'webviewModeChanged');
    expect(msg).toEqual({ type: 'webviewModeChanged', mode: 'chat' });
  });

  it('selecting Karke Dikha emits webviewModeChanged with mode "autonomous"', async () => {
    const posted = await renderAppWithFakeVsCodeApi();
    fireEvent.click(screen.getByRole('radio', { name: 'Karke Dikha' }));
    const msg = posted.find((m) => (m as { type: string }).type === 'webviewModeChanged');
    expect(msg).toEqual({ type: 'webviewModeChanged', mode: 'autonomous' });
  });

  it('New Chat emits the existing newConversation host path', async () => {
    const posted = await renderAppWithFakeVsCodeApi();
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
    expect(posted.find((m) => (m as { type: string }).type === 'newConversation')).toEqual({
      type: 'newConversation',
    });
  });

  it('History opens the history drawer', async () => {
    await renderAppWithFakeVsCodeApi();
    expect(screen.queryByRole('region', { name: 'Conversation history' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('region', { name: 'Conversation history' })).toBeTruthy();
  });

  it('Activity opens the activity panel', async () => {
    await renderAppWithFakeVsCodeApi();
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByRole('region', { name: 'Activity' })).toBeTruthy();
  });

  it('status strip reflects supplied provider/model/mode state', async () => {
    // Real production events only: mode comes from the user's own local mode
    // selection (`mode_changed`, dispatched by ModeBar's onSelect — no host
    // round-trip), and provider/model come from the real `modelSuitability`
    // message AgentPanel actually posts (`modelSelected`/`modeExecutionStarted`
    // are not messages AgentPanel ever sends — see src/shared/webviewProtocol.ts).
    await renderAppWithFakeVsCodeApi();
    fireEvent.click(screen.getByRole('radio', { name: 'Baat Kar' }));
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'modelSuitability', summary: 'ok', details: { selectedProvider: 'ollama', selectedModel: 'qwen3' } },
        }),
      );
    });
    const status = document.querySelector('.kd2-status-bar') as HTMLElement;
    expect(status.textContent).toContain('Baat Kar');
    expect(status.textContent).toContain('ollama/qwen3');
  });

  it('transcript still renders markdown-plain content and the composer still submits', async () => {
    const posted = await renderAppWithFakeVsCodeApi();
    fireEvent.change(screen.getByPlaceholderText('Ask KarkeDikha…'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('hello')).toBeTruthy();
    expect(posted.find((m) => (m as { type: string }).type === 'sendMessage')).toBeTruthy();
  });

  it('streaming still works end to end through the shell', async () => {
    await renderAppWithFakeVsCodeApi();
    fireEvent.change(screen.getByPlaceholderText('Ask KarkeDikha…'), { target: { value: 'stream please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'token', delta: 'partial ' } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'token', delta: 'reply' } }));
    });
    expect(await screen.findByText('partial reply')).toBeTruthy();
  });

  it('does not register duplicate global message listeners across a re-render', async () => {
    const originalAdd = window.addEventListener.bind(window);
    let count = 0;
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'message') count += 1;
      return originalAdd(type, listener as EventListener, opts as boolean | AddEventListenerOptions);
    }) as typeof window.addEventListener;

    vi.resetModules();
    const { App } = await import('../../webview-v2/App');
    (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    });
    const { unmount } = render(<App />);
    expect(count).toBe(1);
    unmount();
    window.addEventListener = originalAdd;
  });
});
