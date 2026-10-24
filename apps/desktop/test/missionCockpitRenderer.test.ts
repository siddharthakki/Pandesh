/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COCKPIT_VISIBLE_LIMIT } from '../src/host/missionCockpit';
import type { ConversationOpenResult, ConversationRailEntryView, ConversationSearchResultView, DesktopSnapshot } from '../src/ipc';
import {
  APPROVED_CARD,
  LONG_PYTHON_TODO_RESPONSE,
  RECORDED_RESULT,
  cockpitInput,
  desktopSnapshotFromEvents,
  recorded120,
  eventFromSummary,
  RECORDED_START,
} from './recordedMissionStream';

declare global {
  interface Window {
    karkedikhaDesktop: {
      getSnapshot: () => Promise<DesktopSnapshot | null>;
      pickFolder: () => Promise<DesktopSnapshot | null>;
      submitTask: (goal: string, worker?: string) => Promise<{ requestId: string; attemptId: string; model: string }>;
      continueTask: (predecessorAttemptId: string, guidance: string) => Promise<{ requestId: string; attemptId: string; model: string }>;
      cancel: () => Promise<void>;
      resolveApproval: (approvalId: string, resolution: string) => Promise<void>;
      setOpenRouterApiKey: (apiKey: string) => Promise<{ keyConfigured: boolean }>;
      clearOpenRouterApiKey: () => Promise<{ keyConfigured: boolean }>;
      selectProvider: (provider: 'ollama' | 'openrouter') => Promise<DesktopSnapshot | null>;
      selectWorker: (worker: string) => Promise<DesktopSnapshot | null>;
      listModels: () => Promise<string[]>;
      selectModel: (model: string) => Promise<DesktopSnapshot | null>;
      transcribeUtterance: (wavBase64: string) => Promise<{ transcript: string; engine: string }>;
      getHostTelemetry: () => Promise<unknown>;
      onEvent: (listener: (event?: unknown) => void) => () => void;
      listConversations: (includeArchived?: boolean) => Promise<ConversationRailEntryView[]>;
      openConversation: (conversationId: string) => Promise<ConversationOpenResult>;
      newConversation: () => Promise<void>;
      renameConversation: (conversationId: string, title: string) => Promise<ConversationRailEntryView[]>;
      pinConversation: (conversationId: string) => Promise<ConversationRailEntryView[]>;
      unpinConversation: (conversationId: string) => Promise<ConversationRailEntryView[]>;
      archiveConversation: (conversationId: string) => Promise<ConversationRailEntryView[]>;
      unarchiveConversation: (conversationId: string) => Promise<ConversationRailEntryView[]>;
      searchConversations: (query: string) => Promise<ConversationSearchResultView[]>;
      exportConversation?: (conversationId: string) => Promise<{ saved: boolean; path: string | null }>;
      listArtifacts?: () => Promise<import('../src/ipc').DesktopArtifactView[]>;
      loadArtifactPreview?: (artifactId: string) => Promise<import('../src/ipc').DesktopArtifactPreview>;
      openArtifactFolder?: (artifactId: string) => Promise<{ opened: boolean }>;
      saveArtifactCopy?: (artifactId: string) => Promise<{ saved: boolean; path: string | null }>;
      probeImageStudio?: () => Promise<import('../src/ipc').DesktopImageStudioStatus>;
      generateImage?: (input: Record<string, unknown>) => Promise<import('../src/ipc').DesktopImageGenerationResult>;
      resolveImageApproval?: (approvalId: string, resolution: import('../src/ipc').DesktopApprovalResolution) => Promise<import('../src/ipc').DesktopImageGenerationResult>;
      cancelImageGeneration?: () => Promise<void>;
    };
    jarvisVoiceCapture: {
      startPushToTalkCapture: () => { stop: () => Promise<Uint8Array | null>; cancel: () => void };
      bytesToBase64: (bytes: Uint8Array) => string;
    };
  }
}

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
const listeners: Array<() => void> = [];

