#!/usr/bin/env node
// node scripts/fetch-parakeet-model.mjs
//
// Fetches (once) the int8 Parakeet TDT 0.6B v3 model that core/attachments/parakeetEngine.ts uses for local speech
// recognition, into ./models/parakeet-tdt-v3-int8/. Build-time only: the packaged app never downloads anything.
//
//   Source : https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models  (sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2, ~487 MB)
//   Model  : nvidia/parakeet-tdt-0.6b-v3, CC-BY-4.0 (attribution: NVIDIA; the model README is kept next to the files)
//   Result : about 640 MB on disk. Every file is checked against scripts/parakeet-model.sha256; a mismatch aborts.
//
// Idempotent: does nothing when all files are present and match.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const modelDir = path.join(repoRoot, 'models', 'parakeet-tdt-v3-int8');
const ARCHIVE = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ARCHIVE}.tar.bz2`;

// Pinned from the verified download of 2026-11-25 (the files the accuracy numbers were measured with); sha256sum format.
const PIN_FILE = path.join(here, 'parakeet-model.sha256');
export const FILES = Object.fromEntries(
  fs.readFileSync(PIN_FILE, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [hash, name] = line.split(/\s+/);
    return [name, hash];
  }),
);

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function problems(dir) {
  const bad = [];
  for (const [name, expected] of Object.entries(FILES)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) bad.push(`${name}: missing`);
    else if (sha256(file) !== expected) bad.push(`${name}: SHA-256 mismatch`);
  }
  return bad;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})`);
}

function main() {
  if (problems(modelDir).length === 0) {
    console.log(`[fetch-parakeet-model] already present and verified at ${modelDir} — skipping.`);
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-fetch-'));
  try {
    console.log(`[fetch-parakeet-model] downloading ${URL} (~487 MB, build-time only)...`);
    run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', `${ARCHIVE}.tar.bz2`, URL], work);
    run('tar', ['xjf', `${ARCHIVE}.tar.bz2`], work);
    const extracted = path.join(work, ARCHIVE);
    const bad = problems(extracted);
    if (bad.length) throw new Error(`downloaded model failed verification: ${bad.join('; ')}`);
    fs.rmSync(modelDir, { recursive: true, force: true });
    fs.mkdirSync(modelDir, { recursive: true });
    for (const name of [...Object.keys(FILES), 'README.md']) {
      if (fs.existsSync(path.join(extracted, name))) fs.copyFileSync(path.join(extracted, name), path.join(modelDir, name));
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('[fetch-parakeet-model] done.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error('[fetch-parakeet-model] FAILED:', err.message); process.exit(1); }
}
