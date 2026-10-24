import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFile, extractLexical, languageOf, roleOf } from '../platform/repo/extractors';
import { RepositoryGraph, testStem } from '../platform/repo/repositoryGraph';
import { LocalFilesystemWorkspaceHost } from '../platform/repo/workspaceHost';
import { RepositoryGraphIndexer } from '../platform/repo/graphIndexer';
import { JsonlGraphStore } from '../platform/repo/graphStore';
import { RepositoryContextEngine } from '../platform/repo/evidence';

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

const REPO: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'demo-app', main: 'src/index.ts', dependencies: { lodash: '1' } }),
  'src/index.ts': `import { Server } from './server';\nimport { loadConfig } from './config/loader';\nimport { Logger } from './util/logger.js';\nexport function main() {\n  const server = new Server(loadConfig(), new Logger());\n  return server.start();\n}\n`,
  'src/server.ts': `import { Handler } from './handlers/handler';\nexport interface Startable { start(): void }\nexport class Server extends Handler implements Startable {\n  start() { return 1; }\n}\nexport const DEFAULT_PORT = 8080;\n`,
  'src/handlers/handler.ts': `export abstract class Handler {\n  abstract start(): void;\n}\n`,
  'src/config/loader.ts': `export function loadConfig() { return { port: 1 }; }\n`,
  'src/util/logger.ts': `export class Logger { log(m: string) { console.log(m); } }\n`,
  'src/server.test.ts': `import { Server } from './server';\ntest('starts', () => { expect(new Server().start()).toBe(1); });\n`,
  'tests/loader_spec.ts': `import { loadConfig } from '../src/config/loader';\n`,
  'README.md': '# Demo\n',
  'py/app/__init__.py': '',
  'py/app/models.py': `class Base:\n    pass\n\nclass User(Base):\n    pass\n\nMAX_USERS = 10\n`,
  'py/app/service.py': `from .models import User\nfrom app import models\nimport os.path\n\ndef make_user():\n    return User()\n`,
  'py/tests/test_service.py': `from app.service import make_user\n`,
};

