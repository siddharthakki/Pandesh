/**
 * P0 — Intelligence Scout (Pandesh).
 *
 * Personalized technology intelligence: durable watchlists, source-backed
 * discovery, deduplication and grounded recommendations. No fabricated
 * benchmarks; network calls are best-effort and fail closed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ScoutWatchKind = 'github_repo' | 'url';

export interface ScoutWatch {
  id: string;
  name: string;
  kind: ScoutWatchKind;
  target: string;
  createdAt: string;
  paused: boolean;
  lastCheckedAt: string | null;
  lastSeenVersion: string | null;
  lastReport: string | null;
}

export interface ScoutFinding {
  source: string;
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string;
}

export interface IntelligenceScoutOptions {
  dataDir: string;
  now?: () => number;
  fetchFn?: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;
  writeFileFn?: (p: string, c: string) => void;
  readFileFn?: (p: string) => string;
  existsFn?: (p: string) => boolean;
}

export interface IntelligenceScout {
  listWatches(): ScoutWatch[];
  addWatch(input: { name?: string; kind: ScoutWatchKind; target: string }): ScoutWatch;
  removeWatch(id: string): boolean;
  pauseWatch(id: string, paused: boolean): boolean;
  runWatch(id: string): Promise<{ changed: boolean; finding: ScoutFinding | null; message: string }>;
  runAll(): Promise<{ results: Array<{ id: string; changed: boolean; message: string }> }>;
  researchGithubRepo(repo: string): Promise<{ finding: ScoutFinding | null; message: string }>;
}

const WATCH_FILE = 'intelligence-scout-watches.json';

function defaultNow(): number { return Date.now(); }

export function createIntelligenceScout(options: IntelligenceScoutOptions): IntelligenceScout {
  const dataDir = options.dataDir;
  const now = options.now ?? defaultNow;
  const fetchFn = options.fetchFn ?? (async (url: string) => {
    const r = await fetch(url, { headers: { 'User-Agent': 'Pandesh-Intelligence-Scout' } });
    return { ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text() };
  });
  const readFileFn = options.readFileFn ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const writeFileFn = options.writeFileFn ?? ((p: string, c: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8'); });
  const existsFn = options.existsFn ?? ((p: string) => fs.existsSync(p));

  const watchPath = path.join(dataDir, WATCH_FILE);

  function loadWatches(): ScoutWatch[] {
    if (!existsFn(watchPath)) return [];
    try {
      const parsed = JSON.parse(readFileFn(watchPath));
      return Array.isArray(parsed) ? parsed as ScoutWatch[] : [];
    } catch { return []; }
  }

  function saveWatches(watches: ScoutWatch[]): void {
    try { writeFileFn(watchPath, JSON.stringify(watches, null, 2)); } catch { /* best effort */ }
  }

  let watches: ScoutWatch[] = loadWatches();

  function newId(): string { return `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

  const scout: IntelligenceScout = {
    listWatches() { return watches.map((w) => ({ ...w })); },
    addWatch(input) {
      const target = input.target.trim();
      const name = (input.name && input.name.trim()) || target;
      const watch: ScoutWatch = {
        id: newId(),
        name,
        kind: input.kind,
        target,
        createdAt: new Date(now()).toISOString(),
        paused: false,
        lastCheckedAt: null,
        lastSeenVersion: null,
        lastReport: null,
      };
      watches.push(watch);
      saveWatches(watches);
      return { ...watch };
    },
    removeWatch(id: string) {
      const before = watches.length;
      watches = watches.filter((w) => w.id !== id);
      if (watches.length !== before) { saveWatches(watches); return true; }
      return false;
    },
    pauseWatch(id: string, paused: boolean) {
      const w = watches.find((x) => x.id === id);
      if (!w) return false;
      w.paused = paused;
      saveWatches(watches);
      return true;
    },
    async runWatch(id: string) {
      const w = watches.find((x) => x.id === id);
      if (!w) return { changed: false, finding: null, message: `watch '${id}' not found` };
      if (w.paused) return { changed: false, finding: null, message: `watch '${w.name}' is paused` };
      w.lastCheckedAt = new Date(now()).toISOString();
      if (w.kind === 'github_repo') {
        const repo = w.target.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
        const url = `https://api.github.com/repos/${repo}/releases/latest`;
        try {
          const r = await fetchFn(url);
          if (!r.ok) {
            w.lastReport = `fetch failed: HTTP ${r.status}`;
            saveWatches(watches);
            return { changed: false, finding: null, message: `Could not fetch releases for ${repo}: HTTP ${r.status}` };
          }
          const data = await r.json() as { tag_name?: string; name?: string; html_url?: string; published_at?: string; body?: string };
          const version = data.tag_name || data.name || '';
          const finding: ScoutFinding = {
            source: 'GitHub releases',
            title: `${repo} ${version}`.trim(),
            url: data.html_url || `https://github.com/${repo}/releases`,
            publishedAt: data.published_at || null,
            summary: (data.body || '').slice(0, 500) || 'No release notes provided.',
          };
          const changed = version !== '' && version !== w.lastSeenVersion;
          if (changed) {
            w.lastSeenVersion = version;
            w.lastReport = `New release ${version}`;
          } else {
            w.lastReport = `No new release (latest ${version || 'unknown'})`;
          }
          saveWatches(watches);
          return {
            changed,
            finding: changed ? finding : null,
            message: changed
              ? `New release for ${repo}: ${version} — ${finding.url}`
              : `No new release for ${repo} (latest: ${version || 'unknown'})`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          w.lastReport = `error: ${msg}`;
          saveWatches(watches);
          return { changed: false, finding: null, message: `Scout error for ${repo}: ${msg}` };
        }
      }
      // url kind: fetch and report change via content length/hash (simple).
      try {
        const r = await fetchFn(w.target);
        if (!r.ok) {
          w.lastReport = `fetch failed: HTTP ${r.status}`;
          saveWatches(watches);
          return { changed: false, finding: null, message: `Could not fetch ${w.target}: HTTP ${r.status}` };
        }
        const text = await r.text();
        const hash = simpleHash(text);
        const changed = hash !== w.lastSeenVersion;
        const finding: ScoutFinding | null = changed ? {
          source: 'URL',
          title: w.name,
          url: w.target,
          publishedAt: null,
          summary: text.slice(0, 300),
        } : null;
        if (changed) { w.lastSeenVersion = hash; w.lastReport = 'Content changed'; }
        else { w.lastReport = 'No change'; }
        saveWatches(watches);
        return { changed, finding, message: changed ? `Content changed at ${w.target}` : `No change at ${w.target}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        w.lastReport = `error: ${msg}`;
        saveWatches(watches);
        return { changed: false, finding: null, message: `Scout error for ${w.target}: ${msg}` };
      }
    },
    async runAll() {
      const results: Array<{ id: string; changed: boolean; message: string }> = [];
      for (const w of watches) {
        if (w.paused) { results.push({ id: w.id, changed: false, message: `${w.name} paused` }); continue; }
        const r = await scout.runWatch(w.id);
        results.push({ id: w.id, changed: r.changed, message: r.message });
      }
      return { results };
    },
    async researchGithubRepo(repo: string) {
      const clean = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
      const url = `https://api.github.com/repos/${clean}`;
      try {
        const r = await fetchFn(url);
        if (!r.ok) return { finding: null, message: `Could not fetch repo ${clean}: HTTP ${r.status}` };
        const data = await r.json() as { full_name?: string; description?: string; html_url?: string; stargazers_count?: number; updated_at?: string; license?: { spdx_id?: string } };
        const finding: ScoutFinding = {
          source: 'GitHub',
          title: data.full_name || clean,
          url: data.html_url || `https://github.com/${clean}`,
          publishedAt: data.updated_at || null,
          summary: `${data.description || 'No description.'} Stars: ${data.stargazers_count ?? 0}. License: ${data.license?.spdx_id || 'unknown'}.`,
        };
        return { finding, message: `Researched ${clean}: ${finding.summary}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { finding: null, message: `Scout error for ${clean}: ${msg}` };
      }
    },
  };

  return scout;
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
  return String(h);
}
