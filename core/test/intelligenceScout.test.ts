import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIntelligenceScout } from '../runtime/intelligenceScout';

describe('Intelligence scout', () => {
  function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'scout-')); }

  it('adds and lists watches durably', () => {
    const dir = tmpDir();
    const scout = createIntelligenceScout({ dataDir: dir });
    const w = scout.addWatch({ kind: 'github_repo', target: 'octocat/Hello-World', name: 'Hello' });
    expect(w.id).toBeTruthy();
    const list = scout.listWatches();
    expect(list).toHaveLength(1);
    expect(list[0].target).toBe('octocat/Hello-World');
    // reload
    const scout2 = createIntelligenceScout({ dataDir: dir });
    expect(scout2.listWatches()).toHaveLength(1);
  });

  it('removes a watch', () => {
    const dir = tmpDir();
    const scout = createIntelligenceScout({ dataDir: dir });
    const w = scout.addWatch({ kind: 'github_repo', target: 'a/b' });
    expect(scout.removeWatch(w.id)).toBe(true);
    expect(scout.removeWatch(w.id)).toBe(false);
    expect(scout.listWatches()).toHaveLength(0);
  });

  it('pauses and resumes', () => {
    const dir = tmpDir();
    const scout = createIntelligenceScout({ dataDir: dir });
    const w = scout.addWatch({ kind: 'github_repo', target: 'a/b' });
    expect(scout.pauseWatch(w.id, true)).toBe(true);
    expect(scout.listWatches()[0].paused).toBe(true);
  });

  it('detects a new GitHub release', async () => {
    const dir = tmpDir();
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ tag_name: 'v1.2.3', html_url: 'https://example.com/r', published_at: '2026-10-20T00:00:00Z', body: 'notes' }),
      text: async () => '',
    }));
    const scout = createIntelligenceScout({ dataDir: dir, fetchFn });
    const w = scout.addWatch({ kind: 'github_repo', target: 'owner/repo' });
    const r = await scout.runWatch(w.id);
    expect(r.changed).toBe(true);
    expect(r.finding?.title).toContain('v1.2.3');
    // second run: no change
    const r2 = await scout.runWatch(w.id);
    expect(r2.changed).toBe(false);
  });

  it('reports no change on same version', async () => {
    const dir = tmpDir();
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ tag_name: 'v1.0.0', html_url: 'u', published_at: null, body: '' }),
      text: async () => '',
    }));
    const scout = createIntelligenceScout({ dataDir: dir, fetchFn });
    const w = scout.addWatch({ kind: 'github_repo', target: 'o/r' });
    await scout.runWatch(w.id);
    const r = await scout.runWatch(w.id);
    expect(r.changed).toBe(false);
    expect(r.message).toContain('No new release');
  });

  it('handles fetch failure gracefully', async () => {
    const dir = tmpDir();
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
    const scout = createIntelligenceScout({ dataDir: dir, fetchFn });
    const w = scout.addWatch({ kind: 'github_repo', target: 'o/r' });
    const r = await scout.runWatch(w.id);
    expect(r.changed).toBe(false);
    expect(r.message).toContain('HTTP 404');
  });

  it('researches a repo with real metadata', async () => {
    const dir = tmpDir();
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ full_name: 'o/r', description: 'desc', html_url: 'https://github.com/o/r', stargazers_count: 42, updated_at: '2026-10-20T00:00:00Z', license: { spdx_id: 'MIT' } }),
      text: async () => '',
    }));
    const scout = createIntelligenceScout({ dataDir: dir, fetchFn });
    const r = await scout.researchGithubRepo('o/r');
    expect(r.finding).not.toBeNull();
    expect(r.finding?.summary).toContain('42');
    expect(r.finding?.summary).toContain('MIT');
  });

  it('runAll skips paused watches', async () => {
    const dir = tmpDir();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1', html_url: 'u', published_at: null, body: '' }), text: async () => '' }));
    const scout = createIntelligenceScout({ dataDir: dir, fetchFn });
    const w1 = scout.addWatch({ kind: 'github_repo', target: 'a/b' });
    const w2 = scout.addWatch({ kind: 'github_repo', target: 'c/d' });
    scout.pauseWatch(w2.id, true);
    const r = await scout.runAll();
    expect(r.results).toHaveLength(2);
    expect(r.results.find((x) => x.id === w2.id)?.message).toContain('paused');
  });
});
