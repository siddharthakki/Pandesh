/**
 * M49.3 — task-scoped tool surface for Saath Kar.
 *
 * A code change inside the workspace needs the workspace tools, not email, calendar, messaging,
 * printers, memory, research, browsers, image generation, OS services or network drives. Exposing
 * all of them costs small local models most of their prompt and invites irrelevant calls
 * (docs/M49_2_COHORT_FORENSICS.md). This decides, from the attempt's FROZEN context only, whether
 * the attempt gets the workspace surface or the full permitted surface.
 *
 * Task-based, never model-based. Uncertainty always falls back to the full surface. The decision
 * only narrows what is offered: hidden tools are refused by the native-call gate, while approval,
 * validation and mutation policy are unchanged. Deterministic, so a restart reproduces it.
 */
import type { MutationPolicy } from './mutationPolicy';

export type ToolSurface = 'workspace_code_change' | 'full';

export interface ToolSurfaceDecision {
  surface: ToolSurface;
  /** Stable machine-readable reason, recorded as evidence. */
  reason: string;
}

/** The smallest sufficient set for a local repository code change; post-mutation validation is host-owned. */
export const WORKSPACE_CODE_CHANGE_TOOLS: readonly string[] = ['read_file', 'run_command', 'propose_text_edit', 'propose_file_change'];

/**
 * Wording that points at something outside the workspace. Any match keeps the full surface. Deliberately specific:
 * generic programming words ("process the input", "error message", "in-memory", "print the total") are not markers.
 */
