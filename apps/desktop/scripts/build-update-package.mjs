/**
 * Builds a signed Pandesh update package (`*.pdupdate`) from the current sources.
 *
 *   node scripts/build-update-package.mjs keygen
 *       One time: creates the signing key outside the repository (%LOCALAPPDATA%\KarkeDikha\update-signing) and
 *       writes its PUBLIC half to updater/update-trust.json, which the installer ships.
 *   node scripts/build-update-package.mjs build --installed-min <build> [--installed-max <build>] [--out <file>]
 *                                                [--components core,ui] [--no-rebuild] [--notes "text"]
 *       Rebuilds the Core and Desktop bundles, then packages them. The build number in build-number.json is the
 *       update's revision and must be higher than the builds it applies to.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitSourceState } from './lib/release-manifest.mjs';
import { composeBuildIdentity, readAppVersion } from './lib/build-identity.mjs';
import { COMPONENTS, PACKAGE_EXTENSION, UPDATER_PROTOCOL, UPDATE_SCHEMA, isManagedPath, sha256File } from '../updater/update-lib.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const trustFile = path.join(desktopRoot, 'updater', 'update-trust.json');
const keyDir = process.env.PANDESH_UPDATE_KEY_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'KarkeDikha', 'update-signing');
const keyFile = path.join(keyDir, 'signing-key.pem');

function walkFiles(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walkFiles(root, child) : [child];
  });
}

export function keyIdOf(publicKeyPem) {
  return crypto.createHash('sha256').update(crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Highest Core migration this source tree declares: what the package's Core will bring the database to. */
