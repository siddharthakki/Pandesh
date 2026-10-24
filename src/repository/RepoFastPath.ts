import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { extractReferencedSymbols } from '../orchestration/ConversationContinuity';
import { Logger } from '../services/Logger';
import { buildWorkspaceInventory, isInventoryQuestion, wantsFullInventory } from './WorkspaceInventory';
import { runGit } from './gitRunner';
import { buildHtmlExcerpt, extractLinkedAssets, mentionedFileKinds, resolveKindReference } from './HtmlEvidence';
import { censusProjects, computeRepositoryFacts, factsRecordFrom, isAnswerIntrospection, planRepositoryFacts, renderFactsPacket, renderIntrospectionPacket, type FactPlan, type FactsRecord, type HostFactsSummary, type ProjectCensus } from './RepositoryFacts';
import { clarificationPacket, hasFileDeixis, hasProjectDeixis, matchNamedProject } from './ReferentResolution';
import {
  ENTRY_STEM, MANIFEST_NAME, OVERVIEW_DOC_NAME, WORKSPACE_ACCESS_GUIDANCE,
  allocateArchitectureBudget, architectureSufficiency, buildImplementationStemIndex, interleaveModuleRanges, prioritizeExpansionTargets, classifyEvidencePath, deriveSubsystemTerms, findExpansionTargets, isArchitectureSubsystemQuestion,
  isRepositoryOverviewQuestion, isWrapperEvidencePath, overviewSufficiency, pickExpansionLines, rankArchitectureEvidence, scoreExpansionTarget,
  selectArchitectureEvidence, sourceCandidatesForBuiltEntry, summarizePackageJson,
  type OverviewEvidenceState, type RankedEvidence, type SubsystemTerms,
} from './RepoEvidencePlans';

/**
 * Repo Fast Path v0 — "the host finds code, the model reasons about code".
 *
 * `repo_query(question)` turns a repository question into a small, task-specific evidence packet
 * WITHOUT any model call and WITHOUT walking the repository in JavaScript:
 *   deterministic query type → parallel (git grep | workspace symbols | path match | open files | git dirty | hot set)
 *   → reciprocal-rank fusion → one batched range read → bounded packet.
 * Prompt size is set by the caps below, never by repository size.
 */

export type RepoQueryType = 'facts' | 'clarify' | 'inventory' | 'overview' | 'architecture' | 'changes' | 'identifier' | 'usage' | 'error_text' | 'conceptual';

/** A file the user named explicitly ("readme", "package.json", "src/foo.ts", "the config file"). */
export interface RepoFileTarget {
  text: string;
  /** Strong = a path/filename or a well-known document stem; weak = "<word> file" (must resolve unambiguously or is ignored). */
  strong: boolean;
}

export interface RepoQueryPlan {
  type: RepoQueryType;
  identifiers: string[];
  keywords: string[];
  literal?: string;
  fileTargets: RepoFileTarget[];
  /** ARCHITECTURE_SUBSYSTEM only: the subsystem the user asked about (strong terms) and related concepts (second pass). */
  subsystem?: SubsystemTerms;
}

export interface RepoRange { path: string; start: number; end: number; reason: string }
export interface RepoSearchHit { path: string; line: number; excerpt: string; reason: string }

export interface RepoQueryResult {
  prompt: string;
  files: Array<{ path: string; estimatedTokens: number }>;
  estimatedTokens: number;
  packageHash: string;
  type: RepoQueryType;
  /** True when lexical/symbol/dirty evidence matched the question (false = structural overview fallback only). */
  grounded: boolean;
  cacheHit: boolean;
  /** Workspace-relative files the user named that the host resolved and read (whole or structured). */
  explicitFiles: string[];
  /** Present when the host COMPUTED the answer (or decided a clarification is needed) rather than retrieving files. */
  hostFacts?: HostFactsSummary;
  /** A project the user explicitly named, or this answer scoped to: later "this project" may refer to it. */
  referent?: { path: string; reason: string };
  /** ARCHITECTURE_SUBSYSTEM: whether the packet met the evidence-sufficiency contract after the bounded passes. An insufficient packet must not end a turn as Completed. */
  evidenceVerdict?: { sufficient: boolean; reason: string };
}

export interface RepoQueryOptions {
  /** Character ceiling for the packet (derived from the selected model's window by the caller). */
  maxChars: number;
  /**
   * Preflight for a question nobody classified as repository-related: return a packet only when the workspace
   * actually matched it (named file, symbol, lexical hit), never the structural-overview fallback.
   */
  requireGrounding?: boolean;
  /** Files from the current conversation, in addition to the previous successful query. */
  hotFiles?: string[];
  /** The one project this conversation has explicitly established (named by the user, or identified by an earlier host answer). */
  establishedProject?: string;
  /** Workspace-relative file in the active editor. It resolves "this file" / "the html" and lifts a matching file into the evidence. */
  activeFile?: string;
}

const MAX_FILES = 8;
const MAX_RANGES = 10;
const MAX_RANGE_CHARS = 5_000;
const CONTEXT_LINES = 14;
const LEXICAL_BUDGET_MS = 2_000;
const SYMBOL_BUDGET_MS = 700;
const AUX_BUDGET_MS = 600;
const CACHE_LIMIT = 16;
const CACHE_TTL_MS = 10 * 60_000;
const RRF_K = 60;
const CENSUS_TTL_MS = 30_000;
const FACTS_BUDGET_MS = 25_000;
const EXPANSION_SOURCE_BYTES = 200_000;

const STOPWORDS = new Set(('about above after again also and any are but can could did does doing done each for from get give had has have how into its just like '
  + 'main make many more most much need not now off once only other our out over own same should show some such than that the their them then there these they '
  + 'this those through too under until use used using very want was were what when where which while who why will with would you your code file files '
  + 'repo repository project codebase implemented implement implementation work works working happen happens thing things find tell explain').split(' '));