export const NON_WORKSPACE_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['email', /\b(?:e-?mails?|gmail|inbox|mailbox)\b/i],
  ['contract', /\b(?:contracts?|agreements?|leases?|ndas?|eula|employment|mou|terms of service|sla|statement of work|sow)\b/i],
  ['continuation', /\b(?:continue|resume|proceed|status|updates?|keep going|what happened|next steps?)\b/i],
  ['extraction', /\b(?:extract|extraction|inventory)\b/i],
  ['calendar', /\b(?:calendar|meetings?|appointments?)\b/i],
  ['reminder', /\b(?:remind(?:er|ers)?|alarms?|set (?:a |an )?timer)\b/i],
  ['messaging', /\b(?:whats\s?app|sms|text messages?)\b/i],
  ['printer', /\b(?:printers?|print (?:it|this|that) out|print out)\b/i],
  ['memory', /\b(?:remember|forget|recall|your memory|memories)\b/i],
  ['web', /\bhttps?:\/\/|\bwww\.|\b(?:web ?search|search (?:the )?(?:web|internet)|look (?:it|this|that) up|online|internet|research|google)\b/i],
  ['browser', /\b(?:browser|web ?pages?|websites?|inspect (?:the )?page|screenshots?)\b/i],
  ['weather', /\b(?:weather|forecast)\b/i],
  ['image', /\b(?:generate|create|make|draw|render) (?:an? |the )?(?:image|picture|photo|logo|illustration|drawing)s?\b|\bimage studio\b/i],
  ['system', new RegExp([
    String.raw`\b(?:running|runaway|hung|stuck|zombie|background) process(?:es)?\b`,
    String.raw`\bprocess(?:es)? (?:id )?#?\d+\b`,
    String.raw`\b(?:pid|process id)s?\b`,
    String.raw`\b(?:kill|stop|terminate|end) (?:the |a |this |that |every |all )?(?:\w+ )?process(?:es)?\b`,
    String.raw`\bwindows services?\b`,
    String.raw`\b(?:start|stop|restart)(?:ing)? (?:the |a )?services?\b`,
    String.raw`\bstartup (?:items|programs|apps)\b`,
    String.raw`\bscheduled tasks?\b`,
    String.raw`\btask (?:manager|scheduler)\b`,
  ].join('|'), 'i')],
  ['network_drive', /\b(?:network|mapped|shared) drives?\b|\bnas\b|\\\\[\w.-]+\\/i],
  ['outside_workspace', /\b[a-z]:[\\/]|(?:^|\s)(?:~\/|\/home\/|\/users\/)|\b(?:desktop|downloads|documents) folder\b|\boutside (?:the |this |my )?(?:workspace|project|repo(?:sitory)?)\b/i],
  ['github', /\b(?:github|pull requests?|open an issue|issue #?\d+|pr #?\d+)\b/i],
  ['diagnostics', new RegExp([
    String.raw`\b(?:run|do|perform) (?:a |the )?diagnostic(?:s)?\b`,
    String.raw`\bdiagnose (?:my |this |the )?(?:pc|computer|system|setup|machine)\b`,
    String.raw`\bcheck (?:my |this |the )?(?:pc|computer|system|setup|machine|health)\b`,
    String.raw`\bhardware(?: |-)?(?:info|information|status|telemetry)\b`,
    String.raw`\bsystem(?: |-)?(?:info|information|status|health)\b`,
    String.raw`\bcpu\b.*\b(?:usage|load|info|status)\b|\bram\b.*\b(?:usage|info|status)\b|\bmemory\b.*\b(?:usage|info|status)\b`,
    String.raw`\bgpu\b.*\b(?:usage|info|status)\b|\bvr(?:am)?\b.*\b(?:usage|info|status)\b`,
    String.raw`\bdisk(?: |-)?(?:space|usage|info|status)\b`,
  ].join('|'), 'i')],
  ['file_read', /\b(?:read|show|open|display|what is in|what's in|contents of)\b.*?\b(?:file|document|readme|log|txt|json|md|yaml|yml)\b|\bread_file\b/i],
  ['model_runtime', new RegExp([
    String.raw`\b(?:which|what|list|show|check|installed|available|running|active|current|loaded)\b.*?\b(?:models?|ollama)\b`,
    String.raw`\bmodels?\b.*?\b(?:available|installed|running|active|loaded|list)\b`,
    String.raw`\bollama\b`,
    String.raw`\b(?:local |active |current )?model provider\b`,
    String.raw`\blocal runtime\b`,
  ].join('|'), 'i')],
];

export function deriveToolSurface(input: {
  objectiveText: string | null | undefined;
  mutationPolicy: MutationPolicy;
  /** The frozen model-selection evidence says the task modifies files. */
  fileModificationRequired: boolean;
  hasWorkspace: boolean;
}): ToolSurfaceDecision {
  if (!input.hasWorkspace) return { surface: 'full', reason: 'no_workspace' };
  if (input.mutationPolicy === 'denied') return { surface: 'full', reason: 'read_only_objective' };
  if (!input.fileModificationRequired) return { surface: 'full', reason: 'no_file_modification_required' };
  const text = String(input.objectiveText ?? '');
  for (const [domain, pattern] of NON_WORKSPACE_MARKERS) {
    if (pattern.test(text)) return { surface: 'full', reason: `objective_mentions_${domain}` };
  }
  return { surface: 'workspace_code_change', reason: 'workspace_code_change_objective' };
}

/**
 * Applies a decision to an already-permitted tool list. The workspace surface is used only when every workspace tool
 * is actually present; otherwise the full list is kept (never a narrower set that lacks a needed tool).
 */
export function applyToolSurface<T extends { name: string }>(tools: readonly T[], decision: ToolSurfaceDecision): { tools: T[]; decision: ToolSurfaceDecision } {
  if (decision.surface !== 'workspace_code_change') return { tools: [...tools], decision };
  const names = new Set(tools.map((tool) => tool.name));
  if (!WORKSPACE_CODE_CHANGE_TOOLS.every((name) => names.has(name))) {
    return { tools: [...tools], decision: { surface: 'full', reason: 'workspace_tools_unavailable' } };
  }
  const allowed = new Set(WORKSPACE_CODE_CHANGE_TOOLS);
  return { tools: tools.filter((tool) => allowed.has(tool.name)), decision };
}