describe('lexical extractors', () => {
  it('TypeScript: imports (incl. .js specifiers, re-exports, require, dynamic), declarations, inheritance, exports', () => {
    const e = extractLexical('a.ts', `import a, { b as c, type D } from './x';\nimport * as ns from "../y.js";\nimport './side';\nexport * from './re';\nconst r = require('./cjs');\nconst d = import('./lazy');\nexport default class Foo<T> extends Base implements IOne, ITwo {\n}\nexport interface Bar extends Baz {}\nexport type Id = string;\nexport enum Color { Red }\nexport const LIMIT: number = 5;\nconst INTERNAL_FLAG = 1;\nfunction helper() {}\n`);
    expect(e.imports.map(i => i.spec)).toEqual(expect.arrayContaining(['./x', '../y.js', './side', './re', './cjs', './lazy']));
    expect(e.imports.find(i => i.spec === './x')!.names).toEqual(['default', 'b', 'D']);
    const byName = Object.fromEntries(e.symbols.map(s => [s.name, s]));
    expect(byName.Foo).toMatchObject({ kind: 'class', exported: true, extends: ['Base'], implements: ['IOne', 'ITwo'] });
    expect(byName.Bar).toMatchObject({ kind: 'interface', extends: ['Baz'] });
    expect(byName.Id.kind).toBe('type');
    expect(byName.Color.kind).toBe('enum');
    expect(byName.LIMIT.exported).toBe(true);
    expect(byName.INTERNAL_FLAG).toMatchObject({ exported: false });
    expect(byName.helper).toMatchObject({ kind: 'function', exported: false });
    expect(e.exports).toEqual(expect.arrayContaining(['Foo', 'Bar', 'Id', 'Color', 'LIMIT', 'default']));
    expect(e.provenance).toBe('lexical');
    expect(e.imports.every(i => i.confidence > 0 && i.confidence < 1)).toBe(true);
  });

  it('Python, Java, Go, Rust, C: imports and declarations', () => {
    const py = extractLexical('m.py', 'from .a import (x,\n  y)\nimport os.path, sys\nclass A(B, C):\n  pass\ndef _private():\n  pass\nasync def go():\n  pass\n');
    expect(py.imports.map(i => i.spec)).toEqual(['.a', 'os.path', 'sys']);
    expect(py.symbols.map(s => s.name)).toEqual(expect.arrayContaining(['A', '_private', 'go']));
    expect(py.exports).toEqual(expect.arrayContaining(['A', 'go']));
    expect(py.exports).not.toContain('_private');
    const java = extractLexical('A.java', 'package p;\nimport java.util.List;\nimport static x.Y.z;\npublic abstract class A extends B implements C, D {\n}\ninterface I {}\n');
    expect(java.imports.map(i => i.spec)).toEqual(['java.util.List', 'x.Y.z']);
    expect(java.symbols.find(s => s.name === 'A')).toMatchObject({ extends: ['B'], implements: ['C', 'D'] });
    const go = extractLexical('m.go', 'package m\nimport (\n  "fmt"\n  s "github.com/x/y/store"\n)\nfunc Run() {}\nfunc (r *R) Do() {}\ntype R struct {}\ntype S interface {}\n');
    expect(go.imports.map(i => i.spec)).toEqual(['fmt', 'github.com/x/y/store']);
    expect(go.symbols.map(s => s.name)).toEqual(expect.arrayContaining(['Run', 'Do', 'R', 'S']));
    const rs = extractLexical('lib.rs', 'use crate::a::b;\npub mod c;\npub fn run() {}\nstruct T;\nimpl Display for T {}\n');
    expect(rs.imports.map(i => i.spec)).toEqual(['crate::a::b', 'self::c']);
    expect(rs.symbols.find(s => s.name === 'T')!.implements).toEqual(['Display']);
    const c = extractLexical('x.cpp', '#include "a.h"\n#include <vector>\nclass W : public V {\n};\n');
    expect(c.imports.map(i => i.spec)).toEqual(['a.h', 'vector']);
    expect(c.symbols[0]).toMatchObject({ name: 'W', extends: ['V'] });
  });

  it('classifies roles and languages, and a host extractor outranks the lexical one', () => {
    expect(roleOf('src/a.test.ts')).toBe('test');
    expect(roleOf('pkg/test_x.py')).toBe('test');
    expect(roleOf('src/FooTest.java')).toBe('test');
    expect(roleOf('package.json')).toBe('manifest');
    expect(roleOf('dist/a.js')).toBe('generated');
    expect(roleOf('README.md')).toBe('doc');
    expect(languageOf('x.mts')).toBe('typescript');
    const merged = extractFile('a.ts', 'export const x = 1;', () => ({ symbols: [{ name: 'fromAst', kind: 'function', line: 1, exported: true }], provenance: 'ast' }));
    expect(merged.provenance).toBe('ast');
    expect(merged.symbols.map(s => s.name)).toEqual(['fromAst']);
    expect(testStem('src/Foo.test.ts')).toBe('foo');
    expect(testStem('tests/test_foo.py')).toBe('foo');
    expect(testStem('FooTest.java')).toBe('foo');
    expect(testStem('foo_test.go')).toBe('foo');
  });

  it('is bounded: a pathological file cannot produce unbounded symbols', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `export const A${i} = ${i};`).join('\n');
    expect(extractFile('big.ts', text).symbols.length).toBeLessThanOrEqual(300);
  });
});

