import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadM19WorkforceConfig } from '../../workforce/M19WorkforceConfig';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function writeConfig(payload: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm19-workforce-'));
  roots.push(root);
  const directory = path.join(root, '.ollama-agent');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'workforce.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return root;
}

const model = {
  model: 'review-model',
  provider: 'remote',
  inputCostPerMillion: 1,
  outputCostPerMillion: 2,
  maxContextTokens: 32000,
};

describe('M19 workforce configuration', () => {
  it('loads external read-only analyst and reviewer workers', async () => {
    const root = await writeConfig({
      workers: [{
        id: 'claude-reviewer',
        adapter: 'claude',
        roles: ['analyst', 'reviewer'],
        capabilities: ['repository-analysis', 'review'],
        permissions: ['repository:read', 'validation:run', 'github:read'],
        models: [model],
        maxConcurrent: 1,
        heartbeatTimeoutMs: 60000,
      }],
    });

    const loaded = await loadM19WorkforceConfig(root);
    expect(loaded.configured).toBe(true);
    expect(loaded.workers).toEqual([
      expect.objectContaining({
        id: 'claude-reviewer',
        adapter: 'claude',
        roles: ['analyst', 'reviewer'],
        permissions: ['repository:read', 'validation:run', 'github:read'],
      }),
    ]);
  });

  it('rejects external implementer and repair roles', async () => {
    const root = await writeConfig({
      workers: [{
        id: 'codex-implementer',
        adapter: 'codex',
        roles: ['implementer'],
        capabilities: ['coding'],
        permissions: ['repository:read', 'validation:run'],
        models: [model],
      }],
    });

    await expect(loadM19WorkforceConfig(root)).rejects.toThrow(
      'repository implementation and repair must run through KarkeDikha',
    );
  });

  it('rejects mutating permissions on external adapters', async () => {
    const root = await writeConfig({
      workers: [{
        id: 'opencode-reviewer',
        adapter: 'opencode',
        roles: ['reviewer'],
        capabilities: ['review'],
        permissions: ['repository:read', 'worktree:write'],
        models: [model],
      }],
    });

    await expect(loadM19WorkforceConfig(root)).rejects.toThrow(
      'repository mutation and draft-PR delivery remain KarkeDikha-governed',
    );
  });

  it('allows a configured KarkeDikha implementation worker', async () => {
    const root = await writeConfig({
      workers: [{
        id: 'karkedikha-local',
        adapter: 'karkedikha',
        roles: ['implementer', 'repairer'],
        capabilities: ['coding', 'ci-repair'],
        permissions: ['repository:read', 'worktree:write', 'validation:run', 'github:draft-pr'],
        models: [{ ...model, provider: 'ollama', inputCostPerMillion: 0, outputCostPerMillion: 0 }],
      }],
    });

    const loaded = await loadM19WorkforceConfig(root);
    expect(loaded.workers[0]).toMatchObject({
      adapter: 'karkedikha',
      roles: ['implementer', 'repairer'],
    });
  });
});
