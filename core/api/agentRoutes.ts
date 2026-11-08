/**
 * Phase 2b — Specialist agents API. Reads are open to trusted clients; every
 * change (tighten-only edits, delegation) is host-only: models and tools can
 * never edit an agent or start a delegation through this API.
 */
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';
import { CoreError } from '../domain/errors';
import { agentHistory, agentScopeForAttempt, agentStatuses, assignAgentRun, deriveScope, getAgentDefinition, getHandoff, listScopeRefusals, markHandoff, proposeHandoff, updateAgentDefinition, type Grant } from '../domain/agents';
import { submitRequest } from '../domain/submission';

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
    const parentAttemptId = String(b.parentAttemptId ?? '');
    const toAgentId = String(b.toAgentId ?? '');
    const brief = String(b.brief ?? '');
    const grant = b.grant && typeof b.grant === 'object' ? b.grant as Grant : null;
    const parent = ctx.db.get<{ requestId: string; conversationId: string | null }>('SELECT a.requestId AS requestId, q.conversationId AS conversationId FROM attempts a JOIN requests q ON q.id = a.requestId WHERE a.id = ?', [parentAttemptId]);
    if (!parent) throw new CoreError('not_found', `parent task '${parentAttemptId}' does not exist`);
    const handoff = proposeHandoff(ctx.db, { parentAttemptId, toAgentId, brief, grant });
    if (handoff.existing && handoff.childRequestId) return ok({ handoff, duplicate: true });

    const parentScope = agentScopeForAttempt(ctx.db, parentAttemptId);
    const workspaceRoot = parentScope?.conversationRoot ?? (typeof b.workspaceRoot === 'string' ? b.workspaceRoot : null);
    const defaults = options.executor?.contextDefaults();
    const result = ctx.db.transaction(() => {
      const submitted = submitRequest(ctx.db, {
        clientId: ctx.clientId,
        currentMessage: brief,
        requestedMode: 'baat_kar',
        conversationId: parent.conversationId,
        requestedProvider: defaults?.selectedProvider ?? null,
        requestedModel: defaults?.selectedModel ?? null,
        selectedProvider: defaults?.selectedProvider ?? null,
        selectedModel: defaults?.selectedModel ?? null,
        workspaceRoot,
        effectiveAllowedTools: [],
        toolPermissionPolicy: {},
        capability: { hasWorkspace: Boolean(workspaceRoot), gitCapable: false },
        correlationId: `delegation:${handoff.id}`,
        idempotencyKey: `delegation:${handoff.id}`,
      });
      // A parent without its own agent scope is an ordinary Pandesh turn: the Chief of Staff definition is its scope.
      const parentEffective = parentScope ?? assignChiefScope(ctx.db, workspaceRoot);
      assignAgentRun(ctx.db, { requestId: submitted.request.id, agentId: toAgentId, conversationRoot: workspaceRoot, parent: parentEffective, grant, handoffId: handoff.id });
      markHandoff(ctx.db, handoff.id, { status: 'running', childRequestId: submitted.request.id });
      return submitted;
    });
    if (options.executor) void options.executor.execute(result.attempt.id).catch(() => { /* the terminal state is recorded durably */ });
    return ok({ handoff: getHandoff(ctx.db, handoff.id), attempt: result.attempt, request: result.request }, 201);
  });

  router.get('/v1/agents/handoffs/:id', (ctx, match) => ok({ handoff: getHandoff(ctx.db, match.params.id) }));
}

/** The scope an ordinary (non-agent) Pandesh turn delegates from: the Chief of Staff definition, frozen now. */
function assignChiefScope(db: ApiContext['db'], workspaceRoot: string | null) {
  // Derived without persisting: the parent request already exists and is not an agent run.
  return deriveScope(getAgentDefinition(db, 'chief'), workspaceRoot, null, null);
}
