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
import { buildCapabilityBrief } from './capabilityBrief';
import type { CapabilityInventory } from './capabilityInventory';

export interface PiCapabilityBridge {
  /**
   * `deferred` definitions belong to chat capabilities the request did not point at: they are executable, but the
   * chat engine offers them only when the model asks for their group (request_tools).
   */
  definitions: Array<{ name: string; description: string; parameters: any; consequential: boolean; capabilityId?: string; deferred?: boolean }>;
  dispatch(toolName: string, args: Record<string, unknown>): Promise<CapabilityDispatchResult>;
  /**
   * The honest, current capability brief: what this build can really do and
   * what is unavailable right now, with the reason. It is built from the
   * registry - the one authority that can execute - so it never lists a
   * capability that has no working tool behind it.
   */
  brief: string;
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
 *
 * The list grows in deliberate steps, and the capability brief travels with
 * it: a larger list is only safe when the model is told what is in it and
 * what is not.
 */
export const CHAT_CAPABILITY_IDS = [
  // The bounded operator set. This is deliberately NOT every capability the
  // registry owns: a live turn with the previous 20-capability list produced
  // 149 tools and ~29k prompt tokens, and the local model answered with one
  // token and no tool call. The same model answered a plain greeting, so the
  // limit is the tool surface, not the model call. These ten cover the
  // acceptance workflows (documents, ComfyUI, phone, plan, wish, browser,
  // research) plus honest capability reporting.
  'image-studio',
  'filesystem',
  'document-tools',
  'household',
  'plan',
  'wish',
  'browser',
  'research',
  'capability-inventory',
  'ollama-management',
  'weather',
] as const;

/**
 * Selects a small, targeted capability set based on the user's current request.
 * Keeps prompt payload bounded (~2-5k tokens instead of ~29k), preventing
 * small/local model overload and empty responses.
 */
export function selectCapabilitiesForIntent(requestText?: string): readonly string[] {
  if (!requestText || !requestText.trim()) {
    return [
      'capability-inventory',
      'ollama-management',
      'weather',
      'research',
    ] as const;
  }
  const text = requestText.trim();
  const caps = new Set<string>();

  // Lightweight catalog tools always available
  caps.add('capability-inventory');
  caps.add('ollama-management');

  // Revenue team: the pipeline tools for leads, offers and drafts (core/runtime/revenueCapability.ts).
  if (/\b(?:leads?|prospects?|offers?|outreach|pipeline|revenue|catering|sales|marketing|social[- ]media|instagram|campaign|posts?|kunden|angebot)\b/i.test(text)) {
    caps.add('revenue');
  }

  // The Workshop: 3D models and their follow-ups (rotate, pull apart, change a component, export).
  if (/\b(?:3-?d|three[- ]d|workshop|assembl(?:y|ies)|gears?|gearbox|mechanism|mechanical|exploded?|explode|pull (?:it|them|this) apart|put (?:it|them) back|reassembl\w*|turntable|glb|gltf|simulat\w*|queues?|serving counters?|arrival rate|waiting times?)\b/i.test(text)) {
    caps.add('workshop');
  }

  // Weather intent
  if (/\b(?:weather|forecast|temperature|rain|snow|degrees|celsius|umbrella|climate)\b/i.test(text)) {
    caps.add('weather');
  }

  // Web research / search / prices / shopping
  if (/\b(?:search|google|web|online|prices?|buy|buying|shop|shopping|links?|cheapest|cost|euro|eur|usd|\$|€|find (?:a|an|the)|compare)\b/i.test(text) || /https?:\/\//i.test(text)) {
    caps.add('research');
  }

  // System diagnostics / setup / hardware / processes / ports
  if (/\b(?:diagnostic|diagnose|telemetry|hardware|specs|ram|cpu|gpu|vram|disks?|storage|processes?|services?|ports?|check setup|setup health)\b/i.test(text)) {
    caps.add('system-management');
    caps.add('port-management');
  }

  // Desktop / screen / window inspection
  if (/\b(?:screenshot|screen|desktop|windows?\s+list|active\s+window)\b/i.test(text)) {
    caps.add('computer-use');
  }

  // Image creation / editing / studio
  if (/\b(?:image|photo|picture|artwork|illustration|drawing|render|generate (?:an? )?image|edit (?:the |this )?image|add people|snowy park)\b/i.test(text)) {
    caps.add('image-studio');
  }

  // Documents / PDF / OCR / reading files
  if (/\b(?:pdf|invoice|document|scan|scanned|ocr|receipt|transcribe|read\s+(?:the|this|a)\s+(?:file|doc|pdf|invoice))\b/i.test(text)) {
    caps.add('document-tools');
    caps.add('filesystem');
  }

  // Filesystem navigation / files outside workspace
  if (/\b(?:folder|directory|files?|downloads?|documents?|desktop folder|read_file|find_file|locate_file)\b/i.test(text)) {
    caps.add('filesystem');
  }

  // Household / routines / obligations / PC organize
  if (/\b(?:routine|every (?:week|morning|day)|bills?|obligations?|warrant(?:y|ies)|renewals?|organi[sz]e)\b/i.test(text)) {
    caps.add('household');
    caps.add('pc-organizer');
  }

  // Wish to reality / business
  if (/\b(?:wish|profitable|sell|business|deliverable)\b/i.test(text)) {
    caps.add('wish');
  }

  // Execution plan
  if (/\b(?:plan|step-by-step|phases?)\b/i.test(text)) {
    caps.add('plan');
  }

  // Browser inspection
  if (/\b(?:inspect_page|browse|browser|open\s+site)\b/i.test(text)) {
    caps.add('browser');
  }

  // If nothing specific matched, include weather and research so basic asks work
  if (caps.size <= 2) {
    caps.add('weather');
    caps.add('research');
  }

  return Array.from(caps);
}


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
  /** The live inventory, when the caller already has one: it adds the
   * "installed here but no Pandesh workflow drives it" line to the brief. */
  inventory?: CapabilityInventory | null;
  signal?: AbortSignal;
  /** The user request text, used to select the small relevant capability set. */
  requestText?: string;
  /**
   * The capability ids this surface offers. Defaults to the bounded chat
   * allowlist. A different surface (or a test proving that a capability the
   * chat list omits is still executable) can name a different set; the brief
   * follows the same set, so what the model is told and what it can call never
   * diverge.
   */
  capabilityIds?: readonly string[];
  /**
   * Capabilities the request did not select that the chat engine may add during the turn. Defaults, for a
   * request-selected set, to the rest of the chat set; an explicit `capabilityIds` defers nothing.
   */
  deferredCapabilityIds?: readonly string[];
}

