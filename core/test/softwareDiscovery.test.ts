import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectSoftwareInventory, countPorcelain, dependentsOf, githubFromMetadataUrl, parseGithubRemote, type SoftwareInventory, type SoftwareItem } from '../runtime/software/inventory';
import { checkForUpdates, compareVersions, parseWingetUpgrade, periodicCheckDue, readUpdateState } from '../runtime/software/updates';
import type { ExecRunner } from '../runtime/capabilityInventory';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-software-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('upstream identification never guesses', () => {
  it('accepts only exact github.com remotes', () => {
    expect(parseGithubRemote('https://github.com/ollama/ollama.git')).toBe('ollama/ollama');
    expect(parseGithubRemote('git@github.com:siddharthakki/Pandesh.git')).toBe('siddharthakki/Pandesh');
    expect(parseGithubRemote('https://user@github.com/a/b')).toBe('a/b');
    expect(parseGithubRemote('https://github.com.evil.io/a/b.git')).toBeNull();
    expect(parseGithubRemote('https://gitlab.com/a/b.git')).toBeNull();
    expect(parseGithubRemote('https://github.com/onlyowner')).toBeNull();
  });
  it('reads repository URLs from package metadata but not organisation or pages URLs', () => {
    expect(githubFromMetadataUrl('git+https://github.com/vitejs/vite.git')).toBe('vitejs/vite');
    expect(githubFromMetadataUrl('https://github.com/psf/requests/tree/main/docs')).toBe('psf/requests');
    expect(githubFromMetadataUrl('github:sindresorhus/execa')).toBe('sindresorhus/execa');
    expect(githubFromMetadataUrl('https://github.com/psf')).toBeNull();
    expect(githubFromMetadataUrl('https://psf.github.io/requests')).toBeNull();
    expect(githubFromMetadataUrl('https://requests.readthedocs.io')).toBeNull();
  });
});

describe('pure helpers', () => {
  it('counts modified and untracked files from git porcelain', () => {
    expect(countPorcelain(' M a.ts\nA  b.ts\n?? c.ts\n?? d/\n')).toEqual({ modified: 2, untracked: 2 });
  });
  it('compares versions with prereleases before their release', () => {
    expect(compareVersions('v1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0-rc.1', '2.0.0')).toBe(-1);
    expect(compareVersions('v0.5', '0.5.0')).toBe(0);
    expect(compareVersions('nightly', '1.0')).toBeNull();
  });
  it('parses the winget upgrade table, including a spinner prefix', () => {
    const out = '\r   - \r   \\ \rName              Id                     Version   Available Source\n------------------------------------------------------------------\nGit               Git.Git                2.45.0    2.47.1    winget\nPython 3.12       Python.Python.3.12     3.12.3    3.12.8    winget\n2 upgrades available.\n';
    expect(parseWingetUpgrade(out)).toEqual([
      { id: 'Git.Git', installed: '2.45.0', available: '2.47.1' },
      { id: 'Python.Python.3.12', installed: '3.12.3', available: '3.12.8' },
    ]);
  });
  it('periodic checks are off by default and due only after the interval', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    expect(periodicCheckDue({ settings: { periodicEnabled: false, intervalHours: 24 }, lastCheckedAt: null }, now)).toBe(false);
    expect(periodicCheckDue({ settings: { periodicEnabled: true, intervalHours: 24 }, lastCheckedAt: '2026-11-08T01:00:00Z' }, now)).toBe(false);
    expect(periodicCheckDue({ settings: { periodicEnabled: true, intervalHours: 6 }, lastCheckedAt: '2026-11-08T01:00:00Z' }, now)).toBe(true);
  });
});

