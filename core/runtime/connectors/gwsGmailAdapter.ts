/**
 * Gmail `probe`/`executor` for the Jarvis Connector Foundation
 * (`connectorDefinitions.ts`), backed by the pinned `gws` transport
 * (`gwsTransport.ts`) instead of a custom Gmail HTTP client.
 *
 * This file *is* the static allowlist required by the feasibility checkpoint:
 * exactly four typed Gmail tools map to a fixed, bounded set of
 * `gws <service> <resource> [sub-resource] <method>` invocations each, with a
 * narrow, typed argument builder. There is no passthrough of a model- or
 * caller-supplied service/resource/method/params — `gws`'s general-purpose
 * shape is never exposed past this module. `gmail_send_draft` never accepts
 * raw message content; it only ever sends a previously created, digest-bound
 * draft by ID (see `gmailDraftDigest.ts` and AI_OS_ARCHITECTURE.md "Gmail
 * draft-bound send safety"). Calendar and every other gws service remain
 * unreachable; adding one means adding another explicit entry here, not
 * widening what this module already accepts.
 *
 * Credential ownership: Jarvis/Desktop keeps the Gmail OAuth *refresh* token
 * in Electron `safeStorage` and mints a short-lived *access* token, pushed
 * into this Core process's `gmailAccessTokenStore.ts` over an authenticated
 * loopback HTTP call (never Core's env — env is fixed at spawn time and a
 * refresh must not require restarting Core). This module reads the current
 * token and account email fresh on every call and forwards only the token,
 * only via `GOOGLE_WORKSPACE_CLI_TOKEN` in a from-scratch child environment
 * (`gwsTransport.ts`). It never persists a token, never accepts one as a tool
 * argument, and never calls `gws auth login`/`export`.
 */
import * as path from 'node:path';
import type { ConnectorExecutor, ConnectorPrepare, ConnectorProbe } from './connectorCapability';
import { analyzeInbox, applyPlan, planChanges, prepareOrganizeAction, undoPlan, type GmailOrganizeStore, type OrganizeEnv } from './gmailOrganize';
import type { ToolExecutionResult } from '../toolRunner';
import {
  GWS_PINNED_SHA256_WINDOWS_X64,
  parseGwsJson,
  resolveGwsBinaryPath,
  runGws,
  verifyPinnedBinary,
} from './gwsTransport';
import { summarizeGmailMessage, summarizeGmailThread, type GmailApiMessage, type GmailApiThread } from './gmailMime';
import {
  buildGmailSendPresentation,
  canonicalizeGmailDraft,
  computeGmailDraftDigest,
  type GmailDraftContent,
} from './gmailDraftDigest';

const MAX_LIST_RESULTS = 50;
const DEFAULT_LIST_RESULTS = 20;
/** `gmail_search` bounds not just the list page but how many per-message
 * metadata lookups it will perform to build useful (subject/from/snippet)
 * results — Gmail's `messages.list` response carries only IDs, so a search
 * that "shows results" costs one `list` plus up to this many `get` calls. */
const MAX_METADATA_LOOKUPS = 20;
/** Bounded fan-out for Gmail search's per-message metadata lookups: a search
 *  costs one `list` plus up to MAX_METADATA_LOOKUPS independent `get` calls, so
 *  fetch at most this many in parallel instead of strictly one at a time. Kept
 *  small so a single search never floods the account's API quota. */
export const MAX_METADATA_CONCURRENCY = 5;

export type { GmailDraftContent };

/** A previously recorded draft binding, as `gmailDraftBindings.ts` returns it
 * — declared locally so this runtime module never imports from `core/domain`
 * (adapters are called by domain, never the reverse). */
export interface StoredGmailDraftBinding extends GmailDraftContent {
  digest: string;
}

export interface GwsGmailDraftBindingStore {
  record(content: GmailDraftContent): StoredGmailDraftBinding;
  get(draftId: string): StoredGmailDraftBinding | undefined;
}

