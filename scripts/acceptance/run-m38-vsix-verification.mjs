#!/usr/bin/env node
// M38 Scenario A — exact-byte VSIX inspection for the governed
// external-tool-fabric packaged candidate. Reuses win32VsixVerification.mjs
// (target platform, sqlite native PE signature, package-content prohibited
// path/string checks) directly rather than reimplementing any of it; adds
// only the size/entry-count/sha256 provenance record and evidence write-out.
//
// Usage: node scripts/acceptance/run-m38-vsix-verification.mjs [vsixPath]
// Exit codes: 0 pass, 1 fail.

import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWin32Vsix } from './win32VsixVerification.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const vsixPath = path.resolve(process.argv[2] ?? path.join(repoRoot, 'karkedikha-win32-x64.vsix'));
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm38', 'scenario-a-package-verification');

function log(message) {
  console.log(`[m38-vsix-verification] ${message}`);
}

function countZipEntries(zipPath) {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); try { $z.Entries.Count } finally { $z.Dispose() }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const count = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  if (result.status !== 0 || !Number.isFinite(count)) {
    throw new Error(`failed to count zip entries in ${zipPath}: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  }
  return count;
}

async function main() {
  if (!fs.existsSync(vsixPath)) {
    console.error(`VSIX not found at ${vsixPath}`);
    process.exit(1);
  }
  const stat = fs.statSync(vsixPath);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(vsixPath)).digest('hex');
  const entryCount = countZipEntries(vsixPath);

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-vsix-verify-'));
  const tarBinary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tarBinary, ['-xf', vsixPath, '-C', extractDir], { stdio: 'inherit' });

  const { ok, report } = verifyWin32Vsix(extractDir);

  const evidence = {
    capturedAt: new Date().toISOString(),
    vsixPath,
    bytes: stat.size,
    sha256,
    entryCount,
    targetPlatform: report.manifest.targetPlatform,
    ok,
    report,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'vsix-verification.json'), JSON.stringify(evidence, null, 2));
  fs.rmSync(extractDir, { recursive: true, force: true });

  log(`bytes=${stat.size} sha256=${sha256} entryCount=${entryCount} targetPlatform=${report.manifest.targetPlatform}`);
  log(ok ? 'PASSED' : `FAILED: ${JSON.stringify(report.checks)}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`[m38-vsix-verification] fatal: ${error.stack ?? error}`);
  process.exit(1);
});
