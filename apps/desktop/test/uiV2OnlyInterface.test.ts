/** @vitest-environment jsdom */
/**
 * v2 is the only Pandesh interface (the Classic renderer was retired). These cover what moved from Classic into v2,
 * placed where the v2 plan puts it: the chats drawer (rename, pin, archive, restore, export), composer attachments
 * (pick, drop, paste, remove, send with files and no text), the consent before a chat runs on a free cloud model,
 * worker requests on every view, Automations (reminders, daily brief, command queue), notes, Diagnostics, and that
 * nothing in the window offers a Classic interface any more.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Snap = Record<string, any>;
let snap: Snap;
const conversations = [
  { id: 'c1', title: 'Tax letter', preview: 'about the tax letter', state: 'completed', updatedAt: new Date().toISOString(), archivedAt: null, pinnedAt: null },
  { id: 'c2', title: 'Old trip', preview: 'trip to Ulm', state: 'failed', updatedAt: '2026-01-02T10:00:00.000Z', archivedAt: null, pinnedAt: '2026-01-03T10:00:00.000Z' },
];
const bridge: Record<string, any> = {
  onEvent: () => () => undefined,
  getSnapshot: vi.fn(async () => snap),
  getTaskOverview: vi.fn(async () => ({ tasks: [], queued: [] })),
  getAssistantBrief: vi.fn(async () => ({ generatedAt: '', home: [] })),
  listConversations: vi.fn(async () => conversations),
  openConversation: vi.fn(async (id: string) => ({ conversation: conversations[0], messages: [], context: null, id })),
  newConversation: vi.fn(async () => undefined),
  renameConversation: vi.fn(async () => conversations),
  pinConversation: vi.fn(async () => conversations),
  unpinConversation: vi.fn(async () => conversations),
  archiveConversation: vi.fn(async () => conversations),
  unarchiveConversation: vi.fn(async () => conversations),
  searchConversations: vi.fn(async () => []),
  exportConversation: vi.fn(async () => ({ saved: true, path: 'D:\\Exports\\tax-letter.md' })),
  pickAttachments: vi.fn(async () => ({ cancelled: false, errors: [] })),
  stageAttachmentBytes: vi.fn(async () => ({ ok: true })),
  removeAttachment: vi.fn(async () => undefined),
  submitTask: vi.fn(async () => ({ attemptId: 'a', requestId: 'r', model: 'm' })),
  selectModel: vi.fn(async () => snap),
  getDevStories: vi.fn(async () => ({ available: true, counts: {}, stories: [] })),
  decideDevStoryPermission: vi.fn(async () => ({ ok: true })),
  household: vi.fn(async () => ({})),
  createNote: vi.fn(async () => snap),
  updateNote: vi.fn(async () => snap),
  deleteNote: vi.fn(async () => snap),
  createReminder: vi.fn(async () => snap),
  completeReminder: vi.fn(async () => snap),
  cancelReminder: vi.fn(async () => snap),
  confirmCommandRun: vi.fn(async () => snap),
  skipCommand: vi.fn(async () => snap),
  enqueueCommand: vi.fn(async () => snap),
  getDailyBriefRoutine: vi.fn(async () => null),
  configureDailyBriefRoutine: vi.fn(async () => null),
  probeImageStudio: vi.fn(async () => ({ studio: false, comfyui: false, ollama: true, detail: '', checkpoints: [] })),
  listArtifacts: vi.fn(async () => []),
};

let App: typeof import('../renderer-v2/src/App').App;
let useComposerControls: typeof import('../renderer-v2/src/ComposerControls').useComposerControls;
let attachments: typeof import('../renderer-v2/src/attachments');
let chats: typeof import('../renderer-v2/src/Chats');
let about: typeof import('../renderer-v2/src/About');
let dev: typeof import('../renderer-v2/src/DevStories');

beforeAll(async () => {
  (window as unknown as { desktop: unknown }).desktop = bridge;
  (window as unknown as { jarvisVoiceCapture: unknown }).jarvisVoiceCapture = { startWakeMonitor: () => ({ stop() {} }), bytesToBase64: () => '' };
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  ({ App } = await import('../renderer-v2/src/App'));
  ({ useComposerControls } = await import('../renderer-v2/src/ComposerControls'));
  attachments = await import('../renderer-v2/src/attachments');
  chats = await import('../renderer-v2/src/Chats');
  about = await import('../renderer-v2/src/About');
  dev = await import('../renderer-v2/src/DevStories');
});

const baseSnap = (): Snap => ({
  coreState: 'connected', model: 'gemma4:12b', modelIsAuto: false, installedModels: ['gemma4:12b'], provider: 'ollama', selectedInferenceProvider: 'ollama',
  running: false, workspaceActivities: [], selectedConversationId: null, activeConversationId: null,
  permission: { conversationId: null, mode: 'ask', authorizations: [], categories: {}, pending: false },
  everydayTools: { timezone: 'Europe/Berlin', catalog: [], notes: [], reminders: [], activeTimers: [] },
  commandQueue: { active: null, confirming: null, waiting: [], recentTerminal: [] },
  stagedAttachments: [],
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('no Classic interface is left', () => {
  it('the window, the host and the renderer never offer or load a Classic interface', () => {
    const root = path.join(__dirname, '..');
    expect(fs.existsSync(path.join(root, 'renderer', 'index.html'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'renderer', 'renderer.js'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'renderer', 'voiceCapture.js'))).toBe(true); // v2 voice uses it
    const main = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
    expect(main).toContain("path.join(__dirname, '..', 'renderer', 'v2', 'index.html')");
    expect(main).not.toMatch(/setUiVariant|getUiVariant|PANDESH_UI_V2/);
    for (const f of fs.readdirSync(path.join(root, 'renderer-v2', 'src')).filter((x) => /\.tsx?$/.test(x))) {
      const src = fs.readFileSync(path.join(root, 'renderer-v2', 'src', f), 'utf8');
      expect(src, f).not.toMatch(/Use the Classic UI|setUiVariant|chosen in the Classic UI/);
    }
  });
});

describe('chats drawer', () => {
  it('groups pinned chats first, then by day', () => {
    const groups = chats.groupConversations(conversations as never, new Date());
    expect(groups.map((g) => g.label)).toEqual(['Pinned', 'Today']);
    expect(chats.dayBucket(new Date(Date.now() - 86_400_000).toISOString())).toBe('Yesterday');
  });

  it('opens from the chat, renames, pins, archives and exports through the host', async () => {
    snap = baseSnap();
    render(React.createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'Open chats' }));
    const drawer = await screen.findByRole('complementary', { name: 'Chats' });
    await waitFor(() => expect(drawer.textContent).toContain('Tax letter'));
    const row = screen.getByText('Tax letter').closest('li')!;
    fireEvent.click(row.querySelector('button[aria-pressed]')!); // Pin
    await waitFor(() => expect(bridge.pinConversation).toHaveBeenCalledWith('c1'));
    fireEvent.click([...row.querySelectorAll('button')].find((b) => b.textContent === 'Export')!);
    await waitFor(() => expect(drawer.textContent).toContain('Saved to D:\\Exports\\tax-letter.md'));
    fireEvent.click([...row.querySelectorAll('button')].find((b) => b.textContent === 'Rename')!);
    const input = row.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'Tax letter 2026' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(bridge.renameConversation).toHaveBeenCalledWith('c1', 'Tax letter 2026'));
    const archive = [...screen.getByText('Tax letter').closest('li')!.querySelectorAll('button')].find((b) => b.textContent === 'Archive')!;
    fireEvent.click(archive);
    await waitFor(() => expect(bridge.archiveConversation).toHaveBeenCalledWith('c1'));
  });
});

describe('composer attachments', () => {
  it('names a pasted picture by its time and words sizes plainly', () => {
    expect(attachments.pastedName('image.png', new Date(2026, 10, 12, 9, 5, 7))).toBe('pasted-20261112-090507.png');
    expect(attachments.pastedName('scan.pdf')).toBe('scan.pdf');
    expect(attachments.formatBytes(2048)).toBe('2.0 KB');
    expect(attachments.formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(attachments.defaultAttachmentText(2)).toBe('Please look at the attached files.');
  });

  it('shows staged files, removes one, and sends files without typed text', async () => {
    snap = { ...baseSnap(), stagedAttachments: [{ id: 'att1', name: 'invoice.pdf', byteSize: 52_000, kind: 'document', mimeType: 'application/pdf' }] };
    render(React.createElement(App));
    const chip = await screen.findByText('invoice.pdf');
    expect((screen.getByLabelText('Message Pandesh') as HTMLTextAreaElement).placeholder).toMatch(/Add a message about your file/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove invoice.pdf' }));
    await waitFor(() => expect(bridge.removeAttachment).toHaveBeenCalledWith('att1'));
    expect(chip).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(bridge.submitTask).toHaveBeenCalledWith('Please look at the attached file.'));
    fireEvent.click(screen.getByRole('button', { name: 'Attach files or images' }));
    await waitFor(() => expect(bridge.pickAttachments).toHaveBeenCalled());
  });
});

describe('free cloud model for chats', () => {
  function Harness() {
    const c = useComposerControls({ snapshot: snap as never, refresh: () => undefined, onNotice: () => undefined, disabled: false });
    return React.createElement('div', null, c.panel, c.controls);
  }
  it('offers enabled providers\' free models and asks before the chat runs in the cloud', async () => {
    snap = { ...baseSnap(), cloud: { selectedModel: null, providers: [{ id: 'groq', displayName: 'Groq', enabled: true, configured: true }], listings: { groq: { pool: [{ id: 'llama-free', displayName: 'Llama free' }] } } } };
    render(React.createElement(Harness));
    const menu = screen.getByLabelText('Model for your next message') as HTMLSelectElement;
    expect([...menu.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Free cloud — the whole chat runs there']);
    fireEvent.change(menu, { target: { value: 'groq::llama-free' } });
    expect(bridge.selectModel).not.toHaveBeenCalled();
    expect(screen.getByText(/Run your chats on llama-free \(Groq\)\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the current model' }));
    expect(bridge.selectModel).not.toHaveBeenCalled();
    fireEvent.change(menu, { target: { value: 'groq::llama-free' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this cloud model' }));
    await waitFor(() => expect(bridge.selectModel).toHaveBeenCalledWith('groq::llama-free'));
  });
});

describe('worker requests, Automations, notes and Diagnostics', () => {
  it('shows a held worker request on every view, with Allow once and Deny', async () => {
    snap = baseSnap();
    bridge.getDevStories.mockResolvedValue({ available: true, counts: {}, stories: [{ id: 's1', title: 'Fix login · coding', status: 'implementing', phase: 'implementing', pendingApprovals: [{ pendingId: 'p1', what: 'npm install left-pad' }] }] });
    expect(dev.pendingWorkerRequests({ available: true, counts: {}, stories: [{ id: 's', title: 't', status: 'x', phase: 'x', pendingApprovals: [{ pendingId: 'p', what: 'w' }] }] })).toHaveLength(1);
    render(React.createElement(App));
    const banner = await screen.findByRole('region', { name: 'Worker requests waiting for you' });
    expect(banner.textContent).toContain('Fix login worker wants to run:');
    expect(banner.textContent).toContain('npm install left-pad');
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(bridge.decideDevStoryPermission).toHaveBeenCalledWith('s1', 'p1', true));
    bridge.getDevStories.mockResolvedValue({ available: true, counts: {}, stories: [] });
  });

  it('Automations: confirm the next queued instruction, set a reminder, and keep reminders with timers', async () => {
    snap = { ...baseSnap(), commandQueue: { active: null, confirming: { id: 'q1', ordinal: 1, status: 'awaiting_confirmation', title: 'Summarize notes', instruction: 'Summarize my notes', revision: 2, confirmationToken: 'tok', confirmationExpiresAt: null, dependsOnId: null, outcome: null, lastError: null, postponedUntil: null }, waiting: [], recentTerminal: [] } };
    render(React.createElement(App));
    await screen.findByRole('button', { name: 'Open chats' });
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    fireEvent.click(screen.getByText('Automations'));
    const confirm = await screen.findByLabelText('Confirm the next queued instruction');
    fireEvent.click([...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Run it')!);
    await waitFor(() => expect(bridge.confirmCommandRun).toHaveBeenCalledWith('q1', 'tok', 2));
    fireEvent.change(screen.getByLabelText('Remind me to'), { target: { value: 'Call the dentist' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set reminder' }));
    await waitFor(() => expect(bridge.createReminder).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call the dentist', timezone: 'Europe/Berlin' })));
  });

  it('Diagnostics words the build and the last update plainly', () => {
    expect(about.buildLabel({ buildKind: 'release', buildNumber: 166 } as never)).toBe('b166');
    expect(about.buildLabel({ buildKind: 'development', buildNumber: null } as never)).toMatch(/development build/);
    expect(about.updateLine({ available: false, installedRevision: 166, version: '0.1.8', lastResult: null })).toMatch(/installer/);
    expect(about.updateLine({ available: true, installedRevision: 166, version: '0.1.8', lastResult: { status: 'rolled_back', at: '', acknowledged: false, revision: 166, attemptedRevision: 167, reason: 'did not start' } })).toMatch(/b167 did not start correctly and was undone\. You are on b166/);
  });
});
