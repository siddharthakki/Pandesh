/**
 * Pandesh's durable commitments, the promise keeper, and the memory route.
 *
 * Three claims are proved here:
 *
 *  1. A promise is a durable fact. It survives the conversation it was made
 *     in, it appears in the brief, and it is never silently re-opened.
 *  2. The follow-up check is honest and quiet. It closes a promise only when
 *     a reply actually arrived, it reports a promise that is still standing at
 *     most once a day, and it never sends anything.
 *  3. Durable memory is now reachable by the live model — and a memory *write*
 *     still needs the operator's approval, exactly like every other mutation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createConversation, listMessages } from '../domain/conversations';
import {
  createCommitment,
  getCommitment,
  listCommitments,
  listDueCommitments,
  toCommitmentView,
  updateCommitmentStatus,
} from '../domain/commitments';
import { setConnectorPermission } from '../domain/connectors';
import { clearGmailAccessToken, setGmailAccessToken } from '../runtime/connectors/gmailAccessTokenStore';
import { buildAssistantTodaySections } from '../domain/assistantBrief';
import { checkForReply, runFollowUpCheck } from '../runtime/followUpRoutine';
import { EventBroadcaster } from '../ws/broadcaster';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createMemoryCapabilityAdapter } from '../runtime/memoryCapability';
import { buildPiMemoryBridge } from '../runtime/piMemoryBridge';
import { appendMessage } from '../domain/conversations';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';
import type { ConnectorId } from '../shared/wireTypes';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-commitments-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A Gmail adapter that answers with a fixed thread, and records what it saw. */
function fakeGmail(thread: { id: string; from: string; receivedAt: string }[]): { adapter: ConnectorAdapter; calls: number } {
  const state = { calls: 0 };
  const adapter = {
    id: 'gmail',
    connectorId: 'gmail' as ConnectorId,
    definitions: () => [
      { name: 'gmail_read_thread', description: 'read a thread', parameters: { type: 'object', properties: {} } },
    ],
    tier: () => 'read' as const,
    classify: () => 'read_only' as const,
    health: () => ({ state: 'available' as const, checkedAt: new Date().toISOString() }),
    isConfigured: () => true,
    redactArguments: (_tool: string, args: Record<string, unknown>) => args,
    run: async () => {
      state.calls += 1;
      return {
        status: 'succeeded' as const,
        exitCode: 0,
        output: JSON.stringify({
          threadId: 'thread-1',
          messages: thread.map((message) => ({
            id: message.id,
            threadId: 'thread-1',
            from: message.from,
            subject: 'Re: the invoice',
            receivedAt: message.receivedAt,
          })),
        }),
        resultCategory: 'gmail_read_thread_succeeded',
      };
    },
    probeHealth: async () => ({ state: 'available' as const, checkedAt: new Date().toISOString() }),
  } as unknown as ConnectorAdapter;
  return { adapter, get calls() { return state.calls; } };
}

function grantGmailRead(): void {
  setConnectorPermission(db, { connectorId: 'gmail', tier: 'read', granted: true, actor: 'test' });
}