describe('RepositoryGraph', () => {
  const graphOf = (files: Record<string, string>) => {
    const g = new RepositoryGraph();
    for (const p of Object.keys(files)) g.addPath(p);
    for (const [p, text] of Object.entries(files)) g.upsert(p, { size: text.length, mtimeMs: 1, text });
    return g;
  };

  it('resolves relative imports (extension-less, .js→.ts, index files) with provenance and confidence', () => {
    const g = graphOf({
      'src/index.ts': "import { A } from './a';\nimport { B } from './b.js';\nimport { C } from './dir';\nimport x from 'external-lib';\n",
      'src/a.ts': 'export const A = 1;', 'src/b.ts': 'export const B = 1;', 'src/dir/index.ts': 'export const C = 1;',
    });
    const edges = g.importsOf('src/index.ts');
    expect(edges.map(e => e.to).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/dir/index.ts']);
    expect(edges.every(e => e.provenance === 'lexical' && e.confidence > 0.5 && e.confidence < 1 && e.kind === 'imports')).toBe(true);
    expect(g.fanIn('src/a.ts')).toBe(1);
    expect(g.importersOf('src/a.ts')[0]).toMatchObject({ from: 'src/index.ts', kind: 'imported_by', via: './a' });
  });

  it('resolves late: an import to a file that appears later is linked when the file is added, and unlinked when removed', () => {
    const g = new RepositoryGraph();
    g.addPath('src/main.ts');
    g.upsert('src/main.ts', { size: 1, mtimeMs: 1, text: "import { Z } from './later';" });
    expect(g.importsOf('src/main.ts')).toEqual([]);
    g.addPath('src/later.ts');
    expect(g.importsOf('src/main.ts').map(e => e.to)).toEqual(['src/later.ts']);
    g.remove('src/later.ts');
    expect(g.importsOf('src/main.ts')).toEqual([]);
    g.addPath('src/later.ts');
    expect(g.importsOf('src/main.ts').map(e => e.to)).toEqual(['src/later.ts']);
  });

  it('finds definitions ranked exported-source first, subtypes, and tests by import and by naming convention', () => {
    const g = graphOf({
      'src/handlers/handler.ts': 'export abstract class Handler {}',
      'src/server.ts': "import { Handler } from './handlers/handler';\nexport class Server extends Handler implements Startable {}\n",
      'src/server.test.ts': "import { Server } from './server';\n",
      'tests/handler.spec.ts': 'describe("x", () => {});\n',
      'src/other.ts': 'class Handler {}\n',
    });
    const defs = g.definitions('Handler');
    expect(defs[0].path).toBe('src/handlers/handler.ts');
    expect(defs.map(d => d.path)).toContain('src/other.ts');
    expect(g.subtypesOf('Handler')).toEqual([{ path: 'src/server.ts', symbol: expect.objectContaining({ name: 'Server' }), relation: 'extends' }]);
    expect(g.subtypesOf('Startable')[0].relation).toBe('implements');
    const serverTests = g.testsFor('src/server.ts');
    expect(serverTests[0]).toMatchObject({ from: 'src/server.test.ts', provenance: 'lexical', confidence: 0.9 });
    const handlerTests = g.testsFor('src/handlers/handler.ts');
    expect(handlerTests[0]).toMatchObject({ from: 'tests/handler.spec.ts', provenance: 'convention', confidence: 0.7 });
    expect(g.subjectsOf('src/server.test.ts').map(e => e.to)).toContain('src/server.ts');
  });

  it('python relative and absolute imports resolve; packages scope files; entry points and ranking use centrality', () => {
    const g = new RepositoryGraph();
    g.setPackages([{ dir: '', manifest: 'package.json', kind: 'npm', name: 'demo-app', main: 'src/index.ts' }, { dir: 'py', manifest: 'py/pyproject.toml', kind: 'python' }]);
    for (const [p, text] of Object.entries(REPO)) g.addPath(p);
    for (const [p, text] of Object.entries(REPO)) g.upsert(p, { size: text.length, mtimeMs: 1, text });
    expect(g.importsOf('py/app/service.py').map(e => e.to)).toEqual(expect.arrayContaining(['py/app/models.py']));
    expect(g.get('py/app/service.py')!.pkg).toBe('py');
    expect(g.get('src/index.ts')!.pkg).toBe('');
    expect(g.entryPoints(3)[0].path).toBe('src/index.ts');
    const ranked = g.rankFiles(['server']);
    expect(ranked[0].path).toBe('src/server.ts');
    expect(ranked.map(r => r.path)).toContain('src/server.test.ts');
    expect(ranked.findIndex(r => r.path === 'src/server.ts')).toBeLessThan(ranked.findIndex(r => r.path === 'src/server.test.ts'));
    expect(g.stats()).toMatchObject({ packages: 2 });
  });

  it('workspace package imports resolve through the package map', () => {
    const g = new RepositoryGraph();
    g.setPackages([{ dir: 'packages/core', manifest: 'packages/core/package.json', kind: 'npm', name: '@acme/core', main: 'src/index.ts' }]);
    for (const p of ['apps/web/main.ts', 'packages/core/src/index.ts', 'packages/core/src/util.ts']) g.addPath(p);
    g.upsert('apps/web/main.ts', { size: 1, mtimeMs: 1, text: "import { a } from '@acme/core';\nimport { u } from '@acme/core/util';" });
    expect(g.importsOf('apps/web/main.ts').map(e => e.to).sort()).toEqual(['packages/core/src/index.ts', 'packages/core/src/util.ts']);
  });

  it('upserting again replaces symbols and edges (incremental correctness)', () => {
    const g = new RepositoryGraph();
    for (const p of ['a.ts', 'b.ts', 'c.ts']) g.addPath(p);
    g.upsert('a.ts', { size: 1, mtimeMs: 1, text: "import './b';\nexport class Old {}" });
    expect(g.definitions('Old')).toHaveLength(1);
    expect(g.fanIn('b.ts')).toBe(1);
    g.upsert('a.ts', { size: 2, mtimeMs: 2, text: "import './c';\nexport class New {}" });
    expect(g.definitions('Old')).toHaveLength(0);
    expect(g.definitions('New')).toHaveLength(1);
    expect(g.fanIn('b.ts')).toBe(0);
    expect(g.fanIn('c.ts')).toBe(1);
    expect(g.stats().symbols).toBe(1);
  });
});

describe('token index stays correct incrementally', () => {
  it('ranking follows upserts, removals and camelCase tokens; ubiquitous tokens fall back to a bounded scan', () => {
    const g = new RepositoryGraph();
    g.addPath('src/auth/loginService.ts');
    g.upsert('src/auth/loginService.ts', { size: 1, mtimeMs: 1, text: 'export class SessionManager {}\nexport function refreshToken() {}' });
    expect(g.rankFiles(['login'])[0].path).toBe('src/auth/loginService.ts');
    expect(g.rankFiles(['session'])[0].reasons.join()).toMatch(/class SessionManager/);
    expect(g.rankFiles(['refresh'])[0].path).toBe('src/auth/loginService.ts');
    g.upsert('src/auth/loginService.ts', { size: 2, mtimeMs: 2, text: 'export class Other {}' });
    expect(g.rankFiles(['session'])).toEqual([]);
    expect(g.rankFiles(['other'])[0].path).toBe('src/auth/loginService.ts');
    g.remove('src/auth/loginService.ts');
    expect(g.rankFiles(['login'])).toEqual([]);
    expect(g.rankFiles(['other'])).toEqual([]);
    // "src" is shared by thousands of files: not indexed, still answerable via the bounded fallback.
    for (let i = 0; i < 4100; i++) g.addPath(`src/gen/f${i}.ts`);
    g.addPath('src/special/zebra.ts');
    expect(g.rankFiles(['src/special'])[0].path).toBe('src/special/zebra.ts');
    expect(g.rankFiles(['x'])).toEqual([]);
  });
});

describe('LocalFilesystemWorkspaceHost', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-host-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('lists, stats, reads ranges, hashes and searches without git; refuses escapes and binaries', async () => {
    await write(root, { 'a/x.ts': 'line1\nline2\nneedle here\nline4\n', 'node_modules/p/i.js': 'needle', '.git/config': 'x', 'b.txt': 'needle too' });
    await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    const host = new LocalFilesystemWorkspaceHost(root);
    expect((await host.identity()).vcs).toBe('none');
    const paths = (await host.listPaths()).sort();
    expect(paths).toEqual(['a/x.ts', 'b.txt', 'bin.dat']);
    expect((await host.stat('a/x.ts'))!.size).toBeGreaterThan(0);
    expect((await host.readFile('a/x.ts', { startLine: 2, endLine: 3 }))!.text).toBe('line2\nneedle here');
    expect(await host.readFile('../outside.txt')).toBeUndefined();
    expect(await host.readFile('bin.dat')).toBeUndefined();
    expect((await host.fileHash('b.txt'))).toMatch(/^[0-9a-f]{40}$/);
    const hits = await host.search('needle');
    expect(hits.map(h => h.path).sort()).toEqual(['a/x.ts', 'b.txt']);
    expect(hits.find(h => h.path === 'a/x.ts')!.line).toBe(3);
  });

  it('uses git for listing (honouring .gitignore), search and state', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    await write(root, { '.gitignore': 'secret/\n', 'src/a.ts': 'export const needle = 1;\n', 'secret/k.ts': 'needle', 'src/b.ts': 'x' });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    await fs.writeFile(path.join(root, 'src/a.ts'), 'export const needle = 2;\n');
    await fs.writeFile(path.join(root, 'src/new.ts'), 'n');
    const host = new LocalFilesystemWorkspaceHost(root);
    const identity = await host.identity();
    expect(identity.vcs).toBe('git');
    expect(identity.head).toMatch(/^[0-9a-f]{40}$/);
    expect((await host.listPaths()).sort()).toEqual(['.gitignore', 'src/a.ts', 'src/b.ts', 'src/new.ts']);
    expect((await host.search('needle', { wholeWord: true })).map(h => h.path)).toEqual(['src/a.ts']);
    const state = await host.gitState();
    expect(state.changed).toEqual(['src/a.ts']);
    expect(state.untracked).toEqual(['src/new.ts']);
  });
});

