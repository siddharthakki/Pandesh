import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreClient } from '../../core-client/CoreClient';
import { migrateLegacyBoardIfPresent } from '../../core-client/legacyMigration';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const TOKEN = 'legacy-migration-test-token';

beforeAll(() => {
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
});

let dataDir: string;
let workspaceRoot: string;
let child: ChildProcess;
let client: CoreClient;
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-legacymig-core-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-legacymig-ws-'));
  child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: TOKEN, KARKEDIKHA_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const record = await waitForDiscovery(dataDir);
  baseUrl = `http://127.0.0.1:${record.port}`;
  client = new CoreClient({ baseUrl, token: TOKEN, clientId: 'migration-test-client', clientVersion: '0.1.0' });
  await client.start();
});

afterEach(async () => {
  client.dispose();
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
  for (const dir of [dataDir, workspaceRoot]) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
});

async function writeLegacyBoard(stories: unknown[]): Promise<string> {
  const boardDir = path.join(workspaceRoot, '.ollama-agent', 'board');
  await fsp.mkdir(boardDir, { recursive: true });
  const filePath = path.join(boardDir, 'local-stories.json');
  await fsp.writeFile(filePath, JSON.stringify({ schemaVersion: 1, stories }, null, 2), 'utf8');
  return filePath;
}

describe('migrateLegacyBoardIfPresent (real Core, real legacy JSON fixture)', () => {
  it('does nothing when no legacy file exists', async () => {
    const result = await migrateLegacyBoardIfPresent(workspaceRoot, client);
    expect(result).toBeUndefined();
  });

  it('migrates valid legacy stories into a new "Imported" project and tolerates a malformed record', async () => {
    await writeLegacyBoard([
      {
        id: 'local-story-abc123',
        title: 'Add dark mode',
        goal: 'Let users toggle dark mode',
        acceptanceCriteria: ['Toggle exists', 'Preference persists'],
        constraints: [],
        validation: [],
        dependencies: [],
        estimatedPoints: 3,
        status: 'in_progress',
        source: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      { id: 'local-story-broken', /* no title */ acceptanceCriteria: [] },
    ]);

    const result = await migrateLegacyBoardIfPresent(workspaceRoot, client);
    expect(result).toBeDefined();
    expect(result!.recordsMigrated).toBe(1);
    expect(result!.recordsFailed).toBe(1);
    expect(result!.alreadyCompleted).toBe(false);

    const project = await client.request<{ name: string }>(`/v1/projects/${result!.projectId}`);
    expect(project.name).toBe('Imported');

    const stories = await client.request<{ stories: Array<{ id: string; status: string; title: string }> }>(
      `/v1/stories?projectId=${result!.projectId}`,
    );
    const migrated = stories.stories.find((s) => s.id === 'local-story-abc123');
    expect(migrated?.status).toBe('implementing'); // in_progress -> implementing per STATUS_MAP
    expect(migrated?.title).toBe('Add dark mode');
  });

  it('is idempotent: migrating the same unchanged file twice does not duplicate stories', async () => {
    await writeLegacyBoard([
      {
        id: 'local-story-dup',
        title: 'A',
        goal: 'g',
        acceptanceCriteria: ['x'],
        constraints: [],
        validation: [],
        dependencies: [],
        estimatedPoints: 3,
        status: 'backlog',
        source: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const first = await migrateLegacyBoardIfPresent(workspaceRoot, client);
    const second = await migrateLegacyBoardIfPresent(workspaceRoot, client);
    expect(first!.alreadyCompleted).toBe(false);
    expect(second!.alreadyCompleted).toBe(true);
    expect(second!.projectId).toBe(first!.projectId);

    const stories = await client.request<{ stories: unknown[] }>(`/v1/stories?projectId=${first!.projectId}`);
    expect(stories.stories).toHaveLength(1);
  });

  it('creates a durable backup of the legacy file that survives (never deletes the original)', async () => {
    const legacyPath = await writeLegacyBoard([
      { id: 'x1', title: 'A', goal: 'g', acceptanceCriteria: ['c'], constraints: [], validation: [], dependencies: [], estimatedPoints: 3, status: 'backlog', source: 'user', createdAt: 'x', updatedAt: 'x' },
    ]);
    await migrateLegacyBoardIfPresent(workspaceRoot, client);
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(`${legacyPath}.migration-backup`)).toBe(true);
  });
});
