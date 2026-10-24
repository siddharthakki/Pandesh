/**
 * Fetch openWakeWord ONNX models (hey_jarvis + feature models) into
 * models/openwakeword/. Build-time only; packaged Desktop loads them locally.
 */
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'models', 'openwakeword');
const BASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';

const FILES = [
  'hey_jarvis_v0.1.onnx',
  'melspectrogram.onnx',
  'embedding_model.onnx',
  'silero_vad.onnx',
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'karkedikha-openwakeword-fetch' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve, reject);
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

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of FILES) {
    const dest = path.join(outDir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      console.log(`[fetch-openwakeword] have ${name}`);
      continue;
    }
    console.log(`[fetch-openwakeword] downloading ${name}…`);
    await download(`${BASE}/${name}`, dest);
  }
  console.log(`[fetch-openwakeword] ready at ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
