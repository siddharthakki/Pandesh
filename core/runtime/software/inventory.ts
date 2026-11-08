/**
 * Software Discovery (read-only) — what is installed on this PC, how it was
 * installed, and where its authoritative upstream lives.
 *
 * Rules (owner brief "Software Discovery & Update Manager", milestone 1B):
 * - Read-only. Collectors only list and read; git runs with
 *   `--no-optional-locks` so even `status` never rewrites the index. Nothing
 *   here installs, updates, fetches, pulls, stops or starts anything.
 * - Local only. Inventory makes no network request except to local services
 *   (Ollama on 127.0.0.1). Update metadata lives in ./updates.ts.
 * - An upstream is recorded only from evidence on this machine: a git remote,
 *   a package's own metadata. A similar-looking project name is never a match;
 *   an item without such evidence has no upstream, and a URL that is not an
 *   exact repository address stays `verified: false`.
 * - Every collector can fail on its own (tool absent, daemon down, timeout);
 *   its section then says why instead of silently reporting nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultExec, type ExecRunner } from '../capabilityInventory';

export type InstallMethod = 'git' | 'winget' | 'scoop' | 'choco' | 'pip' | 'uv' | 'npm' | 'docker' | 'installer' | 'ollama' | 'windows_service' | 'unknown';
export type ItemKind = 'program' | 'python_package' | 'node_package' | 'uv_tool' | 'docker_container' | 'docker_image' | 'model' | 'git_repo' | 'python_environment';

export interface Upstream {
  /** Canonical URL, e.g. https://github.com/owner/repo */
  url: string;
  /** owner/repo when the URL is a GitHub repository. */
  github: string | null;
  /** True only when the URL came from local evidence that names this exact repository. */
  verified: boolean;
  /** Where the URL came from, in words. */
  basis: string;
}

export interface SoftwareItem {
  id: string;
  kind: ItemKind;
  name: string;
  version: string | null;
  installMethod: InstallMethod;
  installPath: string | null;
  /** Package-manager identifier when there is one (winget id, pip name …). */
  packageId: string | null;
  upstream: Upstream | null;
  /** Collector that reported it. */
  source: string;
  details: Record<string, string | number | boolean | null>;
}

export interface GitRepoState {
  path: string;
  remotes: Array<{ name: string; url: string }>;
  branch: string | null;
  headSha: string | null;
  describe: string | null;
  modified: number;
  untracked: number;
  /** Commits on HEAD not on its upstream branch / on upstream not in HEAD (local refs only; no fetch). */
  ahead: number | null;
  behind: number | null;
  hasUpstreamBranch: boolean;
  /** HEAD is contained in some remote-tracking branch, i.e. it has been pushed. */
  headPushed: boolean;
  worktrees: number;
  branches: number;
}

export interface ListeningPort {
  port: number;
  address: string;
  pid: number;
  processName: string | null;
  executablePath: string | null;
  /** Name of the Pandesh-managed service registered on this port, if any. */
  pandeshService: string | null;
  /** Windows service hosted by this process, if any. */
  windowsService: string | null;
}

export interface WindowsServiceEntry {
  name: string;
  displayName: string;
  state: string;
  startMode: string;
  pid: number | null;
  path: string | null;
}

export interface SectionStatus { id: string; label: string; available: boolean; reason: string | null; count: number; durationMs: number }

export interface SoftwareInventory {
  generatedAt: string;
  sections: SectionStatus[];
  items: SoftwareItem[];
  ports: ListeningPort[];
  services: WindowsServiceEntry[];
  repositories: GitRepoState[];
  scanRoots: string[];
}

export interface InventoryDeps {
  exec?: ExecRunner;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  ollamaUrl?: string;
  scanRoots?: string[];
  now?: () => Date;
}

// ---------- pure helpers (unit-tested) ----------

/** Parses a git remote URL into owner/repo when, and only when, it addresses github.com exactly. */
export function parseGithubRemote(url: string): string | null {
  const u = url.trim();
  const m = u.match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  if (m[2] === '' || m[1] === '') return null;
  return `${m[1]}/${m[2]}`;
}

