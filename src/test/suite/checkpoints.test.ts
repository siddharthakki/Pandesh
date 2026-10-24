import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CheckpointManager } from '../../agent/CheckpointManager';
import { FileService } from '../../services/FileService';

const BASE_META = {
  reason: 'test checkpoint',
  model: 'test-model',
  sessionId: 'sess_test',
  turnId: 'turn_1',
  toolName: 'write_file',
  iterationId: 'turn_1_iter0',
};

describe('CheckpointManager — restore operations', () => {
  let tmpDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));
    manager = new CheckpointManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('restores a modified file to its pre-mutation content', async () => {
    const filePath = path.join(tmpDir, 'main.ts');
    await fs.writeFile(filePath, 'original content', 'utf8');

    await manager.createCheckpoint([filePath], BASE_META);
    await fs.writeFile(filePath, 'mutated content', 'utf8');

    await manager.rewindLastCheckpoint();
    expect(await fs.readFile(filePath, 'utf8')).toBe('original content');
  });

  it('removes a newly created file on rollback (file did not exist before)', async () => {
    const filePath = path.join(tmpDir, 'new-file.ts');
    await manager.createCheckpoint([filePath], BASE_META);
    await fs.writeFile(filePath, 'new content', 'utf8');

    await manager.rewindLastCheckpoint();
    expect(await FileService.exists(filePath)).toBe(false);
  });

  it('restores a deleted file with its original content', async () => {
    const filePath = path.join(tmpDir, 'keep-me.ts');
    await fs.writeFile(filePath, 'keep this', 'utf8');

    await manager.createCheckpoint([filePath], { ...BASE_META, toolName: 'delete_file' });
    await fs.unlink(filePath);

    await manager.rewindLastCheckpoint();
    expect(await fs.readFile(filePath, 'utf8')).toBe('keep this');
  });

  it('restores sequentially across multiple checkpoints', async () => {
    const filePath = path.join(tmpDir, 'seq.ts');
    await fs.writeFile(filePath, 'content A', 'utf8');

    await manager.createCheckpoint([filePath], { ...BASE_META, turnId: 'turn_1' });
    await fs.writeFile(filePath, 'content B', 'utf8');

    await manager.createCheckpoint([filePath], { ...BASE_META, turnId: 'turn_2' });
    await fs.writeFile(filePath, 'content C', 'utf8');

    await manager.rewindLastCheckpoint();
    expect(await fs.readFile(filePath, 'utf8')).toBe('content B');

    await manager.rewindLastCheckpoint();
    expect(await fs.readFile(filePath, 'utf8')).toBe('content A');
  });

  it('rewindCheckpoint(id) restores a specific checkpoint by ID', async () => {
    const filePath = path.join(tmpDir, 'specific.ts');
    await fs.writeFile(filePath, 'version 1', 'utf8');

    const id = await manager.createCheckpoint([filePath], BASE_META);
    await fs.writeFile(filePath, 'version 2', 'utf8');

    expect(id).not.toBeNull();
    const result = await manager.rewindCheckpoint(id!);
    expect(result).not.toBeNull();
    expect(await fs.readFile(filePath, 'utf8')).toBe('version 1');
  });

  it('rewindCheckpoint returns null for an unknown ID', async () => {
    const result = await manager.rewindCheckpoint('cp_nonexistent_id');
    expect(result).toBeNull();
  });

  it('rewindIteration restores all checkpoints for a given iterationId', async () => {
    const file1 = path.join(tmpDir, 'a.ts');
    const file2 = path.join(tmpDir, 'b.ts');
    await fs.writeFile(file1, 'before a', 'utf8');
    await fs.writeFile(file2, 'before b', 'utf8');

    const iterMeta = { ...BASE_META, iterationId: 'sess_test_iter2' };
    await manager.createCheckpoint([file1], iterMeta);
    await fs.writeFile(file1, 'after a', 'utf8');

    await manager.createCheckpoint([file2], iterMeta);
    await fs.writeFile(file2, 'after b', 'utf8');

    const result = await manager.rewindIteration('sess_test_iter2');
    expect(result.count).toBe(2);
    expect(await fs.readFile(file1, 'utf8')).toBe('before a');
    expect(await fs.readFile(file2, 'utf8')).toBe('before b');
  });

  it('rewindIteration is a no-op for an unknown iterationId', async () => {
    const result = await manager.rewindIteration('does_not_exist');
    expect(result.count).toBe(0);
    expect(result.restored).toHaveLength(0);
  });

  it('rewindAll restores all checkpoints and requires { confirm: true }', async () => {
    const file1 = path.join(tmpDir, 'all1.ts');
    const file2 = path.join(tmpDir, 'all2.ts');
    await fs.writeFile(file1, 'original A', 'utf8');
    await fs.writeFile(file2, 'original B', 'utf8');

    await manager.createCheckpoint([file1], BASE_META);
    await fs.writeFile(file1, 'mutated A', 'utf8');

    await manager.createCheckpoint([file2], BASE_META);
    await fs.writeFile(file2, 'mutated B', 'utf8');

    const result = await manager.rewindAll({ confirm: true });
    expect(result.checkpointsRemoved).toBe(2);
    expect(await fs.readFile(file1, 'utf8')).toBe('original A');
    expect(await fs.readFile(file2, 'utf8')).toBe('original B');
  });

  it('handles corrupted meta.json — listCheckpoints skips bad entries', async () => {
    const filePath = path.join(tmpDir, 'valid.ts');
    await fs.writeFile(filePath, 'test', 'utf8');
    await manager.createCheckpoint([filePath], BASE_META);

    const corruptedDir = path.join(tmpDir, '.ollama-agent', 'checkpoints', 'cp_0000000_corrupt');
    await fs.mkdir(corruptedDir, { recursive: true });
    await fs.writeFile(path.join(corruptedDir, 'meta.json'), 'not-json', 'utf8');

    const list = await manager.listCheckpoints();
    expect(list.length).toBe(1);
  });

  it('listCheckpoints returns empty array when no checkpoints exist', async () => {
    const list = await manager.listCheckpoints();
    expect(list).toHaveLength(0);
  });

  it('rewindLastCheckpoint returns null when no checkpoints exist', async () => {
    const result = await manager.rewindLastCheckpoint();
    expect(result).toBeNull();
  });

  it('restores multiple files changed in a single action', async () => {
    const fileA = path.join(tmpDir, 'multi-a.ts');
    const fileB = path.join(tmpDir, 'multi-b.ts');
    await fs.writeFile(fileA, 'original A', 'utf8');
    await fs.writeFile(fileB, 'original B', 'utf8');

    await manager.createCheckpoint([fileA, fileB], { ...BASE_META, toolName: 'apply_patch' });
    await fs.writeFile(fileA, 'patched A', 'utf8');
    await fs.writeFile(fileB, 'patched B', 'utf8');

    const result = await manager.rewindLastCheckpoint();
    expect(result?.restored).toHaveLength(2);
    expect(await fs.readFile(fileA, 'utf8')).toBe('original A');
    expect(await fs.readFile(fileB, 'utf8')).toBe('original B');
  });

  it('rollback does not touch unrelated files (dirty-workspace preservation)', async () => {
    const checkpointedFile = path.join(tmpDir, 'checkpointed.ts');
    const unrelatedFile = path.join(tmpDir, 'unrelated.ts');
    await fs.writeFile(checkpointedFile, 'original', 'utf8');
    await fs.writeFile(unrelatedFile, 'user edit', 'utf8');

    await manager.createCheckpoint([checkpointedFile], BASE_META);
    await fs.writeFile(checkpointedFile, 'mutated', 'utf8');
    await fs.writeFile(unrelatedFile, 'user edit after mutation', 'utf8'); // user edits something else

    await manager.rewindLastCheckpoint();

    // Checkpointed file is restored, unrelated file is untouched
    expect(await fs.readFile(checkpointedFile, 'utf8')).toBe('original');
    expect(await fs.readFile(unrelatedFile, 'utf8')).toBe('user edit after mutation');
  });

  it('skips paths outside workspace during restore (traversal guard)', async () => {
    // Manually write a checkpoint meta that references a path outside the workspace
    const outsidePath = path.join(path.dirname(tmpDir), 'outside-workspace.txt');
    const cpId = 'cp_traversal_test';
    const cpDir = path.join(tmpDir, '.ollama-agent', 'checkpoints', cpId);
    await fs.mkdir(cpDir, { recursive: true });

    const meta = {
      id: cpId,
      timestamp: new Date().toISOString(),
      reason: 'traversal test',
      files: [{ path: outsidePath, existed: false, contentPath: '', sha256Before: '', operation: 'create' }],
      model: 'test',
      sessionId: 'sess',
      turnId: 'turn',
      toolName: 'write_file',
    };
    await fs.writeFile(path.join(cpDir, 'meta.json'), JSON.stringify(meta), 'utf8');

    const result = await manager.rewindCheckpoint(cpId);
    expect(result).not.toBeNull();
    expect(result!.restored).toHaveLength(0);
    expect(result!.skipped).toHaveLength(1);
    expect(result!.skipped[0]).toContain('traversal-blocked');
  });

  it('skips file with missing backup and records it as skipped', async () => {
    const filePath = path.join(tmpDir, 'missing-backup.ts');
    await fs.writeFile(filePath, 'original', 'utf8');

    const id = await manager.createCheckpoint([filePath], BASE_META);
    expect(id).not.toBeNull();

    // Corrupt the checkpoint: delete the content backup
    const cpDir = path.join(tmpDir, '.ollama-agent', 'checkpoints', id!);
    const cpDirEntries = await fs.readdir(cpDir);
    const backupEntry = cpDirEntries.find((e) => e !== 'meta.json' && e !== 'meta.json.tmp');
    if (backupEntry) {
      await fs.unlink(path.join(cpDir, backupEntry));
    }

    await fs.writeFile(filePath, 'mutated', 'utf8');

    const result = await manager.rewindCheckpoint(id!);
    expect(result).not.toBeNull();
    expect(result!.skipped).toHaveLength(1);
    expect(result!.skipped[0]).toContain('missing-backup');
    // File stays mutated since backup was missing
    expect(await fs.readFile(filePath, 'utf8')).toBe('mutated');
  });
});

