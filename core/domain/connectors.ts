/**
 * Jarvis Connector Foundation — Core-owned connector registry projection and
 * durable read/draft/execute permission grants (requirements #1, #2).
 *
 * This is deliberately a thin read/write layer over two things that already
 * exist rather than a second authorization system: the `connector_permissions`
 * table (migration 23) for grants, and each `ConnectorCapabilityAdapter`'s own
 * `health()`/`isConfigured()` (core/runtime/connectors) for live state. Absence
 * of a permission row means not granted — fail closed, never inferred.
 */
import type { CoreDatabase } from '../db/connection';
import type { ConnectorId, ConnectorActionTier, ConnectorPermissions, ConnectorStatus } from '../shared/wireTypes';
import { CoreError } from './errors';
import { nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import { CONNECTOR_ACTION_TIERS, deriveConnectorState, noPermissions } from '../runtime/connectors/connectorTypes';
import { CONNECTOR_LABELS } from '../runtime/connectors/connectorDefinitions';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';

function assertTier(tier: string): asserts tier is ConnectorActionTier {
  if (!CONNECTOR_ACTION_TIERS.includes(tier as ConnectorActionTier)) {
    throw new CoreError('invalid_request', `connector permission tier '${tier}' is invalid`);
  }
}

export function getConnectorPermissions(db: CoreDatabase, connectorId: ConnectorId): ConnectorPermissions {
  const rows = db.all<{ tier: string; granted: number }>(
    'SELECT tier, granted FROM connector_permissions WHERE connectorId = ?',
    [connectorId],
  );
  const permissions = noPermissions();
  for (const row of rows) {
    if (row.tier === 'read' || row.tier === 'draft' || row.tier === 'execute') {
      permissions[row.tier] = row.granted === 1;
    }
  }
  return permissions;
}

/** Grants or revokes exactly one tier for one connector. Records a durable
 * runtime event so permission changes are auditable evidence, not a silent
 * config write. */
export function setConnectorPermission(
  db: CoreDatabase,
  input: { connectorId: ConnectorId; tier: string; granted: boolean; actor: string; clientId?: string | null },
): ConnectorPermissions {
  assertTier(input.tier);
  const at = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO connector_permissions (connectorId, tier, granted, updatedAt, updatedBy)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(connectorId, tier) DO UPDATE SET granted = excluded.granted, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`,
      [input.connectorId, input.tier, input.granted ? 1 : 0, at, input.actor],
    );
    recordRuntimeEvent(db, {
      domain: 'connector',
      entityId: input.connectorId,
      eventType: input.granted ? 'connector_permission_granted' : 'connector_permission_revoked',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { connectorId: input.connectorId, tier: input.tier },
    });
  });
  return getConnectorPermissions(db, input.connectorId);
}

/** Fail-closed: absence of a grant row (or any tier other than the one
 * actually granted) means not permitted. Used by `connectorDispatch.ts`
 * *before* `dispatchCapability` is ever called, so a `read` grant can never
 * reach a `draft`/`execute` tool. */
export function hasConnectorPermission(
  db: CoreDatabase,
  connectorId: ConnectorId,
  tier: ConnectorActionTier,
): boolean {
  return getConnectorPermissions(db, connectorId)[tier] === true;
}

/** One connector's truthful status, straight from its adapter's cached
 * `health()` (never a probe itself — callers that need a fresh read call
 * `adapter.probeHealth()` first, e.g. `core/api/routes.ts`'s Gmail
 * access-token and retry-probe routes) plus its durable permission grants. A
 * connector whose adapter is somehow unregistered is still reported, as
 * `unavailable`, never silently omitted. */
export function getConnectorStatus(
  db: CoreDatabase,
  adapters: Map<ConnectorId, ConnectorAdapter>,
  id: ConnectorId,
): ConnectorStatus {
  const adapter = adapters.get(id);
  const checkedAt = nowIso();
  if (!adapter) {
    return {
      id,
      label: CONNECTOR_LABELS[id],
      state: 'unavailable',
      reason: 'connector is not registered on this Core process',
      checkedAt,
      permissions: getConnectorPermissions(db, id),
    };
  }
  const health = adapter.health();
  return {
    id,
    label: CONNECTOR_LABELS[id],
    state: deriveConnectorState(health),
    reason: health.reason ?? null,
    checkedAt: health.checkedAt,
    permissions: getConnectorPermissions(db, id),
  };
}

/** One status entry per connector, always all four (requirement #1: the
 * registry itself, not just an adapter, is the source of truth). */
export function listConnectorStatuses(
  db: CoreDatabase,
  adapters: Map<ConnectorId, ConnectorAdapter>,
): ConnectorStatus[] {
  const ids: ConnectorId[] = ['gmail', 'google_calendar', 'whatsapp', 'printer'];
  return ids.map((id) => getConnectorStatus(db, adapters, id));
}
