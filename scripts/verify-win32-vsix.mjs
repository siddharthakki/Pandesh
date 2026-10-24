#!/usr/bin/env node
// node scripts/verify-win32-vsix.mjs <path-to-win32-vsix>
//
// CLI wrapper: extracts a produced win32-x64 VSIX and runs the static
// structural verification in scripts/acceptance/win32VsixVerification.mjs.
// Exits non-zero on any failed check. Passing this does not by itself mean
// the package is accepted for M35 — Windows activation is still required.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { verifyWin32Vsix } from './acceptance/win32VsixVerification.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extractVsix(vsixPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  // VSIX files are standard zip archives. On Windows, prefer the bundled
  // bsdtar (System32\tar.exe) explicitly — Git Bash's GNU tar on PATH parses
  // a leading "C:\" as a remote-shell host spec and fails. On Linux, GNU
  // tar (unlike bsdtar) cannot extract zip archives at all, so use unzip
  // instead — already relied on elsewhere in this workflow for VSIX entry
  // counting, so it is known to be present on the CI runner.
  if (process.platform === 'win32') {
    const tarBinary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tarBinary, ['-xf', vsixPath, '-C', destination], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', vsixPath, '-d', destination], { stdio: 'inherit' });
  }
}

function main() {
  const vsixArg = process.argv[2];
  if (!vsixArg) {
    console.error('Usage: node scripts/verify-win32-vsix.mjs <path-to-win32-vsix>');
    process.exit(2);
  }
  const vsixPath = path.resolve(vsixArg);
  if (!fs.existsSync(vsixPath)) {
    console.error(`VSIX not found: ${vsixPath}`);
    process.exit(2);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-win32-vsix-verify-'));
  const extractDir = path.join(workDir, 'extracted');
  try {
    extractVsix(vsixPath, extractDir);
    const { ok, report } = verifyWin32Vsix(extractDir);
    console.log(JSON.stringify(report, null, 2));
    if (!ok) {
      console.error('FAILED: win32 VSIX static verification.');
      process.exit(1);
    }
    console.log('PASSED: win32 VSIX static verification (Windows activation is still required for M35 acceptance).');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