describe('RepositoryGraphIndexer: progressive, incremental, persistent', () => {
  let root: string;
  let store: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-idx-'));
    store = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-store-'));
    await write(root, REPO);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(store, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('is usable at discovery (paths known before any file is parsed) and reaches ready with full coverage', async () => {
    const phases: string[] = [];
    const seenFractions: number[] = [];
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root), {
      concurrency: 1, sliceMs: 0, onProgress: c => { phases.push(c.phase); seenFractions.push(c.fraction); },
    });
    const started = indexer.start();
    // Synchronously after start() the run is in flight but nothing has been awaited: the contract is "usable early".
    await new Promise(resolve => setImmediate(resolve));
    await started;
    expect(indexer.timings.firstUsableMs).toBeDefined();
    expect(phases[0]).toBe('discovering');
    expect(indexer.coverage()).toMatchObject({ phase: 'ready', fraction: 1, truncated: false });
    expect(indexer.coverage().eligible).toBe(11);
    expect(indexer.graph.importsOf('src/index.ts').map(e => e.to).sort()).toEqual(['src/config/loader.ts', 'src/server.ts', 'src/util/logger.ts']);
    expect(indexer.graph.packageList().find(p => p.name === 'demo-app')).toBeDefined();
    expect(indexer.graph.get('README.md')!.indexed).toBe(false); // docs are known by path, not parsed
  });

  it('persists a snapshot and restarts incrementally: unchanged files are not re-parsed, changed ones are, deleted ones vanish', async () => {
    const first = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root), { store: new JsonlGraphStore(store) });
    await first.start();
    expect(first.timings.parsed).toBe(12); // 11 code files + the package.json manifest

    await fs.writeFile(path.join(root, 'src/config/loader.ts'), 'export function loadConfig() { return {}; }\nexport function reload() {}\n');
    await fs.rm(path.join(root, 'src/util/logger.ts'));
    await write(root, { 'src/extra.ts': 'export const EXTRA = 1;\n' });

    const second = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root), { store: new JsonlGraphStore(store) });
    await second.start();
    expect(second.timings.restored).toBe(12);
    expect(second.timings.parsed).toBe(2); // loader.ts (changed) + extra.ts (new)
    expect(second.timings.skippedUnchanged).toBe(10);
    expect(second.graph.has('src/util/logger.ts')).toBe(false);
    expect(second.graph.definitions('reload')).toHaveLength(1);
    expect(second.graph.definitions('EXTRA')).toHaveLength(1);
    expect(second.graph.importsOf('src/index.ts').map(e => e.to)).not.toContain('src/util/logger.ts');
    expect(second.graph.stats().symbols).toBeGreaterThan(5);
  });

  it('a damaged or foreign snapshot is ignored, never trusted', async () => {
    const jsonl = new JsonlGraphStore(store);
    const first = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root), { store: jsonl });
    await first.start();
    const id = (await new LocalFilesystemWorkspaceHost(root).identity()).id;
    await fs.writeFile(path.join(store, id, 'meta.json'), '{"schema":99}');
    const again = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root), { store: new JsonlGraphStore(store) });
    await again.start();
    expect(again.timings.restored).toBe(0);
    expect(again.timings.parsed).toBe(12);
    // A truncated data line only loses that file.
    await again.start();
    const data = path.join(store, id, 'files.jsonl');
    const lines = (await fs.readFile(data, 'utf8')).split('\n');
    lines[1] = lines[1].slice(0, 10);
    await fs.writeFile(data, lines.join('\n'));
    await fs.writeFile(path.join(store, id, 'meta.json'), JSON.stringify({ schema: 1, identityId: id, savedAt: '', files: 12, indexedFiles: 12 }));
    const third = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root), { store: new JsonlGraphStore(store) });
    await third.start();
    expect(third.timings.restored).toBe(11);
    expect(third.timings.parsed).toBe(1);
  });

  it('respects the disk bound without losing the in-memory graph', async () => {
    const tiny = new JsonlGraphStore(store, 200);
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root), { store: tiny });
    await indexer.start();
    expect(indexer.coverage().phase).toBe('ready');
    const id = (await new LocalFilesystemWorkspaceHost(root).identity()).id;
    await expect(fs.stat(path.join(store, id, 'files.jsonl'))).rejects.toThrow();
  });

  it('bounds memory with maxFiles and says so', async () => {
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root), { maxFiles: 5 });
    await indexer.start();
    expect(indexer.graph.fileCount()).toBe(5);
    expect(indexer.coverage().truncated).toBe(true);
    expect(indexer.graph.has('package.json')).toBe(true); // manifests and shallow source are kept first
  });

  it('updatePaths re-reads only what changed', async () => {
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root));
    await indexer.start();
    const parsed = indexer.timings.parsed;
    expect(await indexer.updatePaths(['src/server.ts', 'src/handlers/handler.ts'])).toEqual({ updated: 0, removed: 0 });
    await new Promise(resolve => setTimeout(resolve, 15));
    await fs.writeFile(path.join(root, 'src/server.ts'), "import { Handler } from './handlers/handler';\nexport class Server2 extends Handler {}\n");
    await fs.rm(path.join(root, 'src/config/loader.ts'));
    expect(await indexer.updatePaths(['src/server.ts', 'src/config/loader.ts'])).toEqual({ updated: 1, removed: 1 });
    expect(indexer.timings.parsed).toBe(parsed + 1);
    expect(indexer.graph.definitions('Server2')).toHaveLength(1);
    expect(indexer.graph.definitions('Server')).toHaveLength(0);
    expect(indexer.graph.importsOf('src/index.ts').map(e => e.to)).not.toContain('src/config/loader.ts');
  });
});

