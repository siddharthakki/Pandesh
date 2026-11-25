/**
 * Local registry of AUTHORIZED projects (`<dataDir>/projects.json`). A project is something the owner explicitly registered:
 * canonical path(s), repository identity, what it can do, and which agents are preferred for it. Nothing here discovers
 * projects: there is no scan, no "recent folders", no default to whatever workspace happens to be open. A task that names a
 * project is resolved against this registry; if the name or path does not identify exactly one authorized project, the answer is
 * "ask", never a guess, and no filesystem permission is widened to find out.
 *
 * Repository identity is the root commit (stable across clones and worktrees), so a second checkout of the same repository is
 * the same project; it is only a second path when the owner says so.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from './errors';
import { runHardenedGit } from '../security/hardenedGit';

export type ProjectAccess = 'read' | 'read-write';

export interface ProjectRecord {
  id: string;
  /** Display and match name, e.g. `Pandesh`. */
  name: string;
  /** Other whole-word names the owner uses for it. */
  aliases: string[];
  /** Canonical (real, absolute) paths; the first is the main checkout. */
  paths: string[];
  repo: { identity: string | null; remote: string | null; defaultBranch: string | null };
  /** What work makes sense here, e.g. `node`, `vitest`, `git`, `typescript`. Informational for routing; never a permission. */
  capabilities: string[];
  /** Agent/executor ids in order of preference (`claude`, `opencode`, `hermes`, `native`). Advisory: consent rules still apply. */
  preferredAgents: string[];
  /** What a task may do here. `read` projects only ever run read-only work. */
  access: ProjectAccess;
  authorizedAt: string;
  authorizedBy: string;
}

export interface ProjectRegistryFile { version: 1; projects: ProjectRecord[] }

const FILE = 'projects.json';
/**
 * One spelling per folder, for comparing paths: absolute, real (symlinks/junctions and Windows 8.3 short names such as RUNNER~1
 * expanded to the long name the registry stores), no trailing separator, case-folded. A path whose tail does not exist yet keeps
 * that tail, appended to its nearest existing parent's real path. (CI 2026-11-23: GitHub's Windows runner temp folder is
 * C:\Users\RUNNER~1\..., registration stored the long real path, a task naming the short one was "unauthorized".)
 */
function pathKey(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { head = path.join(fs.realpathSync.native(head), ...tail); break; } catch { /* not there (yet): try its parent */ }
    const parent = path.dirname(head);
    if (parent === head) { head = path.join(head, ...tail); break; }
    tail.unshift(path.basename(head)); head = parent;
  }
  return head.replace(/[\\/]+$/, '').toLowerCase();
}

function file(dataDir: string): string { return path.join(dataDir, FILE); }

export function loadProjects(dataDir: string): ProjectRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(dataDir), 'utf8')) as Partial<ProjectRegistryFile>;
    return Array.isArray(raw.projects) ? raw.projects.filter(p => p && typeof p.id === 'string' && Array.isArray(p.paths)) : [];
  } catch { return []; }
}

function save(dataDir: string, projects: ProjectRecord[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file(dataDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects } satisfies ProjectRegistryFile, null, 2));
  fs.renameSync(tmp, file(dataDir));
}

