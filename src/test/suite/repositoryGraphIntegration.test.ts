import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscodeMock from '../mocks/vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import { RepoFastPath } from '../../repository/RepoFastPath';
import { RepositoryGraphService } from '../../repository/RepositoryGraphService';
import { assessRetrievalNeed, extractNamedFiles } from '../../repository/RetrievalNeed';
import { tsAstExtractor } from '../../repository/TsAstExtractor';
import { VSCodeWorkspaceHost } from '../../repository/VSCodeWorkspaceHost';
import { AgentPanel } from '../../ui/AgentPanel';
import { collectCapabilityRows } from '../../onboarding/CapabilityRegistry';
import { extractFile } from '../../../core/platform/repo/extractors';

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-int-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  return root;
}

const REPO = {
  'package.json': JSON.stringify({ name: 'demo', main: 'src/index.ts' }),
  'src/index.ts': "import { JobScheduler } from './jobs/scheduler';\nexport function boot() { return new JobScheduler(); }\n",
  'src/jobs/scheduler.ts': "import { Queue } from './queue';\nexport class JobScheduler extends Queue {\n  tick() { return 1; }\n}\n",
  'src/jobs/queue.ts': 'export class Queue { size() { return 0; } }\n',
  'src/hidden/Quiet.ts': 'export const QUIET = 1;\n',
  'src/jobs/scheduler.test.ts': "import { JobScheduler } from './scheduler';\n",
};

