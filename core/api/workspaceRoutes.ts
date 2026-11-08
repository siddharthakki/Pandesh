/**
 * Phase 2f — user workspaces. Social Studio drafts (host-only). Projects and
 * Wish to Reality use their existing routes; Automations read household
 * routines and the command queue that already exist.
 */
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';
import { CoreError } from '../domain/errors';
import { createSocialDraft, decideSocialDraft, listSocialDrafts } from '../domain/socialDrafts';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export function registerWorkspaceRoutes(router: Router<ApiContext, ApiResult>): void {
  router.get('/v1/social/drafts', (ctx) => { requireHost(ctx); return { status: 200, body: { drafts: listSocialDrafts(ctx.db), publishing: 'No publishing connector exists; approved drafts are not posted anywhere.' } }; });
  router.post('/v1/social/drafts', (ctx) => { requireHost(ctx); const b = rec(ctx.body); return { status: 201, body: { draft: createSocialDraft(ctx.db, { channel: String(b.channel ?? 'other'), text: String(b.text ?? '') }) } }; });
  router.post('/v1/social/drafts/:id/decide', (ctx, match) => {
    requireHost(ctx);
    const b = rec(ctx.body);
    const decision = b.decision === 'approve' || b.decision === 'reject' || b.decision === 'revise' ? b.decision : null;
    if (!decision) throw new CoreError('invalid_request', 'decision must be approve, reject or revise');
    return { status: 200, body: { draft: decideSocialDraft(ctx.db, match.params.id, { decision, note: typeof b.note === 'string' ? b.note : undefined, text: typeof b.text === 'string' ? b.text : undefined }) } };
  });
}
