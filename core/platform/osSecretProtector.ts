/**
 * OS-backed protection for secrets Core must keep on disk.
 *
 * On Windows this is DPAPI in the CurrentUser scope: a blob protected here can only be opened by the same Windows
 * account on the same machine, so a copy of Core's data folder (a backup, a synced folder, a stolen disk image read
 * from another account) is useless without the user's logon. Core is a plain Node process without Electron's
 * `safeStorage`, so it reaches DPAPI through Windows PowerShell's `ProtectedData` — one short process per call, which
 * is why callers protect one small key and cache it rather than calling this per message.
 *
 * Secrets travel over the child's stdin/stdout only, never on its command line.
 */
import { execFile } from 'node:child_process';

export interface SecretProtector {
  /** A short name for status and logs, e.g. "Windows DPAPI (current user)". */
  readonly kind: string;
  protect(plain: Buffer): Promise<Buffer>;
  unprotect(blob: Buffer): Promise<Buffer>;
}

/** Binds a blob to Pandesh, so a DPAPI blob made by another program for this user does not open here. */
const DPAPI_ENTROPY = 'pandesh-os-secret-v1';

function dpapiScript(op: 'Protect' | 'Unprotect'): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    `$out = [Security.Cryptography.ProtectedData]::${op}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
}

function runDpapi(op: 'Protect' | 'Unprotect', input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(dpapiScript(op), 'utf16le').toString('base64');
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(new Error(`DPAPI ${op.toLowerCase()} failed: ${err.message.split('\n')[0]}`)); return; }
      const out = Buffer.from(String(stdout).trim(), 'base64');
      if (!out.length) { reject(new Error(`DPAPI ${op.toLowerCase()} returned nothing`)); return; }
      resolve(out);
    });
    child.stdin?.end(input.toString('base64'));
  });
}

export const windowsDpapiProtector: SecretProtector = {
  kind: 'Windows DPAPI (current user)',
  protect: (plain) => runDpapi('Protect', plain),
  unprotect: (blob) => runDpapi('Unprotect', blob),
};

/** The OS secret store for this platform, or null when Core has none (then secrets that need one are refused). */
export function defaultSecretProtector(): SecretProtector | null {
  return process.platform === 'win32' ? windowsDpapiProtector : null;
}
