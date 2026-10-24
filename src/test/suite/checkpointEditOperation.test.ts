import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CheckpointManager } from '../../agent/CheckpointManager';

const META = {
  reason: 'edit operation test',
  model: 'test-model',
  sessionId: 'session',
  turnId: 'turn',
  toolName: 'edit_file',
};

describe('edit_file checkpoint operation classification', () => {
  let root: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-edit-operation-'));
    manager = new CheckpointManager(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves a workspace-relative existing target and records modify', async () => {
    const relativeTarget = path.join('src', 'existing.ts');
    const absoluteTarget = path.join(root, relativeTarget);
    await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
    await fs.writeFile(absoluteTarget, 'original', 'utf8');

    await manager.createCheckpoint([relativeTarget], META);

    const checkpoints = await manager.listCheckpoints();
    expect(checkpoints[0].files[0].operation).toBe('modify');
    expect(path.normalize(checkpoints[0].files[0].path)).toBe(path.normalize(absoluteTarget));
  });

  it('resolves a workspace-relative missing target and records create', async () => {
    const relativeTarget = path.join('src', 'new.ts');
    const absoluteTarget = path.join(root, relativeTarget);

    await manager.createCheckpoint([relativeTarget], META);

    const checkpoints = await manager.listCheckpoints();
    expect(checkpoints[0].files[0].operation).toBe('create');
    expect(path.normalize(checkpoints[0].files[0].path)).toBe(path.normalize(absoluteTarget));
  });
});
