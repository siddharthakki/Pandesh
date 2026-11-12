/**
 * The ONE isolated update test.
 *
 * Installs the b151 SMOKE installer (distinct AppId) into a scratch directory with its own LOCALAPPDATA/data dir, then:
 *   A. rejects tampered / extra-file / untrusted-key / forged-manifest / outdated / wrong-base / traversal packages
 *   B. checks the Core update gate and that a started write is awaited
 *   C. applies a good update (b152) from the running app, via the same IPC the Update & Restart button uses
 *   D. applies a deliberately broken update (b153: new Core corrupts the database and exits) and expects the
 *      automatic rollback to restore the files AND the database
 * It checks after every step that user data survived and that the owner's real installation was not touched.
 *
 *   node scripts/update-isolated-test.mjs [path-to-Pandesh-Smoke-Setup.exe]
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as esbuild from 'esbuild';
import { buildUpdatePackage, generateKeypair, latestMigrationVersion } from './build-update-package.mjs';
import { sha256File } from '../updater/update-lib.mjs';
import { stopSmokeProcesses, uninstallSmoke } from './lib/smoke-cleanup.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const setupPath = process.argv[2] ?? path.join(repoRoot, '.tmp', 'update-test', 'installer-b151', 'Pandesh-Smoke-Setup.exe');
const keyDir = process.env.PANDESH_UPDATE_KEY_DIR ?? path.join(process.env.LOCALAPPDATA, 'KarkeDikha', 'update-signing');
const ownerRoot = path.join(process.env.LOCALAPPDATA, 'Programs', 'Pandesh');
const scratch = path.join(os.tmpdir(), `karkedikha-installer-smoke-update-${Date.now()}`);
const installDir = path.join(scratch, 'install');
const isolatedLocal = path.join(scratch, 'localappdata');
const dataDir = path.join(isolatedLocal, 'KarkeDikha', 'desktop');
const pkgDir = path.join(scratch, 'packages');
const updatesDir = path.join(dataDir, 'updates');
let cdpPort = String(9600 + (process.pid % 90));
const evidenceFile = path.join(repoRoot, '.tmp', 'update-test', 'update-isolated-test.json');
const checks = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`);
}
async function waitFor(label, fn, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError = '';
  while (Date.now() < deadline) {
    try { last = await fn(); } catch (e) { last = null; lastError = String(e?.message ?? e); }
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}: ${lastError}`);
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ownerFingerprint = () => {
  const f = (p) => (fs.existsSync(p) ? `${sha256File(p)}:${fs.statSync(p).mtimeMs}` : 'absent');
  return JSON.stringify([f(path.join(ownerRoot, 'build-identity.json')), f(path.join(ownerRoot, 'runtime', 'core.js')), f(path.join(ownerRoot, 'electron', 'Pandesh.exe'))]);
};

const env = {
  ...process.env,
  LOCALAPPDATA: isolatedLocal,
  APPDATA: path.join(scratch, 'appdata'),
  KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
  KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
  KARKEDIKHA_MOBILE_PORT: String(3300 + (process.pid % 100)),
  KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
  KARKEDIKHA_UPDATE_TEST_AUTOCONFIRM: '1',
  PANDESH_UPDATE_HEALTH_TIMEOUT_MS: '60000',
};
delete env.ELECTRON_RUN_AS_NODE;

let ws = null;
let nextId = 1;
const pending = new Map();
async function cdp(method, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const page = await waitFor('cdp page', async () => {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      return pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) ?? null;
    }, 150_000);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
    });
  }
  const id = nextId++;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const res = await cdp('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(`eval: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
  return res.result?.value;
}

function launchApp() {
  const child = spawn(path.join(installDir, 'electron', 'Pandesh.exe'), [path.join(installDir, 'app')], {
    cwd: installDir, detached: true, stdio: 'ignore', env, windowsHide: false,
  });
  child.unref();
  return child.pid;
}
async function appConnected() {
  await waitFor('desktop api', () => evaluate('Boolean(window.karkedikhaDesktop)'), 180_000);
  return waitFor('core connected', async () => {
    const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    return s?.coreState === 'connected' ? s : null;
  }, 180_000);
}
async function core(route, method = 'GET', body) {
  const rec = readJson(path.join(dataDir, 'core.json'));
  const token = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
  const attempt = () => fetch(`http://127.0.0.1:${rec.port}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `t-${Date.now()}-${Math.random()}`, 'X-Client-Id': 'update-test' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // A pooled keep-alive socket may have been closed by Core's idle timeout: retry once on a fresh connection.
  const res = await attempt().catch(() => attempt()).catch((e) => { throw new Error(`Core unreachable at ${rec.port} (pid ${rec.pid} alive=${alive(rec.pid)}): ${e.cause?.code ?? e.message}`); });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const installedIdentity = () => readJson(path.join(installDir, 'build-identity.json'));
const coreHash = () => sha256File(path.join(installDir, 'runtime', 'core.js'));
function updater(...args) {
  const r = spawnSync(path.join(installDir, 'runtime', 'node.exe'), [path.join(installDir, 'updater', 'apply-update.mjs'), ...args, '--install-root', installDir, '--data-dir', dataDir], { encoding: 'utf8', windowsHide: true, env });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** Builds a signed package from the INSTALLED tree plus a marker (so the installed files really change). */
