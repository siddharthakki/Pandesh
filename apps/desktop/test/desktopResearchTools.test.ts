import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';
import { normalizeSafeExternalUrl } from '../src/host/desktopSafeOpen';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sessionWithClient(client: Record<string, unknown>): DesktopSession {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-research-'));
  dirs.push(dataDir);
  const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  const internal = host as unknown as { client: Record<string, unknown>; coreState: string };
  internal.client = client;
  internal.coreState = 'connected';
  return host;
}

describe('Desktop governed research projection', () => {
  it('creates a durable conversation and returns the exact Core approval envelope', async () => {
    const createConversation = vi.fn(async () => ({ id: 'conv-1' }));
    const createResearch = vi.fn(async () => ({
      session: { id: 'research-1', conversationId: 'conv-1' },
      approval: {
        id: 'rappr-1', requestedActionDigest: 'digest-1',
        summary: { provider: 'searxng', queryPreview: 'latest local AI news', maxSources: 3 },
      },
    }));
    const host = sessionWithClient({ createConversation, createResearch });
    const approval = await host.startWebResearch('  latest   local AI news ');
    expect(createConversation).toHaveBeenCalledWith({ mode: 'baat_kar', title: 'latest local AI news' });
    expect(createResearch).toHaveBeenCalledWith('conv-1', 'latest local AI news');
    expect(approval).toEqual({
      researchId: 'research-1', conversationId: 'conv-1', approvalId: 'rappr-1',
      requestedActionDigest: 'digest-1', provider: 'searxng',
      queryPreview: 'latest local AI news', maxSources: 3,
    });
    expect(host.snapshot().selectedConversationId).toBe('conv-1');
  });

  it('passes the exact approval id and digest back to Core, never reconstructing them', async () => {
    const resolveResearch = vi.fn(async () => ({}));
    const host = sessionWithClient({
      resolveResearch,
      getResearch: async () => ({
        session: {
          id: 'research-1', conversationId: 'conv-1', originatingUserMessageId: 'm-user',
          normalizedQuery: 'question', state: 'running', failureClassification: null,
        },
        sources: [],
      }),
      listMessages: async () => ({ messages: [{ id: 'm-user', seq: 1, role: 'user', content: 'question' }] }),
    });
    const approval = {
      researchId: 'research-1', conversationId: 'conv-1', approvalId: 'rappr-1',
      requestedActionDigest: 'digest-1', provider: 'searxng', queryPreview: 'question', maxSources: 3,
    };
    await host.resolveWebResearch(approval, 'approved');
    expect(resolveResearch).toHaveBeenCalledWith('research-1', {
      approvalId: 'rappr-1', requestedActionDigest: 'digest-1', resolution: 'approved',
    });
  });

  it('projects only the grounded answer and bounded source metadata', async () => {
    const host = sessionWithClient({
      getResearch: async () => ({
        session: {
          id: 'research-1', conversationId: 'conv-1', originatingUserMessageId: 'm-user',
          normalizedQuery: 'question', state: 'completed', failureClassification: null,
        },
        sources: [{ resultRank: 1, title: '<img onerror=alert(1)>', finalUrl: 'https://example.com/a', normalizedUrl: 'https://example.com/a', status: 'fetched' }],
      }),
      listMessages: async () => ({ messages: [
        { id: 'm-user', seq: 1, role: 'user', content: 'question' },
        { id: 'm-answer', seq: 2, role: 'assistant', content: 'Grounded answer [S1]' },
      ] }),
    });
    const result = await host.getWebResearch('research-1');
    expect(result.answer).toBe('Grounded answer [S1]');
    expect(result.sources).toEqual([{ rank: 1, title: '<img onerror=alert(1)>', url: 'https://example.com/a', status: 'fetched' }]);
  });
});

describe('safe host open boundary', () => {
  it('allows credential-free public HTTPS links', () => {
    expect(normalizeSafeExternalUrl('https://example.com/report?q=1')).toBe('https://example.com/report?q=1');
  });

  it.each([
    'http://example.com',
    'file:///C:/Windows/System32',
    'https://user:secret@example.com',
    'https://localhost:8443',
    'https://127.0.0.1/admin',
    'https://192.168.1.1/',
  ])('refuses unsafe or local URL %s', (url) => {
    expect(() => normalizeSafeExternalUrl(url)).toThrow();
  });
});
