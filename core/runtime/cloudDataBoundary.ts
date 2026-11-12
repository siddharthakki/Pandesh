/**
 * Private-data boundary for cloud chat turns (audit 2026-11-12, SEC-2).
 *
 * A chat that runs on a cloud model (picked before the chat, or handed over after an approved offer) used to receive
 * everything a local turn receives: whatever its tools returned (files, Gmail, Calendar, memory, the personal
 * overview), the contents of files read earlier in the chat, the folder's project notes and the earlier local turns of
 * the conversation. The owner's rule: a private document read during a cloud conversation must never become an
 * unexamined external disclosure.
 *
 * Containment is fail closed:
 *  - only tools on CLOUD_SAFE_TOOLS are offered or executed on a cloud turn. They return public web results,
 *    arithmetic, dates or Core bookkeeping, never local content. Every other tool, including a new one nobody has
 *    classified yet, is withheld;
 *  - earlier turns that did not run on a cloud model are withheld from the cloud model's history;
 *  - the private context sections (earlier reads, Gmail previews, home place, project notes, personal section,
 *    journal) are not added on a cloud turn (enforced at their call sites in piAgentEngine.ts).
 */

/**
 * Tools whose results contain no local private data.
 * - calculate, resolve_time: arithmetic and date resolution on the model's own arguments.
 * - web_research, request_search_permission: public web search, approval-gated per query.
 * - update_task_outcome: Core's record of this turn's own objective, written from the model's arguments.
 * - request_tools: adds tools (only from this same list on a cloud turn).
 */
export const CLOUD_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'calculate',
  'resolve_time',
  'web_research',
  'request_search_permission',
  'update_task_outcome',
  'request_tools',
]);

export function isCloudSafeTool(name: string): boolean {
  return CLOUD_SAFE_TOOLS.has(name);
}

/** Splits a tool list into what a cloud turn may use and what it withholds. */
export function partitionCloudTools<T extends { name: string }>(tools: readonly T[]): { allowed: T[]; withheld: string[] } {
  const allowed: T[] = [];
  const withheld: string[] = [];
  for (const t of tools) {
    if (isCloudSafeTool(t.name)) allowed.push(t);
    else withheld.push(t.name);
  }
  return { allowed, withheld };
}

/** Providers whose turns already ran on a cloud model; anything else (Ollama, Hermes, unknown) counts as local. */
export function isCloudProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return provider !== 'ollama' && provider !== 'hermes' && provider !== 'opencode';
}

/**
 * The part of the history a cloud turn may see: only what was written after the last turn of this conversation that
 * did NOT run on a cloud model. `localCutoffIso` is when that local turn last changed (null when every earlier turn ran
 * on a cloud model). Everything at or before it is withheld, user messages included, also those of a local turn that
 * never got a reply (verification of #78: a cut at assistant replies only let such a message through).
 */
export function cloudVisibleHistory<T extends { createdAt: string }>(messages: readonly T[], localCutoffIso: string | null): { kept: T[]; withheld: number } {
  if (!localCutoffIso) return { kept: [...messages], withheld: 0 };
  const kept = messages.filter((m) => m.createdAt > localCutoffIso);
  return { kept, withheld: messages.length - kept.length };
}

/** SQL for the cutoff: the latest change of any earlier attempt in the conversation that did not start a cloud turn. */
export const LOCAL_CUTOFF_SQL = `SELECT MAX(MAX(a.createdAt, a.updatedAt, COALESCE(a.completedAt, ''))) AS t
  FROM attempts a JOIN requests r ON r.id = a.requestId
 WHERE r.conversationId = ? AND a.id != ?
   AND NOT EXISTS (SELECT 1 FROM runtime_events e WHERE e.entityId = a.id AND e.eventType = 'cloud_turn_started')`;

/**
 * Replaces local paths in text bound for a cloud model: the selected folder becomes "the selected folder" and the home
 * folder "~". Both spellings (backslash and slash) and any letter case of a Windows path are matched.
 */
export function scrubLocalPaths(text: string, paths: { workspace?: string | null; home?: string | null }): string {
  let out = text;
  const replaceAll = (target: string | null | undefined, by: string) => {
    if (!target || target.length < 3) return;
    const variants = new Set([target, target.replace(/\\/g, '/'), target.replace(/\//g, '\\'), target.replace(/\\/g, '\\\\')]);
    for (const v of variants) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'gi'), by);
    }
  };
  replaceAll(paths.workspace?.replace(/[\\/]+$/, ''), 'the selected folder');
  replaceAll(paths.home?.replace(/[\\/]+$/, ''), '~');
  return out;
}

/** The turn fact that tells the cloud model what it cannot see, so it says so instead of guessing. */
export function cloudBoundaryFact(label: string, input: { withheldTools: number; withheldHistory: number }): string {
  const parts = [
    `PRIVATE DATA BOUNDARY: this chat runs on ${label}, a cloud model, not on this PC. Pandesh does not send the user's files, folders, earlier attachments, email, calendar, memory, tasks or reminders to cloud models, so tools that read them are not available in this chat.`,
    'If the request needs any of that, say plainly that it needs a local model and that the user can switch to one; do not guess the content.',
  ];
  if (input.withheldHistory > 0) parts.push(`Earlier parts of this conversation ran on the local model and are not shared with ${label}.`);
  return parts.join(' ');
}
