/**
 * The governed durable-memory capability, made reachable by the chat agent.
 *
 * M39 already owns the whole memory authority — the scoped, provenance-aware
 * domain in `core/domain/memory.ts`, the redaction rules, the contradiction
 * detection, the approval-bearing writes and the durable `tool_invocations`
 * evidence. What was missing was a *route*: the capability was registered in
 * the shared registry but never appeared in the live model's tool list, so the
 * shipped assistant could not remember anything.
 *
 * This module is that route and nothing more. It exposes the M39 definitions
 * verbatim and dispatches through the same `dispatchCapability` fabric the
 * connectors use, so:
 *   - read-only recalls never need an approval,
 *   - consequential writes inherit the existing 'mutation' approval envelope,
 *   - the redaction projection still runs before the approval summary and the
 *     durable evidence are written,
 *   - one approval authority, one evidence store, no second memory runtime.
 */
import type { CoreDatabase } from '../db/connection';
import type { CapabilityDispatchResult } from '../shared/wireTypes';
import { dispatchCapability } from '../domain/capabilityDispatch';
import type { GovernedCapabilityRegistry } from './governedCapability';
import { MEMORY_TOOL_NAMES } from './memoryCapability';

export interface PiMemoryBridge {
  definitions: Array<{ name: string; description: string; parameters: any; consequential: boolean }>;
  dispatch(toolName: string, args: Record<string, unknown>): Promise<CapabilityDispatchResult>;
}

export interface BuildPiMemoryBridgeOptions {
  db: CoreDatabase;
  registry: GovernedCapabilityRegistry;
  /** The conversation the turn belongs to — the durable source of a memory. */
  correlationId: string;
  clientId: string;
  cwd: string;
  actor: string;
  signal?: AbortSignal;
}

/**
 * Builds the bridge, or returns undefined when the memory capability is not in
 * this build's registry. It never invents a tool the registry does not own.
 */
export function buildPiMemoryBridge(options: BuildPiMemoryBridgeOptions): PiMemoryBridge | undefined {
  const { registry } = options;
  const definitions = registry.definitions().filter((def) => MEMORY_TOOL_NAMES.includes(def.name));
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
      toolName,
      arguments: args,
      cwd: options.cwd,
      actor: options.actor,
      clientId: options.clientId,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  };
}
