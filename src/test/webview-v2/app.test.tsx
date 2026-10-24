import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

afterEach(() => {
  cleanup();
  // @ts-expect-error test-only cleanup of the global the bridge caches
  delete window.acquireVsCodeApi;
});

// bridge/vscodeApi.ts caches acquireVsCodeApi() in a module-level singleton
// (mirroring the real VS Code webview constraint of calling it only once), so
// each test must reset the module registry and re-import App to get an
// isolated fake vscode API instance instead of leaking the previous test's.
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

describe('App (submit -> host message -> assistant reply)', () => {
  it('sends a legacy sendMessage on submit and renders the assistant reply once it arrives', async () => {
    const posted = await renderAppWithFakeVsCodeApi();

    const textarea = screen.getByPlaceholderText('Ask KarkeDikha…');
    fireEvent.change(textarea, { target: { value: 'hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('hello there')).toBeTruthy();
    const sent = posted.find((m) => (m as { type: string }).type === 'sendMessage') as
      | { text: string }
      | undefined;
    expect(sent?.text).toBe('hello there');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'assistantContent', content: 'hi back' } }),
      );
    });

    expect(await screen.findByText('hi back')).toBeTruthy();
  });

  it('announces webviewReady using the real AgentPanel handshake shape on mount', async () => {
    const posted = await renderAppWithFakeVsCodeApi();
    const ready = posted.find((m) => (m as { type: string }).type === 'webviewReady');
    expect(ready).toEqual({ type: 'webviewReady', mode: 'agent' });
  });

  it('production Baat Kar path: submit -> token stream -> done renders exactly one assistant message and re-enables the composer', async () => {
    await renderAppWithFakeVsCodeApi();

    fireEvent.change(screen.getByPlaceholderText('Ask KarkeDikha…'), { target: { value: 'explain the build' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect((screen.getByPlaceholderText('Ask KarkeDikha…') as HTMLTextAreaElement).disabled).toBe(true);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'token', delta: 'The build ' } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'token', delta: 'uses esbuild.' } }));
    });
    expect(await screen.findByText('The build uses esbuild.')).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'done', content: 'The build uses esbuild.', messageId: 'srv-1' },
        }),
      );
    });

    expect(await screen.findByText('The build uses esbuild.')).toBeTruthy();
    expect(screen.getAllByText('The build uses esbuild.')).toHaveLength(1);
    expect((screen.getByPlaceholderText('Ask KarkeDikha…') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('production error path: backend error surfaces visibly and the composer becomes usable again', async () => {
    await renderAppWithFakeVsCodeApi();

    fireEvent.change(screen.getByPlaceholderText('Ask KarkeDikha…'), { target: { value: 'do something' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((screen.getByPlaceholderText('Ask KarkeDikha…') as HTMLTextAreaElement).disabled).toBe(true);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'error', message: 'execution failed' } }),
      );
    });

    expect(await screen.findByText('execution failed')).toBeTruthy();
    expect((screen.getByPlaceholderText('Ask KarkeDikha…') as HTMLTextAreaElement).disabled).toBe(false);
  });
});
