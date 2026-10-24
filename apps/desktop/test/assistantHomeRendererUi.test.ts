/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEverydayIntent } from '../src/host/everydayToolsIntent';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: unknown = null;
let brief: unknown = null;
const listeners: Array<() => void> = [];
const desktopApi: Record<string, (...args: unknown[]) => unknown> = {};
const resolveAssistantApproval = vi.fn(async () => ({ status: 'approved' }));
const cancelTask = vi.fn(async () => ({ requested: true }));

function item(extra: Record<string, unknown> = {}) {
  return {
    id: 'approval:ap_1',
    kind: 'approval',
    stance: 'fact',
    title: 'Approval needed — write invoice.html',
    detail: 'C:/repo/invoice.html · asked 2 minutes ago',
    state: 'pending',
    at: new Date(Date.now() - 120_000).toISOString(),
    source: { kind: 'core_approval', label: 'KarkeDikha approval', reference: 'ap_1', checkedAt: new Date().toISOString() },
    actions: [
      { kind: 'resolve_approval', label: 'Approve', approvalId: 'ap_1', attemptId: 'att_1', conversationId: 'conv_1' },
      { kind: 'resolve_approval', label: 'Reject', approvalId: 'ap_1', attemptId: 'att_1', conversationId: 'conv_1' },
    ],
    ...extra,
  };
}

function makeBrief(items: unknown[], todaySections: unknown[] = []) {
  return {
    generatedAt: new Date().toISOString(),
    timezone: 'UTC',
    home: items,
    today: todaySections,
    services: [{ id: 'gmail', label: 'Gmail', state: 'not_configured', reason: 'Gmail credential is not configured', checkedAt: new Date().toISOString() }],
    markdown: '**Your brief**',
  };
}

const CALENDAR_UNAVAILABLE = {
  id: 'calendar',
  label: 'Calendar commitments',
  available: false,
  unavailableReason: 'Google Calendar is not connected',
  items: [],
};

const WORK_SECTION = {
  id: 'work',
  label: 'Pending work',
  available: true,
  unavailableReason: null,
  items: [{
    id: 'task:att_1',
    kind: 'task_running',
    stance: 'fact',
    title: 'Working on it now',
    detail: 'Draft the proposal — Running read_file',
    state: 'running',
    at: new Date().toISOString(),
    source: { kind: 'core_attempt', label: 'KarkeDikha task', reference: 'att_1', checkedAt: new Date().toISOString() },
    actions: [],
  }],
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
    listConversations: async () => [],
    searchConversations: async () => ({ results: [] }),
    newConversation: async () => undefined,
    getTaskOverview: async () => ({ tasks: [], queued: [] }),
    cancelTask,
    resolveAssistantApproval,
    getAssistantBrief: async () => brief,
    connectGmail: vi.fn(async () => ({})),
    retryGmailProbe: vi.fn(async () => ({})),
    disconnectGmail: vi.fn(async () => ({})),
    cancelGoogleConnect: vi.fn(async () => ({})),
    saveGoogleOAuthClient: vi.fn(async () => ({})),
    openExternalUrl: vi.fn(async () => ({ opened: true })),
  });
  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = desktopApi;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const el = (id: string) => document.getElementById(id) as HTMLElement | null;

beforeEach(() => {
  resolveAssistantApproval.mockClear();
  cancelTask.mockClear();
});

