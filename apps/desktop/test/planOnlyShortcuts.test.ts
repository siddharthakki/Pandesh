/**
 * Plan only means nothing is created, changed or run. The desktop host answers some messages itself (notes,
 * reminders, the command queue, timers, image generation) without a Core turn, so before this fix "remind me…" in a
 * Plan only conversation created a real reminder in a separate "Everyday" conversation, in Classic and v2 alike.
 * Those shortcuts are now skipped for a Plan only conversation and the message goes to Core, which freezes Plan only
 * on the turn. Read-only shortcuts (finding notes, listing reminders, a timer's status) still answer directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';
import { everydayIntentActs, parseEverydayIntent } from '../src/host/everydayToolsIntent';

type Internals = {
  client: unknown;
  coreState: string;
  selectedConversationId: string | null;
  handleEverydayIntent: (...args: unknown[]) => Promise<unknown>;
  planMediaRequest: (...args: unknown[]) => Promise<unknown>;
  refreshProvider: () => void;
  refreshProviderSoft: () => void;
};

const REACHED_CORE = 'reached the Core submit path';
let dataDir: string;
let host: DesktopSession;
let internal: Internals;
let mode: 'ask' | 'auto' | 'plan';
let shortcuts: string[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-plan-shortcuts-'));
  host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  internal = host as unknown as Internals;
  mode = 'ask';
  shortcuts = [];
  internal.client = { getConversationPermission: async () => ({ mode, authorizations: [], categories: {} }) };
  internal.coreState = 'connected';
  internal.selectedConversationId = 'conv-1';
  internal.handleEverydayIntent = async (text: unknown) => { shortcuts.push(`everyday:${String(text)}`); return { requestId: 'r', attemptId: 'a', model: 'everyday' }; };
  internal.planMediaRequest = async () => { shortcuts.push('media'); return null; };
  // Past the shortcuts, the next step is choosing the model provider for a real Core turn.
  internal.refreshProvider = () => { throw new Error(REACHED_CORE); };
  internal.refreshProviderSoft = () => { throw new Error(REACHED_CORE); };
});
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('Plan only and the host shortcuts', () => {
  it('knows which shortcuts act', () => {
    const acting = ['remind me in 10 minutes to call the bank', 'remember that the gate code is in the blue folder', 'start a timer for 5 minutes'];
    for (const text of acting) expect(everydayIntentActs(parseEverydayIntent(text)!), text).toBe(true);
    for (const text of ['show my reminders', 'how much time is left on my timer']) {
      const intent = parseEverydayIntent(text);
      expect(intent, text).not.toBeNull();
      expect(everydayIntentActs(intent!), text).toBe(false);
    }
  });

  it('in Plan only, "remind me…" goes to Core instead of creating a reminder', async () => {
    mode = 'plan';
    await expect(host.submitTask('remind me in 10 minutes to call the bank')).rejects.toThrow(REACHED_CORE);
    expect(shortcuts).toEqual([]);
  });

  it('in Plan only, image requests skip the media shortcut too', async () => {
    mode = 'plan';
    await expect(host.submitTask('draw a picture of a red bicycle')).rejects.toThrow(REACHED_CORE);
    expect(shortcuts).toEqual([]);
  });

  it('in Plan only, read-only shortcuts still answer', async () => {
    mode = 'plan';
    await host.submitTask('show my reminders');
    expect(shortcuts).toEqual(['everyday:show my reminders']);
  });

  it('in Ask and Auto the shortcuts work as before', async () => {
    for (const m of ['ask', 'auto'] as const) {
      mode = m;
      shortcuts = [];
      await host.submitTask('remind me in 10 minutes to call the bank');
      expect(shortcuts, m).toEqual(['everyday:remind me in 10 minutes to call the bank']);
    }
  });

  it('a Plan only choice waiting for a new conversation counts too', async () => {
    internal.selectedConversationId = null;
    await host.setPermissionMode('plan');
    await expect(host.submitTask('remind me in 10 minutes to call the bank')).rejects.toThrow(REACHED_CORE);
    expect(shortcuts).toEqual([]);
  });
});
