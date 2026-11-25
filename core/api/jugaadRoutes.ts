/**
 * Host-only HTTP surface for JUGAAD households (`/v1/jugaad/*`). Only the verified Pandesh app calls these: a phone, a paired
 * browser, a model or a tool cannot create a household, attach a phone to one, or read a household's documents from here.
 */
import type { Router } from './router';
import type { ApiContext, ApiResult } from './context';
import { CoreError } from '../domain/errors';
import { listCompanionDevices } from '../domain/companionSync';
import { attachDevice, createHousehold, detachDevice, HOUSEHOLD_ID, legacyOwnerOf, loadHouseholds, setLegacyOwner } from '../runtime/jugaad/households';
import { getDocument, listDocuments, listOutdated, listRuns, openHouseholdIndex, searchDocuments } from '../runtime/jugaad/documentIndex';
import { PIPELINE_VERSION } from '../runtime/jugaad/documentIntake';
import { startReprocess } from '../runtime/jugaad/jugaadGateway';

export interface JugaadRouteOptions { dataDir: string }

const ok = (status: number, body: unknown): ApiResult => ({ status, body });

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}

function body(ctx: ApiContext): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new CoreError('invalid_request', 'request body must be a JSON object');
  return ctx.body as Record<string, unknown>;
}

function household(dataDir: string, id: string) {
  if (!HOUSEHOLD_ID.test(id) || !loadHouseholds(dataDir).households.some(h => h.id === id)) throw new CoreError('not_found', 'household not found');
  return id;
}

export function registerJugaadRoutes(router: Router<ApiContext, ApiResult>, options: JugaadRouteOptions): void {
  router.get('/v1/jugaad/households', (ctx) => {
    requireHost(ctx);
    const reg = loadHouseholds(options.dataDir);
    return ok(200, { legacyOwner: reg.legacyOwner, households: reg.households.map(h => ({ ...h, devices: Object.entries(reg.devices).filter(([, hid]) => hid === h.id).map(([d]) => d), ownsLegacyRecords: reg.legacyOwner === h.id })) });
  });
  router.post('/v1/jugaad/households', (ctx) => { requireHost(ctx); return ok(201, { household: createHousehold(options.dataDir, String(body(ctx).name ?? '')) }); });
  router.post('/v1/jugaad/households/:id/devices', (ctx, match) => {
    requireHost(ctx);
    const hid = household(options.dataDir, match.params.id);
    const deviceId = String(body(ctx).deviceId ?? '');
    const device = listCompanionDevices(ctx.db).find(d => d.id === deviceId);
    if (!device || device.revokedAt) throw new CoreError('not_found', 'that phone is not paired (or its pairing was revoked)');
    attachDevice(options.dataDir, deviceId, hid);
    // Records from before households existed (important dates, briefings) are NOT given to this household automatically.
    return ok(200, { attached: true, householdId: hid, deviceId, legacyRecordsVisible: legacyOwnerOf(options.dataDir) === hid });
  });
  // The household that owns the records created before households existed. Only the owner sets it, never automatically; null clears it.
  router.post('/v1/jugaad/legacy-owner', (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    const hid = b.householdId === null ? null : household(options.dataDir, String(b.householdId ?? ''));
    setLegacyOwner(options.dataDir, hid);
    console.log(`[karkedikha-core ${new Date().toISOString()}] jugaad: legacy records now owned by ${hid ?? 'no household'} (set by ${ctx.principal.id})`);
    return ok(200, { legacyOwner: hid });
  });
  router.delete('/v1/jugaad/devices/:deviceId', (ctx, match) => { requireHost(ctx); return ok(200, { detached: detachDevice(options.dataDir, match.params.deviceId) }); });
  router.get('/v1/jugaad/households/:id/documents', (ctx, match) => {
    requireHost(ctx);
    const hid = household(options.dataDir, match.params.id);
    return ok(200, { documents: listDocuments(openHouseholdIndex(options.dataDir, hid), Number(ctx.query.get('limit') ?? 50) || 50).map(d => ({ id: d.id, name: d.name, type: d.typeLabel, bytes: d.bytes, addedAt: d.addedAt, textSource: d.textSource, fields: d.fields })) });
  });
  router.post('/v1/jugaad/households/:id/search', (ctx, match) => {
    requireHost(ctx);
    const hid = household(options.dataDir, match.params.id);
    return ok(200, { hits: searchDocuments(openHouseholdIndex(options.dataDir, hid), String(body(ctx).q ?? ''), Number(body(ctx).limit) || 10) });
  });
  // --- reprocessing: the owner decides; the original is preserved; every run stays in the history ---
  router.get('/v1/jugaad/households/:id/documents/outdated', (ctx, match) => {
    requireHost(ctx);
    const hid = household(options.dataDir, match.params.id);
    return ok(200, { pipelineVersion: PIPELINE_VERSION, outdated: listOutdated(openHouseholdIndex(options.dataDir, hid), PIPELINE_VERSION) });
  });
  router.get('/v1/jugaad/households/:id/documents/:docId/history', (ctx, match) => {
    requireHost(ctx);
    const hid = household(options.dataDir, match.params.id);
    const index = openHouseholdIndex(options.dataDir, hid);
    const doc = getDocument(index, match.params.docId);
    if (!doc) throw new CoreError('not_found', 'document not found');
    return ok(200, { document: { id: doc.id, name: doc.name, sha256: doc.sha256, storedName: doc.storedName, currentFields: doc.fields }, runs: listRuns(index, doc.id) });
  });
  router.post('/v1/jugaad/households/:id/reprocess', async (ctx, match) => {
    requireHost(ctx);
    const hid = household(options.dataDir, match.params.id);
    const b = body(ctx);
    const index = openHouseholdIndex(options.dataDir, hid);
    // Exactly what the owner named: a list of documents, or "outdated" (those made by an older pipeline). Never "everything" by default.
    const ids: string[] = Array.isArray(b.documentIds) ? b.documentIds.map(String) : b.scope === 'outdated' ? listOutdated(index, PIPELINE_VERSION, 50).map(d => d.id) : [];
    if (!ids.length) throw new CoreError('invalid_request', 'name documentIds, or scope "outdated"');
    if (ids.length > 50) throw new CoreError('invalid_request', 'at most 50 documents per request');
    const reason = typeof b.reason === 'string' ? b.reason.slice(0, 300) : null;
    const started: Array<{ documentId: string; taskId?: string; error?: string }> = [];
    for (const id of ids) {
      if (!getDocument(index, id)) { started.push({ documentId: id, error: 'document not found in this household' }); continue; }
      try { started.push({ documentId: id, taskId: (await startReprocess({ db: ctx.db, dataDir: options.dataDir }, hid, id, ctx.principal.id, reason)).taskId }); }
      catch (err) { started.push({ documentId: id, error: err instanceof Error ? err.message : String(err) }); }
    }
    return ok(202, { pipelineVersion: PIPELINE_VERSION, started });
  });
}
