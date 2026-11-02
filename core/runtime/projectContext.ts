/**
 * Active-project context — "this project" means the workspace the operator selected.
 *
 * A short question such as "What does this project do?" used to take the tool-less chat path, where
 * the only identity the model had was Pandesh's own, so it answered about KarkeDikha. This module is
 * the deterministic half of the fix: it resolves the selected workspace (and says exactly why it
 * cannot when it is missing or unreadable), reads a bounded, read-only set of project files, and
 * hands the model that evidence together with the project's identity.
 *
 * Read-only by construction: it lists directories and reads a few small text files. It never
 * follows symlinks out of the project, never reads `.env*` or key material, and redacts secret-looking
 * lines from anything it includes, so the evidence stays safe to place in a local model's prompt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProjectResolution =
  | { ok: true; root: string; name: string }
  | { ok: false; reason: 'no_workspace' | 'missing' | 'not_directory' | 'unreadable'; root?: string; message: string };

/** Verifies the selected workspace is a real, readable local directory. */
export function resolveActiveProject(workspaceRoot: string | null | undefined): ProjectResolution {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return { ok: false, reason: 'no_workspace', message: 'No workspace folder is selected, so there is no active project to inspect. Select a project folder and ask again.' };
  }
  const root = path.resolve(workspaceRoot);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { ok: false, reason: 'missing', root, message: `The selected workspace folder does not exist or is no longer available: ${root}. I did not inspect anything. Re-select the folder (or restore it) and ask again.` };
    }
    return { ok: false, reason: 'unreadable', root, message: `I cannot access the selected workspace folder ${root} (${err?.code ?? 'access error'}). I did not inspect anything.` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'not_directory', root, message: `The selected workspace ${root} is not a folder, so there is no project to inspect.` };
  }
  try {
    fs.readdirSync(root);
  } catch (err: any) {
    return { ok: false, reason: 'unreadable', root, message: `I cannot read the selected workspace folder ${root} (${err?.code ?? 'access error'}). I did not inspect anything.` };
  }
  return { ok: true, root, name: path.basename(root) || root };
}

const PROJECT_NOUN = '(?:project|repo|repository|codebase|code base|code|app|application|folder|directory|workspace|source)';
const DEICTIC_PROJECT = new RegExp(`\\b(?:this|the|current|active|selected|my|our)\\s+${PROJECT_NOUN}\\b|\\b(?:in|inside|from)\\s+here\\b|\\bhere\\b[^.?!]{0,20}\\b(?:what|which)\\b`, 'i');
const INSPECTION_QUESTION = /\b(?:what(?:'s| is| does| do)?|which|describe|explain|summari[sz]e|tell me|overview|purpose|about|written|language|languages|stack|framework|structure|contain|contains|run|start|launch|build|install|set ?up|use|entry ?point|main file|depend)/i;
const PRONOUN_FOLLOW_UP = /\b(?:what (?:language|languages|programming language)\b[^.?!]{0,30}\b(?:written|built|coded|use[sd]?)|written in|(?:tech(?:nology)?|programming)\s+stack|which (?:framework|language)s?|how (?:do|can|should|would) (?:i|we) (?:run|start|launch|build|install|set up|use)\s+(?:it|this|that|the (?:app|project|thing))|how (?:is|does) (?:it|this) (?:run|start|work|structured)|how to (?:run|start|launch|build|install) (?:it|this|the (?:app|project)))\b/i;

/** True when the request asks about the selected project itself ("this project", "here", "how do I run it"). */
export function isProjectInspectionRequest(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return false;
  if (DEICTIC_PROJECT.test(t) && INSPECTION_QUESTION.test(t)) return true;
  return PRONOUN_FOLLOW_UP.test(t);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '__pycache__', 'venv', '.venv', 'env', '.tox', 'target', '.next', '.idea', '.vscode', 'output', 'outputs', 'coverage', '.cache']);
const SENSITIVE_FILE = /^(?:\.env.*|.*\.(?:pem|key|p12|pfx|crt)|id_rsa.*|.*secrets?.*|credentials.*)$/i;
const SECRET_LINE = /(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|authorization|bearer)\s*[=:]/i;

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.py': 'Python', '.ts': 'TypeScript', '.tsx': 'TypeScript (React)', '.js': 'JavaScript', '.jsx': 'JavaScript (React)', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.java': 'Java', '.kt': 'Kotlin', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.cpp': 'C++', '.cc': 'C++', '.c': 'C', '.h': 'C/C++ header',
  '.swift': 'Swift', '.dart': 'Dart', '.lua': 'Lua', '.sh': 'Shell', '.ps1': 'PowerShell', '.bat': 'Batch', '.sql': 'SQL',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.vue': 'Vue', '.svelte': 'Svelte', '.ipynb': 'Jupyter Notebook',
};
/** Markup/style/script-glue counted separately so a Python app with an HTML page is still reported as Python first. */
const SECONDARY_LANGUAGES = new Set(['HTML', 'CSS', 'SCSS', 'Shell', 'PowerShell', 'Batch', 'SQL']);

