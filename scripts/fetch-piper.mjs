/**
 * Fetch Piper Windows binary + one en_US ONNX voice into runtime/piper/.
 * Intentional Jarvis voice dependency; packaged into portable/installer.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const piperRoot = path.join(repoRoot, 'runtime', 'piper');
const voicesDir = path.join(piperRoot, 'voices');

/** Pinned Piper Windows release (URL); SHA recorded beside the extract after download. */
const PIPER_ZIP_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const VOICE_ONNX_URL =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx';
const VOICE_JSON_URL =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json';

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toUpperCase();
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'karkedikha-piper-fetch' } }, (res) => {
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

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function alreadyStaged() {
  const exe = path.join(piperRoot, 'piper.exe');
  const onnx = path.join(voicesDir, 'en_US-lessac-medium.onnx');
  const espeak = path.join(piperRoot, 'espeak-ng-data', 'phontab');
  return fs.existsSync(exe) && fs.existsSync(onnx) && fs.existsSync(espeak)
    && fs.statSync(path.join(voicesDir, 'en_US-lessac-medium.onnx.json')).size > 100;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[fetch-piper] Windows-only staging; skipping on this platform.');
    return;
  }
  if (alreadyStaged()) {
    console.log(`[fetch-piper] already staged at ${piperRoot}`);
    return;
  }

  fs.mkdirSync(voicesDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'piper-fetch-'));
  const zipPath = path.join(tmp, 'piper_windows_amd64.zip');
  console.log('[fetch-piper] downloading Piper Windows zip…');
  await download(PIPER_ZIP_URL, zipPath);
  const digest = sha256File(zipPath);
  fs.writeFileSync(path.join(piperRoot, 'piper-zip.sha256'), `${digest}  piper_windows_amd64.zip\n`);
  console.log(`[fetch-piper] zip SHA-256 ${digest}`);

  // Expand with PowerShell Expand-Archive
  const extractDir = path.join(tmp, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  const expand = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
  ], { stdio: 'inherit', windowsHide: true });
  if (expand.status !== 0) throw new Error('Failed to extract Piper zip');

  function findPiperExe(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'piper.exe') return full;
      if (entry.isDirectory()) {
        const nested = findPiperExe(full);
        if (nested) return nested;
      }
    }
    return null;
  }
  const exeSrc = findPiperExe(extractDir);
  if (!exeSrc) throw new Error('piper.exe not found in zip');
  const exeDir = path.dirname(exeSrc);
  // Copy the full Piper payload (exe, DLLs, and espeak-ng-data/).
  for (const name of fs.readdirSync(exeDir)) {
    const src = path.join(exeDir, name);
    const dest = path.join(piperRoot, name);
    if (fs.statSync(src).isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  console.log('[fetch-piper] downloading en_US-lessac-medium voice…');
  await download(VOICE_ONNX_URL, path.join(voicesDir, 'en_US-lessac-medium.onnx'));
  await download(VOICE_JSON_URL, path.join(voicesDir, 'en_US-lessac-medium.onnx.json'));

  if (!alreadyStaged()) throw new Error('Piper staging incomplete');
  console.log(`[fetch-piper] ready at ${piperRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
