import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RepositoryIndex } from '../../context/RepositoryIndex';

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function rootWithFiles(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m12-compiler-'));
  await write(root, 'src/model.ts', [
    "import { helper } from './helper';",
    "export { helper as renamedHelper } from './helper';",
    'export interface Shape { area(): number }',
    'export type Size = number;',
    'export class Box { method() { return helper(); } }',
    'export function build(): Shape { return new Box(); }',
    'export const exportedValue = 1;',
  ].join('\n'));
  await write(root, 'src/helper.js', "const path = require('path');\nexports.helper = function helper() { return path.sep; };\n");
  await write(root, 'src/model.test.ts', "import { build } from './model';\ntest('build', () => build());\n");
  await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest' } }, null, 2));
  await write(root, 'README.md', '# Project\n\nSome notes.\n');
  await write(root, 'src/native.py', 'import os\n\ndef run():\n    return os.getcwd()\n');
  await write(root, 'src/broken.ts', 'export function nope( {');
  return root;
}

describe('M12 compiler structural indexing and incremental lifecycle', () => {
  let roots: string[] = [];

  afterEach(async () => {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
    roots = [];
  });

  it('indexes TypeScript classes, interfaces, types, functions, methods, variables, imports, exports, ranges, and tests', async () => {
    const root = await rootWithFiles(); roots.push(root);
    const snapshot = await new RepositoryIndex(root).build(true);
    const model = snapshot.files.find(file => file.path === 'src/model.ts');
    expect(model?.parseStatus).toBe('structural');
    expect(model?.imports).toEqual(expect.arrayContaining(['./helper']));
    expect(model?.exports).toEqual(expect.arrayContaining(['renamedHelper', 'Shape', 'Size', 'Box', 'build', 'exportedValue']));
    expect(model?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Shape', kind: 'interface', line: 3, exported: true }),
      expect.objectContaining({ name: 'Size', kind: 'type', exported: true }),
      expect.objectContaining({ name: 'Box', kind: 'class', exported: true }),
      expect.objectContaining({ name: 'method', kind: 'method' }),
      expect.objectContaining({ name: 'build', kind: 'function', exported: true }),
      expect.objectContaining({ name: 'exportedValue', kind: 'constant', exported: true }),
    ]));
    expect(model?.dependencies).toContain('src/helper.js');
    expect(model?.linkedTests).toContain('src/model.test.ts');
  });

  it('parses JavaScript and classifies JSON configs, Markdown fallback, unsupported fallback, and parse-failure isolation', async () => {
    const root = await rootWithFiles(); roots.push(root);
    const snapshot = await new RepositoryIndex(root).build(true);
    const js = snapshot.files.find(file => file.path === 'src/helper.js');
    const config = snapshot.files.find(file => file.path === 'package.json');
    const markdown = snapshot.files.find(file => file.path === 'README.md');
    const unsupported = snapshot.files.find(file => file.path === 'src/native.py');
    const broken = snapshot.files.find(file => file.path === 'src/broken.ts');
    expect(js?.parseStatus).toBe('structural');
    expect(js?.imports).toContain('path');
    expect(config?.isConfig).toBe(true);
    expect(config?.language).toBe('json');
    expect(markdown?.language).toBe('markdown');
    expect(markdown?.parseStatus).toBe('lexical');
    expect(unsupported?.parseStatus).toBe('lexical');
    expect(broken?.parseStatus).toBe('structural');
    expect(snapshot.files.some(file => file.path === 'src/model.ts')).toBe(true);
  });

  it('reuses unchanged file identities across restart and one-file edit', async () => {
    const root = await rootWithFiles(); roots.push(root);
    const index = new RepositoryIndex(root);
    const first = await index.build(true);
    const restarted = await new RepositoryIndex(root).build(false);
    expect(restarted.updatedAt).toBe(first.updatedAt);

    const beforeModel = first.files.find(file => file.path === 'src/model.ts')?.indexedAt;
    const beforeHelper = first.files.find(file => file.path === 'src/helper.js')?.indexedAt;
    await write(root, 'src/model.ts', `${await fs.readFile(path.join(root, 'src/model.ts'), 'utf8')}\nexport const edited = true;\n`);
    const updated = await index.updateChangedFiles(['src/model.ts']);
    expect(updated.files.find(file => file.path === 'src/helper.js')?.indexedAt).toBe(beforeHelper);
    expect(updated.files.find(file => file.path === 'src/model.ts')?.indexedAt).not.toBe(beforeModel);
  });

  it('handles create, delete, rename, and ignore-rule changes', async () => {
    const root = await rootWithFiles(); roots.push(root);
    const index = new RepositoryIndex(root);
    await index.build(true);
    await write(root, 'src/new.ts', 'export const created = true;\n');
    expect((await index.updateChangedFiles(['src/new.ts'])).files.map(file => file.path)).toContain('src/new.ts');

    await fs.rename(path.join(root, 'src/new.ts'), path.join(root, 'src/renamed.ts'));
    const renamed = await index.updateChangedFiles(['src/new.ts', 'src/renamed.ts']);
    expect(renamed.files.find(file => file.path === 'src/new.ts')?.deleted).toBe(true);
    expect(renamed.files.find(file => file.path === 'src/renamed.ts')?.deleted).toBe(false);

    await write(root, '.gitignore', 'src/renamed.ts\n');
    const ignored = await index.updateChangedFiles(['.gitignore']);
    expect(ignored.files.find(file => file.path === 'src/renamed.ts')?.deleted).toBe(true);
  });

  it('reconciles stale external modification and preserves the committed snapshot on cancellation', async () => {
    const root = await rootWithFiles(); roots.push(root);
    const index = new RepositoryIndex(root);
    await index.build(true);
    await write(root, 'src/model.ts', 'export const externallyChanged = true;\n');
    const reconciled = await new RepositoryIndex(root).reconcileStartup();
    expect(reconciled.files.find(file => file.path === 'src/model.ts')?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'externallyChanged' }),
    ]));

    const controller = new AbortController();
    controller.abort();
    await expect(index.updateChangedFiles(['src/model.ts'], controller.signal)).rejects.toThrow(/indexing_cancelled/);
    const afterCancel = await new RepositoryIndex(root).build(false);
    expect(afterCancel.updatedAt).toBe(reconciled.updatedAt);
  });
});
