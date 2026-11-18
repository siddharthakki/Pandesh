/**
 * Mail Hub (host-only routes, the Pandesh app). Phase 1 is strictly read-only: no route here sends, moves, deletes,
 * marks, labels or exports anything, and none reaches a cloud model. Reads go through the shared Outlook connector and
 * the local index; an account that was not authorized in Mail Hub is never read or searched.
 */
import { CoreError } from '../domain/errors';
import { mailIndexFor } from '../runtime/mail/mailHub';
import { OutlookError } from '../runtime/mail/outlookConnector';
import type { MailCategory } from '../runtime/mail/mailRules';
import { BotService } from '../runtime/bots/botService';
import { botIsRunning, runBot } from '../runtime/bots/botRunner';
import type { EventBroadcaster } from '../ws/broadcaster';
import type { ConnectorId } from '../shared/wireTypes';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });
const CATEGORIES = new Set(['finance', 'career', 'event', 'orders', 'security', 'other']);

export interface MailRouteOptions { dataDir: string; connectors?: Map<ConnectorId, ConnectorAdapter>; broadcaster?: EventBroadcaster }

/** An Outlook problem is an answer the window can show ("Outlook is not running"), not a server error. */
async function guarded<T>(fn: () => Promise<T>): Promise<ApiResult> {
  try { return ok({ ok: true, ...(await fn() as object) }); }
  catch (err) {
    if (err instanceof OutlookError) return ok({ ok: false, code: err.code, error: err.message });
    throw err;
  }
}

export function registerMailRoutes(router: Router<ApiContext, ApiResult>, options: MailRouteOptions): void {
  const idx = (ctx: ApiContext) => mailIndexFor(ctx.db, options.dataDir);
  const body = (ctx: ApiContext) => (ctx.body ?? {}) as Record<string, unknown>;
  const inboxBot = (ctx: ApiContext) => { const s = new BotService(ctx.db, options.dataDir); return { service: s, bot: s.list().find((b) => b.kind === 'inbox') ?? null }; };

  // What Mail Hub knows without touching Outlook: authorization, health, settings, size.
  router.get('/v1/mail/status', (ctx) => {
    requireHost(ctx);
    const index = idx(ctx);
    const { bot } = inboxBot(ctx);
    return ok({ platform: process.platform, connector: index.connector.health(), settings: index.settings(), accounts: index.knownAccounts(), overview: index.overview().counts, storage: index.stats(),
      inboxAssistant: { exists: Boolean(bot), botId: bot?.id ?? null, usesOutlookMail: Boolean(bot?.sources.includes('outlook_mail')) } });
  });

  // Discovery reads account names and inbox counts from Outlook (no message content).
  router.post('/v1/mail/discover', (ctx) => { requireHost(ctx); return guarded(async () => ({ accounts: await idx(ctx).accounts() })); });

  router.post('/v1/mail/accounts/authorize', (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    if (typeof b.storeId !== 'string' || typeof b.enabled !== 'boolean') throw new CoreError('invalid_request', 'storeId and enabled are required');
    return guarded(async () => { idx(ctx).setAuthorized(b.storeId as string, b.enabled as boolean); return { accounts: idx(ctx).knownAccounts() }; });
  });

  router.post('/v1/mail/sync', (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    return guarded(async () => {
      const index = idx(ctx);
      const targets = typeof b.storeId === 'string' ? [b.storeId] : index.enabledStoreIds();
      const results = [];
      for (const id of targets) results.push(await index.sync(id));
      return { results, overview: index.overview().counts };
    });
  });

  router.get('/v1/mail/overview', (ctx) => { requireHost(ctx); return ok(idx(ctx).overview()); });

  router.get('/v1/mail/messages', (ctx) => {
    requireHost(ctx);
    const q = ctx.query;
    const category = q.get('category') ?? undefined;
    if (category && !CATEGORIES.has(category)) throw new CoreError('invalid_request', 'unknown category');
    return ok(idx(ctx).list({
      storeIds: q.get('store') ? [q.get('store') as string] : undefined, category: category as MailCategory | undefined, unreadOnly: q.get('unread') === '1', needsReply: q.get('needsReply') === '1',
      q: q.get('q') ?? undefined, limit: Number(q.get('limit') ?? 25), offset: Number(q.get('offset') ?? 0),
    }));
  });

  router.get('/v1/mail/messages/:id', (ctx, match) => {
    requireHost(ctx);
    return guarded(async () => {
      const m = await idx(ctx).read(match.params.id);
      if (!m) throw new CoreError('not_found', 'that message is not in the index of an authorized account');
      return { message: m };
    });
  });

  router.get('/v1/mail/activity', (ctx) => { requireHost(ctx); return ok({ activity: idx(ctx).recentActivity(Number(ctx.query.get('limit') ?? 100)), connector: idx(ctx).connector.health() }); });

  router.post('/v1/mail/settings', (ctx) => { requireHost(ctx); return ok({ settings: idx(ctx).updateSettings(body(ctx)) }); });

  // Removes what was indexed (all accounts, or one). Outlook itself is not touched.
  router.post('/v1/mail/clear', (ctx) => { requireHost(ctx); const b = body(ctx); return ok({ removed: idx(ctx).forget(typeof b.storeId === 'string' ? b.storeId : undefined) }); });

  // The owner lets the existing Inbox Assistant read the Mail Hub index (a source on the same Bot, not a second agent).
  router.post('/v1/mail/inbox-assistant', (ctx) => {
    requireHost(ctx);
    const { service, bot } = inboxBot(ctx);
    if (!bot) throw new CoreError('invalid_request', 'Create the Inbox Assistant in My Bots first.');
    const on = body(ctx).enabled !== false;
    const sources = on ? [...new Set([...bot.sources, 'outlook_mail' as const])] : bot.sources.filter((s) => s !== 'outlook_mail');
    service.update(bot.id, { sources });
    return ok({ usesOutlookMail: on });
  });

  // Ask Pandesh = a question to the existing Inbox Assistant (Hermes, local model), answered from the index only.
  router.post('/v1/mail/ask', (ctx) => {
    requireHost(ctx);
    const question = typeof body(ctx).question === 'string' ? String(body(ctx).question).trim().slice(0, 1500) : '';
    if (!question) throw new CoreError('invalid_request', 'Ask a question.');
    const { bot } = inboxBot(ctx);
    if (!bot) throw new CoreError('invalid_request', 'The Inbox Assistant does not exist yet: create it in My Bots.');
    if (!bot.sources.includes('outlook_mail')) throw new CoreError('forbidden', 'The Inbox Assistant is not allowed to read Mail Hub yet. Allow it in Mail Hub → Settings.');
    const started = runBot({ db: ctx.db, broadcaster: options.broadcaster, dataDir: options.dataDir, connectorRegistry: options.connectors }, { botId: bot.id, trigger: 'chat', question });
    started.catch((err) => console.error(`[karkedikha-core ${new Date().toISOString()}] mail ask failed:`, err instanceof Error ? err.message : err));
    idx(ctx).activity('inference', null, true, 'a question was sent to the local Inbox Assistant');
    return ok({ started: true });
  });

  router.get('/v1/mail/ask', (ctx) => {
    requireHost(ctx);
    const { service, bot } = inboxBot(ctx);
    if (!bot) return ok({ running: false, run: null });
    const run = service.store.runs(bot.id, 10).find((r) => r.trigger === 'chat') ?? null;
    return ok({ running: botIsRunning(bot.id), run });
  });
}
