/**
 * Free-model registry routes. Host-only (the Pandesh app), never exposed to models or tools: an agent asks for
 * provider operations through Core, and no route here returns an API key.
 */
import { CoreError } from '../domain/errors';
import type { ProviderCatalog } from '../platform/providerCatalog';
import type { PrivacyClass, TaskClass } from '../platform/freeModelEligibility';
import { FreeModelRegistryService, setActiveFreeModelRegistry } from '../runtime/freeModelRegistryService';
import { freeModelSchedule, scheduleFreeModelRefresh } from '../runtime/freeModelRegistryRoutine';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });
const bodyOf = (ctx: ApiContext): Record<string, unknown> => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body as Record<string, unknown> : {});
const TASKS: readonly TaskClass[] = ['chat', 'research', 'coding', 'structured', 'tools', 'long_context'];

export function registerFreeModelRoutes(router: Router<ApiContext, ApiResult>, options: { dataDir: string; catalog: ProviderCatalog }): FreeModelRegistryService {
  const registry = new FreeModelRegistryService(options.dataDir, options.catalog);
  setActiveFreeModelRegistry(registry);

  router.get('/v1/cloud/registry', (ctx) => { requireHost(ctx); return ok({ ...registry.state(), schedule: freeModelSchedule(ctx.db) }); });
  router.post('/v1/cloud/registry/refresh', async (ctx) => {
    requireHost(ctx);
    const outcome = await registry.refresh();
    // The daily refresh starts with the first refresh the user asks for; it can be switched off.
    if (!freeModelSchedule(ctx.db)) scheduleFreeModelRefresh(ctx.db);
    const healthChecked = await registry.healthCheckApproved();
    return ok({ outcome, healthChecked, state: registry.state(), schedule: freeModelSchedule(ctx.db) });
  });
  router.post('/v1/cloud/registry/schedule', (ctx) => {
    requireHost(ctx);
    return ok({ schedule: scheduleFreeModelRefresh(ctx.db, { enabled: bodyOf(ctx).enabled !== false }) });
  });
  router.post('/v1/cloud/registry/preferences', (ctx) => {
    requireHost(ctx);
    const b = bodyOf(ctx);
    return ok({ preferences: registry.setPreferences({
      ...(Array.isArray(b.autoProviders) ? { autoProviders: b.autoProviders as string[] } : {}),
      ...(Array.isArray(b.disabledProviders) ? { disabledProviders: b.disabledProviders as string[] } : {}),
      ...(Array.isArray(b.preferredOrder) ? { preferredOrder: b.preferredOrder as string[] } : {}),
      ...(typeof b.fallbackOnRateLimit === 'boolean' ? { fallbackOnRateLimit: b.fallbackOnRateLimit } : {}),
    }) });
  });
  router.post('/v1/cloud/registry/providers/:provider/health', async (ctx, match) => {
    requireHost(ctx);
    return ok({ result: await registry.healthCheck(match.params.provider, { force: bodyOf(ctx).force === true }), state: registry.state() });
  });
  router.post('/v1/cloud/registry/providers/:provider/qualify', async (ctx, match) => {
    requireHost(ctx);
    const model = bodyOf(ctx).model;
    if (typeof model !== 'string' || !model.trim()) throw new CoreError('invalid_request', 'model is required');
    try {
      return ok({ record: await registry.qualify(match.params.provider, model.trim()) });
    } catch (error) {
      return { status: 409, body: { error: 'not_eligible', message: (error as Error).message } };
    }
  });
  router.post('/v1/cloud/route', (ctx) => {
    requireHost(ctx);
    const b = bodyOf(ctx);
    const task = TASKS.includes(b.task as TaskClass) ? b.task as TaskClass : 'chat';
    // Anything not explicitly marked public is treated as private: local only.
    const privacy: PrivacyClass = b.privacy === 'public' ? 'public' : 'private';
    const exclude = Array.isArray(b.exclude) ? new Set((b.exclude as unknown[]).filter((v): v is string => typeof v === 'string')) : undefined;
    return ok({ task, privacy, decision: registry.route(task, privacy, exclude), preferences: registry.getPreferences() });
  });
  return registry;
}