describe('retrieval need: explicit new files do not trigger repository retrieval (defect #5)', () => {
  it('skips retrieval only when the objective names every file to create and depends on nothing existing', () => {
    const skip = (text: string) => assessRetrievalNeed(text, { fileExists: () => false });
    expect(skip('Create notes.md, todo.md and plan.md with a short heading in each.')).toMatchObject({ needed: false, reason: 'explicit_new_files', targets: ['notes.md', 'todo.md', 'plan.md'] });
    expect(skip('create src/util/strings.ts that exports a slugify function').needed).toBe(false);
    expect(skip('Add hello.txt containing the word hello').needed).toBe(false);
    expect(skip('Visit example.com for ideas, then create ideas.md').targets).toEqual(['ideas.md']);
    expect(skip('Bump to 1.2.3 and create CHANGELOG.md').targets).toEqual(['CHANGELOG.md']);
  });

  it('keeps retrieval on for edits, existing-code references, identifiers, questions and existing targets', () => {
    const need = (text: string, exists = false) => assessRetrievalNeed(text, { fileExists: () => exists });
    expect(need('Update the README and fix the typo in server.ts').needed).toBe(true);
    expect(need('Create tests/user.test.ts for UserService').detail).toMatch(/identifiers/);
    expect(need('Create index.html that imports the existing styles.css').detail).toMatch(/existing code/);
    expect(need('Explain what package.json declares').detail).toMatch(/no creation intent/);
    expect(need('Create a.txt and b.txt', true).detail).toMatch(/already exist/);
    expect(need('Where is the retry logic?').detail).toMatch(/no explicit files/);
    expect(need('Create something nice').needed).toBe(true);
    expect(extractNamedFiles('see ./a/b.ts and C:\\x\\y.py and https://site.org/x')).toEqual(['a/b.ts', 'C:\\x\\y.py']);
  });

  describe('through AgentPanel', () => {
    let root: string;
    beforeEach(() => { root = makeRepo(REPO); vscodeMock._resetConfig(); });
    afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

    const panelFor = () => {
      const panel = new AgentPanel(createMockExtensionContext() as never, root, true);
      const spy = vi.spyOn((panel as unknown as { repoFastPath: RepoFastPath }).repoFastPath, 'repoQuery').mockResolvedValue(undefined);
      return { panel: panel as unknown as { requireModeChange(input: object): Promise<void>; objectiveNeedsRetrieval(t: string): boolean }, spy };
    };

    it('the mode gate does not retrieve for "create three files", and still retrieves for a request about existing code', async () => {
      const { panel, spy } = panelFor();
      await panel.requireModeChange({ text: 'Create alpha.md, beta.md and gamma.md each with one heading', attachmentIds: [], conversationId: 'c1' });
      expect(spy).not.toHaveBeenCalled();
      await panel.requireModeChange({ text: 'Fix the bug in the JobScheduler tick method', attachmentIds: [], conversationId: 'c2' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a named file that already exists is an edit, so retrieval stays on', () => {
      const { panel } = panelFor();
      expect(panel.objectiveNeedsRetrieval('Create package.json with a name field')).toBe(true);
      expect(panel.objectiveNeedsRetrieval('Create brand-new.md with a heading')).toBe(false);
    });
  });
});

describe('graph as a ranked retrieval source for RepoFastPath (ranking only; source is still read exactly)', () => {
  let root: string;
  beforeEach(() => { root = makeRepo(REPO); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('files the graph ranks join the fused candidates and are read; a failing ranker is ignored', async () => {
    const question = 'Explain how the scheduler tick works';
    const base = (await new RepoFastPath(root).repoQuery(question, { maxChars: 8_000 }))!;
    expect(base.files.map(f => f.path)).not.toContain('src/hidden/Quiet.ts');

    const withGraph = new RepoFastPath(root);
    withGraph.setGraphRanker(() => ['src/hidden/Quiet.ts', 'src/jobs/scheduler.ts']);
    const boosted = (await withGraph.repoQuery(question, { maxChars: 8_000 }))!;
    expect(boosted.files.map(f => f.path)).toContain('src/hidden/Quiet.ts');
    // The packet carries source text, never a graph claim.
    expect(boosted.prompt).toContain('export const QUIET = 1;');

    const broken = new RepoFastPath(root);
    broken.setGraphRanker(() => { throw new Error('graph exploded'); });
    expect((await broken.repoQuery(question, { maxChars: 8_000 }))!.files.length).toBeGreaterThan(0);
  });
});

describe('TypeScript AST extractor (stronger provenance than the lexical one)', () => {
  it('captures imports with names, heritage, methods and exports with ast provenance, and skips other languages and huge files', () => {
    const text = [
      "import Def, { a, b as c } from './mod';", "export * from './re';", "const lazy = import('./lazy');", "const cjs = require('./cjs');",
      'export abstract class Repo<T> extends Base<T> implements IRepo, IOther {', '  find() {}', '  get size() { return 1; }', '}',
      'export interface Opts extends Base {}', 'export type Id = string;', 'export enum Mode { A }', 'export const LIMIT = 5;',
      'export const handler = () => 1;', 'const INTERNAL_FLAG = 1;', 'function helper() {}', 'export default helper;',
    ].join('\n');
    const e = tsAstExtractor('a.ts', text)!;
    expect(e.provenance).toBe('ast');
    expect(e.imports!.find(i => i.spec === './mod')).toMatchObject({ names: ['default', 'a', 'b'], kind: 'static', provenance: 'ast' });
    expect(e.imports!.map(i => i.spec)).toEqual(expect.arrayContaining(['./re', './lazy', './cjs']));
    const byName = Object.fromEntries(e.symbols!.map(s => [s.name, s]));
    expect(byName.Repo).toMatchObject({ kind: 'class', exported: true, extends: ['Base'], implements: ['IRepo', 'IOther'] });
    expect(byName.find).toMatchObject({ kind: 'method', container: 'Repo' });
    expect(byName.Opts.extends).toEqual(['Base']);
    expect(byName.handler).toMatchObject({ kind: 'function', exported: true });
    expect(byName.INTERNAL_FLAG).toMatchObject({ exported: false }); // upper-case module constants are kept
    expect(byName.helper).toMatchObject({ kind: 'function', exported: false });
    expect(e.exports).toEqual(expect.arrayContaining(['Repo', 'Opts', 'Id', 'Mode', 'LIMIT', 'handler', 'default']));
    expect(tsAstExtractor('a.py', 'class A: pass')).toBeUndefined();
    expect(tsAstExtractor('big.ts', 'export const x = 1;\n'.repeat(10_000))).toBeUndefined();
    // Wired through the portable extractFile, it replaces the lexical result.
    expect(extractFile('a.ts', text, tsAstExtractor).provenance).toBe('ast');
  });
});

describe('RepositoryGraphService (extension adapter)', () => {
  let root: string;
  let storage: string;
  beforeEach(async () => { vscodeMock._resetConfig(); root = makeRepo(REPO); storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'graph-store-')); });
  afterEach(async () => { fs.rmSync(root, { recursive: true, force: true }); await fsp.rm(storage, { recursive: true, force: true }); });

  const contextWith = (extra: object = {}) => ({ ...createMockExtensionContext(), globalStorageUri: { fsPath: storage }, ...extra }) as never;

  it('indexes in the background, ranks for a plan only once usable, persists, updates incrementally and honours the disable setting', async () => {
    const service = RepositoryGraphService.forWorkspace(contextWith(), root);
    expect(service.rankForPlan({ identifiers: ['JobScheduler'], keywords: [] })).toEqual([]); // not started: no ranking, no error
    service.start(0);
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.indexer.ready();
    const stats = service.stats();
    expect(stats).toMatchObject({ enabled: true, phase: 'ready', coverage: 1 });
    expect(stats.symbols).toBeGreaterThan(3);
    const ranked = service.rankForPlan({ identifiers: ['JobScheduler'], keywords: ['queue'] });
    expect(ranked[0]).toBe('src/jobs/scheduler.ts');
    expect(ranked).toEqual(expect.arrayContaining(['src/jobs/queue.ts', 'src/index.ts']));
    expect(service.indexer.graph.get('src/jobs/scheduler.ts')!.provenance).toBe('ast');

    // Snapshot persisted under the extension's storage, outside the workspace.
    const entries = await fsp.readdir(path.join(storage, 'repo-graph'));
    expect(entries.length).toBe(1);

    // Incremental: a save re-reads only that file.
    fs.writeFileSync(path.join(root, 'src/jobs/queue.ts'), 'export class Queue { size() { return 0; } drain() {} }\nexport class Backlog {}\n');
    service.notifyChanged([path.join(root, 'src/jobs/queue.ts'), path.join(root, 'node_modules/x/y.js')], 10);
    await new Promise(resolve => setTimeout(resolve, 80));
    await service.indexer.ready();
    expect(service.indexer.graph.definitions('Backlog')).toHaveLength(1);

    // Setup's Capabilities section reports exactly what the index knows.
    expect(collectCapabilityRows()).toContainEqual(expect.objectContaining({ name: 'Repository Intelligence', status: 'ok', detail: expect.stringMatching(/^Graph ready · \d+ symbols indexed$/) }));

    vscodeMock._setConfig('ollama-agent.repositoryGraph.enabled', false);
    expect(service.stats().phase).toBe('disabled');
    expect(collectCapabilityRows()).toContainEqual(expect.objectContaining({ name: 'Repository Intelligence', status: 'off' }));
    expect(service.rankForPlan({ identifiers: ['JobScheduler'], keywords: [] })).toEqual([]);
    service.dispose();
  });

  it('the VS Code host is a LocalFilesystemWorkspaceHost plus optional accelerators that never throw when VS Code lacks them', async () => {
    const host = new VSCodeWorkspaceHost(root);
    expect(host.kind).toBe('vscode');
    expect((await host.listPaths()).sort()).toContain('src/index.ts');
    expect(await host.symbols('Queue')).toEqual([]); // no language server in the mock
    expect(await host.definitions('src/index.ts', 1, 1)).toEqual([]);
    expect(await host.diagnostics()).toEqual([]);
    expect(await host.openFiles()).toEqual([]);
    expect(await host.recentFiles()).toEqual([]);
    expect((await host.readFile('src/hidden/Quiet.ts'))!.text).toContain('QUIET');
    expect(await host.readFile('../../etc/passwd')).toBeUndefined();
  });
});
