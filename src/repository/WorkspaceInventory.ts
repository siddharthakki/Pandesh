import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Workspace inventory plan — "what projects are in this folder?" is answered from the workspace's own structure,
 * not from a lexical sample of source files.
 *
 * The host lists directories to a small bounded depth, recognises project markers (manifests, solutions, READMEs,
 * entry files), reads the few bytes of each manifest/README that name and describe a project, and returns one compact
 * inventory packet. It never reads source files and never walks the tree unboundedly. Pure Node (no VS Code) so it is
 * unit-testable.
 */

export interface InventoryProject {
  /** Workspace-relative POSIX path ('.' for the root itself). */
  path: string;
  kinds: string[];
  /** Manifest/README-derived facts only; empty when the folder has no manifest. */
  name?: string;
  description?: string;
  readme?: string;
  detail: string[];
  entryFiles: string[];
  hasManifest: boolean;
  /** How the folder was recognised. manifest > readme > inferred (only "has 2+ source files"): lower is a weaker claim. */
  confidence: 'manifest' | 'readme' | 'inferred';
}

export interface WorkspaceInventory {
  prompt: string;
  /** Manifests/READMEs that were actually read. */
  files: Array<{ path: string; estimatedTokens: number }>;
  projectCount: number;
  folderCount: number;
  /** Recognised projects not named in the prompt (compact mode); the user can ask for the full inventory. */
  omittedProjects: number;
}

export interface InventoryOptions {
  /** List every recognised project. Default is a compact, hierarchical summary. */
  full?: boolean;
  /** Return only the facts (no answer-style instructions), for use as supporting evidence inside another packet. */
  evidenceOnly?: boolean;
}

/** True when the user asked for everything rather than a summary ("full inventory", "list all projects"). */
export function wantsFullInventory(question: string): boolean {
  return /\b(?:full|complete|entire|exhaustive|detailed)\b|\b(?:list|show|name)\s+(?:me\s+)?(?:all|every)\b|\ball\s+(?:the\s+)?(?:projects|apps|packages|modules|services|repos)\b|\bevery\s+(?:project|app|package|module|service)\b/i.test(String(question ?? ''));
}

const MAX_DEPTH = 3;
const MAX_DIRS = 500;
const MAX_PROJECTS = 60;
const WALK_BUDGET_MS = 2_000;
const MANIFEST_READ_BYTES = 12_000;
const README_READ_BYTES = 3_000;
const COMPACT_PER_AREA = 3;
const COMPACT_TOTAL = 14;
const COMPACT_PLAIN_FOLDERS = 8;

const README_FILE = /^readme(?:\.\w+)?$/i;
const CONFIDENCE_RANK = { manifest: 0, readme: 1, inferred: 2 } as const;

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', 'bin', 'obj', 'target', 'coverage', 'venv', 'env', '.venv', '__pycache__',
  'site-packages', '.next', '.idea', '.vs', '.cache', '.gradle', '.tox', '.mypy_cache', '.pytest_cache',
]);

const MANIFESTS: Array<{ pattern: RegExp; kind: string }> = [
  { pattern: /^package\.json$/i, kind: 'Node' },
  { pattern: /^(?:pyproject\.toml|setup\.py|setup\.cfg)$/i, kind: 'Python' },
  { pattern: /^requirements[\w.-]*\.txt$/i, kind: 'Python' },
  { pattern: /^cargo\.toml$/i, kind: 'Rust' },
  { pattern: /^go\.mod$/i, kind: 'Go' },
  { pattern: /^pom\.xml$/i, kind: 'Java (Maven)' },
  { pattern: /^build\.gradle(?:\.kts)?$/i, kind: 'Gradle' },
  { pattern: /^.+\.sln$/i, kind: '.NET solution' },
  { pattern: /^.+\.(?:csproj|fsproj|vbproj)$/i, kind: '.NET' },
  { pattern: /^composer\.json$/i, kind: 'PHP' },
  { pattern: /^gemfile$/i, kind: 'Ruby' },
  { pattern: /^cmakelists\.txt$/i, kind: 'CMake' },
  { pattern: /^makefile$/i, kind: 'Make' },
  { pattern: /^(?:dockerfile|docker-compose\.ya?ml)$/i, kind: 'Docker' },
  { pattern: /^(?:pubspec\.yaml|mix\.exs|deno\.jsonc?)$/i, kind: 'Other manifest' },
];

