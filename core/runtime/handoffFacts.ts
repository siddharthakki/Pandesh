/**
 * Facts a delegating turn hands to the specialist it delegates to (challenge T13: the Operations agent's real data
 * never reached the Coding agent, which then invented values). Only results of Pandesh's own local tools travel —
 * never web, email or document text, which stay behind the untrusted-content rule.
 */

/** Local tools whose results may travel with a hand-off. */
export const HANDOFF_FACT_TOOLS = /^(?:system_hardware_telemetry|run_system_diagnostics|get_system_info|software_updates|listening_ports|list_projects|ollama_list_models|pc_capability_inventory|port_list_services|calculate|resolve_time|list_reminders|memory_recall)$/;

export interface RecordedCallText { tool: string; status?: string; text: string }

export interface HandoffFacts {
  /** What the child's system prompt receives. */
  text: string;
  /** The private part (memory, reminders): a public web query in the child must not repeat it. */
  privateTexts: string[];
}

/**
 * The facts a child receives from the parent's completed local tool calls, bounded per call and in total.
 * `childReadableMemoryScopes` is the child's readable memory scope types (null = unrestricted).
 */
export function collectHandoffFacts(calls: readonly RecordedCallText[], childReadableMemoryScopes: readonly string[] | null): HandoffFacts {
  const parts: string[] = [];
  const privateTexts: string[] = [];
  for (const call of calls) {
    if (call.status !== 'completed') continue;
    const fromOperations = call.tool === 'delegate_to_agent' && /^RESULT FROM THE OPERATIONS AGENT/.test(call.text);
    if (!HANDOFF_FACT_TOOLS.test(call.tool) && !fromOperations) continue;
    // The delegating turn may read more memory than the child (an ordinary turn reads the user's private facts; a
    // Research child reads global + task only). Passing the parent's recall on unfiltered bypassed the child's scope.
    const text = call.tool === 'memory_recall' ? recallWithinScopes(call.text, childReadableMemoryScopes) : call.text;
    if (text === null) continue;
    // Reminders are the user's personal data: only a child that may read the user scope receives them.
    if (call.tool === 'list_reminders' && childReadableMemoryScopes !== null && !childReadableMemoryScopes.includes('user')) continue;
    const bounded = text.slice(0, 2_500);
    parts.push(`[${call.tool}]\n${bounded}`);
    if (PRIVATE_FACT_TOOLS.test(call.tool)) privateTexts.push(bounded);
  }
  return { text: parts.join('\n\n').slice(0, 8_000), privateTexts };
}

/** Personal data among the hand-off tools: the child's public-query guard treats it like text read from the user's files. */
const PRIVATE_FACT_TOOLS = /^(?:memory_recall|list_reminders)$/;

/** Words too common to identify anything on their own. */
const COMMON_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'near', 'is', 'are', 'was', 'be', 'as', 'it', 'its', 'this', 'that', 'my', 'our', 'your', 'their']);

function significantWords(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !COMMON_WORDS.has(w));
}

/** Pairs of consecutive significant words: enough to recognise a name or an address, not a single common word. */
function wordPairs(text: string): Set<string> {
  const words = significantWords(text);
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < words.length; i += 1) pairs.add(`${words[i]} ${words[i + 1]}`);
  return pairs;
}

/**
 * Stored memory a delegation brief repeats although the child may not read it (Build 161 audit): the delegating model
 * writes the brief, and could paste a private fact the hand-off filter keeps from the child. A fact counts as repeated
 * when the brief shares two consecutive significant words with it (or its one distinctive word), unless the user wrote
 * those words in this request themselves. Returns the subjects of the repeated facts.
 */
export function withheldMemoryInBrief(brief: string, withheld: ReadonlyArray<{ subject: string; value: string }>, userMessage: string): string[] {
  const briefPairs = wordPairs(brief);
  const userPairs = wordPairs(userMessage);
  const briefWords = new Set(significantWords(brief));
  const userWords = new Set(significantWords(userMessage));
  const repeated: string[] = [];
  for (const fact of withheld) {
    const pairs = wordPairs(fact.value);
    const words = significantWords(fact.value);
    const hit = pairs.size > 0
      ? [...pairs].some((pair) => briefPairs.has(pair) && !userPairs.has(pair))
      : words.length === 1 && words[0].length >= 5 && briefWords.has(words[0]) && !userWords.has(words[0]);
    if (hit) repeated.push(fact.subject);
  }
  return repeated;
}

/**
 * A recall result reduced to the memory scope types the child may read. Null when nothing may be passed on — including
 * a result that cannot be parsed while the child's memory is restricted (fail closed).
 */
function recallWithinScopes(raw: string, readable: readonly string[] | null): string | null {
  if (readable === null) return raw;
  if (readable.length === 0) return null;
  let parsed: { entries?: unknown } & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return null;
  const entries = (parsed.entries as Array<{ memory?: { scopeType?: unknown } }>).filter((entry) => readable.includes(String(entry?.memory?.scopeType ?? '')));
  if (entries.length === 0) return null;
  return JSON.stringify({ ...parsed, entries, includedScopes: [...readable] });
}
