/**
 * Builds Pandesh-Setup.exe from the existing portable tree.
 * Pins Inno Setup 6.7.3 (see installer/installer-pin.json).
 *
 *   npm run desktop:installer
 *
 * Preserves dist/pandesh-win32-x64 as a separate portable artifact.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitSourceState, verifyReleaseManifest } from './lib/release-manifest.mjs';
import { readAppVersion, readBuildIdentity, verifyBuildIdentity } from './lib/build-identity.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const pinPath = path.join(desktopRoot, 'installer', 'installer-pin.json');
const issPath = path.join(desktopRoot, 'installer', 'pandesh-desktop.iss');
const toolsRoot = path.join(desktopRoot, '.tools');
const portableRoot = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const stagingRoot = process.env.KARKEDIKHA_DESKTOP_INSTALLER_STAGING
  ?? path.join(repoRoot, 'dist', 'pandesh-installer-staging');
const outputDir = process.env.KARKEDIKHA_DESKTOP_INSTALLER_OUT
  ?? path.join(repoRoot, 'dist');

/**
 * The ONE authoritative application version: `apps/desktop/package.json`.
 * The installer, the packaged app, the footer and the About panel all read
 * it, so there is no second hand-maintained version string to drift.
 */
function authoritativeAppVersion() {
  return readAppVersion(repoRoot);
}

function readPin() {
  return JSON.parse(fs.readFileSync(pinPath, 'utf8'));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toUpperCase();
}

/**
 * Node 24 on Windows refuses to spawn a .cmd/.bat file without a shell (CVE-2024-27980 hardening): the call returns
 * `status: null` with an EINVAL error instead of running npm. A batch file is therefore run through the shell, with
 * every argument quoted; anything else is still spawned directly.
 */
