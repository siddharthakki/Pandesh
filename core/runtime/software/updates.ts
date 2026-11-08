/**
 * Update discovery (read-only) for the software inventory.
 *
 * Sources, all public update metadata:
 * - The package managers' own "outdated" views (winget upgrade, pip list
 *   --outdated, npm outdated -g, choco outdated). Pandesh does not duplicate
 *   what they already know. `scoop status` is not used: it updates bucket
 *   repositories, which is a write.
 * - GitHub's REST API, unauthenticated, only for repositories that a local
 *   git remote or package metadata names exactly (Upstream.verified). Requests
 *   carry the owner/repo and, for an already-pushed HEAD, its commit hash —
 *   never local paths, file contents, configuration or credentials. A HEAD
 *   that is not on any remote-tracking branch is never sent.
 *
 * Nothing here installs or changes software. Results are cached in the Core
 * data folder with ETags; rate limits stop further GitHub requests and mark
 * the rest `rate_limited` with the reset time; network failures keep the last
 * known result, marked stale.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultExec, type ExecRunner } from '../capabilityInventory';
import type { SoftwareInventory, SoftwareItem } from './inventory';

export type UpdateStatus = 'up_to_date' | 'update_available' | 'prerelease_available' | 'behind_development' | 'ahead_or_local' | 'unknown' | 'rate_limited' | 'error';

export interface Advisory { id: string; severity: string | null; summary: string; url: string; publishedAt: string | null }

export interface UpdateInfo {
  itemId: string;
  name: string;
  source: 'winget' | 'pip' | 'npm' | 'choco' | 'github';
  installed: string | null;
  latestStable: string | null;
  latestPrerelease: string | null;
  status: UpdateStatus;
  /** Plain-words explanation of the status. */
  summary: string;
  notesUrl: string | null;
  publishedAt: string | null;
  /** Commits on the upstream default branch that the local HEAD does not have. */
  behindBy: number | null;
  fork: { isFork: boolean; parent: string | null } | null;
  advisories: Advisory[];
  checkedAt: string;
  stale: boolean;
  error: string | null;
}

export interface CheckRecord { at: string; trigger: 'manual' | 'periodic'; checked: number; updates: number; rateLimitedUntil: string | null; errors: string[] }

export interface UpdateSettings { periodicEnabled: boolean; intervalHours: number }

export interface UpdateState { results: UpdateInfo[]; history: CheckRecord[]; settings: UpdateSettings; lastCheckedAt: string | null; github: { rateLimitedUntil: string | null; remaining: number | null } }

interface GithubCacheEntry { etag: string | null; body: unknown; fetchedAt: string }
interface CacheFile { results: UpdateInfo[]; history: CheckRecord[]; lastCheckedAt: string | null; github: Record<string, GithubCacheEntry>; rateLimitedUntil: string | null; remaining: number | null }

export interface UpdateDeps { dataDir: string; exec?: ExecRunner; fetchFn?: typeof fetch; now?: () => Date; maxGithubRepos?: number }

const CACHE = 'software-update-cache.json';
const SETTINGS = 'software-update-settings.json';
const DEFAULT_SETTINGS: UpdateSettings = { periodicEnabled: false, intervalHours: 24 };

// ---------- versions (pure, unit-tested) ----------

export function normalizeVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = String(v).trim().match(/(\d+(?:\.\d+)*)([-+._]?[0-9A-Za-z.-]*)?/);
  return m ? `${m[1]}${m[2] ?? ''}` : null;
}
export function isPrerelease(v: string): boolean { return /[-.]?(alpha|beta|rc|pre|preview|dev|nightly|canary)\b/i.test(v); }

