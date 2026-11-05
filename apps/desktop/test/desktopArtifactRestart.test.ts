/**
 * An artifact must still be retrievable and renderable after a genuine
 * restart of the Core AND of the desktop host.
 *
 * The earlier failure ("restart_artifacts_still_accessible") was observed in
 * the real desktop app: after a restart the workspace panel showed the
 * activity but no media. This test reproduces that shape deterministically:
 *
 *   1. a REAL Core process (the shipped bundle) is started on an isolated
 *      data directory,
 *   2. a REAL image file is registered through the REAL Core API and is
 *      verified by Core,
 *   3. the desktop host records the activity that references it,
 *   4. the Core is stopped and started again (a real restart, new instance),
 *   5. a NEW desktop host is created on the same data directory (a real
 *      restart of the host, which reloads its activity log from disk),
 *   6. the restored activity must still name the artifact, the preview must
 *      still be produced, and the bytes must verify.
 *
 * Nothing here is mocked: the Core is a child process, the artifact is a
 * file, and the bytes are checked by digest.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';
import { CoreClient } from '../../../src/core-client/CoreClient';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const token = 'artifact-restart-desktop-token';

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitForDiscovery(dataDir: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const recordPath = path.join(dataDir, 'core.json');
  while (Date.now() < deadline) {
    if (fs.existsSync(recordPath)) {
      try {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (record.port) return record as { port: number; pid: number; instanceId: string };
      } catch { /* partial write */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the Core never published its discovery record');
}

function startCore(dataDir: string): ChildProcess {
  const child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  children.push(child);
  return child;
}

async function stopCore(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/core/shutdown`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `shutdown-${Date.now()}`,
        'X-Client-Id': 'artifact-restart-test',
      },
      body: '{}',
    });
  } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 400));
}

function makeClient(baseUrl: string): CoreClient {
  return new CoreClient({ baseUrl, token, clientId: 'artifact-restart-test' });
}

/** A genuinely valid 1x1 PNG. */
function writePng(file: string): Buffer {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  fs.writeFileSync(file, bytes);
  return bytes;
}

beforeAll(() => {
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
});

afterEach(async () => {
  while (children.length) {
    const child = children.pop()!;
    if (!child.killed) child.kill();
  }
  await new Promise((r) => setTimeout(r, 100));
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

afterAll(() => {
  while (children.length) {
    const child = children.pop()!;
    if (!child.killed) child.kill();
  }
});

describe('artifact durability across a real Core and host restart', () => {
  it('keeps the artifact id, the preview and the bytes after both restarts', async () => {
    const dataDir = makeDir('jarvis-artifact-restart-data-');
    const mediaDir = makeDir('jarvis-artifact-restart-media-');
    const imagePath = path.join(mediaDir, 'lighthouse.png');
    const bytes = writePng(imagePath);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');

    // ---- 1. the real Core, first life ------------------------------------
    startCore(dataDir);
    const first = await waitForDiscovery(dataDir);
    const client = makeClient(`http://127.0.0.1:${first.port}`);

    const conversation = await client.request<{ id: string }>('/v1/conversations', {
      method: 'POST',
      body: { mode: 'baat_kar', title: 'Artifact restart' },
      headers: { 'Idempotency-Key': `conv-${Date.now()}` },
    });

    const artifact = await client.registerArtifact({
      conversationId: conversation.id,
      kind: 'image',
      title: 'Lighthouse at sunset',
      mimeType: 'image/png',
      absolutePath: imagePath,
      source: 'artifact-restart-test',
      metadata: { prompt: 'a lighthouse at sunset' },
    });
    expect(artifact.availability).toBe('ready');
    expect(artifact.sha256).toBe(digest);

    // ---- 2. the desktop host records the activity ------------------------
    const host = new DesktopSession({ productRoot: repoRoot, dataDir });
    const internals = host as unknown as {
      client: unknown;
      coreState: string;
      workspaceActivity: {
        begin(input: { id: string; conversationId: string | null; taskId: string | null; capability: string; title: string }): void;
        settle(id: string, state: 'completed' | 'failed' | 'cancelled', input?: { preview?: unknown; detail?: string | null }): void;
        list(conversationId: string): Array<{ id: string; state: string; preview: { artifactIds?: string[] } | null }>;
      };
    };
    internals.client = client;
    internals.coreState = 'connected';
    internals.workspaceActivity.begin({
      id: 'host-approval-1',
      conversationId: conversation.id,
      taskId: null,
      capability: 'image_generate',
      title: 'Generating an image: a lighthouse at sunset',
    });
    internals.workspaceActivity.settle('host-approval-1', 'completed', {
      preview: { kind: 'image', title: 'a lighthouse at sunset', artifactIds: [artifact.id] },
    });

    // ---- 3. restart the Core for real ------------------------------------
    await stopCore(first.port);
    startCore(dataDir);
    const second = await waitForDiscovery(dataDir);
    expect(second.instanceId).not.toBe(first.instanceId);

    // ---- 4. restart the host for real ------------------------------------
    const restarted = new DesktopSession({ productRoot: repoRoot, dataDir });
    const restartedInternals = restarted as unknown as {
      client: unknown;
      coreState: string;
      workspaceActivity: { list(conversationId: string): Array<{ id: string; state: string; preview: { artifactIds?: string[] } | null }> };
    };
    restartedInternals.client = makeClient(`http://127.0.0.1:${second.port}`);
    restartedInternals.coreState = 'connected';

    const restored = restartedInternals.workspaceActivity.list(conversation.id);
    expect(restored.length).toBe(1);
    expect(restored[0].state).toBe('completed');
    expect(restored[0].preview?.artifactIds).toContain(artifact.id);

    // ---- 5. the artifact is still retrievable and renderable -------------
    const after = await restartedInternals.client as CoreClient;
    const record = await after.getArtifact(artifact.id);
    expect(record.availability).toBe('ready');
    expect(record.sha256).toBe(digest);

    const preview = await restarted.loadArtifactPreview(artifact.id);
    expect(preview.dataUrl).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
    expect(preview.artifact.id).toBe(artifact.id);

    // The bytes on disk are the bytes the Core recorded.
    expect(crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex')).toBe(record.sha256);
  });
});
