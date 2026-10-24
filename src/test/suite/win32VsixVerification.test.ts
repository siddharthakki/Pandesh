import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { verifyWin32Vsix } from '../../../scripts/acceptance/win32VsixVerification.mjs';

const SQLITE_NATIVE_RELATIVE = path.join('node_modules', '@vscode', 'sqlite3', 'build', 'Release', 'vscode-sqlite3.node');
const WINDOWS_PE_HEADER = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // "MZ" + filler
const LINUX_ELF_HEADER = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // "\x7fELF"

async function buildValidExtractedVsix(root: string) {
  const extensionDir = path.join(root, 'extension');
  await fs.mkdir(path.join(extensionDir, 'out'), { recursive: true });
  await fs.mkdir(path.join(extensionDir, 'out-core'), { recursive: true });
  await fs.mkdir(path.join(extensionDir, 'media'), { recursive: true });
  await fs.mkdir(path.join(extensionDir, path.dirname(SQLITE_NATIVE_RELATIVE)), { recursive: true });

  await fs.writeFile(
    path.join(extensionDir, 'package.json'),
    JSON.stringify({
      name: 'ollama-agent',
      contributes: { commands: [{ command: 'ollama-agent.startAutonomousTask' }] },
    }),
    'utf8',
  );
  await fs.writeFile(path.join(extensionDir, 'out', 'extension.js'), '// bundled extension\n', 'utf8');
  await fs.writeFile(path.join(extensionDir, 'out-core', 'core.js'), '// bundled core\n', 'utf8');
  await fs.writeFile(path.join(extensionDir, 'media', 'chat.html'), '<!doctype html><html></html>\n', 'utf8');
  await fs.writeFile(path.join(extensionDir, 'media', 'chat.js'), '// primary chat webview UI\n', 'utf8');
  await fs.writeFile(path.join(extensionDir, 'media', 'chat-sidebar-ui.js'), '// inline approval webview UI\n', 'utf8');
  await fs.writeFile(path.join(extensionDir, 'media', 'chat-autonomous.js'), '// autonomous webview UI\n', 'utf8');
  await fs.writeFile(path.join(extensionDir, SQLITE_NATIVE_RELATIVE), WINDOWS_PE_HEADER);

  await fs.writeFile(
    path.join(root, 'extension.vsixmanifest'),
    '<PackageManifest><Metadata><Identity TargetPlatform="win32-x64" /></Metadata></PackageManifest>',
    'utf8',
  );

  return extensionDir;
}

describe('verifyWin32Vsix', () => {
  let root = '';

  afterEach(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      root = '';
    }
  });

  it('passes a well-formed win32-x64 package with a PE-signed sqlite native binary', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-win32-vsix-verify-'));
    await buildValidExtractedVsix(root);

    const { ok, report } = verifyWin32Vsix(root);

    expect(ok).toBe(true);
    expect(report.checks).toEqual({
      packageContentOk: true,
      targetPlatformOk: true,
      sqlitePresentOk: true,
      sqliteSignatureOk: true,
    });
  });

  it('fails when the sqlite native binary is a Linux ELF binary instead of a Windows PE binary', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-win32-vsix-verify-'));
    const extensionDir = await buildValidExtractedVsix(root);
    await fs.writeFile(path.join(extensionDir, SQLITE_NATIVE_RELATIVE), LINUX_ELF_HEADER);

    const { ok, report } = verifyWin32Vsix(root);

    expect(ok).toBe(false);
    expect(report.checks.sqliteSignatureOk).toBe(false);
    expect(report.sqlite.signatureHex).toBe('7f45');
  });

  it('fails when the sqlite native binary is missing entirely', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-win32-vsix-verify-'));
    const extensionDir = await buildValidExtractedVsix(root);
    await fs.rm(path.join(extensionDir, SQLITE_NATIVE_RELATIVE));

    const { ok, report } = verifyWin32Vsix(root);

    expect(ok).toBe(false);
    expect(report.checks.sqlitePresentOk).toBe(false);
  });

  it('fails when the manifest does not declare TargetPlatform="win32-x64"', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-win32-vsix-verify-'));
    await buildValidExtractedVsix(root);
    await fs.writeFile(
      path.join(root, 'extension.vsixmanifest'),
      '<PackageManifest><Metadata><Identity /></Metadata></PackageManifest>',
      'utf8',
    );

    const { ok, report } = verifyWin32Vsix(root);

    expect(ok).toBe(false);
    expect(report.checks.targetPlatformOk).toBe(false);
  });

  it('fails when required runtime assets are missing', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-win32-vsix-verify-'));
    const extensionDir = await buildValidExtractedVsix(root);
    await fs.rm(path.join(extensionDir, 'out', 'extension.js'));

    const { ok, report } = verifyWin32Vsix(root);

    expect(ok).toBe(false);
    expect(report.checks.packageContentOk).toBe(false);
  });
});
