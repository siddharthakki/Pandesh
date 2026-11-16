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

export interface InvocationRecord { toolName: string; status: string; /** The call's arguments as recorded (JSON or text). */ args?: string }

export interface EvidenceLedger {
  /** Successful calls whose tool or arguments bear on what was asked, by tool name (count). Only these back a verification. */
  verified: Array<{ tool: string; count: number }>;
  /** Tools that succeeded but have nothing to do with the request: executed, not evidence. */
  unrelated: string[];
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

const STOP = new Set(['ask', 'your', 'specialist', 'agent', 'evaluate', 'evaluation', 'assess', 'audit', 'verify', 'verification', 'validate', 'check', 'checked', 'review', 'inspect', 'test', 'confirm', 'investigate', 'diagnose', 'report', 'what', 'that', 'this', 'with', 'from', 'then', 'whether', 'evidence', 'used', 'current', 'approach', 'please', 'tell', 'make', 'sure', 'about', 'they', 'them', 'have', 'does', 'into', 'their', 'there', 'which', 'should', 'would', 'could']);

/** Content words of the request (lower case, endings trimmed), without the words that only say "check this". */
export function requestTopics(request: string): string[] {
  const words = request.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\s_-]/g, ' ').split(/[\s_-]+/).filter((w) => w.length >= 4 && !STOP.has(w));
  return [...new Set(words.map((w) => w.replace(/(?:ing|ed|es|s)$/, '')).filter((w) => w.length >= 4))];
}

/** Subjects the tool name alone does not give away: what a folder, a key or a price question is answered with. */
const SUBJECT_TOOLS: Array<[RegExp, RegExp]> = [
  [/folder|director|file|document|invoice|price|spreadsheet|csv|pdf|workspace|record/, /^(?:read_file|list_directory|search_files|read_document|read_pdf|read_spreadsheet|file_)/],
  [/provider|credential|key|model|cloud|local|private|ollama|authori/, /^(?:provider_readiness|list_models|model_)/],
  [/memor|remember|recall/, /^memory_/],
  [/price|revenue|invoice|sales/, /^revenue_/],
  [/system|disk|diagnos|health/, /^(?:get_system_info|run_system_diagnostics|pc_)/],
];

/** Does this successful call bear on what the user asked to have checked? A different tool's success is not evidence. */
export function isRelevantEvidence(record: InvocationRecord, topics: readonly string[]): boolean {
  if (NOT_EVIDENCE.has(record.toolName)) return false;
  const nameParts = record.toolName.toLowerCase().split('_').filter((p) => p.length >= 4);
  for (const t of topics) {
    for (const part of nameParts) if (part.startsWith(t.slice(0, 5)) || t.startsWith(part.slice(0, 5))) return true;
    for (const [subject, tools] of SUBJECT_TOOLS) if (subject.test(t) && tools.test(record.toolName)) return true;
  }
  const args = (record.args ?? '').toLowerCase();
  return args.length > 0 && topics.some((t) => t.length >= 5 && args.includes(t));
}

export function buildLedger(records: readonly InvocationRecord[], report: string, knownToolNames: readonly string[], request: string | null = null): EvidenceLedger {
  const counted = records.filter((r) => !NOT_EVIDENCE.has(r.toolName));
  const topics = request === null ? null : requestTopics(request);
  const ok = new Map<string, number>();
  const ranButUnrelated = new Set<string>();
  const failed = new Set<string>();
  for (const r of counted) {
    if (r.status === 'succeeded') {
      if (topics === null || isRelevantEvidence(r, topics)) ok.set(r.toolName, (ok.get(r.toolName) ?? 0) + 1);
      else ranButUnrelated.add(r.toolName);
    } else if (r.status !== 'running') failed.add(r.toolName);
  }
  const unbacked = citedTools(report, knownToolNames).filter((t) => !ok.has(t) && !NOT_EVIDENCE.has(t));
  return { verified: [...ok].map(([tool, count]) => ({ tool, count })), unrelated: [...ranButUnrelated].filter((t) => !ok.has(t)), failed: [...failed].filter((t) => !ok.has(t)), unbacked, totalCalls: counted.length };
}

const list = (items: string[]) => items.join(', ');

/** What the lead model reads before the agent's report. */
export function ledgerForLead(agentName: string, ledger: EvidenceLedger): string {
  const lines = [`CORE EVIDENCE LEDGER (from the tool calls Pandesh recorded for the ${agentName} agent, not from its words):`];
  if (ledger.verified.length) lines.push(`- Verified (tool calls that succeeded): ${list(ledger.verified.map((v) => `${v.tool}${v.count > 1 ? ` x${v.count}` : ''}`))}.`);
  else lines.push(`- The ${agentName} agent made no successful tool call that bears on the request: nothing in its report was checked.`);
  if (ledger.unrelated.length) lines.push(`- Ran successfully but unrelated to what was asked (not evidence): ${list(ledger.unrelated)}.`);
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
    ? `Verified by Pandesh Core (successful tool calls recorded for the ${agentName} agent that bear on the request): ${list(ledger.verified.map((v) => v.tool))}.`
    : `Cannot verify: the ${agentName} agent made no successful tool call that bears on the request, so nothing in its report was checked.`);
  if (ledger.unrelated.length) parts.push(`Ran but unrelated to the request (not evidence): ${list(ledger.unrelated)}.`);
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
