import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;
let wsUrl: string;

function authedFetch(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string; clientId?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': init.clientId ?? 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

let idempotencyCounter = 0;
function nextIdemp(): string {
  idempotencyCounter += 1;
  return `idemp-${idempotencyCounter}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-api-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster,
    dataDir: dir,
    coreInfo: () => ({
      coreVersion: '0.1.0',
      apiVersion: 1,
      instanceId: 'test-instance',
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
      electronVersion: null,
      dataDir: dir,
    }),
    onShutdown: () => {},
  });
  ws = attachWsServer({
    httpServer: api.server,
    token: TOKEN,
    broadcaster,
    instanceId: 'test-instance',
    latestSequence: () => latestSequence(db),
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
  wsUrl = `ws://127.0.0.1:${api.port}/v1/ws`;
});

afterEach(async () => {
  ws.close();
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('authentication', () => {
  it('allows unauthenticated health checks', async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    expect(res.status).toBe(200);
  });

  it('rejects protected routes with no token', async () => {
    const res = await fetch(`${baseUrl}/v1/projects`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
  });

  it('rejects protected routes with an invalid token', async () => {
    const res = await fetch(`${baseUrl}/v1/projects`, { headers: { Authorization: 'Bearer wrong-token' } });
    expect(res.status).toBe(401);
  });

  it('accepts a valid token', async () => {
    const res = await authedFetch('/v1/projects');
    expect(res.status).toBe(200);
  });
});

describe('core info', () => {
  it('reports coreVersion/apiVersion', async () => {
    const res = await authedFetch('/v1/core/info');
    const body = await res.json();
    expect(body.coreVersion).toBe('0.1.0');
    expect(body.apiVersion).toBe(1);
  });
});

describe('project CRUD', () => {
  it('creates, lists, gets, updates, and archives a project', async () => {
    const createRes = await authedFetch('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'JUGAAD', aliases: ['household app'] }),
      idempotencyKey: nextIdemp(),
    });
    expect(createRes.status).toBe(201);
    const project = await createRes.json();
    expect(project.name).toBe('JUGAAD');

    const listRes = await authedFetch('/v1/projects');
    const list = await listRes.json();
    expect(list.projects.some((p: { id: string }) => p.id === project.id)).toBe(true);

    const getRes = await authedFetch(`/v1/projects/${project.id}`);
    expect((await getRes.json()).id).toBe(project.id);

    const patchRes = await authedFetch(`/v1/projects/${project.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'household platform' }),
      idempotencyKey: nextIdemp(),
    });
    expect((await patchRes.json()).description).toBe('household platform');

    const archiveRes = await authedFetch(`/v1/projects/${project.id}/archive`, { method: 'POST', idempotencyKey: nextIdemp() });
    expect((await archiveRes.json()).status).toBe('archived');
  });

  it('rejects a malformed create request with a structured 400', async () => {
    const res = await authedFetch('/v1/projects', { method: 'POST', body: JSON.stringify({}), idempotencyKey: nextIdemp() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.correlationId).toBeTruthy();
  });

  it('requires an Idempotency-Key header on mutating routes', async () => {
    const res = await authedFetch('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'X' }) });
    expect(res.status).toBe(400);
  });
});

describe('story lifecycle over HTTP', () => {
  async function createProject(): Promise<{ id: string }> {
    const res = await authedFetch('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'JUGAAD' }), idempotencyKey: nextIdemp() });
    return res.json();
  }

  it('creates a story, transitions it, comments, and archives it', async () => {
    const project = await createProject();
    const createRes = await authedFetch('/v1/stories', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, title: 'Add dark mode', storyType: 'story' }),
      idempotencyKey: nextIdemp(),
    });
    expect(createRes.status).toBe(201);
    const story = await createRes.json();
    expect(story.status).toBe('inbox');

    const transitionRes = await authedFetch(`/v1/stories/${story.id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ toStatus: 'ready' }),
      idempotencyKey: nextIdemp(),
    });
    expect(transitionRes.status).toBe(200);
    expect((await transitionRes.json()).status).toBe('ready');

    const badTransitionRes = await authedFetch(`/v1/stories/${story.id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ toStatus: 'done' }),
      idempotencyKey: nextIdemp(),
    });
    expect(badTransitionRes.status).toBe(422);

    const commentRes = await authedFetch(`/v1/stories/${story.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: 'looks good' }),
      idempotencyKey: nextIdemp(),
    });
    expect(commentRes.status).toBe(201);

    const archiveRes = await authedFetch(`/v1/stories/${story.id}/archive`, { method: 'POST', idempotencyKey: nextIdemp() });
    expect((await archiveRes.json()).status).toBe('archived');
  });

  it('filters story listing by project and status', async () => {
    const project = await createProject();
    await authedFetch('/v1/stories', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, title: 'A', storyType: 'task' }),
      idempotencyKey: nextIdemp(),
    });
    const listRes = await authedFetch(`/v1/stories?projectId=${project.id}&status=inbox`);
    const list = await listRes.json();
    expect(list.stories.length).toBeGreaterThanOrEqual(1);
    expect(list.stories.every((s: { projectId: string; status: string }) => s.projectId === project.id && s.status === 'inbox')).toBe(
      true,
    );
  });
});

