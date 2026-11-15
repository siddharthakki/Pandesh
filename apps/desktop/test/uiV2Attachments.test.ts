/** @vitest-environment jsdom */
/** v2 composer attachments: the pure rules, then the real hook against a mocked host bridge. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { canSend, dragHasFiles, formatBytes, goalFor, nameForFile, summary } from '../renderer-v2/src/attachmentModel';

describe('attachment rules', () => {
  it('sends files with no text using the Classic fallback wording, and never an empty message', () => {
    expect(goalFor('', [])).toBe('');
    expect(goalFor('  ', [{}])).toBe('Please look at the attached file.');
    expect(goalFor('', [{}, {}])).toBe('Please look at the attached files.');
    expect(goalFor(' what is this? ', [{}])).toBe('what is this?');
    expect(canSend('', [])).toBe(false);
    expect(canSend('', [{}])).toBe(true);
    expect(canSend('hi', [])).toBe(true);
  });
  it('formats sizes and names pasted images', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1048576)).toBe('3.0 MB');
    expect(nameForFile({ name: 'image.png', type: 'image/png' })).toBe('pasted-image.png');
    expect(nameForFile({ name: '', type: 'image/jpeg' }, 1)).toBe('pasted-image-2.jpg');
    expect(nameForFile({ name: 'report.pdf', type: 'application/pdf' })).toBe('report.pdf');
    expect(summary([{ name: 'a.png' }, { name: 'b.png' }])).toBe('a.png and 1 more');
  });
  it('treats only drags that carry files as attachments', () => {
    expect(dragHasFiles(['Files'])).toBe(true);
    expect(dragHasFiles(['text/plain', 'text/uri-list'])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});

const bridge = {
  pickAttachments: vi.fn(async () => ({ cancelled: false, errors: [] as string[] })),
  stageAttachmentBytes: vi.fn(async (_n: string, _b: Uint8Array) => ({ ok: true } as { ok: boolean; error?: string })),
  removeAttachment: vi.fn(async (_id: string) => undefined),
  onEvent: () => () => undefined,
};
let useAttachments: typeof import('../renderer-v2/src/Attachments').useAttachments;
beforeAll(async () => {
  (window as unknown as { desktop: unknown }).desktop = bridge;
  ({ useAttachments } = await import('../renderer-v2/src/Attachments'));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Harness({ staged, refresh, onNotice }: { staged: unknown[]; refresh: () => void; onNotice: (n: unknown) => void }) {
  const a = useAttachments({ snapshot: { stagedAttachments: staged } as never, refresh, onNotice, disabled: false });
  return React.createElement('div', { 'data-testid': 'box', onPaste: a.onPaste }, a.button, a.strip, a.overlay);
}
const file = (name: string, type: string, bytes = [1, 2, 3]) => {
  const f = new File([new Uint8Array(bytes)], name, { type });
  // jsdom lacks File.arrayBuffer in some versions
  if (!f.arrayBuffer) (f as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => new Uint8Array(bytes).buffer;
  return f;
};

describe('attachments in the composer', () => {
  it('opens the host file dialog from the paperclip and refreshes', async () => {
    const refresh = vi.fn();
    render(React.createElement(Harness, { staged: [], refresh, onNotice: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    await waitFor(() => expect(bridge.pickAttachments).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('shows host-staged files as chips and removes one through the host', async () => {
    const refresh = vi.fn();
    render(React.createElement(Harness, { staged: [{ id: 'att_1', name: 'plan.pdf', kind: 'document', byteSize: 2048 }], refresh, onNotice: vi.fn() }));
    expect(screen.getByText('plan.pdf')).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove plan.pdf' }));
    await waitFor(() => expect(bridge.removeAttachment).toHaveBeenCalledWith('att_1'));
  });

  it('stages a pasted image through the host and leaves plain-text paste alone', async () => {
    const refresh = vi.fn();
    render(React.createElement(Harness, { staged: [], refresh, onNotice: vi.fn() }));
    const box = screen.getByTestId('box');
    fireEvent.paste(box, { clipboardData: { files: [file('image.png', 'image/png')], getData: () => '' } });
    await waitFor(() => expect(bridge.stageAttachmentBytes).toHaveBeenCalledTimes(1));
    expect(bridge.stageAttachmentBytes.mock.calls[0][0]).toBe('pasted-image.png');
    bridge.stageAttachmentBytes.mockClear();
    fireEvent.paste(box, { clipboardData: { files: [], getData: () => 'just text' } });
    expect(bridge.stageAttachmentBytes).not.toHaveBeenCalled();
  });

  it('stages dropped files and reports a refusal from the host', async () => {
    const onNotice = vi.fn();
    bridge.stageAttachmentBytes.mockResolvedValueOnce({ ok: false, error: '"big.bin" is 40.0 MB; the limit is 20 MB per file.' });
    render(React.createElement(Harness, { staged: [], refresh: vi.fn(), onNotice }));
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
    drop.dataTransfer = { types: ['Files'], files: [file('big.bin', 'application/octet-stream')] };
    window.dispatchEvent(drop);
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith({ text: '"big.bin" is 40.0 MB; the limit is 20 MB per file.', error: true }));
    // a text drag is ignored
    bridge.stageAttachmentBytes.mockClear();
    const textDrop = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
    textDrop.dataTransfer = { types: ['text/plain'], files: [] };
    window.dispatchEvent(textDrop);
    expect(bridge.stageAttachmentBytes).not.toHaveBeenCalled();
  });
});
