import * as crypto from 'crypto';
import { CONTEXT_CHARS_PER_TOKEN } from '../../core/shared/contextBudget';
import type { PackPolicy } from './ExecutionEconomyProfile';

/**
 * M46 Context Compiler.
 *
 * M45's allocator answers "how much context may we spend". This answers "what is
 * the highest-value information to spend it on" for the next model call, and
 * produces a fresh, structured, task-specific pack instead of replaying history.
 *
 * Contract:
 *  - Pure function of its input (plus file contents returned by `readFile`):
 *    equal input gives a byte-identical pack and `packHash`. No clocks, no randomness.
 *  - Never exceeds `policy.maxChars`. Whole entries are admitted or rejected in a fixed
 *    priority order; nothing is concatenated and then truncated at the end.
 *  - Every candidate is reported: selected (and in which form), or rejected (and why).
 *  - It has no repository dependency: callers hand it ranked candidates (see RepositoryIntel),
 *    so a missing index, a plain folder or an empty workspace simply yields a smaller pack.
 */

export const CONTEXT_PACK_SCHEMA_VERSION = 1 as const;

export type PackTaskType = 'inspect' | 'diagnose' | 'repair' | 'implement' | 'general';
export type PackEvidenceKind = 'observation' | 'failure' | 'interaction';
export type PackSectionId =
  | 'objective'
  | 'subgoal'
  | 'constraints'
  | 'mission'
  | 'validation'
  | 'failures'
  | 'questions'
  | 'capabilities'
  | 'architecture'
  | 'files'
  | 'observations'
  | 'interaction';
export type PackForm = 'full' | 'focused' | 'outline' | 'text' | 'reduced';

export interface PackEvidence {
  id: string;
  kind: PackEvidenceKind;
  text: string;
  path?: string;
  /** Caller relevance, 0..100. Defaults by kind. */
  weight?: number;
  /** Larger is newer. Ties in score prefer newer evidence. */
  order: number;
}

export interface RepoCandidate {
  path: string;
  score: number;
  reasons: string[];
  /** Raw size in bytes when known. */
  size?: number;
  /** One-line structural summary from the index. */
  summary?: string;
  /** Symbols as `kind name` or `kind name:line`. */
  symbols?: string[];
  /** Where to look inside a large file. */
  focus?: { lines?: Array<[number, number]>; symbols?: string[] };
}

export interface SubgoalView {
  id: string;
  objective: string;
  successCondition?: string;
  expectedValidation?: string;
  scope?: string;
}

export interface ContextPackInput {
  taskId: string;
  subgoalId?: string;
  taskType: PackTaskType;
  objective: string;
  subgoal?: SubgoalView;
  constraints?: readonly string[];
  missionState?: readonly string[];
  architectureSummary?: readonly string[];
  candidates?: readonly RepoCandidate[];
  readFile?: (path: string) => Promise<string | undefined>;
  evidence?: readonly PackEvidence[];
  validation?: { status: 'unknown' | 'passing' | 'failing'; lines?: readonly string[] };
  unresolvedQuestions?: readonly string[];
  capabilities?: readonly string[];
  policy: PackPolicy;
  /** Recorded in telemetry only. */
  tier?: string;
}

export interface PackSelected {
  id: string;
  section: PackSectionId;
  form: PackForm;
  chars: number;
  why: string;
}

export interface PackRejected {
  id: string;
  section: PackSectionId;
  reason: 'budget' | 'section_cap' | 'file_limit' | 'unreadable' | 'duplicate' | 'empty';
  chars: number;
  detail?: string;
}

export interface PackCandidateRecord {
  id: string;
  section: PackSectionId;
  score: number;
  chars: number;
}

export interface ContextPackTelemetry {
  taskId: string;
  subgoalId?: string;
  taskType: PackTaskType;
  tier?: string;
  budgetChars: number;
  packChars: number;
  estimatedTokens: number;
  packHash: string;
  candidates: PackCandidateRecord[];
  selected: PackSelected[];
  rejected: PackRejected[];
  sections: Array<{ id: PackSectionId; entries: number; chars: number }>;
}

export interface ContextPack {
  schemaVersion: typeof CONTEXT_PACK_SCHEMA_VERSION;
  taskId: string;
  subgoalId?: string;
  taskType: PackTaskType;
  text: string;
  packHash: string;
  chars: number;
  estimatedTokens: number;
  telemetry: ContextPackTelemetry;
}

interface Entry {
  id: string;
  section: PackSectionId;
  score: number;
  text: string;
  alt?: string;
  why: string;
}

