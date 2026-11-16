/**
 * Evidence for delegated work: what a specialist actually did (recorded tool invocations) versus what its report says.
 *
 * Found on Builds 173-177: the Reviewer, asked to evaluate skill discovery and report its evidence, made ZERO tool calls
 * and wrote a confident report that cited find_skill and read_skill as evidence. Tools were exposed to it (15
 * definitions); the model simply answered from its own knowledge, and nothing in Core required otherwise. Matching the
 * report's wording for "called X" does not fix that (the model rephrases), so Core compares the report with the
 * invocation records themselves:
 *   - a task that asks to check / verify / evaluate must produce at least one recorded, successful tool call, or the
 *     agent's answer is "Cannot verify" (Core asks once, then writes that answer itself);
 *   - the lead is given a ledger of what ran (from tool_invocations), and the report is labelled as the model's own
 *     text; a tool the report names that has no successful record is called out as unbacked;
 *   - the final reply carries the same ledger, so verified findings and unverified opinion are never mixed.
 *
 * Pure functions; nothing here performs I/O.
 */

export interface InvocationRecord { toolName: string; status: string }

export interface EvidenceLedger {
  /** Successful calls by tool name (count). */
  verified: Array<{ tool: string; count: number }>;
  /** Tools that were called but did not succeed. */
  failed: string[];
  /** Real tools the report names that have no successful record in this task. */
  unbacked: string[];
  totalCalls: number;
}

/** Calls that do not count as evidence about the work: bookkeeping the model makes about itself. */
const NOT_EVIDENCE = new Set(['update_task_outcome', 'request_tools', 'declare_execution_plan', 'execution_plan_status', 'resolve_time']);

/** The request asks the agent to check, verify or evaluate something and report what it found out. */
export function taskNeedsEvidence(userRequest: string | null | undefined): boolean {
  if (!userRequest) return false;
  return /\b(?:evaluate|evaluation|assess|audit|verify|verification|validate|check(?:ed|ing)?|review|inspect|test(?:ed|ing)?|confirm|investigate|diagnose)\b|\bwhat\s+(?:it|you|they)\s+(?:checked|used|found)\b|\bevidence\b/i.test(userRequest);
}

/**
 * Real tool names the report mentions. Only names from the tool registry count (so ordinary words are never mistaken
 * for tools); a name with no underscore (calculate, memory_recall has one) must be written as `name` or name(...).
 */
export function citedTools(report: string, knownToolNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of new Set(knownToolNames)) {
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = name.includes('_')
      ? new RegExp(`(?<![\\w])${esc}(?![\\w])`)
      : new RegExp('`' + esc + '`|(?<![\\w])' + esc + '\\s*\\(');
    if (pattern.test(report)) out.push(name);
  }
  return out;
}

export function buildLedger(records: readonly InvocationRecord[], report: string, knownToolNames: readonly string[]): EvidenceLedger {
  const counted = records.filter((r) => !NOT_EVIDENCE.has(r.toolName));
  const ok = new Map<string, number>();
  const failed = new Set<string>();
  for (const r of counted) {
    if (r.status === 'succeeded') ok.set(r.toolName, (ok.get(r.toolName) ?? 0) + 1);
    else if (r.status !== 'running') failed.add(r.toolName);
  }
  const unbacked = citedTools(report, knownToolNames).filter((t) => !ok.has(t) && !NOT_EVIDENCE.has(t));
  return { verified: [...ok].map(([tool, count]) => ({ tool, count })), failed: [...failed].filter((t) => !ok.has(t)), unbacked, totalCalls: counted.length };
}

const list = (items: string[]) => items.join(', ');

/** What the lead model reads before the agent's report. */
export function ledgerForLead(agentName: string, ledger: EvidenceLedger): string {
  const lines = [`CORE EVIDENCE LEDGER (from the tool calls Pandesh recorded for the ${agentName} agent, not from its words):`];
  if (ledger.verified.length) lines.push(`- Verified (tool calls that succeeded): ${list(ledger.verified.map((v) => `${v.tool}${v.count > 1 ? ` x${v.count}` : ''}`))}.`);
  else lines.push(`- The ${agentName} agent made no successful tool call: nothing in its report was checked.`);
  if (ledger.failed.length) lines.push(`- Tool calls that failed: ${list(ledger.failed)}.`);
  if (ledger.unbacked.length) lines.push(`- Named in the report but never run successfully: ${list(ledger.unbacked)}. Do not present these as evidence.`);
  lines.push('The report below is the agent\'s own text. Treat what the ledger above does not back as unverified opinion and say so.');
  return lines.join('\n');
}

/** Whether the final reply needs Core's own statement (anything unverified or unbacked). */
export function ledgerNeedsStatement(ledger: EvidenceLedger, requiresEvidence: boolean): boolean {
  return ledger.unbacked.length > 0 || (requiresEvidence && ledger.verified.length === 0);
}

/** Core's statement appended to the final reply: verified evidence apart from unverified opinion. */
export function ledgerStatement(agentName: string, ledger: EvidenceLedger): string {
  const parts: string[] = [];
  parts.push(ledger.verified.length
    ? `Verified by Pandesh Core (tool calls it recorded for the ${agentName} agent): ${list(ledger.verified.map((v) => v.tool))}.`
    : `Cannot verify: the ${agentName} agent made no successful tool call, so nothing in its report was checked.`);
  if (ledger.unbacked.length) parts.push(`Unverified: the report names ${list(ledger.unbacked)} as evidence, but Core recorded no successful call to ${ledger.unbacked.length > 1 ? 'them' : 'it'}; that part is the agent's opinion, not a finding.`);
  if (ledger.failed.length) parts.push(`Failed calls: ${list(ledger.failed)}.`);
  return parts.join(' ');
}

/** Sent to a delegated agent that answered a verification task without running a tool. */
export function evidenceRetryPrompt(toolNames: readonly string[]): string {
  const shown = toolNames.filter((n) => !NOT_EVIDENCE.has(n)).slice(0, 14);
  return `[Pandesh Core] You answered without running a single tool, but this task asks you to check or evaluate something and report your evidence. An answer from memory is not evidence. Now call at least one of your own tools (${list(shown)}) on a real input for this task, then report only what the tool results show. If you cannot get evidence, reply exactly "Cannot verify:" followed by the reason. Do not describe calls you did not make.`;
}

/** The answer Core writes when the agent still ran nothing after being asked once. */
export function cannotVerifyReply(agentName: string, opinion: string): string {
  const text = opinion.trim().slice(0, 1_500);
  return `Cannot verify: the ${agentName} agent made no tool calls even after being asked to run its tools, so nothing below was checked.${text ? `\n\nUnverified opinion from the agent (not a finding):\n${text}` : ''}`;
}

/** The user's own words inside a Core-written hand-off brief (the template's boilerplate also says "evidence"). */
export function userWordsOf(brief: string): string {
  const m = /\(their words\): "([\s\S]*?)"\nYou are the /.exec(brief);
  return m ? m[1] : brief;
}
