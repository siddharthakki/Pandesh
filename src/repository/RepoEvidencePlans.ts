import * as path from 'path';

/**
 * Deterministic query plans for broad repository questions. Pure: no VS Code, no filesystem, no model.
 *
 *   REPOSITORY_OVERVIEW      "what does this project do" → README + manifests + workspace tree + entrypoints (+ docs as support)
 *   ARCHITECTURE_SUBSYSTEM   "how does governance work"  → implementation source ranked ABOVE UI mentions, docs only as support
 *
 * A broad question is never "grounded" by one lexical hit: each plan has an evidence-sufficiency rule, and the host
 * performs another bounded retrieval pass itself when the first packet fails it.
 */

/** Guidance carried by every repository evidence packet. */
export const WORKSPACE_ACCESS_GUIDANCE = 'When repository access is available, never ask the user to paste or pull a repository file that the host can search/read. '
  + 'If the evidence is insufficient, say precisely what the host searched and what is missing; further retrieval is the host\'s job, not the user\'s.';

// ── Question classification ─────────────────────────────────────────────────

const PROJECT_NOUN = '(?:project|repo|repository|codebase|code\\s?base|app|application|extension|workspace|tool|product|system|library|package)';

export function isRepositoryOverviewQuestion(question: string): boolean {
  const q = String(question ?? '');
  const patterns = [
    new RegExp(`\\bwhat\\s+(?:does|do)\\s+(?:this|the|my|our)\\s+${PROJECT_NOUN}\\b`, 'i'),
    new RegExp(`\\bwhat(?:\\s+is|'s)\\s+(?:this|the|my|our)\\s+${PROJECT_NOUN}\\b`, 'i'),
    new RegExp(`\\b(?:explain|summari[sz]e|describe|walk\\s+me\\s+through|tell\\s+me\\s+about|give\\s+me\\s+(?:a|an)\\s+(?:overview|summary)\\s+of)\\s+(?:this|the|my|our)\\s+${PROJECT_NOUN}\\b`, 'i'),
    new RegExp(`\\bhow\\s+is\\s+(?:this|the|my|our)\\s+${PROJECT_NOUN}\\s+(?:structured|organi[sz]ed|laid\\s+out|put\\s+together|built|architected)\\b`, 'i'),
    new RegExp(`\\bhow\\s+does\\s+(?:this|the|my|our)\\s+${PROJECT_NOUN}\\s+work\\b`, 'i'),
    /\bgive\s+me\s+an?\s+(?:high[- ]level\s+)?(?:overview|summary)\b/i,
    new RegExp(`\\b(?:project|repo(?:sitory)?|codebase)\\s+(?:overview|summary)\\b`, 'i'),
  ];
  return patterns.some(pattern => pattern.test(q));
}

const SUBSYSTEM_SHAPES: RegExp[] = [
  /\bhow\s+(?:does|do|did|is|are|can)\b[^?.!]{1,90}?\b(?:work|works|operate|operates|function|functions|implemented|handled|enforced|decided|wired|designed|organi[sz]ed|structured)\b/i,
  /\bexplain\b[^?.!]{0,40}\b(?:state\s+machine|lifecycle|pipeline|workflow|flow|mechanism|subsystem|architecture\s+of|design\s+of)\b/i,
  /\b(?:where|how)\s+(?:is|are|does|do)\b[^?.!]{1,80}?\b(?:implemented|handled|enforced|defined|decided)\b/i,
  /\b(?:state\s+machine|lifecycle|pipeline|mechanism)\s+(?:of|for|behind)\b/i,
];

const GENERIC_TERMS = new Set(('how does do did is are can the our this that these those here there work works working operate operates function functions '
  + 'implemented handled enforced decided wired designed organized organised structured explain describe walk through tell about please detail details '
  + 'project repo repository codebase code base app application extension workspace tool product system thing things happen happens exactly '
  + 'what when where which who why with from into onto and for not but you your mine its it in on of to a an be been being get gets use used using').split(' '));

/** Does the message ask how some subsystem of the repository works (as opposed to what the whole repository is)? */
export function isArchitectureSubsystemQuestion(question: string): boolean {
  const q = String(question ?? '');
  if (!SUBSYSTEM_SHAPES.some(pattern => pattern.test(q))) return false;
  return deriveSubsystemTerms(q).primary.length > 0;
}