const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'pubspec.yaml', 'CMakeLists.txt', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'];
const RUN_SCRIPTS = /^(?:launch|start|run|_start|serve|dev|boot)[\w.-]*\.(?:bat|cmd|ps1|sh)$/i;
const ENTRY_CANDIDATE = /^(?:main|app|index|server|cli|manage|run|start|__main__)\.(?:py|js|ts|mjs|go|rs|java|rb|php|html)$/i;

export interface ProjectFileRead {
  path: string;
  bytes: number;
  truncated: boolean;
}

export interface ProjectEvidence {
  root: string;
  name: string;
  topLevel: string[];
  readme?: { file: string; excerpt: string };
  manifests: Array<{ file: string; excerpt: string }>;
  runScripts: Array<{ file: string; excerpt: string }>;
  entryCandidates: string[];
  languages: Array<{ language: string; files: number }>;
  filesScanned: number;
  scanTruncated: boolean;
  filesRead: ProjectFileRead[];
}

function readBounded(full: string, maxChars: number): { text: string; bytes: number; truncated: boolean } | null {
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, maxChars * 4));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      let text = buf.subarray(0, n).toString('utf8');
      if (text.includes('\u0000')) return null;
      const truncated = stat.size > n || text.length > maxChars;
      if (text.length > maxChars) text = text.slice(0, maxChars);
      const redacted = text.split(/\r?\n/).map((line) => (SECRET_LINE.test(line) ? '[redacted line]' : line)).join('\n');
      return { text: redacted, bytes: stat.size, truncated };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function packageJsonSummary(raw: string): string {
  try {
    const pkg = JSON.parse(raw);
    return JSON.stringify({
      name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main, bin: pkg.bin,
      scripts: pkg.scripts, dependencies: Object.keys(pkg.dependencies ?? {}).slice(0, 25), devDependencies: Object.keys(pkg.devDependencies ?? {}).slice(0, 15),
    }, null, 2);
  } catch {
    return raw;
  }
}

