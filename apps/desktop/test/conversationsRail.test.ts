/** @vitest-environment jsdom */
/**
 * Jarvis Conversations rail Checkpoint 1 — renderer behavior. Proves: rail
 * grouping (Today/Yesterday/Previous 7 Days/Older, pinned first), the
 * approval-pending badge is visible from the rail (not just the live
 * approval card), opening a conversation renders its durable transcript
 * into #result via the existing safe-Markdown renderer (never the event
 * stream), and search navigates to a match.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConversationOpenResult, ConversationRailEntryView, ConversationSearchResultView, DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents } from './recordedMissionStream';

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
    groupConversationsForRail?: (entries: ConversationRailEntryView[], now?: Date) => Record<string, ConversationRailEntryView[]>;
    refreshConversationsRail?: () => Promise<void>;
  }
}

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
let conversations: ConversationRailEntryView[] = [];
const listeners: Array<() => void> = [];

function entry(overrides: Partial<ConversationRailEntryView> = {}): ConversationRailEntryView {
  return {
    id: 'conv_1',
    title: 'Reading list filters',
    preview: 'Add All/Unread/Read filters.',
    state: 'active',
    repositoryName: null,
    createdAt: '2026-09-17T10:00:00.000Z',
    updatedAt: '2026-09-17T10:00:00.000Z',
    archivedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  window.jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({ stop: async () => null, cancel: () => undefined }),
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
    listModels: async () => ['qwen2.5-coder:1.5b'],
    selectModel: async () => currentSnapshot,
    transcribeUtterance: async () => ({ transcript: 'mock', engine: 'whisper' }),
    getHostTelemetry: async () => currentSnapshot?.hostTelemetry ?? null,
    onEvent: (listener: () => void) => { listeners.push(listener); return () => undefined; },
    listConversations: async () => conversations,
    openConversation: async (conversationId: string) => {
      const found = conversations.find((c) => c.id === conversationId) ?? entry({ id: conversationId });
      return {
        conversation: found,
        messages: [
          { id: 'm1', role: 'user', content: 'Add filters to the reading list.', createdAt: '2026-09-17T10:00:00.000Z' },
          { id: 'm2', role: 'assistant', content: 'Added All, Unread, and Read filters.', createdAt: '2026-09-17T10:01:00.000Z' },
        ],
        context: {
          state: 'available', repositoryName: 'reading-list', objective: 'Add filters', latestUserIntent: 'Add filters',
          executionPolicy: 'COLLABORATIVE_EDIT', pendingAction: null, relevantFiles: ['src/App.tsx'], relevantSymbols: [],
          constraints: ['Keep the current design'], findings: 'Filter state lives in App.', validation: 'Tests passed.',
          attachmentNames: [], citationCount: 0, researchSourceCount: 0, messageCount: 2, updatedAt: '2026-09-17T10:01:00.000Z',
        },
      };
    },
    newConversation: async () => undefined,
    renameConversation: async () => conversations,
    pinConversation: async () => conversations,
    unpinConversation: async () => conversations,
    archiveConversation: async () => conversations,
    unarchiveConversation: async () => conversations,
    searchConversations: async (query: string) => conversations
      .filter((c) => (c.title ?? '').toLowerCase().includes(query.toLowerCase()))
      .map((c) => ({ conversationId: c.id, messageId: null, title: c.title, snippet: c.preview ?? '', matchedKinds: ['title' as const], updatedAt: c.updatedAt })),
    exportConversation: async () => ({ saved: true, path: 'C:\\Exports\\conversation.md' }),
    listArtifacts: async () => [{
      id: 'artifact-1', conversationId: 'conv-1', kind: 'image', title: 'Mountain study',
      mimeType: 'image/png', fileName: 'mountain.png', byteSize: 2048, source: 'image-studio',
      createdAt: '2026-09-17T10:00:00.000Z', availability: 'ready',
    }],
    loadArtifactPreview: async () => ({
      artifact: {
        id: 'artifact-1', conversationId: 'conv-1', kind: 'image', title: 'Mountain study',
        mimeType: 'image/png', fileName: 'mountain.png', byteSize: 2048, source: 'image-studio',
        createdAt: '2026-09-17T10:00:00.000Z', availability: 'ready',
      },
      dataUrl: 'data:image/png;base64,c2FmZQ==',
    }),
    openArtifactFolder: async () => ({ opened: true }),
    saveArtifactCopy: async () => ({ saved: true, path: 'C:\\Exports\\mountain.png' }),
    probeImageStudio: async () => ({ studio: true, comfyui: true, ollama: true, detail: 'Image Generation Studio and ComfyUI are ready', checkpoints: [{ name: 'fixture.safetensors', category: 'general' }] }),
    generateImage: async () => ({ outcome: 'approval_required', approvalId: 'approve-image', attemptId: 'attempt-image', presentation: { prompt: 'A blue control center', width: 1024, height: 1024, outputCount: 1 } }),
    resolveImageApproval: async () => ({ outcome: 'executed', attemptId: 'attempt-image', artifactIds: ['artifact-1'], message: 'Generated 1 verified image' }),
    cancelImageGeneration: async () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

async function paint(snapshot: DesktopSnapshot): Promise<void> {
  currentSnapshot = snapshot;
  for (const listener of listeners) listener();
  await Promise.resolve();
  await Promise.resolve();
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Jarvis Conversations rail — grouping', () => {
  it('groups pinned entries first, then Today/Yesterday/Previous 7 Days/Older by updatedAt', () => {
    const now = new Date('2026-09-17T12:00:00.000Z');
    const entries: ConversationRailEntryView[] = [
      entry({ id: 'today', updatedAt: '2026-09-17T09:00:00.000Z' }),
      entry({ id: 'yesterday', updatedAt: '2026-09-16T09:00:00.000Z' }),
      entry({ id: 'week', updatedAt: '2026-09-12T09:00:00.000Z' }),
      entry({ id: 'older', updatedAt: '2026-08-01T09:00:00.000Z' }),
      entry({ id: 'pinned-but-old', updatedAt: '2026-01-01T09:00:00.000Z', pinnedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    const groups = window.groupConversationsForRail!(entries, now);
    expect(groups.pinned.map((e) => e.id)).toEqual(['pinned-but-old']);
    expect(groups.today.map((e) => e.id)).toEqual(['today']);
    expect(groups.yesterday.map((e) => e.id)).toEqual(['yesterday']);
    expect(groups.previous7.map((e) => e.id)).toEqual(['week']);
    expect(groups.older.map((e) => e.id)).toEqual(['older']);
  });
});

describe('Jarvis Conversations rail — rendering and interaction', () => {
  it('renders a fetched conversation in the rail with its state badge, including needs_approval', async () => {
    conversations = [
      entry({ id: 'conv_needs_approval', title: 'Risky change', state: 'needs_approval', updatedAt: new Date().toISOString() }),
    ];
    const snap = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }));
    await paint(snap);
    await window.refreshConversationsRail!();
    await tick();
    const badge = document.querySelector('.conversation-state-badge[data-state="needs_approval"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toMatch(/needs approval/i);
  });

  it('retries a transient "Core is not connected" cold-start race instead of surfacing it as an error', async () => {
    conversations = [entry({ id: 'conv_retry', updatedAt: new Date().toISOString() })];
    const realListConversations = window.karkedikhaDesktop.listConversations;
    let calls = 0;
    window.karkedikhaDesktop.listConversations = async (includeArchived?: boolean) => {
      calls += 1;
      if (calls < 3) throw new Error('Core is not connected');
      return realListConversations(includeArchived);
    };
    const errorNode = document.getElementById('operation-error')!;
    errorNode.hidden = true;
    errorNode.textContent = '';

    try {
      await window.refreshConversationsRail!();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(errorNode.hidden).toBe(true);
      expect(document.querySelector('.conversation-entry[data-conversation-id="conv_retry"]')).toBeTruthy();
    } finally {
      window.karkedikhaDesktop.listConversations = realListConversations;
    }
  });

  it('also retries the same transient race on openConversation, not just listConversations', async () => {
    conversations = [entry({ id: 'conv_open_retry', updatedAt: new Date().toISOString() })];
    const snap = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }));
    await paint(snap);
    await window.refreshConversationsRail!();
    await tick();

    const realOpenConversation = window.karkedikhaDesktop.openConversation;
    let calls = 0;
    window.karkedikhaDesktop.openConversation = async (conversationId: string) => {
      calls += 1;
      if (calls < 3) throw new Error('Core is not connected');
      return realOpenConversation(conversationId);
    };
    const errorNode = document.getElementById('operation-error')!;
    errorNode.hidden = true;
    errorNode.textContent = '';

    try {
      const entryNode = document.querySelector('.conversation-entry[data-conversation-id="conv_open_retry"]') as HTMLElement | null;
      expect(entryNode).toBeTruthy();
      entryNode?.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(errorNode.hidden).toBe(true);
      expect(document.getElementById('result')?.hidden).toBe(false);
    } finally {
      window.karkedikhaDesktop.openConversation = realOpenConversation;
    }
  });

  it('opening a conversation renders its durable transcript into #result via safe Markdown, and the event stream is untouched', async () => {
    conversations = [entry({ id: 'conv_open_me', updatedAt: new Date().toISOString() })];
    const snap = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }));
    await paint(snap);
    await window.refreshConversationsRail!();
    await tick();

    const activityBefore = document.getElementById('activity')?.innerHTML ?? '';
    const entryNode = document.querySelector('.conversation-entry[data-conversation-id="conv_open_me"]') as HTMLElement | null;
    expect(entryNode).toBeTruthy();
    entryNode?.click();
    await tick();

    const result = document.getElementById('result');
    expect(result?.hidden).toBe(false);
    const paragraphs = result?.querySelectorAll('.conversation-paragraph') ?? [];
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(result?.textContent).toContain('Add filters to the reading list.');
    expect(result?.textContent).toContain('Added All, Unread, and Read filters.');
    expect(document.getElementById('conversation-context-body')?.hidden).toBe(false);
    expect(document.getElementById('context-objective')?.textContent).toBe('Add filters');
    expect(document.getElementById('context-files')?.textContent).toContain('src/App.tsx');
    expect(document.getElementById('context-constraints')?.textContent).toContain('Keep the current design');
    // The full transcript never leaks into the bounded operational event stream.
    expect(document.getElementById('activity')?.innerHTML ?? '').toBe(activityBefore);
  });

  it('exports the opened transcript through the host save flow', async () => {
    conversations = [entry({ id: 'conv_export', updatedAt: new Date().toISOString() })];
    await window.refreshConversationsRail!();
    await tick();
    (document.querySelector('.conversation-entry[data-conversation-id="conv_export"]') as HTMLElement)?.click();
    await tick();
    (document.getElementById('conversation-export') as HTMLButtonElement)?.click();
    await tick();
    expect(document.getElementById('conversation-export-status')?.textContent).toContain('conversation.md');
  });

  it('search finds a matching conversation by title and opening a result navigates to it', async () => {
    conversations = [
      entry({ id: 'conv_alpha', title: 'Alpha project notes', updatedAt: new Date().toISOString() }),
      entry({ id: 'conv_beta', title: 'Beta rollout plan', updatedAt: new Date().toISOString() }),
    ];
    const snap = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }));
    await paint(snap);
    await tick();

    const search = document.getElementById('conversations-search') as HTMLInputElement;
    search.value = 'Alpha';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await tick();

    const results = document.getElementById('conversations-search-results');
    expect(results?.hidden).toBe(false);
    expect(results?.textContent).toContain('Alpha project notes');
    expect(results?.textContent).not.toContain('Beta rollout plan');

    const resultNode = results?.querySelector('.conversation-entry') as HTMLElement | null;
    resultNode?.click();
    await tick();
    expect(document.getElementById('result')?.hidden).toBe(false);
  });
});

describe('Artifacts gallery', () => {
  it('loads Core-owned records on tab open and previews a selected verified image', async () => {
    const tab = document.getElementById('btn-media') as HTMLButtonElement;
    tab.click();
    await tick();
    const item = document.querySelector('.artifact-item') as HTMLElement;
    expect(item.textContent).toContain('Mountain study');
    expect(item.textContent).toContain('ready');
    item.click();
    await tick();
    const image = document.getElementById('artifact-preview-image') as HTMLImageElement;
    expect(image.hidden).toBe(false);
    expect(image.src).toContain('data:image/png;base64,c2FmZQ==');
    expect(document.getElementById('artifact-actions')?.hasAttribute('hidden')).toBe(false);
  });

  it('shows exact settings for approval before generation and selects the returned artifact', async () => {
    const prompt = document.getElementById('image-prompt') as HTMLTextAreaElement;
    prompt.value = 'A blue control center';
    (document.getElementById('image-generate') as HTMLButtonElement).click();
    await tick();
    const approval = document.getElementById('image-approval') as HTMLElement;
    expect(approval.hidden).toBe(false);
    expect(document.getElementById('image-approval-detail')?.textContent).toContain('A blue control center');
    (document.getElementById('image-approve') as HTMLButtonElement).click();
    await tick();
    expect(approval.hidden).toBe(true);
    expect(document.getElementById('image-status')?.textContent).toContain('Generated 1 verified image');
    expect((document.getElementById('artifact-preview-image') as HTMLImageElement).hidden).toBe(false);
  });

  it('switches to the Artifacts tab and shows the exact approval card when a chat-typed image request needs approval', async () => {
    const snap = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), {
      pendingImageApproval: { approvalId: 'approve-chat-image', attemptId: 'attempt-chat-image', presentation: { prompt: 'a cute panda eating dosa', checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors' } },
    });
    await paint(snap);
    await tick();
    expect(document.getElementById('tab-assets')?.hasAttribute('hidden')).toBe(false);
    const approval = document.getElementById('image-approval') as HTMLElement;
    expect(approval.hidden).toBe(false);
    expect(document.getElementById('image-approval-detail')?.textContent).toContain('a cute panda eating dosa');
  });
});

describe('Windows paths and Core-posted messages in the transcript', () => {
  it('keeps backslashes in the title, user text and assistant text, and shows no model badge on a Core-posted message', async () => {
    const repoPath = 'C:\\Users\\siddh\\kkd-e2e\\wcdemo';
    const filePath = 'C:\\x\\_my_dir\\file.js';
    conversations = [entry({ id: 'conv_paths', title: `Add a counter in ${repoPath}`, updatedAt: new Date().toISOString() })];
    const realOpen = window.karkedikhaDesktop.openConversation;
    window.karkedikhaDesktop.openConversation = async (conversationId: string) => {
      const base = await realOpen(conversationId);
      return {
        ...base,
        messages: [
          { id: 'p1', role: 'user', content: `Work in ${repoPath} please`, createdAt: '2026-09-17T10:00:00.000Z' },
          { id: 'p2', role: 'assistant', content: `Working in ${repoPath}, branch \`main\`, file ${filePath}`, createdAt: '2026-09-17T10:01:00.000Z', model: 'qwen3.8', provider: 'ollama' },
          { id: 'p3', role: 'assistant', content: '✅ **Counter** is done', createdAt: '2026-09-17T10:02:00.000Z', model: null, provider: null },
        ],
      } as typeof base;
    };
    try {
      const snap = desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }));
      await paint(snap);
      await window.refreshConversationsRail!();
      await tick();
      const node = document.querySelector('.conversation-entry[data-conversation-id="conv_paths"]') as HTMLElement;
      expect(node.textContent).toContain(repoPath);
      node.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const text = document.getElementById('result')!.textContent ?? '';
      expect(text).toContain(`Work in ${repoPath} please`);
      expect(text).toContain(`Working in ${repoPath}, branch main, file ${filePath}`);
      const rows = [...document.querySelectorAll('#result .transcript-row-assistant')];
      expect(rows).toHaveLength(2);
      expect(rows[0].querySelector('.transcript-model-badge')?.textContent).toBe('qwen3.8');
      expect(rows[1].querySelector('.transcript-model-badge')).toBeNull(); // no model wrote the Core report
    } finally {
      window.karkedikhaDesktop.openConversation = realOpen;
    }
  });
});