/** Chat capabilities the intent selection can add beyond the bounded set. */
export const CHAT_EXPANDABLE_CAPABILITY_IDS = [...CHAT_CAPABILITY_IDS, 'system-management', 'port-management', 'computer-use', 'pc-organizer', 'revenue', 'workshop'] as const;

/**
 * Builds the bridge, or returns undefined when this build's registry owns none
 * of the selected capabilities. It never invents a tool the registry does not own.
 */
export function buildPiCapabilityBridge(options: BuildPiCapabilityBridgeOptions): PiCapabilityBridge | undefined {
  const { registry } = options;
  const capabilityIds = options.capabilityIds ?? (options.requestText ? selectCapabilitiesForIntent(options.requestText) : CHAT_CAPABILITY_IDS);
  const allowed = new Set<string>(capabilityIds);
  const deferredIds = new Set<string>(
    (options.deferredCapabilityIds ?? (options.capabilityIds || !options.requestText ? [] : CHAT_EXPANDABLE_CAPABILITY_IDS))
      .filter((id) => !allowed.has(id)),
  );
  const excluded = new Set(options.excludeToolNames ?? []);
  const definitions = registry.definitions().filter((def) => {
    if (excluded.has(def.name)) return false;
    const owner = registry.classify(def.name)?.capabilityId;
    return owner !== undefined && (allowed.has(owner) || deferredIds.has(owner));
  });
  if (definitions.length === 0) return undefined;
  const brief = buildCapabilityBrief({
    registry,
    exposedCapabilityIds: capabilityIds,
    inventory: options.inventory ?? null,
  });
  return {
    definitions: definitions.map((def) => {
      const capabilityId = registry.classify(def.name)?.capabilityId;
      return {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        consequential: registry.classify(def.name)?.risk === 'consequential',
        ...(capabilityId ? { capabilityId } : {}),
        ...(capabilityId && deferredIds.has(capabilityId) ? { deferred: true } : {}),
      };
    }),
    brief: brief.text,
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
