import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EditingEngine } from '../../editing/EditingEngine';
import { FileVersionTracker, hashText } from '../../editing/FileVersionTracker';
import { parseUnifiedPatch } from '../../editing/PatchParser';
import { extractFilePaths } from '../../tools/ToolExecutor';

const strong = { structuredOutput: true, tools: true, contextWindow: 32768 };
const weak = { structuredOutput: false, tools: true, contextWindow: 8192 };

describe('EditingEngine', () => {
  let root: string;
  let engine: EditingEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-editing-'));
    engine = new EditingEngine(root);
    FileVersionTracker.clear();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('applies exact patch context and attributes hunks', async () => {
    const file = path.join(root, 'a.ts');
    const original = 'const a = 1;\nconst b = 2;\n';
    await fs.writeFile(file, original, 'utf8');
    const result = await engine.apply({
      strategy: 'structured_patch',
      patch: [
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,2 +1,2 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
      ].join('\n'),
      expectedHash: hashText(original),
      attribution: { taskId: 'task-1', toolCallId: 'call-1' },
    }, strong);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toContain('const b = 3;');
    expect(result.hunks[0]).toMatchObject({ taskId: 'task-1', toolCallId: 'call-1' });
  });

  it('rejects stale source without changing the file', async () => {
    const file = path.join(root, 'stale.ts');
    await fs.writeFile(file, 'export const value = 2;\n', 'utf8');
    const result = await engine.apply({
      path: 'stale.ts',
      strategy: 'whole_file',
      content: 'export const value = 3;\n',
      expectedHash: hashText('export const value = 1;\n'),
    }, strong);

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].source).toBe('freshness');
    expect(await fs.readFile(file, 'utf8')).toBe('export const value = 2;\n');
  });

  it('validates every file before a multi-file patch writes anything', async () => {
    await fs.writeFile(path.join(root, 'one.txt'), 'one\n', 'utf8');
    await fs.writeFile(path.join(root, 'two.txt'), 'changed externally\n', 'utf8');
    const result = await engine.apply({
      strategy: 'structured_patch',
      patch: [
        '--- a/one.txt',
        '+++ b/one.txt',
        '@@ -1,1 +1,1 @@',
        '-one',
        '+ONE',
        '--- a/two.txt',
        '+++ b/two.txt',
        '@@ -1,1 +1,1 @@',
        '-two',
        '+TWO',
      ].join('\n'),
    }, strong);

    expect(result.ok).toBe(false);
    expect(await fs.readFile(path.join(root, 'one.txt'), 'utf8')).toBe('one\n');
    expect(await fs.readFile(path.join(root, 'two.txt'), 'utf8')).toBe('changed externally\n');
  });

  it('rejects overlapping hunks before applying', () => {
    expect(() => parseUnifiedPatch([
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '@@ -2,1 +2,1 @@',
      '-b',
      '+C',
    ].join('\n'))).toThrow(/overlapping/i);
  });

  it('rejects syntax-invalid JSON and preserves the original', async () => {
    const file = path.join(root, 'config.json');
    await fs.writeFile(file, '{"ok":true}\n', 'utf8');
    const result = await engine.apply({
      path: 'config.json',
      strategy: 'whole_file',
      content: '{"ok":',
    }, strong);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(item => item.source === 'syntax')).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('{"ok":true}\n');
  });

  it('uses JSON AST operations without rewriting invalid structure', async () => {
    const file = path.join(root, 'package.json');
    await fs.writeFile(file, '{\n  "scripts": {"test": "vitest"}\n}\n', 'utf8');
    const result = await engine.apply({
      path: 'package.json',
      strategy: 'json_ast',
      jsonOperations: [
        { op: 'set', path: '/scripts/compile', value: 'tsc -p ./' },
      ],
    }, strong);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(parsed.scripts.compile).toBe('tsc -p ./');
  });

  it('rejects ambiguous search/replace unless replaceAll is explicit', async () => {
    const file = path.join(root, 'repeat.txt');
    await fs.writeFile(file, 'x\nx\n', 'utf8');
    const rejected = await engine.apply({
      path: 'repeat.txt', strategy: 'search_replace', search: 'x', replace: 'y',
    }, strong);
    expect(rejected.ok).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('x\nx\n');

    const accepted = await engine.apply({
      path: 'repeat.txt', strategy: 'search_replace', search: 'x', replace: 'y', replaceAll: true,
    }, strong);
    expect(accepted.ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('y\ny\n');
  });

  it('falls back to a proposed diff for weak models editing a large existing file', async () => {
    const content = 'line\n'.repeat(7000);
    await fs.writeFile(path.join(root, 'large.txt'), content, 'utf8');
    const result = await engine.apply({ path: 'large.txt', content: `${content}end\n` }, weak);
    expect(result.ok).toBe(true);
    expect(result.preview).toBe(true);
    expect(result.strategy).toBe('proposed_diff');
    expect(result.fallbackUsed).toBe('proposed_diff');
    expect(await fs.readFile(path.join(root, 'large.txt'), 'utf8')).toBe(content);
  });

  it('extracts every patch target for checkpointing', () => {
    const patch = [
      '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-a', '+A',
      '--- a/b.ts', '+++ b/b.ts', '@@ -1,1 +1,1 @@', '-b', '+B',
    ].join('\n');
    expect(extractFilePaths('apply_patch', { patch })).toEqual(['a.ts', 'b.ts']);
  });
});
