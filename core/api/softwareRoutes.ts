/**
 * Software & Services (read-only): inventory of installed software, ports and
 * services, plus update discovery. Host-only routes (the Pandesh app), never
 * exposed to models or tools. No route here installs, updates, starts or stops
 * anything; update execution is a separate, not-yet-authorized milestone.
 */
import { CoreError } from '../domain/errors';
import { collectSoftwareInventory, dependentsOf, type SoftwareInventory } from '../runtime/software/inventory';
import { checkForUpdates, periodicCheckDue, readUpdateState, writeUpdateSettings } from '../runtime/software/updates';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });

export interface SoftwareRouteOptions { dataDir: string }

const INVENTORY_TTL_MS = 10 * 60_000;

export function registerSoftwareRoutes(router: Router<ApiContext, ApiResult>, options: SoftwareRouteOptions): { stop: () => void } {
  let cached: SoftwareInventory | null = null;
  let running: Promise<SoftwareInventory> | null = null;
  let checking: Promise<unknown> | null = null;

  const inventory = async (refresh: boolean): Promise<SoftwareInventory> => {
    if (!refresh && cached && Date.now() - new Date(cached.generatedAt).getTime() < INVENTORY_TTL_MS) return cached;
    if (!running) running = collectSoftwareInventory({ dataDir: options.dataDir }).then((inv) => { cached = inv; return inv; }).finally(() => { running = null; });
    return running;
  };
  const withDependents = (inv: SoftwareInventory) => ({
    ...inv,
    items: inv.items.map((item) => {
      const d = dependentsOf(item, inv);
      return { ...item, dependents: { ports: d.ports.map((p) => ({ port: p.port, pid: p.pid, process: p.processName })), services: d.services.map((s) => s.displayName) } };
    }),
  });
  const runCheck = async (trigger: 'manual' | 'periodic') => {
    if (!checking) checking = (async () => checkForUpdates(await inventory(false), { dataDir: options.dataDir }, trigger))().finally(() => { checking = null; });
    return checking;
  };

  router.get('/v1/software/inventory', async (ctx) => {
    requireHost(ctx);
    return ok(withDependents(await inventory(ctx.query.get('refresh') === '1')));
  });
  router.get('/v1/software/updates', (ctx) => {
    requireHost(ctx);
    return ok({ ...readUpdateState(options.dataDir), checking: Boolean(checking) });
  });
  router.post('/v1/software/updates/check', async (ctx) => {
    requireHost(ctx);
    return ok(await runCheck('manual'));
  });
  router.post('/v1/software/settings', (ctx) => {
    requireHost(ctx);
    const b = (ctx.body ?? {}) as { periodicEnabled?: unknown; intervalHours?: unknown };
    return ok(writeUpdateSettings(options.dataDir, {
      ...(b.periodicEnabled !== undefined ? { periodicEnabled: b.periodicEnabled === true } : {}),
      ...(b.intervalHours !== undefined ? { intervalHours: Number(b.intervalHours) } : {}),
    }));
  });

  // Periodic checks run only when the user turned them on; the timer never keeps Core alive.
  const timer = setInterval(() => {
    try { if (periodicCheckDue(readUpdateState(options.dataDir), new Date())) void runCheck('periodic').catch(() => undefined); } catch { /* next tick */ }
  }, 15 * 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