// Generic software concepts only; nothing here names a file or a product.
const CONCEPT_EXPANSIONS: Record<string, string[]> = {
  governance: ['policy', 'approval', 'permission', 'attempt', 'gate', 'validation', 'execution', 'state'],
  governed: ['policy', 'approval', 'permission', 'attempt', 'gate', 'validation', 'execution', 'state'],
  approval: ['approve', 'policy', 'permission', 'consent', 'grant', 'gate'],
  approvals: ['approve', 'policy', 'permission', 'consent', 'grant', 'gate'],
  permission: ['policy', 'authorize', 'grant', 'allow', 'deny', 'scope', 'role'],
  permissions: ['policy', 'authorize', 'grant', 'allow', 'deny', 'scope', 'role'],
  policy: ['rule', 'permission', 'allow', 'deny', 'gate', 'approval'],
  routing: ['route', 'router', 'select', 'dispatch', 'resolve', 'choose'],
  router: ['route', 'select', 'dispatch', 'resolve'],
  persistence: ['persist', 'store', 'storage', 'database', 'repository', 'save', 'restore', 'schema', 'migration'],
  storage: ['persist', 'store', 'database', 'save', 'restore'],
  persist: ['store', 'storage', 'database', 'save', 'restore', 'localstorage'],
  save: ['persist', 'store', 'storage', 'write', 'commit'],
  validate: ['validator', 'verify', 'check', 'assert', 'schema', 'required'],
  validation: ['validate', 'validator', 'verify', 'check', 'assert', 'schema', 'constraint'],
  state: ['transition', 'machine', 'status', 'phase', 'reducer'],
  machine: ['state', 'transition', 'status', 'phase'],
  authentication: ['auth', 'login', 'token', 'session', 'credential'],
  auth: ['login', 'token', 'session', 'credential', 'authorize'],
  caching: ['cache', 'ttl', 'evict', 'memo'],
  logging: ['logger', 'log', 'telemetry', 'trace'],
  scheduling: ['scheduler', 'queue', 'cron', 'job', 'timer'],
  security: ['auth', 'sanitize', 'permission', 'policy', 'secret'],
  configuration: ['config', 'setting', 'option', 'environment'],
  settings: ['config', 'option', 'preference'],
  recovery: ['recover', 'retry', 'resume', 'restore', 'checkpoint'],
  context: ['budget', 'window', 'prompt', 'package', 'compose'],
  planning: ['plan', 'planner', 'step', 'task', 'orchestrat'],
};

const STEM_SUFFIXES = ['ations', 'ation', 'ances', 'ance', 'ences', 'ence', 'ments', 'ment', 'ings', 'ing', 'ers', 'er', 'ors', 'or', 'ions', 'ion', 'ies', 'ied', 'ed', 'es', 'al', 's'];

/** "governance" → "govern" so that governed / governor / governance all match one literal term. Never shorter than 4 characters. */
export function stemTerm(term: string): string {
  const t = term.toLowerCase();
  for (const suffix of STEM_SUFFIXES) {
    if (t.endsWith(suffix) && t.length - suffix.length >= 4) return t.slice(0, -suffix.length);
  }
  return t;
}

function subjectPhrase(q: string): string {
  const shapes: RegExp[] = [
    /\bhow\s+(?:does|do|did|is|are|can)\s+(?:the\s+|our\s+|this\s+|my\s+)?(.+?)\s+(?:work|works|operate|operates|function|functions|get|gets|is|are|implemented|handled|enforced|decided|wired|designed)\b/i,
    /\b(?:where|how)\s+(?:is|are|does|do)\s+(?:the\s+|our\s+)?(.+?)\s+(?:implemented|handled|enforced|defined|decided)\b/i,
    /\bexplain\s+(?:how\s+)?(?:the\s+|our\s+)?(.+?)(?:\s+(?:works?|here|in\s+this\b.*))?[?.!]*$/i,
    /\b(?:state\s+machine|lifecycle|pipeline|mechanism)\s+(?:of|for|behind)\s+(?:the\s+)?(.+?)[?.!]*$/i,
  ];
  for (const shape of shapes) {
    const match = shape.exec(q);
    if (match?.[1]) return match[1];
  }
  return q;
}

