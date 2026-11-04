/**
 * Host-only HTTP surface of the household OS (`/v1/household/*`), used by the desktop's Household panel.
 *
 * A click in the Pandesh window is the person's own decision (like the daily-brief routine's settings), so these routes
 * act directly — but only for the verified host: a model, a tool, a paired browser or a phone can call none of them.
 */
import type { Router } from './router';
import type { ApiContext, ApiResult } from './context';
import type { ConnectorId } from '../shared/wireTypes';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';
import type { EventBroadcaster } from '../ws/broadcaster';
import { CoreError } from '../domain/errors';
import { getOrganizationPlan, listOrganizationPlans, listOrganizationRules, moveCounts } from '../domain/fileOrganization';
import { applyOrganizationPlan, proposeOrganization, renderApplyReport, renderPlanPreview, undoOrganizationPlan, validateRoot } from '../runtime/pcOrganizer';
import { grantDocumentReading, listDocumentReadGrants, revokeDocumentReading } from '../domain/documentReadGrants';
import { decideObligation, listObligationEvidence, listObligations, type ObligationAction, type ObligationStatus } from '../domain/householdObligations';
import { controlHouseholdRoutine, createHouseholdRoutine, listHouseholdRoutines, type HouseholdRoutineKind, type RoutineControl } from '../domain/householdRoutines';
import { getScheduledTask } from '../domain/scheduledTasks';
import { runHouseholdRoutine } from '../runtime/householdRoutineRunner';
import { createCompanionPairingCode, latestCompanionRevision, listCompanionDevices, listCompanionRecords, recentCompanionOps, revokeCompanionDevice } from '../domain/companionSync';
import { companionController, readCompanionSettings, writeCompanionSettings } from './companionServer';
import { probeCapabilityInventory } from '../runtime/capabilityInventory';
import { publishBriefing, renderHouseholdBriefing } from '../runtime/householdService';

const ok = (payload: unknown): ApiResult => ({ status: 200, body: payload });

function body(ctx: ApiContext): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new CoreError('invalid_request', 'request body must be a JSON object');
  return ctx.body as Record<string, unknown>;
}

function requireHost(ctx: ApiContext): string {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
  return p.id;
}

export interface HouseholdRouteOptions {
  dataDir: string;
  connectors: Map<ConnectorId, ConnectorAdapter>;
  broadcaster: EventBroadcaster;
}