const CODE_EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.py': 'Python',
  '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.h': 'C/C++', '.rb': 'Ruby',
  '.php': 'PHP', '.swift': 'Swift', '.html': 'HTML', '.ps1': 'PowerShell', '.bat': 'Batch', '.sh': 'Shell', '.sql': 'SQL', '.ipynb': 'Notebook',
};

const ENTRY_NAMES = /^(?:main|index|app|server|cli|extension|__main__|manage|program|api)\.(?:ts|tsx|js|mjs|py|go|rs|java|cs|html)$/i;

// ── Question detection ──────────────────────────────────────────────────────

const PLURAL_UNIT = /\b(?:projects|apps|applications|packages|modules|services|repos|repositories|sub-?projects|tools|workspaces|components)\b/i;
const SCOPE = /\b(?:folder|directory|workspace|repo|repository|monorepo|here|this|there|root|have|inside|under)\b/i;
const INVENTORY_VERB = /\b(?:list|summari[sz]e|enumerate|inventory|overview|show|what|which|how many|name|describe|tell me)\b/i;

/** True for "what projects are in this folder", "list the apps", "what is in this workspace", "repository structure". */
export function isInventoryQuestion(question: string): boolean {
  const q = String(question ?? '').trim();
  if (!q || q.length > 400) return false;
  if (/\bwhat(?:'s| is| all is)\s+(?:in|inside)\s+(?:this|the|my|our)\s+(?:folder|directory|workspace|repo|repository|project)\b/i.test(q)) return true;
  if (/\b(?:repo(?:sitory)?|workspace|folder|directory|project|codebase)\s+(?:structure|layout|tree|contents?)\b/i.test(q)) return true;
  if (/\b(?:structure|layout|contents?)\s+of\s+(?:this|the|my|our)\s+(?:repo|repository|workspace|folder|directory|codebase)\b/i.test(q)) return true;
  return PLURAL_UNIT.test(q) && SCOPE.test(q) && INVENTORY_VERB.test(q);
}

// ── Directory walk ──────────────────────────────────────────────────────────

interface DirEntry {
  rel: string;
  depth: number;
  files: string[];
  dirs: string[];
  /** Nearest enclosing project path found while walking, if any. */
  ancestorProject?: string;
}

function manifestKinds(files: readonly string[]): { kinds: string[]; names: string[] } {
  const kinds: string[] = [];
  const names: string[] = [];
  for (const file of files) {
    const hit = MANIFESTS.find(m => m.pattern.test(file));
    if (!hit) continue;
    names.push(file);
    if (!kinds.includes(hit.kind)) kinds.push(hit.kind);
  }
  return { kinds, names };
}

function languageSummary(files: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = CODE_EXTENSIONS[path.extname(file).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([language]) => language);
}

async function walk(root: string): Promise<{ dirs: DirEntry[]; truncated: boolean }> {
  const started = Date.now();
  const out: DirEntry[] = [];
  const projectAt = new Map<string, boolean>();
  let queue: Array<{ rel: string; depth: number; ancestorProject?: string }> = [{ rel: '', depth: 0 }];
  let truncated = false;
  while (queue.length > 0) {
    const next: typeof queue = [];
    for (const item of queue) {
      if (out.length >= MAX_DIRS || Date.now() - started > WALK_BUDGET_MS) { truncated = true; break; }
      let entries: import('fs').Dirent[];
      try { entries = await fs.readdir(path.join(root, item.rel), { withFileTypes: true }); } catch { continue; }
      const files = entries.filter(e => e.isFile()).map(e => e.name);
      const dirs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b));
      const entry: DirEntry = { rel: item.rel, depth: item.depth, files, dirs, ...(item.ancestorProject !== undefined ? { ancestorProject: item.ancestorProject } : {}) };
      out.push(entry);
      const isProject = manifestKinds(files).kinds.some(k => k !== 'Docker' && k !== 'Make')
        || (item.depth >= 1 && item.ancestorProject === undefined && files.some(file => README_FILE.test(file)));
      projectAt.set(item.rel, isProject);
      const ancestorForChildren = isProject ? item.rel || '.' : item.ancestorProject;
      if (item.depth < MAX_DEPTH) {
        for (const dir of dirs) next.push({ rel: item.rel ? `${item.rel}/${dir}` : dir, depth: item.depth + 1, ...(ancestorForChildren !== undefined ? { ancestorProject: ancestorForChildren } : {}) });
      }
    }
    if (truncated) break;
    queue = next;
  }
  return { dirs: out, truncated };
}

