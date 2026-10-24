/**
 * Proves the actual HTTP /v1/submit path for Core-owned local model routing
 * end to end, against a test-owned fake Ollama `/api/tags` endpoint rather
 * than a real model or a real Ollama install. No live model workflow runs
 * here — see core/test/missionRepoQuestion.workflow.test.ts (gated behind
 * KARKEDIKHA_LIVE_REPO_QUESTION=1) for that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { getAttemptContext } from '../domain/attemptContext';
import { LOCAL_CORE_QUESTION_PROFILE } from '../runtime/localCoreQuestion';
import { AUTONOMOUS_MISSION_PROFILE } from '../runtime/missionLoop';
import {
  AUTO_FALLBACK_MODEL,
  AUTO_MUTATION_MODEL,
  AUTO_QUESTION_MODEL,
} from '../domain/modelRouting';

const TOKEN = generateToken();

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;
let ollamaServer: http.Server;
let ollamaTagsHits: number;
let ollamaModels: string[] | 'unreachable';
const originalOllamaUrl = process.env.KARKEDIKHA_OLLAMA_URL;

function authed(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'auto-routing-test-client',
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

let idempotencyCounter = 0;
function nextIdemp(): string {
  idempotencyCounter += 1;
  return `auto-routing-idemp-${idempotencyCounter}`;
}

beforeEach(async () => {
  ollamaTagsHits = 0;
  ollamaModels = [];
  ollamaServer = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      ollamaTagsHits += 1;
      if (ollamaModels === 'unreachable') {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: ollamaModels.map((name) => ({ name })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => ollamaServer.listen(0, '127.0.0.1', resolve));
  const { port } = ollamaServer.address() as AddressInfo;
  process.env.KARKEDIKHA_OLLAMA_URL = `http://127.0.0.1:${port}`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-auto-routing-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster,
    dataDir: dir,
    coreInfo: () => ({
      coreVersion: '0.1.0',
      apiVersion: 1,
      instanceId: 'auto-routing-test-instance',
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
      electronVersion: null,
      dataDir: dir,
    }),
    onShutdown: () => {},
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  await api.close();
  db.close();
  await new Promise<void>((resolve) => ollamaServer.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalOllamaUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL;
  else process.env.KARKEDIKHA_OLLAMA_URL = originalOllamaUrl;
});

describe('Core-owned local model routing over the real /v1/submit HTTP path', () => {
  it('routes an auto Local Core question to the measured question model (GSQ)', async () => {
    ollamaModels = [AUTO_QUESTION_MODEL, AUTO_MUTATION_MODEL, 'laguna-xs-2.1:latest', 'qwen2.5-coder:1.5b'];
    const res = await authed('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Explain the delivery manifest module',
        requestedMode: 'saath_kar',
        toolPermissionPolicy: { profile: LOCAL_CORE_QUESTION_PROFILE },
        autoSelectModel: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.modelSelection.selectedModel).toBe(AUTO_QUESTION_MODEL);
    expect(body.modelSelection.userOverrode).toBe(false);
    expect(getAttemptContext(db, body.attempt.id).selectedModel).toBe(AUTO_QUESTION_MODEL);
    expect(ollamaTagsHits).toBe(1);
  });

  it('routes an auto Autonomous Mission submission to the measured mutation model (Q4)', async () => {
    ollamaModels = [AUTO_QUESTION_MODEL, AUTO_MUTATION_MODEL, 'laguna-xs-2.1:latest', 'qwen2.5-coder:1.5b'];
    const res = await authed('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Fix the failing test and commit',
        requestedMode: 'saath_kar',
        toolPermissionPolicy: { profile: AUTONOMOUS_MISSION_PROFILE },
        autoSelectModel: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.modelSelection.selectedModel).toBe(AUTO_MUTATION_MODEL);
    expect(getAttemptContext(db, body.attempt.id).selectedModel).toBe(AUTO_MUTATION_MODEL);
  });

  it('lets an explicit model selection bypass routing entirely, even with Auto-capable models installed', async () => {
    ollamaModels = [AUTO_QUESTION_MODEL, AUTO_MUTATION_MODEL];
    const res = await authed('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Explain the delivery manifest module',
        requestedMode: 'saath_kar',
        requestedProvider: 'ollama',
        requestedModel: 'operator-chosen:model',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.modelSelection.selectedModel).toBe('operator-chosen:model');
    // Explicit selection never consults the catalog.
    expect(ollamaTagsHits).toBe(0);
  });

  it('falls through to the next installed candidate when the preferred model is missing', async () => {
    ollamaModels = [AUTO_MUTATION_MODEL, 'qwen2.5-coder:1.5b'];
    const res = await authed('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Explain the delivery manifest module',
        requestedMode: 'saath_kar',
        toolPermissionPolicy: { profile: LOCAL_CORE_QUESTION_PROFILE },
        autoSelectModel: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.modelSelection.selectedModel).toBe(AUTO_MUTATION_MODEL);
    expect(body.modelSelection.candidates.find((c: { model: string }) => c.model === AUTO_QUESTION_MODEL))
      .toMatchObject({ available: false });
  });

  it('records the historic fallback, marked unavailable, when Ollama is unreachable', async () => {
    ollamaModels = 'unreachable';
    const res = await authed('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Explain the delivery manifest module',
        requestedMode: 'saath_kar',
        toolPermissionPolicy: { profile: LOCAL_CORE_QUESTION_PROFILE },
        autoSelectModel: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.modelSelection.selectedModel).toBe(AUTO_FALLBACK_MODEL);
    expect(body.modelSelection.candidates.every((c: { available: boolean }) => !c.available)).toBe(true);
  });

  it('fails closed when Auto is combined with an explicit model', async () => {
    ollamaModels = [AUTO_QUESTION_MODEL];
    const res = await authed('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Explain the delivery manifest module',
        requestedMode: 'saath_kar',
        autoSelectModel: true,
        requestedModel: 'operator-chosen:model',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(ollamaTagsHits).toBe(0);
  });

  it('fails closed when Ollama is reachable but no chain model is installed', async () => {
    ollamaModels = ['some-unrelated-model:latest'];
    const res = await authed('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Explain the delivery manifest module',
        requestedMode: 'saath_kar',
        toolPermissionPolicy: { profile: LOCAL_CORE_QUESTION_PROFILE },
        autoSelectModel: true,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it('replays a completed duplicate submit without repeating the Ollama catalog fetch', async () => {
    ollamaModels = [AUTO_QUESTION_MODEL];
    const key = nextIdemp();
    const requestInit: RequestInit = {
      method: 'POST',
      body: JSON.stringify({
        currentMessage: 'Explain the delivery manifest module',
        requestedMode: 'saath_kar',
        toolPermissionPolicy: { profile: LOCAL_CORE_QUESTION_PROFILE },
        autoSelectModel: true,
      }),
    };
    const first = await authed('/v1/submit', { ...requestInit, idempotencyKey: key });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(ollamaTagsHits).toBe(1);

    const second = await authed('/v1/submit', { ...requestInit, idempotencyKey: key });
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);
    // The duplicate is a cached replay of an already-terminal idempotency
    // key — it must not perform a second, wasted network round trip.
    expect(ollamaTagsHits).toBe(1);
  });
});
