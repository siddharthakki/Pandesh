/**
 * Missions API (core/domain/missions.ts). Reads are open to trusted clients; cancel and continue are host-only, like
 * every other change a model must not be able to make through the API.
 *
 * A mission's steps are delegated tasks, so anything a step asks the person (an approval card) is already reachable
 * through the conversation the mission was started from (capabilityDispatch.findCapabilityAttemptIds). The list here
 * carries those cards with each mission so the window can show them on the mission itself.
 */
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';
import { CoreError } from '../domain/errors';
import { listAgentDefinitions } from '../domain/agents';
import { listCapabilityActions } from '../domain/capabilityDispatch';
import { getMission, listMissions, missionStepAttemptIds, reopenMission, requestMissionCancel, type Mission } from '../domain/missions';
import type { CoreDatabase } from '../db/connection';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown, status = 200): ApiResult => ({ status, body });

interface RunnerLike { start(missionId: string): void; cancel(missionId: string): void }

export interface MissionView extends Mission {
  agentNames: Record<string, string>;
  /** What the running step is doing right now, from its latest recorded tool call. */
  liveActivity: { tool: string; status: string; at: string } | null;
  pendingApprovals: Array<{ approvalId: string; toolName: string; text: string; agentName: string | null; requestedAt: string }>;
}

/**
 * One readable line for a card that carries no text of its own: the tool, then the short facts in its arguments (a
 * title, a path, a count, what it writes). Long values (a whole script, file content) are left to the full card.
 */
export function approvalLine(toolName: string, args: Record<string, unknown>): string {
  const facts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (facts.length >= 6) break;
    if (typeof v === 'number' || typeof v === 'boolean') facts.push(`${k}: ${v}`);
    else if (typeof v === 'string' && v.trim() && v.length <= 140) facts.push(`${k}: ${v.trim()}`);
    else if (Array.isArray(v)) facts.push(`${k}: ${v.length} item${v.length === 1 ? '' : 's'}`);
  }
  return `${toolName.replace(/_/g, ' ')}${facts.length ? ` — ${facts.join('; ')}` : ''}`;
}

export function missionView(db: CoreDatabase, m: Mission, clientId: string): MissionView {
  const names = Object.fromEntries(listAgentDefinitions(db).map((a) => [a.id, a.name]));
  const running = m.steps.find((s) => s.status === 'running');
  let liveActivity: MissionView['liveActivity'] = null;
  let pendingApprovals: MissionView['pendingApprovals'] = [];
  if (m.status === 'running' && running?.childAttemptId) {
    try {
      const last = db.get<{ toolName: string; status: string; at: string }>('SELECT toolName, status, COALESCE(endedAt, startedAt) AS at FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt DESC LIMIT 1', [running.childAttemptId]);
      if (last) liveActivity = { tool: last.toolName, status: last.status, at: last.at };
    } catch { /* the step list is still correct without the live line */ }
    try {
      const stepAttempts = new Set(missionStepAttemptIds(db, running));
      pendingApprovals = listCapabilityActions(db, { correlationId: m.conversationId, clientId }).actions
        .filter((a) => a.actionable && a.status === 'pending' && stepAttempts.has(a.attemptId))
        .map((a) => {
          const p = (a.presentation ?? {}) as Record<string, unknown>;
          const args = (a.arguments ?? {}) as Record<string, unknown>;
          const toolName = a.toolName || String(p.toolName ?? '');
          const text = typeof p.cardText === 'string' ? p.cardText : approvalLine(toolName, args);
          return { approvalId: a.approvalId, toolName, text: String(text).slice(0, 600), agentName: a.requestedBy?.agentName ?? null, requestedAt: a.requestedAt };
        });
    } catch { /* cards are also reachable from the conversation itself */ }
  }
  return { ...m, agentNames: names, liveActivity, pendingApprovals };
}

export function registerMissionRoutes(router: Router<ApiContext, ApiResult>, options: { runner?: () => RunnerLike }): void {
  router.get('/v1/missions', (ctx) => {
    const conversationId = ctx.query.get('conversationId') || undefined;
    const activeOnly = ctx.query.get('active') === '1';
    const limit = Number(ctx.query.get('limit') ?? 12) || 12;
    return ok({ missions: listMissions(ctx.db, { conversationId, activeOnly, limit }).map((m) => missionView(ctx.db, m, ctx.clientId)) });
  });

  router.get('/v1/missions/:id', (ctx, match) => ok({ mission: missionView(ctx.db, getMission(ctx.db, match.params.id), ctx.clientId) }));

  router.post('/v1/missions/:id/cancel', (ctx, match) => {
    requireHost(ctx);
    const mission = requestMissionCancel(ctx.db, match.params.id);
    options.runner?.().cancel(mission.id);
    return ok({ mission: missionView(ctx.db, getMission(ctx.db, mission.id), ctx.clientId) });
  });

  router.post('/v1/missions/:id/continue', (ctx, match) => {
    requireHost(ctx);
    const runner = options.runner?.();
    if (!runner) throw new CoreError('invalid_request', 'missions cannot run in this Core');
    const mission = reopenMission(ctx.db, match.params.id);
    runner.start(mission.id);
    return ok({ mission: missionView(ctx.db, getMission(ctx.db, mission.id), ctx.clientId) });
  });
}