describe('tsconfig baseUrl / paths (including extends) drive bare-import resolution', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-tsc-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('resolves @alias/* and baseUrl-relative imports, with comments and trailing commas in the config', async () => {
    await write(root, {
      'tsconfig.base.json': '{\n  // shared\n  "compilerOptions": { "baseUrl": "src", "paths": { "@lib/*": ["lib/*"], "@root": ["index.ts"], }, },\n}\n',
      'app/tsconfig.json': '{ "extends": "../tsconfig.base.json" }',
      'src/index.ts': 'export const ROOT = 1;',
      'src/lib/format.ts': 'export function fmt() {}',
      'src/vs/base/lifecycle.ts': 'export class Disposable {}',
      'app/main.ts': "import { fmt } from '@lib/format';\nimport { ROOT } from '@root';\nimport { Disposable } from 'vs/base/lifecycle';\nimport fs from 'fs';\nimport x from 'external-lib/sub';\n",
    });
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root));
    await indexer.start();
    const imports = indexer.graph.importsOf('app/main.ts').map(e => e.to).sort();
    expect(imports).toEqual(['src/index.ts', 'src/lib/format.ts', 'src/vs/base/lifecycle.ts']);
    // External libraries stay unresolved (and are not re-tried forever).
    expect(indexer.graph.get('app/main.ts')!.imports.filter(i => !i.resolved).map(i => i.spec).sort()).toEqual(['external-lib/sub', 'fs']);
  });
});