/** An exact GitHub repository URL inside package metadata (homepage / repository / project URLs). Paths below the repo root are trimmed; anything else is not a repository URL. */
export function githubFromMetadataUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().replace(/^git\+/, '').replace(/#.*$/, '');
  const m = s.match(/^(?:https?|git|ssh):\/\/(?:git@)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob|releases|issues|wiki)(?:\/.*)?)?\/?$/i)
    ?? s.match(/^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i)
    ?? s.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function upstreamFromGithub(github: string, basis: string): Upstream {
  return { url: `https://github.com/${github}`, github, verified: true, basis };
}

/** Lines of `git status --porcelain=v1`: modified/staged vs untracked. */
export function countPorcelain(stdout: string): { modified: number; untracked: number } {
  let modified = 0;
  let untracked = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('??')) untracked++; else modified++;
  }
  return { modified, untracked };
}

/** A program that could not be started at all (ENOENT, or Windows' "not recognized") is simply not installed. */
function notInstalled(r: { code: number | null; stdout: string; stderr: string }): boolean {
  return (r.code === null && !r.stdout.trim()) || /not recognized|ENOENT|cannot find the file/i.test(r.stderr);
}

function json<T>(text: string, fallback: T): T {
  try { const t = text.trim(); return t ? JSON.parse(t) as T : fallback; } catch { return fallback; }
}
function arr<T>(v: T | T[] | null | undefined): T[] { return v == null ? [] : Array.isArray(v) ? v : [v]; }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

// ---------- collectors ----------

interface Ctx { exec: ExecRunner; fetchFn: typeof fetch; env: NodeJS.ProcessEnv; dataDir: string | null; ollamaUrl: string; roots: string[] }
type Collected = Partial<Pick<SoftwareInventory, 'items' | 'ports' | 'services' | 'repositories'>>;

