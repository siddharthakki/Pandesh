import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isCredentialFilePath, redactSecrets } from '../platform/credentialStore';
import { createFilesystemCapabilityAdapter } from '../runtime/filesystemCapability';

// Synthetic values only: shaped like real credentials, never real ones.
const FAKE_GOOGLE_SECRET = `GOCSPX-${'a1B2c3D4'.repeat(3)}`;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-guard-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('credential file guard', () => {
  it.each([
    'credentials.env', '.env', '.env.local', 'client_secret_123.apps.googleusercontent.com.json',
    'google-oauth-client.json', 'google.oauth-client.credential.bin', 'mobile-pair.json', 'server.pem', 'id_ed25519',
  ])('refuses %s', (name) => {
    expect(isCredentialFilePath(path.join(dir, name))).toBe(true);
  });

  it.each(['README.md', 'package.json', '.env.example', 'credentials-guide.md', 'notes.txt'])('allows %s', (name) => {
    expect(isCredentialFilePath(path.join(dir, name))).toBe(false);
  });

  it('sees through Windows aliases and symlinks', () => {
    expect(isCredentialFilePath(path.join(dir, 'credentials.env.'))).toBe(true);
    expect(isCredentialFilePath(`${path.join(dir, 'credentials.env')}::$DATA`)).toBe(true);
    const real = path.join(dir, 'credentials.env');
    fs.writeFileSync(real, 'X=1');
    const link = path.join(dir, 'notes.txt');
    try { fs.symlinkSync(real, link); } catch { return; } // symlinks need privilege on Windows
    expect(isCredentialFilePath(link)).toBe(true);
  });

  it('redacts Google client secrets and env-style secret lines from any tool output', () => {
    const out = redactSecrets(`ok\nJARVIS_GOOGLE_CLIENT_SECRET=${FAKE_GOOGLE_SECRET}\nsee ${FAKE_GOOGLE_SECRET} here\nPORT=8000`);
    expect(out).not.toContain(FAKE_GOOGLE_SECRET);
    expect(out).toContain('PORT=8000');
  });

  it('the outside-workspace read capability refuses a credential file and never returns its content', async () => {
    const file = path.join(dir, 'credentials.env');
    fs.writeFileSync(file, `GOOGLE_CLIENT_SECRET=${FAKE_GOOGLE_SECRET}\n`);
    const result = await createFilesystemCapabilityAdapter().run({ name: 'read_file_outside_workspace', arguments: { path: file } } as never);
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('filesystem_credential_file_refused');
    expect(result.output).not.toContain(FAKE_GOOGLE_SECRET);
  });

  it('redacts a secret that sits in an ordinary, non-credential file', async () => {
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, `pasted: ${FAKE_GOOGLE_SECRET}\n`);
    const result = await createFilesystemCapabilityAdapter().run({ name: 'read_file_outside_workspace', arguments: { path: file } } as never);
    expect(result.status).toBe('succeeded');
    expect(result.output).not.toContain(FAKE_GOOGLE_SECRET);
  });
});
