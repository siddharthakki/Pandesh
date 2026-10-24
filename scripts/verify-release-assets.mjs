#!/usr/bin/env node
// node scripts/verify-release-assets.mjs
//
// Prepackage assertion: fails clearly if the UI v2 bundle (or any other
// required release asset) is missing before vsce package runs. Run after
// `bundle:webview-v2` and before `vsce package` in the `package` script.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const REQUIRED_ASSETS = [
  'media/chat-v2.html',
  'out/webview-v2/webview.js',
  'out/webview-v2/webview.css',
];

function main() {
  const missing = REQUIRED_ASSETS.filter((relPath) => !fs.existsSync(path.join(repoRoot, relPath)));

  if (missing.length > 0) {
    console.error('FAILED: required release assets are missing before packaging:');
    for (const relPath of missing) {
      console.error(`  - ${relPath}`);
    }
    console.error('Run `npm run bundle:webview-v2` (or `npm run package`, which does this automatically).');
    process.exit(1);
  }

  console.log('PASSED: required release assets present:');
  for (const relPath of REQUIRED_ASSETS) {
    console.log(`  - ${relPath}`);
  }
}

main();
