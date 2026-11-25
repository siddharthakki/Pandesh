/**
 * Build 192 regression: "Approve after review" (window and phone) always failed with "request to .../approve-review failed".
 * Core only lets the Pandesh host approve a worker's change (X-Host-Token), but CoreClient.approveDevStoryReview sent the plain
 * client token, so Core answered 403 with a body the client could not read.
 *
 * Core runs here with a host token that DIFFERS from the client token, as in production.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-approve-'));
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

const client = (hostToken?: string) => new CoreClient({ baseUrl, token: TOKEN, clientId: 'desktop-test', clientVersion: '0.1.0', clientType: 'desktop', ...(hostToken ? { hostToken } : {}) });

describe('approve-review from the desktop host', () => {
  it('is refused for a caller without the host token (the route stays host-only)', async () => {
    await expect(client().requestAsHost('/v1/dev-stories/story_none/approve-review', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403 });
  });

  it('gets past the host check with the host token: the story is looked up (not found), not refused as 403', async () => {
    const error = await client(HOST_TOKEN).approveDevStoryReview('story_none').then(() => null, (e: { status?: number }) => e);
    expect(error).not.toBeNull();
    expect(error!.status).not.toBe(403);
  });
});