/** Reads the project's identity files and structure. Bounded: a few small files and a capped directory walk. */
export function gatherProjectEvidence(root: string, limits: { maxFiles?: number; maxDepth?: number } = {}): ProjectEvidence {
  const maxFiles = limits.maxFiles ?? 1500;
  const maxDepth = limits.maxDepth ?? 4;
  const evidence: ProjectEvidence = {
    root, name: path.basename(root) || root, topLevel: [], manifests: [], runScripts: [], entryCandidates: [], languages: [], filesScanned: 0, scanTruncated: false, filesRead: [],
  };
  const record = (rel: string, r: { bytes: number; truncated: boolean }) => evidence.filesRead.push({ path: rel, bytes: r.bytes, truncated: r.truncated });

  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return evidence; }
  const visible = entries.filter((e) => !SENSITIVE_FILE.test(e.name));
  evidence.topLevel = visible
    .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 60);

  const files = visible.filter((e) => e.isFile());
  const readmeEntry = files.find((e) => /^readme(?:\.(?:md|markdown|txt|rst))?$/i.test(e.name));
  if (readmeEntry) {
    const r = readBounded(path.join(root, readmeEntry.name), 5000);
    if (r) { evidence.readme = { file: readmeEntry.name, excerpt: r.text }; record(readmeEntry.name, r); }
  }
  for (const name of MANIFESTS) {
    const hit = files.find((e) => e.name === name);
    if (!hit) continue;
    const r = readBounded(path.join(root, name), name === 'package.json' ? 20000 : 1800);
    if (!r) continue;
    evidence.manifests.push({ file: name, excerpt: name === 'package.json' ? packageJsonSummary(r.text) : r.text });
    record(name, r);
  }
  for (const e of files.filter((f) => /\.(?:csproj|sln)$/i.test(f.name)).slice(0, 2)) {
    const r = readBounded(path.join(root, e.name), 1200);
    if (r) { evidence.manifests.push({ file: e.name, excerpt: r.text }); record(e.name, r); }
  }
  for (const e of files.filter((f) => RUN_SCRIPTS.test(f.name)).slice(0, 4)) {
    const r = readBounded(path.join(root, e.name), 1500);
    if (r) { evidence.runScripts.push({ file: e.name, excerpt: r.text }); record(e.name, r); }
  }
  evidence.entryCandidates = files.filter((e) => ENTRY_CANDIDATE.test(e.name)).map((e) => e.name).slice(0, 8);

  // Language census over a capped, symlink-safe walk.
  const counts = new Map<string, number>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let children: fs.Dirent[];
    try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (!SKIP_DIRS.has(child.name) && !child.name.startsWith('.') && depth < maxDepth) stack.push({ dir: path.join(dir, child.name), depth: depth + 1 });
        continue;
      }
      if (!child.isFile()) continue;
      if (evidence.filesScanned >= maxFiles) { evidence.scanTruncated = true; stack.length = 0; break; }
      evidence.filesScanned += 1;
      const language = LANGUAGE_BY_EXT[path.extname(child.name).toLowerCase()];
      if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  evidence.languages = [...counts.entries()]
    .map(([language, n]) => ({ language, files: n }))
    .sort((a, b) => Number(SECONDARY_LANGUAGES.has(a.language)) - Number(SECONDARY_LANGUAGES.has(b.language)) || b.files - a.files)
    .slice(0, 8);
  return evidence;
}

function fence(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** The evidence as text for the model's system prompt. Identity first, so the model cannot substitute its own. */
export function formatProjectEvidenceForModel(ev: ProjectEvidence): string {
  const lines: string[] = [
    'ACTIVE PROJECT (verified by Core from the selected workspace — this is the project "this project", "this repo", "here" and "it" refer to):',
    `- Project name: ${ev.name}`,
    `- Project root: ${ev.root}`,
    '- This is NOT KarkeDikha/KKD/Pandesh (that is only your own product identity) unless the project root above is that product. Answer about THIS project, using only the evidence below.',
    `- Files Core read: ${ev.filesRead.map((f) => f.path).join(', ') || 'none'}`,
    `- Top-level contents: ${ev.topLevel.join(', ') || '(empty folder)'}`,
    `- Languages by file count (${ev.filesScanned} files scanned${ev.scanTruncated ? ', scan capped' : ''}): ${ev.languages.map((l) => `${l.language} ${l.files}`).join(', ') || 'no recognised source files'}`,
  ];
  if (ev.entryCandidates.length) lines.push(`- Likely entry points: ${ev.entryCandidates.join(', ')}`);
  if (ev.readme) lines.push(`\n--- ${ev.readme.file} ---\n${fence(ev.readme.excerpt, 4500)}`);
  for (const m of ev.manifests) lines.push(`\n--- ${m.file} ---\n${fence(m.excerpt, 1800)}`);
  for (const s of ev.runScripts) lines.push(`\n--- ${s.file} ---\n${fence(s.excerpt, 1500)}`);
  lines.push('\nRULES: state what the project is/does/uses from the evidence above and cite the file names. If the evidence does not say, say so — do not guess or ask which project. Use read_file/list_directory for anything deeper. Do not describe KarkeDikha or Pandesh as this project.');
  return lines.join('\n');
}

function readmeLead(ev: ProjectEvidence): string | undefined {
  if (!ev.readme) return undefined;
  const paragraphs = ev.readme.excerpt.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  const prose = paragraphs.find((p) => !/^#/.test(p) && p.length > 40) ?? paragraphs[0];
  return prose ? fence(prose, 700) : undefined;
}

function runHints(ev: ProjectEvidence): string[] {
  const hints: string[] = [];
  const pkg = ev.manifests.find((m) => m.file === 'package.json');
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg.excerpt).scripts ?? {}) as Record<string, string>;
      for (const key of ['start', 'dev', 'build', 'test']) if (scripts[key]) hints.push(`npm run ${key}  (package.json: ${scripts[key]})`);
    } catch { /* excerpt was not JSON */ }
  }
  if (ev.manifests.some((m) => m.file === 'requirements.txt')) hints.push('pip install -r requirements.txt  (requirements.txt)');
  for (const s of ev.runScripts) hints.push(`${s.file}  (run script present)`);
  const py = ev.entryCandidates.find((f) => f.endsWith('.py'));
  if (py) hints.push(`python ${py}  (entry-point candidate — not confirmed by a script)`);
  return hints;
}