// ── Manifest / README facts ─────────────────────────────────────────────────

async function readHead(file: string, bytes: number): Promise<string | undefined> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      if (buffer.subarray(0, Math.min(bytesRead, 2_000)).includes(0)) return undefined;
      return buffer.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '');
    } finally { await handle.close(); }
  } catch { return undefined; }
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single;
}

function readmeSummary(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const heading = lines.find(line => /^#{1,3}\s+\S/.test(line))?.replace(/^#+\s+/, '');
  const paragraph = lines.find(line => line.length >= 20 && !/^[#>|`!\[<=\-*_~]/.test(line) && !/^\s*(?:https?:)/.test(line));
  const summary = [heading, paragraph].filter(Boolean).join(' — ');
  return summary ? clip(summary, 180) : undefined;
}

interface ManifestFacts { name?: string; description?: string; detail: string[] }

function tomlValue(text: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\r\\n]+)["']`, 'mi').exec(text)?.[1];
}

async function manifestFacts(dir: string, manifestNames: readonly string[]): Promise<{ facts: ManifestFacts; read: string[] }> {
  const facts: ManifestFacts = { detail: [] };
  const read: string[] = [];
  for (const manifest of manifestNames) {
    const lower = manifest.toLowerCase();
    const text = await readHead(path.join(dir, manifest), MANIFEST_READ_BYTES);
    if (text === undefined) continue;
    read.push(manifest);
    if (lower === 'package.json') {
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        if (typeof json['name'] === 'string') facts.name ??= json['name'];
        if (typeof json['description'] === 'string') facts.description ??= clip(json['description'], 140);
        const deps = Object.keys({ ...(json['dependencies'] as object | undefined), ...(json['devDependencies'] as object | undefined) });
        const notable = ['typescript', 'react', 'vue', 'svelte', 'next', 'express', 'fastify', 'vite', 'electron', 'vscode', 'vitest', 'jest', 'webpack', 'esbuild', 'angular']
          .filter(candidate => deps.some(dep => dep === candidate || dep.endsWith(`/${candidate}`) || dep === `@types/${candidate}`));
        if (notable.length) facts.detail.push(`uses ${notable.slice(0, 5).join(', ')}`);
        const scripts = Object.keys((json['scripts'] as object | undefined) ?? {});
        if (scripts.length) facts.detail.push(`scripts: ${scripts.slice(0, 5).join(', ')}`);
      } catch { /* truncated or invalid JSON: the file is still a marker */ }
    } else if (lower === 'pyproject.toml') {
      facts.name ??= tomlValue(text, 'name');
      const description = tomlValue(text, 'description');
      if (description) facts.description ??= clip(description, 140);
    } else if (lower === 'cargo.toml') {
      facts.name ??= tomlValue(text, 'name');
      const description = tomlValue(text, 'description');
      if (description) facts.description ??= clip(description, 140);
    } else if (lower === 'go.mod') {
      facts.name ??= /^\s*module\s+(\S+)/m.exec(text)?.[1];
    } else if (lower === 'pom.xml') {
      facts.name ??= /<artifactId>([^<]+)<\/artifactId>/.exec(text.replace(/<parent>[\s\S]*?<\/parent>/, ''))?.[1];
    } else if (lower.startsWith('requirements')) {
      const packages = text.split(/\r?\n/).map(line => /^([A-Za-z0-9_.-]+)/.exec(line.trim())?.[1]).filter((value): value is string => Boolean(value));
      if (packages.length) facts.detail.push(`requires ${packages.slice(0, 6).join(', ')}`);
    }
  }
  return { facts, read };
}

// ── Project recognition ─────────────────────────────────────────────────────

interface ProjectCandidate { entry: DirEntry; manifestNames: string[]; kinds: string[]; hasManifest: boolean; confidence: InventoryProject['confidence'] }

/** Which walked folders are projects, strongest markers first. Uncapped: callers decide how many to show. */
function recogniseProjects(dirs: readonly DirEntry[]): ProjectCandidate[] {
  const candidates: ProjectCandidate[] = [];
  for (const entry of dirs) {
    const { kinds, names } = manifestKinds(entry.files);
    const hasManifest = kinds.some(kind => kind !== 'Docker' && kind !== 'Make');
    const codeFiles = entry.files.filter(file => CODE_EXTENSIONS[path.extname(file).toLowerCase()]);
    const unclaimed = !hasManifest && entry.depth >= 1 && entry.ancestorProject === undefined;
    const readmeProject = unclaimed && entry.files.some(file => README_FILE.test(file));
    const sourceFolder = unclaimed && !readmeProject && codeFiles.length >= 2;
    if (hasManifest || readmeProject || sourceFolder || (entry.depth === 0 && kinds.length > 0)) {
      candidates.push({
        entry, manifestNames: names, hasManifest,
        kinds: hasManifest ? kinds : languageSummary(entry.files),
        confidence: hasManifest || (entry.depth === 0 && kinds.length > 0) ? 'manifest' : readmeProject ? 'readme' : 'inferred',
      });
    }
  }
  // Strong markers first, so a safety cap drops weak guesses before real projects.
  candidates.sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || a.entry.depth - b.entry.depth || a.entry.rel.localeCompare(b.entry.rel));
  return candidates;
}

