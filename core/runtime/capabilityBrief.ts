/**
 * The capability brief: what Pandesh can actually do, right now.
 *
 * The model used to receive a flat tool list and a long system prompt, and
 * was expected to guess which of the things it could see were real. A tool
 * whose capability was down looked exactly like a tool that worked; a tool
 * that was installed but had no workflow looked exactly like one that had.
 *
 * The brief is the honest surface. It is built from the ONE authority that
 * can execute - the `GovernedCapabilityRegistry` - and from the live
 * inventory, and it separates the four states that used to be blurred
 * together:
 *
 *   installed     the binary is on this PC
 *   reachable     it answers right now
 *   executable    a Pandesh tool can really drive it
 *   authorized    this particular request may use it (the approval gate)
 *
 * An item that is only *installed* is listed as such, never as something
 * Pandesh can do. The brief is deliberately short: a local 27B model is
 * measurably worse at choosing between a large undirected tool list, so the
 * brief names the capability, the tool, and the reason when something is
 * unavailable - nothing more.
 */
import type { CapabilityHealth, GovernedCapabilityRegistry } from './governedCapability';
import type { CapabilityInventory } from './capabilityInventory';

export type CapabilityBriefState =
  /** A tool drives it and it is healthy: callable right now. */
  | 'executable'
  /** A tool drives it but the capability is degraded right now. */
  | 'degraded'
  /** A tool drives it but the capability is not available right now. */
  | 'unavailable'
  /** Installed and answering, but no Pandesh tool drives it. */
  | 'detected_only';

export interface CapabilityBriefEntry {
  capabilityId: string;
  state: CapabilityBriefState;
  /** The tools this capability owns - the model's way in. */
  tools: string[];
  /** Why it is not executable, when it is not. */
  reason?: string;
}

export interface CapabilityBrief {
  entries: CapabilityBriefEntry[];
  /** The short, model-facing text. */
  text: string;
  /** The same facts, structured - for the UI and for tests. */
  byCapability: Record<string, CapabilityBriefEntry>;
}

/** Human names for the capability ids the chat surface can reach. */
const CAPABILITY_LABELS: Record<string, string> = {
  'port-management': 'service ports',
  'system-management': 'Windows services and processes',
  'intelligence-scout': 'watches',
  browser: 'the managed browser',
  'computer-use': 'the desktop (screenshot, windows)',
  hermes: 'the Hermes specialist skills',
  weather: 'weather',
  'capability-inventory': "this PC's capabilities",
  'pc-organizer': 'organizing folders',
  household: 'household records and the phone companion',
  'media-production': 'making a promo video',
  'image-studio': 'image and video generation',
  filesystem: 'reading files outside the workspace',
  'document-tools': 'reading documents (OCR) and downloading media',
  'ollama-management': 'installing and freeing the local models',
  plan: 'declaring and checking the plan of a multi-step task',
  wish: 'the Wish-to-Reality goal, its offering and its deliverables',
  'network-drives': 'the mapped network drives',
  github: 'GitHub issues and comments',
  research: 'web research',
  memory: 'durable memory',
  workspace: 'the workspace files',
};

function labelFor(capabilityId: string): string {
  return CAPABILITY_LABELS[capabilityId] ?? capabilityId.replace(/-/g, ' ');
}

function stateFor(health: CapabilityHealth | undefined): { state: CapabilityBriefState; reason?: string } {
  if (!health) return { state: 'unavailable', reason: 'no health information' };
  switch (health.state) {
    case 'available': return { state: 'executable' };
    case 'degraded': return { state: 'degraded', reason: health.reason };
    case 'unavailable': return { state: 'unavailable', reason: health.reason };
    case 'authorization_required': return { state: 'unavailable', reason: health.reason ?? 'it needs an authorization that has not been given' };
    case 'rate_limited': return { state: 'unavailable', reason: health.reason ?? 'it is rate limited right now' };
    case 'cancelling': return { state: 'degraded', reason: health.reason ?? 'it is finishing another job' };
    case 'stale': return { state: 'degraded', reason: health.reason ?? 'its state is not known to be current' };
    default: return { state: 'unavailable', reason: health.reason };
  }
}

/**
 * Builds the brief from the registry (the authority for what can execute)
 * and, optionally, the live inventory (the authority for what is installed).
 */
export function buildCapabilityBrief(options: {
  registry: GovernedCapabilityRegistry;
  /** The capability ids the chat surface exposes to the model. */
  exposedCapabilityIds: readonly string[];
  inventory?: CapabilityInventory | null;
}): CapabilityBrief {
  const { registry, exposedCapabilityIds, inventory } = options;
  const health = registry.healthSnapshot();
  const exposed = new Set(exposedCapabilityIds);

  const toolsByCapability = new Map<string, string[]>();
  for (const definition of registry.definitions()) {
    const owner = registry.classify(definition.name)?.capabilityId;
    if (!owner) continue;
    if (exposed.size > 0 && !exposed.has(owner)) continue;
    toolsByCapability.set(owner, [...(toolsByCapability.get(owner) ?? []), definition.name]);
  }

  const entries: CapabilityBriefEntry[] = [];
  for (const [capabilityId, tools] of [...toolsByCapability.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { state, reason } = stateFor(health[capabilityId]);
    entries.push({ capabilityId, state, tools: tools.sort(), ...(reason ? { reason } : {}) });
  }

  // Installed-but-undriven tools: honest, but marked as such so the model
  // never claims to be able to do them.
  const detectedOnly: string[] = [];
  if (inventory) {
    for (const item of inventory.items) {
      if (item.status !== 'working') continue;
      if (item.driver && item.driver !== 'detected_only') continue;
      if (item.id.startsWith('ollama:')) continue;
      detectedOnly.push(item.label);
    }
  }

  const lines: string[] = ['WHAT PANDESH CAN DO RIGHT NOW (each line is a tool you may call):'];
  for (const entry of entries) {
    if (entry.state === 'executable') {
      lines.push(`- ${labelFor(entry.capabilityId)}: ${entry.tools.join(', ')}`);
    } else if (entry.state === 'degraded') {
      lines.push(`- ${labelFor(entry.capabilityId)}: ${entry.tools.join(', ')} - DEGRADED${entry.reason ? ` (${entry.reason})` : ''}`);
    } else {
      lines.push(`- ${labelFor(entry.capabilityId)}: NOT AVAILABLE${entry.reason ? ` (${entry.reason})` : ''} - do not promise it; say why`);
    }
  }
  if (detectedOnly.length) {
    lines.push(`- installed on this PC but with no Pandesh workflow (you cannot drive these): ${detectedOnly.join(', ')}`);
  }
  lines.push('Use the capability tools above for the job. Never claim a tool worked unless its result says so; never promise an unavailable capability.');

  const byCapability: Record<string, CapabilityBriefEntry> = {};
  for (const entry of entries) byCapability[entry.capabilityId] = entry;

  return { entries, text: lines.join('\n'), byCapability };
}
