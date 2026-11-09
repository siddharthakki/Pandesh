/**
 * Revenue dashboard routes (host only — the Pandesh app, never a model or tool). The owner reads the pipeline, approves
 * or rejects drafts, and records real-world outcomes with evidence. Agents write through the revenue capability instead.
 */
import { CoreError } from '../domain/errors';
import { decideDraft, pipelineSummary, readPipeline, recordOutcome, requireTrack, TRACKS } from '../domain/revenuePipeline';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });
const wrap = <T>(fn: () => T): T => { try { return fn(); } catch (err) { throw new CoreError('invalid_request', err instanceof Error ? err.message : String(err)); } };

export function registerRevenueRoutes(router: Router<ApiContext, ApiResult>, options: { dataDir: string }): void {
  router.get('/v1/revenue', (ctx) => {
    requireHost(ctx);
    const p = readPipeline(options.dataDir);
    return ok({ tracks: (Object.keys(TRACKS) as Array<keyof typeof TRACKS>).map((t) => ({ id: t, name: TRACKS[t], summary: pipelineSummary(p[t]), ...p[t] })) });
  });
  router.post('/v1/revenue/:track/drafts/:id/decide', (ctx, match) => {
    requireHost(ctx);
    const b = (ctx.body ?? {}) as { decision?: unknown; note?: unknown };
    if (b.decision !== 'approved' && b.decision !== 'rejected') throw new CoreError('invalid_request', 'decision must be approved or rejected');
    return ok({ draft: wrap(() => decideDraft(options.dataDir, requireTrack(match.params.track), match.params.id, b.decision as 'approved', typeof b.note === 'string' ? b.note.slice(0, 500) : null)) });
  });
  router.post('/v1/revenue/:track/outcomes', (ctx, match) => {
    requireHost(ctx);
    return ok({ outcome: wrap(() => recordOutcome(options.dataDir, requireTrack(match.params.track), (ctx.body ?? {}) as never)) });
  });
}
