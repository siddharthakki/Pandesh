import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RepositoryIntel, loadRepositoryIntel } from '../../autonomy/RepositoryIntel';
import { scanWorkspaceLite } from '../../autonomy/workspaceScan';
import { compileContextPack } from '../../autonomy/ContextCompiler';
import { deriveExecutionEconomy } from '../../autonomy/ExecutionEconomyProfile';

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function tinyProject(): Promise<void> {
  await write('package.json', JSON.stringify({ name: 'shop', main: 'src/index.ts', scripts: { test: 'vitest run' } }));
  await write('src/index.ts', "import { calculateTotal } from './total';\nexport const run = () => calculateTotal([1, 2, 3]);\n");
  await write('src/total.ts', 'export function calculateTotal(items: number[]): number {\n  return items.length;\n}\n');
  await write('src/format.ts', 'export const money = (n: number) => `$${n}`;\n');
  await write('src/cart.ts', "import { calculateTotal } from './total';\nexport const cartTotal = (c: number[]) => calculateTotal(c);\n");
  await write('src/total.test.ts', "import { calculateTotal } from './total';\ntest('sums', () => expect(calculateTotal([1, 2, 3])).toBe(6));\n");
}

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-intel-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('M46 repository intelligence', () => {
  it('answers structural questions on a tiny non-Git project from the filesystem fallback', async () => {
    await tinyProject();
    const intel = await loadRepositoryIntel({ workspaceRoot: root });
    expect(intel.source).toBe('filesystem');
    expect(intel.manifests()).toContain('package.json');
    expect(intel.entrypoints()).toContain('src/index.ts');
    expect(intel.definitionsOf('calculate_total')).toEqual([{ path: 'src/total.ts', name: 'calculateTotal', kind: 'function', line: 1 }]);
    expect(intel.referencesTo('src/total.ts')).toEqual(['src/cart.ts', 'src/index.ts', 'src/total.test.ts']);
    expect(intel.testsFor('src/total.ts')).toEqual(['src/total.test.ts']);
    expect(intel.dependenciesOf('src/cart.ts')).toEqual(['src/total.ts']);
    expect(intel.architectureSummary().join('\n')).toMatch(/6 files.*typescript/s);
  });

  it('treats an empty or non-project folder as a valid empty workspace', async () => {
    const intel = await loadRepositoryIntel({ workspaceRoot: root });
    expect(intel.source).toBe('empty');
    expect(intel.candidates({ objective: 'anything', taskType: 'inspect' })).toEqual([]);
    expect(intel.architectureSummary()[0]).toMatch(/no indexable files/);
    const missing = await loadRepositoryIntel({ workspaceRoot: path.join(root, 'does-not-exist') });
    expect(missing.source).toBe('empty');
  });

  it('falls back to the filesystem when the index provider fails or returns nothing', async () => {
    await tinyProject();
    const throwing = await loadRepositoryIntel({ workspaceRoot: root, snapshotProvider: async () => { throw new Error('sqlite unavailable'); } });
    expect(throwing.source).toBe('filesystem');
    expect(throwing.fileCount).toBe(6);
    const undef = await loadRepositoryIntel({ workspaceRoot: root, snapshotProvider: async () => undefined });
    expect(undef.source).toBe('filesystem');
  });

  it('uses a provided index snapshot when it has files', async () => {
    await tinyProject();
    const scan = await scanWorkspaceLite(root);
    const snapshot = { files: scan.files, pins: [], exclusions: [], truncated: false } as never;
    const intel = await loadRepositoryIntel({ workspaceRoot: root, snapshotProvider: async () => snapshot });
    expect(intel.source).toBe('index');
  });

  it('ignores generated, dependency and cache directories and lockfiles', async () => {
    await tinyProject();
    await write('node_modules/left-pad/index.js', 'module.exports = 1;');
    await write('dist/bundle.js', 'var a = 1;');
    await write('.venv/lib/site-packages/x.py', 'x = 1');
    await write('package-lock.json', '{}');
    await write('src/app.min.js', 'var a=1;');
    const intel = await loadRepositoryIntel({ workspaceRoot: root });
    const all = intel.candidates({ objective: 'anything', taskType: 'inspect', limit: 100 }).map(c => c.path);
    for (const noisy of ['node_modules/left-pad/index.js', 'dist/bundle.js', '.venv/lib/site-packages/x.py', 'package-lock.json', 'src/app.min.js']) {
      expect(intel.has(noisy)).toBe(false);
      expect(all).not.toContain(noisy);
    }
  });

  it('implicates files from failure output: printed paths with lines, and symbols it names', async () => {
    await tinyProject();
    const intel = await loadRepositoryIntel({ workspaceRoot: root });
    const output = [
      ' FAIL  src/total.test.ts > sums',
      'AssertionError: expected 3 to be 6',
      ` ❯ ${path.join(root, 'src', 'total.test.ts').replace(/\\/g, '/')}:2:50`,
    ].join('\n');
    const implicated = intel.implicatedBy(output);
    expect(implicated[0]).toMatchObject({ path: 'src/total.test.ts', via: 'path' });
    expect(implicated[0].lines).toContainEqual([2, 2]);
    const bySymbol = intel.implicatedBy('TypeError: calculateTotal returned the wrong value');
    expect(bySymbol).toEqual([{ path: 'src/total.ts', lines: [], symbols: ['calculateTotal'], via: 'symbol' }]);
  });

  it('ranks the definition, its tests and its callers for a repair objective, with reasons', async () => {
    await tinyProject();
    const intel = await loadRepositoryIntel({ workspaceRoot: root });
    const ranked = intel.candidates({
      objective: 'Determine why calculate_total() fails these tests. Do not edit yet.',
      errorText: 'FAIL src/total.test.ts\nexpected 3 to be 6',
      taskType: 'diagnose',
    });
    const paths = ranked.map(c => c.path);
    expect(paths.slice(0, 3)).toEqual(expect.arrayContaining(['src/total.test.ts', 'src/total.ts']));
    expect(paths).toContain('src/cart.ts');
    expect(paths.indexOf('src/format.ts')).toBe(-1);
    const total = ranked.find(c => c.path === 'src/total.ts')!;
    expect(total.reasons.join(' ')).toMatch(/defines calculateTotal/);
    expect(total.focus?.symbols).toContain('calculateTotal');
    // Deterministic and demotes what the model has already seen.
    expect(intel.candidates({ objective: 'calculate_total', taskType: 'diagnose' })).toEqual(intel.candidates({ objective: 'calculate_total', taskType: 'diagnose' }));
    const demoted = intel.candidates({ objective: 'calculate_total', taskType: 'diagnose', alreadySeen: ['src/total.ts'] });
    expect(demoted.find(c => c.path === 'src/total.ts')!.score).toBeLessThan(ranked.find(c => c.path === 'src/total.ts')!.score);
  });

  it('surfaces manifests, entrypoints and documentation for an inspection task', async () => {
    await tinyProject();
    await write('README.md', '# Shop\nA tiny shop.\n');
    const intel = await loadRepositoryIntel({ workspaceRoot: root });
    const paths = intel.candidates({ objective: 'Explain this repository architecture', taskType: 'inspect' }).map(c => c.path);
    expect(paths).toEqual(expect.arrayContaining(['package.json', 'src/index.ts', 'README.md']));
  });

  it('handles a large repository quickly and keeps the pack inside its budget', async () => {
    await tinyProject();
    for (let i = 0; i < 1_200; i += 1) {
      await write(`pkg${i % 40}/mod${i}.ts`, `export function generated${i}(x: number): number { return x + ${i}; }\n`);
    }
    const started = Date.now();
    const intel = await loadRepositoryIntel({ workspaceRoot: root });
    expect(intel.fileCount).toBeGreaterThan(1_200);
    const profile = deriveExecutionEconomy({ contextWindow: { contextTokens: 8_192, source: 'router_metadata' } });
    const request = { objective: 'Fix calculate_total', errorText: 'src/total.test.ts:2', taskType: 'repair' as const };
    const pack = await compileContextPack({
      taskId: 't', taskType: 'repair', objective: request.objective, policy: profile.pack, tier: profile.tier,
      candidates: intel.candidates(request),
      architectureSummary: intel.architectureSummary(),
      readFile: async p => fs.readFile(path.join(root, p), 'utf8').catch(() => undefined),
    });
    expect(pack.chars).toBeLessThanOrEqual(profile.pack.maxChars);
    expect(pack.text).toContain('src/total.ts');
    expect(pack.text).toContain('src/total.test.ts');
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('produces an equivalent pack after a restart (fresh intel over the same durable workspace)', async () => {
    await tinyProject();
    const profile = deriveExecutionEconomy({ contextWindow: { contextTokens: 32_768, source: 'router_metadata' } });
    const build = async () => {
      const intel = await loadRepositoryIntel({ workspaceRoot: root });
      const request = { objective: 'Diagnose calculate_total', errorText: 'src/total.test.ts:2', taskType: 'diagnose' as const };
      return compileContextPack({
        taskId: 'task-9', subgoalId: 'sg-1', taskType: 'diagnose', objective: request.objective,
        policy: profile.pack, tier: profile.tier,
        candidates: intel.candidates(request), architectureSummary: intel.architectureSummary(),
        readFile: async p => fs.readFile(path.join(root, p), 'utf8').catch(() => undefined),
      });
    };
    const before = await build();
    const after = await build();
    expect(after.packHash).toBe(before.packHash);
    expect(after.text).toBe(before.text);
  });

  it('keeps a file structurally relevant when its raw size exceeds the snippet limit', async () => {
    await tinyProject();
    const filler = Array.from({ length: 2_500 }, (_, i) => `// filler line ${i}`).join('\n');
    await write('src/total.ts', `${filler}\nexport function calculateTotal(items: number[]): number {\n  return items.length;\n}\n`);
    const intel = await loadRepositoryIntel({ workspaceRoot: root });
    const profile = deriveExecutionEconomy({ contextWindow: { contextTokens: 8_192, source: 'router_metadata' } });
    const pack = await compileContextPack({
      taskId: 't', taskType: 'diagnose', objective: 'Why does calculate_total fail?', policy: profile.pack,
      candidates: intel.candidates({ objective: 'Why does calculate_total fail?', taskType: 'diagnose' }),
      readFile: async p => fs.readFile(path.join(root, p), 'utf8').catch(() => undefined),
    });
    const form = pack.telemetry.selected.find(s => s.id === 'src/total.ts')?.form;
    expect(['focused', 'outline']).toContain(form);
    expect(pack.text).toContain('calculateTotal');
    expect(pack.text).not.toContain('filler line 1200');
  });

  it('is an ordinary in-memory query object over any record set (no Git, no disk)', () => {
    const intel = new RepositoryIntel([]);
    expect(intel.source).toBe('empty');
    expect(intel.entrypoints()).toEqual([]);
    expect(intel.recentlyChanged()).toEqual([]);
  });
});