export interface SubsystemTerms {
  /** What the user is asking about (original word + stem), strongest signal. */
  primary: string[];
  /** Generic related concepts, used only when the primary pass is insufficient. */
  expanded: string[];
}

export function deriveSubsystemTerms(question: string): SubsystemTerms {
  const q = String(question ?? '');
  const words = (subjectPhrase(q).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter(word => !GENERIC_TERMS.has(word));
  const primary: string[] = [];
  for (const word of [...new Set(words)].slice(0, 5)) {
    const stem = stemTerm(word);
    if (stem.length >= 4) primary.push(stem);
    else if (word.length >= 4) primary.push(word);
  }
  const uniquePrimary = [...new Set(primary)];
  const expanded: string[] = [];
  for (const word of [...new Set(words)]) {
    for (const related of CONCEPT_EXPANSIONS[word] ?? CONCEPT_EXPANSIONS[stemTerm(word)] ?? []) {
      const term = related.length >= 6 && stemTerm(related).length >= 4 ? stemTerm(related) : related;
      if (!uniquePrimary.includes(term) && !expanded.includes(term)) expanded.push(term);
    }
  }
  return { primary: uniquePrimary, expanded: expanded.slice(0, 10) };
}

// ── Evidence classes ────────────────────────────────────────────────────────

export type EvidenceClass = 'implementation' | 'ui' | 'docs' | 'test' | 'config' | 'other';

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|c|cc|cpp|h|hpp|rb|php|swift|scala|lua|sh|ps1)$/i;
const UI_EXT = /\.(?:html?|css|scss|sass|less|svg|vue|svelte)$/i;
const UI_DIR = /(?:^|\/)(?:media|public|static|assets|webview|webviews|templates|styles|stylesheets|wwwroot)\//i;
const DOC_EXT = /\.(?:md|markdown|rst|txt|adoc)$/i;
const CONFIG_EXT = /\.(?:json|ya?ml|toml|ini|cfg|lock|env)$/i;

export function isTestEvidencePath(p: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|spec|specs)\//i.test(p) || /\.(?:test|spec)\.[a-z]+$|(?:^|\/)test_[^/]+$|_test\.[a-z]+$/i.test(p);
}

export function classifyEvidencePath(p: string): EvidenceClass {
  const file = p.replace(/\\/g, '/');
  if (isTestEvidencePath(file)) return 'test';
  if (DOC_EXT.test(file)) return 'docs';
  if (UI_EXT.test(file) || UI_DIR.test(file)) return 'ui';
  if (CONFIG_EXT.test(file)) return 'config';
  if (SOURCE_EXT.test(file)) return 'implementation';
  return 'other';
}

const CLASS_WEIGHT: Record<EvidenceClass, number> = { implementation: 1, config: 0.4, test: 0.35, docs: 0.5, ui: 0.2, other: 0.4 };

export interface ArchitectureHit { path: string; line: number; excerpt: string }
export interface ArchitectureRankInput {
  primary: readonly string[];
  expanded: readonly string[];
  hits: readonly ArchitectureHit[];
  /** Workspace-symbol definitions of the primary terms. */
  symbolPaths: ReadonlyArray<{ path: string; line: number; name: string }>;
  pathMatches: readonly string[];
}
export interface RankedEvidence {
  path: string;
  cls: EvidenceClass;
  score: number;
  /** Lines worth reading, definition lines first. */
  lines: number[];
  /** Why the file ranked ("name", "definition", "lexical", "symbol"). */
  reasons: string[];
}

const DEFINITION_LINE = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|def|fn|struct|trait|impl|public|private|protected|static|func)\b/;

