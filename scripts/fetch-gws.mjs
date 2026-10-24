/**
 * Stage the pinned Google Workspace CLI (`gws`) Windows x64 binary into
 * runtime/gws/ for the portable/installer build. Unlike fetch-piper.mjs,
 * digest verification here is strict and fails closed — this binary is a
 * governed connector transport (core/runtime/connectors/gwsTransport.ts),
 * not a nice-to-have voice asset. See AI_OS_ARCHITECTURE.md "Google
 * Workspace CLI (`gws`) as connector transport" for the pinned identity and
 * the three-way SHA-256 verification this checkpoint already performed.
 *
 * This script runs only at build/package time (an operator or CI running
 * `node scripts/fetch-gws.mjs` before packaging) — the packaged app itself
 * never downloads or self-updates gws at runtime; gwsTransport.ts only ever
 * reads a pre-staged path from KARKEDIKHA_GWS_BIN.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gwsRoot = path.join(repoRoot, 'runtime', 'gws');

const GWS_VERSION = '0.22.5';
const GWS_ASSET_NAME = 'google-workspace-cli-x86_64-pc-windows-msvc.zip';
const GWS_ZIP_URL = `https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/${GWS_ASSET_NAME}`;
// GitHub release-asset digest, independently verified during the feasibility
// checkpoint. Check this before extracting anything from the archive.
const GWS_PINNED_ZIP_SHA256 = '407705d695dc83d48b1c5f50d71b5aa64095bf6f17d5b439b2e9a373bbe67ec2';
// Must match GWS_PINNED_SHA256_WINDOWS_X64 in
// core/runtime/connectors/gwsTransport.ts. This is the digest of the actual
// executable Core launches, not the containing ZIP.
const GWS_PINNED_EXE_SHA256 = '82ad48dd28564be969174aaef3e3f99816f959bf2519eeeb4ab77d84f9fa9c67';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toLowerCase();
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'karkedikha-gws-fetch' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        const next = new URL(res.headers.location, url).href;
        download(next, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
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

function findGwsExe(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'gws.exe') return full;
    if (entry.isDirectory()) {
      const nested = findGwsExe(full);
      if (nested) return nested;
    }
  }
  return null;
}

function alreadyStaged() {
  const exe = path.join(gwsRoot, 'gws.exe');
  if (!fs.existsSync(exe)) return false;
  return sha256File(exe) === GWS_PINNED_EXE_SHA256;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[fetch-gws] Windows-only staging; skipping on this platform.');
    return;
  }
  if (alreadyStaged()) {
    console.log(`[fetch-gws] already staged and digest-verified at ${gwsRoot}`);
    return;
  }

  fs.mkdirSync(gwsRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-fetch-'));
  const zipPath = path.join(tmp, GWS_ASSET_NAME);
  console.log(`[fetch-gws] downloading gws v${GWS_VERSION}…`);
  await download(GWS_ZIP_URL, zipPath);

  const zipDigest = sha256File(zipPath);
  console.log(`[fetch-gws] downloaded zip SHA-256 ${zipDigest}`);
  if (zipDigest !== GWS_PINNED_ZIP_SHA256) {
    fs.unlinkSync(zipPath);
    throw new Error(
      `gws release ZIP digest mismatch: expected ${GWS_PINNED_ZIP_SHA256}, got ${zipDigest}. `
      + 'Refusing to extract an unverified release asset.',
    );
  }

  const extractDir = path.join(tmp, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  const expand = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
  ], { stdio: 'inherit', windowsHide: true });
  if (expand.status !== 0) throw new Error('Failed to extract gws zip');

  const exeSrc = findGwsExe(extractDir);
  if (!exeSrc) throw new Error('gws.exe not found in the downloaded archive — refusing to stage an unverifiable payload');

  // Also stage the Apache 2.0 LICENSE from the release archive, if present,
  // for packaging's third-party notice requirement.
  const licenseSrc = fs.readdirSync(extractDir, { withFileTypes: true })
    .find((e) => e.isFile() && /^licen[sc]e/i.test(e.name));

  const exeDest = path.join(gwsRoot, 'gws.exe');
  fs.copyFileSync(exeSrc, exeDest);
  if (licenseSrc) fs.copyFileSync(path.join(extractDir, licenseSrc.name), path.join(gwsRoot, 'LICENSE'));

  const stagedDigest = sha256File(exeDest);
  if (stagedDigest !== GWS_PINNED_EXE_SHA256) {
    fs.unlinkSync(exeDest);
    throw new Error(
      `gws.exe digest mismatch: expected ${GWS_PINNED_EXE_SHA256}, got ${stagedDigest}. `
      + 'Refusing to stage an unverified binary — this must match AI_OS_ARCHITECTURE.md\'s pinned identity exactly.',
    );
  }

  fs.writeFileSync(path.join(gwsRoot, 'gws.exe.sha256'), `${stagedDigest}  gws.exe\n`);
  console.log(`[fetch-gws] staged and verified gws.exe at ${exeDest} (sha256 ${stagedDigest})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
