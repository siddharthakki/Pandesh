import * as fs from 'fs/promises';
import * as path from 'path';
import { listProjectRoots, type ProjectRoot } from './WorkspaceInventory';
import { runGit } from './gitRunner';

/**
 * Deterministic, READ-ONLY repository computation.
 *
 * "Count the files in each project", "which project is largest", "how many tests" are arithmetic over the workspace,
 * not reasoning. The host computes them here (no model, no shell exposed to anyone) and hands back structured data plus
 * a pre-rendered answer the model only has to present. Pure Node (no VS Code) so any host can reuse it.
 *
 * Git workspace: ONE `git ls-files` (and one `git ls-tree -l` for sizes), every file assigned to its deepest recognised
 * project root in a single pass. Non-Git workspace: a bounded filesystem enumeration.
 */

export type FactKind = 'project_file_counts' | 'project_size_comparison' | 'project_extension_counts' | 'test_file_counts' | 'git_change_summary' | 'project_tree';

export interface FactPlan {
  kind: FactKind;
  /** project_extension_counts: lower-case extensions without the dot, e.g. ['py'], plus the label the user used. */
  extensions?: string[];
  label?: string;
  /** project_tree: a project path or name the user named, if any. */
  target?: string;
}

/** What the UI may say about a host-computed answer. Every string is a fact that really happened. */
export interface HostFactsSummary {
  kind: FactKind | 'clarify_referent';
  recognised?: number;
  /** "Counting tracked files by project" */
  computing?: string;
  /** "139 projects measured" */
  measured?: string;
  /** A single project the answer named unambiguously; later "this project" may refer to it. */
  established?: { path: string; reason: string };
  /** Exact workspace-level count when the question asked for one (extension counts). Dominates any project breakdown. */
  workspaceTotal?: number;
  /** How many recognised projects held a match; a breakdown of workspaceTotal, never a substitute for it. */
  projectsWithMatches?: number;
  /** completed unless the host knows the question could not be answered / needs the user. */
  outcome: 'completed' | 'needs_input' | 'blocked';
}

export interface ProjectStats {
  path: string;
  kinds: string[];
  files: number;
  sourceFiles: number;
  testFiles: number;
  /** Tracked bytes (Git HEAD blobs); undefined when not cheaply known. */
  bytes?: number;
  extensions: Record<string, number>;
  changed: number;
}

export interface RepositoryFacts {
  plan: FactPlan;
  source: 'git' | 'filesystem';
  projects: ProjectStats[];
  /** Files that belong to no recognised project (only when the workspace root is not itself a project). */
  outside: ProjectStats;
  totalFiles: number;
  bytesKnown: boolean;
  truncated: boolean;
  /** The enumeration behind this answer, so a follow-up question can reuse it instead of re-walking. */
  census?: ProjectCensus;
  /** git_change_summary only. */
  changes?: { total: number; byStatus: Record<string, number>; files: Array<{ status: string; path: string }> };
  headline: string;
  /** The complete host-rendered answer (markdown), sized to `maxChars`. */
  answer: string;
  summary: HostFactsSummary;
}

// ── Question planning ───────────────────────────────────────────────────────

const UNIT = '(?:projects?|apps?|applications?|packages?|modules?|services?|sub-?projects?|workspaces?|components?|repos?|repositories|folders?|directories)';
const EACH_UNIT = new RegExp(`\\b(?:each|every|per|by|for all|across(?: all)?(?: the)?)\\s+${UNIT}\\b`, 'i');
const NOT_REPO_SCOPE = /\b(?:in the world|ever made|in history|of all time|on earth)\b/i;