/** Ranks files for an ARCHITECTURE_SUBSYSTEM question. A UI label can never outrank implementation source. */
export function rankArchitectureEvidence(input: ArchitectureRankInput): RankedEvidence[] {
  const files = new Map<string, { terms: Set<string>; expandedTerms: Set<string>; hits: number; defHits: number; lines: Array<{ line: number; def: boolean }>; nameScore: number; symbolScore: number; reasons: Set<string> }>();
  const entry = (p: string) => {
    let value = files.get(p);
    if (!value) {
      value = { terms: new Set(), expandedTerms: new Set(), hits: 0, defHits: 0, lines: [], nameScore: 0, symbolScore: 0, reasons: new Set() };
      files.set(p, value);
    }
    return value;
  };
  for (const hit of input.hits) {
    const e = entry(hit.path);
    const lowered = hit.excerpt.toLowerCase();
    const isDef = DEFINITION_LINE.test(hit.excerpt);
    let matched = false;
    for (const term of input.primary) if (lowered.includes(term)) { e.terms.add(term); matched = true; }
    for (const term of input.expanded) if (lowered.includes(term)) { e.expandedTerms.add(term); matched = true; }
    if (!matched) continue;
    e.hits += 1;
    if (isDef) e.defHits += 1;
    e.lines.push({ line: hit.line, def: isDef });
    e.reasons.add(isDef ? 'definition' : 'lexical');
  }
  for (const p of input.pathMatches) {
    const e = entry(p);
    const base = path.posix.basename(p).toLowerCase();
    const dirs = path.posix.dirname(p).toLowerCase();
    for (const term of input.primary) {
      if (base.includes(term)) { e.nameScore += 4; e.reasons.add('name'); } else if (dirs.includes(term)) { e.nameScore += 1.5; e.reasons.add('path'); }
    }
    for (const term of input.expanded) if (base.includes(term)) { e.nameScore += 1.5; e.reasons.add('name'); }
  }
  for (const symbol of input.symbolPaths) {
    const e = entry(symbol.path);
    if (e.symbolScore < 6) e.symbolScore += 3;
    e.lines.push({ line: symbol.line, def: true });
    e.reasons.add('symbol');
  }
  const ranked: RankedEvidence[] = [];
  for (const [file, e] of files) {
    const cls = classifyEvidencePath(file);
    const raw = e.terms.size * 3 + e.expandedTerms.size + Math.min(e.defHits, 3) * 2 + Math.min(e.hits, 6) * 0.3 + e.nameScore + e.symbolScore;
    if (raw <= 0) continue;
    const ordered = [...e.lines].sort((a, b) => Number(b.def) - Number(a.def) || a.line - b.line).map(item => item.line);
    ranked.push({ path: file, cls, score: Math.round(raw * CLASS_WEIGHT[cls] * 1000) / 1000, lines: [...new Set(ordered)].slice(0, 6), reasons: [...e.reasons] });
  }
  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export interface ArchitectureSelection {
  selected: RankedEvidence[];
  implementationCandidates: number;
  implementationSelected: number;
  uiOnly: boolean;
  /** Every selected implementation file is a UI/demo/controller/entry wrapper (see isWrapperEvidencePath). */
  wrapperOnly: boolean;
}

/**
 * Implementation first (up to five), then at most two docs and one test as support, and a UI file only as the last tier.
 * `extraImplementation` are files the host reached by following imports/references from the ranked ones; they are
 * implementation evidence too and are kept even when the lexical top five were all taken.
 */
export function selectArchitectureEvidence(
  ranked: readonly RankedEvidence[],
  limits = { implementation: 5, docs: 2, test: 1, ui: 1, config: 1 },
  extraImplementation: readonly RankedEvidence[] = [],
): ArchitectureSelection {
  const take = (cls: EvidenceClass, count: number) => ranked.filter(item => item.cls === cls).slice(0, count);
  const lexical = take('implementation', limits.implementation);
  const known = new Set(lexical.map(item => item.path));
  const extras = extraImplementation.filter(item => !known.has(item.path));
  const implementation = [...lexical, ...extras];
  const rankedPaths = new Set(ranked.filter(item => item.cls === 'implementation').map(item => item.path));
  const implementationCandidates = rankedPaths.size + extras.filter(item => !rankedPaths.has(item.path)).length;
  const selected = [
    ...implementation,
    ...take('config', implementation.length < 2 ? limits.config : 0),
    ...take('docs', limits.docs),
    ...take('test', implementation.length < 2 ? limits.test + 1 : limits.test),
    ...take('ui', implementation.length === 0 ? limits.ui + 1 : limits.ui),
    ...take('other', 1),
  ];
  return {
    selected, implementationCandidates, implementationSelected: implementation.length,
    uiOnly: implementationCandidates === 0 && ranked.some(item => item.cls === 'ui'),
    wrapperOnly: implementation.length > 0 && implementation.every(item => isWrapperEvidencePath(item.path)),
  };
}

export interface Sufficiency { sufficient: boolean; reason: string }

/** What import/reference expansion found: implementation modules the host could resolve in the workspace, and how many reached the packet. */
export interface ExpansionState { resolvable: number; retrieved: number }

/**
 * ARCHITECTURE_SUBSYSTEM: when implementation matches exist, several implementation files are required; one UI label is
 * never sufficient evidence of HOW a subsystem works. One implementation file is not enough while resolvable
 * implementation targets (imports/references of the selected files) remain unretrieved, and a wrapper (demo/controller/UI)
 * never stands in for the modules it imports.
 */
export function architectureSufficiency(selection: ArchitectureSelection, implementationRanges: number, expansion?: ExpansionState): Sufficiency {
  if (selection.implementationCandidates === 0) {
    return { sufficient: false, reason: selection.uiOnly ? 'only UI mentions matched; no implementation source found yet' : 'no implementation source matched yet' };
  }
  const pending = expansion ? Math.max(0, expansion.resolvable - expansion.retrieved) : 0;
  const needFiles = Math.min(2, selection.implementationCandidates + pending);
  if (selection.implementationSelected < needFiles) {
    return { sufficient: false, reason: pending > 0
      ? `needs ${needFiles} implementation files, have ${selection.implementationSelected}; ${pending} resolvable implementation target${pending === 1 ? '' : 's'} not retrieved`
      : `needs ${needFiles} implementation files, have ${selection.implementationSelected}` };
  }
  if (pending > 0 && selection.wrapperOnly) {
    return { sufficient: false, reason: `only a wrapper (UI/demo/controller) was retrieved; ${pending} imported implementation target${pending === 1 ? '' : 's'} not retrieved` };
  }
  const needRanges = Math.min(3, selection.implementationCandidates * 2);
  if (implementationRanges < needRanges) return { sufficient: false, reason: `needs ${needRanges} implementation ranges, have ${implementationRanges}` };
  return { sufficient: true, reason: 'implementation source evidence present' };
}

// ── Import / reference expansion (pure) ─────────────────────────────────────

/** A file whose job is to host, present or start a subsystem rather than implement it. */
export function isWrapperEvidencePath(p: string): boolean {
  const file = p.replace(/\\/g, '/');
  const stem = path.posix.parse(file).name;
  if (/^(?:extension|main|index|app|activate|bootstrap)$/i.test(stem)) return true;
  if (/(?:demo|controller|panel|view|webview|page|screen|widget|launcher|activation|bootstrap)$/i.test(stem)) return true;
  return /(?:^|\/)(?:ui|views?|webviews?|pages|screens|demo|demos|examples?)\//i.test(file);
}

const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const PY_RELATIVE_IMPORT = /^[ \t]*from\s+(\.+)([\w.]*)\s+import\b/gm;
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php'];

/** Workspace-local import specifiers (relative only; packages are not workspace files). */
export function parseLocalImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) if (match[1].startsWith('.')) specs.push(match[1]);
  }
  for (const match of source.matchAll(PY_RELATIVE_IMPORT)) {
    const up = match[1].length - 1;
    specs.push(`${up === 0 ? './' : '../'.repeat(up)}${match[2].replace(/\./g, '/')}`);
  }
  return [...new Set(specs)];
}