describe('CheckpointManager — retention and pruning', () => {
  let tmpDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-prune-'));
    manager = new CheckpointManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('pruneOldCheckpoints removes checkpoints beyond maxCount', async () => {
    const file = path.join(tmpDir, 'prune.ts');
    await fs.writeFile(file, 'v0', 'utf8');
    // Create 3 checkpoints
    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(file, `v${i}`, 'utf8');
      await manager.createCheckpoint([file], { ...BASE_META, turnId: `turn_${i}` });
      await new Promise((r) => setTimeout(r, 5)); // ensure distinct timestamps
    }
    expect((await manager.listCheckpoints()).length).toBe(3);

    const removed = await manager.pruneOldCheckpoints(2);
    expect(removed).toBe(1);
    expect((await manager.listCheckpoints()).length).toBe(2);
  });

  it('pruneOldCheckpoints is a no-op when within maxCount', async () => {
    const file = path.join(tmpDir, 'no-prune.ts');
    await fs.writeFile(file, 'content', 'utf8');
    await manager.createCheckpoint([file], BASE_META);

    const removed = await manager.pruneOldCheckpoints(5);
    expect(removed).toBe(0);
    expect((await manager.listCheckpoints()).length).toBe(1);
  });

  it('pruneBySessionId removes all checkpoints for a completed session', async () => {
    const file = path.join(tmpDir, 'sess.ts');
    await fs.writeFile(file, 'content', 'utf8');

    await manager.createCheckpoint([file], { ...BASE_META, sessionId: 'sess_done', turnId: 'turn_1' });
    await manager.createCheckpoint([file], { ...BASE_META, sessionId: 'sess_done', turnId: 'turn_2' });
    await manager.createCheckpoint([file], { ...BASE_META, sessionId: 'sess_active', turnId: 'turn_1' });

    expect((await manager.listCheckpoints()).length).toBe(3);

    const removed = await manager.pruneBySessionId('sess_done');
    expect(removed).toBe(2);

    const remaining = await manager.listCheckpoints();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sessionId).toBe('sess_active');
  });
});

