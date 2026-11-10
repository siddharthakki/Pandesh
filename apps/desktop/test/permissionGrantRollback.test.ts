/**
 * An Auto grant Core refuses (an unknown category, more than 24 hours) must not leave the conversation switched to
 * Auto. Found in the live v2 test on 2026-11-10: the refused grant was reported, but the mode had already changed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';

let dataDir: string;
let host: DesktopSession;
let calls: string[];
let mode: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-grant-rollback-'));
  host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  calls = [];
  mode = 'ask';
  const internal = host as unknown as { client: unknown; coreState: string; selectedConversationId: string | null };
  internal.client = {
    getConversationPermission: async () => ({ mode, authorizations: [], categories: {} }),
    setConversationPermissionMode: async (_id: string, next: string) => { calls.push(`mode:${next}`); mode = next; return {}; },
    grantStandingAuthorization: async (_id: string, input: { categories: string[] }) => {
      if (input.categories.includes('delete_everything')) throw new Error("'delete_everything' is not something a standing authorization can cover");
      calls.push('grant'); return {};
    },
  };
  internal.coreState = 'connected';
  internal.selectedConversationId = 'conv-1';
});
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('an Auto grant Core refuses', () => {
  it('puts the conversation back to the mode it had', async () => {
    await expect(host.setPermissionMode('auto', { categories: ['delete_everything'], expiresInMinutes: 60 })).rejects.toThrow(/not something a standing authorization can cover/);
    expect(calls).toEqual(['mode:auto', 'mode:ask']);
    expect(mode).toBe('ask');
  });

  it('keeps Auto and its grants when Auto was already on', async () => {
    mode = 'auto';
    await expect(host.setPermissionMode('auto', { categories: ['delete_everything'], expiresInMinutes: 60 })).rejects.toThrow();
    expect(calls).toEqual(['mode:auto']);
    expect(mode).toBe('auto');
  });

  it('a valid grant turns Auto on as before', async () => {
    await host.setPermissionMode('auto', { categories: ['web_research_public'], expiresInMinutes: 60 });
    expect(calls).toEqual(['mode:auto', 'grant']);
  });
});
