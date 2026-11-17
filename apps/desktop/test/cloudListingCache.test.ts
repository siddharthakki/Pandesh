import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOUD_LISTING_MAX_AGE_MS, cloudListingIsStale, cloudListingsPath, loadCloudListings, saveCloudListings } from '../src/host/cloudListingCache';
import type { DesktopCloudModelListing } from '../src/ipc';

const dirs: string[] = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-listings-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const listing = (over: Partial<DesktopCloudModelListing> = {}): DesktopCloudModelListing => ({
  ok: true, checkedAt: '2026-11-17T09:00:00.000Z', latencyMs: 120,
  pool: [{ id: 'llama-free', displayName: 'Llama' } as never],
  excluded: { paid: 3, unknown: 0, promotional: 0, trial: 0, nonGenerative: 1 },
  ...over,
});

describe('cloud model listings kept across a restart', () => {
  it('restores the last verified free-model lists, so the menus are not empty after a restart', () => {
    const dir = tempDir();
    saveCloudListings(dir, new Map([['groq', listing()], ['nvidia', listing({ pool: [] })]]));
    const back = loadCloudListings(dir);
    expect([...back.keys()].sort()).toEqual(['groq', 'nvidia']);
    expect(back.get('groq')?.pool.map((m) => m.id)).toEqual(['llama-free']);
    expect(back.get('groq')?.checkedAt).toBe('2026-11-17T09:00:00.000Z');
  });

  it('never stores a failed check, a key, or an invalid provider id', () => {
    const dir = tempDir();
    saveCloudListings(dir, new Map([
      ['groq', listing()],
      ['cerebras', listing({ ok: false, error: 'HTTP 401', errorClass: 'auth', pool: [] })],
      ['../evil', listing()],
    ]));
    const text = fs.readFileSync(cloudListingsPath(dir), 'utf8');
    expect(Object.keys(JSON.parse(text).listings)).toEqual(['groq']);
    expect(text).not.toMatch(/api[_-]?key|authorization|bearer/i);
  });

  it('starts empty on a missing or damaged file and ignores entries that are not listings', () => {
    const dir = tempDir();
    expect(loadCloudListings(dir).size).toBe(0);
    fs.writeFileSync(cloudListingsPath(dir), '{not json');
    expect(loadCloudListings(dir).size).toBe(0);
    fs.writeFileSync(cloudListingsPath(dir), JSON.stringify({ listings: { groq: { ok: true, checkedAt: 'x', pool: [{ nope: 1 }] }, nvidia: listing(), bad: { ok: false, checkedAt: 'x', pool: [] } } }));
    expect([...loadCloudListings(dir).keys()]).toEqual(['nvidia']);
  });

  it('asks for a new check only when there is no good list or it is older than a day', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(cloudListingIsStale(undefined, now)).toBe(true);
    expect(cloudListingIsStale(listing({ ok: false }), now)).toBe(true);
    expect(cloudListingIsStale(listing({ checkedAt: 'never' }), now)).toBe(true);
    expect(cloudListingIsStale(listing(), now)).toBe(false);
    expect(cloudListingIsStale(listing({ checkedAt: new Date(now - CLOUD_LISTING_MAX_AGE_MS - 1).toISOString() }), now)).toBe(true);
  });
});