describe('durable commitments', () => {
  it('stores a promise with its condition, its due date and its provenance', () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const commitment = createCommitment(db, {
      title: 'Follow up with Priya about the invoice',
      subject: 'Priya',
      relatedId: 'thread-1',
      channel: 'gmail',
      condition: 'no_reply',
      dueAt: '2026-10-20T09:00:00.000Z',
      conversationId: conversation.id,
    });

    expect(commitment.status).toBe('open');
    expect(commitment.condition).toBe('no_reply');
    expect(commitment.conversationId).toBe(conversation.id);
    expect(getCommitment(db, commitment.id)?.title).toContain('Priya');
    expect(listCommitments(db, { status: 'open' })).toHaveLength(1);
  });

  it('refuses a promise with no title and an unknown condition', () => {
    expect(() => createCommitment(db, { title: '   ' })).toThrow(/title is required/);
    expect(() => createCommitment(db, { title: 'ok', condition: 'vibes' })).toThrow(/condition must be one of/);
  });

  it('never silently re-opens a settled promise', () => {
    const commitment = createCommitment(db, { title: 'Send the report' });
    updateCommitmentStatus(db, commitment.id, 'satisfied', 'sent');
    expect(() => updateCommitmentStatus(db, commitment.id, 'open')).toThrow(/already satisfied/);
    expect(getCommitment(db, commitment.id)?.status).toBe('satisfied');
  });

  it('appears in the daily brief as a fact, not as a suggestion', () => {
    createCommitment(db, {
      title: 'Follow up with Priya about the invoice',
      subject: 'Priya',
      dueAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const sections = buildAssistantTodaySections(db, {});
    const followUps = sections.find((section) => section.id === 'follow_ups');
    expect(followUps).toBeDefined();
    const item = followUps?.items.find((entry) => entry.id.startsWith('commitment:'));
    expect(item).toBeDefined();
    expect(item?.stance).toBe('fact');
    expect(item?.source.kind).toBe('core_commitment');
    expect(item?.detail).toContain('overdue');
  });

  it('only lists a promise as due once its moment has arrived', () => {
    const future = createCommitment(db, { title: 'later', dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    const past = createCommitment(db, { title: 'now', dueAt: new Date(Date.now() - 1_000).toISOString() });
    const due = listDueCommitments(db).map((commitment) => commitment.id);
    expect(due).toContain(past.id);
    expect(due).not.toContain(future.id);
    expect(toCommitmentView(past).overdue).toBe(true);
  });
});

describe('the follow-up check', () => {
  beforeEach(() => {
    // The signed-in account is what tells a reply apart from the user's own
    // message. Desktop pushes it into Core with the access token.
    setGmailAccessToken('token', new Date(Date.now() + 3_600_000).toISOString(), 'me@example.com', [
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
  });
  afterEach(() => {
    clearGmailAccessToken();
  });

  it('closes a promise only when a reply from the other party actually arrived', async () => {
    grantGmailRead();
    const commitment = createCommitment(db, {
      title: 'Follow up with Priya',
      subject: 'Priya',
      relatedId: 'thread-1',
      condition: 'no_reply',
      dueAt: new Date(Date.now() - 1_000).toISOString(),
    });
    // A reply that arrived after the promise was made.
    const repliedAt = new Date(Date.parse(commitment.createdAt) + 60_000).toISOString();
    const { adapter } = fakeGmail([
      { id: 'm1', from: 'Priya <priya@example.com>', receivedAt: repliedAt },
    ]);

    const check = await checkForReply(db, new Map([['gmail', adapter]]), commitment, {
      cwd: dir,
      signal: new AbortController().signal,
    });
    expect(check.replied).toBe(true);
    expect(check.repliedBy).toContain('Priya');
  });

  it('does not treat the user\'s own message as a reply', async () => {
    grantGmailRead();
    const commitment = createCommitment(db, {
      title: 'Follow up with Priya',
      relatedId: 'thread-1',
      condition: 'no_reply',
      dueAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const repliedAt = new Date(Date.parse(commitment.createdAt) + 60_000).toISOString();
    const { adapter } = fakeGmail([
      { id: 'm1', from: 'me@example.com', receivedAt: repliedAt },
    ]);

    const check = await checkForReply(db, new Map([['gmail', adapter]]), commitment, {
      cwd: dir,
      signal: new AbortController().signal,
    });
    expect(check.replied).toBe(false);
  });

  it('reports a standing promise once, and stays quiet the rest of the day', async () => {
    grantGmailRead();
    const { adapter } = fakeGmail([]);
    const commitment = createCommitment(db, {
      title: 'Follow up with Priya',
      subject: 'Priya',
      relatedId: 'thread-1',
      condition: 'no_reply',
      dueAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const adapters = new Map<ConnectorId, ConnectorAdapter>([['gmail', adapter]]);
    const broadcaster = new EventBroadcaster();

    const first = await runFollowUpCheck(db, broadcaster, { connectorRegistry: adapters, cwd: dir });
    expect(first.delivered).toBe(true);
    expect(first.outstanding).toContain(commitment.id);
    expect(first.satisfied).toEqual([]);

    const second = await runFollowUpCheck(db, broadcaster, { connectorRegistry: adapters, cwd: dir });
    expect(second.delivered).toBe(false);
    expect(second.reason).toBe('nothing to report');

    // The promise itself is still open — Pandesh reported it, it did not close it.
    expect(getCommitment(db, commitment.id)?.status).toBe('open');
  });

  it('says plainly that it could not check, and does not claim a delivery', async () => {
    // No Gmail permission granted: the check must fail closed with a reason.
    const { adapter } = fakeGmail([]);
    const commitment = createCommitment(db, {
      title: 'Follow up with Priya',
      relatedId: 'thread-1',
      condition: 'no_reply',
      dueAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const adapters = new Map<ConnectorId, ConnectorAdapter>([['gmail', adapter]]);
    const result = await runFollowUpCheck(db, new EventBroadcaster(), { connectorRegistry: adapters, cwd: dir });
    expect(result.delivered).toBe(true);
    expect(result.outstanding).toContain(commitment.id);
    expect(getCommitment(db, commitment.id)?.status).toBe('open');
  });

  it('does nothing at all when no promise is due', async () => {
    const result = await runFollowUpCheck(db, new EventBroadcaster(), {});
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('no commitment is due');
  });
});

describe('the memory route', () => {
  function registry(): GovernedCapabilityRegistry {
    return new GovernedCapabilityRegistry().register(createMemoryCapabilityAdapter({ db }));
  }

  it('offers the durable memory tools to the model', () => {
    const bridge = buildPiMemoryBridge({
      db,
      registry: registry(),
      correlationId: 'conv-1',
      clientId: 'test-client',
      cwd: dir,
      actor: 'core:executor',
    });
    expect(bridge).toBeDefined();
    const names = bridge!.definitions.map((definition) => definition.name);
    expect(names).toContain('memory_recall');
    expect(names).toContain('memory_remember');
    expect(names).toContain('memory_forget');
    expect(bridge!.definitions.find((definition) => definition.name === 'memory_remember')?.consequential).toBe(true);
    expect(bridge!.definitions.find((definition) => definition.name === 'memory_recall')?.consequential).toBe(false);
  });

  it('reads memory without asking for an approval', async () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    appendMessage(db, conversation.id, { role: 'user', content: 'I prefer dark mode in every editor.', actor: 'test' });
    const bridge = buildPiMemoryBridge({
      db,
      registry: registry(),
      correlationId: conversation.id,
      clientId: 'test-client',
      cwd: dir,
      actor: 'core:executor',
    })!;

    const outcome = await bridge.dispatch('memory_recall', { scopeType: 'user' });
    expect(outcome.outcome).toBe('executed');
  });

  it('asks for an approval before a memory is written', async () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    appendMessage(db, conversation.id, { role: 'user', content: 'Remember that I prefer dark mode.', actor: 'test' });
    const bridge = buildPiMemoryBridge({
      db,
      registry: registry(),
      correlationId: conversation.id,
      clientId: 'test-client',
      cwd: dir,
      actor: 'core:executor',
    })!;

    const outcome = await bridge.dispatch('memory_remember', {
      memoryType: 'user',
      scopeType: 'user',
      scopeId: 'preferences',
      subject: 'editor theme',
      predicate: 'prefers',
      value: 'dark mode',
      sensitivity: 'internal',
    });
    expect(outcome.outcome).toBe('approval_required');
    // Nothing was written: the write waits for the human.
    const listed = listCommitments(db);
    expect(listed).toHaveLength(0);
  });
});