function ui() {
  return {
    activity: Array.from(document.querySelectorAll('#activity li')).map((item) => item.textContent ?? ''),
    diagnostics: Array.from(document.querySelectorAll('#diagnostics-list li')).map((item) => item.textContent ?? ''),
    result: document.getElementById('result')?.textContent ?? '',
    resultOutcome: document.getElementById('result-outcome')?.textContent ?? '',
    resultBlockedHidden: Boolean((document.getElementById('result-blocked') as HTMLElement | null)?.hidden ?? true),
    resultBlockedReason: document.getElementById('result-blocked-reason')?.textContent ?? '',
    codeBlocks: document.querySelectorAll('#result .code-block').length,
    phase: document.getElementById('cockpit-phase')?.textContent ?? '',
    action: document.getElementById('cockpit-action')?.textContent ?? '',
    elapsed: document.getElementById('cockpit-elapsed')?.textContent ?? '',
    remaining: document.getElementById('cockpit-remaining')?.textContent ?? '',
    productive: document.getElementById('cockpit-productive')?.textContent ?? '',
    repair: document.getElementById('cockpit-repair')?.textContent ?? '',
    read: document.getElementById('cockpit-read')?.textContent ?? '',
    validation: document.getElementById('cockpit-validation')?.textContent ?? '',
    verification: document.getElementById('cockpit-verification')?.textContent ?? '',
    approvalHidden: Boolean(document.getElementById('approval-panel')?.hidden),
    approvedHidden: Boolean(document.getElementById('approved-auth')?.hidden),
    jumpHidden: Boolean(document.getElementById('jump-latest')?.hidden),
    diagnosticsOpen: Boolean((document.getElementById('diagnostics') as HTMLDetailsElement | null)?.open),
    ids: document.getElementById('ids')?.textContent ?? '',
  };
}