const EXCLUDE_PATHSPECS = [
  ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/dist/**', ':(exclude,glob)**/out/**', ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/vendor/**', ':(exclude,glob)**/*.lock', ':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/*.min.*',
  ':(exclude,glob)**/*.map', ':(exclude,glob)**/*.svg', ':(exclude,glob)**/*.snap', ':(exclude,glob)**/*.png',
];

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.venv', '__pycache__', '.idea', 'target', '.next']);

// ── Deterministic file-target extraction ────────────────────────────────────

const DOC_STEMS = new Set(['readme', 'changelog', 'contributing', 'license', 'licence', 'security', 'roadmap', 'makefile', 'dockerfile']);
const FILE_WORD_SKIP = new Set(['the', 'this', 'that', 'a', 'an', 'each', 'every', 'any', 'my', 'our', 'your', 'whole', 'entire', 'single', 'same', 'whole', 'one', 'new', 'old', 'text', 'source', 'code', 'file', 'which']);

/** Pulls explicit file/path references out of a message. Pure and case-insensitive; no model involved. */
export function extractFileTargets(question: string): RepoFileTarget[] {
  const q = String(question ?? '');
  const targets: RepoFileTarget[] = [];
  const seen = new Set<string>();
  const add = (text: string, strong: boolean) => {
    const cleaned = text.replace(/^[`'"“(\[]+|[`'"”)\].,;:!?]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
    const key = cleaned.toLowerCase();
    if (cleaned.length < 2 || cleaned.length > 160 || seen.has(key)) return;
    seen.add(key);
    targets.push({ text: cleaned, strong });
  };
  // 1. path-like or filename-with-extension tokens: src/foo.ts, package.json, README.md, .env.example
  for (const m of q.matchAll(/(?:^|[\s`'"“(\[])((?:[\w.-]+[\\/])*\.?[\w-]+(?:\.[A-Za-z0-9]{1,8})+)(?=$|[\s`'"”)\].,;:!?])/g)) {
    const token = m[1];
    if (/^\d+(?:\.\d+)+$/.test(token) || /^(?:e\.g|i\.e|etc|vs)\.?$/i.test(token)) continue; // versions, abbreviations
    add(token, true);
  }
  // 2. well-known document stems typed bare, in any casing: "readme", "ReadMe", "the changelog"
  for (const m of q.toLowerCase().matchAll(/\b(readme|changelog|contributing|licen[cs]e|roadmap|makefile|dockerfile)\b/g)) add(m[1], true);
  // 3. "<word> file" — "the config file", "the manifest file"
  for (const m of q.matchAll(/\b([A-Za-z][\w-]{1,30})\s+file\b/gi)) {
    if (!FILE_WORD_SKIP.has(m[1].toLowerCase())) add(m[1], false);
  }
  return targets.slice(0, 4);
}

export function resolveFileTarget(target: RepoFileTarget, files: readonly string[]): string | undefined {
  const t = target.text.toLowerCase();
  const depth = (p: string) => p.split('/').length;
  const shallowest = (list: string[]) => [...list].sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b));
  const pickUnique = (list: string[]): string | undefined => {
    if (list.length === 0) return undefined;
    const sorted = shallowest(list);
    return sorted.length === 1 || depth(sorted[0]) < depth(sorted[1]) ? sorted[0] : (target.strong ? sorted[0] : undefined);
  };
  const base = (p: string) => path.posix.basename(p).toLowerCase();
  const stemOf = (p: string) => path.posix.parse(base(p)).name;
  // 1. exact relative path (exact case first, then case-insensitive)
  const exactCase = files.find(f => f === target.text);
  if (exactCase) return exactCase;
  const exactPath = files.filter(f => f.toLowerCase() === t);
  if (exactPath.length) return shallowest(exactPath)[0];
  // path suffix: "foo/bar.ts" inside a nested package
  if (t.includes('/')) {
    const suffix = pickUnique(files.filter(f => f.toLowerCase().endsWith(`/${t}`)));
    if (suffix) return suffix;
  }
  const wanted = path.posix.basename(t);
  // 2. case-insensitive basename
  const byBase = pickUnique(files.filter(f => base(f) === wanted));
  if (byBase) return byBase;
  // 3. case-insensitive stem ("readme" -> README.md / README.rst / README.txt); documentation formats first
  const wantedStem = path.posix.parse(wanted).name;
  const byStem = files.filter(f => stemOf(f) === wantedStem && !isLowValuePath(f));
  if (byStem.length) {
    const rank = (p: string) => (/\.(?:md|markdown|rst|txt|adoc)$/i.test(p) || !path.posix.extname(p) ? 0 : 1);
    const best = [...byStem].sort((a, b) => depth(a) - depth(b) || rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
    const topDepth = depth(best[0]);
    const atTop = best.filter(f => depth(f) === topDepth);
    if (atTop.length === 1 || target.strong) return best[0];
    if (new Set(atTop.map(stemOf)).size === 1 && atTop.every(f => rank(f) === rank(atTop[0]))) return undefined;
  }
  // 4. bounded fuzzy: exactly one obvious candidate whose name contains the target
  // A name WITH an extension is a specific file: a different file that merely contains the name is a rename, not a match.
  if (wantedStem.length >= 4 && !path.posix.extname(wanted)) {
    const fuzzy = files.filter(f => base(f).includes(wantedStem) && !isLowValuePath(f) && !isTestPath(f));
    if (fuzzy.length === 1) return fuzzy[0];
  }
  return undefined;
}

// ── Deterministic query typing ──────────────────────────────────────────────

export function planRepoQuery(question: string): RepoQueryPlan {
  const q = String(question ?? '').trim();
  const backticked = [...q.matchAll(/`([^`\n]{2,80})`/g)].map(match => match[1].trim());
  const identifiers = [...new Set([
    ...extractReferencedSymbols(q),
    ...backticked.filter(token => /^[A-Za-z_][\w.$/-]*$/.test(token)),
  ])].slice(0, 8);
  const quoted = [...q.matchAll(/["“']([^"”'\n]{8,160})["”']/g)].map(match => match[1].trim())
    .concat(backticked.filter(token => /\s|:/.test(token) && token.length >= 8));
  const literal = quoted.find(Boolean);
  const keywords = [...new Set(
    (q.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter(word => !STOPWORDS.has(word)),
  )].slice(0, 8);

  let type: RepoQueryType;
  if (isInventoryQuestion(q)) type = 'inventory';
  else if (/\b(?:what(?:'s| has| have)?\s+(?:has\s+)?changed|uncommitted|working tree|git (?:diff|status)|my (?:recent )?(?:changes|edits)|recent (?:changes|edits)|what did i (?:change|edit))\b/i.test(q)) type = 'changes';
  else if (literal && (/\b(?:error|exception|fail(?:ed|s|ure)?|throws?|message)\b/i.test(q) || identifiers.length === 0)) type = 'error_text';
  else if (identifiers.length > 0 && /\b(?:where|which|who)\b[^?.!]{0,60}\b(?:used|uses|called|calls|referenced|invoked|imported)\b|\busages? of\b|\bcallers? of\b/i.test(q)) type = 'usage';
  else if (isRepositoryOverviewQuestion(q)) type = 'overview';
  else if (isArchitectureSubsystemQuestion(q)) type = 'architecture';
  else if (/\b(?:what (?:does|is) (?:this|the|my|our)?\s*(?:repo|repository|project|codebase|app|application|workspace|tool|extension)\b|what is (?:this|the) (?:repo|repository|project|codebase)|(?:repo|repository|project|codebase)\b[^?.!]{0,30}\b(?:for|about|do|does)\b|overview|entry ?points?|architecture|high[- ]level|dependenc(?:y|ies)|requirements|tech stack|how is (?:this|the) (?:repo|project|code) (?:structured|organi[sz]ed))/i.test(q)) type = 'overview';
  else if (identifiers.length > 0 && q.split(/\s+/).length <= 4) type = 'identifier';
  else type = 'conceptual';
  return { type, identifiers, keywords, fileTargets: extractFileTargets(q), ...(literal ? { literal } : {}), ...(type === 'architecture' ? { subsystem: deriveSubsystemTerms(q) } : {}) };
}

// ── Pure helpers (rank fusion, range merge) ─────────────────────────────────

/** Reciprocal Rank Fusion over ordered candidate lists. Returns paths best-first with their fused score. */
export function fuseRanks(lists: ReadonlyArray<readonly string[]>): Array<{ path: string; score: number; sources: number }> {
  const scores = new Map<string, { score: number; sources: number }>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const entry = scores.get(item) ?? { score: 0, sources: 0 };
      entry.score += 1 / (RRF_K + index + 1);
      entry.sources += 1;
      scores.set(item, entry);
    });
  }
  return [...scores.entries()]
    .map(([file, value]) => ({ path: file, ...value }))
    .sort((a, b) => b.score - a.score || b.sources - a.sources || a.path.localeCompare(b.path));
}

export function mergeRanges(ranges: RepoRange[]): RepoRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: RepoRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 3) {
      last.end = Math.max(last.end, range.end);
      if (!last.reason.includes(range.reason)) last.reason = `${last.reason}+${range.reason}`;
    } else merged.push({ ...range });
  }
  return merged;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isLowValuePath(p: string): boolean {
  return /(?:^|\/)(?:__snapshots__|fixtures?|testdata|locales?|i18n|docs?\/archive)\//i.test(p) || /\.(?:lock|min\.js|map|snap|svg|png|jpe?g|gif|ico|woff2?|ttf|pdf|zip|vsix|db|sqlite)$/i.test(p);
}

function isTestPath(p: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|spec)\//i.test(p) || /\.(?:test|spec)\.[a-z]+$|(?:^|\/)test_[^/]+$|_test\.[a-z]+$/i.test(p);
}

async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<{ value: T; ms: number; timedOut: boolean }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  try {
    const raced = await Promise.race([work.then(value => ({ value })), timeout]);
    if ('timedOut' in raced) return { value: fallback, ms: Date.now() - started, timedOut: true };
    return { value: raced.value, ms: Date.now() - started, timedOut: false };
  } catch {
    return { value: fallback, ms: Date.now() - started, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SymbolHit { path: string; line: number; name: string; exact: boolean }

export class RepoFastPath {
  private isGitRepo?: Promise<boolean>;
  private readonly cache = new Map<string, { at: number; result: RepoQueryResult }>();
  private lastFiles: string[] = [];
  /** Files the user pointed at (by name, kind or active editor) earlier in this conversation: the focus a short follow-up keeps. */
  private focusFiles: string[] = [];
  private lastQuestion = '';
  /** The last repository-facts answer the host computed in this conversation: the only evidence a "why did you say that?" can rest on. */
  private lastFacts?: FactsRecord;
  private graphRanker?: (plan: { identifiers: readonly string[]; keywords: readonly string[] }) => string[];

  /**
   * Plugs the repository graph in as one more ranked source for the fusion. The graph only orders candidate paths; the
   * exact source ranges that reach the model are still read by this class.
   */
  setGraphRanker(ranker: ((plan: { identifiers: readonly string[]; keywords: readonly string[] }) => string[]) | undefined): void {
    this.graphRanker = ranker;
  }

  private graphRank(plan: { identifiers: readonly string[]; keywords: readonly string[] }): string[] {
    if (!this.graphRanker) return [];
    try { return this.graphRanker(plan).map(normalizePath); } catch { return []; }
  }

  constructor(private readonly root: string) {}

  /** New Chat: nothing the previous conversation retrieved or asked may steer the next one. */
  resetConversationState(): void {
    this.lastFiles = [];
    this.focusFiles = [];
    this.lastQuestion = '';
    this.lastFacts = undefined;
    this.fileListCache = undefined;
    this.cache.clear();
  }

  /** True when an earlier turn of this conversation grounded on specific files, so a short follow-up still refers to them. */
  hasFocus(): boolean {
    return this.focusFiles.length > 0;
  }

  /**
   * A follow-up keeps the workspace and the previous topic as CONTEXT. The files read for the previous turn are a hint
   * only: the new question searches the whole workspace and may need files the previous turn never touched.
   */
  private followUpNote(question: string): string {
    if (!this.lastQuestion) return '';
    const followUp = /\b(?:here|this|that|it|its|there|also|then|same|too|again)\b/i.test(question) || question.trim().split(/\s+/).length <= 8;
    if (!followUp) return '';
    const earlier = this.lastQuestion.length > 140 ? `${this.lastQuestion.slice(0, 140)}…` : this.lastQuestion;
    const files = this.lastFiles.slice(0, 6).join(', ');
    return `\nThis follows an earlier question in this conversation: "${earlier}".${files ? ` Files read for it: ${files} (a hint only; the evidence below was searched across the whole workspace for the new question).` : ''}`;
  }

  private git(): Promise<boolean> {
    this.isGitRepo ??= runGit(this.root, ['rev-parse', '--is-inside-work-tree'], 2_000).then(r => r.ok && r.stdout.trim() === 'true');
    return this.isGitRepo;
  }

  /** Cheap "does this identifier exist anywhere here" check used by the repository-question gate. undefined = cannot tell. */
  async knowsSymbols(candidates: string[]): Promise<boolean | undefined> {
    if (candidates.length === 0) return false;
    if (await this.git()) {
      const args = ['grep', '--untracked', '-l', '-I', '-w', '-F', '--max-count=1', ...candidates.slice(0, 6).flatMap(c => ['-e', c]), '--', '.', ...EXCLUDE_PATHSPECS];
      const result = await runGit(this.root, args, 1_500, 64 * 1024);
      return result.ok ? result.stdout.trim().length > 0 : undefined;
    }
    const symbols = await withDeadline(this.workspaceSymbols(candidates.slice(0, 3)), SYMBOL_BUDGET_MS, [] as SymbolHit[]);
    return symbols.value.length > 0 ? true : undefined;
  }

  // ── repo_search ───────────────────────────────────────────────────────────
  async repoSearch(plan: RepoQueryPlan): Promise<RepoSearchHit[]> {
    const fixedTerms = [...new Set([...(plan.literal ? [plan.literal] : []), ...plan.identifiers])].slice(0, 8);
    const looseTerms = plan.type === 'error_text' ? [] : plan.keywords.slice(0, 6);
    if (fixedTerms.length === 0 && looseTerms.length === 0) return [];
    const terms = [...fixedTerms, ...looseTerms];
    const hits: RepoSearchHit[] = [];
    const parse = (stdout: string, reason: string) => {
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const file = normalizePath(m[1]);
        if (isLowValuePath(file)) continue;
        hits.push({ path: file, line: Number(m[2]), excerpt: m[3].trim().slice(0, 160), reason });
      }
    };
    if (await this.git()) {
      const args = ['grep', '--untracked', '-n', '-I', '-i', '-F', '--no-color', '--max-count=4', ...terms.flatMap(t => ['-e', t]), '--', '.', ...EXCLUDE_PATHSPECS];
      const result = await runGit(this.root, args, LEXICAL_BUDGET_MS);
      parse(result.stdout, 'lexical');
    } else {
      const args = ['-n', '-i', '-F', '--no-heading', '--color=never', '--max-count=4', '--max-filesize=1M', ...terms.flatMap(t => ['-e', t]), '.'];
      const result = await new Promise<{ stdout: string; ok: boolean }>(resolve => {
        const child = spawn('rg', args, { cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const out: Buffer[] = [];
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, LEXICAL_BUDGET_MS);
        child.stdout?.on('data', (c: Buffer) => out.push(c));
        child.on('error', () => { clearTimeout(timer); resolve({ stdout: '', ok: false }); });
        child.on('close', () => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out).toString('utf8').slice(0, 2_000_000), ok: true }); });
      });
      parse(result.stdout, 'lexical');
    }
    return hits;
  }

  /** Files whose NAME matches a term; uses the Git index (or VS Code's ripgrep-backed file search outside Git). */
  private async pathMatches(plan: RepoQueryPlan): Promise<string[]> {
    const terms = [...plan.identifiers, ...plan.keywords].filter(t => /^[\w.-]+$/.test(t)).slice(0, 6);
    if (terms.length === 0) return [];
    if (await this.git()) {
      const specs = terms.map(t => `:(icase,glob)**/*${t}*`);
      const result = await runGit(this.root, ['ls-files', '--', ...specs, ...EXCLUDE_PATHSPECS], AUX_BUDGET_MS, 512 * 1024);
      return result.stdout.split(/\r?\n/).filter(Boolean).map(normalizePath).filter(p => !isLowValuePath(p)).slice(0, 40);
    }
    const found = await vscode.workspace.findFiles(`**/*{${terms.join(',')}}*`, '**/{node_modules,.git,dist,out,build}/**', 40);
    return found.map(uri => normalizePath(path.relative(this.root, uri.fsPath)));
  }

  // ── repo_symbols / repo_references ────────────────────────────────────────
  async repoSymbols(plan: RepoQueryPlan): Promise<SymbolHit[]> {
    const names = [...new Set([...plan.identifiers, ...(plan.identifiers.length === 0 ? plan.keywords.slice(0, 3) : [])])].slice(0, 4);
    return this.workspaceSymbols(names);
  }

  private async workspaceSymbols(names: string[]): Promise<SymbolHit[]> {
    const lists = await Promise.all(names.map(async name => {
      try {
        const found = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name);
        return (found ?? []).map(symbol => ({ symbol, name }));
      } catch { return []; }
    }));
    const hits: SymbolHit[] = [];
    for (const { symbol, name } of lists.flat()) {
      const fsPath = symbol.location?.uri?.fsPath;
      if (!fsPath || !fsPath.startsWith(this.root)) continue;
      const rel = normalizePath(path.relative(this.root, fsPath));
      if (/(?:^|\/)(?:node_modules|dist|out|build)\//.test(rel)) continue;
      hits.push({ path: rel, line: symbol.location.range.start.line + 1, name: symbol.name, exact: symbol.name.toLowerCase() === name.toLowerCase() });
    }
    return hits.sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, 16);
  }

  async repoReferences(symbol: SymbolHit): Promise<RepoSearchHit[]> {
    try {
      const uri = vscode.Uri.file(path.join(this.root, symbol.path));
      const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, new vscode.Position(symbol.line - 1, 0));
      return (refs ?? []).slice(0, 15).flatMap(ref => {
        const rel = normalizePath(path.relative(this.root, ref.uri.fsPath));
        return rel.startsWith('..') ? [] : [{ path: rel, line: ref.range.start.line + 1, excerpt: '', reason: 'reference' }];
      });
    } catch { return []; }
  }

  // ── hot set / git state ───────────────────────────────────────────────────
  private openFiles(): string[] {
    const open = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors ?? []) open.add(editor.document.uri.fsPath);
    for (const group of vscode.window.tabGroups?.all ?? []) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri?.scheme === 'file') open.add(input.uri.fsPath);
      }
    }
    return [...open].filter(file => file.startsWith(this.root)).map(file => normalizePath(path.relative(this.root, file)))
      .filter(file => !isLowValuePath(file));
  }

  private async dirtyFiles(): Promise<string[]> {
    if (!(await this.git())) return [];
    const result = await runGit(this.root, ['status', '--porcelain=v1', '-uall'], AUX_BUDGET_MS, 256 * 1024);
    return result.stdout.split(/\r?\n/).filter(line => line.length > 3)
      .map(line => normalizePath(line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')))
      .filter(file => !isLowValuePath(file)).slice(0, 50);
  }

  private async cacheKey(question: string, dirty: string[]): Promise<string | undefined> {
    if (!(await this.git())) return undefined;
    const head = (await runGit(this.root, ['rev-parse', 'HEAD'], AUX_BUDGET_MS, 4096)).stdout.trim();
    const stats = await Promise.all(dirty.slice(0, 50).map(async file => {
      try { const s = await fs.stat(path.join(this.root, file)); return `${file}:${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return `${file}:gone`; }
    }));
    const fingerprint = crypto.createHash('sha1').update(stats.join('|')).digest('hex');
    const query = crypto.createHash('sha1').update(question.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');
    return `${head}|${fingerprint}|${query}`;
  }

  // ── overview seeds (filesystem names only; no tree walk) ──────────────────
  private async overviewSeeds(): Promise<{ layout: string[]; files: string[] }> {
    let entries: import('fs').Dirent[] = [];
    try { entries = await fs.readdir(this.root, { withFileTypes: true }); } catch { /* unreadable root */ }
    const layout = entries.filter(e => !IGNORED_DIRS.has(e.name) && !(e.name.startsWith('.') && e.isDirectory()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(e => e.isDirectory() ? `${e.name}/` : e.name).slice(0, 40);
    const names = entries.filter(e => e.isFile()).map(e => e.name);
    const readme = names.filter(n => /^readme/i.test(n));
    const manifests = names.filter(n => /^(?:package\.json|pyproject\.toml|setup\.py|setup\.cfg|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|cmakelists\.txt|makefile|composer\.json|gemfile|requirements\.txt|.*\.sln|.*\.csproj|dockerfile|docker-compose\.ya?ml|agents?\.md|claude\.md)$/i.test(n));
    const entryCandidates = ['main', 'index', 'app', 'server', 'cli', 'extension', '__main__', 'manage', 'program', 'lib']
      .flatMap(base => ['', 'src/', 'app/', 'cmd/', 'lib/'].flatMap(dir => ['.ts', '.tsx', '.js', '.mjs', '.py', '.go', '.rs', '.java', '.cs', '.c', '.cpp', '.rb', '.php'].map(ext => `${dir}${base}${ext}`)));
    const present = await Promise.all(entryCandidates.map(async candidate => {
      try { await fs.access(path.join(this.root, candidate)); return candidate; } catch { return undefined; }
    }));
    return { layout, files: [...readme, ...manifests, ...present.filter((p): p is string => Boolean(p))] };
  }

  // ── repo_read_batch ───────────────────────────────────────────────────────
  async repoReadBatch(ranges: RepoRange[], maxChars: number, maxRanges = MAX_RANGES, perRangeChars = MAX_RANGE_CHARS): Promise<Array<RepoRange & { text: string }>> {
    const read = await Promise.all(ranges.slice(0, maxRanges * 2).map(async range => {
      try {
        const full = path.join(this.root, range.path);
        const handle = await fs.open(full, 'r');
        try {
          const size = (await handle.stat()).size;
          const buffer = Buffer.alloc(Math.min(size, 400_000));
          await handle.read(buffer, 0, buffer.length, 0);
          if (buffer.subarray(0, 4_000).includes(0)) return undefined; // binary
          const lines = buffer.toString('utf8').split(/\r?\n/);
          const start = Math.max(1, range.start);
          const end = Math.min(lines.length, Math.max(start, range.end));
          let text = lines.slice(start - 1, end).map((line, index) => `${start + index}| ${line.length > 220 ? `${line.slice(0, 220)}…` : line}`).join('\n');
          if (text.length > perRangeChars) text = `${text.slice(0, perRangeChars)}\n…`;
          return { ...range, start, end, text };
        } finally { await handle.close(); }
      } catch { return undefined; }
    }));
    const out: Array<RepoRange & { text: string }> = [];
    let used = 0;
    for (const item of read) {
      if (!item || out.length >= maxRanges) continue;
      const room = maxChars - used;
      if (room < 400) break;
      const text = item.text.length > room ? `${item.text.slice(0, room)}\n…` : item.text;
      out.push({ ...item, text });
      used += text.length + item.path.length + 40;
    }
    return out;
  }

  // ── explicit file targets ─────────────────────────────────────────────────
  private fileListCache?: { at: number; files: string[] };

  /** Workspace file list from the Git index (or VS Code's file search outside Git). Deterministic, bounded, short-lived cache. */
  private async listFiles(refresh = false): Promise<string[]> {
    if (!refresh && this.fileListCache && Date.now() - this.fileListCache.at < 20_000) return this.fileListCache.files;
    let files: string[] = [];
    if (await this.git()) {
      const result = await runGit(this.root, ['ls-files', '--cached', '--others', '--exclude-standard'], 1_500, 6 * 1024 * 1024);
      files = result.stdout.split(/\r?\n/).filter(Boolean).map(normalizePath);
    }
    if (files.length === 0) {
      try {
        const found = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,build,.venv,__pycache__,target}/**', 8_000);
        files = found.map(uri => normalizePath(path.relative(this.root, uri.fsPath)));
      } catch { /* no file search available */ }
    }
    if (files.length === 0) files = await this.walkFiles();
    files = files.filter(f => !f.startsWith('..') && !path.isAbsolute(f));
    this.fileListCache = { at: Date.now(), files };
    return files;
  }

  /** SHA-1 of a file's first 600 KB: byte-identical copies are one piece of evidence, not two. */
  private async fileDigest(rel: string): Promise<string | undefined> {
    try {
      const handle = await fs.open(path.join(this.root, rel), 'r');
      try {
        const buffer = Buffer.alloc(Math.min((await handle.stat()).size, 600_000));
        await handle.read(buffer, 0, buffer.length, 0);
        return crypto.createHash('sha1').update(buffer).digest('hex');
      } finally { await handle.close(); }
    } catch { return undefined; }
  }

  /** Bounded directory walk for a workspace with neither Git nor a VS Code file search: still a direct read of what is on disk. */
  private async walkFiles(): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= 4_000 || depth > 5) return;
      let entries: import('fs').Dirent[] = [];
      try { entries = await fs.readdir(path.join(this.root, dir), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (out.length >= 4_000) return;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) await visit(rel, depth + 1); } else if (entry.isFile()) out.push(rel);
      }
    };
    await visit('', 0);
    return out;
  }

  /**
   * Reads one named file: whole when it fits the budget, otherwise a deterministic, line-numbered selection that says
   * exactly which line ranges are NOT included (head, sections matching the question, then the earliest unread text in
   * order, plus an outline of the headings that were left out), so the model never claims to have verified text it did not see.
   */
  private async readExplicitFile(rel: string, budget: number, terms: string[]): Promise<{ text: string; mode: 'full' | 'structured'; lines: number }> {
    const handle = await fs.open(path.join(this.root, rel), 'r');
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 600_000));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, 4_000).includes(0)) throw new Error('binary file');
      const raw = buffer.toString('utf8').replace(/^﻿/, '');
      const lines = raw.split(/\r?\n/);
      const truncatedOnDisk = size > buffer.length;
      if (!truncatedOnDisk && raw.length <= budget) return { text: lines.join('\n'), mode: 'full', lines: lines.length };

      if (/\.html?$/i.test(rel)) {
        const html = buildHtmlExcerpt(raw, budget, terms, truncatedOnDisk);
        return { text: html.text, mode: 'structured', lines: lines.length };
      }
      const cost = (index: number) => Math.min(lines[index].length, 220) + 8;
      const included = new Array<boolean>(lines.length).fill(false);
      let used = 0;
      const take = (index: number): boolean => {
        if (included[index]) return true;
        if (used + cost(index) > budget) return false;
        included[index] = true;
        used += cost(index);
        return true;
      };
      // 1. the opening of the file (title, purpose, install/usage), up to 40% of the budget
      for (let i = 0; i < lines.length && used + cost(i) <= budget * 0.4; i++) take(i);
      // 2. sections around the question's own terms
      const outlineReserve = Math.min(2_000, Math.floor(budget * 0.12));
      const loweredTerms = terms.map(t => t.toLowerCase()).filter(t => t.length >= 4);
      let matched = 0;
      for (let i = 0; i < lines.length && loweredTerms.length > 0 && matched < 4; i++) {
        if (included[i] || !loweredTerms.some(t => lines[i].toLowerCase().includes(t))) continue;
        const from = Math.max(0, i - 4);
        const to = Math.min(lines.length - 1, i + 8);
        if (used + outlineReserve + (to - from + 1) * 60 > budget) break;
        for (let k = from; k <= to; k++) take(k);
        matched += 1;
        i = to;
      }
      // 3. deterministic chunking: the earliest not-yet-included lines, in file order, until the budget is spent
      const fillLimit = budget - outlineReserve;
      for (let i = 0; i < lines.length && used + cost(i) <= fillLimit; i++) take(i);

      const omitted: Array<[number, number]> = [];
      for (let i = 0; i < lines.length; i++) {
        if (included[i]) continue;
        const start = i;
        while (i + 1 < lines.length && !included[i + 1]) i++;
        omitted.push([start + 1, i + 1]);
      }
      const blocks: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!included[i]) continue;
        const start = i;
        while (i + 1 < lines.length && included[i + 1]) i++;
        blocks.push(lines.slice(start, i + 1).map((l, k) => `${start + k + 1}| ${l.length > 220 ? `${l.slice(0, 220)}…` : l}`).join('\n'));
      }
      const outline: string[] = [];
      for (const [from, to] of omitted) {
        for (let i = from - 1; i < to && outline.length < 60; i++) {
          const line = lines[i];
          if (/^#{1,6}\s+\S/.test(line) || (i + 1 < lines.length && /^(?:={3,}|-{3,}|~{3,})\s*$/.test(lines[i + 1]) && line.trim().length > 0)) outline.push(`${i + 1}| ${line.trim().slice(0, 120)}`);
        }
      }
      const parts = [blocks.join('\n…\n')];
      if (outline.length) parts.push(`[headings inside the parts that are NOT included: line| heading]\n${outline.join('\n')}`);
      const omittedText = omitted.length
        ? `NOT included: lines ${omitted.slice(0, 8).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')}${omitted.length > 8 ? ', …' : ''}`
        : 'every line was included';
      parts.push(`[file has ${lines.length}${truncatedOnDisk ? '+' : ''} lines; ${omittedText}. Do not claim to have verified text you were not given; name the sections you could not check.]`);
      return { text: parts.join('\n\n'), mode: 'structured', lines: lines.length };
    } finally { await handle.close(); }
  }

  /** Resolves every explicit file reference and reads the unique targets. Failures become notes, never silence. */
  private async readExplicitTargets(plan: RepoQueryPlan, budget: number): Promise<{ files: Array<{ path: string; text: string; mode: 'full' | 'structured'; lines: number }>; notes: string[]; infos?: string[] }> {
    const out = { files: [] as Array<{ path: string; text: string; mode: 'full' | 'structured'; lines: number }>, notes: [] as string[], infos: [] as string[] };
    if (plan.fileTargets.length === 0) return out;
    let all = await this.listFiles();
    const resolved: string[] = [];
    const unresolved: RepoFileTarget[] = [];
    for (const target of plan.fileTargets) {
      const hit = resolveFileTarget(target, all);
      if (hit) { if (!resolved.includes(hit)) resolved.push(hit); } else unresolved.push(target);
    }
    // A cached listing can predate a file the user just created or renamed: one fresh listing before declaring a file missing.
    if (unresolved.length > 0 && Date.now() - (this.fileListCache?.at ?? 0) > 500) {
      all = await this.listFiles(true);
      for (const target of unresolved.splice(0)) {
        const hit = resolveFileTarget(target, all);
        if (hit) { if (!resolved.includes(hit)) resolved.push(hit); } else unresolved.push(target);
      }
    }
    for (const target of unresolved) {
      const stem = target.text.toLowerCase();
      const named = /\.[A-Za-z0-9]{1,8}$/.test(target.text) || target.text.includes('/');
      if (!target.strong || !(DOC_STEMS.has(stem) || named)) continue;
      const wantedStem = path.posix.parse(path.posix.basename(stem)).name;
      const similar = all.filter(f => wantedStem.length >= 3 && path.posix.parse(path.posix.basename(f).toLowerCase()).name.replace(/[-_ ]/g, '').includes(wantedStem.replace(/[-_ ]/g, '')) && !isLowValuePath(f)).slice(0, 3);
      out.notes.push(`No file matching "${target.text}" exists in the workspace.${similar.length ? ` Similar files that do exist: ${similar.join(', ')}.` : ''} Say so plainly; do not describe the contents of a file that was not read.`);
    }
    // The target the user named comes FIRST and gets the budget it needs (whole file whenever it fits); later targets
    // share what is left, each keeping a floor so none is dropped. Nothing loosely related is read before this.
    const terms = [...plan.identifiers, ...plan.keywords];
    const targets = resolved.slice(0, 3);
    let remaining = budget;
    const digests = new Map<string, string>();
    const read = async (rel: string, share: number): Promise<boolean> => {
      const digest = await this.fileDigest(rel);
      const twin = digest ? digests.get(digest) : undefined;
      if (twin) { out.infos.push(`${rel} is byte-identical to ${twin}, which was read above; it is not repeated.`); return false; }
      if (digest) digests.set(digest, rel);
      try {
        const result = await this.readExplicitFile(rel, share, terms);
        out.files.push({ path: rel, ...result });
        remaining = Math.max(0, remaining - result.text.length - rel.length - 60);
        return true;
      } catch (error) {
        out.notes.push(`${rel} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    for (const [index, rel] of targets.entries()) {
      const reserveForOthers = 1_500 * (targets.length - index - 1);
      await read(rel, Math.max(1_500, remaining - reserveForOthers));
    }
    // Linked local scripts / stylesheets of a named HTML page are part of that page: read them (bounded) when the page
    // delegates behaviour or style to them. Remote (CDN) references are only listed.
    const page = out.files.find(file => /\.html?$/i.test(file.path));
    if (page) {
      try {
        const handle = await fs.open(path.join(this.root, page.path), 'r');
        let html = '';
        try {
          const buffer = Buffer.alloc(Math.min((await handle.stat()).size, 600_000));
          await handle.read(buffer, 0, buffer.length, 0);
          html = buffer.toString('utf8');
        } finally { await handle.close(); }
        const linked = extractLinkedAssets(html, page.path, all);
        const wantsStyle = /\b(?:css|style|styles|styling|layout|theme|design|look|colou?rs?|responsive|animation)\b/i.test(terms.join(' '));
        const picks = [...linked.scripts, ...(wantsStyle ? linked.styles : [])].filter(f => !out.files.some(file => file.path === f)).slice(0, 3);
        for (const rel of picks) if (remaining >= 1_500) await read(rel, Math.min(Math.floor(budget * 0.4), remaining));
        const listed = [...linked.scripts, ...linked.styles].filter(f => !out.files.some(file => file.path === f));
        if (listed.length || linked.remote.length) {
          out.infos.push(`${page.path} links ${[...linked.scripts, ...linked.styles].length} local asset(s)${listed.length ? ` not read for this question (ask for them by name): ${listed.join(', ')}` : ''}${linked.remote.length ? `; external (not fetched): ${linked.remote.slice(0, 4).join(', ')}` : ''}.`);
        }
      } catch { /* the page itself was already read; its link scan is best-effort */ }
    }
    return out;
  }

  /** Bounded `git diff HEAD` (stat + patch) for "what changed" questions. Empty outside Git. */
  private async diffSummary(maxChars: number): Promise<string> {
    if (!(await this.git())) return '';
    const stat = await runGit(this.root, ['diff', 'HEAD', '--stat', '--no-color'], AUX_BUDGET_MS, 64 * 1024);
    const patch = await runGit(this.root, ['diff', 'HEAD', '-U3', '--no-color', '--', '.', ...EXCLUDE_PATHSPECS], AUX_BUDGET_MS, 128 * 1024);
    return `${stat.stdout.trim().slice(0, 1_500)}\n\n${patch.stdout.slice(0, Math.max(2_000, Math.floor(maxChars * 0.5)))}`.trim();
  }

  // ── deterministic repository facts ────────────────────────────────────────
  private censusCache?: { at: number; census: ProjectCensus };

  private packetResult(prompt: string, type: RepoQueryType, extra: Partial<RepoQueryResult> = {}): RepoQueryResult {
    return {
      prompt, files: [], estimatedTokens: Math.ceil(prompt.length / 3.5), packageHash: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
      type, grounded: true, cacheHit: false, explicitFiles: [], ...extra,
    };
  }

  /** READ-ONLY host computation (see RepositoryFacts). The model never runs, and is never offered, a command for this. */
  private async answerFactQuery(plan: FactPlan, maxChars: number, question = ''): Promise<RepoQueryResult> {
    const workspaceName = path.basename(this.root) || this.root;
    const prior = this.censusCache && Date.now() - this.censusCache.at < CENSUS_TTL_MS ? this.censusCache.census : undefined;
    const computed = await withDeadline(computeRepositoryFacts(this.root, plan, { maxChars: Math.max(2_000, maxChars - 1_500) }, prior), FACTS_BUDGET_MS, undefined as Awaited<ReturnType<typeof computeRepositoryFacts>>);
    const facts = computed.value;
    if (!facts) {
      const reason = computed.timedOut ? 'the computation did not finish within its safety limit' : 'the workspace could not be enumerated';
      const prompt = `Repository facts were requested (${plan.kind}) but the host could not compute them: ${reason}. Tell the user exactly that, name what was attempted, and offer to retry. `
        + 'Do not guess any figure, and do not tell the user to run commands themselves. ' + WORKSPACE_ACCESS_GUIDANCE;
      return this.packetResult(prompt, 'facts', { hostFacts: { kind: plan.kind, computing: 'Counting tracked files', measured: 'Could not complete', outcome: 'blocked' } });
    }
    if (facts.census) this.censusCache = { at: Date.now(), census: facts.census };
    this.lastFacts = factsRecordFrom(question, facts);
    let prompt = renderFactsPacket(facts, workspaceName);
    if (plan.kind === 'git_change_summary' && facts.changes && facts.changes.total > 0) {
      const diff = await withDeadline(this.diffSummary(Math.max(2_000, maxChars - prompt.length)), 2 * AUX_BUDGET_MS, '');
      if (diff.value) prompt += `\n\n--- git diff (working tree vs HEAD), bounded ---\n${diff.value}`;
    }
    return this.packetResult(prompt, 'facts', { hostFacts: facts.summary, ...(facts.summary.established ? { referent: facts.summary.established } : {}) });
  }

  private async projectPaths(): Promise<string[]> {
    if (this.censusCache && Date.now() - this.censusCache.at < CENSUS_TTL_MS) return this.censusCache.census.roots.map(root => root.path);
    const census = await withDeadline(censusProjects(this.root, false), FACTS_BUDGET_MS, undefined as Awaited<ReturnType<typeof censusProjects>>);
    if (census.value) this.censusCache = { at: Date.now(), census: census.value };
    return census.value?.roots.map(root => root.path) ?? [];
  }

  /**
   * "Explain this project" must resolve to a project the conversation actually established. Returns a clarification
   * packet when it did not (never a guess from retrieval), the resolved project when it did, or nothing when the
   * message has no such reference or the workspace has only one project.
   */
  private async resolveReferent(question: string, plan: RepoQueryPlan, options: RepoQueryOptions): Promise<{ clarify: RepoQueryResult } | { project: { path: string; reason: string } } | undefined> {
    if (plan.fileTargets.some(target => target.strong) || plan.identifiers.length > 0 || plan.literal) return undefined;
    const workspaceName = path.basename(this.root) || this.root;
    if (hasProjectDeixis(question)) {
      const allProjects = await this.projectPaths();
      const projects = allProjects.filter(p => p !== '.');
      if (projects.length < 2) return undefined;
      const named = matchNamedProject(question, projects);
      if (named) return { project: { path: named, reason: 'named by the user' } };
      if (options.establishedProject && projects.includes(options.establishedProject)) return { project: { path: options.establishedProject, reason: 'established earlier in this conversation' } };
      // The opened workspace is itself a project (it has its own manifest): "this project" is that repository, with its
      // nested packages as parts of it. Only a container of unrelated projects needs the question asked back.
      if (allProjects.includes('.')) return undefined;
      const ranked = this.censusCache ? [...this.censusCache.census.assigner.projects].sort((a, b) => b.files - a.files).map(p => p.path).filter(p => p !== '.') : projects;
      const prompt = clarificationPacket({ what: 'project', workspaceName, projectCount: projects.length, candidates: ranked.slice(0, 6) });
      return { clarify: this.packetResult(prompt, 'clarify', { hostFacts: { kind: 'clarify_referent', recognised: projects.length, outcome: 'needs_input' } }) };
    }
    if (hasFileDeixis(question) && (options.hotFiles ?? []).length === 0 && this.lastFiles.length === 0 && this.focusFiles.length === 0 && !options.activeFile && this.openFiles().length === 0) {
      const prompt = clarificationPacket({ what: 'file', workspaceName, projectCount: 0, candidates: [] });
      return { clarify: this.packetResult(prompt, 'clarify', { hostFacts: { kind: 'clarify_referent', outcome: 'needs_input' } }) };
    }
    return undefined;
  }

  /** Evidence for ONE resolved project: its own README / manifest / entry files and its top-level layout, nothing else. */
  private async scopedProjectResult(project: { path: string; reason: string }, plan: RepoQueryPlan, maxChars: number): Promise<RepoQueryResult | undefined> {
    const all = await this.listFiles();
    const prefix = `${project.path}/`;
    const inside = all.filter(file => file.startsWith(prefix));
    if (inside.length === 0) return undefined;
    const direct = inside.filter(file => !file.slice(prefix.length).includes('/'));
    const layout = [...new Set(inside.map(file => `${file.slice(prefix.length).split('/')[0]}${file.slice(prefix.length).includes('/') ? '/' : ''}`))].sort().slice(0, 40);
    const pick = (pattern: RegExp) => direct.filter(file => pattern.test(path.posix.basename(file)));
    const named = [
      ...pick(/^readme/i),
      ...pick(/^(?:package\.json|pyproject\.toml|setup\.py|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|.*\.csproj|requirements\.txt)$/i),
      ...pick(/^(?:main|index|app|server|cli|__main__|manage|program|api)\.[a-z]+$/i),
    ].slice(0, 3);
    const explicit = await withDeadline(
      this.readExplicitTargets({ ...plan, fileTargets: named.map(text => ({ text, strong: true })) }, Math.floor(maxChars * 0.8)), 2_500,
      { files: [], notes: [] } as Awaited<ReturnType<RepoFastPath['readExplicitTargets']>>,
    ).then(result => result.value);
    const header = `Repository evidence for the project "${project.path}" in workspace "${path.basename(this.root) || this.root}". The host resolved the user's "this project" to it (${project.reason}); `
      + 'it is the ONLY project covered below. Answer about this project from the evidence; if it is insufficient say what is missing. Never say you cannot access the workspace. ' + WORKSPACE_ACCESS_GUIDANCE;
    const sections = explicit.files.map(file => `--- ${file.path} [${file.mode === 'full' ? `full file, ${file.lines} lines` : 'structured excerpt'}] ---\n${file.text}`);
    const notes = explicit.notes.length ? [`--- host read problems ---\n${explicit.notes.join('\n')}`] : [];
    const prompt = [header, `--- ${project.path}/ top-level entries (${inside.length} tracked files) ---\n${layout.join(', ')}`, ...sections, ...notes].join('\n\n');
    const result = this.packetResult(prompt, 'overview', {
      files: explicit.files.map(file => ({ path: file.path, estimatedTokens: Math.ceil(file.text.length / 3.5) })),
      explicitFiles: explicit.files.map(file => file.path),
      referent: project,
    });
    this.lastFiles = result.files.map(file => file.path);
    return result;
  }

  // ── REPOSITORY_OVERVIEW ───────────────────────────────────────────────────
  /**
   * Deterministic overview pack: README, project manifest(s), a compact workspace tree, likely entrypoints and any
   * architecture docs. No lexical ranking decides what the project is. A pack that lacks something the workspace has
   * (README, manifest, entrypoint) triggers a second, deeper bounded pass before it is sent.
   */
  private async overviewPack(question: string, maxChars: number, activeFile?: string): Promise<RepoQueryResult | undefined> {
    const all = (await this.listFiles()).filter(f => !isLowValuePath(f) && !/(?:^|\/)(?:node_modules|dist|out|build|\.git|\.venv|target)\//.test(f));
    if (all.length === 0) return undefined;
    const log: string[] = [];
    let pack: Awaited<ReturnType<RepoFastPath['collectOverviewEvidence']>> | undefined;
    for (const maxDepth of [1, 3]) {
      pack = await this.collectOverviewEvidence(all, maxChars, maxDepth, activeFile);
      const verdict = overviewSufficiency(pack.state);
      log.push(`pass ${maxDepth === 1 ? 1 : 2} (depth<=${maxDepth}): ${verdict.reason}`);
      if (verdict.sufficient) break;
    }
    if (!pack) return undefined;
    const workspaceName = path.basename(this.root) || this.root;
    const header = `Repository evidence retrieved by the host from the open workspace "${workspaceName}" (${this.root}) for a REPOSITORY_OVERVIEW question. `
      + 'The host assembled it deterministically from the README, project manifests, workspace tree, entrypoints and architecture docs; no single file IS the project. '
      + 'Describe the project from ALL of it (the manifest and entrypoints say what kind of project this is). Never say you cannot access the repository. '
      + WORKSPACE_ACCESS_GUIDANCE;
    const state = pack.state;
    const checks = `Evidence checks: README ${state.readmeAvailable ? (state.readmeIncluded ? 'included' : 'MISSING') : 'none in workspace'}; manifest ${state.manifestAvailable ? (state.manifestIncluded ? 'included' : 'MISSING') : 'none in workspace'}; `
      + `tree ${state.treeIncluded ? 'included' : 'MISSING'}; entrypoint ${state.entrypointAvailable ? (state.entrypointIncluded ? 'included' : 'MISSING') : 'none found'}. Retrieval: ${log.join('; ')}.`;
    const prompt = [header + this.followUpNote(question), ...pack.sections, checks].join('\n\n');
    const result = this.packetResult(prompt, 'overview', { files: pack.files });
    this.lastFiles = pack.files.map(file => file.path);
    return result;
  }

  private async collectOverviewEvidence(all: string[], maxChars: number, maxDepth: number, activeFile?: string): Promise<{
    sections: string[]; files: Array<{ path: string; estimatedTokens: number }>; state: OverviewEvidenceState;
  }> {
    const depth = (f: string) => f.split('/').length;
    const base = (f: string) => path.posix.basename(f);
    const fileSet = new Set(all);
    const files: Array<{ path: string; estimatedTokens: number }> = [];
    const sections: string[] = [];
    const note = (rel: string, text: string) => files.push({ path: rel, estimatedTokens: Math.ceil(text.length / 3.5) });
    const docRank = (p: string) => (/\.(?:md|markdown|rst|txt|adoc)$/i.test(p) || !path.posix.extname(p) ? 0 : 1);

    // README
    const readmeAll = all.filter(f => /^readme/i.test(base(f)) && depth(f) <= 3);
    const readme = readmeAll.filter(f => depth(f) <= maxDepth).sort((a, b) => depth(a) - depth(b) || docRank(a) - docRank(b) || a.length - b.length)[0];
    let readmeIncluded = false;
    if (readme) {
      try {
        const read = await this.readExplicitFile(readme, Math.min(6_500, Math.floor(maxChars * 0.28)), []);
        sections.push(`--- ${readme} [README, ${read.mode === 'full' ? `full file, ${read.lines} lines` : 'structured excerpt'}] ---\n${read.text}`);
        note(readme, read.text);
        readmeIncluded = true;
      } catch { /* unreadable README is reported as missing below */ }
    }

    // Manifests (root first; nested workspace members only on the deeper pass)
    const manifestAll = all.filter(f => MANIFEST_NAME.test(base(f)) && depth(f) <= 3);
    const manifestPick = (f: string) => (/^package\.json$/i.test(base(f)) ? 0 : /^(?:pyproject\.toml|cargo\.toml|go\.mod|pom\.xml)$/i.test(base(f)) ? 1 : 2);
    const manifests = manifestAll.filter(f => depth(f) <= maxDepth).sort((a, b) => depth(a) - depth(b) || manifestPick(a) - manifestPick(b) || a.localeCompare(b));
    const rootManifests = manifests.filter(f => depth(f) === 1).slice(0, 3);
    const chosenManifests = [...rootManifests, ...manifests.filter(f => depth(f) > 1).slice(0, 2)];
    const manifestBudget = Math.max(900, Math.floor((maxChars * 0.22) / Math.max(1, chosenManifests.length)));
    let manifestIncluded = false;
    let rootPackage: Record<string, unknown> | undefined;
    for (const rel of chosenManifests) {
      try {
        const handle = await fs.open(path.join(this.root, rel), 'r');
        let raw = '';
        try {
          const buffer = Buffer.alloc(Math.min((await handle.stat()).size, 300_000));
          await handle.read(buffer, 0, buffer.length, 0);
          raw = buffer.toString('utf8');
        } finally { await handle.close(); }
        const summary = /^package\.json$/i.test(base(rel)) ? summarizePackageJson(raw) : undefined;
        if (summary && rel === 'package.json') { try { rootPackage = JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>; } catch { /* summary already degraded */ } }
        const text = (summary ?? raw.split(/\r?\n/).slice(0, 45).join('\n')).slice(0, manifestBudget);
        sections.push(`--- ${rel} [${summary ? 'manifest summary' : 'manifest, first lines'}] ---\n${text}`);
        note(rel, text);
        manifestIncluded = true;
      } catch { /* unreadable manifest */ }
    }

    // Workspace tree
    const topDirs = new Map<string, { count: number; children: Map<string, number> }>();
    const rootFiles: string[] = [];
    for (const f of all) {
      const parts = f.split('/');
      if (parts.length === 1) { rootFiles.push(f); continue; }
      const entry = topDirs.get(parts[0]) ?? { count: 0, children: new Map<string, number>() };
      entry.count += 1;
      if (parts.length > 2) entry.children.set(parts[1], (entry.children.get(parts[1]) ?? 0) + 1);
      topDirs.set(parts[0], entry);
    }
    const dirLines = [...topDirs.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, 14).map(([dir, info], index) => {
      const kids = index < 8 ? [...info.children.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name]) => `${name}/`) : [];
      return `  ${dir}/ — ${info.count} files${kids.length ? `: ${kids.join(', ')}` : ''}`;
    });
    const treeText = `workspace tree (${all.length} files, ${topDirs.size} top-level folders):\n${dirLines.join('\n')}\n  root files: ${rootFiles.slice(0, 16).join(', ')}${rootFiles.length > 16 ? ', …' : ''}`.slice(0, Math.max(1_200, Math.floor(maxChars * 0.12)));
    sections.push(`--- ${treeText.split('\n')[0]} ---\n${treeText.split('\n').slice(1).join('\n')}`);

    // Entrypoints: what the manifest says first, then conservative name heuristics
    const fromManifest: string[] = [];
    if (rootPackage) {
      const built: string[] = [];
      for (const key of ['main', 'module']) if (typeof rootPackage[key] === 'string') built.push(rootPackage[key] as string);
      const bin = rootPackage['bin'];
      if (typeof bin === 'string') built.push(bin);
      else if (bin && typeof bin === 'object') built.push(...Object.values(bin as Record<string, unknown>).filter((v): v is string => typeof v === 'string'));
      for (const entry of built) {
        const hit = sourceCandidatesForBuiltEntry(entry).find(candidate => fileSet.has(candidate));
        if (hit) fromManifest.push(hit);
      }
    }
    const isEntryName = (f: string) => ENTRY_STEM.test(path.posix.parse(f).name) && classifyEvidencePath(f) === 'implementation' && !isTestPath(f);
    const srcRank = (f: string) => (/^(?:src|app|lib|cmd|core|server|packages\/[^/]+\/src)\//i.test(f) ? 0 : 1);
    const stemRank = (f: string) => ['extension', 'main', 'app', 'server', 'cli', 'index'].indexOf(path.posix.parse(f).name.toLowerCase()) >>> 0;
    const entryAvailable = fromManifest.length > 0 || all.some(f => isEntryName(f) && depth(f) <= 5);
    const heuristic = all.filter(f => isEntryName(f) && depth(f) <= (maxDepth === 1 ? 3 : 5))
      .sort((a, b) => srcRank(a) - srcRank(b) || depth(a) - depth(b) || stemRank(a) - stemRank(b) || a.length - b.length);
    const entries = [...new Set([...fromManifest, ...heuristic])].slice(0, 3);
    const docs = all.filter(f => /\.(?:md|markdown|rst|txt|adoc)$/i.test(f) && depth(f) <= 2 && OVERVIEW_DOC_NAME.test(base(f)) && !/^readme/i.test(base(f)))
      .sort((a, b) => depth(a) - depth(b) || Number(/architect/i.test(base(b))) - Number(/architect/i.test(base(a))) || a.localeCompare(b)).slice(0, 2);
    const ranges: RepoRange[] = [
      ...entries.map(rel => ({ path: rel, start: 1, end: 70, reason: 'entrypoint' })),
      ...docs.map(rel => ({ path: rel, start: 1, end: 55, reason: 'architecture doc (supporting)' })),
    ];
    const batch = await this.repoReadBatch(ranges, Math.max(1_500, Math.floor(maxChars * 0.4)), 6);
    for (const item of batch) {
      sections.push(`--- ${item.path}:${item.start}-${item.end} [${item.reason}] ---\n${item.text}`);
      note(item.path, item.text);
    }
    let entrypointIncluded = batch.some(item => item.reason === 'entrypoint');
    let appSourceIncluded = false;
    // A workspace with no README, manifest or conventionally named entrypoint (a single-page web app, a script folder) is
    // described by its own source: the top-level source documents ARE the evidence, read with the same structured reader.
    if (!readmeIncluded && !manifestIncluded && !entrypointIncluded) {
      const sourceRank = (f: string) => ['.html', '.htm', '.py', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.go', '.rs', '.java', '.cs', '.rb', '.php', '.sh', '.ps1'].indexOf(path.posix.extname(f).toLowerCase());
      const sources = all.filter(f => depth(f) <= Math.max(2, maxDepth) && sourceRank(f) >= 0 && !isTestPath(f))
        .sort((a, b) => Number(b === activeFile) - Number(a === activeFile) || depth(a) - depth(b) || sourceRank(a) - sourceRank(b) || a.localeCompare(b)).slice(0, 3);
      let remaining = Math.max(2_000, Math.floor(maxChars * 0.6));
      const seenSources = new Map<string, string>();
      for (const rel of sources) {
        if (remaining < 1_500) break;
        const digest = await this.fileDigest(rel);
        if (digest && seenSources.has(digest)) { sections.push(`--- ${rel} [byte-identical to ${seenSources.get(digest)}, not repeated] ---`); continue; }
        if (digest) seenSources.set(digest, rel);
        try {
          const read = await this.readExplicitFile(rel, Math.min(remaining, Math.floor(maxChars * 0.45)), []);
          sections.push(`--- ${rel} [application source, ${read.mode === 'full' ? `full file, ${read.lines} lines` : `structured excerpt of ${read.lines} lines`}] ---
${read.text}`);
          note(rel, read.text);
          remaining -= read.text.length;
          appSourceIncluded = true;
          this.focusFiles = [...new Set([...this.focusFiles, rel])].slice(0, 3);
        } catch { /* unreadable source file */ }
      }
      if (appSourceIncluded) entrypointIncluded = true;
    }
    return {
      sections, files,
      state: {
        readmeAvailable: readmeAll.length > 0, readmeIncluded,
        manifestAvailable: manifestAll.length > 0, manifestIncluded,
        treeIncluded: true,
        entrypointAvailable: entryAvailable || appSourceIncluded, entrypointIncluded,
      },
    };
  }

  // ── ARCHITECTURE_SUBSYSTEM ────────────────────────────────────────────────
  private async gatherArchitectureEvidence(primary: string[], expanded: string[]) {
    const fixed = (identifiers: string[]): RepoQueryPlan => ({ type: 'architecture', identifiers, keywords: [], fileTargets: [] });
    const allTerms = [...primary.slice(0, 4), ...expanded.slice(0, 6)];
    const [primaryHits, expandedHits, symbols, names] = await Promise.all([
      withDeadline(this.repoSearch(fixed(primary.slice(0, 4))), LEXICAL_BUDGET_MS + 200, [] as RepoSearchHit[]),
      expanded.length ? withDeadline(this.repoSearch(fixed(expanded.slice(0, 6))), LEXICAL_BUDGET_MS + 200, [] as RepoSearchHit[]) : Promise.resolve({ value: [] as RepoSearchHit[], ms: 0, timedOut: false }),
      withDeadline(this.workspaceSymbols(primary.slice(0, 3)), SYMBOL_BUDGET_MS, [] as SymbolHit[]),
      withDeadline(this.pathMatches(fixed(allTerms)), AUX_BUDGET_MS, [] as string[]),
    ]);
    return { hits: [...primaryHits.value, ...expandedHits.value], symbols: symbols.value, names: names.value };
  }

  /**
   * Targeted expansion for "how does X work": derive subsystem terms, search names / symbols / source text, rank
   * implementation ABOVE UI mentions, read several bounded implementation ranges, keep docs as support. When the first
   * packet fails the sufficiency rule the host widens the search itself (related concepts) instead of asking the user.
   */
  private async readSourceText(rel: string): Promise<string> {
    try {
      const handle = await fs.open(path.join(this.root, rel), 'r');
      try {
        const buffer = Buffer.alloc(Math.min((await handle.stat()).size, EXPANSION_SOURCE_BYTES));
        await handle.read(buffer, 0, buffer.length, 0);
        if (buffer.subarray(0, 4_000).includes(0)) return '';
        return buffer.toString('utf8');
      } finally { await handle.close(); }
    } catch { return ''; }
  }

  /**
   * Follows the workspace-local imports / symbol references of the already-selected implementation files, 1–2 hops,
   * bounded. The host resolves them against the workspace file list (no model, no LSP); modules whose names or contents
   * match the subsystem terms come first, the remaining imported implementation modules fill the allowance, so a
   * controller/demo wrapper never stands in for the modules it wires together.
   */
  private async expandImplementationImports(
    seeds: string[], terms: { primary: string[]; expanded: string[] }, already: ReadonlySet<string>,
    limits: { hops: number; perHop: number; total: number },
  ): Promise<{ items: RankedEvidence[]; resolvable: number; trail: string[] }> {
    const files = new Set(await this.listFiles());
    const stemIndex = buildImplementationStemIndex(files);
    const visited = new Set<string>([...already, ...seeds]);
    const items: RankedEvidence[] = [];
    const trail: string[] = [];
    const sources = new Map<string, string>();
    const sourceOf = async (rel: string) => {
      if (!sources.has(rel)) sources.set(rel, await this.readSourceText(rel));
      return sources.get(rel) ?? '';
    };
    let frontier = seeds.slice(0, 3);
    let resolvable = 0;
    for (let hop = 1; hop <= limits.hops && frontier.length > 0 && items.length < limits.total; hop++) {
      const found = new Map<string, { via: 'import' | 'reference'; from: string }>();
      const coveredImports = new Set<string>();
      for (const from of frontier) {
        for (const target of findExpansionTargets(from, await sourceOf(from), files, stemIndex)) {
          if (visited.has(target.path)) { if (target.via === 'import') coveredImports.add(target.path); continue; }
          if (!found.has(target.path)) found.set(target.path, { via: target.via, from });
        }
      }
      resolvable += found.size;
      // Direct graph walk: exact imports are scored in full (every one is cheap and already resolved); the loose
      // identifier→file-stem references that inflated the candidate cloud are only a bounded fallback inside prioritizeExpansionTargets.
      const candidates = [...found.entries()];
      const scored = await Promise.all(candidates.map(async ([target, meta]) => {
        const score = scoreExpansionTarget(target, await sourceOf(target), terms);
        return { path: target, via: meta.via, from: meta.from, ...score };
      }));
      const room = Math.min(hop === 1 ? limits.perHop : Math.ceil(limits.perHop / 2), limits.total - items.length);
      const picked = prioritizeExpansionTargets(scored, terms, room, coveredImports.size);
      for (const pick of picked) {
        visited.add(pick.path);
        items.push({
          path: pick.path, cls: 'implementation', score: pick.score,
          lines: pickExpansionLines(await sourceOf(pick.path), terms), reasons: [pick.via, pick.tier],
        });
        trail.push(`${path.posix.basename(pick.from)} → ${path.posix.basename(pick.path)} (${pick.via}, hop ${hop})`);
      }
      frontier = picked.map(pick => pick.path);
    }
    return { items, resolvable, trail };
  }

  private async architecturePack(question: string, plan: RepoQueryPlan, maxChars: number, requireGrounding: boolean): Promise<RepoQueryResult | undefined> {
    const subsystem = plan.subsystem ?? deriveSubsystemTerms(question);
    if (subsystem.primary.length === 0) return undefined;
    // Pass 2 always runs when pass 1 is insufficient: it adds related concepts (when there are any) and a wider import expansion.
    const passes: Array<{ label: string; expanded: string[]; hops: number; perHop: number; total: number; seeds: number }> = [
      { label: 'subject terms', expanded: [], hops: 2, perHop: 4, total: 6, seeds: 2 },
      { label: subsystem.expanded.length > 0 ? 'subject + related concepts' : 'subject terms, wider imports', expanded: subsystem.expanded, hops: 2, perHop: 6, total: 8, seeds: 4 },
    ];
    const log: string[] = [];
    let best: { ranked: RankedEvidence[]; selection: ReturnType<typeof selectArchitectureEvidence>; batch: Array<RepoRange & { text: string }>; sufficient: boolean; reason: string; trail: string[] } | undefined;
    for (const [index, pass] of passes.entries()) {
      const gathered = await this.gatherArchitectureEvidence(subsystem.primary, pass.expanded);
      const ranked = rankArchitectureEvidence({
        primary: subsystem.primary, expanded: pass.expanded, hits: gathered.hits,
        symbolPaths: gathered.symbols.filter(symbol => subsystem.primary.some(term => symbol.name.toLowerCase().includes(term))).map(symbol => ({ path: symbol.path, line: symbol.line, name: symbol.name })),
        pathMatches: gathered.names,
      });
      const lexicalSelection = selectArchitectureEvidence(ranked);
      const lexicalImplementation = lexicalSelection.selected.filter(item => item.cls === 'implementation');
      const expansion = lexicalImplementation.length > 0
        ? await this.expandImplementationImports(
          lexicalImplementation.slice(0, pass.seeds).map(item => item.path), { primary: subsystem.primary, expanded: pass.expanded.length ? pass.expanded : subsystem.expanded },
          new Set(lexicalImplementation.map(item => item.path)), pass,
        )
        : { items: [] as RankedEvidence[], resolvable: 0, trail: [] as string[] };
      const selection = selectArchitectureEvidence(ranked, undefined, expansion.items);
      const rangesOf = (item: RankedEvidence): RepoRange[] => {
        const reason = `${item.cls}; ${item.reasons.join('+')}`;
        const wide = item.cls === 'implementation' ? 36 : 16;
        const own = item.lines.slice(0, 4).map(line => ({ path: item.path, start: Math.max(1, line - 6), end: line + wide, reason }));
        if (own.length === 0) return [{ path: item.path, start: 1, end: 60, reason }];
        // mergeRanges orders by file position; the module's guaranteed first range must be its highest-priority line (definitions related to the subsystem first).
        const priority = (range: RepoRange) => { const at = item.lines.findIndex(line => line >= range.start && line <= range.end); return at < 0 ? Number.MAX_SAFE_INTEGER : at; };
        return mergeRanges(own).sort((a, b) => priority(a) - priority(b) || a.start - b.start).slice(0, item.cls === 'implementation' ? 3 : 1);
      };
      // Seed (lexical) modules and expanded (import-followed) modules read from SEPARATE budgets, so a large seed/controller
      // file can never consume the space the expanded modules need. Within each group every module gets one range before any gets a second.
      const expandedPaths = new Set(expansion.items.map(item => item.path));
      const implementation = selection.selected.filter(item => item.cls === 'implementation');
      const seedModules = implementation.filter(item => !expandedPaths.has(item.path));
      const expandedModules = implementation.filter(item => expandedPaths.has(item.path));
      const budget = allocateArchitectureBudget(maxChars, expandedModules.length > 0);
      const moduleRanges = (items: RankedEvidence[]) => interleaveModuleRanges(items.map(item => ({ path: item.path, ranges: rangesOf(item) })));
      // Each module's range is capped to its fair share of its group's budget, so the first module cannot take the whole group's space.
      const share = (total: number, count: number) => Math.min(MAX_RANGE_CHARS, Math.max(500, Math.floor(total / Math.max(1, count)) - 60));
      const seedBatch = await this.repoReadBatch(moduleRanges(seedModules), budget.seed, 14, share(budget.seed, seedModules.length));
      const expandedBatch = expandedModules.length > 0 ? await this.repoReadBatch(moduleRanges(expandedModules), budget.expansion, 14, share(budget.expansion, expandedModules.length)) : [];
      const supportBudget = Math.max(0, maxChars - 1_800 - seedBatch.concat(expandedBatch).reduce((sum, item) => sum + item.text.length + item.path.length + 40, 0));
      const supportRanges = selection.selected.filter(item => item.cls !== 'implementation').flatMap(rangesOf);
      const supportBatch = supportBudget >= 400 && supportRanges.length > 0 ? await this.repoReadBatch(supportRanges, supportBudget, 6) : [];
      const batch = [...seedBatch, ...expandedBatch, ...supportBatch];
      const implementationInBatch = [...new Set(batch.filter(item => classifyEvidencePath(item.path) === 'implementation').map(item => item.path))];
      const retrieved = expansion.items.filter(item => implementationInBatch.includes(item.path)).length;
      const verdict = architectureSufficiency(
        { ...selection, implementationSelected: implementationInBatch.length, wrapperOnly: implementationInBatch.length > 0 && implementationInBatch.every(isWrapperEvidencePath) },
        batch.filter(item => classifyEvidencePath(item.path) === 'implementation').length,
        { resolvable: expansion.resolvable, retrieved },
      );
      log.push(`pass ${index + 1} (${pass.label}): ${ranked.length} ranked files, ${implementationInBatch.length}/${selection.implementationCandidates} implementation, ${expansion.items.length} followed from imports/references (${expansion.resolvable} resolvable), ${verdict.reason}`);
      best = { ranked, selection, batch, sufficient: verdict.sufficient, reason: verdict.reason, trail: expansion.trail };
      if (verdict.sufficient) break;
    }
    if (!best || best.ranked.length === 0 || best.batch.length === 0) return undefined;
    if (requireGrounding && best.selection.implementationCandidates === 0 && best.selection.uiOnly) return undefined;
    const workspaceName = path.basename(this.root) || this.root;
    const header = `Repository evidence retrieved by the host from the open workspace "${workspaceName}" (${this.root}) for an ARCHITECTURE_SUBSYSTEM question about "${subsystem.primary.join(', ')}". `
      + 'The host searched file names, workspace symbols and source text across the whole workspace and ranked implementation source ABOVE UI mentions. '
      + 'Explain how it works from the implementation ranges; docs are supporting, and a UI label or chip alone never shows how a subsystem works. '
      + 'Never say you cannot access the repository. ' + WORKSPACE_ACCESS_GUIDANCE;
    const sections = best.batch.map(item => `--- ${item.path}:${item.start}-${item.end} [${item.reason}] ---\n${item.text}`);
    const followed = best.trail.length ? ` Modules the host followed from the selected files' imports/references: ${best.trail.join('; ')}.` : '';
    const footer = `Retrieval: ${log.join('; ')}.${followed}${best.sufficient ? '' : ' The host searched twice; implementation evidence is still thin. State exactly which parts you could verify and which you could not, and do not ask the user to find or paste files.'}`;
    const prompt = [header + this.followUpNote(question), ...sections, footer].join('\n\n');
    const tokens = new Map<string, number>();
    for (const item of best.batch) tokens.set(item.path, (tokens.get(item.path) ?? 0) + Math.ceil(item.text.length / 3.5));
    const files = [...tokens.entries()].slice(0, 24).map(([file, estimatedTokens]) => ({ path: file, estimatedTokens }));
    const result = this.packetResult(prompt, 'architecture', { files, grounded: true, evidenceVerdict: { sufficient: best.sufficient, reason: best.reason } });
    this.lastFiles = files.map(file => file.path);
    return result;
  }

  // ── repo_query ────────────────────────────────────────────────────────────
  async repoQuery(question: string, options: RepoQueryOptions): Promise<RepoQueryResult | undefined> {
    const result = await this.repoQueryCore(question, options);
    if (result && result.type !== 'clarify') this.lastQuestion = question;
    return result;
  }

  /**
   * Adds the files a message refers to without naming them. Order: (1) the user's own filename (kept as is); (2) a file
   * kind ("the html", "the stylesheet") resolved against the active editor, then the workspace; (3) "this/the current/the
   * open file" = the active editor; (4) a short follow-up keeps the conversation's focus file(s). Read-only and bounded.
   */
  private async withImplicitTargets(question: string, plan: RepoQueryPlan, options: RepoQueryOptions, isFactQuestion: boolean): Promise<RepoQueryPlan> {
    if (isFactQuestion || plan.type === 'inventory' || plan.type === 'changes' || plan.fileTargets.some(target => target.strong)) return plan;
    const active = options.activeFile ? normalizePath(options.activeFile) : undefined;
    const add = (paths: readonly string[]): RepoQueryPlan => ({ ...plan, fileTargets: [...plan.fileTargets, ...paths.map(text => ({ text, strong: true }))].slice(0, 4) });
    const kinds = mentionedFileKinds(question);
    if (kinds.length > 0) {
      const found = resolveKindReference(question, await this.listFiles(), active);
      if (found.length > 0) return add(found);
    }
    if (active && /\b(?:this|the current|the open|the active|current|my open)\s+(?:file|page|document|tab|editor|form|screen|script|code)\b|\b(?:open|active) (?:file|editor)\b/i.test(question)) return add([active]);
    if (this.focusFiles.length > 0 && (plan.keywords.length === 0 || await this.focusMentions(plan.keywords)) && plan.type !== 'overview' && plan.type !== 'architecture' && plan.identifiers.length === 0 && !plan.literal) return add(active && this.focusFiles.includes(active) ? [active] : this.focusFiles.slice(0, 2));
    return plan;
  }

  /** A longer follow-up stays on the focus file only when that file itself contains the question's own terms (by stem); a topic switch searches the workspace. */
  private async focusMentions(keywords: readonly string[]): Promise<boolean> {
    const stems = keywords.filter(word => word.length >= 5).map(word => (word.length >= 8 ? word.slice(0, 5) : word.length >= 6 ? word.slice(0, 4) : word));
    if (stems.length === 0) return false;
    for (const rel of this.focusFiles.slice(0, 2)) {
      const text = (await this.readSourceText(rel)).toLowerCase();
      if (stems.some(stem => text.includes(stem))) return true;
    }
    return false;
  }

  private async repoQueryCore(question: string, options: RepoQueryOptions): Promise<RepoQueryResult | undefined> {
    const started = Date.now();
    let plan = planRepoQuery(question);
    const maxChars = Math.max(2_000, options.maxChars);
    // REPOSITORY FACTS: counts, sizes and rankings are computed by the host, never estimated by a model or left to a shell.
    const factPlan = planRepositoryFacts(question);
    // FILE-KIND / ACTIVE-EDITOR / CONVERSATION FOCUS: "check the html", "this file", or a short follow-up resolves to a file
    // the workspace (not a model) can name. Strong filenames in the message always win.
    plan = await this.withImplicitTargets(question, plan, options, Boolean(factPlan));
    // A question about an earlier host-computed answer is answered from the host's record of it, never from guessed introspection.
    if (!factPlan && this.lastFacts && isAnswerIntrospection(question)) {
      Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=facts_introspection kind=${this.lastFacts.kind}`);
      return this.packetResult(renderIntrospectionPacket(this.lastFacts), 'facts', { hostFacts: { kind: this.lastFacts.kind, computing: 'Checking the earlier host result', measured: this.lastFacts.measured, outcome: 'completed' } });
    }
    if (factPlan) {
      const result = await this.answerFactQuery(factPlan, maxChars, question);
      Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=facts kind=${factPlan.kind} outcome=${result.hostFacts?.outcome} returned_chars=${result.prompt.length}`);
      return result;
    }
    // REFERENT SAFETY: "this project" / "that file" resolves only to something this conversation established.
    const referent = await this.resolveReferent(question, plan, options);
    if (referent && 'clarify' in referent) {
      Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=clarify`);
      return referent.clarify;
    }
    if (referent && 'project' in referent) {
      const scoped = await this.scopedProjectResult(referent.project, plan, maxChars);
      if (scoped) {
        Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=scoped_project project=${referent.project.path} files=${scoped.files.length}`);
        return scoped;
      }
    }
    // WORKSPACE_INVENTORY: a deterministic structural plan (directories + project manifests), not a lexical sample.
    if (plan.type === 'inventory') {
      const inventory = await withDeadline(buildWorkspaceInventory(this.root, maxChars, { full: wantsFullInventory(question) }), 3_500, undefined as Awaited<ReturnType<typeof buildWorkspaceInventory>>);
      if (inventory.value) {
        const result: RepoQueryResult = {
          prompt: inventory.value.prompt,
          files: inventory.value.files,
          estimatedTokens: Math.ceil(inventory.value.prompt.length / 3.5),
          packageHash: crypto.createHash('sha256').update(inventory.value.prompt, 'utf8').digest('hex'),
          type: 'inventory',
          grounded: true,
          cacheHit: false,
          explicitFiles: [],
        };
        this.lastFiles = result.files.map(f => f.path);
        Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=inventory projects=${inventory.value.projectCount} folders=${inventory.value.folderCount} returned_chars=${result.prompt.length}`);
        return result;
      }
    }
    // REPOSITORY_OVERVIEW / ARCHITECTURE_SUBSYSTEM: deterministic multi-source plans, never one lexical hit.
    if (plan.type === 'overview' && !plan.fileTargets.some(target => target.strong)) {
      const overview = await withDeadline(this.overviewPack(question, maxChars, options.activeFile), 6_000, undefined as RepoQueryResult | undefined);
      if (overview.value) {
        Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=overview_plan files=${overview.value.files.length} returned_chars=${overview.value.prompt.length}`);
        return overview.value;
      }
    }
    if (plan.type === 'architecture' && !plan.fileTargets.some(target => target.strong)) {
      const architecture = await withDeadline(this.architecturePack(question, plan, maxChars, Boolean(options.requireGrounding)), 9_000, undefined as RepoQueryResult | undefined);
      if (architecture.value) {
        Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=architecture_plan files=${architecture.value.files.length} returned_chars=${architecture.value.prompt.length}`);
        return architecture.value;
      }
    }
    // Preflight for unclassified chat: nothing in the message can possibly match the workspace → no work at all.
    if (options.requireGrounding && plan.type !== 'changes' && plan.fileTargets.length === 0 && plan.identifiers.length === 0 && plan.keywords.length === 0 && !plan.literal) return undefined;

    const dirtyFirst = await withDeadline(this.dirtyFiles(), AUX_BUDGET_MS, [] as string[]);
    const key = await withDeadline(this.cacheKey(`${question}|${maxChars}`, dirtyFirst.value), AUX_BUDGET_MS, undefined as string | undefined);
    if (key.value) {
      const cached = this.cache.get(key.value);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        this.lastFiles = cached.result.files.map(f => f.path);
        Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} cache=hit type=${plan.type} returned_files=${cached.result.files.length} returned_chars=${cached.result.prompt.length}`);
        return { ...cached.result, cacheHit: true };
      }
    }

    // Explicitly named files are read first and directly: no ranking decides whether "readme" is available.
    const explicit = await withDeadline(
      this.readExplicitTargets(plan, Math.floor(maxChars * 0.85)), 2_500,
      { files: [], notes: [] } as Awaited<ReturnType<RepoFastPath['readExplicitTargets']>>,
    ).then(r => r.value);
    const explicitPaths = explicit.files.map(f => f.path);
    if (explicitPaths.length > 0) this.focusFiles = explicitPaths.slice(0, 3);
    const explicitDoc = explicit.files.some(f => /\.(?:md|markdown|rst|txt|adoc)$/i.test(f.path));
    // "check my README" must not grep the repo for the words "check"/"suggest"/"corrections": keyword noise is dropped
    // when a named file already answers the question and nothing more specific (identifier / quoted text) was asked.
    if (explicit.files.length > 0 && plan.identifiers.length === 0 && !plan.literal) plan = { ...plan, keywords: [] };

    // All independent retrieval sources race under their own bounded budget; slow ones are dropped, not awaited.
    const [lexical, symbols, names, seeds] = await Promise.all([
      withDeadline(this.repoSearch(plan), LEXICAL_BUDGET_MS + 200, [] as RepoSearchHit[]),
      withDeadline(this.repoSymbols(plan), SYMBOL_BUDGET_MS, [] as SymbolHit[]),
      withDeadline(this.pathMatches(plan), AUX_BUDGET_MS, [] as string[]),
      plan.type === 'overview' || explicitDoc || (plan.identifiers.length === 0 && plan.keywords.length === 0 && !options.requireGrounding)
        ? withDeadline(this.overviewSeeds(), AUX_BUDGET_MS, { layout: [], files: [] })
        : Promise.resolve({ value: { layout: [] as string[], files: [] as string[] }, ms: 0, timedOut: false }),
    ]);
    const open = this.openFiles();
    const dirty = dirtyFirst.value;
    const hot = [...new Set([...(options.hotFiles ?? []), ...this.lastFiles])].map(normalizePath);

    // Lexical ranking: distinct matched terms, then hit count; tests and docs sink below source.
    const perFile = new Map<string, { hits: RepoSearchHit[]; terms: Set<string> }>();
    for (const hit of lexical.value) {
      const entry = perFile.get(hit.path) ?? { hits: [], terms: new Set<string>() };
      entry.hits.push(hit);
      for (const term of [...plan.identifiers, ...plan.keywords, ...(plan.literal ? [plan.literal] : [])]) {
        if (hit.excerpt.toLowerCase().includes(term.toLowerCase())) entry.terms.add(term);
      }
      perFile.set(hit.path, entry);
    }
    const weight = (file: string) => {
      const entry = perFile.get(file)!;
      const identifierHits = [...entry.terms].filter(t => plan.identifiers.includes(t)).length;
      return entry.terms.size + identifierHits * 2 + Math.min(entry.hits.length, 4) * 0.25 - (isTestPath(file) ? 1.5 : 0) - (/\.(?:md|txt|json)$/i.test(file) ? 0.75 : 0);
    };
    const lexicalRank = [...perFile.keys()].sort((a, b) => weight(b) - weight(a));
    const symbolRank = [...new Set(symbols.value.map(s => s.path))];
    const pathRank = names.value.sort((a, b) => Number(isTestPath(a)) - Number(isTestPath(b)) || a.length - b.length);
    const lists: string[][] = [lexicalRank, symbolRank, pathRank];
    if (plan.type === 'changes') lists.unshift(dirty, dirty);
    else lists.push(dirty);
    const graphList = this.graphRank(plan);
    if (graphList.length > 0) lists.push(graphList);
    if (plan.type === 'overview' || seeds.value.files.length) lists.unshift(seeds.value.files, seeds.value.files);
    lists.push(open, hot);

    if (!options.requireGrounding && explicit.files.length === 0 && lists.every(list => list.length === 0) && seeds.value.files.length === 0) {
      // Nothing matched the question at all: fall back to the structural overview rather than returning nothing.
      const fallback = (await withDeadline(this.overviewSeeds(), AUX_BUDGET_MS, { layout: [], files: [] })).value;
      seeds.value.files = fallback.files;
      seeds.value.layout = fallback.layout;
      lists.unshift(fallback.files);
    }
    let fused = fuseRanks(lists);
    // Same-directory neighbours of the three strongest results get a small deterministic lift.
    const topDirs = new Set(fused.slice(0, 3).map(item => path.posix.dirname(item.path)));
    fused = fused.map(item => topDirs.has(path.posix.dirname(item.path)) && !fused.slice(0, 3).includes(item)
      ? { ...item, score: item.score + 1 / (RRF_K + 12) } : item).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const candidateCount = fused.length;
    const top = fused.map(item => item.path).filter(file => !explicitPaths.includes(file)).slice(0, MAX_FILES - explicitPaths.length);

    // Nearby tests for the two best source files (Git index lookup, one call).
    let nearbyTests: string[] = [];
    if (plan.type !== 'overview' && plan.type !== 'changes' && (await this.git())) {
      const specs = top.slice(0, 2).filter(f => !isTestPath(f)).map(f => path.posix.parse(f).name)
        .flatMap(name => [`:(icase,glob)**/${name}.test.*`, `:(icase,glob)**/${name}.spec.*`, `:(icase,glob)**/test_${name}.*`, `:(icase,glob)**/${name}_test.*`]);
      if (specs.length) nearbyTests = (await withDeadline(runGit(this.root, ['ls-files', '--', ...specs], AUX_BUDGET_MS, 64 * 1024), AUX_BUDGET_MS, { stdout: '', ok: false, truncated: false })).value
        .stdout.split(/\r?\n/).filter(Boolean).map(normalizePath).slice(0, 1);
    }

    // Ranges per file: symbol bodies, lexical hit windows, or a bounded head for structural/hot files.
    const reasonOf = (file: string) => [
      perFile.has(file) ? 'lexical' : '', symbolRank.includes(file) ? 'symbol' : '', names.value.includes(file) ? 'path' : '',
      open.includes(file) ? 'open' : '', dirty.includes(file) ? 'dirty' : '', hot.includes(file) ? 'hot' : '', seeds.value.files.includes(file) ? 'structure' : '',
    ].filter(Boolean).join('+') || 'ranked';
    const ranges: RepoRange[] = [];
    for (const file of [...top, ...nearbyTests]) {
      const reason = reasonOf(file);
      const own: RepoRange[] = [];
      for (const sym of symbols.value.filter(s => s.path === file).slice(0, 2)) {
        own.push({ path: file, start: Math.max(1, sym.line - 2), end: sym.line + 45, reason: 'symbol' });
      }
      for (const hit of (perFile.get(file)?.hits ?? []).slice(0, 3)) {
        own.push({ path: file, start: Math.max(1, hit.line - CONTEXT_LINES), end: hit.line + CONTEXT_LINES, reason: 'lexical' });
      }
      if (own.length === 0) {
        const isReadme = /^readme/i.test(path.posix.basename(file));
        own.push({ path: file, start: 1, end: isReadme ? 110 : /manifest|package\.json|pyproject|cargo|go\.mod|pom\.xml/i.test(file) ? 60 : 50, reason });
      }
      ranges.push(...mergeRanges(own).slice(0, 2).map(r => ({ ...r, reason: r.reason === 'lexical' || r.reason === 'symbol' ? `${r.reason}; ${reason}` : r.reason })));
    }

    // Changes intent: a bounded diff summary instead of source windows.
    const diffText = plan.type === 'changes' ? await this.diffSummary(maxChars) : '';

    const readStarted = Date.now();
    const explicitChars = explicit.files.reduce((sum, f) => sum + f.text.length + f.path.length + 60, 0)
      + explicit.notes.reduce((sum, n) => sum + n.length + 4, 0);
    // Verification evidence is secondary to the named file: a README audit gets a compact inventory plus only a few
    // manifests / entry files, never more than a fixed slice of the packet.
    const explicitReadme = explicit.files.some(f => /^readme/i.test(path.posix.basename(f.path)));
    const inventoryEvidence = explicitReadme
      ? (await withDeadline(buildWorkspaceInventory(this.root, 2_500, { evidenceOnly: true }), 1_500, undefined as Awaited<ReturnType<typeof buildWorkspaceInventory>>)).value
      : undefined;
    const inventoryChars = inventoryEvidence ? inventoryEvidence.prompt.length + 80 : 0;
    const verificationCap = explicit.files.length > 0 ? 10_000 : Number.POSITIVE_INFINITY;
    const readBudget = Math.min(verificationCap, Math.max(1_500, maxChars - diffText.length - explicitChars - inventoryChars - 800));
    const batch = await this.repoReadBatch(ranges, readBudget);
    const batchMs = Date.now() - readStarted;

    const grounded = explicit.files.length > 0 || lexical.value.length > 0 || symbols.value.length > 0 || dirty.length > 0 && plan.type === 'changes';
    if (options.requireGrounding && !grounded && explicit.notes.length === 0) {
      Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=${plan.type} preflight=ungrounded`);
      return undefined;
    }
    if (batch.length === 0 && !diffText && explicit.files.length === 0 && explicit.notes.length === 0) {
      Logger.info(`[RepoQuery] repo_query_total_ms=${Date.now() - started} type=${plan.type} candidate_files=${candidateCount} returned_ranges=0 empty=true`);
      return undefined;
    }

    const workspaceName = path.basename(this.root) || this.root;
    const header = `Repository evidence retrieved by the host from the open workspace "${workspaceName}" (${this.root}) for this question (query type: ${plan.type}). `
      + 'The workspace IS open and the host has read the content below for you. '
      + (explicit.files.length ? 'Files marked [full file] are complete. ' : '')
      + 'Never say you cannot access the repository and never ask the user to paste a file that appears here. '
      + WORKSPACE_ACCESS_GUIDANCE + ' '
      + 'Answer from this evidence; if it is insufficient, say what is missing rather than guessing.';
    const layout = seeds.value.layout.length ? `\nTop-level layout: ${seeds.value.layout.join(', ')}` : '';
    const explicitSections = explicit.files.map(f => `--- ${f.path} [${f.mode === 'full' ? `full file, ${f.lines} lines` : `large file, structured excerpt of ${f.lines} lines`}; named by the user] ---\n${f.text}`);
    const infoSection = explicit.infos?.length ? [`--- linked assets of the named page ---\n${explicit.infos.join('\n')}`] : [];
    const noteSection = explicit.notes.length ? [`--- host read problems ---\n${explicit.notes.join('\n')}\nReport exactly this to the user; do not ask them to paste the file unless the problem is genuinely unrecoverable.`] : [];
    const inventorySection = inventoryEvidence ? [`--- compact workspace/project inventory (to verify claims in the named file) ---\n${inventoryEvidence.prompt}`] : [];
    const sections = batch.map(item => `--- ${item.path}:${item.start}-${item.end} [${item.reason}] ---\n${item.text}`);
    const prompt = [header + layout, ...explicitSections, ...infoSection, ...noteSection, ...inventorySection, ...(diffText ? [`--- git diff (working tree vs HEAD) ---\n${diffText}`] : []), ...sections].join('\n\n');
    const fileTokens = new Map<string, number>();
    for (const f of explicit.files) fileTokens.set(f.path, Math.ceil(f.text.length / 3.5));
    for (const item of batch) fileTokens.set(item.path, (fileTokens.get(item.path) ?? 0) + Math.ceil(item.text.length / 3.5));
    const files = [...fileTokens.entries()].slice(0, 24).map(([file, estimatedTokens]) => ({ path: file, estimatedTokens }));
    const result: RepoQueryResult = {
      prompt,
      files,
      estimatedTokens: Math.ceil(prompt.length / 3.5),
      packageHash: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
      type: plan.type,
      grounded,
      cacheHit: false,
      explicitFiles: explicitPaths,
    };
    this.lastFiles = files.map(f => f.path);
    if (key.value) {
      if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key.value, { at: Date.now(), result });
    }
    Logger.info(
      `[RepoQuery] repo_query_total_ms=${Date.now() - started} lexical_ms=${lexical.ms}${lexical.timedOut ? '(timeout)' : ''} symbols_ms=${symbols.ms}${symbols.timedOut ? '(timeout)' : ''} `
      + `batch_read_ms=${batchMs} candidate_files=${candidateCount} returned_ranges=${batch.length} returned_chars=${prompt.length} type=${plan.type} grounded=${grounded} cache=miss`,
    );
    return result;
  }
}
