import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFile, htmlScriptView, roleOf } from '../platform/repo/extractors';
import { RepositoryGraph, stemNeedle } from '../platform/repo/repositoryGraph';
import { LocalFilesystemWorkspaceHost, type WorkspaceHost } from '../platform/repo/workspaceHost';
import { RepositoryGraphIndexer } from '../platform/repo/graphIndexer';
import { RepositoryContextEngine } from '../platform/repo/evidence';

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}
const crlf = (text: string): string => text.replace(/\n/g, '\r\n');

let root = '';
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-nav-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function git(...args: string[]): void { execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' }); }

async function ready(host: WorkspaceHost): Promise<RepositoryContextEngine> {
  const indexer = new RepositoryGraphIndexer(host);
  await indexer.start();
  return new RepositoryContextEngine(host, indexer);
}

describe('host search on Windows-style checkouts', () => {
  it('finds hits in CRLF files (a trailing \\r must not drop every match)', async () => {
    await write(root, { 'a.ts': crlf('export function persist() {}\n'), 'b.ts': crlf("import { persist } from './a';\npersist();\n") });
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'x');
    const hits = await new LocalFilesystemWorkspaceHost(root).search('persist', { wholeWord: true, caseSensitive: true });
    expect(hits.map(h => `${h.path}:${h.line}`).sort()).toEqual(['a.ts:1', 'b.ts:1', 'b.ts:2']);
    expect(hits.every(h => !h.text.includes('\r'))).toBe(true);
  });

  it('finds a file that exists but was never `git add`ed (fresh results after creating a file)', async () => {
    await write(root, { 'old.ts': 'export const x = 1;\n' });
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'x');
    await write(root, { 'brand_new.ts': 'export function freshlyCreated() {}\n' });
    const hits = await new LocalFilesystemWorkspaceHost(root).search('freshlyCreated', {});
    expect(hits.map(h => h.path)).toEqual(['brand_new.ts']);
  });
});

describe('single-file HTML apps', () => {
  const HTML = `<!doctype html>\n<html><body>\n<script src="cdn.js"></script>\n<script type="application/json">{"function fake(){}":1}</script>\n<script>\nfunction saveDB(){ localStorage.setItem('k','v') }\nfunction commit(){ saveDB() }\n</script>\n</body></html>\n`;

  it('only inline JavaScript is visible to extractors and every line number is preserved', () => {
    const view = htmlScriptView(HTML);
    expect(view.split('\n').length).toBe(HTML.split('\n').length);
    expect(view).toContain('function saveDB');
    expect(view).not.toContain('fake');
    expect(view).not.toContain('cdn.js');
    const e = extractFile('app.html', HTML);
    expect(e.language).toBe('html');
    expect(Object.fromEntries(e.symbols.map(s => [s.name, s.line]))).toEqual({ saveDB: 6, commit: 7 });
  });

  it('html is a source file, so the graph reads it and can answer who-calls', async () => {
    expect(roleOf('app.html')).toBe('source');
    await write(root, { 'app.html': HTML });
    const engine = await ready(new LocalFilesystemWorkspaceHost(root));
    const refs = await engine.findReferences('saveDB');
    expect(refs.definitions).toEqual([{ path: 'app.html', line: 6, kind: 'function' }]);
    expect(refs.references.map(r => r.line)).toEqual([7]);
  });
});

describe('RepositoryContextEngine.findReferences / impact', () => {
  const REPO = {
    'src/validator.ts': crlf('export function validate(x: string) { return x.length > 0; }\n'),
    'src/form.ts': crlf("import { validate } from './validator';\nexport function submit(v: string) { return validate(v); }\n"),
    'src/page.ts': crlf("import { submit } from './form';\nexport const go = () => submit('a');\n"),
    'src/validator.test.ts': crlf("import { validate } from './validator';\ntest('v', () => validate('a'));\n"),
    'src/unrelated.ts': 'export function validateElsewhere() {}\n',
  };

  it('lists exact call sites (not definitions, not look-alike names) in CRLF repos', async () => {
    await write(root, REPO);
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'x');
    const engine = await ready(new LocalFilesystemWorkspaceHost(root));
    const refs = await engine.findReferences('validate');
    expect(refs.source).toBe('graph-search');
    expect(refs.references.map(r => `${r.path}:${r.line}`).sort()).toEqual(['src/form.ts:1', 'src/form.ts:2', 'src/validator.test.ts:1', 'src/validator.test.ts:2']);
  });

  it("prefers the editor's language service when the host has one, and reports it", async () => {
    await write(root, REPO);
    const base = new LocalFilesystemWorkspaceHost(root);
    const host: WorkspaceHost = Object.assign(Object.create(base), {
      references: async () => [{ path: 'src/form.ts', line: 2, column: 40 }, { path: 'src/validator.ts', line: 1 }],
    });
    const engine = await ready(host);
    const refs = await engine.findReferences('validate');
    expect(refs.source).toBe('lsp');
    expect(refs.references.map(r => `${r.path}:${r.line}`)).toEqual(['src/form.ts:2']); // the definition site itself is excluded
  });

  it('impact of a file: direct importers, importers of those, and the tests to run', async () => {
    await write(root, REPO);
    const engine = await ready(new LocalFilesystemWorkspaceHost(root));
    const impact = await engine.impact('src/validator.ts');
    expect(impact.kind).toBe('file');
    expect(impact.direct).toEqual(['src/form.ts']);
    expect(impact.indirect).toEqual(['src/page.ts']);
    expect(impact.tests).toEqual(['src/validator.test.ts']);
  });

  it('impact of a symbol: the files using it plus tests of the definer', async () => {
    await write(root, REPO);
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'x');
    const engine = await ready(new LocalFilesystemWorkspaceHost(root));
    const impact = await engine.impact('validate');
    expect(impact.kind).toBe('symbol');
    expect(impact.direct).toEqual(['src/form.ts']);
    expect(impact.tests).toContain('src/validator.test.ts');
  });
});