async function paint(snapshot: DesktopSnapshot): Promise<void> {
  currentSnapshot = snapshot;
  for (const listener of listeners) listener();
  await Promise.resolve();
  await Promise.resolve();
}

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  window.jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({
      stop: async () => null,
      cancel: () => undefined,
    }),
    bytesToBase64: () => '',
  };
  window.karkedikhaDesktop = {
    getSnapshot: async () => currentSnapshot,
    pickFolder: async () => currentSnapshot,
    submitTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    continueTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    cancel: async () => undefined,
    resolveApproval: async () => undefined,
    setOpenRouterApiKey: async () => ({ keyConfigured: true }),
    clearOpenRouterApiKey: async () => ({ keyConfigured: false }),
    selectProvider: async () => currentSnapshot,
    selectWorker: async () => currentSnapshot,
    listModels: async () => [],
    selectModel: async () => currentSnapshot,
    transcribeUtterance: async () => ({ transcript: 'mock', engine: 'whisper' }),
    getHostTelemetry: async () => currentSnapshot?.hostTelemetry ?? null,
    onEvent: (listener: () => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    listConversations: async () => [],
    openConversation: async (conversationId: string) => ({
      conversation: {
        id: conversationId, title: null, preview: null, state: 'active', repositoryName: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null, pinnedAt: null,
      },
      messages: [],
      context: { state: 'no_workspace', repositoryName: null, objective: null, latestUserIntent: null, executionPolicy: null, pendingAction: null, relevantFiles: [], relevantSymbols: [], constraints: [], findings: null, validation: null, attachmentNames: [], citationCount: 0, researchSourceCount: 0, messageCount: 0, updatedAt: new Date().toISOString() },
    }),
    newConversation: async () => undefined,
    renameConversation: async () => [],
    pinConversation: async () => [],
    unpinConversation: async () => [],
    archiveConversation: async () => [],
    unarchiveConversation: async () => [],
    searchConversations: async () => [],
  };
  // Production renderer, not a parallel copy.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

afterEach(() => {
  const result = document.getElementById('result');
  if (result) result.replaceChildren();
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  vi.restoreAllMocks();
});

describe('production renderer mission cockpit', () => {
  it('approves once, collapses the envelope, and retains the completed outcome on refresh', async () => {
    const input = cockpitInput({ pendingApproval: APPROVED_CARD, approvedApproval: null });
    await paint(desktopSnapshotFromEvents([], input));
    expect(ui().approvalHidden).toBe(false);
    expect(ui().result).toBe('');
    const resolve = vi.spyOn(window.karkedikhaDesktop, 'resolveApproval').mockImplementation(async () => {
      currentSnapshot = desktopSnapshotFromEvents([], cockpitInput());
    });
    document.getElementById('approve')?.click();
    document.getElementById('approve')?.click();
    await vi.waitFor(() => expect(ui().approvedHidden).toBe(false));
    expect(resolve).toHaveBeenCalledExactlyOnceWith(APPROVED_CARD.approvalId, 'approved');
    expect(ui().approvalHidden).toBe(true);
    expect(ui().result).toBe('');
    const terminal = desktopSnapshotFromEvents([
      eventFromSummary('Final answer from Core conversation', RECORDED_START, { kind: 'result', text: 'Tip calculation fixed.' }),
    ], cockpitInput({ running: false, terminal: true }));
    await paint(terminal);
    await paint(terminal);
    expect(ui().result).toBe('Tip calculation fixed.');
    expect((document.getElementById('submit') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('cancel') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the composer usable and Stop reachable while work is running, and hides Stop when idle', async () => {
    await paint(desktopSnapshotFromEvents([], cockpitInput({ running: true, terminal: false })));
    const submit = document.getElementById('submit') as HTMLButtonElement;
    const stop = document.getElementById('cancel') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(stop.hidden).toBe(false);
    expect(stop.disabled).toBe(false);
    expect(stop.getAttribute('aria-label')).toMatch(/stop/i);
    expect(stop.textContent).toMatch(/Stop/);
    await paint(desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: true })));
    expect(stop.hidden).toBe(true);
  });

  it('keeps an approval error visible while leaving the pending gate actionable', async () => {
    await paint(desktopSnapshotFromEvents([], cockpitInput({ pendingApproval: APPROVED_CARD, approvedApproval: null })));
    vi.spyOn(window.karkedikhaDesktop, 'resolveApproval').mockRejectedValue(new Error('Core approval is stale'));
    document.getElementById('approve')?.click();
    await vi.waitFor(() => expect(document.getElementById('operation-error')?.textContent).toBe('Core approval is stale'));
    expect(ui().approvalHidden).toBe(false);
    expect(ui().result).toBe('');
    expect((document.getElementById('approve') as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores a late snapshot from the previous attempt', async () => {
    let completeOld!: (snapshot: DesktopSnapshot) => void;
    const old = desktopSnapshotFromEvents([], cockpitInput());
    const next = desktopSnapshotFromEvents([], cockpitInput({ attemptId: 'att_next', requestId: 'req_next' }));
    vi.spyOn(window.karkedikhaDesktop, 'getSnapshot')
      .mockImplementationOnce(() => new Promise((resolve) => { completeOld = resolve; }))
      .mockResolvedValue(next);
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    await Promise.resolve();
    completeOld(old);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui().ids).toContain('att_next');
    expect(ui().ids).not.toContain(old.attemptId);
  });
  it('replays the recorded 120-event stream without stale mixing or a 120-row timeline', async () => {
    const stream = recorded120();
    expect(stream).toHaveLength(120);
    const scrollSpy = vi.mocked(HTMLElement.prototype.scrollIntoView);
    let maxRows = 0;

    for (let index = 1; index <= stream.length; index += 1) {
      const slice = stream.slice(0, index);
      const last = slice[slice.length - 1];
      const terminal = last.kind === 'error' || last.eventType === 'attempt_failed';
      const pending = last.kind === 'approval'
        ? { ...APPROVED_CARD, approvalId: 'appr_live' }
        : null;
      const approved = slice.some((event) => /Core approval approved/.test(event.summary)) ? APPROVED_CARD : null;
      await paint(desktopSnapshotFromEvents(slice, cockpitInput({
        running: !terminal,
        terminal,
        pendingApproval: pending,
        approvedApproval: pending ? null : approved,
        nowMs: Date.parse(last.at),
      })));
      const state = ui();
      maxRows = Math.max(maxRows, state.activity.length);
      expect(state.activity.length).toBeLessThanOrEqual(COCKPIT_VISIBLE_LIMIT);
      expect(state.activity.some((row) => /att_other/.test(row))).toBe(false);
      if (!terminal) {
        expect(state.result).not.toMatch(/Waiting for mutation approval/);
        expect(state.result).toBe('');
      }
    }

    const terminal = ui();
    expect(maxRows).toBeLessThanOrEqual(COCKPIT_VISIBLE_LIMIT);
    expect(terminal.activity).toHaveLength(COCKPIT_VISIBLE_LIMIT);
    expect(terminal.diagnostics.length).toBeGreaterThan(terminal.activity.length);
    expect(terminal.diagnostics.length).toBeGreaterThan(40);
    expect(terminal.result).toBe(RECORDED_RESULT);
    expect(terminal.approvalHidden).toBe(true);
    expect(terminal.approvedHidden).toBe(false);
    expect(terminal.diagnosticsOpen).toBe(false);
    expect(terminal.validation).toBe('Passed');
    expect(terminal.verification).toMatch(/Failed/);
    expect(terminal.elapsed).toMatch(/^20:/);
    expect(terminal.remaining).toBe('0:00');
    expect(terminal.ids).toContain('att_8e2b1136');
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('keeps follow-latest until the user scrolls up, then offers Jump to latest', async () => {
    const stream = recorded120().slice(0, 40);
    const pane = document.getElementById('checkpoint-pane') as HTMLElement;
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 240 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: 960 });

    await paint(desktopSnapshotFromEvents(stream, cockpitInput({
      nowMs: Date.parse(stream[stream.length - 1].at),
    })));
    expect(ui().jumpHidden).toBe(true);

    Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: 0 });
    pane.dispatchEvent(new Event('scroll'));
    expect(ui().jumpHidden).toBe(false);

    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    await paint(desktopSnapshotFromEvents(stream, cockpitInput({
      nowMs: Date.parse(stream[stream.length - 1].at) + 1_000,
    })));
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView)).not.toHaveBeenCalled();

    document.getElementById('jump-latest')?.click();
    expect(ui().jumpHidden).toBe(true);
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView)).toHaveBeenCalled();
  });
});