export function run(command, args, cwd = repoRoot) {
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const result = isBatch
    ? spawnSync([/\s/.test(command) ? `"${command}"` : command, ...args.map((part) => `"${String(part).replace(/"/g, '\\"')}"`)].join(' '), {
      cwd, stdio: 'inherit', windowsHide: true, env: process.env, shell: true,
    })
    : spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true, env: process.env, shell: false });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'karkedikha-desktop-installer' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`download failed HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      try { file.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      reject(err);
    });
  });
}

function copyRecursive(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.copyFileSync(src, dest);
}

async function ensureInnoSetup(pin) {
  const extractDir = path.join(toolsRoot, `innosetup-${pin.version}`);
  const iscc = path.join(extractDir, 'ISCC.exe');
  if (fs.existsSync(iscc)) return iscc;

  fs.mkdirSync(toolsRoot, { recursive: true });
  const installerPath = path.join(toolsRoot, `innosetup-${pin.version}.exe`);
  if (!fs.existsSync(installerPath)) {
    console.log(`Downloading Inno Setup ${pin.version}…`);
    await downloadFile(pin.installerUrl, installerPath);
  }
  const actual = sha256File(installerPath);
  if (actual !== pin.installerSha256.toUpperCase()) {
    throw new Error(`Inno Setup SHA-256 mismatch: expected ${pin.installerSha256}, got ${actual}`);
  }

  console.log(`Extracting Inno Setup ${pin.version} to ${extractDir}…`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const extract = spawnSync(installerPath, [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/CURRENTUSER',
    `/DIR=${extractDir}`,
  ], { stdio: 'inherit', windowsHide: true });
  if (extract.status !== 0 || !fs.existsSync(iscc)) {
    throw new Error(`Failed to extract Inno Setup ISCC.exe into ${extractDir}`);
  }
  return iscc;
}

/**
 * The portable tree is rebuilt on every installer build, because package-portable.mjs rebuilds the Core and Desktop
 * bundles. Reuse is opt-in (KARKEDIKHA_DESKTOP_REUSE_PORTABLE=1) and only accepted when the tree's own manifest
 * verifies against its files AND records a clean build of the current HEAD. The manifest returned is always the one
 * written by the portable build from the packaged binaries.
 */
function ensurePortable() {
  if (process.env.KARKEDIKHA_DESKTOP_REUSE_PORTABLE === '1') {
    try {
      const manifest = verifyReleaseManifest(portableRoot);
      const source = gitSourceState(repoRoot);
      if (manifest.commit === source.commit && manifest.sourceState === 'clean' && source.sourceState === 'clean') {
        console.log(`Reusing verified portable build of ${manifest.commit}.`);
        return manifest;
      }
      console.log('Portable build is not a clean build of the current HEAD — rebuilding.');
    } catch (err) {
      console.log(`Portable build cannot be reused (${err.message}) — rebuilding.`);
    }
  }
  console.log('Building portable package via package-portable.mjs…');
  run(process.execPath, [path.join(desktopRoot, 'scripts', 'package-portable.mjs')]);
  return verifyReleaseManifest(portableRoot);
}

function stageInstallerPayload(pin, releaseManifest) {
  console.log(`Staging installer payload at ${stagingRoot}`);
  const appVersion = authoritativeAppVersion();
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagingRoot), { recursive: true });
  copyRecursive(portableRoot, stagingRoot);
  // What gets compiled into the installer must still be exactly what the manifest describes.
  verifyReleaseManifest(stagingRoot, releaseManifest);
  // The build identity embedded in the payload must agree with the committed
  // sources, or the installer would ship a build that names a different
  // version than the repository declares.
  const identity = verifyBuildIdentity(stagingRoot, repoRoot);
  if (identity.version !== appVersion) {
    throw new Error(`build identity version ${identity.version} does not match the application version ${appVersion}`);
  }

  // Electron requires its DLLs/resources beside the executable. Copy next to
  // electron.exe (not install root) so shortcuts can launch Pandesh.exe directly.
  const electronExe = path.join(stagingRoot, 'electron', 'electron.exe');
  if (!fs.existsSync(electronExe)) throw new Error(`missing ${electronExe}`);
  const pandeshExe = path.join(stagingRoot, 'electron', 'Pandesh.exe');
  fs.copyFileSync(electronExe, pandeshExe);

  // Host logs for installed launches go under LocalAppData (main.ts defaults).
  // Keep Launch-Pandesh.cmd for operators who still want the portable entrypoint inside the install tree.
  fs.writeFileSync(path.join(stagingRoot, 'INSTALL.txt'), [
    'Pandesh (installed Windows build)',
    '',
    'Launch from the Desktop or Start Menu shortcut named "Pandesh".',
    'No Cursor, VS Code, npm, Node, or .cmd file is required.',
    '',
    'Requires a running local Ollama instance with at least one installed model.',
    'OpenRouter cloud submission is not ready; Ollama/local-only is the default.',
    '',
    `User data: %LOCALAPPDATA%\\${pin.dataDirRelative.replace(/\\\\/g, '\\')}`,
    'Uninstall via Windows Settings → Apps (user data is preserved).',
    '',
    `Built: ${new Date().toISOString()}`,
    `Host: ${os.hostname()}`,
    `Inno Setup: ${pin.version}`,
    '',
  ].join('\r\n'));

  fs.writeFileSync(path.join(stagingRoot, 'installer-payload-manifest.json'), `${JSON.stringify({
    name: 'pandesh-installer-payload',
    productVersion: appVersion,
    electron: pin.electronVersion,
    builtAt: new Date().toISOString(),
    includes: {
      electronRuntime: true,
      coreBundle: true,
      whisperModel: true,
      whisperRuntimeAssets: true,
      portableLauncherCmd: true,
      pandeshExe: true,
    },
    excludes: {
      secrets: true,
      localAppData: true,
      tipCalculatorDrivers: true,
    },
  }, null, 2)}\n`);
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('desktop:installer currently supports Windows only');
  }
  const pin = readPin();
  const appVersion = authoritativeAppVersion();
  const releaseManifest = ensurePortable();
  stageInstallerPayload(pin, releaseManifest);
  const iscc = await ensureInnoSetup(pin);

  fs.mkdirSync(outputDir, { recursive: true });
  const setupPath = path.join(outputDir, pin.setupFileName);
  if (fs.existsSync(setupPath)) fs.unlinkSync(setupPath);

  console.log(`Compiling ${pin.setupFileName}…`);
  const iconFile = path.join(desktopRoot, 'assets', 'icon.ico');
  if (!fs.existsSync(iconFile)) throw new Error(`missing ${iconFile} — run: node scripts/build-icons.mjs`);
  run(iscc, [
    `/DSourceDir=${stagingRoot}`,
    `/DOutputDir=${outputDir}`,
    `/DMyAppVersion=${appVersion}`,
    `/DIconFile=${iconFile}`,
    issPath,
  ]);

  if (!fs.existsSync(setupPath)) {
    throw new Error(`Setup executable missing after compile: ${setupPath}`);
  }
  const digest = sha256File(setupPath);
  const sidecar = `${setupPath}.sha256`;
  fs.writeFileSync(sidecar, `${digest}  ${pin.setupFileName}\n`);
  // The installer, its sidecar and its manifest must agree before anything is reported.
  if (sha256File(setupPath) !== digest) throw new Error(`${setupPath} changed while the release manifest was being written`);
  fs.writeFileSync(path.join(outputDir, 'pandesh-installer-manifest.json'), `${JSON.stringify({
    setupFile: setupPath,
    setupFileName: pin.setupFileName,
    sha256: digest,
    bytes: fs.statSync(setupPath).size,
    productName: pin.productName,
    productVersion: appVersion,
    appId: pin.appId,
    appIdGuid: pin.appIdGuid,
    innoSetupVersion: pin.version,
    portableRoot,
    stagingRoot,
    sourceCommit: releaseManifest.commit,
    sourceState: releaseManifest.sourceState,
    dirtyFiles: releaseManifest.dirtyFiles,
    sourceDiffSha256: releaseManifest.diffSha256,
    bundleHashes: releaseManifest.files,
    buildIdentity: readBuildIdentity(stagingRoot),
    builtAt: new Date().toISOString(),
    privilegesRequired: pin.privilegesRequired,
  }, null, 2)}\n`);

  console.log(`Installer ready: ${setupPath}`);
  console.log(`SHA-256: ${digest}`);

  const smokeIssPath = path.join(desktopRoot, 'installer', 'pandesh-smoke.iss');
  const smokeSetupPath = path.join(outputDir, 'Pandesh-Smoke-Setup.exe');
  if (fs.existsSync(smokeIssPath)) {
    console.log('Compiling Pandesh-Smoke-Setup.exe…');
    if (fs.existsSync(smokeSetupPath)) fs.unlinkSync(smokeSetupPath);
    run(iscc, [
      `/DSourceDir=${stagingRoot}`,
      `/DOutputDir=${outputDir}`,
      `/DMyAppVersion=${appVersion}`,
      `/DIconFile=${iconFile}`,
      smokeIssPath,
    ]);
    if (fs.existsSync(smokeSetupPath)) {
      const smokeDigest = sha256File(smokeSetupPath);
      fs.writeFileSync(`${smokeSetupPath}.sha256`, `${smokeDigest}  Pandesh-Smoke-Setup.exe\n`);
      console.log(`Smoke installer ready: ${smokeSetupPath}`);
      console.log(`Smoke SHA-256: ${smokeDigest}`);
    }
  }

  console.log(`Portable preserved at: ${portableRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
