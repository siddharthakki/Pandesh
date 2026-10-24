/**
 * Focused tests for the Gmail-specific static allowlist over the `gws`
 * transport (feasibility checkpoint, AI_OS_ARCHITECTURE.md "Google Workspace
 * CLI (`gws`) as connector transport" and "Gmail draft-bound send safety").
 * `runGwsFn` is injected exactly like every other connector's `probe`/
 * `executor` override, so these prove the allowlist/validation/error-mapping/
 * digest logic without spawning any process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  createGwsGmailExecutor,
  createGwsGmailProbe,
  MAX_METADATA_CONCURRENCY,
  type GwsGmailAdapterConfig,
  type GwsGmailDraftBindingStore,
  type StoredGmailDraftBinding,
} from '../runtime/connectors/gwsGmailAdapter';
import { computeGmailDraftDigest, type GmailDraftContent } from '../runtime/connectors/gmailDraftDigest';
import type { RunGwsResult } from '../runtime/connectors/gwsTransport';
import type { ToolExecutionContext } from '../runtime/toolRunner';

let dir: string;
let binaryPath: string;
let ctx: ToolExecutionContext;
let accessToken: string | null;
let accountEmail: string | null;

function fakeDigestFor(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function fakeBindingStore(): GwsGmailDraftBindingStore {
  const store = new Map<string, StoredGmailDraftBinding>();
  return {
    record: (content: GmailDraftContent) => {
      const binding: StoredGmailDraftBinding = { ...content, digest: computeGmailDraftDigest(content) };
      store.set(content.draftId, binding);
      return binding;
    },
    get: (draftId: string) => store.get(draftId),
  };
}

function baseConfig(overrides: Partial<GwsGmailAdapterConfig> = {}): GwsGmailAdapterConfig {
  return {
    getAccessToken: () => accessToken,
    getAccountEmail: () => accountEmail,
    configDir: path.join(dir, 'config'),
    binaryPath,
    expectedSha256: fakeDigestFor(binaryPath),
    bindings: fakeBindingStore(),
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-gmail-adapter-'));
  binaryPath = path.join(dir, 'fake-gws.exe');
  fs.writeFileSync(binaryPath, 'not a real binary, only used for digest pinning in tests');
  ctx = { cwd: dir, signal: new AbortController().signal };
  accessToken = null;
  accountEmail = null;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stubRunGws(result: Partial<RunGwsResult>): () => Promise<RunGwsResult> {
  return async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...result });
}

describe('createGwsGmailExecutor: static allowlist', () => {
  it('refuses any tool name outside the fixed four, before ever touching a token or the binary', async () => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_delete_everything', {}, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('gws_not_allowlisted');
  });

  it('fails closed with no action taken when no access token is present', async () => {
    accountEmail = 'me@example.com';
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_search', {}, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('connector_not_configured');
  });

  it('fails closed with no action taken when no account is connected (no account email)', async () => {
    accessToken = 'token';
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_search', {}, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('connector_not_configured');
  });

  it('fails closed when the pinned binary is missing', async () => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
    const executor = createGwsGmailExecutor(baseConfig({ binaryPath: path.join(dir, 'nope.exe'), runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_search', {}, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('gws_binary_unavailable');
  });

  it('fails closed when the binary digest does not match the pinned value (tamper detection)', async () => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
    const executor = createGwsGmailExecutor(baseConfig({ expectedSha256: 'f'.repeat(64), runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_search', {}, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('gws_binary_unavailable');
    expect(result.output).toMatch(/digest mismatch/);
  });

  it('reports cancellation distinctly from a normal failure', async () => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({ aborted: true, exitCode: null }) }));
    const result = await executor('gmail_search', {}, ctx);
    expect(result.resultCategory).toBe('gws_cancelled');
  });

  it('reports a timeout distinctly from a normal failure', async () => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({ timedOut: true, exitCode: null }) }));
    const result = await executor('gmail_search', {}, ctx);
    expect(result.resultCategory).toBe('gws_timeout');
  });

  it('maps a Google API error JSON into a readable, non-secret failure', async () => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
    const executor = createGwsGmailExecutor(baseConfig({
      runGwsFn: stubRunGws({ exitCode: 1, stdout: '{"error":{"code":401,"message":"Request had invalid authentication credentials.","reason":"authError"}}' }),
    }));
    const result = await executor('gmail_search', {}, ctx);
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/authError/);
    expect(result.output).toMatch(/401/);
    expect(result.output).not.toMatch(/token/i);
  });
});

describe('gmail_search', () => {
  beforeEach(() => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
  });

  it('bounds maxResults regardless of what is requested, and never auto-paginates', async () => {
    let listArgs: string[] = [];
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('list')) { listArgs = input.args; return { exitCode: 0, stdout: '{"messages":[]}', stderr: '', timedOut: false, aborted: false }; }
      return { exitCode: 0, stdout: '{}', stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: runGwsFn as any }));
    await executor('gmail_search', { maxResults: 999999 }, ctx);
    const paramsIndex = listArgs.indexOf('--params');
    const params = JSON.parse(listArgs[paramsIndex + 1]);
    expect(params.maxResults).toBeLessThanOrEqual(50);
    expect(listArgs).not.toContain('--page-all');
  });

  it('lists ids then fetches bounded per-message metadata, returning subject/from/date/snippet', async () => {
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('list')) {
        return { exitCode: 0, stdout: '{"messages":[{"id":"m1","threadId":"t1"},{"id":"m2","threadId":"t2"}]}', stderr: '', timedOut: false, aborted: false };
      }
      const paramsIndex = input.args.indexOf('--params');
      const params = JSON.parse(input.args[paramsIndex + 1]);
      const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
      const bodies: Record<string, unknown> = {
        m1: { id: 'm1', threadId: 't1', snippet: 'hi there', payload: { headers: [{ name: 'Subject', value: 'Hello' }, { name: 'From', value: 'a@example.com' }], body: { data: b64('x') } } },
        m2: { id: 'm2', threadId: 't2', snippet: 'bye', payload: { headers: [{ name: 'Subject', value: 'Bye' }, { name: 'From', value: 'b@example.com' }], body: { data: b64('y') } } },
      };
      return { exitCode: 0, stdout: JSON.stringify(bodies[params.id as string]), stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: runGwsFn as any }));
    const result = await executor('gmail_search', { query: 'is:unread' }, ctx);
    expect(result.status).toBe('succeeded');
    const parsed = JSON.parse(result.output);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toMatchObject({ id: 'm1', subject: 'Hello', from: 'a@example.com', snippet: 'hi there' });
  });

  it('a single failed per-message metadata lookup does not fail the whole search (partial results)', async () => {
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('list')) {
        return { exitCode: 0, stdout: '{"messages":[{"id":"m1"},{"id":"m2"}]}', stderr: '', timedOut: false, aborted: false };
      }
      const paramsIndex = input.args.indexOf('--params');
      const params = JSON.parse(input.args[paramsIndex + 1]);
      if (params.id === 'm1') return { exitCode: 1, stdout: '{"error":{"code":404,"message":"not found"}}', stderr: '', timedOut: false, aborted: false };
      return { exitCode: 0, stdout: '{"id":"m2","payload":{"headers":[{"name":"Subject","value":"ok"}]}}', stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: runGwsFn as any }));
    const result = await executor('gmail_search', {}, ctx);
    expect(result.status).toBe('succeeded');
    const parsed = JSON.parse(result.output);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].subject).toBe('ok');
  });

  it('fetches per-message metadata with bounded concurrency and preserves list order', async () => {
    // 6 stubs > MAX_METADATA_CONCURRENCY (5). Each get is held on a pending gate
    // until every already-dispatched lookup has been logged, so the peak in-flight
    // count is provable (bounded by the cap) — then gates open in reverse order to
    // prove the result list keeps the original list order regardless of completion.
    let inFlight = 0;
    let peak = 0;
    const dispatchOrder: string[] = [];
    let openSignal: (() => void) | null = null;
    const openPromise = new Promise<void>((resolve) => { openSignal = resolve; });
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('list')) {
        const stubs = Array.from({ length: 6 }, (_, i) => ({ id: `m${i + 1}`, threadId: `t${i + 1}` }));
        return { exitCode: 0, stdout: JSON.stringify({ messages: stubs }), stderr: '', timedOut: false, aborted: false };
      }
      const params = JSON.parse(input.args[input.args.indexOf('--params') + 1]) as { id: string };
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      dispatchOrder.push(params.id);
      if (dispatchOrder.length >= MAX_METADATA_CONCURRENCY) openSignal?.();
      await new Promise<void>((resolve) => { setTimeout(resolve, Math.floor(Math.random() * 20)); });
      await openPromise;
      inFlight -= 1;
      return { exitCode: 0, stdout: JSON.stringify({ id: params.id, threadId: '', payload: { headers: [{ name: 'Subject', value: `subject-of-${params.id}` }], body: { data: '' } } }), stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: runGwsFn as any }));
    const result = await executor('gmail_search', { maxResults: 50 }, ctx);
    expect(result.status).toBe('succeeded');
    const parsed = JSON.parse(result.output);
    // Order is preserved from the list, not from completion order.
    expect(parsed.results.map((r: { subject: string }) => r.subject)).toEqual([
      'subject-of-m1', 'subject-of-m2', 'subject-of-m3', 'subject-of-m4', 'subject-of-m5', 'subject-of-m6',
    ]);
    // Fan-out really happened (more than one lookup overlapped)…
    expect(peak).toBeGreaterThan(1);
    // …but never exceeded the bound.
    expect(peak).toBeLessThanOrEqual(MAX_METADATA_CONCURRENCY);
    // The dispatcher starts in list order before any gate opens.
    expect(dispatchOrder.slice(0, MAX_METADATA_CONCURRENCY)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });
});

describe('gmail_read_thread', () => {
  beforeEach(() => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
  });

  it('requires threadId before ever invoking gws', async () => {
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_read_thread', {}, ctx);
    expect(result.resultCategory).toBe('gws_invalid_arguments');
  });

  it('parses every message in the thread payload', async () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    const thread = {
      id: 't1',
      messages: [
        { id: 'm1', threadId: 't1', payload: { headers: [{ name: 'Subject', value: 'Hi' }], body: { data: b64('hello') } } },
        { id: 'm2', threadId: 't1', payload: { headers: [{ name: 'Subject', value: 'Re: Hi' }], body: { data: b64('reply') } } },
      ],
    };
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({ stdout: JSON.stringify(thread) }) }));
    const result = await executor('gmail_read_thread', { threadId: 't1' }, ctx);
    expect(result.status).toBe('succeeded');
    const parsed = JSON.parse(result.output);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].bodyText).toBe('reply');
  });
});

describe('gmail_create_draft', () => {
  beforeEach(() => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
  });

  it('requires a non-empty "to" and a body before ever invoking gws', async () => {
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_create_draft', { subject: 'x', bodyText: 'y' }, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('gws_invalid_arguments');
  });

  it('creates a draft and records a digest-bound binding for it', async () => {
    const bindings = fakeBindingStore();
    const executor = createGwsGmailExecutor(baseConfig({
      bindings,
      runGwsFn: stubRunGws({ stdout: '{"id":"draft-1","message":{"id":"msg-1","threadId":"thread-1"}}' }),
    }));
    const result = await executor('gmail_create_draft', { to: ['bob@example.com'], subject: 'Hi', bodyText: 'Hello Bob' }, ctx);
    expect(result.status).toBe('succeeded');
    expect(JSON.parse(result.output)).toEqual({ draftId: 'draft-1', threadId: 'thread-1' });
    const binding = bindings.get('draft-1');
    expect(binding?.subject).toBe('Hi');
    expect(binding?.to).toEqual(['bob@example.com']);
    expect(binding?.accountEmail).toBe('me@example.com');
  });

  it('rejects a caller-supplied draftId — only gws-assigned IDs are ever bound', async () => {
    const bindings = fakeBindingStore();
    const executor = createGwsGmailExecutor(baseConfig({
      bindings,
      runGwsFn: stubRunGws({ stdout: '{"id":"draft-real","message":{"id":"msg-1"}}' }),
    }));
    const result = await executor('gmail_create_draft', { to: ['bob@example.com'], subject: 'Hi', bodyText: 'Hello', draftId: 'attacker-chosen' }, ctx);
    expect(result.status).toBe('succeeded');
    expect(JSON.parse(result.output).draftId).toBe('draft-real');
    expect(bindings.get('attacker-chosen')).toBeUndefined();
  });
});

describe('gmail_send_draft: draft-bound send safety', () => {
  beforeEach(() => {
    accessToken = 'token';
    accountEmail = 'me@example.com';
  });

  function liveDraftStub(overrides: Record<string, unknown> = {}) {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    return {
      id: 'draft-1',
      message: {
        id: 'msg-1',
        threadId: 'thread-1',
        payload: {
          headers: [
            { name: 'To', value: 'bob@example.com' },
            { name: 'Subject', value: 'Hi' },
          ],
          body: { data: b64('Hello Bob') },
        },
      },
      ...overrides,
    };
  }

  it('requires draftId before ever invoking gws', async () => {
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_send_draft', {}, ctx);
    expect(result.resultCategory).toBe('gws_invalid_arguments');
  });

  it('refuses to send when no approved digest is present on the context (unapproved send)', async () => {
    const executor = createGwsGmailExecutor(baseConfig({ runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_send_draft', { draftId: 'draft-1' }, ctx);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('gmail_send_draft_unapproved');
  });

  it('sends when the live draft matches the approved digest exactly', async () => {
    const bindings = fakeBindingStore();
    const content: GmailDraftContent = {
      accountEmail: 'me@example.com', draftId: 'draft-1', threadId: 'thread-1',
      to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', bodyText: 'Hello Bob', bodyHtml: null,
    };
    const expectedDigest = bindings.record(content).digest;
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('get')) return { exitCode: 0, stdout: JSON.stringify(liveDraftStub()), stderr: '', timedOut: false, aborted: false };
      return { exitCode: 0, stdout: '{"id":"msg-sent","threadId":"thread-1"}', stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ bindings, runGwsFn: runGwsFn as any }));
    const result = await executor('gmail_send_draft', { draftId: 'draft-1' }, { ...ctx, gmailDraftExpectedDigest: expectedDigest });
    expect(result.status).toBe('succeeded');
    expect(JSON.parse(result.output)).toEqual({ messageId: 'msg-sent', threadId: 'thread-1' });
  });

  it('sends successfully even when the draft has a Bcc (unverifiable via Gmail re-read, trusted from the binding)', async () => {
    const bindings = fakeBindingStore();
    const content: GmailDraftContent = {
      accountEmail: 'me@example.com', draftId: 'draft-1', threadId: 'thread-1',
      to: ['bob@example.com'], cc: [], bcc: ['secret-cc@example.com'], subject: 'Hi', bodyText: 'Hello Bob', bodyHtml: null,
    };
    const expectedDigest = bindings.record(content).digest;
    // Gmail's read-back never includes Bcc — this stub has none, exactly as
    // Gmail's real API behaves, and the send must still succeed.
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('get')) return { exitCode: 0, stdout: JSON.stringify(liveDraftStub()), stderr: '', timedOut: false, aborted: false };
      return { exitCode: 0, stdout: '{"id":"msg-sent","threadId":"thread-1"}', stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ bindings, runGwsFn: runGwsFn as any }));
    const result = await executor('gmail_send_draft', { draftId: 'draft-1' }, { ...ctx, gmailDraftExpectedDigest: expectedDigest });
    expect(result.status).toBe('succeeded');
  });

  it('never leaks message content in the send result — only IDs', async () => {
    const bindings = fakeBindingStore();
    const content: GmailDraftContent = {
      accountEmail: 'me@example.com', draftId: 'draft-1', threadId: 'thread-1',
      to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', bodyText: 'Hello Bob', bodyHtml: null,
    };
    const expectedDigest = bindings.record(content).digest;
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('get')) return { exitCode: 0, stdout: JSON.stringify(liveDraftStub()), stderr: '', timedOut: false, aborted: false };
      return { exitCode: 0, stdout: '{"id":"msg-sent","threadId":"thread-1"}', stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ bindings, runGwsFn: runGwsFn as any }));
    const result = await executor('gmail_send_draft', { draftId: 'draft-1' }, { ...ctx, gmailDraftExpectedDigest: expectedDigest });
    expect(result.output).not.toContain('Hello Bob');
    expect(result.output).not.toContain('bob@example.com');
  });

  it('refuses to send when the live draft body changed after review (draft changed after review)', async () => {
    const bindings = fakeBindingStore();
    const original: GmailDraftContent = {
      accountEmail: 'me@example.com', draftId: 'draft-1', threadId: 'thread-1',
      to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', bodyText: 'Hello Bob', bodyHtml: null,
    };
    const expectedDigest = bindings.record(original).digest;
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    const tampered = liveDraftStub({
      message: { id: 'msg-1', threadId: 'thread-1', payload: { headers: [{ name: 'To', value: 'bob@example.com' }, { name: 'Subject', value: 'Hi' }], body: { data: b64('SOMETHING ELSE ENTIRELY') } } },
    });
    let sendCalled = false;
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('get')) return { exitCode: 0, stdout: JSON.stringify(tampered), stderr: '', timedOut: false, aborted: false };
      sendCalled = true;
      return { exitCode: 0, stdout: '{"id":"msg-sent"}', stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ bindings, runGwsFn: runGwsFn as any }));
    const result = await executor('gmail_send_draft', { draftId: 'draft-1' }, { ...ctx, gmailDraftExpectedDigest: expectedDigest });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('gmail_send_draft_stale_digest');
    expect(sendCalled).toBe(false);
    expect(result.output).not.toContain('SOMETHING ELSE ENTIRELY');
  });

  it('refuses to send when the connected account identity changed after review', async () => {
    const bindings = fakeBindingStore();
    const original: GmailDraftContent = {
      accountEmail: 'me@example.com', draftId: 'draft-1', threadId: 'thread-1',
      to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', bodyText: 'Hello Bob', bodyHtml: null,
    };
    const expectedDigest = bindings.record(original).digest;
    accountEmail = 'someone-else@example.com'; // a different Google account is now connected
    let sendCalled = false;
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('get')) return { exitCode: 0, stdout: JSON.stringify(liveDraftStub()), stderr: '', timedOut: false, aborted: false };
      sendCalled = true;
      return { exitCode: 0, stdout: '{"id":"msg-sent"}', stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ bindings, runGwsFn: runGwsFn as any }));
    const result = await executor('gmail_send_draft', { draftId: 'draft-1' }, { ...ctx, gmailDraftExpectedDigest: expectedDigest });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('gmail_send_draft_stale_digest');
    expect(sendCalled).toBe(false);
  });

  it('refuses when no binding is on record for the draft id, even with a plausible-looking expected digest', async () => {
    const bindings = fakeBindingStore(); // nothing recorded
    const executor = createGwsGmailExecutor(baseConfig({ bindings, runGwsFn: stubRunGws({}) }));
    const result = await executor('gmail_send_draft', { draftId: 'draft-1' }, { ...ctx, gmailDraftExpectedDigest: 'a'.repeat(64) });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('gmail_send_draft_unapproved');
  });

  it('retains the binding after a successful send, so a retried/idempotent re-dispatch is never misread as "unapproved"', async () => {
    const bindings = fakeBindingStore();
    const content: GmailDraftContent = {
      accountEmail: 'me@example.com', draftId: 'draft-1', threadId: 'thread-1',
      to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', bodyText: 'Hello Bob', bodyHtml: null,
    };
    const expectedDigest = bindings.record(content).digest;
    const runGwsFn = async (input: { args: string[] }) => {
      if (input.args.includes('get')) return { exitCode: 0, stdout: JSON.stringify(liveDraftStub()), stderr: '', timedOut: false, aborted: false };
      return { exitCode: 0, stdout: '{"id":"msg-sent"}', stderr: '', timedOut: false, aborted: false };
    };
    const executor = createGwsGmailExecutor(baseConfig({ bindings, runGwsFn: runGwsFn as any }));
    await executor('gmail_send_draft', { draftId: 'draft-1' }, { ...ctx, gmailDraftExpectedDigest: expectedDigest });
    expect(bindings.get('draft-1')).toBeDefined();
  });
});

describe('createGwsGmailProbe', () => {
  it('reports not-ok with no token, without attempting to run gws', async () => {
    const probe = createGwsGmailProbe(baseConfig({ runGwsFn: stubRunGws({}) }));
    const result = await probe(new AbortController().signal);
    expect(result.ok).toBe(false);
  });

  it('reports ok on a successful getProfile call', async () => {
    accessToken = 'token';
    const probe = createGwsGmailProbe(baseConfig({ runGwsFn: stubRunGws({ stdout: '{"emailAddress":"me@example.com"}' }) }));
    const result = await probe(new AbortController().signal);
    expect(result.ok).toBe(true);
  });

  it('reports not-ok on an auth failure, with a non-secret reason', async () => {
    accessToken = 'token';
    const probe = createGwsGmailProbe(baseConfig({
      runGwsFn: stubRunGws({ exitCode: 1, stdout: '{"error":{"code":401,"message":"invalid credentials","reason":"authError"}}' }),
    }));
    const result = await probe(new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/authError/);
  });
});