export function latestMigrationVersion() {
  const text = fs.readFileSync(path.join(repoRoot, 'core', 'db', 'migrations.ts'), 'utf8');
  const versions = [...text.matchAll(/^\s*\{ version: (\d+), description:/gm)].map((m) => Number(m[1]));
  if (!versions.length) throw new Error('could not read the Core migration list');
  return Math.max(...versions);
}

/**
 * Pure assembly step: takes the already-built component sources and produces the signed package.
 * `sources`: { coreJs, uiOutDir, uiRendererDir, appPackageJson (string), buildIdentity (object) }.
 */
export function buildUpdatePackage({ sources, components, meta, compat, privateKeyPem, outFile, notes = null }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-update-'));
  try {
    const payload = path.join(stage, 'payload');
    const put = (rel, from) => {
      const dst = path.join(payload, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(from, dst);
    };
    const putText = (rel, text) => {
      const dst = path.join(payload, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, text);
    };
    if (components.includes('core')) put('runtime/core.js', sources.coreJs);
    if (components.includes('ui')) {
      for (const f of walkFiles(sources.uiOutDir)) put(`app/out/${f}`, path.join(sources.uiOutDir, f));
      for (const f of walkFiles(sources.uiRendererDir)) put(`app/renderer/${f}`, path.join(sources.uiRendererDir, f));
      putText('app/package.json', sources.appPackageJson);
    }
    putText('build-identity.json', `${JSON.stringify(sources.buildIdentity, null, 2)}\n`);

    const files = walkFiles(payload).sort().map((rel) => {
      if (!isManagedPath(rel, components)) throw new Error(`refusing to package unmanaged path ${rel}`);
      const full = path.join(payload, ...rel.split('/'));
      return { path: rel, size: fs.statSync(full).size, sha256: sha256File(full) };
    });
    const keyPem = crypto.createPrivateKey(privateKeyPem);
    const publicPem = crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'pem' }).toString();
    const manifest = {
      schema: UPDATE_SCHEMA,
      product: 'pandesh',
      platform: 'win32-x64',
      requiresUpdater: UPDATER_PROTOCOL,
      signingKeyId: keyIdOf(publicPem),
      revision: meta.revision,
      version: meta.version,
      commit: meta.commit,
      sourceState: meta.sourceState,
      builtAt: meta.builtAt,
      components,
      compat,
      notes,
      files,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(stage, 'manifest.json'), manifestBytes);
    fs.writeFileSync(path.join(stage, 'manifest.sig'), crypto.sign(null, manifestBytes, keyPem).toString('base64'));

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.rmSync(outFile, { force: true });
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const zip = spawnSync(tar, ['--format', 'zip', '-cf', outFile, '-C', stage, 'manifest.json', 'manifest.sig', 'payload'], { windowsHide: true, encoding: 'utf8' });
    if (zip.status !== 0) throw new Error(`could not write ${outFile}: ${zip.stderr}`);
    return { manifest, outFile, bytes: fs.statSync(outFile).size, sha256: sha256File(outFile) };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function option(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function run(command, args) {
  const r = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`${path.basename(args[0] ?? command)} failed with status ${r.status}`);
}

function keygen() {
  if (fs.existsSync(keyFile)) throw new Error(`a signing key already exists at ${keyFile}; refusing to replace it`);
  const { publicKeyPem, privateKeyPem } = generateKeypair();
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(keyFile, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(trustFile, `${JSON.stringify({ keys: [{ id: keyIdOf(publicKeyPem), publicKeyPem }] }, null, 2)}\n`);
  console.log(`Private signing key: ${keyFile}  (keep it; never commit it)`);
  console.log(`Public trust file:   ${trustFile}  (ships with the installer)`);
}

function build(argv) {
  const installedMin = Number(option(argv, 'installed-min'));
  if (!Number.isInteger(installedMin)) throw new Error('--installed-min <build> is required');
  const components = (option(argv, 'components') ?? 'core,ui').split(',');
  if (components.some((c) => !Object.hasOwn(COMPONENTS, c))) throw new Error('--components must be core, ui or core,ui');
  if (!fs.existsSync(keyFile)) throw new Error(`no signing key at ${keyFile}; run: node scripts/build-update-package.mjs keygen`);
  if (!argv.includes('--no-rebuild')) {
    run(process.execPath, [path.join(repoRoot, 'esbuild.core.js'), '--production']);
    run(process.execPath, [path.join(desktopRoot, 'esbuild.mjs')]);
  }
  const source = gitSourceState(repoRoot);
  const builtAt = new Date().toISOString();
  const identity = composeBuildIdentity(repoRoot, { commit: source.commit, builtAt, sourceState: source.sourceState });
  const revision = identity.buildNumber;
  const installedMax = Number(option(argv, 'installed-max') ?? revision - 1);
  if (!(installedMin <= installedMax && installedMax < revision)) throw new Error(`installed builds b${installedMin}–b${installedMax} must be lower than this update's build b${revision}`);
  const electron = fs.readFileSync(path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'version'), 'utf8').trim().replace(/^v/, '');
  const version = readAppVersion(repoRoot);
  const outFile = path.resolve(option(argv, 'out') ?? path.join(repoRoot, 'dist', 'updates', `Pandesh-Update-v${version}-b${revision}${PACKAGE_EXTENSION}`));
  const result = buildUpdatePackage({
    sources: {
      coreJs: path.join(repoRoot, 'out-core', 'core.js'),
      uiOutDir: path.join(desktopRoot, 'out'),
      uiRendererDir: path.join(desktopRoot, 'renderer'),
      appPackageJson: `${JSON.stringify({ name: 'pandesh', version, private: true, main: 'out/main.js', productName: 'Pandesh' }, null, 2)}\n`,
      buildIdentity: identity,
    },
    components,
    meta: { revision, version, commit: source.commit, sourceState: source.sourceState, builtAt },
    compat: { baseVersion: version, installedBuildMin: installedMin, installedBuildMax: installedMax, electron, dbSchemaTarget: latestMigrationVersion() },
    privateKeyPem: fs.readFileSync(keyFile, 'utf8'),
    outFile,
    notes: option(argv, 'notes') ?? null,
  });
  console.log(`Update package: ${result.outFile}`);
  console.log(`  revision b${revision} (v${version}), applies to b${installedMin}–b${installedMax}, db schema ${result.manifest.compat.dbSchemaTarget}`);
  console.log(`  ${result.manifest.files.length} files, ${(result.bytes / 1048576).toFixed(2)} MB, SHA-256 ${result.sha256.toUpperCase()}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'keygen') keygen();
    else if (cmd === 'build') build(rest);
    else throw new Error('usage: build-update-package.mjs keygen | build --installed-min <build> [...]');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
