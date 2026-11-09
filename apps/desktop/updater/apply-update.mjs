/**
 * Pandesh updater. Runs under the bundled runtime/node.exe, outside the Electron app.
 *
 *   node apply-update.mjs inspect --package <file> --install-root <dir> --data-dir <dir>
 *       Verifies a package into <data-dir>/updates/staging and prints one JSON line. Installs nothing.
 *   node apply-update.mjs apply --install-root <dir> --data-dir <dir> --parent-pid <pid>
 *       Waits for Pandesh (and its Core) to exit, backs up every file it will replace, applies the staged package,
 *       starts Pandesh again and checks that the new UI and Core really came up. If anything fails it restores the
 *       backup (files, and the database when a migration was due) and starts the previous version.
 *
 * User data (<data-dir>: database, credentials, conversations, settings) is never written except the database
 * backup/restore around a declared migration and the update bookkeeping under <data-dir>/updates.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  FINGERPRINT_FILE, checkCompat, extractPackage, managedFor, mayForceStop, readDbSchema, readInstalled,
  readProcessIdentity, regenerateFingerprint, sha256File, verifyStaged,
} from './update-lib.mjs';

const HEALTH_TIMEOUT_MS = Number(process.env.PANDESH_UPDATE_HEALTH_TIMEOUT_MS) || 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Antivirus or an indexer can hold a freshly written file for a moment on Windows: retry before giving up. */
function withRetry(fn) {
  for (let attempt = 1; ; attempt += 1) {
    try { return fn(); } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

function parseArgs(argv) {
  const args = { _: argv[0] };
  for (let i = 1; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

function paths(dataDir) {
  const root = path.join(dataDir, 'updates');
  return {
    root,
    staging: path.join(root, 'staging'),
    backups: path.join(root, 'backups'),
    result: path.join(root, 'result.json'),
    health: path.join(root, 'ui-health.json'),
    lock: path.join(root, 'apply.lock'),
    log: path.join(root, 'update.log'),
  };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const installRoot = path.resolve(args['install-root'] ?? '');
  const dataDir = path.resolve(args['data-dir'] ?? '');
  if (!args['install-root'] || !args['data-dir'] || !fs.existsSync(path.join(installRoot, 'build-identity.json'))) {
    throw new Error('--install-root must be a Pandesh installation and --data-dir must be given');
  }
  const p = paths(dataDir);
  fs.mkdirSync(p.root, { recursive: true });
  if (args._ === 'inspect') return inspect(args, installRoot, dataDir, p);
  if (args._ === 'apply') return apply(args, installRoot, dataDir, p);
  throw new Error('usage: apply-update.mjs inspect|apply');
}

async function inspect(args, installRoot, dataDir, p) {
  extractPackage(args.package, p.staging);
  const manifest = verifyStaged(p.staging, installRoot);
  const installed = readInstalled(installRoot);
  const dbSchema = await readDbSchema(dataDir);
  const { problems, migrates } = checkCompat(manifest, installed, dbSchema);
  if (problems.length) throw new Error(problems.join('; '));
  console.log(JSON.stringify({
    ok: true,
    revision: manifest.revision,
    version: manifest.version,
    commit: manifest.commit,
    components: manifest.components,
    fileCount: manifest.files.length,
    installedRevision: installed.buildNumber,
    migrates,
    dbSchemaFrom: dbSchema,
    dbSchemaTo: manifest.compat.dbSchemaTarget,
    notes: manifest.notes ?? null,
  }));
}

async function apply(args, installRoot, dataDir, p) {
  const log = (m) => { try { fs.appendFileSync(p.log, `[${new Date().toISOString()}] ${m}\n`); } catch { /* best effort */ } };
  const parentPid = Number(args['parent-pid']);
  const coreRecordFile = path.join(dataDir, 'core.json');
  const result = (status, extra = {}) => {
    const body = { status, at: new Date().toISOString(), acknowledged: false, ...extra };
    fs.writeFileSync(p.result, `${JSON.stringify(body, null, 2)}\n`);
    log(`result: ${status} ${extra.reason ?? ''}`);
  };

  try { fs.writeFileSync(p.lock, String(process.pid), { flag: 'wx' }); } catch {
    const holder = Number(fs.readFileSync(p.lock, 'utf8'));
    if (alive(holder)) throw new Error('another update is already being applied');
    fs.writeFileSync(p.lock, String(process.pid));
  }
  let launched = null;
  let backupDir = null;
  let journal = null;
  const installedBefore = readInstalled(installRoot);

  const launchApp = () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.join(installRoot, 'electron', 'Pandesh.exe'), [path.join(installRoot, 'app')], {
      cwd: installRoot, detached: true, stdio: 'ignore', env, windowsHide: false,
    });
    child.unref();
    return { pid: child.pid, at: Date.now() };
  };
  // Force-stop only a process this update started: the expected executable, created after this update launched it.
  // A recycled PID, a stale core.json or one copied from another profile is left alone (and logged).
  const killTree = (pid, expectedExecutable, label) => {
    if (!alive(pid)) return;
    const identity = readProcessIdentity(pid);
    if (!mayForceStop(identity, expectedExecutable, launched?.at ?? Number.POSITIVE_INFINITY)) {
      log(`not force-stopping ${label} pid ${pid}: it is not the process this update started (${identity?.executablePath ?? 'identity unavailable'})`);
      return;
    }
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  };
  const coreCall = async (route, method = 'GET', body) => {
    const record = readJson(coreRecordFile);
    const token = fs.existsSync(path.join(dataDir, 'core.token')) ? fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim() : '';
    if (!record?.port || !token) return null;
    const attempt = () => fetch(`http://127.0.0.1:${record.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `update-${Date.now()}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(4000),
    });
    const res = await attempt().catch(() => attempt()); // a pooled keep-alive socket may have been closed by Core
    return res.ok ? res.json() : null;
  };
  const stopCore = async () => {
    const record = readJson(coreRecordFile);
    if (!record?.pid) return;
    // The address makes Core refuse (409) when core.json names another profile's Core.
    try { await coreCall('/v1/core/shutdown', 'POST', { expectedDataDir: dataDir }); } catch { /* fall through */ }
    for (let i = 0; i < 50 && alive(record.pid); i += 1) await sleep(200);
    killTree(record.pid, path.join(installRoot, 'runtime', 'node.exe'), 'Core');
  };

  try {
    // 1. Pandesh and its Core must be gone before a single file is touched.
    log(`apply: waiting for Pandesh pid ${parentPid} to exit`);
    for (let i = 0; i < 300 && alive(parentPid); i += 1) await sleep(200);
    if (alive(parentPid)) {
      try { await coreCall('/v1/core/update-gate', 'POST', { quiesce: false }); } catch { /* ignore */ }
      result('aborted', { reason: 'Pandesh did not close in time; nothing was changed.' });
      return;
    }
    const coreBefore = readJson(coreRecordFile);
    for (let i = 0; i < 150 && coreBefore?.pid && alive(coreBefore.pid); i += 1) await sleep(200);
    if (coreBefore?.pid && alive(coreBefore.pid)) {
      result('aborted', { reason: 'Core did not stop in time; nothing was changed.' });
      launched = launchApp();
      return;
    }

    // 2. Re-verify what was staged (it may have been tampered with since it was inspected) and re-check compatibility.
    const manifest = verifyStaged(p.staging, installRoot);
    const dbSchema = await readDbSchema(dataDir);
    const { problems, migrates } = checkCompat(manifest, installedBefore, dbSchema);
    if (problems.length) throw Object.assign(new Error(problems.join('; ')), { beforeChanges: true });

    // 3. Backup everything that will change, then journal it.
    backupDir = path.join(p.backups, `b${installedBefore.buildNumber}-to-b${manifest.revision}-${Date.now()}`);
    const filesDir = path.join(backupDir, 'files');
    const wanted = new Set(manifest.files.map((f) => f.path));
    const stale = [];
    for (const dir of managedFor(manifest.components).dirs) {
      const abs = path.join(installRoot, ...dir.split('/'));
      if (!fs.existsSync(abs)) continue;
      const stack = [dir];
      while (stack.length) {
        const rel = stack.pop();
        for (const e of fs.readdirSync(path.join(installRoot, ...rel.split('/')), { withFileTypes: true })) {
          const child = `${rel}/${e.name}`;
          if (e.isDirectory()) stack.push(child); else if (!wanted.has(child)) stale.push(child);
        }
      }
    }
    const touched = [...wanted, ...stale, FINGERPRINT_FILE];
    journal = { from: installedBefore.buildNumber, to: manifest.revision, files: [], db: null, stage: 'backup' };
    for (const rel of touched) {
      const src = path.join(installRoot, ...rel.split('/'));
      const had = fs.existsSync(src);
      if (had) {
        const dst = path.join(filesDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        if (sha256File(dst) !== sha256File(src)) throw Object.assign(new Error(`backup of ${rel} did not verify`), { beforeChanges: true });
      }
      journal.files.push({ path: rel, had });
    }
    if (migrates) {
      const dbBackup = path.join(backupDir, 'db');
      fs.mkdirSync(dbBackup, { recursive: true });
      journal.db = { files: [] };
      for (const name of ['core.db', 'core.db-wal', 'core.db-shm']) {
        const src = path.join(dataDir, name);
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dbBackup, name)); journal.db.files.push(name); }
      }
      if (!journal.db.files.includes('core.db')) journal.db = null;
    }
    fs.writeFileSync(path.join(backupDir, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
    log(`backup complete: ${journal.files.filter((f) => f.had).length} files${journal.db ? ' + database' : ''} in ${backupDir}`);

    // 4. Apply: replace via a sibling temp file so a file is either entirely old or entirely new.
    journal.stage = 'applying';
    fs.writeFileSync(path.join(backupDir, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
    for (const rel of stale) withRetry(() => fs.rmSync(path.join(installRoot, ...rel.split('/')), { force: true }));
    for (const f of manifest.files) {
      const dst = path.join(installRoot, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = `${dst}.pandesh-new`;
      fs.copyFileSync(path.join(p.staging, 'payload', ...f.path.split('/')), tmp);
      withRetry(() => fs.renameSync(tmp, dst));
    }
    regenerateFingerprint(installRoot, manifest);
    for (const f of manifest.files) {
      if (sha256File(path.join(installRoot, ...f.path.split('/'))) !== f.sha256) throw new Error(`${f.path} did not verify after it was written`);
    }
    log(`applied ${manifest.files.length} files, removed ${stale.length} stale`);

    // 5. Start the new version and prove it works.
    journal.stage = 'verifying';
    fs.writeFileSync(path.join(backupDir, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
    fs.rmSync(p.health, { force: true });
    launched = launchApp();
    const expectedCoreHash = sha256File(path.join(installRoot, 'runtime', 'core.js'));
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let ok = null;
    while (Date.now() < deadline && !ok) {
      await sleep(1000);
      if (!alive(launched.pid)) throw new Error('the updated Pandesh exited during start-up');
      const health = readJson(p.health);
      if (!health || health.buildNumber !== manifest.revision || Date.parse(health.at) < launched.at || !health.rendererLoaded || !health.coreConnected) continue;
      const info = await coreCall('/v1/core/info').catch(() => null);
      if (info && info.bundleHash === expectedCoreHash) ok = { health, info };
    }
    if (!ok) throw new Error('the updated Pandesh did not report a loaded window and a running new Core in time');

    result('success', {
      revision: manifest.revision,
      version: manifest.version,
      fromRevision: installedBefore.buildNumber,
      dbMigrated: migrates ? { from: dbSchema, to: manifest.compat.dbSchemaTarget } : null,
      coreBundleHash: expectedCoreHash,
      backup: backupDir,
    });
    const byAge = (name) => Number(name.split('-').pop());
    for (const old of fs.readdirSync(p.backups).sort((a, b) => byAge(a) - byAge(b)).slice(0, -2)) fs.rmSync(path.join(p.backups, old), { recursive: true, force: true });
    fs.rmSync(p.staging, { recursive: true, force: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`apply failed: ${reason}`);
    if (!journal || err?.beforeChanges) {
      // Nothing (or nothing but a verified copy) was changed; just make sure Pandesh is running again.
      result('aborted', { reason: `${reason}. Nothing was changed.`, fromRevision: installedBefore.buildNumber });
      if (!launched) launched = launchApp();
      return;
    }
    // Roll back: stop what we started, restore the files and, if it was due to migrate, the database.
    killTree(launched?.pid, path.join(installRoot, 'electron', 'Pandesh.exe'), 'Pandesh');
    await stopCore();
    try {
      for (const f of journal.files) {
        const dst = path.join(installRoot, ...f.path.split('/'));
        if (f.had) {
          const src = path.join(backupDir, 'files', ...f.path.split('/'));
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, `${dst}.pandesh-restore`);
          withRetry(() => fs.renameSync(`${dst}.pandesh-restore`, dst));
          if (sha256File(dst) !== sha256File(src)) throw new Error(`restored ${f.path} does not match its backup`);
        } else {
          fs.rmSync(dst, { force: true });
        }
      }
      if (journal.db) {
        for (const name of ['core.db', 'core.db-wal', 'core.db-shm']) fs.rmSync(path.join(dataDir, name), { force: true });
        for (const name of journal.db.files) fs.copyFileSync(path.join(backupDir, 'db', name), path.join(dataDir, name));
      }
      const back = readInstalled(installRoot);
      result('rolled_back', { reason, revision: back.buildNumber, attemptedRevision: journal.to, dbRestored: Boolean(journal.db) });
      launched = launchApp();
    } catch (restoreErr) {
      result('rollback_failed', { reason, restoreError: String(restoreErr?.message ?? restoreErr), backup: backupDir });
    }
  } finally {
    fs.rmSync(p.lock, { force: true });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(2);
});
