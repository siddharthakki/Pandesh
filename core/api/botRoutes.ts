/**
 * My Bots and Automations (host-only routes, the Pandesh app). A Bot is a Hermes profile plus Pandesh's record of
 * what it may read; see core/runtime/bots. No route here lets a Bot act: a run only reads and reports.
 */
import { CoreError } from '../domain/errors';
import { getScheduledTask, listScheduledTasks, rescheduleDailyTask, setScheduledTaskEnabled, type ScheduledTaskRecord } from '../domain/scheduledTasks';
import { HOUSEHOLD_ROUTINES } from '../domain/householdRoutines';
import type { EventBroadcaster } from '../ws/broadcaster';
import type { ConnectorId } from '../shared/wireTypes';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';
import { BOT_SOURCES, type BotSourceId } from '../runtime/bots/botStore';
import { BotService, STANDARD_BOTS } from '../runtime/bots/botService';
import { BOT_ROUTINE, runBot } from '../runtime/bots/botRunner';
import type { HermesBotRuntime } from '../runtime/bots/hermesBotRuntime';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });

export interface BotRouteOptions { dataDir: string; connectors?: Map<ConnectorId, ConnectorAdapter>; broadcaster?: EventBroadcaster; hermes?: HermesBotRuntime }

/** What the Automations page shows for any scheduled routine: who runs it and what it last did. */
export function automationRow(task: ScheduledTaskRecord, service: BotService): Record<string, unknown> {
  const botId = task.routine === BOT_ROUTINE ? (task.scope as { botId?: string } | null)?.botId ?? null : null;
  const bot = botId ? service.store.get(botId) : null;
  const lastRun = bot ? service.store.runs(bot.id, 12).find((r) => r.taskId === task.id) ?? null : null;
  return {
    id: task.id, title: task.title, purpose: task.purpose, enabled: task.enabled, dailyTime: task.dailyTime, timezone: task.timezone, repeat: task.repeat, recurrence: task.recurrence,
    nextRunAt: task.enabled ? task.nextRunAt : null, lastRunAt: task.lastRunAt, routine: task.routine, conversationId: bot?.conversationId ?? task.conversationId,
    owner: 'Pandesh Core scheduler',
    // "Run now" exists only where Core has a route that runs it on demand.
    runNow: task.routine === BOT_ROUTINE ? (bot ? 'bot' : null) : task.routine && HOUSEHOLD_ROUTINES.has(task.routine) ? 'household' : null,
    kind: task.routine === BOT_ROUTINE ? 'bot' : task.routine ? 'built_in' : 'instruction',
    bot: bot ? { id: bot.id, name: bot.name, status: bot.status } : null,
    lastResult: lastRun ? { status: lastRun.status, reason: lastRun.reason, at: lastRun.finishedAt ?? lastRun.startedAt } : null,
  };
}

