/**
 * Shared jsdom setup for the launch-restore tests: the real renderer.js with a
 * scripted host. Each test file evaluates the renderer once, so every startup
 * scenario lives in its own file.
 */
import { vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents } from './recordedMissionStream';

export interface ScriptedHost {
  snapshot: DesktopSnapshot;
  coreReady: boolean;
  /** The transcript fetch fails for another reason than a starting Core (e.g. a timeout). */
  openFails: boolean;
  calls: string[];
  paint(extra: Partial<DesktopSnapshot>): Promise<void>;
  send(text: string): Promise<void>;
}

export function snapshotWith(extra: Partial<DesktopSnapshot>): DesktopSnapshot {
  return desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), extra);
}

export function bootRendererWithRestoredConversation(conversationId: string): ScriptedHost {
  const rendererRoot = path.resolve(__dirname, '../renderer');
  const listeners: Array<() => void> = [];
  const host: ScriptedHost = {
    // Launch: the host has restored the last conversation from selected-conversation.json; Core is still starting.
    snapshot: snapshotWith({ coreState: 'starting', selectedConversationId: conversationId } as Partial<DesktopSnapshot>),
    coreReady: false,
    openFails: false,
    calls: [],
    async paint(extra) {
      host.snapshot = { ...host.snapshot, ...extra };
      for (const listener of listeners) listener();
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    async send(text) {
      (document.getElementById('task-input') as HTMLTextAreaElement).value = text;
      (document.getElementById('submit') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  };
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  document.body.innerHTML = (html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  (window as any).jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({ stop: async () => null, cancel: () => undefined }),
    bytesToBase64: () => '',
  };
  (window as any).karkedikhaDesktop = new Proxy({
    getSnapshot: async () => host.snapshot,
    onEvent: (listener: () => void) => { listeners.push(listener); return () => undefined; },
    listModels: async () => [],
    listConversations: async () => {
      if (!host.coreReady) throw new Error('Core is not connected');
      return [{ id: conversationId, title: 'Yesterday\'s price comparison', preview: null, state: 'active', repositoryName: null, createdAt: '2026-11-07T10:00:00.000Z', updatedAt: '2026-11-07T10:00:00.000Z', archivedAt: null, pinnedAt: null }];
    },
    openConversation: async (id: string) => {
      host.calls.push(`openConversation:${id}`);
      if (host.openFails) throw new Error('Timed out loading the conversation');
      if (!host.coreReady) throw new Error('Core is not connected');
      return {
        conversation: { id, title: 'Yesterday\'s price comparison' },
        messages: [
          { id: 'm1', role: 'user', content: 'Compare the three price lists.', createdAt: '2026-11-07T10:00:00.000Z' },
          { id: 'm2', role: 'assistant', content: 'The cheapest is 64 EUR.', createdAt: '2026-11-07T10:01:00.000Z' },
        ],
        context: { state: 'available', repositoryName: null, objective: null, latestUserIntent: null, executionPolicy: null, pendingAction: null, relevantFiles: [], relevantSymbols: [], constraints: [], findings: null, validation: null, attachmentNames: [], citationCount: 0, researchSourceCount: 0, messageCount: 2, updatedAt: '2026-11-07T10:01:00.000Z' },
      };
    },
    newConversation: async () => {
      host.calls.push('newConversation');
      host.snapshot = { ...host.snapshot, selectedConversationId: null } as DesktopSnapshot;
    },
    submitTask: async (goal: string) => {
      host.calls.push(`submitTask:${goal}:${host.snapshot.selectedConversationId ?? 'fresh'}`);
      return { requestId: 'req', attemptId: 'att', model: 'qwen' };
    },
  }, {
    // Every other host call the renderer makes during boot is a harmless no-op here.
    get: (target: Record<string, unknown>, key: string) => (key in target ? target[key] : async () => ({})),
  });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
  return host;
}
