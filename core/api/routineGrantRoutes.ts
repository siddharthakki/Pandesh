/**
 * Standing write permission for one scheduled routine (host-only: only a person in the Pandesh app can give or take it
 * back, never a model, a tool or the scheduler). See core/domain/routineWriteGrants.ts for what it covers and what it never does.
 */
import { CoreError } from '../domain/errors';
import { createGrant, getActiveGrant, listGrants, revokeGrant, checkGrantForWrite, GRANTABLE_OPERATIONS, GRANT_LIMIT_CAPS, GRANT_DEFAULT_LIMITS } from '../domain/routineWriteGrants';
import { getScheduledTask, listScheduledTasks } from '../domain/scheduledTasks';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';

function requireHost(ctx: ApiContext): string {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
  return p.id;
}
const asHost = (id: string): string => (id.startsWith('host:') ? id : `host:${id}`);
const bodyOf = (ctx: ApiContext): Record<string, unknown> => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body as Record<string, unknown> : {});

export function registerRoutineGrantRoutes(router: Router<ApiContext, ApiResult>): void {
  // What the host window shows: every enabled routine that works in a folder, the exact permission it could be given, and the state.
  router.get('/v1/routine-write-grants', (ctx) => {
    requireHost(ctx);
    const routines = listScheduledTasks(ctx.db, false).filter((t) => !t.routine).map((t) => {
      const scope = t.scope as { workspaceRoot?: string; workspaceAccess?: string } | null;
      const folder = scope?.workspaceRoot ?? null;
      const active = getActiveGrant(ctx.db, t.id);
      return {
        taskId: t.id, title: t.title, instruction: t.instruction, dailyTime: t.dailyTime, folder, access: scope?.workspaceAccess ?? null,
        grantable: Boolean(folder && scope?.workspaceAccess === 'read_write'),
        status: !active ? 'none' : (folder && checkGrantForWrite(ctx.db, t.id, folder).ok ? 'active' : 'stale'),
        active: active ? { id: active.id, grantedAt: active.grantedAt, frozen: active.frozen } : null,
      };
    }).filter((r) => r.folder);
    return { status: 200, body: { routines, operations: GRANTABLE_OPERATIONS, caps: GRANT_LIMIT_CAPS, defaults: GRANT_DEFAULT_LIMITS } };
  });
  router.get('/v1/scheduled-tasks/:id/write-grant', (ctx, match) => {
    requireHost(ctx);
    const task = getScheduledTask(ctx.db, match.params.id);
    const active = getActiveGrant(ctx.db, task.id);
    const scopeRoot = (task.scope as { workspaceRoot?: string } | null)?.workspaceRoot;
    const uses = ctx.db.all("SELECT path, contentBytes, readbackMatched, finalCheck, createdAt, attemptId FROM routine_write_grant_uses WHERE taskId = ? ORDER BY createdAt DESC LIMIT 20", [task.id]);
    return { status: 200, body: { taskId: task.id, active, applies: active && scopeRoot ? checkGrantForWrite(ctx.db, task.id, scopeRoot).ok : false, history: listGrants(ctx.db, task.id), recentUses: uses, grantable: { operations: GRANTABLE_OPERATIONS, caps: GRANT_LIMIT_CAPS, defaults: GRANT_DEFAULT_LIMITS } } };
  });
  router.post('/v1/scheduled-tasks/:id/write-grant', (ctx, match) => {
    const who = requireHost(ctx);
    const b = bodyOf(ctx);
    if (b.confirm !== true) throw new CoreError('invalid_request', 'the owner must confirm the permission (confirm: true) after seeing the folder, operations and limits');
    const grant = createGrant(ctx.db, {
      taskId: match.params.id,
      operations: Array.isArray(b.operations) ? b.operations.map(String) : undefined,
      limits: b.limits && typeof b.limits === 'object' ? b.limits as Record<string, number> : undefined,
      grantedBy: asHost(who),
    });
    return { status: 200, body: { grant } };
  });
  router.delete('/v1/scheduled-tasks/:id/write-grant', (ctx, match) => {
    const who = requireHost(ctx);
    getScheduledTask(ctx.db, match.params.id);
    const revoked = revokeGrant(ctx.db, match.params.id, asHost(who), 'revoked by the owner');
    return { status: 200, body: { revoked } };
  });
}