describe('RepositoryContextEngine: graph finds, source proves', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-ctx-')); await write(root, REPO); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('explicit files: reads exactly the named files and nothing else (no retrieval)', async () => {
    const engine = new RepositoryContextEngine(new LocalFilesystemWorkspaceHost(root));
    const packet = await engine.explicitFiles(['src/config/loader.ts']);
    expect(packet.mode).toBe('explicit');
    expect(packet.items.map(i => i.path)).toEqual(['src/config/loader.ts']);
    expect(packet.items[0].text).toContain('export function loadConfig');
    expect(packet.notes).toEqual([]);
  });

  it('symbol trace with a ready graph: definition, importing users, test; evidence is exact source text with line numbers', async () => {
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root));
    await indexer.start();
    const engine = new RepositoryContextEngine(new LocalFilesystemWorkspaceHost(root), indexer);
    const packet = await engine.traceSymbol('Server');
    expect(packet.mode).toBe('graph');
    const paths = packet.items.map(i => i.path);
    expect(paths[0]).toBe('src/server.ts');
    expect(paths).toContain('src/index.ts'); // imports the defining module and uses Server
    expect(packet.items[0]).toMatchObject({ source: 'graph' });
    expect(packet.items[0].text).toContain('export class Server extends Handler');
    expect(packet.notes.join(' ')).toMatch(/src\/server\.ts:3 defines class Server/);
    // The graph never fabricates evidence: every item's text really is the file's text at those lines.
    for (const item of packet.items) {
      const real = (await fs.readFile(path.join(root, item.path), 'utf8')).split('\n').slice(item.startLine - 1, item.endLine).join('\n');
      expect(item.text.trim()).toBe(real.trim());
    }
  });

  it('cold start: with no graph at all it still answers from host search', async () => {
    const engine = new RepositoryContextEngine(new LocalFilesystemWorkspaceHost(root)); // no indexer
    const packet = await engine.traceSymbol('loadConfig');
    expect(packet.mode).toBe('cold');
    expect(packet.items[0].path).toBe('src/config/loader.ts');
    expect(packet.notes.join(' ')).toMatch(/graph not ready/i);
    const unstarted = new RepositoryContextEngine(new LocalFilesystemWorkspaceHost(root), new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root)));
    expect((await unstarted.traceSymbol('Logger')).items.length).toBeGreaterThan(0);
  });

  it('architecture evidence: manifest + entry point + what the terms select, within the token budget', async () => {
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root));
    await indexer.start();
    const engine = new RepositoryContextEngine(new LocalFilesystemWorkspaceHost(root), indexer);
    const packet = await engine.architectureEvidence(['server', 'handler'], { budgetTokens: 1500 });
    const paths = packet.items.map(i => i.path);
    expect(paths).toEqual(expect.arrayContaining(['package.json', 'src/index.ts', 'src/server.ts']));
    expect(packet.tokenEstimate).toBeLessThanOrEqual(1500);
    const tight = await engine.architectureEvidence(['server'], { budgetTokens: 120 });
    expect(tight.tokenEstimate).toBeLessThanOrEqual(120);
    expect(tight.truncated).toBe(true);
  });

  it('neighbourhood is navigation with provenance, not evidence', async () => {
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root));
    await indexer.start();
    const engine = new RepositoryContextEngine(new LocalFilesystemWorkspaceHost(root), indexer);
    const n = engine.neighborhood('src/server.ts');
    expect(n.map(x => x.relation)).toEqual(expect.arrayContaining(['imports', 'imported_by', 'tests']));
    expect(n.every(x => x.confidence > 0 && x.confidence <= 1 && x.provenance)).toBe(true);
  });
});
