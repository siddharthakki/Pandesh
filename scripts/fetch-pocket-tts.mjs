/**
 * Stage Kyutai Pocket TTS into runtime/pocket-tts/ (optional local speech engine).
 *
 * The standalone pocket-tts.exe has no public pinned download URL, so it is copied from a
 * local directory (--exe-dir <dir> or POCKET_TTS_EXE_DIR) and verified against the pin in
 * scripts/pocket-tts/manifest.json. Model, tokenizer and voice are downloaded from pinned
 * Hugging Face revisions and sha256-verified. Once staged, Pandesh runs fully offline.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoRoot, 'scripts', 'pocket-tts');
const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
const stageRoot = path.join(repoRoot, 'runtime', 'pocket-tts');
const assetsDir = path.join(stageRoot, manifest.language);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verified(file, sha256) {
  return fs.existsSync(file) && sha256File(file) === sha256;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[fetch-pocket-tts] Windows-only staging; skipping on this platform.');
    return;
  }
  fs.mkdirSync(assetsDir, { recursive: true });

  const exeDirArg = process.argv.indexOf('--exe-dir');
  const exeDir = (exeDirArg > 0 ? process.argv[exeDirArg + 1] : process.env.POCKET_TTS_EXE_DIR) ?? '';
  const exeDest = path.join(stageRoot, manifest.engine.file);
  const licenseDest = path.join(stageRoot, manifest.engine.licenseFile);
  if (!verified(exeDest, manifest.engine.sha256)) {
    const exeSrc = path.join(exeDir, manifest.engine.file);
    if (!exeDir || !fs.existsSync(exeSrc)) {
      throw new Error(
        `pocket-tts.exe ${manifest.engine.version} is not staged. Pass --exe-dir <folder with pocket-tts.exe> or set POCKET_TTS_EXE_DIR.`,
      );
    }
    if (sha256File(exeSrc) !== manifest.engine.sha256) {
      throw new Error(`${exeSrc} does not match pinned pocket-tts ${manifest.engine.version} sha256.`);
    }
    fs.copyFileSync(exeSrc, exeDest);
    fs.copyFileSync(path.join(exeDir, manifest.engine.licenseFile), licenseDest);
  }
  if (!verified(licenseDest, manifest.engine.licenseSha256)) {
    throw new Error(`${licenseDest} is missing or does not match the pinned license.`);
  }

  for (const asset of manifest.assets) {
    const dest = path.join(assetsDir, asset.path);
    if (verified(dest, asset.sha256)) continue;
    console.log(`[fetch-pocket-tts] downloading ${asset.path} (${(asset.size / 1e6).toFixed(1)} MB)`);
    await download(asset.url, dest);
    if (sha256File(dest) !== asset.sha256) {
      fs.rmSync(dest, { force: true });
      throw new Error(`sha256 mismatch for ${asset.path}; removed.`);
    }
  }

  for (const name of ['NOTICE.md', 'manifest.json', 'english_18m_refl_2026-10.config.template.yaml']) {
    fs.copyFileSync(path.join(srcDir, name), path.join(stageRoot, name));
  }
  console.log(`[fetch-pocket-tts] staged and verified at ${stageRoot}`);
}

main().catch((err) => {
  console.error(`[fetch-pocket-tts] ${err.message}`);
  process.exit(1);
});