const LANGUAGES: Record<string, { label: string; ext: string[] }> = {
  python: { label: 'Python', ext: ['py'] },
  typescript: { label: 'TypeScript', ext: ['ts', 'tsx'] },
  javascript: { label: 'JavaScript', ext: ['js', 'jsx', 'mjs', 'cjs'] },
  java: { label: 'Java', ext: ['java'] },
  kotlin: { label: 'Kotlin', ext: ['kt', 'kts'] },
  go: { label: 'Go', ext: ['go'] },
  golang: { label: 'Go', ext: ['go'] },
  rust: { label: 'Rust', ext: ['rs'] },
  'c#': { label: 'C#', ext: ['cs'] },
  csharp: { label: 'C#', ext: ['cs'] },
  'c++': { label: 'C++', ext: ['cpp', 'cc', 'cxx', 'hpp'] },
  cpp: { label: 'C++', ext: ['cpp', 'cc', 'cxx', 'hpp'] },
  ruby: { label: 'Ruby', ext: ['rb'] },
  php: { label: 'PHP', ext: ['php'] },
  swift: { label: 'Swift', ext: ['swift'] },
  html: { label: 'HTML', ext: ['html', 'htm'] },
  css: { label: 'CSS', ext: ['css', 'scss'] },
  json: { label: 'JSON', ext: ['json'] },
  markdown: { label: 'Markdown', ext: ['md', 'markdown'] },
  shell: { label: 'Shell', ext: ['sh'] },
  powershell: { label: 'PowerShell', ext: ['ps1'] },
  sql: { label: 'SQL', ext: ['sql'] },
};

function languageIn(q: string): { label: string; ext: string[] } | undefined {
  const dotted = /(?:^|\s)\.([a-z0-9]{1,5})\s+files?\b/i.exec(q);
  if (dotted) return { label: `.${dotted[1].toLowerCase()}`, ext: [dotted[1].toLowerCase()] };
  for (const [name, value] of Object.entries(LANGUAGES)) {
    const escaped = name.replace(/[+#]/g, match => `\\${match}`);
    if (new RegExp(`(?:^|[^\\w])${escaped}(?=\\s+(?:files?|code|sources?|scripts?)\\b)`, 'i').test(q)) return value;
  }
  return undefined;
}

/** Recognises deterministic repository-fact questions. Pure, case-insensitive; no model involved. */
export function planRepositoryFacts(question: string): FactPlan | undefined {
  const q = String(question ?? '').trim();
  if (!q || q.length > 400 || NOT_REPO_SCOPE.test(q)) return undefined;

  const language = languageIn(q);
  const countVerb = /\b(?:count|how many|number of|tally|total)\b/i.test(q);
  const rankVerb = /\b(?:which|what|who)\b[^?.!]{0,50}\b(?:most|more|top|highest|largest|biggest|heaviest)\b|\b(?:most|highest number of)\b/i.test(q);

  if (language && (countVerb || rankVerb || EACH_UNIT.test(q))) {
    return { kind: 'project_extension_counts', extensions: language.ext, label: language.label };
  }
  if (new RegExp(`\\b(?:largest|biggest|heaviest)\\b[^?.!]{0,30}\\b${UNIT}\\b|\\b${UNIT}\\b[^?.!]{0,30}\\b(?:is|are|has|have)?\\s*(?:the\\s+)?(?:largest|biggest|heaviest)\\b|\\b${UNIT}\\b[^?.!]{0,30}\\b(?:most|more|highest number of) (?:files|code|source)\\b|\\b(?:rank|sort|compare)\\b[^?.!]{0,30}\\b${UNIT}\\b[^?.!]{0,20}\\b(?:by )?(?:size|files)\\b|\\b${UNIT}\\s+sizes?\\b`, 'i').test(q)) {
    return { kind: 'project_size_comparison' };
  }
  if (countVerb && /\b(?:files?|file counts?)\b/i.test(q) && (EACH_UNIT.test(q) || new RegExp(`\\b${UNIT}\\b`, 'i').test(q))) {
    return { kind: 'project_file_counts' };
  }
  if (/\bfile counts?\b/i.test(q) && new RegExp(`\\b${UNIT}\\b`, 'i').test(q)) return { kind: 'project_file_counts' };
  // "how many tests should I write?" is advice; only a question about the repository's own tests is a fact query.
  if (/\b(?:how many|count|number of)\s+(?:the\s+)?(?:unit\s+|test\s+)?(?:tests?|test files?|specs?)\b(?!\s+(?:pass|passed|fail|failed|failing|ran|run|did|are failing|were|should|would|do i need|to write))/i.test(q)
    && (/\b(?:in|across|inside|within|of)\s+(?:this|the|my|our|each|every|all)\b|\b(?:are there|do we have|do i have|have we got|exist|per project|in total)\b/i.test(q)
      || /^\W*(?:how many|count|number of)\s+(?:the\s+)?(?:unit\s+)?(?:tests?|test files?|specs?)\W*$/i.test(q))) {
    return { kind: 'test_file_counts' };
  }
  // "what changed in src/foo.ts" names a file: that is a diff question, not a repository-wide summary.
  if (!/\b[\w-]+\.[a-z0-9]{1,5}\b|\w\/\w/i.test(q) && /\b(?:what(?:'s| has| have)?\s+(?:has\s+)?changed|uncommitted|working tree|git status|changed files|files? (?:i|we) (?:changed|modified|edited)|(?:how many|count)\b[^?.!]{0,30}\b(?:files?\s+)?(?:changed|modified|dirty))\b/i.test(q)) {
    return { kind: 'git_change_summary' };
  }
  const tree = /\b(?:directory|folder|project|file) tree\b|\btree (?:of|for)\b/i.exec(q);
  if (tree) {
    const target = /\b(?:tree (?:of|for)|in|inside)\s+(?:the\s+)?([\w./\\-]{2,80})\s*$/i.exec(q.replace(/[?.!]+$/, ''))?.[1];
    return { kind: 'project_tree', ...(target && !/^(?:this|that|the|workspace|repo|repository|project|folder)$/i.test(target) ? { target: target.replace(/\\/g, '/') } : {}) };
  }
  return undefined;
}

// ── File classification ─────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', 'bin', 'obj', 'target', 'coverage', 'venv', 'env', '.venv', '__pycache__',
  'site-packages', '.next', '.idea', '.vs', '.cache', '.gradle', '.tox', '.mypy_cache', '.pytest_cache', '.nyc_output', '.turbo',
]);

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'rb', 'php', 'swift',
  'html', 'htm', 'css', 'scss', 'vue', 'svelte', 'sh', 'ps1', 'bat', 'sql', 'lua', 'dart', 'scala', 'ipynb',
]);