function makePackage(name, { revision, min, max, privateKeyPem, baseVersion, coreTransform, dbTarget, mutate }) {
  const work = path.join(pkgDir, `${name}-src`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.cpSync(path.join(installDir, 'app', 'out'), path.join(work, 'out'), { recursive: true });
  fs.cpSync(path.join(installDir, 'app', 'renderer'), path.join(work, 'renderer'), { recursive: true });
  const coreJs = path.join(work, 'core.js');
  fs.writeFileSync(coreJs, coreTransform(fs.readFileSync(path.join(installDir, 'runtime', 'core.js'), 'utf8')));
  fs.appendFileSync(path.join(work, 'renderer', 'v2', 'app.js'), `\n// pandesh-update-test ${name}\n`);
  const base = installedIdentity();
  const identity = { ...base, buildNumber: revision, builtAt: new Date().toISOString() };
  const outFile = path.join(pkgDir, `${name}.pdupdate`);
  const electron = fs.readFileSync(path.join(installDir, 'electron', 'version'), 'utf8').trim().replace(/^v/, '');
  const result = buildUpdatePackage({
    sources: { coreJs, uiOutDir: path.join(work, 'out'), uiRendererDir: path.join(work, 'renderer'), appPackageJson: fs.readFileSync(path.join(installDir, 'app', 'package.json'), 'utf8'), buildIdentity: identity },
    components: ['core', 'ui'],
    meta: { revision, version: base.version, commit: 'update-test', sourceState: 'dirty', builtAt: identity.builtAt },
    compat: { baseVersion: baseVersion ?? base.version, installedBuildMin: min, installedBuildMax: max, electron, dbSchemaTarget: dbTarget ?? latestMigrationVersion() },
    privateKeyPem,
    outFile,
  });
  mutate?.(outFile);
  return { ...result, outFile, coreSha: sha256File(coreJs) };
}

/** Unzips a package, lets `edit(dir)` change it, and zips it back with the original manifest and signature. */
function repack(src, name, edit) {
  const dir = path.join(pkgDir, `${name}-x`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  spawnSync(tar, ['-xf', src, '-C', dir], { windowsHide: true });
  edit(dir);
  const out = path.join(pkgDir, `${name}.pdupdate`);
  fs.rmSync(out, { force: true });
  const entries = ['manifest.json', 'manifest.sig', 'payload'];
  spawnSync(tar, ['--format', 'zip', '-cf', out, '-C', dir, ...entries], { windowsHide: true });
  return out;
}


/** A minimal one-entry stored zip, so a hostile entry name can be written that bsdtar would refuse to create. */
function storedZip(name, text) {
  const data = Buffer.from(text);
  const nameBuf = Buffer.from(name);
  const crc = (() => { let c, crc = 0xffffffff; for (const b of data) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; })();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  const localPart = Buffer.concat([local, nameBuf, data]);
  const centralPart = Buffer.concat([central, nameBuf]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12); end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

async function stateOfData() {
  const seeded = {};
  for (const f of ['oauth-seed.json', 'settings-seed.json']) seeded[f] = sha256File(path.join(dataDir, f));
  const conv = await core('/v1/conversations');
  const found = (conv.body?.conversations ?? conv.body ?? []).some?.((c) => c.title === 'update-test-marker');
  return { seeded, conversationPresent: Boolean(found), conversationCount: (conv.body?.conversations ?? []).length };
}

async function applyViaUi(packagePath) {
  const startedAt = Date.now();
  fs.rmSync(path.join(updatesDir, 'result.json'), { force: true });
  // The window may close before the reply arrives; the updater's result file is the real proof either way.
  const r = await evaluate(`window.karkedikhaDesktop.startUpdate(${JSON.stringify(packagePath)})`).catch(() => ({ status: 'applying', message: 'window closed first' }));
  try { ws?.close(); } catch { /* the app is quitting */ }
  ws = null;
  const result = await waitFor('updater result', () => {
    const rec = readJson(path.join(updatesDir, 'result.json'));
    return rec && Date.parse(rec.at) >= startedAt ? rec : null;
  }, 360_000);
  return { ui: r, result };
}

async function main() {
  if (!fs.existsSync(setupPath)) throw new Error(`smoke setup missing: ${setupPath}`);
  if (!fs.existsSync(path.join(keyDir, 'signing-key.pem'))) throw new Error('signing key missing; run build-update-package.mjs keygen');
  const privateKeyPem = fs.readFileSync(path.join(keyDir, 'signing-key.pem'), 'utf8');
  const ownerBefore = ownerFingerprint();
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(pkgDir, { recursive: true });

  // ---- install + seed -------------------------------------------------------------------------------------------
  const inst = spawnSync(setupPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${installDir}`], { env, windowsHide: true });
  check('smoke baseline installed', inst.status === 0 && fs.existsSync(path.join(installDir, 'updater', 'apply-update.mjs')), installDir);
  const base = installedIdentity();
  check('baseline is b151 with the updater and trust key shipped', base.buildNumber === 151 && fs.existsSync(path.join(installDir, 'updater', 'update-trust.json')), { build: base.buildNumber });
  fs.writeFileSync(path.join(dataDir, 'oauth-seed.json'), JSON.stringify({ refresh_token: 'seed-secret-do-not-lose' }));
  fs.writeFileSync(path.join(dataDir, 'settings-seed.json'), JSON.stringify({ theme: 'seeded' }));

  launchApp();
  await appConnected();
  const created = await core('/v1/conversations', 'POST', { mode: 'baat_kar', title: 'update-test-marker' });
  check('seed conversation created in Core', created.status === 201, created.status);
  const dataBefore = await stateOfData();
  check('baseline data readable', dataBefore.conversationPresent, dataBefore);

  const original = { core: coreHash(), renderer: sha256File(path.join(installDir, 'app', 'renderer', 'v2', 'app.js')) };

  // ---- A. rejections ----------------------------------------------------------------------------------------------
  const good = makePackage('b152', { revision: 152, min: 151, max: 151, privateKeyPem, coreTransform: (s) => `${s}\n// pandesh-update-test b152\n` });
  const inspectGood = updater('inspect', '--package', good.outFile);
  check('A0 a good package inspects clean', inspectGood.status === 0 && JSON.parse(inspectGood.out).revision === 152, inspectGood.out.trim().slice(0, 200));

  const reject = (label, file, expect) => {
    const r = updater('inspect', '--package', file);
    const msg = (() => { try { return JSON.parse(r.err.trim().split(/\r?\n/).pop()).error; } catch { return r.err.slice(0, 200); } })();
    check(`A ${label} is refused`, r.status === 2 && expect.test(msg), msg);
  };
  reject('tampered payload (corrupt)', repack(good.outFile, 'tampered', (d) => {
    const f = path.join(d, 'payload', 'runtime', 'core.js');
    fs.appendFileSync(f, '\n// injected');
  }), /corrupt|hash/i);
  reject('unlisted extra file', repack(good.outFile, 'extra', (d) => fs.writeFileSync(path.join(d, 'payload', 'runtime', 'evil.js'), 'x')), /does not list/i);
  reject('forged manifest (revision edited)', repack(good.outFile, 'forged', (d) => {
    const mf = path.join(d, 'manifest.json');
    fs.writeFileSync(mf, fs.readFileSync(mf, 'utf8').replace('"revision": 152', '"revision": 999'));
  }), /signature/i);
  const stranger = generateKeypair();
  reject('package signed by an untrusted key', makePackage('untrusted', { revision: 152, min: 151, max: 151, privateKeyPem: stranger.privateKeyPem, coreTransform: (s) => s }).outFile, /trust/i);
  reject('outdated package (not newer than installed)', makePackage('outdated', { revision: 151, min: 150, max: 150, privateKeyPem, coreTransform: (s) => s }).outFile, /not newer/i);
  reject('package for a different version', makePackage('otherversion', { revision: 152, min: 151, max: 151, privateKeyPem, baseVersion: '9.9.9', coreTransform: (s) => s }).outFile, /9\.9\.9/);
  reject('package for other installed builds', makePackage('otherbase', { revision: 152, min: 140, max: 149, privateKeyPem, coreTransform: (s) => s }).outFile, /applies to builds/i);
  reject('database newer than the package understands', makePackage('dbdowngrade', { revision: 152, min: 151, max: 151, privateKeyPem, dbTarget: 5, coreTransform: (s) => s }).outFile, /downgrade/i);
  reject('path-traversal entry', (() => {
    const out = path.join(pkgDir, 'traversal.pdupdate');
    fs.writeFileSync(out, storedZip('payload/../../escape.txt', 'x'));
    return out;
  })(), /unexpected entry|not a readable/i);
  check('A installed files untouched by every rejected package', coreHash() === original.core, coreHash().slice(0, 12));

  // ---- B. Core update gate ----------------------------------------------------------------------------------------
  const ready0 = await core('/v1/core/update-readiness');
  const gateOn = await core('/v1/core/update-gate', 'POST', { quiesce: true });
  const gateOff = await core('/v1/core/update-gate', 'POST', { quiesce: false });
  check('B Core update gate toggles', ready0.body.quiescing === false && gateOn.body.quiescing === true && gateOff.body.quiescing === false, { gateOn: gateOn.body, gateOff: gateOff.body });
  const gateJs = esbuild.transformSync(fs.readFileSync(path.join(repoRoot, 'core', 'runtime', 'updateGate.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code;
  const gate = await import(`data:text/javascript;base64,${Buffer.from(gateJs).toString('base64')}`);
  const endWrite = gate.beginWrite();
  setTimeout(endWrite, 400);
  const t0 = Date.now();
  const drained = await gate.drainWrites(3000);
  const waited = Date.now() - t0;
  const endWrite2 = gate.beginWrite();
  const notDrained = await gate.drainWrites(150);
  endWrite2();
  check('B a started write is awaited, never abandoned early', drained === true && waited >= 350 && notDrained === false && gate.gmailWritesInFlight() === 0, { waited, drained, notDrained });

  // ---- C. good update from the running app ------------------------------------------------------------------------
  const uiBefore = await evaluate('window.karkedikhaDesktop.getUpdateStatus()');
  check('C Update control reports installed b151 and the updater available', uiBefore.available === true && uiBefore.installedRevision === 151, uiBefore);
  const c = await applyViaUi(good.outFile);
  check('C UI handed over to the updater', c.ui.status === 'applying', c.ui);
  check('C updater reports success', c.result.status === 'success', c.result);
  check('C installed revision is now b152', installedIdentity().buildNumber === 152 && c.result.revision === 152, installedIdentity().buildNumber);
  check('C Core and UI files replaced', coreHash() === good.coreSha && coreHash() !== original.core
    && sha256File(path.join(installDir, 'app', 'renderer', 'v2', 'app.js')) !== original.renderer);
  const fp = readJson(path.join(installDir, 'build-fingerprint.json'));
  check('C fingerprint regenerated from installed files', fp?.files?.coreBundle?.sha256?.toLowerCase() === coreHash(), fp?.updatedBy);
  // The app the updater relaunched reports on itself: its own window+Core health marker names the build it is.
  const health = readJson(path.join(updatesDir, 'ui-health.json'));
  check('C relaunched app reports b152 with window loaded and Core connected', health?.buildNumber === 152 && health.rendererLoaded && health.coreConnected && alive(health.pid), health);
  // The old process can keep the debug port bound for a while; restart on a fresh port to drive the UI again.
  stopSmokeProcesses(scratch);
  await sleep(2000);
  cdpPort = String(Number(cdpPort) + 100);
  env.KARKEDIKHA_DESKTOP_CDP_PORT = cdpPort;
  launchApp();
  await appConnected();
  const meta = await evaluate('window.karkedikhaDesktop.getAppMetadata()');
  const status = await evaluate('window.karkedikhaDesktop.getUpdateStatus()');
  check('C running app reports b152', meta.buildNumber === 152 && status.installedRevision === 152 && status.lastResult?.status === 'success', { build: meta.buildNumber, last: status.lastResult?.status });
  const info = await core('/v1/core/info');
  check('C running Core is the new bundle', info.body.bundleHash === coreHash(), info.body.bundleHash?.slice(0, 12));
  const dataC = await stateOfData();
  check('C user data preserved', JSON.stringify(dataC.seeded) === JSON.stringify(dataBefore.seeded) && dataC.conversationPresent, dataC);
  const backups = fs.readdirSync(path.join(updatesDir, 'backups'));
  const backedCore = path.join(updatesDir, 'backups', backups[backups.length - 1], 'files', 'runtime', 'core.js');
  check('C replaced files were backed up first', fs.existsSync(backedCore) && sha256File(backedCore) === original.core, backups);
  reject('re-applying the same update (now outdated)', good.outFile, /not newer/i);

  // ---- D. broken update -> automatic rollback ---------------------------------------------------------------------
  const dbTarget = latestMigrationVersion() + 1;
  const bad = makePackage('b153-broken', {
    revision: 153, min: 152, max: 152, privateKeyPem, dbTarget,
    coreTransform: () => [
      "const fs = require('node:fs'), path = require('node:path');",
      "const dir = process.env.KARKEDIKHA_DATA_DIR || '';",
      "try { fs.writeFileSync(path.join(dir, 'core.db'), 'CORRUPTED BY A FAILED MIGRATION'); fs.writeFileSync(path.join(dir, 'updates', 'bad-core-ran.txt'), 'ran'); } catch {}",
      'process.exit(3);',
    ].join('\n'),
  });
  const inspectBad = updater('inspect', '--package', bad.outFile);
  check('D the broken package is validly signed and declares a DB migration', inspectBad.status === 0 && JSON.parse(inspectBad.out).migrates === true, inspectBad.out.trim().slice(0, 200));
  const coreBeforeD = coreHash();
  const d = await applyViaUi(bad.outFile);
  check('D updater rolled back', d.result.status === 'rolled_back' && d.result.dbRestored === true, d.result);
  check('D the new (broken) Core really ran and corrupted the database', fs.existsSync(path.join(updatesDir, 'bad-core-ran.txt')), 'marker present');
  check('D installed files restored to b152 exactly', installedIdentity().buildNumber === 152 && coreHash() === coreBeforeD, installedIdentity().buildNumber);
  const healthD = await waitFor('restored app health', () => {
    const h = readJson(path.join(updatesDir, 'ui-health.json'));
    return h && h.buildNumber === 152 && alive(h.pid) && h.coreConnected && Date.parse(h.at) > Date.parse(d.result.at) - 5000 ? h : null;
  }, 120_000);
  check('D restored b152 app is running with window and Core connected', Boolean(healthD), healthD);
  stopSmokeProcesses(scratch);
  await sleep(2000);
  cdpPort = String(Number(cdpPort) + 100);
  env.KARKEDIKHA_DESKTOP_CDP_PORT = cdpPort;
  launchApp();
  await appConnected();
  const infoD = await core('/v1/core/info');
  check('D previous version is running again with its own Core', infoD.body.bundleHash === coreBeforeD, infoD.body.bundleHash?.slice(0, 12));
  const statusD = await evaluate('window.karkedikhaDesktop.getUpdateStatus()');
  check('D app tells the user the update was undone', statusD.lastResult?.status === 'rolled_back' && statusD.installedRevision === 152, statusD.lastResult);
  const dataD = await stateOfData();
  check('D database restored from backup, user data preserved', JSON.stringify(dataD.seeded) === JSON.stringify(dataBefore.seeded) && dataD.conversationPresent, dataD);

  const ownerAfter = ownerFingerprint();
  check('owner production installation untouched', ownerAfter === ownerBefore, ownerAfter === ownerBefore ? 'identical' : 'CHANGED');
}

let failure = null;
try { await main(); } catch (err) { failure = err; check('harness', false, err instanceof Error ? err.message : String(err)); }
try { ws?.close(); } catch { /* ignore */ }
if (process.env.PANDESH_UPDATE_TEST_KEEP === '1') { console.log(`KEPT ${scratch}`); process.exit(1); }
try {
  uninstallSmoke(scratch, { ...process.env, LOCALAPPDATA: isolatedLocal, APPDATA: path.join(scratch, 'appdata') });
  check('scratch install removed', !fs.existsSync(scratch), scratch);
} catch (err) {
  try { stopSmokeProcesses(scratch); } catch { /* best effort */ }
  check('cleanup', false, err.message);
}
fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
fs.writeFileSync(evidenceFile, `${JSON.stringify({ at: new Date().toISOString(), setupPath, checks }, null, 2)}\n`);
const failed = checks.filter((c) => c.status === 'FAIL').length;
console.log(`\n[update-test] passed=${checks.length - failed} failed=${failed} evidence=${evidenceFile}`);
process.exit(failure || failed ? 1 : 0);