/** Answer composed only from the evidence — used when the model's reply is not grounded in it, or cannot see it. */
export function composeEvidenceAnswer(ev: ProjectEvidence, question: string): string {
  const empty = ev.topLevel.length === 0;
  if (empty) return `The project "${ev.name}" (${ev.root}) is an empty folder, so there is nothing to describe yet.`;
  const lang = ev.languages.length
    ? `${ev.languages.map((l) => `${l.language} (${l.files} file${l.files === 1 ? '' : 's'})`).join(', ')}`
    : 'no recognised source files';
  const sources = `Evidence read from ${ev.root}: ${ev.filesRead.map((f) => f.path).join(', ') || 'directory listing only'}.`;
  if (/\b(?:language|written|stack|framework)/i.test(question)) {
    return `**${ev.name}** — languages by file count: ${lang}.${ev.manifests.length ? ` Manifests: ${ev.manifests.map((m) => m.file).join(', ')}.` : ''}\n\n${sources}`;
  }
  if (/\b(?:run|start|launch|build|install|set ?up)\b/i.test(question)) {
    const hints = runHints(ev);
    return hints.length
      ? `**${ev.name}** — from its files, to run it:\n${hints.map((h) => `- ${h}`).join('\n')}\n\n${sources}`
      : `**${ev.name}** — I found no run instructions, scripts or manifest I could confirm in ${ev.root}. Top-level contents: ${ev.topLevel.slice(0, 20).join(', ')}.\n\n${sources}`;
  }
  const lead = readmeLead(ev);
  return `**${ev.name}** (${ev.root})\n\n${lead ?? 'There is no README, so its purpose is not stated; the structure below is all I could verify.'}\n\nLanguages: ${lang}. Top-level: ${ev.topLevel.slice(0, 20).join(', ')}.\n\n${sources}`;
}

const ASKS_WHICH_PROJECT = /\b(?:which|what) (?:project|repo|repository|codebase)\b|\b(?:specify|clarify|tell me|let me know|provide)\b[^.?!]{0,40}\b(?:project|repo|repository|codebase|folder|workspace)\b|\b(?:no|not) (?:workspace|project) (?:is )?(?:selected|provided|specified)\b/i;
const OWN_IDENTITY = /\b(?:karkedikha|kkd|pandesh)\b/i;

/** The model's reply is acceptable only if it does not ask which project and does not substitute Pandesh's identity. */
export function isReplyGroundedInProject(reply: string, ev: ProjectEvidence): boolean {
  if (!reply.trim()) return false;
  if (ASKS_WHICH_PROJECT.test(reply)) return false;
  if (OWN_IDENTITY.test(reply)) {
    const known = [ev.name, ev.root, ev.readme?.excerpt ?? '', ...ev.manifests.map((m) => m.excerpt)].join('\n');
    if (!OWN_IDENTITY.test(known)) return false;
  }
  return true;
}

/** Prompts may only leave the machine's local model endpoint if the operator configured one; evidence never does. */
export function isLocalModelEndpoint(apiBase: string, model: string): boolean {
  if (/(?:^|[-:])cloud$/i.test(model)) return false;
  try {
    const host = new URL(apiBase).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}
