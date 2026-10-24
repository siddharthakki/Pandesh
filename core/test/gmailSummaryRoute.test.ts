import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import type { ModelBackend, ModelChatRequest } from '../runtime/modelBackend';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;
let capturedRequests: ModelChatRequest[];

function authedFetch(pathAndQuery: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'test-desktop',
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

function fakeBackend(): ModelBackend {
  return {
    async streamChat(req) {
      capturedRequests.push(req);
      return { content: 'This thread discusses lunch plans.', toolCalls: [], provider: 'ollama', model: req.model, usage: { durationMs: 1 } };
    },
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-gmail-summary-route-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  capturedRequests = [];
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster: new EventBroadcaster(),
    dataDir: dir,
    gmailSummaryBackend: fakeBackend(),
    coreInfo: () => ({
      coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test-instance', startedAt: new Date().toISOString(),
      nodeVersion: process.version, electronVersion: null, dataDir: dir,
    }),
    onShutdown: () => {},
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /v1/gmail/summarize-thread', () => {
  it('returns a summary from the injected local backend', async () => {
    const res = await authedFetch('/v1/gmail/summarize-thread', {
      method: 'POST',
      body: JSON.stringify({ model: 'test-model', messages: [{ from: 'a@example.com', subject: 'Lunch', date: 'Mon', bodyText: 'Free for lunch?' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain('lunch');
    expect(capturedRequests[0].model).toBe('test-model');
    expect(capturedRequests[0].tools).toBeUndefined();
  });

  it('rejects an empty messages array', async () => {
    const res = await authedFetch('/v1/gmail/summarize-thread', {
      method: 'POST',
      body: JSON.stringify({ model: 'test-model', messages: [] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await fetch(`${baseUrl}/v1/gmail/summarize-thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ from: 'a@example.com', subject: 's', date: 'd', bodyText: 'b' }] }),
    });
    expect(res.status).toBe(401);
  });
});