async function collectPortsAndServices(c: Ctx): Promise<Collected> {
  const script = [
    '$c = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess)',
    '$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath)',
    '$s = @(Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,ProcessId,PathName)',
    '@{ conns = $c; procs = $p; svcs = $s } | ConvertTo-Json -Depth 3 -Compress',
  ].join('; ');
  const r = await c.exec('powershell.exe', [...PS, script], 45_000);
  if (r.code !== 0) throw new Error(`PowerShell could not list ports and services: ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}`);
  const data = json<{ conns?: unknown; procs?: unknown; svcs?: unknown }>(r.stdout, {});
  const procs = new Map<number, { name: string | null; exe: string | null }>();
  for (const p of arr(data.procs as Array<{ ProcessId: number; Name?: string; ExecutablePath?: string }>)) procs.set(Number(p.ProcessId), { name: p.Name ?? null, exe: p.ExecutablePath ?? null });
  const services: WindowsServiceEntry[] = arr(data.svcs as Array<{ Name: string; DisplayName?: string; State?: string; StartMode?: string; ProcessId?: number; PathName?: string }>).map((s) => ({
    name: s.Name, displayName: s.DisplayName ?? s.Name, state: s.State ?? 'Unknown', startMode: s.StartMode ?? 'Unknown', pid: s.ProcessId ? Number(s.ProcessId) : null, path: s.PathName ?? null,
  }));
  const svcByPid = new Map<number, string>();
  for (const s of services) if (s.pid && s.state === 'Running') svcByPid.set(s.pid, svcByPid.has(s.pid) ? `${svcByPid.get(s.pid)}, ${s.displayName}` : s.displayName);
  const managed = readManagedServices(c.dataDir);
  const seen = new Set<string>();
  const ports: ListeningPort[] = [];
  for (const k of arr(data.conns as Array<{ LocalAddress: string; LocalPort: number; OwningProcess: number }>)) {
    const key = `${k.LocalAddress}:${k.LocalPort}:${k.OwningProcess}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const proc = procs.get(Number(k.OwningProcess));
    ports.push({
      port: Number(k.LocalPort), address: String(k.LocalAddress), pid: Number(k.OwningProcess),
      processName: proc?.name ?? null, executablePath: proc?.exe ?? null,
      pandeshService: managed.find((m) => m.port === Number(k.LocalPort) && (m.pid == null || m.pid === Number(k.OwningProcess)))?.name ?? null,
      windowsService: svcByPid.get(Number(k.OwningProcess)) ?? null,
    });
  }
  ports.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
  return { ports, services };
}

function readManagedServices(dataDir: string | null): Array<{ name: string; port: number; pid: number | null }> {
  if (!dataDir) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'port-manager-registry.json'), 'utf8')) as Array<{ name?: string; port?: number; pid?: number | null }>;
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.port === 'number').map((r) => ({ name: String(r.name ?? 'service'), port: Number(r.port), pid: r.pid ?? null })) : [];
  } catch { return []; }
}

async function collectInstalledPrograms(c: Ctx): Promise<Collected> {
  const script = [
    "$k = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    '@(Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } | Select-Object DisplayName,DisplayVersion,Publisher,InstallLocation,URLInfoAbout,PSChildName) | ConvertTo-Json -Depth 2 -Compress',
  ].join('; ');
  const r = await c.exec('powershell.exe', [...PS, script], 45_000);
  if (r.code !== 0) throw new Error(`could not read installed programs: ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}`);
  const seen = new Set<string>();
  const items: SoftwareItem[] = [];
  for (const p of arr(json<unknown>(r.stdout, []) as Array<{ DisplayName: string; DisplayVersion?: string; Publisher?: string; InstallLocation?: string; URLInfoAbout?: string; PSChildName?: string }>)) {
    const key = `${p.DisplayName}|${p.DisplayVersion ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gh = githubFromMetadataUrl(p.URLInfoAbout);
    items.push({
      id: `program:${slug(p.DisplayName)}`, kind: 'program', name: p.DisplayName, version: p.DisplayVersion ?? null, installMethod: 'installer',
      installPath: p.InstallLocation ? String(p.InstallLocation).replace(/[\\/]+$/, '') || null : null, packageId: null,
      // An installer's "about" URL is the vendor's claim, not a repository match: keep it unverified.
      upstream: gh ? { url: `https://github.com/${gh}`, github: gh, verified: false, basis: 'installer "about" URL (vendor-stated, unverified)' }
        : p.URLInfoAbout ? { url: String(p.URLInfoAbout), github: null, verified: false, basis: 'installer "about" URL (vendor-stated)' } : null,
      source: 'Windows installed programs', details: { publisher: p.Publisher ?? null },
    });
  }
  return { items };
}

/** `winget export` gives exact package ids and versions without accepting anything on the user's behalf. */
async function collectWinget(c: Ctx): Promise<Collected> {
  const tmp = path.join(c.env.TEMP || c.env.TMP || '.', `pandesh-winget-export-${process.pid}-${Date.now()}.json`);
  try {
    const r = await c.exec('winget', ['export', '-o', tmp, '--include-versions', '--disable-interactivity'], 120_000);
    if (!fs.existsSync(tmp)) throw new Error(`winget export produced no file (${(r.stderr || r.stdout).trim().slice(0, 160) || `exit ${r.code}`})`);
    const data = json<{ Sources?: Array<{ SourceDetails?: { Name?: string }; Packages?: Array<{ PackageIdentifier: string; Version?: string }> }> }>(fs.readFileSync(tmp, 'utf8'), {});
    const items: SoftwareItem[] = [];
    for (const src of data.Sources ?? []) for (const p of src.Packages ?? []) {
      items.push({ id: `winget:${p.PackageIdentifier}`, kind: 'program', name: p.PackageIdentifier, version: p.Version ?? null, installMethod: 'winget', installPath: null, packageId: p.PackageIdentifier, upstream: null, source: `winget (${src.SourceDetails?.Name ?? 'source'})`, details: {} });
    }
    return { items };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* not created */ }
  }
}