describe('idempotency over HTTP', () => {
  it('an identical retry with the same key returns the same story without duplicating it', async () => {
    const projectRes = await authedFetch('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'JUGAAD' }), idempotencyKey: nextIdemp() });
    const project = await projectRes.json();
    const key = nextIdemp();
    const body = JSON.stringify({ projectId: project.id, title: 'A', storyType: 'task' });

    const first = await authedFetch('/v1/stories', { method: 'POST', body, idempotencyKey: key });
    const second = await authedFetch('/v1/stories', { method: 'POST', body, idempotencyKey: key });
    const firstStory = await first.json();
    const secondStory = await second.json();
    expect(firstStory.id).toBe(secondStory.id);

    const listRes = await authedFetch(`/v1/stories?projectId=${project.id}`);
    expect((await listRes.json()).stories).toHaveLength(1);
  });

  it('rejects the same key reused with a different body', async () => {
    const projectRes = await authedFetch('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'JUGAAD' }), idempotencyKey: nextIdemp() });
    const project = await projectRes.json();
    const key = nextIdemp();
    await authedFetch('/v1/stories', { method: 'POST', body: JSON.stringify({ projectId: project.id, title: 'A', storyType: 'task' }), idempotencyKey: key });
    const res = await authedFetch('/v1/stories', { method: 'POST', body: JSON.stringify({ projectId: project.id, title: 'B', storyType: 'task' }), idempotencyKey: key });
    expect(res.status).toBe(409);
  });
});

// Messages can arrive the instant the connection opens (the server's "connected" ack races the
// client's own 'open' handler), so we must queue every message from socket creation onward rather
// than attaching a fresh 'message' listener only after the caller decides to wait for one.
const messageQueues = new WeakMap<WebSocket, Record<string, unknown>[]>();
const waiters = new WeakMap<WebSocket, Array<(msg: Record<string, unknown>) => void>>();

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    messageQueues.set(socket, []);
    waiters.set(socket, []);
    socket.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString());
      const pendingWaiters = waiters.get(socket)!;
      const waiter = pendingWaiters.shift();
      if (waiter) {
        waiter(parsed);
      } else {
        messageQueues.get(socket)!.push(parsed);
      }
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const queue = messageQueues.get(socket)!;
  if (queue.length > 0) {
    return Promise.resolve(queue.shift()!);
  }
  return new Promise((resolve) => {
    waiters.get(socket)!.push(resolve);
  });
}

describe('WebSocket event stream', () => {
  it('rejects a connection with a missing/invalid token', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        socket.once('open', () => resolve('opened'));
        socket.once('error', reject);
        socket.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      }),
    ).rejects.toThrow('401');
  });

  it('sends a connected ack with instanceId and latestSequence', async () => {
    const socket = await connectWs();
    const msg = await nextMessage(socket);
    expect(msg.type).toBe('connected');
    expect(msg.instanceId).toBe('test-instance');
    socket.close();
  });

  it('delivers a live event to a connected client when a story is created', async () => {
    const socket = await connectWs();
    await nextMessage(socket); // connected ack
    const nextEvent = nextMessage(socket);

    const projectRes = await authedFetch('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'JUGAAD' }), idempotencyKey: nextIdemp() });
    const project = await projectRes.json();
    await authedFetch('/v1/stories', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, title: 'A', storyType: 'task' }),
      idempotencyKey: nextIdemp(),
    });

    const msg = await nextEvent;
    expect(msg.type).toBe('event');
    expect((msg.event as { eventType: string }).eventType).toBe('story_created');
    socket.close();
  });

  it('delivers the same event to two simultaneously connected clients', async () => {
    const socketA = await connectWs();
    const socketB = await connectWs();
    await nextMessage(socketA);
    await nextMessage(socketB);
    const eventA = nextMessage(socketA);
    const eventB = nextMessage(socketB);

    const projectRes = await authedFetch('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'JUGAAD' }), idempotencyKey: nextIdemp() });
    const project = await projectRes.json();
    await authedFetch('/v1/stories', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, title: 'A', storyType: 'task' }),
      idempotencyKey: nextIdemp(),
    });

    const [msgA, msgB] = await Promise.all([eventA, eventB]);
    expect((msgA.event as { id: string }).id).toBe((msgB.event as { id: string }).id);
    socketA.close();
    socketB.close();
  });

  it('missed events can be replayed via GET /v1/events?after=', async () => {
    const before = latestSequence(db);
    const projectRes = await authedFetch('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'JUGAAD' }), idempotencyKey: nextIdemp() });
    const project = await projectRes.json();
    await authedFetch('/v1/stories', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, title: 'A', storyType: 'task' }),
      idempotencyKey: nextIdemp(),
    });
    const res = await authedFetch(`/v1/events?after=${before}`);
    const body = await res.json();
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    expect(body.events.every((e: { sequence: number }) => e.sequence > before)).toBe(true);
  });
});

describe('everyday tools API', () => {
  it('creates notes and reminders through Core HTTP', async () => {
    const noteRes = await authedFetch('/v1/everyday/notes', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ body: 'Remember that my printer uses A4' }),
    });
    expect(noteRes.status).toBe(201);
    const note = await noteRes.json();
    expect(note.body).toContain('A4');

    const findRes = await authedFetch('/v1/everyday/notes?query=printer');
    const found = await findRes.json();
    expect(found.notes.some((n: { id: string }) => n.id === note.id)).toBe(true);

    const dueAt = new Date(Date.now() + 120_000).toISOString();
    const remRes = await authedFetch('/v1/everyday/reminders', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ title: 'check the oven', dueAt, timezone: 'UTC' }),
    });
    expect(remRes.status).toBe(201);
    const reminder = await remRes.json();
    expect(reminder.title).toBe('check the oven');

    const listRes = await authedFetch('/v1/everyday/reminders?status=open');
    const list = await listRes.json();
    expect(list.reminders.some((r: { id: string }) => r.id === reminder.id)).toBe(true);
  });
});
