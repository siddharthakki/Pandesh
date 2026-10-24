/**
 * The governed Core capability surface, made reachable by the chat agent.
 *
 * Port Manager, System Management, Intelligence Scout, the browser/computer
 * surface and the Hermes specialist surface were all registered in the shared
 * `GovernedCapabilityRegistry`, but the live chat engine (Pi) builds its own
 * tool list and only bridged the connector and memory capabilities. The
 * result was a capability that existed in Core and was unreachable from a
 * conversation: "check my setup" could not call `port_check_setup`, a watch
 * could not be created, and no skill could be invoked.
 *
 * This module is that route and nothing more. It exposes the selected
 * capabilities' definitions verbatim and dispatches through the same
 * `dispatchCapability` fabric the connectors and memory use, so:
 *   - read-only calls never need an approval,
 *   - consequential calls inherit the existing 'mutation' approval envelope,
 *   - the redaction projection still runs before the approval summary and the
 *     durable evidence are written,
 *   - one approval authority, one evidence store, no second runtime.
 */
import type { CoreDatabase } from '../db/connection';
import type { CapabilityDispatchResult } from '../shared/wireTypes';
import { dispatchCapability } from '../domain/capabilityDispatch';
import type { GovernedCapabilityRegistry } from './governedCapability';

export interface PiCapabilityBridge {
  definitions: Array<{ name: string; description: string; parameters: any; consequential: boolean }>;
  dispatch(toolName: string, args: Record<string, unknown>): Promise<CapabilityDispatchResult>;
}

/**
 * The capabilities the chat surface deliberately exposes.
 *
 * This is an explicit allowlist, not "everything the registry owns": the
 * chat model already has the workspace, connector and memory surfaces, and a
 * 27B local model is measurably worse at choosing between a large undirected
 * tool list. Each id below is a capability whose tools the Pandesh system
 * prompt already instructs the model to use, or a capability that is useless
 * without a conversational route.
 */
export const CHAT_CAPABILITY_IDS = [
  'port-management',
  'system-management',
  'intelligence-scout',
  'browser',
  'computer-use',
  'hermes',
  'weather',
] as const;

export interface BuildPiCapabilityBridgeOptions {
  db: CoreDatabase;
  registry: GovernedCapabilityRegistry;
  /** The conversation the turn belongs to — the anchor for the governed call. */
  correlationId: string;
  clientId: string;
  cwd: string;
  actor: string;
  /** The attempt that owns this turn, so the anchor attempt is settled with it. */
  ownerAttemptId?: string;
  /** Tool names already offered by another surface (workspace, connectors, memory). */
  excludeToolNames?: string[];
  signal?: AbortSignal;
}

/**
 * Builds the bridge, or returns undefined when this build's registry owns none
 * of the selected capabilities. It never invents a tool the registry does not own.
 */
export function buildPiCapabilityBridge(options: BuildPiCapabilityBridgeOptions): PiCapabilityBridge | undefined {
  const { registry } = options;
  const allowed = new Set<string>(CHAT_CAPABILITY_IDS);
  const excluded = new Set(options.excludeToolNames ?? []);
  const definitions = registry.definitions().filter((def) => {
    if (excluded.has(def.name)) return false;
    const owner = registry.classify(def.name)?.capabilityId;
    return owner !== undefined && allowed.has(owner);
  });
  if (definitions.length === 0) return undefined;
  return {
    definitions: definitions.map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      consequential: registry.classify(def.name)?.risk === 'consequential',
    })),
    dispatch: (toolName, args) => dispatchCapability(options.db, registry, {
      correlationId: options.correlationId,
      // The anchor attempt is NOT owned by the chat attempt: it is the
      // conversation's governed anchor, exactly like the connector and memory
      // bridges. An owned anchor is settled when its owning turn ends, and a
      // settled anchor is never reopened — so the next turn in the same
      // conversation could never reach a capability again.
      scopeIdentity: options.ownerAttemptId ?? options.correlationId,
      toolName,
      arguments: args,
      cwd: options.cwd,
      actor: options.actor,
      clientId: options.clientId,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  };
}
