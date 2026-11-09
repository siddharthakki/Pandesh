/**
 * Phase 2d — Second Brain API. Host-only: this is the user's own knowledge,
 * shown to the user in the Pandesh app. Models reach memory only through the
 * governed memory tools, which are scope-gated per agent (2b).
 */
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';
import { CoreError } from '../domain/errors';
import { brainGraph, brainItem, brainTimeline, correctBrainFact, ensureBrainIndex, forgetBrainFact, forgetImpact, searchBrain, type BrainItemType } from '../domain/secondBrain';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });
const TYPES: BrainItemType[] = ['fact', 'note', 'commitment', 'artifact', 'entity', 'document'];
const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const type = (v: string): BrainItemType => { if (!TYPES.includes(v as BrainItemType)) throw new CoreError('invalid_request', `unknown item type '${v}'`); return v as BrainItemType; };

export function registerSecondBrainRoutes(router: Router<ApiContext, ApiResult>): void {
  router.get('/v1/knowledge/status', (ctx) => {
    requireHost(ctx);
    const index = ensureBrainIndex(ctx.db);
    const grants = ctx.db.all('SELECT id, folder, grantedAt FROM document_read_grants WHERE revokedAt IS NULL ORDER BY grantedAt');
    const sources = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_sources WHERE state = 'active'")?.n ?? 0;
    const facts = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_facts WHERE state = 'active' AND sensitivity != 'restricted'")?.n ?? 0;
    const conflicts = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_contradictions WHERE state != 'resolved'")?.n ?? 0;
    return ok({ index, grants, documents: sources, facts, openConflicts: conflicts, embeddings: 'off (the evaluation gate has not been met)' });
  });
  router.post('/v1/knowledge/reindex', (ctx) => { requireHost(ctx); return ok(ensureBrainIndex(ctx.db, true)); });
  router.get('/v1/knowledge/search', (ctx) => {
    requireHost(ctx);
    return ok(searchBrain(ctx.db, { q: ctx.query.get('q') ?? '', types: list(ctx.query.get('types'))?.map(type), scopes: list(ctx.query.get('scopes')), limit: Number(ctx.query.get('limit')) || undefined }));
  });
  router.get('/v1/knowledge/items/:type/:id', (ctx, match) => { requireHost(ctx); return ok(brainItem(ctx.db, type(match.params.type), match.params.id)); });
  router.get('/v1/knowledge/timeline', (ctx) => {
    requireHost(ctx);
    return ok({ items: brainTimeline(ctx.db, { from: ctx.query.get('from') ?? undefined, to: ctx.query.get('to') ?? undefined, types: list(ctx.query.get('types'))?.map(type), limit: Number(ctx.query.get('limit')) || undefined }) });
  });
  router.get('/v1/knowledge/graph', (ctx) => {
    requireHost(ctx);
    const ft = ctx.query.get('focusType');
    return ok(brainGraph(ctx.db, { focusType: ft ? type(ft) : undefined, focusId: ctx.query.get('focusId') ?? undefined, hops: Number(ctx.query.get('hops')) || 1 }));
  });
  router.get('/v1/knowledge/facts/:id/impact', (ctx, match) => { requireHost(ctx); return ok(forgetImpact(ctx.db, match.params.id)); });
  router.post('/v1/knowledge/facts/:id/forget', (ctx, match) => { requireHost(ctx); return ok(forgetBrainFact(ctx.db, match.params.id, 'user', ctx.clientId)); });
  router.post('/v1/knowledge/facts/:id/correct', (ctx, match) => {
    requireHost(ctx);
    const b = (ctx.body ?? {}) as { value?: unknown };
    return ok(correctBrainFact(ctx.db, { memoryId: match.params.id, value: String(b.value ?? ''), actor: 'user', clientId: ctx.clientId }));
  });
}
