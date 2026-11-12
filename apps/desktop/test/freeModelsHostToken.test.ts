/**
 * Build 165 regression: the v2 Free cloud models card called the host-only /v1/cloud/registry with the plain client
 * token. Core answered 403, and CoreClient treated that 403 as a credential failure, so every later request failed
 * with "/v1/cloud/registry rejected credentials" and chats could not load.
 *
 * Unlike #67's own tests, Core runs here with a host token that DIFFERS from the client token, as in production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../../../core/db/openCore';
import type { CoreDatabase } from '../../../core/db/connection';
import { startApiServer, type RunningApiServer } from '../../../core/api/server';
import { EventBroadcaster } from '../../../core/ws/broadcaster';
import { generateToken } from '../../../core/auth/token';
import { CoreClient } from '../../../src/core-client/CoreClient';

const TOKEN = generateToken();
const HOST_TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-hosttoken-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  api = await startApiServer({
    db, token: TOKEN, hostToken: HOST_TOKEN, broadcaster: new EventBroadcaster(), dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const client = (token = TOKEN) => new CoreClient({ baseUrl, token, clientId: 'desktop-test', clientVersion: '0.1.0', clientType: 'desktop', hostToken: HOST_TOKEN });

describe('free-model routes from the desktop host', () => {
  it('the host reaches /v1/cloud/registry and /v1/cloud/route with its host token', async () => {
    const c = client();
    const registry = await c.requestAsHost<{ providers?: unknown[] }>('/v1/cloud/registry');
    expect(registry).toBeTypeOf('object');
    await expect(c.requestAsHost('/v1/cloud/route', { method: 'POST', body: { task: 'chat', privacy: 'public', exclude: [] } })).resolves.toBeDefined();
    expect(c.getStatus().state).not.toBe('authentication_failed');
  });

  it('a 403 on one host-only route fails that request only; the connection stays usable', async () => {
    const c = client();
    await expect(c.request('/v1/cloud/registry')).rejects.toMatchObject({ status: 403 });
    expect(c.getStatus().state).not.toBe('authentication_failed');
    // The next ordinary request still works.
    await expect(c.request('/v1/cloud/catalog')).resolves.toBeDefined();
  });

  it('a wrong token (401) still marks the connection as failed', async () => {
    const c = client(generateToken());
    await expect(c.request('/v1/cloud/catalog')).rejects.toMatchObject({ status: 401 });
    expect(c.getStatus().state).toBe('authentication_failed');
  });

  it('the desktop host calls every host-only free-model route with requestAsHost', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'host', 'desktopSession.ts'), 'utf8');
    const plain = [...source.matchAll(/\.request(?:<[^(]*?>)?\(\s*[`'"]\/v1\/cloud\/(?:registry|route)/g)].map((m) => m[0]);
    expect(plain).toEqual([]);
    expect(source).toMatch(/requestAsHost(?:<[^(]*?>)?\(\s*'\/v1\/cloud\/registry'/);
  });
});