async function collectScoop(c: Ctx): Promise<Collected> {
  const r = await c.exec('cmd.exe', ['/d', '/s', '/c', 'scoop export'], 60_000);
  if (r.code !== 0) throw new Error(/not recognized|not found/i.test(r.stderr + r.stdout) ? 'Scoop is not installed' : `scoop export failed: ${r.stderr.trim().slice(0, 160)}`);
  const data = json<{ apps?: Array<{ Name: string; Version?: string; Source?: string }> }>(r.stdout, {});
  return { items: (data.apps ?? []).map((a) => ({ id: `scoop:${a.Name}`, kind: 'program' as const, name: a.Name, version: a.Version ?? null, installMethod: 'scoop' as const, installPath: c.env.USERPROFILE ? path.join(c.env.USERPROFILE, 'scoop', 'apps', a.Name, 'current') : null, packageId: a.Name, upstream: null, source: `scoop (${a.Source ?? 'bucket'})`, details: {} })) };
}

async function collectChoco(c: Ctx): Promise<Collected> {
  const r = await c.exec('choco', ['list', '--limit-output'], 60_000);
  if (r.code !== 0) throw new Error(notInstalled(r) ? 'Chocolatey is not installed' : `choco list failed: ${(r.stderr || r.stdout).trim().slice(0, 160) || `exit ${r.code}`}`);
  const items = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[^|\s]+\|[^|]+$/.test(l)).map((l) => {
    const [name, version] = l.split('|');
    return { id: `choco:${name}`, kind: 'program' as const, name, version, installMethod: 'choco' as const, installPath: null, packageId: name, upstream: null, source: 'Chocolatey', details: {} };
  });
  return { items };
}

const PY_PROBE = [
  'import json, sys, importlib.metadata as m',
  'out = []',
  'for d in m.distributions():',
  '    md = d.metadata',
  "    urls = [md.get('Home-page') or ''] + [u.split(',', 1)[-1].strip() for u in (md.get_all('Project-URL') or [])]",
  "    out.append({'name': md.get('Name'), 'version': d.version, 'urls': [u for u in urls if u]})",
  "print(json.dumps({'exe': sys.executable, 'version': sys.version.split()[0], 'prefix': sys.prefix, 'packages': out}))",
].join('\n');

/** Python interpreters from the launcher (`py -0p`) plus `python` on PATH; packages from each one's own metadata. */
async function collectPython(c: Ctx): Promise<Collected> {
  const exes = new Set<string>();
  const launcher = await c.exec('py', ['-0p'], 15_000).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (launcher.code === 0) for (const line of launcher.stdout.split(/\r?\n/)) { const m = line.match(/([A-Za-z]:\\[^\r\n]*python[w]?\.exe)\s*$/i); if (m) exes.add(m[1].trim()); }
  const where = await c.exec('where.exe', ['python'], 10_000).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (where.code === 0) for (const line of where.stdout.split(/\r?\n/)) { const p = line.trim(); if (p && !/WindowsApps/i.test(p)) exes.add(p); }
  if (exes.size === 0) throw new Error('no Python interpreter found');
  const items: SoftwareItem[] = [];
  const seenPrefix = new Set<string>();
  for (const exe of exes) {
    const r = await c.exec(exe, ['-I', '-c', PY_PROBE], 60_000);
    if (r.code !== 0) continue;
    const d = json<{ exe: string; version: string; prefix: string; packages: Array<{ name: string; version: string; urls: string[] }> }>(r.stdout, { exe, version: '', prefix: '', packages: [] });
    if (seenPrefix.has(d.prefix.toLowerCase())) continue;
    seenPrefix.add(d.prefix.toLowerCase());
    const envId = slug(d.prefix);
    items.push({ id: `python:${envId}`, kind: 'python_environment', name: `Python ${d.version}`, version: d.version, installMethod: 'unknown', installPath: d.prefix, packageId: null, upstream: null, source: 'Python interpreter', details: { executable: d.exe, packages: d.packages.length } });
    for (const p of d.packages) {
      if (!p.name) continue;
      const gh = p.urls.map(githubFromMetadataUrl).find(Boolean) ?? null;
      items.push({ id: `pip:${envId}:${p.name.toLowerCase()}`, kind: 'python_package', name: p.name, version: p.version, installMethod: 'pip', installPath: d.prefix, packageId: p.name, upstream: gh ? upstreamFromGithub(gh, 'package metadata (Home-page / Project-URL)') : null, source: `pip (${d.prefix})`, details: { environment: d.prefix } });
    }
  }
  return { items };
}