describe('CheckpointManager — operation type recording', () => {
  let tmpDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-ops-'));
    manager = new CheckpointManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('records operation=create for a new file via write_file', async () => {
    const filePath = path.join(tmpDir, 'new.ts');
    const id = await manager.createCheckpoint([filePath], { ...BASE_META, toolName: 'write_file' });
    const list = await manager.listCheckpoints();
    const cp = list.find((c) => c.id === id);
    expect(cp?.files[0].operation).toBe('create');
  });

  it('records operation=modify for an existing file via write_file', async () => {
    const filePath = path.join(tmpDir, 'exist.ts');
    await fs.writeFile(filePath, 'existing', 'utf8');
    const id = await manager.createCheckpoint([filePath], { ...BASE_META, toolName: 'write_file' });
    const list = await manager.listCheckpoints();
    const cp = list.find((c) => c.id === id);
    expect(cp?.files[0].operation).toBe('modify');
  });

  it('records operation=delete for delete_file tool', async () => {
    const filePath = path.join(tmpDir, 'del.ts');
    await fs.writeFile(filePath, 'bye', 'utf8');
    const id = await manager.createCheckpoint([filePath], { ...BASE_META, toolName: 'delete_file' });
    const list = await manager.listCheckpoints();
    const cp = list.find((c) => c.id === id);
    expect(cp?.files[0].operation).toBe('delete');
  });

  it('records operation=batch_patch for replace_in_file tool', async () => {
    const filePath = path.join(tmpDir, 'patch.ts');
    await fs.writeFile(filePath, 'content', 'utf8');
    const id = await manager.createCheckpoint([filePath], { ...BASE_META, toolName: 'replace_in_file' });
    const list = await manager.listCheckpoints();
    const cp = list.find((c) => c.id === id);
    expect(cp?.files[0].operation).toBe('batch_patch');
  });

  it('stores iterationId in checkpoint metadata', async () => {
    const filePath = path.join(tmpDir, 'iter.ts');
    await fs.writeFile(filePath, 'content', 'utf8');
    await manager.createCheckpoint([filePath], { ...BASE_META, iterationId: 'sess_test_iter7' });
    const list = await manager.listCheckpoints();
    expect(list[0].iterationId).toBe('sess_test_iter7');
  });
});