function isExcludedPath(rel: string): boolean {
  for (const segment of rel.split('/').slice(0, -1)) if (EXCLUDED_DIRS.has(segment.toLowerCase())) return true;
  return false;
}

function isTestFile(rel: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|spec)\//i.test(rel) || /\.(?:test|spec)\.[a-z0-9]+$|(?:^|\/)test_[^/]+\.[a-z0-9]+$|_test\.[a-z0-9]+$/i.test(rel);
}

function extensionOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const OUTSIDE = '(outside any project)';

function emptyStats(project: string, kinds: string[] = []): ProjectStats {
  return { path: project, kinds, files: 0, sourceFiles: 0, testFiles: 0, extensions: {}, changed: 0 };
}

/** Assigns each file to the deepest recognised project root that contains it, in one pass over the file list. */
export class ProjectAssigner {
  private readonly byPath = new Map<string, ProjectStats>();
  readonly outside = emptyStats(OUTSIDE);

  constructor(roots: readonly ProjectRoot[]) {
    for (const root of roots) this.byPath.set(root.path, emptyStats(root.path, root.kinds));
  }

  get projects(): ProjectStats[] { return [...this.byPath.values()]; }

  owner(rel: string): ProjectStats {
    let dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    while (dir) {
      const hit = this.byPath.get(dir);
      if (hit) return hit;
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
    return this.byPath.get('.') ?? this.outside;
  }

  add(rel: string, size?: number): void {
    const stats = this.owner(rel);
    const ext = extensionOf(rel);
    stats.files += 1;
    if (SOURCE_EXTENSIONS.has(ext)) stats.sourceFiles += 1;
    if (isTestFile(rel)) stats.testFiles += 1;
    if (ext) stats.extensions[ext] = (stats.extensions[ext] ?? 0) + 1;
    if (size !== undefined) stats.bytes = (stats.bytes ?? 0) + size;
  }
}

// ── Enumeration ─────────────────────────────────────────────────────────────

const GIT_FILES_BUDGET_MS = 15_000;
const GIT_FILES_MAX_BYTES = 64 * 1024 * 1024;
const FS_MAX_FILES = 200_000;
const FS_BUDGET_MS = 8_000;

async function isGitWorkTree(root: string): Promise<boolean> {
  const result = await runGit(root, ['rev-parse', '--is-inside-work-tree'], 2_000, 4096);
  return result.ok && result.stdout.trim() === 'true';
}

/** The workspace's tracked file list from ONE `git ls-files -z`, paths relative to `root`, excluded trees dropped. */
async function gitTrackedFiles(root: string): Promise<{ files: string[]; truncated: boolean } | undefined> {
  const result = await runGit(root, ['ls-files', '-z', '--cached'], GIT_FILES_BUDGET_MS, GIT_FILES_MAX_BYTES);
  if (!result.ok) return undefined;
  const files = result.stdout.split('\0').filter(Boolean).map(file => file.replace(/\\/g, '/')).filter(file => !isExcludedPath(file));
  return { files, truncated: result.truncated };
}

/** Sizes of every committed blob from one `git ls-tree -r -l HEAD`; undefined when HEAD does not exist or output was cut. */
async function gitBlobSizes(root: string): Promise<Map<string, number> | undefined> {
  const result = await runGit(root, ['ls-tree', '-r', '-l', '-z', 'HEAD'], GIT_FILES_BUDGET_MS, GIT_FILES_MAX_BYTES);
  if (!result.ok || result.truncated || !result.stdout) return undefined;
  const sizes = new Map<string, number>();
  for (const entry of result.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3]);
    if (Number.isFinite(size)) sizes.set(entry.slice(tab + 1).replace(/\\/g, '/'), size);
  }
  return sizes;
}

