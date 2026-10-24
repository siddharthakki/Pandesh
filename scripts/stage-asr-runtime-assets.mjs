#!/usr/bin/env node
// node scripts/stage-asr-runtime-assets.mjs
//
// Copies ONLY the specific files core/attachments/audioProcessing.ts's
// bundled whisper engine needs at runtime — @xenova/transformers' `src/`
// (its actual `main` entry for Node) plus onnxruntime-web's `dist/` (its
// compiled WASM runtime) and their own direct runtime dependencies — into
// runtime-assets/node_modules/, a self-contained, trimmed node_modules tree
// OUTSIDE the repo's real top-level node_modules/.
//
// Why: `vsce package`'s default dependency-walking (when a package is
// declared as a "dependency", not "devDependency") includes far more than
// intended for this specific dependency tree — every optional native
// backend (onnxruntime-node, sharp), every platform prebuild, docs/lib/types
// folders, and their own transitive chains — ballooning the packaged VSIX
// to 370MB+/5000+ files regardless of .vscodeignore's allowlist scoping
// (confirmed empirically: `--no-dependencies` swings the other way and
// drops node_modules handling entirely, breaking @vscode/sqlite3 too).
// Staging a hand-picked subset as plain repository-relative files (which
// vsce includes/excludes via .vscodeignore exactly like any other file,
// with none of the "declared dependency" auto-walk behavior) gives full,
// predictable control. It is still a real `node_modules` DIRECTORY NAME
// (just not the top-level one) so Node's ordinary module resolution finds
// cross-package `require`/`import` calls between these packages correctly
// (e.g. @xenova/transformers's own `import ... from 'onnxruntime-web'`
// resolves by walking up from its own location to the nearest ancestor
// `node_modules`, which is this staged one).
//
// Idempotent: skips entirely if the expected output already exists.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourceNodeModules = path.join(repoRoot, 'node_modules');
const stagedNodeModules = path.join(repoRoot, 'runtime-assets', 'node_modules');

const COPY_SPEC = [
  { pkg: '@xenova/transformers', include: ['package.json', 'src'] },
  { pkg: 'onnxruntime-web', include: ['package.json', 'dist'] },
  { pkg: 'onnxruntime-common', include: ['package.json', 'dist'] },
  { pkg: '@huggingface/jinja', include: ['package.json', 'dist'] },
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// @xenova/transformers' backends/onnx.js does an UNCONDITIONAL top-level
// `import * as ONNX_NODE from 'onnxruntime-node'` (see its own comment:
// "dynamic imports don't seem to work with the current webpack version").
// It only *uses* onnxruntime-node when `process.release.name === 'node'`
// (i.e. always, under both plain Node and Electron-as-Node), but the import
// itself is evaluated unconditionally regardless of which branch runs.
// onnxruntime-node ships a prebuilt native binary per-platform — exactly the
// kind of heavyweight, non-WASM dependency this staging approach exists to
// avoid shipping. We deliberately never stage the real onnxruntime-node.
// Instead we stage a tiny shim package of the same name whose sole job is
// to make that static import resolve, by re-exporting onnxruntime-web's
// pure-WASM implementation. `module.exports = require('onnxruntime-web')`
// is a pattern cjs-module-lexer special-cases to proxy named exports through
// for ESM `import * as X` callers, so this remains usable from onnx.js's
// ESM import. audioProcessing.ts's importTransformers() forces the
// execution-provider list back to WASM-only after import (onnx.js also
// unshifts a 'cpu' provider whenever it *thinks* it's running under Node,
// which onnxruntime-web does not implement).
function writeOnnxruntimeNodeShim() {
  const shimDir = path.join(stagedNodeModules, 'onnxruntime-node');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(
    path.join(shimDir, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-node', version: '0.0.0-wasm-shim', main: 'index.js' }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(shimDir, 'index.js'),
    "// Shim: this extension never ships the real onnxruntime-node native binary.\n"
    + "// @xenova/transformers statically imports 'onnxruntime-node' regardless of\n"
    + "// platform; re-export onnxruntime-web (pure WASM, no native binary) so that\n"
    + "// import resolves, and so it functions correctly if ever actually used as\n"
    + "// the selected backend.\n"
    + "module.exports = require('onnxruntime-web');\n",
  );
  console.log('[stage-asr-runtime-assets] wrote onnxruntime-node WASM-backed shim (no native binary shipped)');
}

// @xenova/transformers' utils/image.js similarly does an unconditional
// top-level `import sharp from 'sharp'`, used only for optional Node-side
// image loading (`else if (sharp) { ... }`) that our audio-only pipeline
// never exercises. sharp ships large prebuilt native binaries per-platform —
// again exactly what this staging approach exists to avoid. A default
// export of `null` makes the `if (sharp)` check falsy, which is a real,
// truthful "image loading via sharp is unavailable" state (never fabricates
// image support), while letting the static import resolve.
function writeSharpShim() {
  const shimDir = path.join(stagedNodeModules, 'sharp');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(
    path.join(shimDir, 'package.json'),
    JSON.stringify({ name: 'sharp', version: '0.0.0-unavailable-shim', main: 'index.js' }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(shimDir, 'index.js'),
    "// Shim: this extension never ships the real `sharp` native image library.\n"
    + "// @xenova/transformers statically imports 'sharp' regardless of whether\n"
    + "// image support is needed; this audio-only integration never uses it.\n"
    + "// Keep this truthy so Transformers can initialize its audio pipeline.\n"
    + "// An attempted image call still fails closed: this package has no image backend.\n"
    + "module.exports = function unavailableSharp() { throw new Error('sharp is unavailable in this packaged audio-only runtime'); };\n",
  );
  console.log('[stage-asr-runtime-assets] wrote sharp unavailable-shim (no native binary shipped, audio path does not need it)');
}

function alreadyStaged() {
  return COPY_SPEC.every(({ pkg }) => fs.existsSync(path.join(stagedNodeModules, pkg, 'package.json')))
    && fs.existsSync(path.join(stagedNodeModules, 'onnxruntime-node', 'package.json'))
    && fs.existsSync(path.join(stagedNodeModules, 'sharp', 'package.json'));
}

function main() {
  if (alreadyStaged()) {
    writeOnnxruntimeNodeShim();
    writeSharpShim();
    console.log(`[stage-asr-runtime-assets] already present at ${stagedNodeModules} — skipping.`);
    return;
  }
  fs.rmSync(stagedNodeModules, { recursive: true, force: true });
  for (const { pkg, include } of COPY_SPEC) {
    const srcPkgDir = path.join(sourceNodeModules, pkg);
    if (!fs.existsSync(srcPkgDir)) {
      throw new Error(`[stage-asr-runtime-assets] expected node_modules/${pkg} to exist (run npm install first)`);
    }
    const destPkgDir = path.join(stagedNodeModules, pkg);
    for (const relPath of include) {
      const src = path.join(srcPkgDir, relPath);
      if (!fs.existsSync(src)) {
        throw new Error(`[stage-asr-runtime-assets] expected node_modules/${pkg}/${relPath} to exist`);
      }
      copyRecursive(src, path.join(destPkgDir, relPath));
    }
    console.log(`[stage-asr-runtime-assets] staged ${pkg} (${include.join(', ')})`);
  }
  writeOnnxruntimeNodeShim();
  writeSharpShim();
}

main();