describe('CheckpointManager — atomicity', () => {
  let tmpDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-atomic-'));
    manager = new CheckpointManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('meta.json contains valid JSON after createCheckpoint', async () => {
    const filePath = path.join(tmpDir, 'atomic.ts');
    await fs.writeFile(filePath, 'content', 'utf8');
    const id = await manager.createCheckpoint([filePath], BASE_META);
    expect(id).toBeTruthy();

    const cpDir = path.join(tmpDir, '.ollama-agent', 'checkpoints', id!);
    const metaText = await fs.readFile(path.join(cpDir, 'meta.json'), 'utf8');
    const meta = JSON.parse(metaText);
    expect(meta.id).toBe(id);
    expect(meta.files).toHaveLength(1);
  });

  it('no .tmp file is left behind after createCheckpoint', async () => {
    const filePath = path.join(tmpDir, 'no-tmp.ts');
    await fs.writeFile(filePath, 'content', 'utf8');
    const id = await manager.createCheckpoint([filePath], BASE_META);
    const cpDir = path.join(tmpDir, '.ollama-agent', 'checkpoints', id!);
    const entries = await fs.readdir(cpDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});

describe('FileService — atomicWriteText', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes content and the file exists with the correct content', async () => {
    const filePath = path.join(tmpDir, 'out.json');
    await FileService.atomicWriteText(filePath, '{"ok":true}');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('{"ok":true}');
  });

  it('overwrites an existing file atomically', async () => {
    const filePath = path.join(tmpDir, 'overwrite.txt');
    await fs.writeFile(filePath, 'old', 'utf8');
    await FileService.atomicWriteText(filePath, 'new');
    expect(await fs.readFile(filePath, 'utf8')).toBe('new');
  });

  it('leaves no .tmp file after successful write', async () => {
    const filePath = path.join(tmpDir, 'clean.txt');
    await FileService.atomicWriteText(filePath, 'content');
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('creates parent directories if they do not exist', async () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt');
    await FileService.atomicWriteText(filePath, 'nested');
    expect(await fs.readFile(filePath, 'utf8')).toBe('nested');
  });
});
