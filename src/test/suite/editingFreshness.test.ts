import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EditingEngine } from '../../editing/EditingEngine';
import { FileVersionTracker, hashText } from '../../editing/FileVersionTracker';

const capabilities = { structuredOutput: true, tools: true, contextWindow: 32768 };

describe('editing freshness enforcement', () => {
  let root: string;
  let engine: EditingEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-edit-freshness-'));
    engine = new EditingEngine(root);
    FileVersionTracker.clear();
  });

  afterEach(async () => {
    FileVersionTracker.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses the latest observation from the same task when session attribution is omitted', async () => {
    const file = path.join(root, 'observed.ts');
    const original = 'export const value = 1;\n';
    await fs.writeFile(file, original, 'utf8');
    FileVersionTracker.record(file, original, {
      taskId: 'task-one',
      sessionId: 'session-one',
    });

    await fs.writeFile(file, 'export const value = 2;\n', 'utf8');
    const result = await engine.apply({
      path: 'observed.ts',
      strategy: 'whole_file',
      content: 'export const value = 3;\n',
      attribution: { taskId: 'task-one' },
    }, capabilities);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(item => item.source === 'freshness')).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('export const value = 2;\n');
  });

  it('enforces an expected hash independently for every multi-file patch target', async () => {
    const first = 'export const one = 1;\n';
    const second = 'export const two = 2;\n';
    await fs.writeFile(path.join(root, 'one.ts'), first, 'utf8');
    await fs.writeFile(path.join(root, 'two.ts'), second, 'utf8');

    const result = await engine.apply({
      strategy: 'structured_patch',
      patch: [
        '--- a/one.ts',
        '+++ b/one.ts',
        '@@ -1,1 +1,1 @@',
        '-export const one = 1;',
        '+export const one = 10;',
        '--- a/two.ts',
        '+++ b/two.ts',
        '@@ -1,1 +1,1 @@',
        '-export const two = 2;',
        '+export const two = 20;',
      ].join('\n'),
      expectedHashes: {
        'one.ts': hashText(first),
        'two.ts': hashText('stale content\n'),
      },
    }, capabilities);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stale source rejected for two\.ts/i);
    expect(await fs.readFile(path.join(root, 'one.ts'), 'utf8')).toBe(first);
    expect(await fs.readFile(path.join(root, 'two.ts'), 'utf8')).toBe(second);
  });
});
