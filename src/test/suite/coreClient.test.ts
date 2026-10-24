import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreClient } from '../../core-client/CoreClient';
import type { StoryEventRecord } from '../../../core/shared/wireTypes';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const TOKEN = 'coreclient-test-token';

beforeAll(() => {
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
});

let dataDir: string;
let child: ChildProcess;
let baseUrl: string;

async function waitForDiscovery(dir: string, timeoutMs = 8000): Promise<{ port: number }> {
  const discoveryPath = path.join(dir, 'core.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(discoveryPath)) {
      try {
        return JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      } catch {
        /* partial write race */
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('discovery record did not appear in time');
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-coreclient-test-'));
  child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: TOKEN, KARKEDIKHA_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const record = await waitForDiscovery(dataDir);
  baseUrl = `http://127.0.0.1:${record.port}`;
});

afterEach(async () => {
  try {
    await fetch(`${baseUrl}/v1/core/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'cleanup', 'X-Client-Id': 'test' },
      body: '{}',
    });
  } catch {
    /* best effort */
  }
  await new Promise((r) => setTimeout(r, 300));
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

describe('CoreClient (real HTTP + real WebSocket against a spawned Core)', () => {
  it('start() registers the client and fetches an initial (empty) board snapshot', async () => {
    const client = new CoreClient({ baseUrl, token: TOKEN, clientId: 'client-a', clientVersion: '0.1.0' });
    await client.start();
    const snapshot = await client.fetchBoardSnapshot();
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.stories).toEqual([]);
    client.dispose();
  });

  it('receives live story events pushed over the WebSocket after another client mutates', async () => {
    const events: StoryEventRecord[] = [];
    const client = new CoreClient({
      baseUrl,
      token: TOKEN,
      clientId: 'client-a',
      clientVersion: '0.1.0',
      onStoryEvent: (e) => events.push(e),
    });
    await client.start();

    // Wait for the WS 'connected' handshake to complete before mutating.
    await new Promise((r) => setTimeout(r, 300));

    const projectRes = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'p1', 'X-Client-Id': 'other-client' },
      body: JSON.stringify({ name: 'JUGAAD' }),
    });
    const project = await projectRes.json();
    await fetch(`${baseUrl}/v1/stories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': 's1', 'X-Client-Id': 'other-client' },
      body: JSON.stringify({ projectId: project.id, title: 'A', storyType: 'task' }),
    });

    const deadline = Date.now() + 4000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(events.some((e) => e.eventType === 'story_created')).toBe(true);
    client.dispose();
  }, 10000);

  it('rejects requests with the wrong token via CoreApiError', async () => {
    const client = new CoreClient({ baseUrl, token: 'wrong', clientId: 'client-a', clientVersion: '0.1.0' });
    await expect(client.fetchBoardSnapshot()).rejects.toThrow();
    client.dispose();
  });

  it('dispose() closes the client connection without affecting the Core process (still answers health)', async () => {
    const client = new CoreClient({ baseUrl, token: TOKEN, clientId: 'client-a', clientVersion: '0.1.0' });
    await client.start();
    client.dispose();
    const res = await fetch(`${baseUrl}/v1/health`);
    expect(res.status).toBe(200);
  });

  it('reads the workspace-scoped activation snapshot without creating a replacement request or attempt', async () => {
    const client = new CoreClient({ baseUrl, token: TOKEN, clientId: 'client-rehydrate', clientVersion: '0.1.0' });
    await client.start();
    const workspaceRoot = path.join(dataDir, 'workspace');
    const conversation = await client.createConversation({ mode: 'baat_kar' });
    const submitted = await client.submit({
      currentMessage: 'resume this exact turn',
      requestedMode: 'baat_kar',
      conversationId: conversation.id,
      workspaceRoot,
      hasWorkspace: true,
      gitCapable: true,
    });

    const first = await client.getWorkspaceAttemptRehydration(workspaceRoot);
    const second = await client.getWorkspaceAttemptRehydration(workspaceRoot);

    expect(first.attempts.map(item => item.attempt.id)).toEqual([submitted.attempt.id]);
    expect(second.attempts.map(item => item.request.id)).toEqual([submitted.request.id]);
    expect((await client.listAttempts({ activeOnly: true })).attempts).toHaveLength(1);
    client.dispose();
  });

  it('drives the M37 controller transport through Core-owned request, sprint, assignment, and restart-safe snapshot records', async () => {
    const client = new CoreClient({ baseUrl, token: TOKEN, clientId: 'm37-controller-client', clientVersion: '0.1.0' });
    await client.start();
    const project = await client.request<{ id: string }>('/v1/projects', { method: 'POST', body: { name: 'M37 controller project' } });
    const request = await client.createEngineeringProductRequest({
      projectId: project.id,
      title: 'Use Core as the engineering authority',
      goal: 'Dispatch exactly one governed Core attempt.',
      acceptanceCriteria: ['One Core assignment exists.'],
      definitionOfReady: ['Scope is explicit.'],
      definitionOfDone: ['Human merge is observed.'],
      estimatedPoints: 2,
    });
    const approved = await client.approveEngineeringProductRequest(request.id);
    const planned = await client.planEngineeringSprint({
      projectId: project.id,
      name: 'Core transport sprint',
      goal: 'Exercise the M37 transport.',
      capacityPoints: 2,
      wipLimit: 1,
      storyIds: [approved.storyId],
    });
    await client.startEngineeringSprint(planned.sprint.id);
    const assignment = await client.dispatchEngineeringSprint(planned.sprint.id, {
      workerIds: ['worker-b', 'worker-a'], leaseMs: 60_000, workspaceRoot: dataDir,
      selectedProvider: 'ollama', selectedModel: 'test-coder',
    });
    expect(assignment).toMatchObject({ storyId: approved.storyId, workerId: 'worker-a' });

    const first = await client.engineeringSnapshot(project.id);
    const second = await client.engineeringSnapshot(project.id);
    expect(first.requests).toHaveLength(1);
    expect(second.assignments.map(item => item.attemptId)).toEqual([assignment!.attemptId]);
    client.dispose();
  });
});
