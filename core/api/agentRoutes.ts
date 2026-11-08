/**
 * Phase 2b — Specialist agents API. Reads are open to trusted clients; every
 * change (tighten-only edits, delegation) is host-only: models and tools can
 * never edit an agent or start a delegation through this API.
 */
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';
import { CoreError } from '../domain/errors';
import { agentHistory, agentStatuses, getAgentDefinition, getHandoff, listScopeRefusals, updateAgentDefinition, type Grant } from '../domain/agents';
import { startDelegation } from '../domain/delegation';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

interface ExecutorLike { execute(attemptId: string): Promise<unknown>; contextDefaults(): { selectedProvider?: string | null; selectedModel?: string | null } | undefined }

export function registerAgentRoutes(router: Router<ApiContext, ApiResult>, options: { executor?: ExecutorLike | null }): void {
  router.get('/v1/agents', (ctx) => ok({ agents: agentStatuses(ctx.db) }));

  router.get('/v1/agents/:id', (ctx, match) => ok({
    agent: getAgentDefinition(ctx.db, match.params.id),
    history: agentHistory(ctx.db, match.params.id),
    refusals: listScopeRefusals(ctx.db, match.params.id),
  }));

  router.post('/v1/agents/:id/update', (ctx, match) => {
    requireHost(ctx);
    const b = rec(ctx.body);
    const patch: Parameters<typeof updateAgentDefinition>[2] = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.modelPolicy && typeof b.modelPolicy === 'object') {
      const m = rec(b.modelPolicy);
      patch.modelPolicy = { localOnly: m.localOnly !== false, models: Array.isArray(m.models) ? m.models.map(String) : [] };
    }
    if (Array.isArray(b.toolDenylist)) patch.toolDenylist = b.toolDenylist.map(String);
    if (Array.isArray(b.alwaysAsk)) patch.alwaysAsk = b.alwaysAsk.map(String);
    return ok({ agent: updateAgentDefinition(ctx.db, match.params.id, patch) });
  });

  /** Delegation: a child request for `toAgentId`, scoped to (child definition ∩ parent's frozen scope ∩ grant). */
  router.post('/v1/agents/delegate', async (ctx) => {
    requireHost(ctx);
    const b = rec(ctx.body);
    const grant = b.grant && typeof b.grant === 'object' ? b.grant as Grant : null;
    const started = startDelegation(ctx.db, {
      parentAttemptId: String(b.parentAttemptId ?? ''), toAgentId: String(b.toAgentId ?? ''), brief: String(b.brief ?? ''), grant,
      clientId: ctx.clientId, defaults: options.executor?.contextDefaults(),
      workspaceRoot: typeof b.workspaceRoot === 'string' ? b.workspaceRoot : null,
      conversation: b.ownConversation === true ? 'own' : 'parent',
    });
    if (started.duplicate) return ok({ handoff: started.handoff, duplicate: true });
    if (options.executor && started.attemptId) void options.executor.execute(started.attemptId).catch(() => { /* the terminal state is recorded durably */ });
    return ok({ handoff: started.handoff, attempt: { id: started.attemptId }, request: { id: started.requestId }, conversationId: started.conversationId }, 201);
  });

  router.get('/v1/agents/handoffs/:id', (ctx, match) => ok({ handoff: getHandoff(ctx.db, match.params.id) }));
}
