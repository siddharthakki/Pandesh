/**
 * Software & Services (read-only): inventory of installed software, ports and
 * services, plus update discovery. Host-only routes (the Pandesh app), never
 * exposed to models or tools. No route here installs, updates, starts or stops
 * anything; update execution is a separate, not-yet-authorized milestone.
 */
import { CoreError } from '../domain/errors';
import { collectSoftwareInventory, dependentsOf, type SoftwareInventory } from '../runtime/software/inventory';
import { checkForUpdates, periodicCheckDue, readUpdateState, writeUpdateSettings } from '../runtime/software/updates';
import { aiRadarSchedule, scheduleAiRadar } from '../runtime/aiRadarRoutine';
import { decideRadarFinding, readRadarState, RADAR_SOURCES, radarRequestText, scanAiRadar } from '../runtime/aiRadar';
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

  // --- AI Radar (core/runtime/aiRadar.ts): public releases/advisories vs what is installed here ---
  const installedTools = (inv: SoftwareInventory) => inv.items.filter((i) => i.kind !== 'model').map((i) => ({ name: i.name, version: i.version }));
  router.get('/v1/radar', (ctx) => {
    requireHost(ctx);
    const state = readRadarState(options.dataDir);
    return ok({ ...state, findings: Object.values(state.findings).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')), sources: RADAR_SOURCES.map((s) => ({ id: s.id, name: s.name, repo: s.repo, region: s.region, category: s.category, pandesh: s.pandesh })) });
  });
  router.post('/v1/radar/scan', async (ctx) => {
    requireHost(ctx);
    const result = await scanAiRadar({ dataDir: options.dataDir, installed: installedTools(await inventory(false)) });
    return ok({ scannedAt: result.scannedAt, newFindings: result.newFindings.length, urgent: result.urgent.length, errors: result.errors });
  });
  router.get('/v1/radar/schedule', (ctx) => { requireHost(ctx); return ok({ schedule: aiRadarSchedule(ctx.db) }); });
  router.post('/v1/radar/schedule', (ctx) => {
    requireHost(ctx);
    const b = (ctx.body ?? {}) as { enabled?: unknown; dailyTime?: unknown };
    return ok({ schedule: scheduleAiRadar(ctx.db, { enabled: b.enabled === false ? false : true, dailyTime: typeof b.dailyTime === 'string' ? b.dailyTime : undefined }) });
  });
  router.post('/v1/radar/findings/:id/decision', (ctx, match) => {
    requireHost(ctx);
    const b = (ctx.body ?? {}) as { action?: unknown; note?: unknown };
    const action = String(b.action ?? '');
    if (!['investigate', 'prepare_update', 'dismiss'].includes(action)) throw new CoreError('invalid_request', 'action must be investigate, prepare_update or dismiss');
    let finding;
    try { finding = decideRadarFinding(options.dataDir, decodeURIComponent(match.params.id), action as 'investigate', typeof b.note === 'string' ? b.note.slice(0, 500) : null); }
    catch (err) { throw new CoreError('not_found', err instanceof Error ? err.message : String(err)); }
    // Investigate / Prepare update hand the desktop a normal chat request to send; Core governs it like any message.
    return ok({ finding, request: action === 'dismiss' ? null : radarRequestText(finding, action as 'investigate' | 'prepare_update') });
  });

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