/** Resolves a relative specifier against the workspace file set (extension-less, `.js`→`.ts`, and `/index` forms). */
export function resolveLocalImport(fromPath: string, spec: string, files: ReadonlySet<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath.replace(/\\/g, '/')), spec));
  if (base.startsWith('..')) return undefined;
  const trimmed = base.replace(/\.(?:c|m)?jsx?$/i, '');
  const candidates = [base, ...RESOLVE_EXTS.map(ext => `${trimmed}${ext}`), ...RESOLVE_EXTS.map(ext => `${base}/index${ext}`), `${base}/__init__.py`];
  return candidates.find(candidate => files.has(candidate) && SOURCE_EXT.test(candidate));
}

const GENERIC_STEMS = new Set(['index', 'types', 'type', 'utils', 'util', 'constants', 'helpers', 'config', 'common', 'shared', 'main', 'test']);

/** lower-case file stem → implementation paths, for resolving symbol references (a class named like its file) without an LSP. */
export function buildImplementationStemIndex(files: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    if (classifyEvidencePath(file) !== 'implementation') continue;
    const stem = path.posix.parse(file).name.toLowerCase();
    if (stem.length < 6 || GENERIC_STEMS.has(stem)) continue;
    const list = index.get(stem) ?? [];
    if (list.length < 3) list.push(file);
    index.set(stem, list);
  }
  return index;
}