/** Bounded breadth-first filesystem enumeration for a workspace that is not a Git repository. */
async function walkFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const started = Date.now();
  const files: string[] = [];
  let level: string[] = [''];
  let truncated = false;
  while (level.length > 0 && !truncated) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 32) {
      if (files.length >= FS_MAX_FILES || Date.now() - started > FS_BUDGET_MS) { truncated = true; break; }
      const batch = level.slice(i, i + 32);
      const listed = await Promise.all(batch.map(async dir => {
        try { return { dir, entries: await fs.readdir(path.join(root, dir), { withFileTypes: true }) }; } catch { return { dir, entries: [] as import('fs').Dirent[] }; }
      }));
      for (const { dir, entries } of listed) {
        for (const entry of entries) {
          const rel = dir ? `${dir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) next.push(rel); }
          else if (entry.isFile()) files.push(rel);
        }
      }
    }
    level = next;
  }
  return { files, truncated };
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const n = (value: number) => value.toLocaleString('en-US');
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? '' : 's'}`;

function table(headers: string[], rows: string[][]): string {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
}

/** Renders as many rows as fit, never silently dropping the rest: the omitted tail is summed and said. */
function fitRows<T>(items: readonly T[], render: (item: T) => string[], headers: string[], maxChars: number, tail: (omitted: readonly T[]) => string): string {
  const rows: string[][] = [];
  let used = headers.join(' | ').length + 80;
  for (const item of items) {
    const row = render(item);
    const cost = row.join(' | ').length + 8;
    if (used + cost > maxChars - 200) break;
    rows.push(row);
    used += cost;
  }
  const omitted = items.slice(rows.length);
  return table(headers, rows) + (omitted.length > 0 ? `\n\n${tail(omitted)}` : '');
}

// ── Computation ─────────────────────────────────────────────────────────────

export interface FactsOptions {
  /** Character budget for the rendered answer. */
  maxChars: number;
}

export interface ProjectCensus {
  source: 'git' | 'filesystem';
  roots: ProjectRoot[];
  assigner: ProjectAssigner;
  totalFiles: number;
  bytesKnown: boolean;
  truncated: boolean;
}

/** One enumeration + one assignment pass. Cheap enough to repeat; callers may cache the result for a short while. */
export async function censusProjects(root: string, needBytes: boolean): Promise<ProjectCensus | undefined> {
  const [{ roots, truncated: rootsTruncated }, git] = await Promise.all([listProjectRoots(root), isGitWorkTree(root)]);
  let files: string[] | undefined;
  let source: ProjectCensus['source'] = 'git';
  let truncated = rootsTruncated;
  let sizes: Map<string, number> | undefined;
  if (git) {
    const tracked = await gitTrackedFiles(root);
    if (tracked) {
      files = tracked.files;
      truncated ||= tracked.truncated;
      if (needBytes) sizes = await gitBlobSizes(root);
    }
  }
  if (!files) {
    source = 'filesystem';
    const walked = await walkFiles(root);
    files = walked.files;
    truncated ||= walked.truncated;
  }
  if (files.length === 0 && roots.length === 0) return undefined;
  const assigner = new ProjectAssigner(roots);
  for (const file of files) assigner.add(file, sizes?.get(file));
  return { source, roots, assigner, totalFiles: files.length, bytesKnown: Boolean(sizes), truncated };
}

function ranked(projects: readonly ProjectStats[], key: (p: ProjectStats) => number): ProjectStats[] {
  return [...projects].sort((a, b) => key(b) - key(a) || b.files - a.files || a.path.localeCompare(b.path));
}

function scopeNote(census: ProjectCensus): string {
  return `Counted from ${census.source === 'git' ? 'the Git index (tracked files only)' : 'a bounded filesystem walk'}; `
    + 'excluded: node_modules, .git, dist, build, out, bin, obj, target, coverage, venv/.venv, __pycache__ and similar generated trees.'
    + `${census.truncated ? ' The enumeration hit its safety limit, so figures may be a lower bound.' : ''}`;
}

export async function computeRepositoryFacts(root: string, plan: FactPlan, options: FactsOptions, prior?: ProjectCensus): Promise<RepositoryFacts | undefined> {
  if (plan.kind === 'git_change_summary') return computeChangeSummary(root, plan, options);
  const needBytes = plan.kind === 'project_size_comparison' || plan.kind === 'project_file_counts';
  const census = prior && (!needBytes || prior.bytesKnown || prior.source === 'filesystem') ? prior : await censusProjects(root, needBytes);
  if (!census) return undefined;
  const { assigner } = census;
  const withFiles = assigner.projects.filter(project => project.files > 0);
  const projects = withFiles.length > 0 ? withFiles : assigner.projects;
  const recognised = census.roots.length;
  const outside = assigner.outside;
  const common = { plan, source: census.source, projects, outside, totalFiles: census.totalFiles, bytesKnown: census.bytesKnown, truncated: census.truncated, census } as const;
  const bytesCol = census.bytesKnown;

  const projectColumns = (p: ProjectStats): string[] => [`\`${p.path}\``, n(p.files), n(p.sourceFiles), ...(bytesCol ? [formatBytes(p.bytes ?? 0)] : [])];
  const projectHeaders = ['Project', 'Files', 'Source files', ...(bytesCol ? ['Tracked bytes'] : [])];
  const outsideLine = outside.files > 0 ? `\n${plural(outside.files, 'file')} sit outside any recognised project (workspace-level files).` : '';

  if (plan.kind === 'project_file_counts' || plan.kind === 'project_size_comparison') {
    const byFiles = ranked(projects, p => p.files);
    const byBytes = bytesCol ? ranked(projects, p => p.bytes ?? 0) : [];
    const top = byFiles[0];
    let headline: string;
    let established: HostFactsSummary['established'];
    if (!top) {
      headline = 'No tracked files were found in any recognised project.';
    } else if (plan.kind === 'project_size_comparison') {
      headline = `By tracked file count, \`${top.path}\` is the largest project (${plural(top.files, 'file')}, ${plural(top.sourceFiles, 'source file')}`
        + `${bytesCol ? `, ${formatBytes(top.bytes ?? 0)}` : ''}).`
        + (bytesCol && byBytes[0] && byBytes[0].path !== top.path ? ` By tracked bytes, \`${byBytes[0].path}\` is largest (${formatBytes(byBytes[0].bytes ?? 0)}).` : '');
      if (!(byFiles[1] && byFiles[1].files === top.files)) established = { path: top.path, reason: 'largest project by tracked file count' };
    } else {
      headline = `${plural(census.totalFiles, 'tracked file')} across ${plural(recognised, 'recognised project')}.`;
    }
    const rows = fitRows(byFiles, projectColumns, projectHeaders, Math.max(1_500, options.maxChars - 900),
      omitted => `…and ${plural(omitted.length, 'smaller project')} (${plural(omitted.reduce((sum, p) => sum + p.files, 0), 'file')} in total) not listed here; ask for the full list to see them.`);
    const metric = plan.kind === 'project_size_comparison'
      ? '"Largest" has no single meaning, so three metrics are shown: Files (tracked files), Source files (code files) and Tracked bytes (committed content size). The headline states which metric it ranks by.'
      : 'Files = tracked files assigned to the deepest recognised project that contains them.';
    const answer = `${metric}\n\n${headline}\n\n${rows}${outsideLine}\n\n${scopeNote(census)}`;
    return {
      ...common, headline, answer,
      summary: {
        kind: plan.kind, recognised, computing: 'Counting tracked files by project', outcome: 'completed',
        measured: `${plural(withFiles.length, 'project')} measured · ${plural(census.totalFiles, 'file')}`,
        ...(established ? { established } : {}),
      },
    };
  }

  if (plan.kind === 'project_extension_counts') {
    const extensions = plan.extensions ?? [];
    const countOf = (p: ProjectStats) => (extensions.length > 0 ? extensions.reduce((sum, ext) => sum + (p.extensions[ext] ?? 0), 0) : p.sourceFiles);
    const label = plan.label ?? 'source';
    const order = ranked(projects, countOf).filter(p => countOf(p) > 0);
    const total = order.reduce((sum, p) => sum + countOf(p), 0) + (extensions.length > 0 ? extensions.reduce((sum, ext) => sum + (outside.extensions[ext] ?? 0), 0) : 0);
    const outsideCount = extensions.length > 0 ? extensions.reduce((sum, ext) => sum + (outside.extensions[ext] ?? 0), 0) : 0;
    // The workspace-level total is the exact computed fact. How many files fall inside "recognised projects" is only a
    // breakdown of it, so zero recognised projects can never be read as zero files.
    const workspaceTotal = plural(total, `${label} file`);
    const outsideNote = outsideCount > 0 ? ` ${plural(outsideCount, `${label} file`)} ${outsideCount === 1 ? 'sits' : 'sit'} outside any recognised project (workspace-level files).` : '';
    const headline = total === 0
      ? `No ${label} files were found in this workspace.`
      : order.length === 0
        ? `There ${total === 1 ? 'is' : 'are'} ${workspaceTotal} in this workspace.${outsideNote}`
        : `\`${order[0].path}\` has the most ${label} files (${n(countOf(order[0]))}); ${workspaceTotal} in total across ${plural(order.length, 'project')}${outsideCount > 0 ? ' and workspace-level files' : ''}.${outsideNote}`;
    const rows = order.length === 0 ? '' : fitRows(order, p => [`\`${p.path}\``, n(countOf(p)), n(p.files)], ['Project', `${label} files`, 'All files'], options.maxChars - 900,
      omitted => `…and ${plural(omitted.length, 'smaller project')} (${plural(omitted.reduce((sum, p) => sum + countOf(p), 0), `${label} file`)}) not listed.`);
    return {
      ...common, headline, answer: `${headline}${rows ? `

${rows}` : ''}

${scopeNote(census)}`,
      summary: {
        kind: plan.kind, recognised, computing: `Counting ${label} files`, outcome: 'completed',
        measured: `${plural(total, `${label} file`)} counted across the workspace`,
        workspaceTotal: total, projectsWithMatches: order.length,
        ...(order[0] && !(order[1] && countOf(order[1]) === countOf(order[0])) ? { established: { path: order[0].path, reason: `most ${label} files` } } : {}),
      },
    };
  }

  if (plan.kind === 'test_file_counts') {
    const order = ranked(projects, p => p.testFiles).filter(p => p.testFiles > 0);
    const total = projects.reduce((sum, p) => sum + p.testFiles, 0) + outside.testFiles;
    const headline = total === 0 ? 'No test files were found (matching test/, tests/, __tests__/, *.test.*, *.spec.*, test_*, *_test.*).'
      : `${plural(total, 'test file')} found across ${plural(order.length, 'project')} (counted by file name/location; this is test FILES, not individual test cases).`;
    const rows = order.length === 0 ? '' : fitRows(order, p => [`\`${p.path}\``, n(p.testFiles), n(p.files)], ['Project', 'Test files', 'All files'], options.maxChars - 900,
      omitted => `…and ${plural(omitted.length, 'smaller project')} (${plural(omitted.reduce((sum, p) => sum + p.testFiles, 0), 'test file')}) not listed.`);
    return {
      ...common, headline, answer: `${headline}\n\n${rows}\n\n${scopeNote(census)}`,
      summary: { kind: plan.kind, recognised, computing: 'Counting test files by project', measured: `${plural(total, 'test file')} found`, outcome: 'completed' },
    };
  }

  // project_tree
  const target = plan.target?.toLowerCase();
  const wanted = target ? projects.find(p => p.path.toLowerCase() === target || path.posix.basename(p.path).toLowerCase() === target) : undefined;
  const lines = [wanted ? `Project \`${wanted.path}\`: ${plural(wanted.files, 'file')}, kinds: ${wanted.kinds.join(', ') || 'unknown'}.` : `${plural(recognised, 'recognised project')}.`];
  const shown = (wanted ? [wanted] : ranked(projects, p => p.files)).slice(0, 40);
  for (const p of shown) lines.push(`- \`${p.path}\` — ${plural(p.files, 'file')}${p.kinds.length ? ` (${p.kinds.join(', ')})` : ''}`);
  if (!wanted && projects.length > shown.length) lines.push(`…and ${plural(projects.length - shown.length, 'smaller project')} not listed.`);
  return {
    ...common, headline: lines[0], answer: `${lines.join('\n')}\n\n${scopeNote(census)}`,
    summary: { kind: plan.kind, recognised, computing: 'Listing project layout', measured: `${plural(withFiles.length, 'project')} measured`, outcome: 'completed' },
  };
}

// ── Git change summary ──────────────────────────────────────────────────────

async function computeChangeSummary(root: string, plan: FactPlan, options: FactsOptions): Promise<RepositoryFacts | undefined> {
  const [{ roots }, git] = await Promise.all([listProjectRoots(root), isGitWorkTree(root)]);
  if (!git) {
    return {
      plan, source: 'filesystem', projects: [], outside: emptyStats(OUTSIDE), totalFiles: 0, bytesKnown: false, truncated: false,
      headline: 'This workspace is not a Git repository, so there is no recorded baseline to compare against.',
      answer: 'This workspace is not a Git repository, so changed files cannot be determined from version control.',
      summary: { kind: plan.kind, computing: 'Checking Git status', measured: 'Not a Git repository', outcome: 'blocked' },
    };
  }
  const status = await runGit(root, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'], 8_000, 8 * 1024 * 1024);
  if (!status.ok) return undefined;
  // Porcelain paths are relative to the repository top; the workspace may be a sub-folder of it.
  const prefix = (await runGit(root, ['rev-parse', '--show-prefix'], 2_000, 4096)).stdout.trim().replace(/\\/g, '/');
  const assigner = new ProjectAssigner(roots);
  const byStatus: Record<string, number> = {};
  const files: Array<{ status: string; path: string }> = [];
  for (const entry of status.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const full = entry.slice(3).replace(/\\/g, '/');
    if (prefix && !full.startsWith(prefix)) continue;
    const file = prefix ? full.slice(prefix.length) : full;
    if (isExcludedPath(file)) continue;
    const label = code === '??' ? 'untracked' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : 'modified';
    byStatus[label] = (byStatus[label] ?? 0) + 1;
    files.push({ status: label, path: file });
    assigner.owner(file).changed += 1;
  }
  const perProject = ranked(assigner.projects.filter(p => p.changed > 0), p => p.changed);
  const outsideChanged = assigner.outside.changed;
  const breakdown = Object.entries(byStatus).map(([label, count]) => `${n(count)} ${label}`).join(', ');
  const headline = files.length === 0 ? 'The working tree is clean: no changed or untracked files.' : `${plural(files.length, 'changed file')} (${breakdown}).`;
  const rows = perProject.length === 0 ? '' : fitRows(perProject, p => [`\`${p.path}\``, n(p.changed)], ['Project', 'Changed files'], Math.floor(options.maxChars / 3),
    omitted => `…and ${plural(omitted.length, 'more project')} with changes.`);
  const listed = files.slice(0, 60).map(file => `- ${file.status}: \`${file.path}\``).join('\n');
  const answer = [headline, rows, outsideChanged > 0 ? `${plural(outsideChanged, 'changed file')} sit outside any recognised project.` : '', listed ? `Changed files${files.length > 60 ? ` (first 60 of ${n(files.length)})` : ''}:\n${listed}` : '']
    .filter(Boolean).join('\n\n');
  return {
    plan, source: 'git', projects: assigner.projects, outside: assigner.outside, totalFiles: files.length, bytesKnown: false, truncated: status.truncated,
    changes: { total: files.length, byStatus, files }, headline, answer,
    summary: { kind: plan.kind, recognised: roots.length, computing: 'Reading Git status', measured: `${plural(files.length, 'changed file')}`, outcome: 'completed' },
  };
}

// ── Packet for the model ────────────────────────────────────────────────────

/** The evidence packet: the computed answer plus the rules for presenting it. The model formats; it does not compute. */
export function renderFactsPacket(facts: RepositoryFacts, workspaceName: string): string {
  const header = `Repository facts computed by the host from the open workspace "${workspaceName}" for the user's question `
    + `(fact query: ${facts.plan.kind}; deterministic, read-only, no model was involved). The workspace IS open and these figures are authoritative. `
    + 'Present the result below to the user: keep the headline and the table, correct nothing, and add at most one short sentence of explanation. '
    + 'Do NOT say you lack tools, cannot run commands, cannot list directories or cannot count files, and do NOT tell the user to run any command themselves. '
    + 'A count of recognised projects (including zero) is only a breakdown: it never means the workspace has no files. When a workspace-level total is stated, that total is the answer. '
    + 'Do not invent figures that are not listed. If a figure the user asked for is not here, say exactly which one is missing.';
  return `${header}\n\n--- computed answer ---\n${facts.answer}`;
}

// ── Questions about an earlier host-computed answer ─────────────────────────

/** What the host actually recorded about the last repository-facts answer it produced in this conversation. */
export interface FactsRecord { question: string; kind: FactKind; headline: string; measured?: string; workspaceTotal?: number; projectsWithMatches?: number }

/** "why did you say X?", "what was the root cause?": a question about the assistant's own earlier answer. */
const INTROSPECTION = /\b(?:why did (?:you|it)\b[^.?!]*\b(?:say|answer|claim|report|tell|state|respond)|why (?:was|is) (?:that|this|your (?:answer|reply|response))\b[^.?!]*\b(?:wrong|incorrect|off)|what(?:'s| is| was) (?:the )?(?:root )?cause|root[- ]cause|what went wrong|why (?:the )?(?:wrong|incorrect) (?:answer|count))/i;

export function isAnswerIntrospection(question: string): boolean {
  const q = String(question ?? '').trim();
  return q.length > 0 && q.length <= 400 && INTROSPECTION.test(q);
}

export function factsRecordFrom(question: string, facts: RepositoryFacts): FactsRecord {
  return {
    question, kind: facts.plan.kind, headline: facts.headline, measured: facts.summary.measured,
    workspaceTotal: facts.summary.workspaceTotal, projectsWithMatches: facts.summary.projectsWithMatches,
  };
}

/**
 * The model cannot observe why an earlier answer was worded as it was, so it must not claim to. The host hands it the only
 * observable evidence (its own record of the figure it computed) and, when that record shows the project breakdown was empty
 * while the workspace total was not, the one observable way an answer could have contradicted it.
 */
export function renderIntrospectionPacket(record: FactsRecord): string {
  const lines = [
    `The user is asking why an earlier answer in this conversation said what it said. Earlier question: "${record.question}".`,
    `Host record of that answer (deterministic, computed before any model wording): ${record.headline}${record.measured ? ` [${record.measured}]` : ''}`,
  ];
  if (record.workspaceTotal !== undefined && record.workspaceTotal > 0 && (record.projectsWithMatches ?? 0) === 0) {
    lines.push(
      `Observable discrepancy: the host's workspace-level total was ${record.workspaceTotal}, while the recognised-project breakdown found 0 projects containing matches (the matching files are workspace-level files outside any recognised project). `
      + 'An earlier answer that said none were found can only be explained by reading that zero project count as zero files.',
    );
  }
  lines.push(
    'RULES: You have no access to your earlier internal reasoning, so do not claim to know why you said something, and do not say you "ignored" or "missed" evidence unless this record shows it. '
    + 'Explain only from the host record above. Compare it with what the earlier assistant message said: if they disagree, say plainly that the earlier statement was wrong and give the host figure; if the record above contains a discrepancy, state it as the observable cause. '
    + 'If the host record does not explain the difference, say the cause cannot be determined from the available evidence. Keep it to a few sentences.',
  );
  return lines.join('\n');
}