export interface GwsGmailAdapterConfig {
  /** Reads the current short-lived access token, or `null` if none/expired. */
  getAccessToken: () => string | null;
  /** The connected Google account's email, or `null` if none connected. */
  getAccountEmail: () => string | null;
  /** Core-owned directory for gws's non-secret Discovery-schema cache. */
  configDir: string;
  bindings: GwsGmailDraftBindingStore;
  /** Inbox organization (analysis, bulk preview, approved label changes, undo). Absent = those tools report not available. */
  organize?: {
    store: GmailOrganizeStore;
    /** True only when Google granted gmail.modify for the current token. */
    hasModifyScope: () => boolean;
    onProgress?: OrganizeEnv['onProgress'];
    /** Clock for the analysis time budget. Tests only. */
    now?: () => number;
  };
  /** Overridable for tests; production always uses `resolveGwsBinaryPath()`. */
  binaryPath?: string;
  expectedSha256?: string;
  timeoutMs?: number;
  /** Injectable for tests, exactly like `probe`/`executor` elsewhere in the
   * connector foundation — production always uses the real `runGws`, which
   * actually spawns the pinned binary. Tests substitute a fake to prove the
   * allowlist/error-mapping logic without a real `gws` process. */
  runGwsFn?: typeof runGws;
  /** User's IANA zone for rendering message times. Defaults to the host's. */
  timeZone?: () => string;
}

export function resolveBinary(config: GwsGmailAdapterConfig): { ok: true; path: string } | { ok: false; reason: string } {
  const binaryPath = config.binaryPath ?? resolveGwsBinaryPath();
  if (!binaryPath) return { ok: false, reason: 'gws binary is not staged (KARKEDIKHA_GWS_BIN is not set)' };
  const check = verifyPinnedBinary(binaryPath, config.expectedSha256 ?? GWS_PINNED_SHA256_WINDOWS_X64);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, path: check.path };
}

export function errorReasonFromParsed(parsed: ReturnType<typeof parseGwsJson>, stderr: string, exitCode: number | null): string {
  if (parsed.ok) {
    const data = parsed.data as { error?: { code?: number; message?: string; reason?: string } } | null;
    if (data && typeof data === 'object' && data.error) {
      return `gws ${data.error.reason ?? 'error'} (${data.error.code ?? exitCode}): ${data.error.message ?? 'no message'}`;
    }
    return `gws exited ${exitCode} with an unexpected JSON shape`;
  }
  return stderr.trim() ? `${parsed.reason}: ${stderr.trim()}` : parsed.reason;
}

export interface CallDeps {
  binaryPath: string;
  accessToken: string;
  configDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  runGwsFn: typeof runGws;
  timeZone?: string;
}

export type GwsCallOutcome = { ok: true; data: unknown } | { ok: false; result: ToolExecutionResult };

export async function callGws(deps: CallDeps, args: string[], resultCategoryOnFailure: string, options: { allowEmptyOutput?: boolean } = {}): Promise<GwsCallOutcome> {
  const result = await deps.runGwsFn({
    binaryPath: deps.binaryPath,
    args,
    accessToken: deps.accessToken,
    configDir: deps.configDir,
    signal: deps.signal,
    timeoutMs: deps.timeoutMs,
  });
  if (result.aborted) {
    return { ok: false, result: { status: 'failed', exitCode: null, output: 'cancelled', resultCategory: 'gws_cancelled' } };
  }
  if (result.timedOut) {
    return { ok: false, result: { status: 'failed', exitCode: null, output: `gws timed out after ${deps.timeoutMs ?? 20_000}ms`, resultCategory: 'gws_timeout' } };
  }
  // Some Google methods (e.g. Calendar events.delete) legitimately answer 204 with no body.
  if (options.allowEmptyOutput && result.exitCode === 0 && !result.stdout.trim()) return { ok: true, data: null };
  const parsed = parseGwsJson(result.stdout);
  if (result.exitCode === 0 && parsed.ok) return { ok: true, data: parsed.data };
  return {
    ok: false,
    result: { status: 'failed', exitCode: result.exitCode, output: errorReasonFromParsed(parsed, result.stderr, result.exitCode), resultCategory: resultCategoryOnFailure },
  };
}

export function succeeded(resultCategory: string, output: unknown): ToolExecutionResult {
  return { status: 'succeeded', exitCode: 0, output: JSON.stringify(output), resultCategory };
}

export function invalidArgs(message: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output: message, resultCategory: 'gws_invalid_arguments' };
}

