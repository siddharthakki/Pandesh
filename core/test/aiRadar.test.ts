import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyRelease, decideRadarFinding, RADAR_SOURCES, radarRequestText, readRadarState, renderRadarDigest, scanAiRadar, type RadarSource } from '../runtime/aiRadar';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const src = (id: string) => RADAR_SOURCES.find((s) => s.id === id)! as RadarSource;
const rel = (tag: string) => ({ tag, name: tag, publishedAt: '2026-11-03T00:00:00Z', url: `https://github.com/x/releases/${tag}`, notes: '' });

/** A fake GitHub: per repo one stable release (plus a prerelease that must be skipped) and optional advisories. */
function fakeGithub(releases: Record<string, string>, advisories: Record<string, Array<{ id: string; severity: string; publishedAt: string }>> = {}) {
  return async (url: string) => {
    const m = /repos\/(.+?)\/(releases|security-advisories)/.exec(url)!;
    const body = m[2] === 'releases'
      ? [{ tag_name: 'v99.0.0-rc1', prerelease: true }, ...(releases[m[1]] ? [{ tag_name: releases[m[1]], published_at: '2026-11-03T10:00:00Z', html_url: `https://github.com/${m[1]}/releases/${releases[m[1]]}`, body: 'notes' }] : [])]
      : (advisories[m[1]] ?? []).map((a) => ({ ghsa_id: a.id, severity: a.severity, summary: 'issue', html_url: `https://github.com/advisories/${a.id}`, published_at: a.publishedAt }));
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

describe('AI Radar classification', () => {
  it('flags an update for a tool Pandesh depends on and that is behind', () => {
    expect(classifyRelease(src('ollama'), rel('v0.40.15'), '0.40.12').classification).toBe('update_available');
    expect(classifyRelease(src('ollama'), rel('v0.40.15'), '0.40.15').classification).toBe('already_implemented');
  });
  it('treats an installed version newer than the GitHub release as current (Aider pip 0.86.2 vs release 0.86.0)', () => {
    const c = classifyRelease(src('aider'), rel('v0.86.0'), '0.86.2');
    expect(c.classification).toBe('already_implemented');
    expect(c.why).toContain('newer than the latest GitHub release');
  });
  it('never recommends what Pandesh already covers, and says when something does not fit this PC', () => {
    expect(classifyRelease(src('llama-cpp'), rel('b9999'), null).classification).toBe('already_implemented');
    expect(classifyRelease(src('vllm'), rel('v0.33.0'), null).classification).toBe('not_relevant');
    expect(classifyRelease(src('mcp'), rel('2026-07-28'), null).classification).toBe('missing_capability');
    expect(classifyRelease(src('opencode'), rel('v1.19.5'), null).classification).toBe('worth_testing');
  });
});

describe('AI Radar scan', () => {
  const sources = [src('ollama'), src('opencode')];
  const now = new Date('2026-11-09T06:30:00Z');

  it('stores findings once, keeps decisions across scans, and alerts only for new urgent advisories on installed tools', async () => {
    const fetchFn = fakeGithub({ 'ollama/ollama': 'v0.40.15', 'sst/opencode': 'v1.19.5' }, { 'ollama/ollama': [{ id: 'GHSA-aaaa', severity: 'high', publishedAt: '2026-11-05T00:00:00Z' }] });
    const installed = [{ name: 'Ollama version 0.40.12', version: '0.40.12' }];
    const first = await scanAiRadar({ dataDir: dir, installed, fetchFn, now, sources });
    expect(first.newFindings.map((f) => f.id).sort()).toEqual(['ollama#GHSA-aaaa', 'ollama@v0.40.15', 'opencode@v1.19.5']);
    expect(first.urgent.map((f) => f.id)).toEqual(['ollama#GHSA-aaaa']);
    decideRadarFinding(dir, 'opencode@v1.19.5', 'dismiss');
    const second = await scanAiRadar({ dataDir: dir, installed, fetchFn, now, sources });
    expect(second.newFindings).toEqual([]);
    expect(second.urgent).toEqual([]); // no repeated alarm
    expect(readRadarState(dir).findings['opencode@v1.19.5'].status).toBe('dismissed');
  });

  it('reuses a repo answer for six hours instead of spending the GitHub hourly request budget', async () => {
    let calls = 0;
    const counting = async (url: string) => { calls += 1; return fakeGithub({ 'ollama/ollama': 'v0.40.15' })(url); };
    await scanAiRadar({ dataDir: dir, installed: [], fetchFn: counting, now, sources: [src('ollama')] });
    const afterFirst = calls;
    const again = await scanAiRadar({ dataDir: dir, installed: [{ name: 'Ollama.Ollama', version: '0.40.15' }], fetchFn: counting, now: new Date(now.getTime() + 3_600_000), sources: [src('ollama')] });
    expect(calls).toBe(afterFirst); // no new requests
    expect(again.state.findings['ollama@v0.40.15'].classification).toBe('already_implemented'); // still reclassified
    await scanAiRadar({ dataDir: dir, installed: [], fetchFn: counting, now: new Date(now.getTime() + 7 * 3_600_000), sources: [src('ollama')] });
    expect(calls).toBeGreaterThan(afterFirst);
  });

  it('records unreadable sources as errors instead of failing the scan', async () => {
    const r = await scanAiRadar({ dataDir: dir, installed: [], fetchFn: async () => new Response('{}', { status: 403 }), now, sources });
    expect(r.errors.join(' ')).toContain('rate limit');
    expect(r.newFindings).toEqual([]);
  });

  it('turns decisions into governed chat requests that never install anything', async () => {
    await scanAiRadar({ dataDir: dir, installed: [{ name: 'Ollama.Ollama', version: '0.40.12' }], fetchFn: fakeGithub({ 'ollama/ollama': 'v0.40.15' }), now, sources: [src('ollama')] });
    const f = decideRadarFinding(dir, 'ollama@v0.40.15', 'prepare_update');
    expect(f.status).toBe('update_prepared');
    expect(radarRequestText(f, 'prepare_update')).toMatch(/do not run.*Do not install or change anything/s);
    expect(radarRequestText(f, 'investigate')).toMatch(/^Ask your Research specialist/);
  });

  it('the digest lists only actionable findings, grouped by class', async () => {
    const r = await scanAiRadar({ dataDir: dir, installed: [{ name: 'Ollama.Ollama', version: '0.40.12' }], fetchFn: fakeGithub({ 'ollama/ollama': 'v0.40.15', 'ggml-org/llama.cpp': 'b9999' }), now, sources: [src('ollama'), src('llama-cpp')] });
    const digest = renderRadarDigest(r.newFindings)!;
    expect(digest).toContain('Update available');
    expect(digest).toContain('Ollama v0.40.15');
    expect(digest).not.toContain('llama.cpp');
    expect(renderRadarDigest([])).toBeNull();
  });
});

describe('AI Radar daily routine', () => {
  it('scans on schedule, alerts once for an urgent finding, and posts no chat message of its own', async () => {
    const { openCoreDatabase } = await import('../db/openCore');
    const { EventBroadcaster } = await import('../ws/broadcaster');
    const { runAiRadarRoutine, scheduleAiRadar } = await import('../runtime/aiRadarRoutine');
    const db = openCoreDatabase(path.join(dir, 'core.db')).db;
    try {
      const task = scheduleAiRadar(db)!;
      expect(task).toMatchObject({ routine: 'ai_radar', dailyTime: '06:30', timezone: 'Europe/Berlin' });
      expect(scheduleAiRadar(db)!.id).toBe(task.id); // never a second schedule
      const fetchFn = fakeGithub({ 'ollama/ollama': 'v0.40.15' }, { 'ollama/ollama': [{ id: 'GHSA-bbbb', severity: 'critical', publishedAt: new Date(Date.now() - 86_400_000).toISOString() }] });
      const scan = (opts: Parameters<typeof scanAiRadar>[0]) => scanAiRadar({ ...opts, fetchFn, sources: [src('ollama')] });
      const installed = async () => [{ name: 'Ollama.Ollama', version: '0.40.12' }];
      await runAiRadarRoutine(db, new EventBroadcaster(), { task, dataDir: dir, installed, scan });
      await runAiRadarRoutine(db, new EventBroadcaster(), { task, dataDir: dir, installed, scan });
      expect(db.all<{ title: string }>('SELECT title FROM notification_outbox').map((n) => n.title)).toEqual(['Security: Ollama: issue']);
      expect(db.all('SELECT * FROM conversation_messages')).toHaveLength(0);
    } finally { db.close?.(); }
  });
});