async function collectUvTools(c: Ctx): Promise<Collected> {
  const r = await c.exec('uv', ['tool', 'list'], 30_000);
  if (r.code !== 0) throw new Error(notInstalled(r) ? 'uv is not installed' : `uv tool list failed: ${(r.stderr || r.stdout).trim().slice(0, 160) || `exit ${r.code}`}`);
  const items: SoftwareItem[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s+v?([0-9][^\s]*)/);
    if (m) items.push({ id: `uv:${m[1].toLowerCase()}`, kind: 'uv_tool', name: m[1], version: m[2], installMethod: 'uv', installPath: null, packageId: m[1], upstream: null, source: 'uv tool', details: {} });
  }
  return { items };
}

async function collectNpmGlobal(c: Ctx): Promise<Collected> {
  const root = await c.exec('cmd.exe', ['/d', '/s', '/c', 'npm root -g'], 30_000);
  if (root.code !== 0) throw new Error('npm is not available');
  const dir = root.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
  const items: SoftwareItem[] = [];
  const pkgDirs: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) { for (const s of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) if (s.isDirectory()) pkgDirs.push(path.join(dir, e.name, s.name)); }
      else pkgDirs.push(path.join(dir, e.name));
    }
  } catch { throw new Error(`cannot read the npm global folder ${dir}`); }
  for (const pd of pkgDirs) {
    const pj = json<{ name?: string; version?: string; repository?: string | { url?: string }; homepage?: string }>((() => { try { return fs.readFileSync(path.join(pd, 'package.json'), 'utf8'); } catch { return ''; } })(), {});
    if (!pj.name) continue;
    const repoUrl = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url;
    const gh = githubFromMetadataUrl(repoUrl) ?? null;
    items.push({ id: `npm:${pj.name}`, kind: 'node_package', name: pj.name, version: pj.version ?? null, installMethod: 'npm', installPath: pd, packageId: pj.name, upstream: gh ? upstreamFromGithub(gh, 'package.json "repository"') : null, source: 'npm (global)', details: {} });
  }
  return { items };
}

async function collectDocker(c: Ctx): Promise<Collected> {
  const ps = await c.exec('docker', ['ps', '-a', '--format', '{{json .}}'], 20_000);
  if (ps.code !== 0) throw new Error(notInstalled(ps) ? 'Docker is not installed' : `Docker is not answering: ${(ps.stderr || ps.stdout).trim().slice(0, 160) || `exit ${ps.code}`}`);
  const items: SoftwareItem[] = [];
  for (const line of ps.stdout.split(/\r?\n/)) {
    const d = json<{ ID?: string; Names?: string; Image?: string; State?: string; Status?: string; Ports?: string }>(line, {});
    if (d.ID) items.push({ id: `docker:container:${d.ID}`, kind: 'docker_container', name: d.Names ?? d.ID, version: d.Image ?? null, installMethod: 'docker', installPath: null, packageId: d.Image ?? null, upstream: null, source: 'Docker', details: { state: d.State ?? null, status: d.Status ?? null, ports: d.Ports ?? null } });
  }
  const im = await c.exec('docker', ['images', '--format', '{{json .}}'], 20_000);
  if (im.code === 0) for (const line of im.stdout.split(/\r?\n/)) {
    const d = json<{ ID?: string; Repository?: string; Tag?: string; CreatedSince?: string }>(line, {});
    if (d.ID) items.push({ id: `docker:image:${d.ID}`, kind: 'docker_image', name: d.Repository ?? d.ID, version: d.Tag ?? null, installMethod: 'docker', installPath: null, packageId: `${d.Repository}:${d.Tag}`, upstream: null, source: 'Docker', details: { created: d.CreatedSince ?? null } });
  }
  return { items };
}