describe('the Home shows what genuinely needs attention', () => {
  it('keeps the calm panda welcome when there is nothing to show', async () => {
    brief = makeBrief([]);
    await (window as unknown as { refreshAssistantBrief: (o?: unknown) => Promise<unknown> }).refreshAssistantBrief({ external: false });
    await settle();

    expect(el('home-attention')?.hidden).toBe(true);
    expect(el('home-today')?.hidden).toBe(true);
    // The approved panda welcome is untouched.
    expect(document.querySelector('.panda-hero-art')).not.toBeNull();
    expect(el('assistant-subline')?.textContent).toContain('ready');
  });

  it('shows a card with the real source, the real state, and working actions', async () => {
    brief = makeBrief([item()]);
    await (window as unknown as { refreshAssistantBrief: (o?: unknown) => Promise<unknown> }).refreshAssistantBrief({ external: false });
    await settle();

    expect(el('home-attention')?.hidden).toBe(false);
    const card = document.querySelector('#home-attention-list .ws-attention-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.dataset.kind).toBe('approval');
    expect(card.textContent).toContain('write invoice.html');
    expect(card.textContent).toContain('KarkeDikha approval');
    expect(card.textContent).toContain('pending');
  });

  it('keeps running and finished work out of "Needs you" and shows it as quiet Recent history', async () => {
    const running = item({ id: 'task:att_2', kind: 'task_running', title: 'Working on it now', detail: 'Draft the proposal — Running read_file', state: 'running', actions: [{ kind: 'open_conversation', label: 'Open conversation', conversationId: 'conv_2' }] });
    const done = item({ id: 'task:att_3', kind: 'task_completed', title: 'Finished', detail: 'Plan the trip — Finished', state: 'completed', actions: [] });
    brief = makeBrief([running, done]);
    await (window as unknown as { refreshAssistantBrief: (o?: unknown) => Promise<unknown> }).refreshAssistantBrief({ external: false });
    await settle();

    expect(el('home-attention')?.hidden).toBe(true);
    expect(document.querySelectorAll('#home-attention-list .ws-attention-card')).toHaveLength(0);
    expect(el('home-recent')?.hidden).toBe(false);
    expect(document.querySelectorAll('#home-recent-list .ws-recent-row')).toHaveLength(2);
    expect(el('assistant-subline')?.textContent).toContain('Nothing needs you');
  });

  it('keeps a real approval and a failure in "Needs you" beside recent work', async () => {
    const failed = item({ id: 'task:att_4', kind: 'task_failed', title: 'Failed — a task did not finish', state: 'failed', actions: [] });
    const running = item({ id: 'task:att_5', kind: 'task_running', title: 'Working on it now', state: 'running', actions: [] });
    brief = makeBrief([item(), failed, running]);
    await (window as unknown as { refreshAssistantBrief: (o?: unknown) => Promise<unknown> }).refreshAssistantBrief({ external: false });
    await settle();

    expect(document.querySelectorAll('#home-attention-list .ws-attention-card')).toHaveLength(2);
    expect(el('home-attention-title')?.textContent).toContain('2 items');
    expect(document.querySelectorAll('#home-recent-list .ws-recent-row')).toHaveLength(1);
  });

  it('completes an approval from its visible card', async () => {
    brief = makeBrief([item()]);
    await (window as unknown as { refreshAssistantBrief: (o?: unknown) => Promise<unknown> }).refreshAssistantBrief({ external: false });
    await settle();

    const approve = [...Array.from(document.querySelectorAll('#home-attention-list .ws-chip'))].find((b) => b.textContent === 'Approve') as HTMLButtonElement;
    expect(approve).toBeTruthy();
    approve.click();
    await settle();

    expect(resolveAssistantApproval).toHaveBeenCalledWith('ap_1', 'approved');
  });

  it('says plainly when a service could not be read, instead of pretending it was empty', async () => {
    brief = makeBrief([], [CALENDAR_UNAVAILABLE]);
    await (window as unknown as { refreshAssistantBrief: (o?: unknown) => Promise<unknown> }).refreshAssistantBrief({ external: false });
    await settle();

    const calendar = document.querySelector('#home-today-list .ws-today-section[data-section="calendar"]') as HTMLElement;
    expect(calendar).not.toBeNull();
    expect(calendar.textContent).toContain('Google Calendar is not connected');
  });

  it('shows real pending work under Today', async () => {
    brief = makeBrief([], [WORK_SECTION]);
    await (window as unknown as { refreshAssistantBrief: (o?: unknown) => Promise<unknown> }).refreshAssistantBrief({ external: false });
    await settle();

    expect(el('home-today')?.hidden).toBe(false);
    const work = document.querySelector('#home-today-list .ws-today-section[data-section="work"]') as HTMLElement;
    expect(work.textContent).toContain('Working on it now');
  });
});

describe('the transcript never repeats a turn', () => {
  const render = (container: HTMLElement, messages: unknown[]) =>
    (window as unknown as { renderConversationTranscript: (c: HTMLElement, m: unknown[]) => void }).renderConversationTranscript(container, messages);
  const userRows = (c: HTMLElement) => c.querySelectorAll(':scope > .transcript-row-user');
  const long = ['Section one.', 'Section two.', 'Section three. Reply OK.'].join(String.fromCharCode(10, 10));

  it('does not re-append a durable user turn when the transcript refreshes', () => {
    const container = document.createElement('div');
    render(container, [{ role: 'user', content: long }]);
    render(container, [{ role: 'user', content: long }, { role: 'assistant', content: 'OK' }]);
    expect(userRows(container)).toHaveLength(1);
    expect(container.textContent).toContain('Section three. Reply OK.');
  });

  it('keeps a just-sent turn the durable transcript does not carry yet, and drops it once it does', () => {
    const container = document.createElement('div');
    const echo = document.createElement('div');
    echo.className = 'conversation-paragraph-row transcript-row-user';
    echo.dataset.liveEcho = '1';
    const body = document.createElement('div');
    body.className = 'transcript-body';
    body.textContent = long;
    echo.appendChild(body);
    container.appendChild(echo);
    render(container, []);
    expect(userRows(container)).toHaveLength(1);
    render(container, [{ role: 'user', content: long }]);
    expect(userRows(container)).toHaveLength(1);
    expect((userRows(container)[0] as HTMLElement).dataset.liveEcho).toBeUndefined();
  });
});

describe('asking for the briefing in conversation', () => {
  it('recognises a request for the briefing', () => {
    expect(parseEverydayIntent('What is on my plate today?')?.kind).toBe('daily_brief');
    expect(parseEverydayIntent("What's on my plate today?")?.kind).toBe('daily_brief');
    expect(parseEverydayIntent('Give me my daily brief for today.')?.kind).toBe('daily_brief');
    expect(parseEverydayIntent('refresh my brief')?.kind).toBe('daily_brief');
  });

  it('never hijacks an ordinary request', () => {
    expect(parseEverydayIntent('Build a small app for me.')?.kind).not.toBe('daily_brief');
    expect(parseEverydayIntent('The brief is in README.md, read it and summarise it for the team')?.kind).not.toBe('daily_brief');
    expect(parseEverydayIntent('Refactor the brief parser in src/brief.ts to be faster')?.kind).not.toBe('daily_brief');
  });
});