describe('inventory collection (read-only, isolated collectors)', () => {
  it('reports a failing collector as unavailable with its reason and keeps the others', async () => {
    const root = tmp();
    const repo = path.join(root, 'tool-a');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const npmRoot = path.join(root, 'npm-global');
    fs.mkdirSync(path.join(npmRoot, 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(npmRoot, 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0', repository: { url: 'git+https://github.com/left-pad/left-pad.git' } }));
    const calls: string[][] = [];
    const exec: ExecRunner = async (file, args) => {
      calls.push([file, ...args]);
      const cmd = [file, ...args].join(' ');
      if (file === 'powershell.exe' && cmd.includes('Get-NetTCPConnection')) return { code: 0, stdout: JSON.stringify({ conns: [{ LocalAddress: '127.0.0.1', LocalPort: 11434, OwningProcess: 42 }], procs: [{ ProcessId: 42, Name: 'ollama.exe', ExecutablePath: 'C:\\Tools\\Ollama\\ollama.exe' }], svcs: [] }), stderr: '' };
      if (file === 'powershell.exe') return { code: 0, stdout: JSON.stringify([{ DisplayName: 'Ollama', DisplayVersion: '0.9.0', InstallLocation: 'C:\\Tools\\Ollama\\', URLInfoAbout: 'https://github.com/ollama/ollama' }]), stderr: '' };
      if (file === 'docker') return { code: null, stdout: '', stderr: 'spawn docker ENOENT' };
      if (cmd.includes('npm root -g')) return { code: 0, stdout: `${npmRoot}\n`, stderr: '' };
      if (file === 'git' && args.includes('--version')) return { code: 0, stdout: 'git version 2.47', stderr: '' };
      if (file === 'git' && args.includes('remote')) return { code: 0, stdout: 'origin\thttps://github.com/acme/tool-a.git (fetch)\norigin\thttps://github.com/acme/tool-a.git (push)\n', stderr: '' };
      if (file === 'git' && args.includes('rev-parse') && args.includes('--abbrev-ref')) return { code: 0, stdout: 'main\n', stderr: '' };
      if (file === 'git' && args.includes('rev-parse')) return { code: 0, stdout: 'abc123def4567890\n', stderr: '' };
      if (file === 'git' && args.includes('describe')) return { code: 0, stdout: 'v1.0.0\n', stderr: '' };
      if (file === 'git' && args.includes('status')) return { code: 0, stdout: ' M x\n?? y\n', stderr: '' };
      if (file === 'git' && args.includes('--contains')) return { code: 0, stdout: '  origin/main\n', stderr: '' };
      if (file === 'git') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: `'${file}' is not recognized` };
    };
    const fetchFn = (async () => new Response(JSON.stringify({ models: [{ name: 'gemma4:12b', digest: 'sha256:abcdef0123456789' }] }), { status: 200 })) as unknown as typeof fetch;
    const inv = await collectSoftwareInventory({ exec, fetchFn, env: { TEMP: root }, dataDir: root, scanRoots: [root] });

    const docker = inv.sections.find((s) => s.id === 'docker')!;
    expect(docker.available).toBe(false);
    expect(docker.reason).toMatch(/Docker is not installed/);
    expect(inv.sections.find((s) => s.id === 'ports')!.available).toBe(true);
    expect(inv.ports[0]).toMatchObject({ port: 11434, processName: 'ollama.exe' });

    const program = inv.items.find((i) => i.id === 'program:ollama')!;
    expect(program.upstream).toMatchObject({ github: 'ollama/ollama', verified: false });
    const npmPkg = inv.items.find((i) => i.id === 'npm:left-pad')!;
    expect(npmPkg.upstream).toMatchObject({ github: 'left-pad/left-pad', verified: true });
    const repoItem = inv.items.find((i) => i.kind === 'git_repo')!;
    expect(repoItem.upstream).toMatchObject({ github: 'acme/tool-a', verified: true });
    expect(repoItem.details).toMatchObject({ modified: 1, untracked: 1, headPushed: true, branch: 'main' });
    expect(inv.items.find((i) => i.id === 'ollama:gemma4:12b')).toBeTruthy();

    // Read-only: every git call avoids optional locks; nothing mutating was run.
    for (const c of calls.filter((c) => c[0] === 'git' && !c.includes('--version'))) expect(c[1]).toBe('--no-optional-locks');
    const forbidden = /\b(fetch|pull|push|checkout|reset|install|upgrade|uninstall|update|stop|start|rm)\b/;
    for (const c of calls) if (c[0] === 'git' || c[0] === 'docker' || c[0] === 'winget') expect(c.slice(1).join(' ')).not.toMatch(forbidden);

    const deps = dependentsOf(program, inv);
    expect(deps.ports.map((p) => p.port)).toEqual([11434]);
  });
});

function repoItem(over: Partial<SoftwareItem> & { details?: SoftwareItem['details'] }): SoftwareItem {
  return { id: 'git:tool', kind: 'git_repo', name: 'tool', version: 'v1.0.0', installMethod: 'git', installPath: 'D:\\secret\\path\\tool', packageId: null, upstream: { url: 'https://github.com/acme/tool', github: 'acme/tool', verified: true, basis: 'git remote' }, source: 'git', details: { head: 'abc123def4567890', headPushed: true }, ...over } as SoftwareItem;
}
function inventoryOf(items: SoftwareItem[]): SoftwareInventory {
  return { generatedAt: new Date().toISOString(), sections: [], items, ports: [], services: [], repositories: [], scanRoots: [] };
}

describe('update discovery (public metadata, cached, rate-limit aware)', () => {
  const okJson = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'x-ratelimit-remaining': '50', etag: '"e1"', ...headers } });

  it('reports a newer stable release and a separate prerelease, and never sends local paths', async () => {
    const dataDir = tmp();
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/repos/acme/tool')) return okJson({ full_name: 'acme/tool', fork: false, default_branch: 'main', archived: false, html_url: 'https://github.com/acme/tool' });
      if (url.includes('/releases')) return okJson([{ tag_name: 'v1.3.0-rc.1', prerelease: true, draft: false, html_url: 'u3', published_at: null }, { tag_name: 'v1.2.0', prerelease: false, draft: false, html_url: 'https://github.com/acme/tool/releases/tag/v1.2.0', published_at: '2026-10-01T00:00:00Z' }]);
      if (url.includes('/compare/')) return okJson({ behind_by: 7, ahead_by: 0, status: 'behind' });
      if (url.includes('/security-advisories')) return okJson([{ ghsa_id: 'GHSA-xxxx', severity: 'high', summary: 'bad thing', html_url: 'a', published_at: '2026-10-02' }]);
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const state = await checkForUpdates(inventoryOf([repoItem({})]), { dataDir, fetchFn, exec: async () => ({ code: 1, stdout: '', stderr: '' }) });
    const r = state.results[0];
    expect(r).toMatchObject({ status: 'update_available', latestStable: 'v1.2.0', latestPrerelease: 'v1.3.0-rc.1', behindBy: 7 });
    expect(r.advisories[0].id).toBe('GHSA-xxxx');
    for (const u of urls) { expect(u.startsWith('https://api.github.com/repos/acme/tool')).toBe(true); expect(u).not.toMatch(/secret|path/i); }
    expect(state.history[0]).toMatchObject({ trigger: 'manual', updates: 1 });
  });

  it('does not send an unpushed commit hash to GitHub', async () => {
    const dataDir = tmp();
    const urls: string[] = [];
    const fetchFn = (async (url: string) => { urls.push(url); return url.includes('/releases') ? okJson([]) : okJson({ full_name: 'acme/tool', fork: true, parent: { full_name: 'origin/tool' }, default_branch: 'main', archived: false }); }) as unknown as typeof fetch;
    const state = await checkForUpdates(inventoryOf([repoItem({ details: { head: 'deadbeefcafe0000', headPushed: false } })]), { dataDir, fetchFn, exec: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect(urls.some((u) => u.includes('deadbeef'))).toBe(false);
    expect(state.results[0].fork).toEqual({ isFork: true, parent: 'origin/tool' });
    expect(state.results[0].summary).toMatch(/not on any remote branch/);
  });

  it('stops at the rate limit, marks the rest, and reuses ETag-cached bodies', async () => {
    const dataDir = tmp();
    const items = [repoItem({ id: 'git:a', upstream: { url: '', github: 'acme/a', verified: true, basis: '' } }), repoItem({ id: 'git:b', upstream: { url: '', github: 'acme/b', verified: true, basis: '' } })];
    const limited = (async (url: string) => {
      if (url.includes('acme/a')) return url.includes('/releases') ? okJson([{ tag_name: 'v1.0.0', prerelease: false, draft: false, html_url: 'x', published_at: null }]) : url.includes('/compare/') ? okJson({ behind_by: 0, ahead_by: 0 }) : okJson({ full_name: 'acme/a', fork: false, default_branch: 'main', archived: false });
      return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.UTC(2026, 10, 8, 20) / 1000)) } });
    }) as unknown as typeof fetch;
    const s1 = await checkForUpdates(inventoryOf(items), { dataDir, fetchFn: limited, exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => new Date('2026-11-08T19:00:00Z') });
    expect(s1.results.find((r) => r.itemId === 'git:a')!.status).toBe('up_to_date');
    expect(s1.results.find((r) => r.itemId === 'git:b')!.status).toBe('rate_limited');
    expect(s1.github.rateLimitedUntil).toBe('2026-11-08T20:00:00.000Z');

    // After the reset: 304 Not Modified answers reuse the cached body for acme/a.
    let notModified = 0;
    const conditional = (async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h['If-None-Match']) { notModified++; return new Response(null, { status: 304, headers: { 'x-ratelimit-remaining': '49' } }); }
      return url.includes('/releases') ? okJson([]) : okJson({ full_name: 'acme/b', fork: false, default_branch: 'main', archived: false });
    }) as unknown as typeof fetch;
    const s2 = await checkForUpdates(inventoryOf(items), { dataDir, fetchFn: conditional, exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => new Date('2026-11-08T20:30:00Z') });
    expect(notModified).toBeGreaterThan(0);
    expect(s2.results.find((r) => r.itemId === 'git:a')!.status).toBe('up_to_date');
    expect(s2.github.rateLimitedUntil).toBeNull();
  });

  it('keeps the last result, marked stale, when GitHub cannot be reached', async () => {
    const dataDir = tmp();
    const good = (async (url: string) => url.includes('/releases') ? okJson([{ tag_name: 'v2.0.0', prerelease: false, draft: false, html_url: 'x', published_at: null }]) : url.includes('/compare/') ? okJson({ behind_by: 0 }) : okJson({ full_name: 'acme/tool', fork: false, default_branch: 'main', archived: false })) as unknown as typeof fetch;
    await checkForUpdates(inventoryOf([repoItem({})]), { dataDir, fetchFn: good, exec: async () => ({ code: 1, stdout: '', stderr: '' }) });
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const s = await checkForUpdates(inventoryOf([repoItem({})]), { dataDir, fetchFn: offline, exec: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect(s.results[0]).toMatchObject({ status: 'update_available', stale: true });
    expect(s.results[0].error).toMatch(/fetch failed/);
    expect(readUpdateState(dataDir).history.length).toBe(2);
  });

  it('takes package-manager answers as authoritative and skips GitHub for those items', async () => {
    const dataDir = tmp();
    const inv = inventoryOf([{ id: 'npm:vite', kind: 'node_package', name: 'vite', version: '5.0.0', installMethod: 'npm', installPath: 'C:\\npm\\vite', packageId: 'vite', upstream: { url: '', github: 'vitejs/vite', verified: true, basis: '' }, source: 'npm', details: {} }]);
    inv.sections.push({ id: 'npm', label: 'npm', available: true, reason: null, count: 1, durationMs: 1 });
    let fetched = 0;
    const s = await checkForUpdates(inv, { dataDir, fetchFn: (async () => { fetched++; return new Response('{}'); }) as unknown as typeof fetch, exec: async (file, args) => (args.join(' ').includes('npm outdated') ? { code: 1, stdout: JSON.stringify({ vite: { current: '5.0.0', latest: '6.1.0' } }), stderr: '' } : { code: 1, stdout: '', stderr: '' }) });
    expect(s.results).toHaveLength(1);
    expect(s.results[0]).toMatchObject({ source: 'npm', status: 'update_available', latestStable: '6.1.0' });
    expect(fetched).toBe(0);
  });
});
