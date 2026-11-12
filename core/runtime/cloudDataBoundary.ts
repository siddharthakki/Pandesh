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
 * The part of the history a cloud turn may see: only the trailing run of exchanges that already happened on a cloud
 * model. Everything up to and including the last assistant reply that did not come from a cloud model is withheld,
 * with the user messages of those turns (they were written for a local model).
 */
export function cloudVisibleHistory<T extends { role: string; provider?: string | null }>(messages: readonly T[]): { kept: T[]; withheld: number } {
  let cut = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === 'assistant' && !isCloudProvider(messages[i].provider)) cut = i;
  }
  return { kept: messages.slice(cut + 1), withheld: cut + 1 };
}

/** The turn fact that tells the cloud model what it cannot see, so it says so instead of guessing. */
export function cloudBoundaryFact(label: string, input: { withheldTools: number; withheldHistory: number }): string {
  const parts = [
    `PRIVATE DATA BOUNDARY: this chat runs on ${label}, a cloud model, not on this PC. Pandesh does not send the user's files, folders, email, calendar, memory, tasks, reminders or PC details to cloud models, so tools that read them are not available in this chat.`,
    'If the request needs any of that, say plainly that it needs a local model and that the user can switch to one; do not guess the content.',
  ];
  if (input.withheldHistory > 0) parts.push(`Earlier parts of this conversation ran on the local model and are not shared with ${label}.`);
  return parts.join(' ');
}