export function registerBotRoutes(router: Router<ApiContext, ApiResult>, options: BotRouteOptions): void {
  const serviceFor = (ctx: ApiContext) => new BotService(ctx.db, options.dataDir, { hermes: options.hermes });
  const body = (ctx: ApiContext) => (ctx.body ?? {}) as Record<string, unknown>;
  const sourcesOf = (value: unknown): BotSourceId[] | undefined => (Array.isArray(value) ? value.filter((s): s is BotSourceId => typeof s === 'string' && s in BOT_SOURCES) : undefined);

  router.get('/v1/bots', async (ctx) => {
    requireHost(ctx);
    const service = serviceFor(ctx);
    const hermes = await service.hermesStatus(ctx.query.get('refresh') === '1');
    const bots = service.list();
    const managed = new Set(bots.map((b) => b.profile));
    return ok({
      hermes,
      bots,
      // Hermes profiles that exist on this PC but are not Pandesh Bots: shown, never run by Pandesh.
      otherProfiles: service.hermes.listProfiles().filter((p) => !managed.has(p.name)).map((p) => ({ name: p.name, description: p.description, model: p.model, localOnly: p.localOnly })),
      sources: Object.entries(BOT_SOURCES).map(([id, s]) => ({ id, ...s })),
      standard: STANDARD_BOTS.map((s) => ({ kind: s.kind, name: s.name, responsibility: s.responsibility, exists: bots.some((b) => b.kind === s.kind) })),
      scheduler: 'Pandesh Core scheduler (Hermes cron is not used for Bots)',
    });
  });

  router.post('/v1/bots', async (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    const bot = await serviceFor(ctx).create({
      name: String(b.name ?? ''), responsibility: String(b.responsibility ?? ''), instructions: typeof b.instructions === 'string' ? b.instructions : undefined,
      sources: sourcesOf(b.sources), model: typeof b.model === 'string' ? b.model : undefined, repoPath: typeof b.repoPath === 'string' ? b.repoPath : null,
    });
    return ok({ bot });
  });

  router.post('/v1/bots/standard', async (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    const only = Array.isArray(b.only) ? b.only.filter((k): k is 'inbox' | 'pc' | 'scout' | 'engineer' => ['inbox', 'pc', 'scout', 'engineer'].includes(String(k))) : undefined;
    return ok(await serviceFor(ctx).ensureStandard({ repoPath: typeof b.repoPath === 'string' ? b.repoPath : null, only }));
  });

  router.get('/v1/bots/:id', (ctx, match) => {
    requireHost(ctx);
    const service = serviceFor(ctx);
    const bot = service.require(match.params.id);
    return ok({ bot: service.view(bot), instructions: service.hermes.readSoul(bot.profile), memory: service.hermes.readMemory(bot.profile), runs: service.store.runs(bot.id, 25) });
  });

  router.post('/v1/bots/:id', (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    const service = serviceFor(ctx);
    let bot = service.view(service.require(match.params.id));
    if (b.status === 'active' || b.status === 'paused') bot = service.setStatus(bot.id, b.status);
    const patch = {
      ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(typeof b.responsibility === 'string' ? { responsibility: b.responsibility } : {}),
      ...(typeof b.instructions === 'string' ? { instructions: b.instructions } : {}), ...(typeof b.model === 'string' ? { model: b.model } : {}),
      ...(sourcesOf(b.sources) ? { sources: sourcesOf(b.sources) } : {}), ...('repoPath' in b ? { repoPath: typeof b.repoPath === 'string' ? b.repoPath : null } : {}),
    };
    if (Object.keys(patch).length) bot = service.update(bot.id, patch);
    return ok({ bot });
  });

  const remove = async (ctx: ApiContext, id: string) => { requireHost(ctx); await serviceFor(ctx).remove(id); return ok({ removed: true }); };
  router.delete('/v1/bots/:id', (ctx, match) => remove(ctx, match.params.id));
  router.post('/v1/bots/:id/remove', (ctx, match) => remove(ctx, match.params.id));

  router.post('/v1/bots/:id/run', async (ctx, match) => {
    requireHost(ctx);
    const service = serviceFor(ctx);
    const bot = service.require(match.params.id);
    const question = typeof body(ctx).question === 'string' ? String(body(ctx).question).trim().slice(0, 1500) : null;
    // A run takes minutes, so it is started here and read back through GET /v1/bots/:id ("running", then its record).
    // `wait: true` (tests, scripts) answers when it ends instead.
    const started = runBot({ db: ctx.db, broadcaster: options.broadcaster, dataDir: options.dataDir, connectorRegistry: options.connectors, hermes: options.hermes }, { botId: bot.id, trigger: 'manual', question: question || null });
    if (body(ctx).wait === true) return ok({ started: true, run: await started, bot: service.view(service.require(bot.id)) });
    started.catch((err) => console.error(`[karkedikha-core ${new Date().toISOString()}] bot run ${bot.id} failed:`, err instanceof Error ? err.message : err));
    return ok({ started: true, run: null, bot: service.view(service.require(bot.id)) });
  });

  router.post('/v1/bots/:id/routines', (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    const task = serviceFor(ctx).addRoutine(match.params.id, {
      title: typeof b.title === 'string' ? b.title : undefined, dailyTime: String(b.dailyTime ?? ''), timezone: typeof b.timezone === 'string' ? b.timezone : undefined,
      everyDays: typeof b.everyDays === 'number' ? b.everyDays : undefined, weekdays: Array.isArray(b.weekdays) ? b.weekdays.filter((d): d is number => typeof d === 'number') : undefined,
      enabled: b.enabled === false ? false : true,
    });
    return ok({ routine: task });
  });

  router.post('/v1/bots/routines/:taskId', (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    const task = serviceFor(ctx).updateRoutine(match.params.taskId, {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, dailyTime: typeof b.dailyTime === 'string' ? b.dailyTime : undefined,
      everyDays: typeof b.everyDays === 'number' ? b.everyDays : undefined, weekdays: Array.isArray(b.weekdays) ? b.weekdays.filter((d): d is number => typeof d === 'number') : undefined,
    });
    return ok({ routine: task });
  });

  const removeRoutine = (ctx: ApiContext, taskId: string) => { requireHost(ctx); return ok({ routine: serviceFor(ctx).removeRoutine(taskId) }); };
  router.delete('/v1/bots/routines/:taskId', (ctx, match) => removeRoutine(ctx, match.params.taskId));
  router.post('/v1/bots/routines/:taskId/remove', (ctx, match) => removeRoutine(ctx, match.params.taskId));

  // Every recurring thing Core runs, in one list, each with its single scheduler owner.
  router.get('/v1/automations', (ctx) => {
    requireHost(ctx);
    const service = serviceFor(ctx);
    const tasks = listScheduledTasks(ctx.db, true).filter((t) => t.repeat === 'daily');
    return ok({ automations: tasks.map((t) => automationRow(t, service)), scheduler: 'Pandesh Core scheduler' });
  });

  // Pause, resume or re-time any recurring routine. Nothing else about it can be changed from here.
  router.post('/v1/automations/:id', (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    let task = getScheduledTask(ctx.db, match.params.id);
    if (task.repeat !== 'daily') throw new CoreError('invalid_request', 'Only a recurring routine can be changed here.');
    if (typeof b.dailyTime === 'string') task = rescheduleDailyTask(ctx.db, task.id, { dailyTime: b.dailyTime });
    if (typeof b.enabled === 'boolean') task = setScheduledTaskEnabled(ctx.db, task.id, b.enabled);
    return ok({ automation: automationRow(task, serviceFor(ctx)) });
  });
}