export interface ExpansionTarget { path: string; via: 'import' | 'reference' }

/** Implementation files a source file imports (resolved) or names as a symbol (identifier equals a workspace file stem). Imports first, in source order. */
export function findExpansionTargets(fromPath: string, source: string, files: ReadonlySet<string>, stemIndex: ReadonlyMap<string, string[]>): ExpansionTarget[] {
  const self = fromPath.replace(/\\/g, '/');
  const out: ExpansionTarget[] = [];
  const seen = new Set<string>([self]);
  const add = (target: string | undefined, via: ExpansionTarget['via']) => {
    if (!target || seen.has(target) || classifyEvidencePath(target) !== 'implementation') return;
    seen.add(target);
    out.push({ path: target, via });
  };
  for (const spec of parseLocalImportSpecifiers(source)) add(resolveLocalImport(self, spec, files), 'import');
  const identifiers = new Set((source.match(/\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g) ?? []).map(word => word.toLowerCase()));
  for (const word of identifiers) for (const target of stemIndex.get(word) ?? []) add(target, 'reference');
  return out;
}

/** How a resolved target was reached, strongest first. `import-subsystem` = an exact relative import whose name or source matches the subsystem terms. */
export type ExpansionTier = 'import-subsystem' | 'import' | 'subsystem-name' | 'reference';
const TIER_RANK: Record<ExpansionTier, number> = { 'import-subsystem': 0, import: 1, 'subsystem-name': 2, reference: 3 };

export interface PrioritizedTarget { path: string; via: 'import' | 'reference'; from: string; tier: ExpansionTier; score: number }

/**
 * Orders and bounds resolved expansion targets: exact relative imports first, then same-subsystem filename matches,
 * and loose references (an identifier that merely equals a workspace file stem) only as a fallback when the direct
 * imports did not fill the allowance. Returns at most `limit` targets; never the whole candidate cloud.
 */
