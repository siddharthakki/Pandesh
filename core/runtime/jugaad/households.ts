/**
 * Household scope for JUGAAD. A household is a hard data boundary: its documents, its search index and its upload
 * staging live in their own folder (`<dataDir>/jugaad/<householdId>/`), and a paired phone belongs to exactly one household.
 * Every JUGAAD operation resolves the calling device to its household first; nothing downstream takes a household id from
 * the phone, so a phone cannot name another household's data. There is no cross-household query anywhere.
 *
 * The registry is a small JSON file written only by the Pandesh app (host-only routes); a phone cannot create a household or
 * attach itself to one.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from '../../domain/errors';

export const HOUSEHOLD_ID = /^hh_[a-f0-9]{12}$/;

export interface Household { id: string; name: string; createdAt: string }
export interface HouseholdRegistry {
  version: 1; households: Household[]; devices: Record<string, string>;
  /**
   * The household that owns the records created before households existed (important dates, briefings...). Never set automatically:
   * until the owner names one, those records are visible only to phones that belong to no household (the way they always worked), and
   * to no household's phone.
   */
  legacyOwner: string | null;
}

const FILE = path.join('jugaad', 'households.json');

export function jugaadRoot(dataDir: string): string { return path.join(dataDir, 'jugaad'); }

export function loadHouseholds(dataDir: string): HouseholdRegistry {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')) as Partial<HouseholdRegistry>;
    const households = Array.isArray(raw.households) ? raw.households.filter(h => HOUSEHOLD_ID.test(String(h?.id))) : [];
    const legacy = typeof raw.legacyOwner === 'string' && households.some(h => h.id === raw.legacyOwner) ? raw.legacyOwner : null;
    return { version: 1, households, devices: raw.devices && typeof raw.devices === 'object' ? raw.devices as Record<string, string> : {}, legacyOwner: legacy };
  } catch { return { version: 1, households: [], devices: {}, legacyOwner: null }; }
}

function save(dataDir: string, reg: HouseholdRegistry): void {
  const file = path.join(dataDir, FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, file);
}

export function createHousehold(dataDir: string, name: string): Household {
  const clean = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  if (clean.length < 2 || clean.length > 60) throw new CoreError('invalid_request', 'a household name is 2-60 characters');
  const reg = loadHouseholds(dataDir);
  if (reg.households.some(h => h.name.toLowerCase() === clean.toLowerCase())) throw new CoreError('conflict', `a household called '${clean}' already exists`);
  const h: Household = { id: `hh_${crypto.randomBytes(6).toString('hex')}`, name: clean, createdAt: new Date().toISOString() };
  reg.households.push(h);
  save(dataDir, reg);
  householdDirs(dataDir, h.id);
  return h;
}

/** Attaches an already-paired phone to a household (host only; the caller verified the device exists and is not revoked). */
export function attachDevice(dataDir: string, deviceId: string, householdId: string): void {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) throw new CoreError('invalid_request', 'malformed device id');
  const reg = loadHouseholds(dataDir);
  if (!reg.households.some(h => h.id === householdId)) throw new CoreError('not_found', 'household not found');
  const current = reg.devices[deviceId];
  if (current && current !== householdId) throw new CoreError('conflict', 'this phone already belongs to another household; detach it first');
  reg.devices[deviceId] = householdId;
  save(dataDir, reg);
}

/** Explicitly assigns (or clears) the household that owns the pre-household records. Host only; nothing ever does this by itself. */
export function setLegacyOwner(dataDir: string, householdId: string | null): void {
  const reg = loadHouseholds(dataDir);
  if (householdId !== null && !reg.households.some(h => h.id === householdId)) throw new CoreError('not_found', 'household not found');
  reg.legacyOwner = householdId;
  save(dataDir, reg);
}

export function legacyOwnerOf(dataDir: string): string | null { return loadHouseholds(dataDir).legacyOwner; }

export function detachDevice(dataDir: string, deviceId: string): boolean {
  const reg = loadHouseholds(dataDir);
  if (!(deviceId in reg.devices)) return false;
  delete reg.devices[deviceId];
  save(dataDir, reg);
  return true;
}

/** The household of a phone, or null: a phone with no household can use none of the JUGAAD document services. */
export function householdOfDevice(dataDir: string, deviceId: string): string | null {
  const id = loadHouseholds(dataDir).devices[deviceId];
  return id && HOUSEHOLD_ID.test(id) ? id : null;
}

export interface HouseholdDirs { root: string; inbox: string; uploads: string; index: string }

/** The household's folders, created on demand. The id is validated, so it can never be a path. */
export function householdDirs(dataDir: string, householdId: string): HouseholdDirs {
  if (!HOUSEHOLD_ID.test(householdId)) throw new CoreError('invalid_request', 'malformed household id');
  const root = path.join(jugaadRoot(dataDir), householdId);
  const dirs = { root, inbox: path.join(root, 'inbox'), uploads: path.join(root, 'uploads'), index: path.join(root, 'index.sqlite') };
  fs.mkdirSync(dirs.inbox, { recursive: true });
  fs.mkdirSync(dirs.uploads, { recursive: true });
  return dirs;
}