export interface ProjectRoot {
  /** Workspace-relative POSIX path ('.' for the workspace root itself). */
  path: string;
  kinds: string[];
  confidence: InventoryProject['confidence'];
}

/**
 * Every recognised project root (same recognition as the inventory, without its display cap), from the bounded
 * directory walk only: no manifest or README is read. This is what repository computations aggregate against.
 */
export async function listProjectRoots(root: string): Promise<{ roots: ProjectRoot[]; truncated: boolean }> {
  const { dirs, truncated } = await walk(root);
  const roots = recogniseProjects(dirs).map(({ entry, kinds, confidence }) => ({ path: entry.rel || '.', kinds, confidence }));
  roots.sort((a, b) => a.path.localeCompare(b.path));
  return { roots, truncated };
}

// ── Inventory ───────────────────────────────────────────────────────────────

export async function buildWorkspaceInventory(root: string, maxChars: number, options: InventoryOptions = {}): Promise<WorkspaceInventory | undefined> {
  const { dirs, truncated } = await walk(root);
  if (dirs.length === 0) return undefined;
  const workspaceName = path.basename(root) || root;

  // 1. Decide which folders are projects.
  // Manifests and READMEs are project markers (high / medium confidence). "2+ source files" is only a fallback guess
  // (low confidence): it is ranked last, labelled as inferred, and never lists internal source directories of a
  // recognised project (the walk's `ancestorProject` already excludes those).
  const candidates = recogniseProjects(dirs);
  const shown = candidates.slice(0, MAX_PROJECTS);

  // 2. Read the few bytes that name and describe each project (manifest + README head), concurrently.
  const readFiles: Array<{ path: string; estimatedTokens: number }> = [];
  const projects: InventoryProject[] = await Promise.all(shown.map(async ({ entry, manifestNames, kinds, hasManifest, confidence }) => {
    const dir = path.join(root, entry.rel);
    const { facts, read } = await manifestFacts(dir, manifestNames);
    const readmeName = entry.files.find(file => README_FILE.test(file));
    const readmeText = readmeName ? await readHead(path.join(dir, readmeName), README_READ_BYTES) : undefined;
    for (const name of read) readFiles.push({ path: entry.rel ? `${entry.rel}/${name}` : name, estimatedTokens: 200 });
    if (readmeName && readmeText !== undefined) readFiles.push({ path: entry.rel ? `${entry.rel}/${readmeName}` : readmeName, estimatedTokens: 300 });
    const readme = readmeText ? readmeSummary(readmeText) : undefined;
    return {
      path: entry.rel || '.',
      kinds,
      ...(facts.name ? { name: facts.name } : {}),
      ...(facts.description ? { description: facts.description } : {}),
      ...(readme ? { readme } : {}),
      detail: facts.detail,
      entryFiles: entry.files.filter(file => ENTRY_NAMES.test(file)).slice(0, 3),
      hasManifest,
      confidence,
    };
  }));
  projects.sort((a, b) => a.path.localeCompare(b.path));

  // 3. Describe every top-level folder, grouping the projects found beneath it.
  const topLevel = dirs.filter(entry => entry.depth === 1);
  const rootEntry = dirs.find(entry => entry.depth === 0);
  const lineFor = (project: InventoryProject): string => {
    const parts = [`- ${project.path}`];
    const kind = project.kinds.length ? project.kinds.join(' + ') : '';
    const label = project.name && project.name !== path.posix.basename(project.path) ? ` "${project.name}"` : '';
    const basis = project.confidence === 'manifest' ? '' : project.confidence === 'readme' ? ' (README, no manifest)' : ' (inferred from source files only)';
    parts.push(` — ${kind || 'folder'}${basis}${label}`);
    const facts = [project.description, ...project.detail, project.entryFiles.length ? `entry: ${project.entryFiles.join(', ')}` : undefined,
      project.readme ? `README: ${project.readme}` : undefined].filter(Boolean);
    return facts.length ? `${parts.join('')}\n    ${facts.join(' | ')}` : parts.join('');
  };
  const rootProjectEntry = projects.find(project => project.path === '.');
  const rootProject = rootProjectEntry;
  const rootFiles = rootEntry ? rootEntry.files.filter(file => !file.startsWith('.')).slice(0, 12) : [];
  const plainFolder = (top: DirEntry): string => {
    const languages = languageSummary(top.files);
    const subfolders = top.dirs.length ? `${top.dirs.length} subfolder${top.dirs.length === 1 ? '' : 's'}` : '';
    const summary = [`${top.files.length} file${top.files.length === 1 ? '' : 's'}`, subfolders, languages.join('/')].filter(Boolean).join(', ');
    return `- ${top.rel}/ — folder, not a recognised project (${summary || 'empty'})`;
  };
  const underOf = (top: DirEntry) => projects.filter(project => project.path === top.rel || project.path.startsWith(`${top.rel}/`));

  const sections: string[] = [];
  let omitted = 0;
  if (rootProjectEntry) sections.push(lineFor(rootProjectEntry));
  if (options.full) {
    for (const top of topLevel) {
      const under = underOf(top);
      sections.push(under.length === 0 ? plainFolder(top) : under.map(lineFor).join('\n'));
    }
  } else {
    // Compact, hierarchical: one line per top-level area with its project count, then only its most informative
    // projects. Strong markers and projects that carry a description are the representatives; the rest are counted.
    const richness = (project: InventoryProject) => CONFIDENCE_RANK[project.confidence] * 10
      - (project.description || project.readme ? 3 : 0) - (project.name ? 1 : 0) + project.path.split('/').length;
    let listedTotal = rootProjectEntry ? 1 : 0;
    for (const top of topLevel) {
      const under = underOf(top);
      if (under.length === 0) continue;
      const languages = [...new Set(under.flatMap(project => project.kinds))].slice(0, 3).join(', ');
      const inferred = under.filter(project => project.confidence === 'inferred').length;
      const counts = `${under.length} project${under.length === 1 ? '' : 's'}`
        + (inferred === 0 ? '' : inferred === under.length ? ' (inferred from source files only)' : ` (${inferred} inferred from source files only)`);
      const room = Math.max(0, Math.min(COMPACT_PER_AREA, COMPACT_TOTAL - listedTotal));
      const representatives = [...under].sort((a, b) => richness(a) - richness(b) || a.path.localeCompare(b.path)).slice(0, room)
        .sort((a, b) => a.path.localeCompare(b.path));
      listedTotal += representatives.length;
      omitted += under.length - representatives.length;
      const lines = [`- ${top.rel}/ — ${counts}${languages ? `; ${languages}` : ''}`, ...representatives.map(lineFor).map(line => `  ${line.replace(/\n/g, '\n  ')}`)];
      if (under.length > representatives.length) lines.push(`  (+${under.length - representatives.length} more in ${top.rel}/ not listed)`);
      sections.push(lines.join('\n'));
    }
    const plain = topLevel.filter(top => underOf(top).length === 0);
    for (const top of plain.slice(0, COMPACT_PLAIN_FOLDERS)) sections.push(plainFolder(top));
    if (plain.length > COMPACT_PLAIN_FOLDERS) sections.push(`- (+${plain.length - COMPACT_PLAIN_FOLDERS} more folders that are not recognised projects)`);
  }

  const byConfidence = (kind: InventoryProject['confidence']) => projects.filter(project => project.confidence === kind).length;
  const header = `Workspace inventory collected by the host from the open workspace "${workspaceName}" (${root}). `
    + 'It lists the folders and project markers found within three directory levels; it is a structural inventory, not a read of every file. '
    + (options.full
      ? 'Present it as the answer: group the projects, say what each is from its manifest/README facts, and mention folders that are not projects. '
      : 'Answer with a compact hierarchical summary: the top-level project areas, the recognised project count, and the representative projects with one short description each. Do not list every project. ')
    + 'Projects recognised by a manifest are reliable; "README, no manifest" is likely; "inferred from source files only" is a weak guess and must be described as such. '
    + 'Never say you cannot access the workspace and never ask the user to paste anything. Do not invent details that are not listed here.';
  const stats = `Scanned ${dirs.length} folder${dirs.length === 1 ? '' : 's'}; ${projects.length} project${projects.length === 1 ? '' : 's'} recognised `
    + `(${byConfidence('manifest')} by manifest, ${byConfidence('readme')} by README, ${byConfidence('inferred')} inferred from source files only)`
    + `${candidates.length > shown.length ? `; ${candidates.length - shown.length} more not read` : ''}${truncated ? '; scan stopped at its safety limit' : ''}.`;
  const rootLine = `Workspace root files: ${rootFiles.length ? rootFiles.join(', ') : '(none)'}${rootProject ? '\nThe workspace root is itself a project (listed as ".").' : ''}`;
  const moreNote = !options.full && omitted > 0
    ? `\n\nI found ${omitted} more project${omitted === 1 ? '' : 's'} than are listed here. Tell the user so, and offer: "ask for the full inventory" to list them all.`
    : '';
  let body = sections.join('\n');
  const room = Math.max(1_500, maxChars - header.length - stats.length - rootLine.length - moreNote.length - 100);
  if (body.length > room) {
    const cut = body.slice(0, room);
    body = `${cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : room)}\n… (inventory truncated to fit the model's window)`;
  }
  const prompt = options.evidenceOnly
    ? [stats, rootLine, body].join('\n\n')
    : [header, stats, rootLine, '--- project areas and folders ---', body].join('\n\n') + moreNote;
  return { prompt, files: readFiles.slice(0, 24), projectCount: projects.length, folderCount: dirs.length, omittedProjects: omitted };
}