export function prioritizeExpansionTargets(
  candidates: ReadonlyArray<{ path: string; via: 'import' | 'reference'; from: string; score: number; matched: boolean }>,
  terms: { primary: readonly string[]; expanded: readonly string[] },
  limit: number,
  alreadyCovered = 0,
): PrioritizedTarget[] {
  const tiered: PrioritizedTarget[] = candidates.map(candidate => {
    const base = path.posix.basename(candidate.path).toLowerCase();
    const nameMatch = [...terms.primary, ...terms.expanded].some(term => base.includes(term));
    const tier: ExpansionTier = candidate.via === 'import' ? (candidate.matched ? 'import-subsystem' : 'import') : nameMatch ? 'subsystem-name' : 'reference';
    return { path: candidate.path, via: candidate.via, from: candidate.from, tier, score: candidate.score };
  });
  const order = new Map(candidates.map((candidate, index) => [candidate.path, index]));
  tiered.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score
    || Number(isWrapperEvidencePath(a.path)) - Number(isWrapperEvidencePath(b.path)) || (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  const direct = tiered.filter(item => item.via === 'import');
  // Loose references only top up what direct imports left unfilled, and only subsystem-named ones before arbitrary ones.
  // Direct imports that are already in the packet (read as lexical seeds) count toward the allowance too.
  const topUp = tiered.filter(item => item.via === 'reference').slice(0, Math.max(0, limit - direct.length - alreadyCovered));
  return [...direct, ...topUp].slice(0, Math.max(0, limit));
}

/** Splits the packet character budget so expanded modules can never be starved by the seed file(s). */
export function allocateArchitectureBudget(maxChars: number, hasExpansion: boolean): { seed: number; expansion: number } {
  const usable = Math.max(1_500, maxChars - 1_800);
  if (!hasExpansion) return { seed: usable, expansion: 0 };
  const expansion = Math.max(900, Math.floor(usable * 0.55));
  return { seed: Math.max(600, usable - expansion), expansion };
}

export interface ModuleRanges<R> { path: string; ranges: R[] }

/** Round-robin: every module's first range, then every module's second, and so on. A module never gets a second range before all have one. */
export function interleaveModuleRanges<R>(modules: ReadonlyArray<ModuleRanges<R>>): R[] {
  const out: R[] = [];
  const depth = Math.max(0, ...modules.map(module => module.ranges.length));
  for (let level = 0; level < depth; level++) for (const module of modules) if (module.ranges[level]) out.push(module.ranges[level]);
  return out;
}

export interface ExpansionScore { score: number; matched: boolean }

/** How strongly an imported module's NAME and CONTENT match the subsystem terms. Used to order, never to exclude. */
export function scoreExpansionTarget(targetPath: string, source: string, terms: { primary: readonly string[]; expanded: readonly string[] }): ExpansionScore {
  const base = path.posix.basename(targetPath).toLowerCase();
  const text = source.toLowerCase();
  let score = 0;
  for (const term of terms.primary) {
    if (base.includes(term)) score += 4;
    if (text.includes(term)) score += 3;
  }
  for (const term of terms.expanded) {
    if (base.includes(term)) score += 1.5;
    if (text.includes(term)) score += 1;
  }
  if (isWrapperEvidencePath(targetPath)) score *= 0.6;
  return { score: Math.round(score * 1000) / 1000, matched: score > 0 };
}

/** Lines worth reading in an expanded module: definitions that mention the subsystem, then other term lines, then the first definitions. */
export function pickExpansionLines(source: string, terms: { primary: readonly string[]; expanded: readonly string[] }, max = 4): number[] {
  const lines = source.split(/\r?\n/);
  const all = [...terms.primary, ...terms.expanded];
  const picked: number[] = [];
  const push = (n: number) => { if (!picked.includes(n) && picked.length < max) picked.push(n); };
  lines.forEach((line, i) => { if (DEFINITION_LINE.test(line) && all.some(term => line.toLowerCase().includes(term))) push(i + 1); });
  lines.forEach((line, i) => { if (terms.primary.some(term => line.toLowerCase().includes(term))) push(i + 1); });
  lines.forEach((line, i) => { if (/^\s*export\b/.test(line) && DEFINITION_LINE.test(line)) push(i + 1); });
  lines.forEach((line, i) => { if (DEFINITION_LINE.test(line)) push(i + 1); });
  return picked.length > 0 ? picked : [1];
}

export interface OverviewEvidenceState {
  readmeAvailable: boolean; readmeIncluded: boolean;
  manifestAvailable: boolean; manifestIncluded: boolean;
  treeIncluded: boolean;
  entrypointAvailable: boolean; entrypointIncluded: boolean;
}

/** REPOSITORY_OVERVIEW: README (if any), a manifest (if any), the workspace tree, and an implementation/entrypoint signal (if any). */
export function overviewSufficiency(state: OverviewEvidenceState): Sufficiency {
  const missing: string[] = [];
  if (state.readmeAvailable && !state.readmeIncluded) missing.push('README');
  if (state.manifestAvailable && !state.manifestIncluded) missing.push('manifest');
  if (!state.treeIncluded) missing.push('workspace tree');
  if (state.entrypointAvailable && !state.entrypointIncluded) missing.push('entrypoint');
  return missing.length === 0 ? { sufficient: true, reason: 'README/manifest/tree/entrypoint evidence present where available' } : { sufficient: false, reason: `missing ${missing.join(', ')}` };
}

// ── Manifest / entrypoint helpers ───────────────────────────────────────────

export const MANIFEST_NAME = /^(?:package\.json|pyproject\.toml|setup\.py|setup\.cfg|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|gemfile|requirements\.txt|.*\.sln|.*\.csproj|cmakelists\.txt)$/i;
export const ENTRY_STEM = /^(?:main|index|app|server|cli|extension|__main__|manage|program|run|api|activate|bootstrap)$/i;
export const OVERVIEW_DOC_NAME = /(?:architect|overview|design|how[-_ ]?it[-_ ]?works|^agents?\.md$|^claude\.md$)/i;

/** A compact, deterministic summary of a package.json: identity, what it declares itself to be, and its main dependencies. */
export function summarizePackageJson(text: string): string | undefined {
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>; } catch { return undefined; }
  if (!pkg || typeof pkg !== 'object') return undefined;
  const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const lines: string[] = [];
  for (const key of ['name', 'displayName', 'version', 'description', 'main', 'module', 'type', 'publisher', 'license']) {
    if (typeof pkg[key] === 'string') lines.push(`${key}: ${String(pkg[key]).slice(0, 240)}`);
  }
  const engines = asRecord(pkg['engines']);
  if (Object.keys(engines).length) lines.push(`engines: ${Object.entries(engines).map(([k, v]) => `${k} ${String(v)}`).join(', ')}`);
  if (Array.isArray(pkg['activationEvents'])) lines.push(`activationEvents: ${(pkg['activationEvents'] as unknown[]).slice(0, 6).map(String).join(', ')}`);
  const contributes = asRecord(pkg['contributes']);
  if (Object.keys(contributes).length) {
    const parts = Object.entries(contributes).map(([k, v]) => `${k}${Array.isArray(v) ? `(${v.length})` : ''}`);
    lines.push(`contributes: ${parts.slice(0, 14).join(', ')}`);
    const commands = Array.isArray(contributes['commands']) ? contributes['commands'] as Array<Record<string, unknown>> : [];
    const titles = commands.map(c => String(c['title'] ?? c['command'] ?? '')).filter(Boolean).slice(0, 8);
    if (titles.length) lines.push(`example commands: ${titles.join('; ')}`);
  }
  const bin = pkg['bin'];
  if (typeof bin === 'string') lines.push(`bin: ${bin}`);
  else if (Object.keys(asRecord(bin)).length) lines.push(`bin: ${Object.keys(asRecord(bin)).slice(0, 6).join(', ')}`);
  const scripts = Object.keys(asRecord(pkg['scripts']));
  if (scripts.length) lines.push(`scripts: ${scripts.slice(0, 14).join(', ')}${scripts.length > 14 ? ', …' : ''}`);
  const deps = Object.keys(asRecord(pkg['dependencies']));
  if (deps.length) lines.push(`dependencies (${deps.length}): ${deps.slice(0, 24).join(', ')}${deps.length > 24 ? ', …' : ''}`);
  const dev = Object.keys(asRecord(pkg['devDependencies']));
  if (dev.length) lines.push(`devDependencies (${dev.length}): ${dev.slice(0, 12).join(', ')}${dev.length > 12 ? ', …' : ''}`);
  if (Array.isArray(pkg['workspaces'])) lines.push(`workspaces: ${(pkg['workspaces'] as unknown[]).slice(0, 8).map(String).join(', ')}`);
  return lines.join('\n');
}