export function trimmedNonEmptyString(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

/**
 * Maps `items` through `fn` with at most `limit` lookups in flight at once,
 * resolving to results in the *original* order (each worker stores under its
 * own index, so the order never depends on which lookup finishes first). No
 * external concurrency library — the work is bounded and small, so a
 * self-managed pool is the minimal, honest shape.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return out;
}

let boundaryCounter = 0;
function freshBoundary(): string {
  boundaryCounter += 1;
  return `gmail-boundary-${Date.now()}-${boundaryCounter}`;
}

/** RFC 2822 message, base64url-encoded exactly as the Gmail API's
 * `drafts.create`/`drafts.send` `raw` field requires. Supports a plain-text
 * body, or a `multipart/alternative` plain+HTML body when `bodyHtml` is
 * given. No third-party MIME library — the shape needed here is small and
 * fully deterministic. */
function buildRawMessage(input: { to: string[]; cc: string[]; bcc: string[]; subject: string; bodyText: string; bodyHtml: string | null }): string {
  const headerLines = [
    `To: ${input.to.join(', ')}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    ...(input.bcc.length ? [`Bcc: ${input.bcc.join(', ')}`] : []),
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
  ];
  let body: string;
  if (input.bodyHtml) {
    const boundary = freshBoundary();
    headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      input.bodyText,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      input.bodyHtml,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    headerLines.push('Content-Type: text/plain; charset="UTF-8"');
    body = input.bodyText;
  }
  const mime = [...headerLines, '', body].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** Splits a header value like `"Bob <bob@example.com>, carol@example.com"`
 * into individual address strings. A best-effort comma split — sufficient
 * for the simple address lists this connector's own drafts produce; it does
 * not attempt full RFC 5322 address-list parsing of arbitrary inbound mail. */
function splitAddressList(headerValue: string): string[] {
  return headerValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runGmailSearch(args: Record<string, unknown>, deps: CallDeps): Promise<ToolExecutionResult> {
  const requested = Number(args.maxResults);
  const maxResults = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_LIST_RESULTS)
    : DEFAULT_LIST_RESULTS;
  const params: Record<string, unknown> = { userId: 'me', maxResults };
  const query = trimmedNonEmptyString(args.query);
  if (query) params.q = query;

  const listOutcome = await callGws(deps, ['gmail', 'users', 'messages', 'list', '--params', JSON.stringify(params)], 'gmail_search_failed');
  if (!listOutcome.ok) return listOutcome.result;
  const listData = listOutcome.data as { messages?: Array<{ id?: string; threadId?: string }>; resultSizeEstimate?: number; nextPageToken?: string } | null;
  const stubs = (listData?.messages ?? []).filter((m) => typeof m.id === 'string');

  const lookups = stubs.slice(0, MAX_METADATA_LOOKUPS);
  const resolved = await mapWithConcurrency(lookups, MAX_METADATA_CONCURRENCY, async (stub) => {
    const getParams = {
      userId: 'me',
      id: stub.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    };
    const outcome = await callGws(deps, ['gmail', 'users', 'messages', 'get', '--params', JSON.stringify(getParams)], 'gmail_search_metadata_failed');
    if (!outcome.ok) return null; // a failed lookup leaves no slot; it is counted and reported below
    const summary = summarizeGmailMessage(outcome.data as GmailApiMessage, deps.timeZone);
    return {
      id: summary.id || String(stub.id),
      threadId: summary.threadId || String(stub.threadId ?? ''),
      subject: summary.subject,
      from: summary.from,
      date: summary.date,
      receivedAt: summary.receivedAt,
      receivedLocal: summary.receivedLocal,
      snippet: summary.snippet,
      // Gmail's own labels (INBOX, UNREAD, STARRED, CATEGORY_PROMOTIONS…) let a briefing triage without guessing.
      labels: Array.isArray((outcome.data as GmailApiMessage).labelIds) ? (outcome.data as GmailApiMessage).labelIds! : [],
    };
  });
  // Keep the user-facing list in the same order as the `list` returned; drop the
  // slots that failed so `failedLookups` stays an honest count of what was lost.
  const results = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
  const failedLookups = lookups.length - results.length;
  const listed = stubs.length;
  const moreAvailable = Boolean(listData?.nextPageToken);
  // Gmail's resultSizeEstimate is only an estimate; when the list fit on one page (no nextPageToken) the listed count is exact.
  let matched = moreAvailable ? Math.max(Number(listData?.resultSizeEstimate) || 0, listed) : listed;
  let matchedIsExact = !moreAvailable;
  if (moreAvailable) {
    // The two common "how many unread" questions have an exact answer from Gmail's own label counters.
    const normalized = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
    const labelId = normalized === 'in:inbox is:unread' ? 'INBOX' : normalized === 'is:unread' ? 'UNREAD' : null;
    if (labelId) {
      const label = await callGws(deps, ['gmail', 'users', 'labels', 'get', '--params', JSON.stringify({ userId: 'me', id: labelId })], 'gmail_label_count_failed');
      if (label.ok) {
        const data = label.data as { messagesUnread?: number; messagesTotal?: number } | null;
        const exact = labelId === 'INBOX' ? data?.messagesUnread : data?.messagesTotal;
        if (typeof exact === 'number' && exact >= listed) { matched = exact; matchedIsExact = true; }
      }
    }
  }
  const counts = { matched, matchedIsExact, listed, shown: results.length, failedLookups, timeZone: deps.timeZone };
  const note = results.length === matched
    ? `All ${matched} matching message(s) are shown.`
    : `Showing ${results.length} of ${matchedIsExact ? matched : `about ${matched}`} matching message(s)${failedLookups ? `; ${failedLookups} could not be loaded` : ''}${moreAvailable ? '; more exist beyond this page' : ''}. State both numbers; do not present the shown count as the total.`;
  return succeeded('gmail_search_succeeded', { results, truncated: moreAvailable || listed > lookups.length, counts, note });
}

async function runGmailReadThread(args: Record<string, unknown>, deps: CallDeps): Promise<ToolExecutionResult> {
  const threadId = trimmedNonEmptyString(args.threadId);
  if (!threadId) return invalidArgs('gmail_read_thread: "threadId" is required');
  const params = { userId: 'me', id: threadId, format: 'full' };
  const outcome = await callGws(deps, ['gmail', 'users', 'threads', 'get', '--params', JSON.stringify(params)], 'gmail_read_thread_failed');
  if (!outcome.ok) return outcome.result;
  const messages = summarizeGmailThread(outcome.data as GmailApiThread, deps.timeZone);
  return succeeded('gmail_read_thread_succeeded', { threadId, messages });
}

async function runGmailCreateDraft(
  args: Record<string, unknown>,
  deps: CallDeps,
  accountEmail: string,
  bindings: GwsGmailDraftBindingStore,
): Promise<ToolExecutionResult> {
  const to = stringArray(args.to);
  const subject = typeof args.subject === 'string' ? args.subject : '';
  const bodyText = typeof args.bodyText === 'string' ? args.bodyText : '';
  if (!to.length) return invalidArgs('gmail_create_draft: "to" must be a non-empty array of addresses');
  if (!bodyText.trim()) return invalidArgs('gmail_create_draft: "bodyText" is required');
  const cc = stringArray(args.cc);
  const bcc = stringArray(args.bcc);
  const bodyHtml = trimmedNonEmptyString(args.bodyHtml);
  const threadId = trimmedNonEmptyString(args.threadId);

  const raw = buildRawMessage({ to, cc, bcc, subject, bodyText, bodyHtml });
  const message: Record<string, unknown> = { raw };
  if (threadId) message.threadId = threadId;
  const outcome = await callGws(
    deps,
    ['gmail', 'users', 'drafts', 'create', '--params', JSON.stringify({ userId: 'me' }), '--json', JSON.stringify({ message })],
    'gmail_create_draft_failed',
  );
  if (!outcome.ok) return outcome.result;
  const data = outcome.data as { id?: string; message?: { id?: string; threadId?: string } } | null;
  const draftId = data?.id;
  if (!draftId) {
    return { status: 'failed', exitCode: null, output: 'gws created a draft but returned no draft ID', resultCategory: 'gmail_create_draft_no_id' };
  }
  const resultThreadId = data?.message?.threadId ?? threadId ?? null;
  const content: GmailDraftContent = {
    accountEmail,
    draftId,
    threadId: resultThreadId,
    to,
    cc,
    bcc,
    subject,
    bodyText,
    bodyHtml,
  };
  bindings.record(content);
  return succeeded('gmail_create_draft_succeeded', { draftId, threadId: resultThreadId });
}

async function runGmailSendDraft(
  args: Record<string, unknown>,
  deps: CallDeps,
  accountEmail: string,
  bindings: GwsGmailDraftBindingStore,
  expectedDigest: string | undefined,
): Promise<ToolExecutionResult> {
  const draftId = trimmedNonEmptyString(args.draftId);
  if (!draftId) return invalidArgs('gmail_send_draft: "draftId" is required');
  if (!expectedDigest) {
    return {
      status: 'failed', exitCode: null,
      output: 'no approved digest is bound to this send request; the draft must be re-created and re-approved',
      resultCategory: 'gmail_send_draft_unapproved',
    };
  }

  // Gmail's API never echoes Bcc back on a read (by design, for every
  // client, not just this one) — a live re-read alone cannot verify it.
  // Bcc integrity is instead protected by Core's own binding row (the value
  // recorded on the same trip that computed the originally-approved digest,
  // covering the narrower "did Core's own durable record change" question
  // rather than the unanswerable "did Gmail's copy change"). A missing
  // binding at this point is refused rather than silently treated as an
  // empty Bcc — that would let a real mismatch go undetected.
  const binding = bindings.get(draftId);
  if (!binding) {
    return {
      status: 'failed', exitCode: null,
      output: 'no approved draft record is on file for this draft id; the draft must be re-created and re-approved',
      resultCategory: 'gmail_send_draft_unapproved',
    };
  }

  const getOutcome = await callGws(
    deps,
    ['gmail', 'users', 'drafts', 'get', '--params', JSON.stringify({ userId: 'me', id: draftId, format: 'full' })],
    'gmail_send_draft_reread_failed',
  );
  if (!getOutcome.ok) return getOutcome.result;
  const draftData = getOutcome.data as { id?: string; message?: GmailApiMessage } | null;
  const message = draftData?.message;
  if (!message) {
    return { status: 'failed', exitCode: null, output: 'gws returned a draft with no message content to verify', resultCategory: 'gmail_send_draft_malformed' };
  }
  const summary = summarizeGmailMessage(message);
  const liveContent: GmailDraftContent = {
    accountEmail,
    draftId,
    threadId: summary.threadId || null,
    to: splitAddressList(summary.to),
    cc: splitAddressList(summary.cc),
    bcc: binding.bcc,
    subject: summary.subject,
    bodyText: summary.bodyText,
    bodyHtml: summary.bodyHtml || null,
  };
  const liveDigest = computeGmailDraftDigest(liveContent);
  if (liveDigest !== expectedDigest) {
    return {
      status: 'failed', exitCode: null,
      output: 'the draft no longer matches what was approved (content or connected account changed since review); refusing to send. Re-create and re-approve the draft.',
      resultCategory: 'gmail_send_draft_stale_digest',
    };
  }

  const sendOutcome = await callGws(
    deps,
    ['gmail', 'users', 'drafts', 'send', '--params', JSON.stringify({ userId: 'me' }), '--json', JSON.stringify({ id: draftId })],
    'gmail_send_draft_failed',
  );
  if (!sendOutcome.ok) return sendOutcome.result;
  const sent = sendOutcome.data as { id?: string; threadId?: string } | null;
  // The binding is deliberately NOT cleared here: `connectorDispatch.ts`'s
  // `dispatchGmailSendDraft` looks it up on every `gmail_send_draft`
  // dispatch, including a retried/idempotent re-dispatch of an
  // already-executed send (the existing terminal-invocation match in
  // `capabilityDispatch.ts` then correctly returns the prior result without
  // re-sending) — clearing it here would make that retry look like "no
  // approved draft on record" instead. Sent draft IDs are not reused by
  // Gmail, so the row is inert afterward, not a correctness risk.
  return succeeded('gmail_send_draft_succeeded', { messageId: sent?.id ?? null, threadId: sent?.threadId ?? null });
}

export function createGwsGmailProbe(config: GwsGmailAdapterConfig): ConnectorProbe {
  return async (signal) => {
    const token = config.getAccessToken();
    if (!token) return { ok: false, reason: 'no Gmail access token available' };
    const binary = resolveBinary(config);
    if (!binary.ok) return { ok: false, reason: binary.reason };
    const result = await (config.runGwsFn ?? runGws)({
      binaryPath: binary.path,
      args: ['gmail', 'users', 'getProfile', '--params', JSON.stringify({ userId: 'me' })],
      accessToken: token,
      configDir: config.configDir,
      signal,
      timeoutMs: config.timeoutMs ?? 8_000,
    });
    if (result.aborted) return { ok: false, reason: 'probe cancelled' };
    if (result.timedOut) return { ok: false, reason: 'probe timed out' };
    const parsed = parseGwsJson(result.stdout);
    if (result.exitCode === 0 && parsed.ok) return { ok: true };
    return { ok: false, reason: errorReasonFromParsed(parsed, result.stderr, result.exitCode) };
  };
}

const GMAIL_TOOL_NAMES = new Set(['gmail_search', 'gmail_read_thread', 'gmail_create_draft', 'gmail_send_draft', 'gmail_analyze_inbox', 'gmail_plan_changes', 'gmail_apply_plan', 'gmail_undo_plan']);

function organizeEnv(config: GwsGmailAdapterConfig, deps: CallDeps, accountEmail: string): OrganizeEnv {
  return {
    deps,
    accountEmail,
    store: config.organize!.store,
    hasModifyScope: config.organize!.hasModifyScope,
    ...(config.organize!.onProgress ? { onProgress: config.organize!.onProgress } : {}),
    ...(config.organize!.now ? { nowMs: config.organize!.now } : {}),
  };
}

/** Builds the exact approval card for inbox changes before any approval exists. Other Gmail tools pass through. */
export function createGwsGmailPrepare(config: GwsGmailAdapterConfig): ConnectorPrepare {
  return async (toolName, args, signal) => {
    if (toolName !== 'gmail_apply_plan' && toolName !== 'gmail_undo_plan') return { ok: true, arguments: args };
    if (!config.organize) return { ok: false, reason: 'Inbox organization is not available in this build' };
    const accountEmail = config.getAccountEmail();
    if (!config.getAccessToken() || !accountEmail) return { ok: false, reason: 'Gmail is not connected' };
    const deps: CallDeps = { binaryPath: '', accessToken: '', configDir: config.configDir, signal, runGwsFn: config.runGwsFn ?? runGws };
    return prepareOrganizeAction(toolName, args, organizeEnv(config, deps, accountEmail));
  };
}

export function createGwsGmailExecutor(config: GwsGmailAdapterConfig): ConnectorExecutor {
  return async (toolName, args, ctx) => {
    if (!GMAIL_TOOL_NAMES.has(toolName)) {
      return {
        status: 'failed',
        exitCode: null,
        output: `gws transport has no allowlisted mapping for '${toolName}'; no action was taken`,
        resultCategory: 'gws_not_allowlisted',
      };
    }
    const token = config.getAccessToken();
    const accountEmail = config.getAccountEmail();
    if (!token || !accountEmail) {
      return { status: 'failed', exitCode: null, output: 'Gmail is not configured; no action was taken', resultCategory: 'connector_not_configured' };
    }
    const binary = resolveBinary(config);
    if (!binary.ok) {
      return { status: 'failed', exitCode: null, output: binary.reason, resultCategory: 'gws_binary_unavailable' };
    }
    const deps: CallDeps = {
      binaryPath: binary.path,
      accessToken: token,
      configDir: config.configDir,
      signal: ctx.signal,
      timeoutMs: config.timeoutMs,
      runGwsFn: config.runGwsFn ?? runGws,
      timeZone: config.timeZone?.() ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    };
    try {
      switch (toolName) {
        case 'gmail_search':
          return await runGmailSearch(args, deps);
        case 'gmail_read_thread':
          return await runGmailReadThread(args, deps);
        case 'gmail_create_draft':
          return await runGmailCreateDraft(args, deps, accountEmail, config.bindings);
        case 'gmail_send_draft':
          return await runGmailSendDraft(args, deps, accountEmail, config.bindings, ctx.gmailDraftExpectedDigest);
        case 'gmail_analyze_inbox':
        case 'gmail_plan_changes':
        case 'gmail_apply_plan':
        case 'gmail_undo_plan': {
          if (!config.organize) return { status: 'failed', exitCode: null, output: 'Inbox organization is not available in this build; no action was taken', resultCategory: 'connector_not_implemented' };
          const env = organizeEnv(config, deps, accountEmail);
          if (toolName === 'gmail_analyze_inbox') return await analyzeInbox(args, env);
          if (toolName === 'gmail_plan_changes') return await planChanges(args, env);
          if (toolName === 'gmail_apply_plan') return await applyPlan(args, env);
          return await undoPlan(args, env);
        }
        default:
          return { status: 'failed', exitCode: null, output: `unreachable: '${toolName}'`, resultCategory: 'gws_not_allowlisted' };
      }
    } catch (err) {
      return { status: 'failed', exitCode: null, output: err instanceof Error ? err.message : String(err), resultCategory: 'gws_invalid_arguments' };
    }
  };
}

export function defaultGwsGmailConfigDir(dataDir: string): string {
  return path.join(dataDir, 'gws-cache', 'gmail');
}

export { buildGmailSendPresentation, canonicalizeGmailDraft, computeGmailDraftDigest };