describe('repoMap and ranking', () => {
  it('stems question words so "validate"/"persisted" reach Validator/persist*', () => {
    expect(stemNeedle('validate')).toBe('validat');
    expect(stemNeedle('persisted')).toBe('persist');
    expect(stemNeedle('store')).toBe('stor'); // matches store/storage/TaskStore
    expect(stemNeedle('task')).toBe('task'); // never shortened below four characters
    expect(stemNeedle('src/x')).toBe('src/x');
  });

  it('a file matching several question words by path outranks a file with many symbol hits', () => {
    const g = new RepositoryGraph();
    g.upsert('src/TaskStore.ts', { size: 1, mtimeMs: 1, text: 'export class TaskStore {}\n' });
    const noisy = Array.from({ length: 30 }, (_, i) => `export const task${i} = ${i};`).join('\n');
    g.upsert('src/protocol.ts', { size: 1, mtimeMs: 1, text: noisy });
    expect(g.rankFiles(['task', 'store'], { max: 2 })[0]!.path).toBe('src/TaskStore.ts');
  });

  it('repoMap respects its token budget and lists the whole outline of a tiny repo', async () => {
    await write(root, { 'app.html': '<script>\nfunction a(){}\nfunction b(){}\n</script>' });
    const engine = await ready(new LocalFilesystemWorkspaceHost(root));
    const small = engine.graph!.repoMap({ budgetTokens: 300 });
    expect(small.text).toContain('app.html: a, b');

    const many: Record<string, string> = {};
    for (let i = 0; i < 80; i++) many[`src/m${i}.ts`] = `export function fn${i}() {}\n`;
    await write(root, many);
    const big = await ready(new LocalFilesystemWorkspaceHost(root));
    const map = big.graph!.repoMap({ budgetTokens: 120 });
    expect(map.tokenEstimate).toBeLessThanOrEqual(120);
    expect(map.files).toBeGreaterThan(0);
    expect(map.files).toBeLessThan(80);
  });
});

describe('freshness: the answer reflects the workspace immediately after it changes', () => {
  async function indexed(): Promise<{ indexer: RepositoryGraphIndexer; engine: RepositoryContextEngine }> {
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root));
    await indexer.start();
    return { indexer, engine: new RepositoryContextEngine(new LocalFilesystemWorkspaceHost(root), indexer) };
  }

  it('edit: a symbol added to an existing file is findable after an incremental update', async () => {
    await write(root, { 'a.ts': 'export function one() {}\n' });
    const { indexer, engine } = await indexed();
    expect(engine.graph!.definitions('two')).toEqual([]);
    await fs.writeFile(path.join(root, 'a.ts'), 'export function one() {}\nexport function two() {}\n');
    await indexer.updatePaths(['a.ts']);
    expect(engine.graph!.definitions('two').map(d => `${d.path}:${d.symbol.line}`)).toEqual(['a.ts:2']);
  });

  it('rename: the old path stops answering and the new path takes over', async () => {
    await write(root, { 'old.ts': 'export function moved() {}\n', 'user.ts': "import { moved } from './old';\nmoved();\n" });
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'x');
    const { indexer, engine } = await indexed();
    expect(engine.graph!.definitions('moved').map(d => d.path)).toEqual(['old.ts']);
    git('mv', 'old.ts', 'renamed.ts');
    await indexer.updatePaths(['old.ts', 'renamed.ts']);
    expect(engine.graph!.definitions('moved').map(d => d.path)).toEqual(['renamed.ts']);
    expect(engine.graph!.has('old.ts')).toBe(false);
    const refs = await engine.findReferences('moved');
    expect(refs.references.map(r => r.path)).toEqual(['user.ts', 'user.ts']);
  });

  it('branch switch: a checkout that rewrites many files is reflected once those paths are reported', async () => {
    await write(root, { 'a.ts': 'export function onMain() {}\n', 'b.ts': 'export const keep = 1;\n' });
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'main');
    git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(root, 'a.ts'), 'export function onFeature() {}\n');
    await write(root, { 'c.ts': 'export function addedOnFeature() {}\n' });
    git('add', '-A'); git('commit', '-qm', 'feature');
    git('checkout', '-q', 'main');
    const { indexer, engine } = await indexed();
    expect(engine.graph!.definitions('onMain')).toHaveLength(1);
    expect(engine.graph!.definitions('addedOnFeature')).toHaveLength(0);
    git('checkout', '-q', 'feature');
    await indexer.updatePaths(['a.ts', 'c.ts']); // what the file watcher reports for the checkout
    expect(engine.graph!.definitions('onMain')).toHaveLength(0);
    expect(engine.graph!.definitions('onFeature')).toHaveLength(1);
    expect(engine.graph!.definitions('addedOnFeature').map(d => d.path)).toEqual(['c.ts']);
  });

  it('workspace switch: two roots never share an index', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-nav2-'));
    try {
      await write(root, { 'a.ts': 'export function inFirst() {}\n' });
      await write(other, { 'b.ts': 'export function inSecond() {}\n' });
      const first = await ready(new LocalFilesystemWorkspaceHost(root));
      const second = await ready(new LocalFilesystemWorkspaceHost(other));
      expect(first.graph!.definitions('inSecond')).toHaveLength(0);
      expect(second.graph!.definitions('inFirst')).toHaveLength(0);
      expect(second.graph!.definitions('inSecond')).toHaveLength(1);
    } finally { await fs.rm(other, { recursive: true, force: true }); }
  });
});