const SECTION_TITLES: Record<PackSectionId, string> = {
  objective: 'Objective',
  subgoal: 'Current subgoal',
  constraints: 'Constraints',
  mission: 'Mission state',
  validation: 'Validation state',
  failures: 'Relevant failures',
  questions: 'Open questions',
  capabilities: 'Allowed capabilities',
  architecture: 'Repository',
  files: 'Relevant files',
  observations: 'Recent observations',
  interaction: 'Recent interaction',
};

const RENDER_ORDER: readonly PackSectionId[] = [
  'objective', 'subgoal', 'constraints', 'mission', 'validation', 'failures', 'questions',
  'capabilities', 'architecture', 'files', 'observations', 'interaction',
];

/** Optional sections in admission order, per task type. Mandatory sections are always admitted first. */
const ADMISSION_ORDER: Record<PackTaskType, readonly PackSectionId[]> = {
  inspect: ['constraints', 'architecture', 'files', 'mission', 'questions', 'capabilities', 'observations', 'validation', 'failures', 'interaction'],
  diagnose: ['constraints', 'validation', 'failures', 'files', 'questions', 'capabilities', 'mission', 'architecture', 'observations', 'interaction'],
  repair: ['constraints', 'validation', 'failures', 'files', 'questions', 'capabilities', 'mission', 'architecture', 'observations', 'interaction'],
  implement: ['constraints', 'files', 'architecture', 'mission', 'validation', 'questions', 'capabilities', 'failures', 'observations', 'interaction'],
  general: ['constraints', 'mission', 'validation', 'failures', 'files', 'architecture', 'questions', 'capabilities', 'observations', 'interaction'],
};

/** Fraction of the pack budget one optional section may occupy (files use the remainder, see below). */
const SECTION_CAP: Partial<Record<PackSectionId, number>> = {
  constraints: 0.1,
  mission: 0.12,
  validation: 0.15,
  failures: 0.2,
  questions: 0.06,
  capabilities: 0.05,
  architecture: 0.15,
  observations: 0.2,
};
const FILES_SHARE_OF_REMAINING = 0.7;
const MAX_ENTRY_CHARS = 1_200;
const MAX_LINE_CHARS = 400;
const FOCUS_CONTEXT_LINES = 6;
const FOCUS_SYMBOL_SPAN_LINES = 40;
const DEFAULT_WEIGHT: Record<PackEvidenceKind, number> = { failure: 70, observation: 50, interaction: 30 };
const TRUNCATION_MARK = '\n[…omitted…]\n';

export function hashText(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`;
}

/** File bodies keep their own line endings (a whole-file body must hash like the bytes on disk). */
function cleanBody(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

/** Keeps the start and the end of a long text; the middle is what is least likely to matter. */
function headTail(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARK.length + 8) return text.slice(0, Math.max(0, max));
  const room = max - TRUNCATION_MARK.length;
  const head = Math.ceil(room * 0.6);
  return `${text.slice(0, head)}${TRUNCATION_MARK}${text.slice(text.length - (room - head))}`;
}

function bullets(lines: readonly string[] | undefined, perLine = MAX_LINE_CHARS): string[] {
  return (lines ?? [])
    .map(line => clean(line).replace(/\s+/g, ' ').trim().slice(0, perLine))
    .filter(line => line.length > 0);
}

function byScoreThenId(a: { score: number; id: string }, b: { score: number; id: string }): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ── file rendering ──────────────────────────────────────────────────────────

const DECLARATION = /\b(?:function|class|interface|type|enum|def|fn|func|const|let|var|struct|impl|trait)\b/;

function findSymbolLine(lines: readonly string[], symbol: string): number | undefined {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`\\b${escaped}\\b`);
  let fallback: number | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    if (!word.test(lines[i])) continue;
    if (DECLARATION.test(lines[i])) return i;
    if (fallback === undefined) fallback = i;
  }
  return fallback;
}

/** Merges 0-based inclusive line ranges. */
function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const sorted = windows.map(w => [w[0], w[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window[0] <= last[1] + 1) last[1] = Math.max(last[1], window[1]);
    else merged.push(window);
  }
  return merged;
}

function focusedExcerpt(lines: readonly string[], focus: RepoCandidate['focus'], maxChars: number): string | undefined {
  const windows: Array<[number, number]> = [];
  for (const [from, to] of focus?.lines ?? []) {
    windows.push([Math.max(0, from - 1 - FOCUS_CONTEXT_LINES), Math.min(lines.length - 1, to - 1 + FOCUS_CONTEXT_LINES)]);
  }
  for (const symbol of focus?.symbols ?? []) {
    const line = findSymbolLine(lines, symbol);
    if (line !== undefined) windows.push([Math.max(0, line - 2), Math.min(lines.length - 1, line + FOCUS_SYMBOL_SPAN_LINES)]);
  }
  if (windows.length === 0) return undefined;
  const parts: string[] = [];
  let used = 0;
  for (const [from, to] of mergeWindows(windows)) {
    const body = lines.slice(from, to + 1).map((line, index) => `${from + index + 1}: ${line.replace(/\r$/, '').slice(0, MAX_LINE_CHARS)}`).join('\n');
    const room = maxChars - used;
    if (room <= 40) break;
    const piece = body.length <= room ? body : `${body.slice(0, room - 20)}\n[…cut…]`;
    parts.push(piece);
    used += piece.length + 1;
  }
  return parts.length > 0 ? parts.join('\n…\n') : undefined;
}

function outlineOf(candidate: RepoCandidate, rawSize: number | undefined): string {
  const bits: string[] = [];
  if (candidate.summary) bits.push(clean(candidate.summary).slice(0, 240));
  if (candidate.symbols?.length) bits.push(`symbols: ${candidate.symbols.slice(0, 24).join(', ')}`);
  if (rawSize !== undefined) bits.push(`${rawSize} bytes`);
  return bits.join('\n');
}

function fileEntryHeader(candidate: RepoCandidate, form: PackForm): string {
  const why = candidate.reasons.slice(0, 3).join('; ');
  return `### ${candidate.path} [${form}${why ? `; ${why}` : ''}]`;
}