function git(args: string[], cwd: string): string | null {
  try {
    const r = runHardenedGit(args, { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    return r.status === 0 ? String(r.stdout ?? '').trim() : null;
  } catch { return null; }
}

/** Repository identity of a checkout, read-only (rev-list, config, rev-parse). */
export function repoIdentity(dir: string): ProjectRecord['repo'] {
  const roots = git(['rev-list', '--max-parents=0', 'HEAD'], dir);
  const remote = git(['config', '--get', 'remote.origin.url'], dir);
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return { identity: roots ? roots.split(/\r?\n/)[0]!.trim() : null, remote: remote || null, defaultBranch: head && head !== 'HEAD' ? head : null };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,48}$/;

export interface RegisterProjectInput {
  name: string; path: string; aliases?: string[]; capabilities?: string[]; preferredAgents?: string[]; access?: ProjectAccess;
  /** Explicitly add this path to the existing project with the same repository identity (another checkout/worktree). */
  asAdditionalPath?: boolean; authorizedBy: string;
}

/** Registers an authorized project. Only the Pandesh app calls this; the HTTP layer enforces that. */
export function registerProject(dataDir: string, input: RegisterProjectInput): ProjectRecord {
  if (!NAME.test(input.name)) throw new CoreError('invalid_request', 'project name must be 2-49 characters: letters, digits, space, dot, dash or underscore');
  let canonical: string;
  try { canonical = fs.realpathSync.native(path.resolve(input.path)); } catch { throw new CoreError('invalid_request', `project path does not exist: ${input.path}`); }
  if (!fs.statSync(canonical).isDirectory()) throw new CoreError('invalid_request', 'project path must be a folder');
  if (/^[A-Za-z]:\\?$/.test(canonical)) throw new CoreError('invalid_request', 'a drive root cannot be a project');
  const projects = loadProjects(dataDir);
  const repo = repoIdentity(canonical);
  const key = pathKey(canonical);
  // A path may belong to one project only: no nesting two authorized projects on top of each other without saying so.
  for (const p of projects) {
    for (const existing of p.paths) {
      const ek = pathKey(existing);
      if (ek === key) throw new CoreError('conflict', `that folder is already authorized as project '${p.name}'`);
      if (key.startsWith(ek + path.sep) || ek.startsWith(key + path.sep)) throw new CoreError('conflict', `that folder overlaps project '${p.name}' (${existing}); register one or the other`);
    }
  }
  const sameRepo = repo.identity ? projects.find(p => p.repo.identity === repo.identity) : undefined;
  if (sameRepo && !input.asAdditionalPath) throw new CoreError('conflict', `that repository is already project '${sameRepo.name}'; register it as an additional path of that project explicitly`);
  const nameClash = projects.find(p => p.name.toLowerCase() === input.name.toLowerCase());
  if (nameClash && nameClash !== sameRepo) throw new CoreError('conflict', `a different project is already called '${nameClash.name}'`);
  const clean = (xs: string[] | undefined) => [...new Set((xs ?? []).map(x => String(x).trim()).filter(Boolean))].slice(0, 20);
  let record: ProjectRecord;
  if (sameRepo) {
    sameRepo.paths.push(canonical);
    sameRepo.aliases = clean([...sameRepo.aliases, ...(input.aliases ?? [])]);
    record = sameRepo;
  } else {
    record = {
      id: `prj_${randomUUID().replace(/-/g, '').slice(0, 16)}`, name: input.name.trim(), aliases: clean(input.aliases), paths: [canonical], repo,
      capabilities: clean(input.capabilities), preferredAgents: clean(input.preferredAgents), access: input.access === 'read-write' ? 'read-write' : 'read',
      authorizedAt: new Date().toISOString(), authorizedBy: input.authorizedBy,
    };
    projects.push(record);
  }
  save(dataDir, projects);
  return record;
}

export function removeProject(dataDir: string, id: string): boolean {
  const projects = loadProjects(dataDir);
  const next = projects.filter(p => p.id !== id);
  if (next.length === projects.length) return false;
  save(dataDir, next);
  return true;
}

// ---------------------------------------------------------------- resolution

export type ProjectResolution =
  | { status: 'none' }
  | { status: 'resolved'; project: ProjectRecord; path: string; via: 'path' | 'name'; ref: string | null; readOnlyRequested: boolean }
  | { status: 'ambiguous'; candidates: Array<{ id: string; name: string; paths: string[] }>; question: string }
  | { status: 'unauthorized'; path: string; question: string }
  /** The task says outright which project it is for ("the project named X"), and no project of that name is registered. */
  | { status: 'unregistered'; name: string; question: string };

const WINDOWS_PATH = /[A-Za-z]:[\\/][^\s"'`<>|?*]*[^\s"'`<>|?*.,;:!)]/g;
const REF = /\b(?:on|branch|at|off(?:\s+of)?)\s+(?:the\s+)?(?:branch\s+)?([A-Za-z0-9][A-Za-z0-9._/-]{1,80}\/[A-Za-z0-9._/-]{1,80}|main|master|develop)\b/i;
const READ_ONLY = /\b(do not modify|don't modify|without modifying|read[- ]only|no changes|do not change|do not edit)\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const QUOTE = '["\'`“”‘’]';
const QUOTED_NAME = `${QUOTE}([^"'\`“”‘’]{2,49})${QUOTE}`;
/** Ways a task says outright which project it is for. Deliberately narrow: a quoted name, or the word right after "named"/"called". */
const DECLARED: RegExp[] = [
  new RegExp(`\\bproject\\s+(?:named|called|name\\s*[:=]?)\\s*${QUOTED_NAME}`, 'i'),
  new RegExp(`\\b(?:registered|authori[sz]ed)\\s+project\\s*[:=]?\\s*${QUOTED_NAME}`, 'i'),
  /\bproject\s+(?:named|called)\s+([A-Za-z0-9][A-Za-z0-9._-]{1,48})(?![\w-])/i,
];
/** A line that is only `Project: Name`. */
const DECLARED_LINE = /^[ \t]*project[ \t]*[:=][ \t]*["'`“‘]?([A-Za-z0-9][A-Za-z0-9 ._-]{1,48}?)["'`”’]?[ \t]*$/im;
const NOT_A_NAME = new Set(['after', 'for', 'in', 'on', 'the', 'a', 'an', 'by', 'as', 'it', 'this', 'that', 'something', 'whatever']);

/**
 * The project a task names outright (`the registered project named "Pandesh"`, `project called Calc`, a line `Project: Calc`), or
 * null when it only mentions names in passing. An explicit name is binding: it resolves to exactly that registered project or to
 * nothing, never to another project that happens to be mentioned (live failure 2026-11-23, ptask_9902d8ad: `PROJECT NAMED "Pandesh"
 * (not CalcDemo)` on a PC where only CalcDemo was registered ran in CalcDemo).
 */
export function declaredProjectName(instruction: string): string | null {
  const flat = instruction.replace(/\s+/g, ' ');
  for (const re of DECLARED) {
    const name = re.exec(flat)?.[1]?.trim();
    if (name && !NOT_A_NAME.has(name.toLowerCase())) return name;
  }
  return DECLARED_LINE.exec(instruction)?.[1]?.trim() || null;
}

/** Wording that rules a project OUT: "not CalcDemo", "rather than the Ledger project", "instead of Calc". */
const RULED_OUT = new RegExp(`(?:\\bnot|\\bnever|\\brather than|\\binstead of|\\bother than|\\bunlike|\\bexcluding|\\bexcept(?: for)?)\\s+(?:(?:in|on|for|the|project|named|called)\\s+)*${QUOTE}?$`, 'i');

/** Whether the text mentions this name at least once in a way that does not rule it out. */
function mentioned(text: string, name: string): boolean {
  const whole = new RegExp(`(?<![\\w-])${esc(name)}(?![\\w-])`, 'gi');
  for (let m = whole.exec(text); m; m = whole.exec(text)) if (!RULED_OUT.test(text.slice(0, m.index))) return true;
  return false;
}

/**
 * Which authorized project does this instruction mean?
 * - an explicit path inside exactly one authorized project -> that project (deepest wins is moot: paths cannot nest);
 * - an explicit path inside none -> `unauthorized` (it is NOT searched, registered or read; the owner is asked);
 * - names/aliases matched as whole words: one project -> resolved, several -> `ambiguous`; none -> `none`.
 * `none` means the instruction does not reference a registered project at all (the caller keeps its normal isolated behaviour).
 * The currently open workspace is deliberately not an input: it never decides which project a task means.
 */
export function resolveProject(projects: ProjectRecord[], instruction: string): ProjectResolution {
  const text = instruction.replace(/\s+/g, ' ');
  const ref = REF.exec(text)?.[1]?.replace(/[./-]+$/, '') ?? null;
  const readOnlyRequested = READ_ONLY.test(text);
  const paths = [...new Set(text.match(WINDOWS_PATH) ?? [])];
  const hits = new Map<string, { project: ProjectRecord; path: string }>();
  const stray: string[] = [];
  for (const raw of paths) {
    const k = pathKey(raw);
    const owner = projects.find(p => p.paths.some(pp => { const pk = pathKey(pp); return k === pk || k.startsWith(pk + path.sep); }));
    if (owner) hits.set(owner.id, { project: owner, path: owner.paths.find(pp => { const pk = pathKey(pp); return k === pk || k.startsWith(pk + path.sep); })! });
    else stray.push(raw);
  }
  // A project named outright is binding: exactly that registered project, or nothing. Other names in the text never stand in for it.
  const declared = declaredProjectName(instruction);
  if (declared) {
    const want = declared.toLowerCase();
    const match = projects.find(p => [p.name, ...p.aliases].some(n => n.toLowerCase() === want));
    if (!match) {
      return { status: 'unregistered', name: declared, question: `This task names the project '${declared}', and no project of that name is registered in Pandesh on this PC. Nothing was copied, started or sent, and no other project was used in its place. Register '${declared}' in Pandesh with the access this task needs, then send the task again.` };
    }
    const elsewhere = [...hits.values()].filter(h => h.project.id !== match.id);
    if (elsewhere.length) {
      return { status: 'ambiguous', candidates: [match, ...elsewhere.map(h => h.project)].map(p => ({ id: p.id, name: p.name, paths: p.paths })), question: `This task names the project '${match.name}' but gives a path in ${elsewhere.map(h => h.project.name).join(', ')}. Which one is it about?` };
    }
    if (stray.length) {
      return { status: 'unauthorized', path: stray[0]!, question: `${stray[0]} is not an authorized project. Register it in Pandesh first (nothing was searched or read), or name an authorized project.` };
    }
    const hit = hits.get(match.id);
    return { status: 'resolved', project: match, path: hit?.path ?? match.paths[0]!, via: hit ? 'path' : 'name', ref, readOnlyRequested };
  }
  if (hits.size > 1) {
    return { status: 'ambiguous', candidates: [...hits.values()].map(h => ({ id: h.project.id, name: h.project.name, paths: h.project.paths })), question: `This task names paths in ${hits.size} different projects (${[...hits.values()].map(h => h.project.name).join(', ')}). Which one is it about?` };
  }
  if (hits.size === 1) {
    const h = [...hits.values()][0]!;
    return { status: 'resolved', project: h.project, path: h.path, via: 'path', ref, readOnlyRequested };
  }
  if (stray.length) {
    return { status: 'unauthorized', path: stray[0]!, question: `${stray[0]} is not an authorized project. Register it in Pandesh first (nothing was searched or read), or name an authorized project.` };
  }
  // A name the task rules out ("not CalcDemo") is not a reference to that project.
  const named = projects.filter(p => [p.name, ...p.aliases].some(n => mentioned(text, n)));
  if (named.length === 1) return { status: 'resolved', project: named[0]!, path: named[0]!.paths[0]!, via: 'name', ref, readOnlyRequested };
  if (named.length > 1) {
    return { status: 'ambiguous', candidates: named.map(p => ({ id: p.id, name: p.name, paths: p.paths })), question: `Which project do you mean: ${named.map(p => p.name).join(' or ')}?` };
  }
  return { status: 'none' };
}

/** Whether this project's authorization allows the requested kind of work. */
export function projectAllows(project: ProjectRecord, readOnly: boolean): { ok: true } | { ok: false; reason: string } {
  if (readOnly || project.access === 'read-write') return { ok: true };
  return { ok: false, reason: `Project '${project.name}' is authorized read-only; this task may change files. Ask for a read-only task or have the owner grant write access.` };
}