/** Maps a built entry ("./out/extension.js", "dist/index.js") back to plausible source paths. */
export function sourceCandidatesForBuiltEntry(entry: string): string[] {
  const clean = entry.replace(/^\.\//, '').replace(/\\/g, '/');
  const withoutExt = clean.replace(/\.(?:c|m)?js$/i, '');
  const unbuilt = withoutExt.replace(/^(?:out|dist|build|lib)\//i, 'src/');
  const bases = [...new Set([withoutExt, unbuilt, withoutExt.replace(/^(?:out|dist|build|lib)\//i, '')])];
  return bases.flatMap(base => ['.ts', '.tsx', '.js', '.mjs'].map(ext => `${base}${ext}`));
}

/** Detects an answer that hands a repository-retrieval job back to the user ("paste the file", "pull the markup"). */
export function answerAsksUserToFetchRepoFiles(answer: string): boolean {
  const text = String(answer ?? '');
  const ask = /\b(?:if you (?:can|could|'d like|want|are able to)|please|could you|can you|would you|you(?:'ll| will)? (?:need to|have to|should|can|could|may)|just|simply|go ahead and)\b[^.\n?]{0,70}\b(?:paste|pull|share|send|provide|upload|attach|copy|drop|show me|give me|open)\b[^.\n?]{0,90}\b(?:file|files|markup|module|modules|code|source|snippet|contents?|directory|folder|component|popover|class|function|implementation|section)\b/i;
  return ask.test(text);
}
