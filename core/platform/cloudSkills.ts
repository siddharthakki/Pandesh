/**
 * Built-in cloud invocation skills, executed HOST SIDE (no prompt documents).
 *
 *   cloud-token-budget            compactForCloud()
 *   grounded-repository-answer    tierEvidence() / groundedAnswerContract()
 *   evidence-before-claim         auditClaims()  (uses EvidenceLedger)
 *   cloud-tool-discipline         ToolDiscipline
 *   objective-completion          checkObjectiveCompletion()
 *   cloud-cost-guard              CostGuard
 *
 * These only ever make a request smaller, a claim checkable, or a call refusable. None of them can grant
 * a permission, widen a path boundary or override a governance decision.
 */
import { EvidenceLedger, extractClaims, type Claim, type ClaimVerdict } from './evidenceLedger';
import { spendVerdict, type CloudSpendPolicy } from './cloudRouting';

// ---------------------------------------------------------------- cloud-token-budget

export interface BudgetMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
}

export interface TokenBudgetOptions {
  maxContextTokens: number;
  outputReserveTokens: number;
  /** Conservative: real tokenizers vary, so assume text is a little denser than 4 chars/token. */
  charsPerToken?: number;
  /** Always keep the last N messages verbatim. */
  keepRecent?: number;
  /** Messages that must survive verbatim (for example the file currently being edited). */
  preserve?: (message: BudgetMessage, index: number) => boolean;
}

export interface TokenBudgetReport {
  charsBefore: number;
  charsAfter: number;
  budgetChars: number;
  deduplicated: number;
  trimmed: number;
  dropped: number;
  changed: boolean;
}

const TRIM_HEAD = 700;
const TRIM_TAIL = 400;

function trimMiddle(content: string, head = TRIM_HEAD, tail = TRIM_TAIL): string {
  if (content.length <= head + tail + 80) return content;
  return `${content.slice(0, head)}\n[… ${content.length - head - tail} characters trimmed to save tokens …]\n${content.slice(-tail)}`;
}

/**
 * Deduplicates, compresses old turns and trims irrelevant bulk until the prompt fits the window minus the output
 * reserve. System messages, the opening user objective, the recent tail and anything `preserve` names are never touched.
 */
export function compactForCloud(messages: readonly BudgetMessage[], options: TokenBudgetOptions): { messages: BudgetMessage[]; report: TokenBudgetReport } {
  const charsPerToken = options.charsPerToken ?? 3.5;
  const keepRecent = options.keepRecent ?? 6;
  const budgetChars = Math.max(2000, Math.floor((options.maxContextTokens - options.outputReserveTokens) * charsPerToken * 0.9));
  const total = (list: readonly BudgetMessage[]): number => list.reduce((sum, m) => sum + m.content.length, 0);
  const report: TokenBudgetReport = { charsBefore: total(messages), charsAfter: 0, budgetChars, deduplicated: 0, trimmed: 0, dropped: 0, changed: false };
  let out = messages.map(m => ({ ...m }));
  if (report.charsBefore <= budgetChars) { report.charsAfter = report.charsBefore; return { messages: out, report }; }

  const firstUser = out.findIndex(m => m.role === 'user');
  const protectedAt = (m: BudgetMessage, i: number): boolean =>
    m.role === 'system' || i === firstUser || i >= out.length - keepRecent || m.images?.length ? true : options.preserve?.(m, i) === true;

  // 1. Deduplicate: an identical earlier message is redundant once a later copy exists.
  const lastSeen = new Map<string, number>();
  out.forEach((m, i) => { if (m.content.length > 200 && m.role !== 'system') lastSeen.set(`${m.role}:${m.content}`, i); });
  out = out.map((m, i) => {
    if (m.content.length > 200 && m.role !== 'system' && lastSeen.get(`${m.role}:${m.content}`) !== i && !protectedAt(m, i)) {
      report.deduplicated++;
      return { ...m, content: '[duplicate of a later message omitted]' };
    }
    return m;
  });

  // 2. Compress old bulky messages (tool observations first, then assistant, then user).
  for (const role of ['tool', 'assistant', 'user'] as const) {
    if (total(out) <= budgetChars) break;
    out = out.map((m, i) => {
      if (m.role !== role || protectedAt(m, i) || total(out) <= budgetChars) return m;
      const trimmed = trimMiddle(m.content);
      if (trimmed.length < m.content.length) report.trimmed++;
      return { ...m, content: trimmed };
    });
  }

  // 3. Last resort: drop the oldest unprotected messages, disclosed with a single marker.
  if (total(out) > budgetChars) {
    const kept: BudgetMessage[] = [];
    let droppedCount = 0;
    let markerAt = -1;
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (!protectedAt(m, i) && total(kept) + total(out.slice(i)) > budgetChars) {
        droppedCount++;
        if (markerAt < 0) markerAt = kept.length;
        continue;
      }
      kept.push(m);
    }
    if (droppedCount > 0) {
      kept.splice(markerAt, 0, { role: 'user', content: `[${droppedCount} earlier message${droppedCount === 1 ? '' : 's'} omitted to fit the model's context window]` });
      report.dropped = droppedCount;
    }
    out = kept;
  }
  report.charsAfter = total(out);
  report.changed = report.deduplicated + report.trimmed + report.dropped > 0;
  return { messages: out, report };
}

// ---------------------------------------------------------------- grounded-repository-answer

export type EvidenceTierLabel = 'KNOWN' | 'DERIVED' | 'INFERRED' | 'UNKNOWN';

export interface TieredItem { label: string; tier: EvidenceTierLabel }