/** Numeric comparison of dotted versions; a prerelease sorts before its release. Returns null when either side is not a version. */
export function compareVersions(a: string | null, b: string | null): number | null {
  const x = normalizeVersion(a); const y = normalizeVersion(b);
  if (!x || !y) return null;
  const nx = x.match(/^\d+(?:\.\d+)*/)![0].split('.').map(Number);
  const ny = y.match(/^\d+(?:\.\d+)*/)![0].split('.').map(Number);
  for (let i = 0; i < Math.max(nx.length, ny.length); i++) {
    const d = (nx[i] ?? 0) - (ny[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  const px = isPrerelease(x); const py = isPrerelease(y);
  return px === py ? 0 : px ? -1 : 1;
}

/** `winget upgrade` prints a fixed-width table; columns are located from the header line. */
export function parseWingetUpgrade(stdout: string): Array<{ id: string; installed: string; available: string }> {
  // winget redraws a progress spinner with bare carriage returns: keep only the text after the last one.
  const lines = stdout.split(/\r?\n/).map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l));
  const hi = lines.findIndex((l) => /\bId\b/.test(l) && /\bVersion\b/.test(l) && /\bAvailable\b/.test(l));
  if (hi < 0) return [];
  const h = lines[hi];
  const cId = h.indexOf('Id'); const cVer = h.indexOf('Version'); const cAvail = h.indexOf('Available'); const cSrc = h.indexOf('Source');
  const out: Array<{ id: string; installed: string; available: string }> = [];
  for (const l of lines.slice(hi + 1)) {
    if (/^-+$/.test(l.trim()) || !l.trim() || /upgrades? available|package\(s\)|require explicit/i.test(l)) continue;
    if (l.length < cAvail) continue;
    const id = l.slice(cId, cVer).trim(); const installed = l.slice(cVer, cAvail).trim(); const available = (cSrc > 0 ? l.slice(cAvail, cSrc) : l.slice(cAvail)).trim();
    if (id && available && !id.includes(' ')) out.push({ id, installed, available });
  }
  return out;
}

// ---------- cache & settings ----------

function readCache(dataDir: string): CacheFile {
  try { return { results: [], history: [], lastCheckedAt: null, github: {}, rateLimitedUntil: null, remaining: null, ...JSON.parse(fs.readFileSync(path.join(dataDir, CACHE), 'utf8')) as Partial<CacheFile> }; }
  catch { return { results: [], history: [], lastCheckedAt: null, github: {}, rateLimitedUntil: null, remaining: null }; }
}
function writeCache(dataDir: string, c: CacheFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = path.join(dataDir, `${CACHE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, path.join(dataDir, CACHE));
}
export function readUpdateSettings(dataDir: string): UpdateSettings {
  try { const s = JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS), 'utf8')) as Partial<UpdateSettings>; return { periodicEnabled: s.periodicEnabled === true, intervalHours: Math.min(168, Math.max(6, Number(s.intervalHours) || 24)) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function writeUpdateSettings(dataDir: string, patch: Partial<UpdateSettings>): UpdateSettings {
  const next = { ...readUpdateSettings(dataDir), ...patch };
  next.intervalHours = Math.min(168, Math.max(6, Number(next.intervalHours) || 24));
  next.periodicEnabled = next.periodicEnabled === true;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, SETTINGS), JSON.stringify(next, null, 2));
  return next;
}
export function readUpdateState(dataDir: string): UpdateState {
  const c = readCache(dataDir);
  return { results: c.results, history: c.history, settings: readUpdateSettings(dataDir), lastCheckedAt: c.lastCheckedAt, github: { rateLimitedUntil: c.rateLimitedUntil, remaining: c.remaining } };
}

// ---------- GitHub (public metadata only) ----------

class RateLimited extends Error { constructor(public readonly resetAt: string) { super(`GitHub rate limit reached until ${resetAt}`); } }

function githubClient(fetchFn: typeof fetch, cache: CacheFile, now: () => Date) {
  return async function get<T>(apiPath: string): Promise<{ status: number; body: T | null }> {
    if (cache.rateLimitedUntil && new Date(cache.rateLimitedUntil) > now()) throw new RateLimited(cache.rateLimitedUntil);
    const key = apiPath;
    const prev = cache.github[key];
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Pandesh-software-discovery', 'X-GitHub-Api-Version': '2022-11-28' };
    if (prev?.etag) headers['If-None-Match'] = prev.etag;
    const r = await fetchFn(`https://api.github.com${apiPath}`, { headers, signal: AbortSignal.timeout(15_000) });
    const remaining = r.headers.get('x-ratelimit-remaining');
    const reset = r.headers.get('x-ratelimit-reset');
    if (remaining != null) cache.remaining = Number(remaining);
    if ((r.status === 403 || r.status === 429) && remaining === '0') {
      cache.rateLimitedUntil = reset ? new Date(Number(reset) * 1000).toISOString() : new Date(now().getTime() + 3600_000).toISOString();
      throw new RateLimited(cache.rateLimitedUntil);
    }
    if (r.status === 304 && prev) return { status: 200, body: prev.body as T };
    if (!r.ok) return { status: r.status, body: null };
    const body = await r.json() as T;
    cache.github[key] = { etag: r.headers.get('etag'), body, fetchedAt: now().toISOString() };
    return { status: 200, body };
  };
}

interface GhRepo { full_name: string; fork: boolean; parent?: { full_name: string }; default_branch: string; archived: boolean; html_url: string; private?: boolean }
interface GhRelease { tag_name: string; prerelease: boolean; draft: boolean; html_url: string; published_at: string | null }
interface GhAdvisory { ghsa_id: string; severity?: string; summary: string; html_url: string; published_at?: string }

async function checkGithubItem(get: ReturnType<typeof githubClient>, item: SoftwareItem, checkedAt: string): Promise<UpdateInfo> {
  const gh = item.upstream!.github!;
  const base: UpdateInfo = { itemId: item.id, name: item.name, source: 'github', installed: item.version, latestStable: null, latestPrerelease: null, status: 'unknown', summary: '', notesUrl: null, publishedAt: null, behindBy: null, fork: null, advisories: [], checkedAt, stale: false, error: null };
  const repo = await get<GhRepo>(`/repos/${gh}`);
  if (!repo.body) return { ...base, status: 'unknown', summary: repo.status === 404 ? 'GitHub does not show this repository publicly (private, renamed or removed).' : `GitHub answered HTTP ${repo.status}.` };
  base.fork = { isFork: repo.body.fork, parent: repo.body.parent?.full_name ?? null };
  const rel = await get<GhRelease[]>(`/repos/${gh}/releases?per_page=15`);
  const releases = (Array.isArray(rel.body) ? rel.body : []).filter((r) => r && typeof r.tag_name === 'string' && !r.draft);
  const stable = releases.find((r) => !r.prerelease && !isPrerelease(r.tag_name)) ?? null;
  const pre = releases.find((r) => r.prerelease || isPrerelease(r.tag_name)) ?? null;
  base.latestStable = stable?.tag_name ?? null;
  base.notesUrl = stable?.html_url ?? null;
  base.publishedAt = stable?.published_at ?? null;
  if (pre && (!stable || (compareVersions(pre.tag_name, stable.tag_name) ?? 0) > 0)) base.latestPrerelease = pre.tag_name;

  const installedTag = item.kind === 'git_repo' ? (item.details.head ? (item.version && !/^[0-9a-f]{12}$/.test(item.version) ? item.version : null) : null) : item.version;
  const cmp = compareVersions(installedTag, base.latestStable);
  const parts: string[] = [];
  if (item.kind === 'git_repo') {
    const head = String(item.details.head ?? '');
    if (head && item.details.headPushed === true) {
      const c = await get<{ behind_by: number; ahead_by: number; status: string }>(`/repos/${gh}/compare/${encodeURIComponent(repo.body.default_branch)}...${head}`);
      if (c.body) base.behindBy = c.body.behind_by;
    }
    if (item.details.headPushed !== true) parts.push('Local commits are not on any remote branch, so they were not compared online.');
  }
  if (cmp != null && cmp < 0) { base.status = 'update_available'; parts.unshift(`Stable release ${base.latestStable} is newer than the installed ${installedTag}.`); }
  else if (cmp != null && cmp > 0) { base.status = 'ahead_or_local'; parts.unshift(`Installed ${installedTag} is newer than the latest stable release ${base.latestStable}.`); }
  else if (cmp === 0) { base.status = 'up_to_date'; parts.unshift(`Installed ${installedTag} is the latest stable release.`); }
  if (base.behindBy && base.behindBy > 0 && base.status !== 'update_available') { base.status = 'behind_development'; parts.push(`${base.behindBy} newer commit(s) on ${repo.body.default_branch}.`); }
  else if (base.behindBy === 0 && base.status === 'unknown') { base.status = 'up_to_date'; parts.push(`HEAD includes the latest ${repo.body.default_branch}.`); }
  if (base.status === 'unknown') parts.unshift(stable ? `Latest stable release is ${stable.tag_name}; the installed version could not be compared.` : 'No releases published; the installed version could not be compared.');
  if (base.latestPrerelease) { parts.push(`Prerelease ${base.latestPrerelease} is available (not stable).`); if (base.status === 'up_to_date') base.status = 'prerelease_available'; }
  if (repo.body.fork) parts.push(`This is a fork of ${repo.body.parent?.full_name ?? 'another repository'}.`);
  if (repo.body.archived) parts.push('The upstream repository is archived.');
  if (base.status === 'update_available' || base.status === 'behind_development') {
    const adv = await get<GhAdvisory[]>(`/repos/${gh}/security-advisories?state=published&per_page=5`).catch(() => ({ status: 0, body: null }));
    // Not every repository publishes advisories; anything but a list means "none known".
    base.advisories = (Array.isArray(adv.body) ? adv.body : []).filter((a) => a && a.ghsa_id).map((a) => ({ id: a.ghsa_id, severity: a.severity ?? null, summary: a.summary, url: a.html_url, publishedAt: a.published_at ?? null }));
  }
  base.summary = parts.join(' ');
  return base;
}

// ---------- package managers ----------

async function packageManagerUpdates(exec: ExecRunner, inv: SoftwareInventory, checkedAt: string, errors: string[]): Promise<UpdateInfo[]> {
  const out: UpdateInfo[] = [];
  const mk = (item: SoftwareItem | undefined, source: UpdateInfo['source'], name: string, installed: string | null, available: string, idFallback: string): UpdateInfo => ({
    itemId: item?.id ?? idFallback, name, source, installed, latestStable: isPrerelease(available) ? null : available, latestPrerelease: isPrerelease(available) ? available : null,
    status: isPrerelease(available) ? 'prerelease_available' : 'update_available', summary: `${source} reports ${available} (installed ${installed ?? 'unknown'}).`,
    notesUrl: null, publishedAt: null, behindBy: null, fork: null, advisories: [], checkedAt, stale: false, error: null,
  });
  const byId = new Map(inv.items.map((i) => [i.id, i]));
  if (inv.sections.find((s) => s.id === 'winget')?.available) {
    const r = await exec('winget', ['upgrade', '--disable-interactivity'], 120_000);
    if (/agreement/i.test(r.stdout + r.stderr) && !/Available/.test(r.stdout)) errors.push('winget: the source agreement has not been accepted; run "winget upgrade" once yourself.');
    else for (const u of parseWingetUpgrade(r.stdout)) out.push(mk(byId.get(`winget:${u.id}`), 'winget', u.id, u.installed, u.available, `winget:${u.id}`));
  }
  for (const env of inv.items.filter((i) => i.kind === 'python_environment')) {
    const exe = String(env.details.executable ?? '');
    if (!exe) continue;
    const r = await exec(exe, ['-m', 'pip', 'list', '--outdated', '--format=json', '--disable-pip-version-check'], 180_000);
    if (r.code !== 0) { errors.push(`pip (${env.installPath}): ${r.stderr.trim().split(/\r?\n/).pop()?.slice(0, 140) ?? 'failed'}`); continue; }
    try {
      for (const p of JSON.parse(r.stdout) as Array<{ name: string; version: string; latest_version: string }>) {
        const id = `pip:${env.id.slice('python:'.length)}:${p.name.toLowerCase()}`;
        out.push(mk(byId.get(id), 'pip', p.name, p.version, p.latest_version, id));
      }
    } catch { errors.push(`pip (${env.installPath}): unreadable output`); }
  }
  if (inv.sections.find((s) => s.id === 'npm')?.available) {
    const r = await exec('cmd.exe', ['/d', '/s', '/c', 'npm outdated -g --json'], 120_000);
    try {
      const d = JSON.parse(r.stdout || '{}') as Record<string, { current?: string; latest?: string; wanted?: string }>;
      for (const [name, v] of Object.entries(d)) if (v.latest) out.push(mk(byId.get(`npm:${name}`), 'npm', name, v.current ?? null, v.latest, `npm:${name}`));
    } catch { errors.push('npm: unreadable "npm outdated" output'); }
  }
  if (inv.sections.find((s) => s.id === 'choco')?.available) {
    const r = await exec('choco', ['outdated', '--limit-output'], 120_000);
    for (const l of r.stdout.split(/\r?\n/)) {
      const [name, cur, avail, pinned] = l.trim().split('|');
      if (name && avail && cur !== avail) out.push({ ...mk(byId.get(`choco:${name}`), 'choco', name, cur, avail, `choco:${name}`), summary: `Chocolatey reports ${avail} (installed ${cur})${pinned === 'true' ? '; the package is pinned' : ''}.` });
    }
  }
  return out;
}

// ---------- the check ----------

export async function checkForUpdates(inv: SoftwareInventory, deps: UpdateDeps, trigger: 'manual' | 'periodic' = 'manual'): Promise<UpdateState> {
  const now = deps.now ?? (() => new Date());
  const exec = deps.exec ?? defaultExec;
  const fetchFn = deps.fetchFn ?? fetch;
  const cache = readCache(deps.dataDir);
  const checkedAt = now().toISOString();
  const errors: string[] = [];
  const results: UpdateInfo[] = [];

  try { results.push(...await packageManagerUpdates(exec, inv, checkedAt, errors)); }
  catch (err) { errors.push(`package managers: ${err instanceof Error ? err.message : String(err)}`); }

  const covered = new Set(results.map((r) => r.itemId));
  const ghItems = inv.items.filter((i) => i.upstream?.verified && i.upstream.github && !covered.has(i.id) && (i.kind === 'git_repo' || i.kind === 'node_package'));
  const seen = new Set<string>();
  const unique = ghItems.filter((i) => { const k = `${i.upstream!.github}|${i.version}|${i.details.head ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, deps.maxGithubRepos ?? 40);
  const get = githubClient(fetchFn, cache, now);
  let rateLimitedUntil: string | null = null;
  for (const item of unique) {
    if (rateLimitedUntil) { results.push(rateLimitedResult(item, checkedAt, rateLimitedUntil, cache)); continue; }
    try { results.push(await checkGithubItem(get, item, checkedAt)); }
    catch (err) {
      if (err instanceof RateLimited) { rateLimitedUntil = err.resetAt; results.push(rateLimitedResult(item, checkedAt, rateLimitedUntil, cache)); continue; }
      const prev = cache.results.find((r) => r.itemId === item.id && r.source === 'github');
      const msg = err instanceof Error ? err.message : String(err);
      results.push(prev ? { ...prev, stale: true, error: `Last check failed (${msg}); showing the result from ${prev.checkedAt}.` } : { itemId: item.id, name: item.name, source: 'github', installed: item.version, latestStable: null, latestPrerelease: null, status: 'error', summary: `Could not reach GitHub: ${msg}`, notesUrl: null, publishedAt: null, behindBy: null, fork: null, advisories: [], checkedAt, stale: false, error: msg });
    }
  }
  if (rateLimitedUntil) errors.push(`GitHub rate limit reached; remaining checks resume after ${rateLimitedUntil}.`);
  if (!rateLimitedUntil && cache.rateLimitedUntil && new Date(cache.rateLimitedUntil) <= now()) cache.rateLimitedUntil = null;

  const record: CheckRecord = { at: checkedAt, trigger, checked: results.length, updates: results.filter((r) => r.status === 'update_available').length, rateLimitedUntil, errors };
  cache.results = results;
  cache.lastCheckedAt = checkedAt;
  cache.history = [record, ...cache.history].slice(0, 50);
  writeCache(deps.dataDir, cache);
  return readUpdateState(deps.dataDir);
}

function rateLimitedResult(item: SoftwareItem, checkedAt: string, until: string, cache: CacheFile): UpdateInfo {
  const prev = cache.results.find((r) => r.itemId === item.id && r.source === 'github');
  if (prev) return { ...prev, stale: true, error: `GitHub rate limit until ${until}; showing the result from ${prev.checkedAt}.` };
  return { itemId: item.id, name: item.name, source: 'github', installed: item.version, latestStable: null, latestPrerelease: null, status: 'rate_limited', summary: `Not checked: GitHub's hourly limit for unauthenticated requests was reached. It resets at ${until}.`, notesUrl: null, publishedAt: null, behindBy: null, fork: null, advisories: [], checkedAt, stale: false, error: null };
}

/** True when a periodic check is due under the saved settings. */
export function periodicCheckDue(state: Pick<UpdateState, 'settings' | 'lastCheckedAt'>, now: Date): boolean {
  if (!state.settings.periodicEnabled) return false;
  if (!state.lastCheckedAt) return true;
  return now.getTime() - new Date(state.lastCheckedAt).getTime() >= state.settings.intervalHours * 3600_000;
}