export function registerHouseholdRoutes(router: Router<ApiContext, ApiResult>, options: HouseholdRouteOptions): void {
  router.get('/v1/household/overview', (ctx) => {
    requireHost(ctx);
    // A routine run that found nothing to move leaves an empty plan behind; it is history, not something to review.
    const plans = listOrganizationPlans(ctx.db, 20).map((p) => ({ ...p, counts: moveCounts(ctx.db, p.id) }))
      .filter((p) => p.origin !== 'routine' || Object.values(p.counts).some((n) => n > 0)).slice(0, 10);
    return ok({
      routines: listHouseholdRoutines(ctx.db, 5),
      obligations: listObligations(ctx.db, { status: ['proposed', 'confirmed'] }).slice(0, 50),
      plans,
      rules: listOrganizationRules(ctx.db),
      documentReading: listDocumentReadGrants(ctx.db),
      companion: { ...companionController(ctx.db, options.dataDir).status(), devices: listCompanionDevices(ctx.db), latestRevision: latestCompanionRevision(ctx.db), records: listCompanionRecords(ctx.db).length, recentOps: recentCompanionOps(ctx.db, 5) },
    });
  });

  router.get('/v1/household/capabilities', async (ctx) => {
    requireHost(ctx);
    return ok(await probeCapabilityInventory({ db: ctx.db, connectors: options.connectors, probeWeb: false }, { refresh: ctx.query.get('refresh') === '1' }));
  });

  // --- PC organization ---
  router.post('/v1/household/organization/plans', async (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    const roots = Array.isArray(b.roots) ? b.roots.map(String) : [];
    const plan = await proposeOrganization(ctx.db, { roots, targetBase: typeof b.targetBase === 'string' && b.targetBase ? b.targetBase : undefined, inspectContents: b.inspectContents === true, origin: 'host' });
    return ok({ plan, preview: renderPlanPreview(ctx.db, plan) });
  });
  router.get('/v1/household/organization/plans/:id', (ctx, match) => {
    requireHost(ctx);
    const plan = getOrganizationPlan(ctx.db, match.params.id);
    return ok({ plan, counts: moveCounts(ctx.db, plan.id), preview: renderPlanPreview(ctx.db, plan, Number(ctx.query.get('limit')) || 50) });
  });
  router.post('/v1/household/organization/plans/:id/apply', async (ctx, match) => {
    const who = requireHost(ctx);
    const b = body(ctx);
    const report = await applyOrganizationPlan(ctx.db, match.params.id, {
      actor: who, expectedDigest: typeof b.digest === 'string' ? b.digest : undefined, categories: Array.isArray(b.categories) ? b.categories.map(String) : undefined,
      includeUnits: b.includeUnits === true, archiveDuplicates: b.archiveDuplicates === true, saveRules: b.saveRules === true,
    });
    return ok({ report, text: renderApplyReport(report) });
  });
  router.post('/v1/household/organization/plans/:id/undo', async (ctx, match) => {
    requireHost(ctx);
    return ok(await undoOrganizationPlan(ctx.db, match.params.id));
  });

  // --- Routines ---
  router.post('/v1/household/routines', (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    const task = createHouseholdRoutine(ctx.db, {
      kind: String(b.kind) as HouseholdRoutineKind, title: typeof b.title === 'string' ? b.title : undefined, dailyTime: typeof b.time === 'string' ? b.time : undefined,
      timezone: typeof b.timezone === 'string' ? b.timezone : undefined, recurrence: (b.recurrence as never) ?? undefined, scope: (b.scope as never) ?? undefined,
    });
    return ok({ routine: listHouseholdRoutines(ctx.db).find((r) => r.id === task.id) });
  });
  router.post('/v1/household/routines/:id/:action', async (ctx, match) => {
    requireHost(ctx);
    const action = match.params.action;
    if (action === 'run') {
      const r = await runHouseholdRoutine(ctx.db, options.broadcaster, getScheduledTask(ctx.db, match.params.id), 'manual', { connectorRegistry: options.connectors, cwd: options.dataDir });
      return ok({ run: r.run, reason: r.reason });
    }
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new CoreError('invalid_request', 'action must be pause, resume, cancel or run');
    controlHouseholdRoutine(ctx.db, match.params.id, action as RoutineControl);
    return ok({ routine: listHouseholdRoutines(ctx.db).find((r) => r.id === match.params.id) });
  });

  // --- Obligations ---
  router.get('/v1/household/obligations', (ctx) => {
    requireHost(ctx);
    const status = (ctx.query.get('status')?.split(',').filter(Boolean) ?? ['proposed', 'confirmed']) as ObligationStatus[];
    const obligations = listObligations(ctx.db, { status });
    return ok({ obligations: obligations.map((o) => ({ ...o, evidence: listObligationEvidence(ctx.db, o.id).slice(-3) })) });
  });
  router.post('/v1/household/obligations/:id/:action', (ctx, match) => {
    const who = requireHost(ctx);
    const b = body(ctx);
    const action = match.params.action as ObligationAction;
    if (!['confirm', 'resolve', 'dismiss', 'reopen'].includes(action)) throw new CoreError('invalid_request', 'action must be confirm, resolve, dismiss or reopen');
    return ok({ obligation: decideObligation(ctx.db, match.params.id, { action, actor: who, resolution: b.resolution === 'paid' ? 'paid' : undefined, corrections: typeof b.date === 'string' ? { nextDate: b.date } : undefined }) });
  });

  // --- Document reading: the person's own, separate decision per folder ---
  router.post('/v1/household/document-reading', (ctx) => {
    const who = requireHost(ctx);
    const b = body(ctx);
    const v = validateRoot(String(b.folder ?? ''));
    if (!v.ok) throw new CoreError('invalid_request', `that folder cannot be allowed: ${v.reason}`);
    return ok({ grant: grantDocumentReading(ctx.db, v.root, who), grants: listDocumentReadGrants(ctx.db) });
  });
  router.post('/v1/household/document-reading/:id/revoke', (ctx, match) => {
    const who = requireHost(ctx);
    return ok({ revoked: revokeDocumentReading(ctx.db, match.params.id, who), grants: listDocumentReadGrants(ctx.db) });
  });

  // --- JUGAAD companion ---
  router.post('/v1/household/companion/settings', async (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    const current = readCompanionSettings(options.dataDir);
    const next = { enabled: b.enabled === undefined ? current.enabled : b.enabled === true, bind: b.bind === 'lan' ? 'lan' as const : b.bind === 'loopback' ? 'loopback' as const : current.bind, port: Number.isInteger(b.port) ? Number(b.port) : current.port };
    writeCompanionSettings(options.dataDir, next);
    const controller = companionController(ctx.db, options.dataDir);
    await controller.apply(next);
    return ok(controller.status());
  });
  router.post('/v1/household/companion/pairing-code', (ctx) => {
    requireHost(ctx);
    const status = companionController(ctx.db, options.dataDir).status();
    if (!status.listening) throw new CoreError('invalid_transition', 'turn on phone sync first, so the phone can reach Pandesh');
    return ok({ ...createCompanionPairingCode(), port: status.port, scheme: 'https', certificateFingerprint: status.certificateFingerprint, addresses: status.settings.bind === 'lan' ? status.lanAddresses : ['10.0.2.2 (Android emulator)', '127.0.0.1 (USB with adb reverse)'] });
  });
  router.post('/v1/household/companion/devices/:id/revoke', (ctx, match) => {
    requireHost(ctx);
    return ok({ device: revokeCompanionDevice(ctx.db, match.params.id) });
  });
  router.post('/v1/household/companion/briefing', (ctx) => {
    requireHost(ctx);
    const b = renderHouseholdBriefing(ctx.db, null);
    return ok({ record: publishBriefing(ctx.db, 'Household briefing', b.lines), markdown: b.markdown });
  });
}