/** KNOWN: read directly. DERIVED: computed by the host from reads (index, graph, diff). INFERRED: the model's own reading. UNKNOWN: not examined. */
export function tierEvidence(items: ReadonlyArray<{ label: string; source: 'read' | 'host-derived' | 'model' | 'missing' }>): TieredItem[] {
  return items.map(item => ({
    label: item.label,
    tier: item.source === 'read' ? 'KNOWN' : item.source === 'host-derived' ? 'DERIVED' : item.source === 'model' ? 'INFERRED' : 'UNKNOWN',
  }));
}

/** A one-line contract, deliberately tiny: the host does the work, the model only needs the labels. */
export function groundedAnswerContract(tiers: readonly TieredItem[]): string {
  const count = (tier: EvidenceTierLabel): number => tiers.filter(item => item.tier === tier).length;
  return `Ground every claim in the supplied evidence. Label statements KNOWN (read directly: ${count('KNOWN')}), DERIVED (host-computed: ${count('DERIVED')}), INFERRED (your reading) or UNKNOWN (not examined: ${count('UNKNOWN')}). Say UNKNOWN rather than guessing.`;
}

// ---------------------------------------------------------------- evidence-before-claim

export interface ClaimAudit { verdicts: ClaimVerdict[]; unverified: ClaimVerdict[]; allVerified: boolean }

/** Cross-checks explicit claims in an answer against the ledger. Unrecognised prose produces no verdicts. */
export function auditClaims(answerText: string, ledger: EvidenceLedger, extra: readonly Claim[] = []): ClaimAudit {
  const verdicts = ledger.verifyAll([...extractClaims(answerText), ...extra]);
  const unverified = verdicts.filter(v => !v.verified);
  return { verdicts, unverified, allVerified: unverified.length === 0 };
}

// ---------------------------------------------------------------- objective-completion

/** A required target set without matching recorded writes means "not complete", whatever the model says. */
export function checkObjectiveCompletion(ledger: EvidenceLedger, requiredTargets: readonly string[]): ClaimVerdict {
  return ledger.verify({ kind: 'objective_complete', requiredTargets: [...requiredTargets] });
}

// ---------------------------------------------------------------- cloud-tool-discipline

export interface ToolCallLike { name: string; args: Record<string, unknown> }
export type DisciplineVerdict = { allow: true } | { allow: false; reason: string };

const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'list_directory', 'search_files', 'search_code', 'grep', 'glob', 'find_files']);

/** Keeps a cloud model from burning quota on repeats and runaway call counts. Governance still decides everything else. */
export class ToolDiscipline {
  private readonly seen = new Set<string>();
  private calls = 0;
  constructor(private readonly maxCallsPerTurn = 24) {}

  /** Call after any write: previously read content may have changed, so reads are allowed again. */
  noteMutation(): void { this.seen.clear(); }
  resetTurn(): void { this.calls = 0; }

  check(call: ToolCallLike): DisciplineVerdict {
    this.calls++;
    if (this.calls > this.maxCallsPerTurn) {
      return { allow: false, reason: `Tool-call limit for one turn reached (${this.maxCallsPerTurn}). Answer from the evidence already gathered.` };
    }
    if (READ_ONLY_TOOLS.has(call.name)) {
      const key = `${call.name}:${JSON.stringify(call.args, Object.keys(call.args).sort())}`;
      if (this.seen.has(key)) return { allow: false, reason: `Identical ${call.name} call already made and nothing changed since. Reuse its result.` };
      this.seen.add(key);
    }
    return { allow: true };
  }
}

export interface LineRange { start: number; end: number }

/** Merges overlapping or adjacent line ranges so one read serves several requests. */
export function batchLineRanges(ranges: readonly LineRange[], gap = 5): LineRange[] {
  const sorted = [...ranges].filter(r => r.end >= r.start).sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + gap) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

// ---------------------------------------------------------------- cloud-cost-guard

export interface CostGuardLimits { maxRequests: number; maxTotalTokens: number }
export const DEFAULT_COST_LIMITS: CostGuardLimits = { maxRequests: 40, maxTotalTokens: 400_000 };

/** Per-task ceiling on cloud calls and tokens, on top of the spend policy: even free quota is finite. */
export class CostGuard {
  private requests = 0;
  private tokens = 0;
  constructor(private readonly policy: CloudSpendPolicy, private readonly limits: CostGuardLimits = DEFAULT_COST_LIMITS) {}

  beforeRequest(model: Parameters<typeof spendVerdict>[1]): { allow: true } | { allow: false; reason: string } {
    const verdict = spendVerdict(this.policy, model);
    if (!verdict.allowed) return { allow: false, reason: verdict.reason };
    if (this.requests >= this.limits.maxRequests) return { allow: false, reason: `This task reached its cloud request limit (${this.limits.maxRequests}).` };
    if (this.tokens >= this.limits.maxTotalTokens) return { allow: false, reason: `This task reached its cloud token limit (${this.limits.maxTotalTokens}).` };
    this.requests++;
    return { allow: true };
  }

  afterResponse(usage: { promptTokens?: number | null; completionTokens?: number | null }): void {
    this.tokens += (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  }

  snapshot(): { requests: number; tokens: number } { return { requests: this.requests, tokens: this.tokens }; }
}

export const BUILTIN_CLOUD_SKILL_IDS = [
  'cloud-token-budget',
  'grounded-repository-answer',
  'evidence-before-claim',
  'cloud-tool-discipline',
  'objective-completion',
  'cloud-cost-guard',
] as const;
