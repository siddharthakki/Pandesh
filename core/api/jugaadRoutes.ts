/**
 * Host-only HTTP surface for JUGAAD households (`/v1/jugaad/*`). Only the verified Pandesh app calls these: a phone, a paired
 * browser, a model or a tool cannot create a household, attach a phone to one, or read a household's documents from here.
 */
import type { Router } from './router';
import type { ApiContext, ApiResult } from './context';
import { CoreError } from '../domain/errors';
import { listCompanionDevices } from '../domain/companionSync';
import { attachDevice, createHousehold, detachDevice, HOUSEHOLD_ID, loadHouseholds } from '../runtime/jugaad/households';
import { listDocuments, openHouseholdIndex, searchDocuments } from '../runtime/jugaad/documentIndex';

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
    return ok(200, { households: reg.households.map(h => ({ ...h, devices: Object.entries(reg.devices).filter(([, hid]) => hid === h.id).map(([d]) => d) })) });
  });
  router.post('/v1/jugaad/households', (ctx) => { requireHost(ctx); return ok(201, { household: createHousehold(options.dataDir, String(body(ctx).name ?? '')) }); });
  router.post('/v1/jugaad/households/:id/devices', (ctx, match) => {
    requireHost(ctx);
    const hid = household(options.dataDir, match.params.id);
    const deviceId = String(body(ctx).deviceId ?? '');
    const device = listCompanionDevices(ctx.db).find(d => d.id === deviceId);
    if (!device || device.revokedAt) throw new CoreError('not_found', 'that phone is not paired (or its pairing was revoked)');
    attachDevice(options.dataDir, deviceId, hid);
    return ok(200, { attached: true, householdId: hid, deviceId });
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
}