describe('regression: full response stays in the conversation pane, never the bounded event stream', () => {
  it('a long code-plus-prose reply (the reported Python to-do case) renders fully in #result and never appears in #activity', async () => {
    const terminal = desktopSnapshotFromEvents([
      eventFromSummary('Reply from Core conversation', RECORDED_START, { kind: 'result', text: LONG_PYTHON_TODO_RESPONSE }),
    ], cockpitInput({ running: false, terminal: true }), { turnOutcomeKind: 'answered', interactionMode: 'chat' });
    await paint(terminal);
    await paint(terminal);

    const state = ui();
    // The full response, including the code, is in the conversation pane.
    expect(state.result).toContain('import json');
    expect(state.result).toContain('def main():');
    expect(state.result).toContain('copy it into a');
    expect(state.result).toContain('file yourself');
    // Rendered as an actual scrollable/copyable code block, not raw text.
    expect(state.codeBlocks).toBeGreaterThan(0);
    const copyButtons = document.querySelectorAll('#result .code-block-copy');
    expect(copyButtons.length).toBeGreaterThan(0);
    expect(copyButtons[0].textContent).toBe('Copy code');

    // The event stream (#activity) never carries the code or the prose.
    for (const row of state.activity) {
      expect(row).not.toContain('import json');
      expect(row).not.toContain('def main():');
      expect(row).not.toContain('todos.json');
    }
    expect(state.activity.length).toBeLessThanOrEqual(COCKPIT_VISIBLE_LIMIT);

    // Truthfully labeled as a text answer, never implying a file was written.
    expect(state.resultOutcome).toBe('Answered');
  });

  it('a completed autonomous-mission turn is labeled "Repository updated", not a bare "Mission completed"', async () => {
    const terminal = desktopSnapshotFromEvents([
      eventFromSummary('Final answer from Core conversation', RECORDED_START, { kind: 'result', text: 'Created hello.py and committed it.' }),
    ], cockpitInput({ running: false, terminal: true }), { turnOutcomeKind: 'workspace_changed', interactionMode: 'mission' });
    await paint(terminal);
    await paint(terminal);
    expect(ui().resultOutcome).toBe('Repository updated');
  });

  it('a file-creation request with no workspace selected shows blocked_needs_workspace with a Select folder action, never a false success', async () => {
    const blocked = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), {
      turnOutcomeKind: 'blocked_needs_workspace',
      blockedReason: 'Select a repository to create this file — Jarvis cannot write files without one.',
      folder: null,
    });
    await paint(blocked);
    await paint(blocked);

    const state = ui();
    expect(state.resultOutcome).toBe('Needs a workspace');
    expect(state.resultBlockedHidden).toBe(false);
    expect(state.resultBlockedReason).toMatch(/select a repository/i);
    expect(state.result).toBe(''); // no fabricated response text
    const selectFolderBtn = document.getElementById('result-select-folder');
    expect(selectFolderBtn).not.toBeNull();

    const pickFolder = vi.spyOn(window.karkedikhaDesktop, 'pickFolder').mockResolvedValue(
      desktopSnapshotFromEvents([], cockpitInput(), { turnOutcomeKind: null, blockedReason: null, folder: 'C:\\repo' }),
    );
    selectFolderBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalled());
  });
});