async function collectOllama(c: Ctx): Promise<Collected> {
  const r = await c.fetchFn(`${c.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Ollama answered HTTP ${r.status}`);
  const d = await r.json() as { models?: Array<{ name: string; digest?: string; size?: number; modified_at?: string; details?: { parameter_size?: string; quantization_level?: string } }> };
  return { items: (d.models ?? []).map((m) => ({ id: `ollama:${m.name}`, kind: 'model' as const, name: m.name, version: m.digest ? m.digest.slice(0, 12) : null, installMethod: 'ollama' as const, installPath: null, packageId: m.name, upstream: null, source: 'Ollama (local)', details: { size: m.size ?? null, parameters: m.details?.parameter_size ?? null, quantization: m.details?.quantization_level ?? null, modified: m.modified_at ?? null } })) };
}

/** Git repositories under the scan roots (depth ≤ 3, skipping dependency folders). */
export function findRepositories(roots: string[], maxDepth = 3): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', 'target', '.tmp']);
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === '.git')) { out.push(dir); }
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return [...new Set(out)];
}

async function git(c: Ctx, repo: string, args: string[]): Promise<string | null> {
  const r = await c.exec('git', ['--no-optional-locks', '-C', repo, ...args], 15_000);
  return r.code === 0 ? r.stdout : null;
}

