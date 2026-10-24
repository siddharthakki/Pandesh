#!/usr/bin/env node
// Deletes stray .ts/.tsx source files from node_modules before packaging.
//
// Some npm dependencies (tailwind-merge, style-to-object, style-to-js,
// parse5's nested `entities` dependency, ...) publish their raw TypeScript
// source alongside compiled dist/ JS. Node only ever requires the compiled
// .js at runtime, so the source is dead weight — and it's exactly what
// scripts/acceptance/packageContentAssertion.mjs's isProbablySourceTs check
// fails the packaged build on.
//
// This can't be done via .vscodeignore: vsce's ignore-file matcher treats
// any `!`-negated bare directory pattern (this repo has `!node_modules/`,
// needed so @vscode/sqlite3's native binary still ships) as unconditionally
// overriding every other node_modules exclusion pattern, by design of its
// ignore/negate-OR matching (see @vscode/vsce's collectFiles in
// node_modules/@vscode/vsce/out/package.js) — there is no ordering trick
// that lets a later ignore pattern re-exclude a file once any negate
// pattern already matched it. Removing files from disk before `vsce
// package` runs sidesteps that entirely.
//
// Declaration files (.d.ts) are left alone — they're inert at runtime and
// the acceptance check doesn't flag them.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nodeModulesRoot = path.join(repoRoot, 'node_modules');

function isStraySourceTs(filePath) {
  return /\.tsx?$/.test(filePath) && !/\.d\.tsx?$/.test(filePath);
}

function walkAndStrip(dir, removed) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndStrip(full, removed);
    } else if (entry.isFile() && isStraySourceTs(full)) {
      fs.unlinkSync(full);
      removed.push(full);
    }
  }
}

function main() {
  if (!fs.existsSync(nodeModulesRoot)) {
    console.log('[strip-node-modules-ts-sources] node_modules not present — skipping.');
    return;
  }
  const removed = [];
  walkAndStrip(nodeModulesRoot, removed);
  console.log(`[strip-node-modules-ts-sources] removed ${removed.length} stray .ts/.tsx source file(s) from node_modules.`);
}

main();
