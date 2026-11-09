#!/usr/bin/env node
/**
 * Copies a Pandesh profile for an upgrade rehearsal or a test run WITHOUT its live identity or its secrets.
 *
 *   node apps/desktop/scripts/clone-profile-for-rehearsal.mjs --from <profile dir> --to <new empty dir> [--keep-schedules]
 *
 * Why: the Build 160 rehearsal copied the production profile wholesale. The copy's core.json + core.token led the
 * rehearsal app straight to the PRODUCTION Core, and quitting the rehearsal stopped it. A wholesale copy also carries:
 *   - the process-ownership ledger and its token (a copy could force-stop the original's processes),
 *   - the Electron profile whose `Local State` holds the safeStorage key, i.e. the ability to decrypt the copied
 *     Gmail / Google / cloud-provider credentials (a rehearsal must not be able to send mail or spend credits),
 *   - the phone pairing and companion TLS/vault secrets,
 *   - enabled schedules, so the copy would run the 06:30 / 08:00 routines a second time next to production.
 *
 * What it does:
 *   - takes a CONSISTENT database copy with SQLite `VACUUM INTO` (safe while the source Core is running; the source
 *     is opened read-only and never written),
 *   - copies everything else except the live-identity and secret files below,
 *   - in the COPY only: disables every schedule (unless --keep-schedules) and drops the copied single-owner claim,
 *   - writes rehearsal-clone.json describing what was left out.
 * The source profile is only read.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** Files that identify the RUNNING instance of the source profile. A copy must create its own. */
export const LIVE_IDENTITY_FILES = [
  'core.json', 'core.lock', 'core.token', 'host.token', 'client-id.json',
  'port-manager.token', 'port-manager-registry.json', 'process-ownership-ledger.json', 'browser-launched-processes.json',
];
/** Secrets the copy must not be able to use. */
export const SECRET_FILES = ['mobile-pair.json', 'companion-tls.json', 'companion-vault.json', 'companion-sync.json'];
export const SECRET_PATTERNS = [/\.credential\.bin$/i];
/** Directories that are runtime state or hold the key that decrypts the credentials. */
export const EXCLUDED_DIRS = ['electron-profile', 'updates', 'logs', 'migration-backups'];
/** The database is copied separately and consistently. */
const DATABASE_FILES = ['core.db', 'core.db-wal', 'core.db-shm', 'core.db-journal'];

function parseArgs(argv) {
  const args = { keepSchedules: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--to') args.to = argv[++i];
    else if (argv[i] === '--keep-schedules') args.keepSchedules = true;
  }
  return args;
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function excludedReason(rel) {
  const top = rel.split(/[\\/]/)[0];
  if (EXCLUDED_DIRS.includes(top)) return 'runtime state / key material';
  const name = path.basename(rel);
  if (rel === name && LIVE_IDENTITY_FILES.includes(name)) return 'live identity';
  if (rel === name && SECRET_FILES.includes(name)) return 'secret';
  if (SECRET_PATTERNS.some((pattern) => pattern.test(name))) return 'secret';
  if (rel === name && DATABASE_FILES.includes(name)) return 'database (copied consistently)';
  if (/^\.core\.(json|lock)\./.test(name)) return 'live identity';
  return null;
}

export function cloneProfileForRehearsal({ from, to, keepSchedules = false }) {
  if (!from || !to) throw new Error('both --from and --to are required');
  const source = path.resolve(from);
  const target = path.resolve(to);
  if (!fs.existsSync(path.join(source, 'core.db'))) throw new Error(`${source} is not a Pandesh profile (no core.db)`);
  if (isInside(target, source) || isInside(source, target)) throw new Error('the copy must not be inside the source profile (or the other way round)');
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`${target} is not empty; refusing to overwrite anything`);
  fs.mkdirSync(target, { recursive: true });

  const excluded = [];
  const copied = [];
  const walk = (relDir) => {
    for (const entry of fs.readdirSync(path.join(source, relDir), { withFileTypes: true })) {
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      const reason = excludedReason(rel);
      if (reason) {
        excluded.push({ path: rel.replace(/\\/g, '/'), reason });
        continue;
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(path.join(target, rel), { recursive: true });
        walk(rel);
      } else if (entry.isFile()) {
        fs.copyFileSync(path.join(source, rel), path.join(target, rel));
        copied.push(rel.replace(/\\/g, '/'));
      }
    }
  };
  walk('');

  // A consistent snapshot even while the source Core writes: the source is opened read-only.
  const sourceDb = new DatabaseSync(path.join(source, 'core.db'), { readOnly: true });
  try {
    sourceDb.exec(`VACUUM INTO '${path.join(target, 'core.db').replace(/'/g, "''")}'`);
  } finally {
    sourceDb.close();
  }

  const copy = new DatabaseSync(path.join(target, 'core.db'));
  let schedulesDisabled = 0;
  let ownerClaimDropped = false;
  try {
    const hasTable = (name) => Boolean(copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    if (!keepSchedules && hasTable('scheduled_tasks')) {
      schedulesDisabled = Number(copy.prepare('UPDATE scheduled_tasks SET enabled = 0 WHERE enabled = 1').run().changes);
    }
    if (hasTable('core_metadata')) {
      ownerClaimDropped = Number(copy.prepare("DELETE FROM core_metadata WHERE key = 'singleton_owner'").run().changes) > 0;
    }
    const check = copy.prepare('PRAGMA integrity_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error(`the copied database failed its integrity check: ${JSON.stringify(check)}`);
  } finally {
    copy.close();
  }

  const summary = {
    clonedFrom: source,
    clonedAt: new Date().toISOString(),
    copiedFiles: copied.length,
    excluded,
    schedulesDisabled,
    ownerClaimDropped,
    note: 'Rehearsal copy: no live identity, no credentials, schedules disabled. Connect accounts again only if the rehearsal needs them.',
  };
  fs.writeFileSync(path.join(target, 'rehearsal-clone.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  try {
    const summary = cloneProfileForRehearsal(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, ...summary, excluded: summary.excluded.length }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}
