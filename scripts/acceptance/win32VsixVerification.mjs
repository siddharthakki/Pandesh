// Static verification for the M35 win32-x64 VSIX.
//
// This confirms the artifact is structurally a genuine Windows package
// (declared target platform, a PE-signed sqlite native binary, required
// production assets present, no harness/test material shipped). It does
// NOT prove the extension activates — a PE binary can still be built
// against an incompatible Node ABI/V8 version. Activation inside a real
// Windows VS Code install is a separate, mandatory acceptance step.

import * as fs from 'fs';
import * as path from 'path';
import { assertPackagedContent } from './packageContentAssertion.mjs';

const SQLITE_NATIVE_RELATIVE = path.join('node_modules', '@vscode', 'sqlite3', 'build', 'Release', 'vscode-sqlite3.node');
const WINDOWS_PE_SIGNATURE = Buffer.from('MZ', 'ascii');

function readManifestTargetPlatform(extractedRoot) {
  const manifestPath = path.join(extractedRoot, 'extension.vsixmanifest');
  if (!fs.existsSync(manifestPath)) {
    return { present: false, targetPlatform: null };
  }
  const xml = fs.readFileSync(manifestPath, 'utf8');
  const match = xml.match(/TargetPlatform="([^"]*)"/);
  return { present: true, targetPlatform: match ? match[1] : null };
}

function readSqliteNativeSignature(extractedExtensionDir) {
  const binaryPath = path.join(extractedExtensionDir, SQLITE_NATIVE_RELATIVE);
  if (!fs.existsSync(binaryPath)) {
    return { present: false, signatureHex: null, isWindowsPe: false };
  }
  const fd = fs.openSync(binaryPath, 'r');
  const header = Buffer.alloc(2);
  fs.readSync(fd, header, 0, 2, 0);
  fs.closeSync(fd);
  return {
    present: true,
    signatureHex: header.toString('hex'),
    isWindowsPe: header.equals(WINDOWS_PE_SIGNATURE),
  };
}

/**
 * @param {string} extractedRoot absolute path to an extracted VSIX (the directory that directly
 *   contains extension.vsixmanifest and the extension/ subdirectory)
 */
export function verifyWin32Vsix(extractedRoot) {
  const extensionDir = path.join(extractedRoot, 'extension');
  const { ok: packageContentOk, report: packageContentReport } = assertPackagedContent(extensionDir);
  const manifest = readManifestTargetPlatform(extractedRoot);
  const sqlite = readSqliteNativeSignature(extensionDir);

  const targetPlatformOk = manifest.present && manifest.targetPlatform === 'win32-x64';
  const sqlitePresentOk = sqlite.present;
  const sqliteSignatureOk = sqlite.isWindowsPe;

  const checks = { packageContentOk, targetPlatformOk, sqlitePresentOk, sqliteSignatureOk };
  const ok = Object.values(checks).every(Boolean);

  return {
    ok,
    report: {
      extractedRoot,
      manifest,
      sqlite,
      packageContent: packageContentReport,
      checks,
      note: 'Static checks only. Windows activation is a separate mandatory acceptance step.',
    },
  };
}
