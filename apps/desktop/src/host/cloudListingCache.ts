/**
 * The last verified free-model listing per cloud provider, kept on disk.
 *
 * A listing is what Core returned from the provider's own model list after checking each model's price: which models
 * are free, and when that was checked. It holds no key and no user content. Before this file the listings lived only
 * in memory, so after every restart the v2 model menus had nothing to offer until someone opened the Classic UI and
 * pressed "discover" (Build 183: five providers enabled, no cloud model visible).
 *
 * Only a successful listing is stored: a failed check never replaces the last good one. The check time travels with
 * it, so the interface can say how old the list is.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopCloudModelListing } from '../ipc';
import { CLOUD_PROVIDER_ID_PATTERN } from './cloudProviderSettings';

export const CLOUD_LISTINGS_FILE = 'cloud-model-listings.json';
/** A stored listing older than this is checked again in the background after Core connects. */
export const CLOUD_LISTING_MAX_AGE_MS = 24 * 3_600_000;

export function cloudListingsPath(dataDir: string): string {
  return path.join(dataDir, CLOUD_LISTINGS_FILE);
}

function isListing(value: unknown): value is DesktopCloudModelListing {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.ok === true && typeof v.checkedAt === 'string' && Array.isArray(v.pool)
    && v.pool.every((m) => m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string');
}

export function loadCloudListings(dataDir: string): Map<string, DesktopCloudModelListing> {
  const out = new Map<string, DesktopCloudModelListing>();
  try {
    const raw = JSON.parse(fs.readFileSync(cloudListingsPath(dataDir), 'utf8')) as { listings?: Record<string, unknown> };
    for (const [id, listing] of Object.entries(raw?.listings ?? {})) {
      if (CLOUD_PROVIDER_ID_PATTERN.test(id) && isListing(listing)) out.set(id, listing);
    }
  } catch { /* no file yet, or unreadable: start empty */ }
  return out;
}

export function saveCloudListings(dataDir: string, listings: ReadonlyMap<string, DesktopCloudModelListing>): void {
  const good: Record<string, DesktopCloudModelListing> = {};
  for (const [id, listing] of listings) if (listing.ok && CLOUD_PROVIDER_ID_PATTERN.test(id)) good[id] = listing;
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${cloudListingsPath(dataDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, listings: good }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cloudListingsPath(dataDir));
}

/** True when there is no successful listing, or it was checked longer ago than `maxAgeMs`. */
export function cloudListingIsStale(listing: DesktopCloudModelListing | undefined, now: number, maxAgeMs = CLOUD_LISTING_MAX_AGE_MS): boolean {
  if (!listing?.ok) return true;
  const at = Date.parse(listing.checkedAt);
  return !Number.isFinite(at) || now - at > maxAgeMs;
}