async function inspectRepo(c: Ctx, repo: string): Promise<GitRepoState> {
  const remotesRaw = (await git(c, repo, ['remote', '-v'])) ?? '';
  const remotes = [...new Map(remotesRaw.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2).map((p) => [p[0], { name: p[0], url: p[1] }] as const)).values()];
  const branch = (await git(c, repo, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? null;
  const headSha = (await git(c, repo, ['rev-parse', 'HEAD']))?.trim() ?? null;
  const describe = (await git(c, repo, ['describe', '--tags', '--abbrev=0']))?.trim() || null;
  const { modified, untracked } = countPorcelain((await git(c, repo, ['status', '--porcelain=v1'])) ?? '');
  const lr = (await git(c, repo, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']))?.trim();
  let ahead: number | null = null; let behind: number | null = null;
  if (lr) { const [a, b] = lr.split(/\s+/).map(Number); ahead = Number.isFinite(a) ? a : null; behind = Number.isFinite(b) ? b : null; }
  const pushed = ((await git(c, repo, ['branch', '-r', '--contains', 'HEAD'])) ?? '').trim().length > 0;
  const worktrees = ((await git(c, repo, ['worktree', 'list', '--porcelain'])) ?? '').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length;
  const branches = ((await git(c, repo, ['branch', '--list'])) ?? '').split(/\r?\n/).filter((l) => l.trim()).length;
  return { path: repo, remotes, branch: branch === 'HEAD' ? null : branch, headSha, describe, modified, untracked, ahead, behind, hasUpstreamBranch: lr != null, headPushed: pushed, worktrees, branches };
}

async function collectRepositories(c: Ctx): Promise<Collected> {
  if (c.roots.length === 0) throw new Error('no scan folders are configured');
  const which = await c.exec('git', ['--version'], 10_000);
  if (which.code !== 0) throw new Error('git is not installed');
  const repos = findRepositories(c.roots);
  const repositories: GitRepoState[] = [];
  const items: SoftwareItem[] = [];
  for (const repo of repos.slice(0, 200)) {
    const st = await inspectRepo(c, repo);
    repositories.push(st);
    const origin = st.remotes.find((r) => r.name === 'origin') ?? st.remotes[0];
    const gh = origin ? parseGithubRemote(origin.url) : null;
    const upstreamRemote = st.remotes.find((r) => r.name === 'upstream');
    const upstreamGh = upstreamRemote ? parseGithubRemote(upstreamRemote.url) : null;
    items.push({
      id: `git:${slug(repo)}`, kind: 'git_repo', name: path.basename(repo), version: st.describe ?? (st.headSha ? st.headSha.slice(0, 12) : null), installMethod: 'git', installPath: repo, packageId: null,
      upstream: gh ? upstreamFromGithub(gh, `git remote "${origin!.name}"`) : origin ? { url: origin.url, github: null, verified: false, basis: `git remote "${origin.name}" (not GitHub)` } : null,
      source: 'git', details: { branch: st.branch, head: st.headSha, modified: st.modified, untracked: st.untracked, ahead: st.ahead, behind: st.behind, worktrees: st.worktrees, branches: st.branches, headPushed: st.headPushed, upstreamRemote: upstreamGh },
    });
  }
  return { items, repositories };
}

export function defaultScanRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.PANDESH_SOFTWARE_SCAN_ROOTS?.split(';').map((s) => s.trim()).filter(Boolean);
  if (configured?.length) return configured;
  const candidates = [env.USERPROFILE && path.join(env.USERPROFILE, 'source', 'repos'), env.USERPROFILE && path.join(env.USERPROFILE, 'Projects'), 'D:\\Projects'].filter(Boolean) as string[];
  return candidates.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

const COLLECTORS: Array<{ id: string; label: string; run: (c: Ctx) => Promise<Collected> }> = [
  { id: 'ports', label: 'Ports, processes and Windows services', run: collectPortsAndServices },
  { id: 'programs', label: 'Installed programs', run: collectInstalledPrograms },
  { id: 'winget', label: 'winget packages', run: collectWinget },
  { id: 'scoop', label: 'Scoop apps', run: collectScoop },
  { id: 'choco', label: 'Chocolatey packages', run: collectChoco },
  { id: 'python', label: 'Python environments and packages', run: collectPython },
  { id: 'uv', label: 'uv tools', run: collectUvTools },
  { id: 'npm', label: 'Global npm packages', run: collectNpmGlobal },
  { id: 'docker', label: 'Docker containers and images', run: collectDocker },
  { id: 'ollama', label: 'Ollama models', run: collectOllama },
  { id: 'git', label: 'Git repositories', run: collectRepositories },
];

/** Runs every collector (in parallel, each isolated) and returns one read-only inventory. */
export async function collectSoftwareInventory(deps: InventoryDeps = {}): Promise<SoftwareInventory> {
  const env = deps.env ?? process.env;
  const c: Ctx = {
    exec: deps.exec ?? defaultExec,
    fetchFn: deps.fetchFn ?? fetch,
    env,
    dataDir: deps.dataDir ?? null,
    ollamaUrl: deps.ollamaUrl ?? (env.OLLAMA_HOST ? `http://${env.OLLAMA_HOST.replace(/^https?:\/\//, '')}` : 'http://127.0.0.1:11434'),
    roots: deps.scanRoots ?? defaultScanRoots(env),
  };
  const now = deps.now ?? (() => new Date());
  const results = await Promise.all(COLLECTORS.map(async (col) => {
    const t0 = Date.now();
    try { const out = await col.run(c); return { col, out, error: null as string | null, ms: Date.now() - t0 }; }
    catch (err) { return { col, out: {} as Collected, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 }; }
  }));
  const inv: SoftwareInventory = { generatedAt: now().toISOString(), sections: [], items: [], ports: [], services: [], repositories: [], scanRoots: c.roots };
  for (const r of results) {
    const count = (r.out.items?.length ?? 0) + (r.out.ports?.length ?? 0) + (r.out.repositories?.length ?? 0);
    inv.sections.push({ id: r.col.id, label: r.col.label, available: r.error === null, reason: r.error, count, durationMs: r.ms });
    inv.items.push(...(r.out.items ?? []));
    inv.ports.push(...(r.out.ports ?? []));
    inv.services.push(...(r.out.services ?? []));
    inv.repositories.push(...(r.out.repositories ?? []));
  }
  return inv;
}

/** Which running processes and listening ports belong to an item's install folder — what an update could interrupt. */
export function dependentsOf(item: Pick<SoftwareItem, 'installPath' | 'kind' | 'name'>, inv: Pick<SoftwareInventory, 'ports' | 'services'>): { ports: ListeningPort[]; services: WindowsServiceEntry[] } {
  const base = item.installPath?.toLowerCase().replace(/[\\/]+$/, '');
  if (!base || base.length < 4) return { ports: [], services: [] };
  const inside = (p: string | null) => Boolean(p && p.toLowerCase().replace(/^"/, '').startsWith(`${base}\\`));
  return {
    ports: inv.ports.filter((p) => inside(p.executablePath)),
    services: inv.services.filter((s) => inside(s.path)),
  };
}
