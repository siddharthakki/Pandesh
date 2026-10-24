import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TOKEN_FILE = 'core.token';
const CLIENT_ID_FILE = 'client-id.json';

export function getOrCreateDesktopToken(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const generated = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenPath, generated, { mode: 0o600, encoding: 'utf8' });
  return generated;
}

/**
 * Secret that only the Panda host presents when it decides a worker approval for a person. Core verifies it (X-Host-Token);
 * the client id header proves nothing because any holder of the Core bearer token can send any client id.
 */
export function getOrCreateHostToken(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, 'host.token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const generated = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenPath, generated, { mode: 0o600, encoding: 'utf8' });
  return generated;
}

export function getOrCreateDesktopClientId(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const idPath = path.join(dataDir, CLIENT_ID_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(idPath, 'utf8')) as { clientId?: string };
    if (typeof parsed.clientId === 'string' && parsed.clientId.startsWith('desktop_')) {
      return parsed.clientId;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const generated = `desktop_${crypto.randomUUID()}`;
  fs.writeFileSync(idPath, JSON.stringify({ clientId: generated }, null, 2), { mode: 0o600, encoding: 'utf8' });
  return generated;
}
