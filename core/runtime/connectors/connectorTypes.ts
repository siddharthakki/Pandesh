/**
 * Jarvis Connector Foundation — shared types for the Gmail / Google Calendar /
 * WhatsApp / Printer connector slice.
 *
 * This does not introduce a second governed runtime: a `ConnectorCapabilityAdapter`
 * *is* a `GovernedCapabilityAdapter` (core/runtime/governedCapability.ts) plus the
 * two pieces of metadata connectors need that the generic fabric does not: which
 * `ConnectorId` it belongs to, and which of the three connector-specific action
 * tiers (`read` / `draft` / `execute`) each of its tools sits in. Dispatch,
 * approval, evidence, idempotency, redaction, and cancellation all remain
 * `core/domain/capabilityDispatch.ts` unchanged — see `connectorDispatch.ts` for
 * the one thing layered on top (the tier permission gate).
 */
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityHealthState } from '../governedCapability';
import type { ConnectorId, ConnectorActionTier, ConnectorState, ConnectorPermissions, ConnectorStatus } from '../../shared/wireTypes';

// Single source of truth for the wire-facing shapes is core/shared/wireTypes.ts
// (also used by src/core-client/CoreClient.ts and core/api/routes.ts); this
// module only re-exports them alongside the runtime-only pieces below.
export type { ConnectorId, ConnectorActionTier, ConnectorState, ConnectorPermissions, ConnectorStatus };

/** The four connectors this foundation slice governs. Fixed and closed — adding a
 * fifth connector means adding to this union and its permission/catalog wiring,
 * not inventing a second mechanism. */
export const CONNECTOR_IDS: readonly ConnectorId[] = ['gmail', 'google_calendar', 'whatsapp', 'printer'];

export const CONNECTOR_ACTION_TIERS: readonly ConnectorActionTier[] = ['read', 'draft', 'execute'];

/** `CapabilityHealthState` -> `ConnectorState`, applied to an adapter's cached
 * (non-connecting) health. Deterministic and total: every health state maps to
 * exactly one connector state. */
export function deriveConnectorState(health: CapabilityHealth): ConnectorState {
  const map: Record<CapabilityHealthState, ConnectorState> = {
    authorization_required: 'not_configured',
    available: 'connected',
    degraded: 'degraded',
    rate_limited: 'degraded',
    stale: 'degraded',
    unavailable: 'unavailable',
    cancelling: 'connecting',
  };
  return map[health.state];
}

export function noPermissions(): ConnectorPermissions {
  return { read: false, draft: false, execute: false };
}

/**
 * A `GovernedCapabilityAdapter` that additionally declares its `ConnectorId` and
 * a total tool -> tier mapping. `classify()` (inherited) still returns the
 * binary `read_only` / `consequential` risk `dispatchCapability` requires;
 * `tier()` is the finer-grained dimension `dispatchConnectorAction` gates on
 * before `dispatchCapability` is ever called.
 */
export interface ConnectorCapabilityAdapter extends GovernedCapabilityAdapter {
  readonly connectorId: ConnectorId;
  /** Fixed per tool name; never derived from call arguments. */
  tier(toolName: string): ConnectorActionTier;
  /** Cheap, synchronous credential-presence check — never a network/device call. */
  isConfigured(): boolean;
}