// ── compiler ────────────────────────────────────────────────────────────────

export async function compileContextPack(input: ContextPackInput): Promise<ContextPack> {
  const { policy } = input;
  const budget = Math.max(400, Math.floor(policy.maxChars));
  const selected: PackSelected[] = [];
  const rejected: PackRejected[] = [];
  const candidateRecords: PackCandidateRecord[] = [];
  const admitted = new Map<PackSectionId, Array<{ id: string; text: string }>>();
  const sectionChars = new Map<PackSectionId, number>();
  const seenHashes = new Set<string>();
  let total = 0;

  const headerText = `# Context Pack — task ${input.taskId}${input.subgoalId ? ` / subgoal ${input.subgoalId}` : ''} (${input.taskType})\n`;
  total += headerText.length;

  const overheadFor = (section: PackSectionId): number => (admitted.has(section) ? 0 : `\n## ${SECTION_TITLES[section]}\n`.length);

  const admit = (entry: Entry, text: string, form: PackForm): void => {
    const list = admitted.get(entry.section) ?? [];
    total += overheadFor(entry.section) + text.length + 1;
    list.push({ id: entry.id, text });
    admitted.set(entry.section, list);
    sectionChars.set(entry.section, (sectionChars.get(entry.section) ?? 0) + text.length + 1);
    selected.push({ id: entry.id, section: entry.section, form, chars: text.length, why: entry.why });
  };

  const tryAdmit = (entry: Entry, sectionCapChars: number): boolean => {
    candidateRecords.push({ id: entry.id, section: entry.section, score: entry.score, chars: entry.text.length });
    if (entry.text.trim().length === 0) {
      rejected.push({ id: entry.id, section: entry.section, reason: 'empty', chars: 0 });
      return false;
    }
    const hash = hashText(entry.text.replace(/\s+/g, ' ').trim().toLowerCase());
    if (seenHashes.has(hash)) {
      rejected.push({ id: entry.id, section: entry.section, reason: 'duplicate', chars: entry.text.length });
      return false;
    }
    const fits = (text: string): 'ok' | 'budget' | 'section_cap' => {
      if (total + overheadFor(entry.section) + text.length + 1 > budget) return 'budget';
      if ((sectionChars.get(entry.section) ?? 0) + text.length + 1 > sectionCapChars) return 'section_cap';
      return 'ok';
    };
    const first = fits(entry.text);
    if (first === 'ok') {
      seenHashes.add(hash);
      admit(entry, entry.text, 'text');
      return true;
    }
    if (entry.alt && fits(entry.alt) === 'ok') {
      seenHashes.add(hash);
      admit(entry, entry.alt, 'reduced');
      return true;
    }
    rejected.push({ id: entry.id, section: entry.section, reason: first, chars: entry.text.length });
    return false;
  };

  // Mandatory: objective (always, shrunk before anything else is dropped) and the current subgoal.
  const objectiveCap = Math.max(300, Math.floor(budget / 3));
  const objectiveText = headTail(clean(input.objective).trim(), objectiveCap);
  candidateRecords.push({ id: 'objective', section: 'objective', score: 1000, chars: objectiveText.length });
  admit({ id: 'objective', section: 'objective', score: 1000, text: objectiveText, why: 'mission objective (mandatory)' }, objectiveText, 'text');
  if (input.subgoal) {
    const sg = input.subgoal;
    const lines = [
      `Do: ${clean(sg.objective).replace(/\s+/g, ' ').trim().slice(0, 600)}`,
      sg.successCondition ? `Done when: ${clean(sg.successCondition).replace(/\s+/g, ' ').trim().slice(0, 400)}` : '',
      sg.expectedValidation ? `Check with: ${clean(sg.expectedValidation).replace(/\s+/g, ' ').trim().slice(0, 300)}` : '',
      sg.scope ? `Scope: ${clean(sg.scope).replace(/\s+/g, ' ').trim().slice(0, 300)}` : '',
    ].filter(Boolean);
    const text = lines.join('\n');
    candidateRecords.push({ id: `subgoal:${sg.id}`, section: 'subgoal', score: 900, chars: text.length });
    admit({ id: `subgoal:${sg.id}`, section: 'subgoal', score: 900, text, why: 'current bounded subgoal (mandatory)' }, text, 'text');
  }

  // Build every optional entry, then admit section by section in the task type's priority order.
  const bySection = new Map<PackSectionId, Entry[]>();
  const push = (entry: Entry): void => {
    const list = bySection.get(entry.section) ?? [];
    list.push(entry);
    bySection.set(entry.section, list);
  };
  const listEntries = (section: PackSectionId, why: string, lines: readonly string[] | undefined, baseScore: number): void => {
    bullets(lines).forEach((line, index) => push({
      id: `${section}:${index}`,
      section,
      score: baseScore - index,
      text: `- ${line}`,
      why,
    }));
  };
  listEntries('constraints', 'stated constraint', input.constraints, 100);
  listEntries('mission', 'durable mission state', input.missionState, 80);
  listEntries('questions', 'unresolved question', input.unresolvedQuestions, 60);
  listEntries('capabilities', 'allowed capability', input.capabilities, 50);
  listEntries('architecture', 'repository architecture summary', input.architectureSummary, 70);
  if (input.validation) {
    const lines = bullets(input.validation.lines);
    push({ id: 'validation:status', section: 'validation', score: 100, text: `status: ${input.validation.status}`, why: 'validation status' });
    lines.forEach((line, index) => push({ id: `validation:${index}`, section: 'validation', score: 90 - index, text: `- ${line}`, why: 'validation evidence' }));
  }
  const evidenceSection: Record<PackEvidenceKind, PackSectionId> = { failure: 'failures', observation: 'observations', interaction: 'interaction' };
  const evidenceLimit: Record<PackEvidenceKind, number> = {
    failure: policy.maxFailures,
    observation: policy.maxObservations,
    interaction: Number.MAX_SAFE_INTEGER,
  };
  for (const kind of ['failure', 'observation', 'interaction'] as const) {
    const items = (input.evidence ?? []).filter(item => item.kind === kind);
    items
      .map(item => ({ item, score: (item.weight ?? DEFAULT_WEIGHT[kind]) + Math.min(item.order, 1000) / 1000 }))
      .sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1))
      .forEach(({ item, score }, index) => {
        if (index >= evidenceLimit[kind]) {
          candidateRecords.push({ id: item.id, section: evidenceSection[kind], score, chars: item.text.length });
          rejected.push({ id: item.id, section: evidenceSection[kind], reason: 'budget', chars: item.text.length, detail: 'over the per-kind evidence limit' });
          return;
        }
        const body = clean(item.text).trim();
        const full = headTail(body, MAX_ENTRY_CHARS);
        const short = headTail(body, Math.max(160, Math.floor(MAX_ENTRY_CHARS / 4)));
        const prefix = item.path ? `[${item.path}] ` : '';
        push({
          id: item.id,
          section: evidenceSection[kind],
          score,
          text: `- ${prefix}${full}`,
          alt: short.length < full.length ? `- ${prefix}${short}` : undefined,
          why: kind === 'failure' ? 'relevant prior failure' : kind === 'observation' ? 'recent useful observation' : 'recent interaction',
        });
      });
  }

  const fileCandidates = [...(input.candidates ?? [])]
    .map(candidate => ({ candidate, id: candidate.path, score: candidate.score }))
    .sort(byScoreThenId);

  for (const section of ADMISSION_ORDER[input.taskType]) {
    if (section === 'files') {
      await admitFiles();
      continue;
    }
    const entries = (bySection.get(section) ?? []).sort(byScoreThenId);
    const fraction = section === 'interaction' ? Math.min(1, policy.recentInteractionChars / budget) : (SECTION_CAP[section] ?? 0.1);
    const capChars = Math.floor(budget * fraction);
    for (const entry of entries) tryAdmit(entry, capChars);
  }

  async function admitFiles(): Promise<void> {
    const remaining = () => Math.max(0, budget - total);
    const filesCap = Math.floor(remaining() * FILES_SHARE_OF_REMAINING);
    let admittedFiles = 0;
    for (const { candidate } of fileCandidates) {
      const id = candidate.path;
      const record = (chars: number) => candidateRecords.push({ id, section: 'files', score: candidate.score, chars });
      if (admittedFiles >= policy.maxFiles) {
        record(0);
        rejected.push({ id, section: 'files', reason: 'file_limit', chars: 0 });
        continue;
      }
      let content: string | undefined;
      if (input.readFile) {
        try { content = await input.readFile(candidate.path); } catch { content = undefined; }
      }
      const normalized = content === undefined ? undefined : cleanBody(content);
      const rawSize = candidate.size ?? normalized?.length;
      const outline = outlineOf(candidate, rawSize);
      record(normalized?.length ?? outline.length);

      const forms: Array<{ form: PackForm; body: string }> = [];
      if (normalized !== undefined && normalized.length <= policy.maxSnippetChars) {
        forms.push({ form: 'full', body: normalized });
      }
      if (normalized !== undefined) {
        const lines = normalized.split('\n');
        const excerpt = focusedExcerpt(lines, candidate.focus, policy.maxSnippetChars);
        if (excerpt) forms.push({ form: 'focused', body: excerpt });
      }
      if (outline.length > 0) forms.push({ form: 'outline', body: outline });

      if (forms.length === 0) {
        rejected.push({ id, section: 'files', reason: normalized === undefined && input.readFile ? 'unreadable' : 'empty', chars: 0 });
        continue;
      }
      let placed = false;
      let lastReason: PackRejected['reason'] = 'budget';
      for (const { form, body } of forms) {
        const fence = form === 'outline' ? body : `\`\`\`\n${body}\n\`\`\``;
        const text = `${fileEntryHeader(candidate, form)}\n${fence}`;
        const sectionUsed = sectionChars.get('files') ?? 0;
        if (total + overheadFor('files') + text.length + 1 > budget) { lastReason = 'budget'; continue; }
        if (sectionUsed + text.length + 1 > filesCap) { lastReason = 'section_cap'; continue; }
        const hash = hashText(text);
        if (seenHashes.has(hash)) { lastReason = 'duplicate'; break; }
        seenHashes.add(hash);
        admit({ id, section: 'files', score: candidate.score, text, why: candidate.reasons.slice(0, 3).join('; ') || 'ranked repository candidate' }, text, form);
        admittedFiles += 1;
        placed = true;
        break;
      }
      if (!placed) rejected.push({ id, section: 'files', reason: lastReason, chars: normalized?.length ?? outline.length });
    }
  }

  // Render in fixed section order.
  const out: string[] = [headerText];
  for (const section of RENDER_ORDER) {
    const list = admitted.get(section);
    if (!list || list.length === 0) continue;
    out.push(`\n## ${SECTION_TITLES[section]}\n`);
    out.push(list.map(item => item.text).join('\n'));
    out.push('\n');
  }
  let text = out.join('').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  if (text.length > budget) {
    // Only reachable for a pathologically small budget: the objective is the one mandatory body.
    text = text.slice(0, Math.max(0, budget - 1)).trimEnd() + '\n';
  }
  const packHash = hashText(text);
  const sections = RENDER_ORDER
    .filter(id => (admitted.get(id)?.length ?? 0) > 0)
    .map(id => ({ id, entries: admitted.get(id)!.length, chars: admitted.get(id)!.reduce((sum, item) => sum + item.text.length, 0) }));
  const telemetry: ContextPackTelemetry = {
    taskId: input.taskId,
    ...(input.subgoalId ? { subgoalId: input.subgoalId } : {}),
    taskType: input.taskType,
    ...(input.tier ? { tier: input.tier } : {}),
    budgetChars: budget,
    packChars: text.length,
    estimatedTokens: Math.ceil(text.length / CONTEXT_CHARS_PER_TOKEN),
    packHash,
    candidates: candidateRecords,
    selected,
    rejected,
    sections,
  };
  return {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    taskId: input.taskId,
    ...(input.subgoalId ? { subgoalId: input.subgoalId } : {}),
    taskType: input.taskType,
    text,
    packHash,
    chars: text.length,
    estimatedTokens: telemetry.estimatedTokens,
    telemetry,
  };
}
