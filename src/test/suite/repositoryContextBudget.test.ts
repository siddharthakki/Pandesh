import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RepositoryContextService } from '../../context/RepositoryContextService';
import {
  REPOSITORY_CONTEXT_HARD_MAX_CHARS,
  REPOSITORY_CONTEXT_MIN_CHARS,
  planRepositoryContextBudget,
  type RepositoryContextBudget,
} from '../../context/RepositoryContextBudget';
import type { RepositoryContextResult } from '../../context/RepositoryTypes';
import { normalizeRepositoryContext } from '../../../core/domain/attemptContext';
import { REPOSITORY_CONTEXT_MAX_PROMPT_CHARS } from '../../../core/shared/wireTypes';

const execFileAsync = promisify(execFile);

const OVERVIEW_QUERY = 'Inspect this repository and explain its architecture, major components, and current state. Do not modify anything.';

async function write(root: string, relative: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

/** A plausible source module of roughly `chars` characters. */
function sourceModule(name: string, chars: number): string {
  const lines = [`export function ${name}(input: number): number {`];
  let index = 0;
  while (lines.join('\n').length < chars - 40) {
    lines.push(`  const ${name}Step${index} = input * ${index} + ${index % 7}; // ${name} step ${index}`);
    index += 1;
  }
  lines.push('  return input;', '}');
  return lines.join('\n');
}

async function writeSourceTree(root: string, fileCount: number, charsPerFile: number): Promise<void> {
  await write(root, 'package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'tsc' } }, null, 2));
  await write(root, 'README.md', '# Fixture\n\nA service with an api layer, a domain model and workers.\n');
  await write(root, 'src/index.ts', "import { handler0 } from './api/handler0';\nexport const start = () => handler0(1);\n");
  for (let index = 0; index < fileCount; index += 1) {
    const area = ['api', 'domain', 'workers', 'storage'][index % 4];
    await write(root, `src/${area}/handler${index}.ts`, sourceModule(`handler${index}`, charsPerFile));
  }
}

async function gitInit(root: string): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: root, windowsHide: true });
}

function assertBounded(result: RepositoryContextResult, budget: RepositoryContextBudget): void {
  expect(result.prompt.length).toBeLessThanOrEqual(budget.budgetChars);
  expect(result.prompt.length).toBeLessThanOrEqual(REPOSITORY_CONTEXT_HARD_MAX_CHARS);
  expect(result.prompt.length).toBeLessThan(REPOSITORY_CONTEXT_MAX_PROMPT_CHARS);
  expect(result.diagnostics.budget?.selectedChars).toBe(result.prompt.length);
  expect(result.diagnostics.budget?.budgetChars).toBe(budget.budgetChars);
  if (result.prompt) {
    // The exact package the extension submits must pass Core's own validator.
    expect(() => normalizeRepositoryContext({
      prompt: result.prompt,
      selectedFiles: result.files.map(file => ({ path: file.path, estimatedTokens: file.estimatedTokens })),
      estimatedTokens: result.diagnostics.estimatedTokens,
      packageHash: result.diagnostics.packageHash,
    })).not.toThrow();
  }
}

describe('repository context budget planning', () => {
  it('reserves system, objective, conversation, output and margin before repository context for a 32k model', () => {
    const budget = planRepositoryContextBudget({ modelContextTokens: 32_768, objective: OVERVIEW_QUERY });
    const { reservations } = budget;
    expect(reservations.systemPrompt).toBeGreaterThan(0);
    expect(reservations.objective).toBeGreaterThan(OVERVIEW_QUERY.length / 4);
    expect(reservations.conversation).toBeGreaterThan(0);
    expect(reservations.output).toBeGreaterThan(0);
    expect(reservations.safetyMargin).toBeGreaterThan(0);
    expect(reservations.toolDefinitions).toBe(0);
    expect(budget.reservedTokens).toBe(Object.values(reservations).reduce((sum, value) => sum + value, 0));
    expect(budget.budgetTokens).toBe(32_768 - budget.reservedTokens);
    expect(budget.limitedBy).toBe('model_context');
    // The pre-fix builder allowed 30,268 tokens (~121k chars) for this window.
    expect(budget.budgetChars).toBeLessThan(REPOSITORY_CONTEXT_MAX_PROMPT_CHARS);
    expect(budget.budgetTokens + budget.reservedTokens).toBeLessThanOrEqual(32_768);
  });

  it('caps a 128k+ model at the hard maximum instead of scaling with the window', () => {
    for (const window of [131_072, 262_144, 393_216]) {
      const budget = planRepositoryContextBudget({ modelContextTokens: window, objective: OVERVIEW_QUERY });
      expect(budget.limitedBy).toBe('hard_max');
      expect(budget.budgetChars).toBe(REPOSITORY_CONTEXT_HARD_MAX_CHARS);
    }
  });

  it('reserves tool definitions when the turn carries tools', () => {
    const chat = planRepositoryContextBudget({ modelContextTokens: 32_768, objective: 'x' });
    const tools = planRepositoryContextBudget({ modelContextTokens: 32_768, objective: 'x', toolsEnabled: true });
    expect(tools.reservations.toolDefinitions).toBeGreaterThan(0);
    expect(tools.budgetChars).toBeLessThan(chat.budgetChars);
  });

  it("reserves for Core's per-surface conversation replay: Baat Kar min(20000, 30%), Saath Kar min(20000, 15%)", () => {
    const saath = planRepositoryContextBudget({ modelContextTokens: 32_768, objective: 'x' });
    expect(saath.reservations.conversation).toBe(Math.floor(32_768 * 0.15));
    const baat = planRepositoryContextBudget({ modelContextTokens: 32_768, objective: 'x', surface: 'baat_kar' });
    expect(baat.reservations.conversation).toBe(Math.floor(32_768 * 0.3));
    expect(baat.budgetChars).toBeLessThan(saath.budgetChars);
    const largeBaat = planRepositoryContextBudget({ modelContextTokens: 131_072, objective: 'x', surface: 'baat_kar' });
    expect(largeBaat.reservations.conversation).toBe(20_000);
  });

  it('keeps a bounded floor for a tiny window and falls back when the window is unknown', () => {
    const tiny = planRepositoryContextBudget({ modelContextTokens: 512, objective: OVERVIEW_QUERY });
    expect(tiny.limitedBy).toBe('minimum_floor');
    expect(tiny.budgetChars).toBe(REPOSITORY_CONTEXT_MIN_CHARS);
    const unknown = planRepositoryContextBudget({ modelContextTokens: 0, objective: 'x' });
    expect(unknown.modelContext).toBe(8_192);
    expect(unknown.budgetChars).toBeGreaterThan(0);
  });

  it('never lets an explicit output allowance consume more than half the window', () => {
    const budget = planRepositoryContextBudget({ modelContextTokens: 32_768, objective: 'x', outputTokens: 1_000_000 });
    expect(budget.reservations.output).toBe(16_384);
    expect(budget.budgetTokens).toBeGreaterThanOrEqual(0);
  });
});

describe('bounded repository context assembly', () => {
  let roots: string[] = [];
  let indexRoot: string;
  const previousIndexRoot = process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT;

  async function tempRoot(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  async function build(root: string, query: string, window: number, toolsEnabled = false) {
    const budget = planRepositoryContextBudget({ modelContextTokens: window, objective: query, toolsEnabled });
    const result = await new RepositoryContextService(root).build({
      query,
      mode: toolsEnabled ? 'agent' : 'chat',
      model: 'fixture-model',
      providerType: 'ollama',
      tokenBudget: budget.budgetTokens,
      budget,
    });
    assertBounded(result, budget);
    return { budget, result };
  }

  beforeEach(async () => {
    roots = [];
    indexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-ctx-budget-index-'));
    process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT = indexRoot;
  });

  afterEach(async () => {
    if (previousIndexRoot === undefined) delete process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT;
    else process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT = previousIndexRoot;
    for (const root of [...roots, indexRoot]) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('tiny repository: the whole project fits and the overview leads the package', async () => {
    const root = await tempRoot('oa-ctx-tiny-');
    await writeSourceTree(root, 2, 400);
    const { result } = await build(root, OVERVIEW_QUERY, 32_768);
    expect(result.prompt).toContain('### Repository overview');
    expect(result.prompt.indexOf('### Repository overview')).toBeLessThan(result.prompt.indexOf('### src/'));
    const paths = result.files.map(file => file.path);
    expect(paths).toEqual(expect.arrayContaining(['package.json', 'README.md', 'src/index.ts']));
    expect(result.diagnostics.budget?.droppedFiles).toBe(0);
  });

  it('repository whose raw context is 120k+ characters stays within a 32k model budget', async () => {
    const root = await tempRoot('oa-ctx-120k-');
    await writeSourceTree(root, 40, 3_500);
    const { budget, result } = await build(root, OVERVIEW_QUERY, 32_768);
    expect(result.diagnostics.budget!.candidateChars).toBeGreaterThan(120_000);
    expect(budget.limitedBy).toBe('model_context');
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.diagnostics.budget!.droppedFiles).toBeGreaterThan(0);
  });

  it('repository whose raw context is 500k+ characters degrades into excerpts plus summaries on a 128k model', async () => {
    const root = await tempRoot('oa-ctx-500k-');
    await writeSourceTree(root, 150, 4_000);
    const { budget, result } = await build(root, OVERVIEW_QUERY, 131_072);
    const telemetry = result.diagnostics.budget!;
    expect(telemetry.candidateChars).toBeGreaterThan(500_000);
    expect(budget.limitedBy).toBe('hard_max');
    expect(telemetry.summarizedFiles).toBeGreaterThan(0);
    expect(result.prompt).toContain('### Other relevant files (index summaries only');
    expect(result.files.length).toBeLessThanOrEqual(24);
  });

  it('huge generated, dependency and cache directories never reach the package or starve the inventory', async () => {
    const root = await tempRoot('oa-ctx-generated-');
    await write(root, 'package.json', JSON.stringify({ name: 'app' }));
    await write(root, 'src/app.ts', 'export function startApp() { return "architecture entry"; }\n');
    for (let index = 0; index < 400; index += 1) {
      await write(root, `node_modules/dep${index}/index.js`, `module.exports = ${index}; // architecture`);
      await write(root, `.venv/lib/site-packages/pkg${index}/__init__.py`, `ARCHITECTURE = ${index}`);
    }
    for (let index = 0; index < 60; index += 1) {
      await write(root, `dist/chunk${index}.js`, sourceModule(`chunk${index}`, 2_000));
      await write(root, `.cache/entry${index}.json`, '{"architecture": true}');
    }
    await write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));
    await write(root, 'assets/logo.png', Buffer.alloc(4_096, 7));

    const { result } = await build(root, OVERVIEW_QUERY, 32_768);
    const paths = result.files.map(file => file.path);
    expect(paths).toContain('src/app.ts');
    for (const selected of paths) {
      expect(selected).not.toMatch(/^(node_modules|\.venv|dist|\.cache)\//);
      expect(selected).not.toMatch(/package-lock\.json$|\.png$/);
    }
    expect(result.index.files.some(file => file.path.startsWith('node_modules/') || file.path.startsWith('.venv/'))).toBe(false);
    expect(result.index.truncated).toBe(false);
  });

  it('giant single source file is excerpted, never dumped whole', async () => {
    const root = await tempRoot('oa-ctx-giant-');
    await write(root, 'package.json', JSON.stringify({ name: 'giant' }));
    await write(root, 'src/giant.ts', sourceModule('giant', 900_000));
    await write(root, 'src/large.ts', sourceModule('large', 200_000));
    await write(root, 'src/small.ts', 'export const small = 1;\n');
    const { budget, result } = await build(root, 'Explain what src/giant.ts and src/large.ts do', 32_768);
    const giant = result.files.find(file => file.path === 'src/giant.ts');
    const large = result.files.find(file => file.path === 'src/large.ts');
    expect(giant?.truncated).toBe(true);
    expect(large?.truncated).toBe(true);
    expect(giant!.snippet.length).toBeLessThanOrEqual(Math.floor(budget.budgetChars * 0.5));
  });

  it('multi-root workspace: every root and the enclosing folder use the same bounded mechanism', async () => {
    const parent = await tempRoot('oa-ctx-multiroot-');
    const api = path.join(parent, 'api');
    const web = path.join(parent, 'web');
    await writeSourceTree(api, 60, 4_000);
    await writeSourceTree(web, 60, 4_000);
    await gitInit(api);
    for (const root of [api, web, parent]) {
      const { result } = await build(root, OVERVIEW_QUERY, 32_768);
      expect(result.prompt.length).toBeGreaterThan(0);
    }
    const { result } = await build(parent, OVERVIEW_QUERY, 32_768);
    expect(result.prompt).toMatch(/api\/ \(\d+ files\)/);
    expect(result.prompt).toMatch(/web\/ \(\d+ files\)/);
  });

  it('models with 32k and 128k+ context both produce bounded packages for the same repository', async () => {
    const root = await tempRoot('oa-ctx-windows-');
    await writeSourceTree(root, 120, 4_000);
    const small = await build(root, OVERVIEW_QUERY, 32_768);
    const large = await build(root, OVERVIEW_QUERY, 262_144);
    expect(small.result.prompt.length).toBeLessThan(large.result.prompt.length);
    expect(large.result.prompt.length).toBeLessThanOrEqual(REPOSITORY_CONTEXT_HARD_MAX_CHARS);
    const saath = await build(root, OVERVIEW_QUERY, 32_768, true);
    expect(saath.result.prompt.length).toBeLessThanOrEqual(small.budget.budgetChars);
  });

  it('empty folder: a whole-repository question gets a truthful overview; a specific question gets nothing', async () => {
    const root = await tempRoot('oa-ctx-empty-');
    const overview = await build(root, OVERVIEW_QUERY, 32_768);
    expect(overview.result.files).toEqual([]);
    expect(overview.result.prompt).toContain('no indexable source or text files');
    const specific = await build(root, 'Why does registerUser accept an empty username?', 32_768);
    expect(specific.result.prompt).toBe('');
  });

  it('non-Git and Git folders with the same content select the same bounded package', async () => {
    const plain = await tempRoot('oa-ctx-nongit-');
    const tracked = await tempRoot('oa-ctx-git-');
    await writeSourceTree(plain, 40, 3_500);
    await writeSourceTree(tracked, 40, 3_500);
    await gitInit(tracked);
    const withoutGit = await build(plain, OVERVIEW_QUERY, 32_768);
    const withGit = await build(tracked, OVERVIEW_QUERY, 32_768);
    expect(withoutGit.result.files.length).toBeGreaterThan(0);
    expect(withoutGit.result.prompt.length).toBeLessThanOrEqual(withoutGit.budget.budgetChars);
    expect(withGit.result.prompt.length).toBeLessThanOrEqual(withGit.budget.budgetChars);
  });

  it('duplicate content is excerpted once; the copy is named as a pointer, not repeated', async () => {
    const root = await tempRoot('oa-ctx-dupes-');
    const body = sourceModule('shared', 1_500);
    await write(root, 'package.json', JSON.stringify({ name: 'dupes' }));
    await write(root, 'src/shared.ts', body);
    await write(root, 'src/copy/shared.ts', body);
    const { result } = await build(root, 'How does shared work in src/shared.ts?', 32_768);
    const original = result.files.find(file => file.path === 'src/shared.ts');
    const copy = result.files.find(file => file.path === 'src/copy/shared.ts');
    expect(original?.snippet).toContain('export function shared');
    expect(copy?.snippet).toBe('');
    expect(copy?.reasons).toContainEqual({ reason: 'duplicate content of src/shared.ts', score: 0 });
    expect(result.prompt).toContain('### src/copy/shared.ts\nIdentical content to src/shared.ts; not repeated.');
    expect(result.prompt.split('export function shared(').length - 1).toBe(1);
    expect(result.diagnostics.budget!.dedupedChars).toBeLessThan(result.diagnostics.budget!.candidateChars);
  });

  it('exposes every budget decision as telemetry', async () => {
    const root = await tempRoot('oa-ctx-telemetry-');
    await writeSourceTree(root, 30, 3_000);
    const { budget, result } = await build(root, OVERVIEW_QUERY, 32_768);
    expect(result.diagnostics.budget).toEqual(expect.objectContaining({
      candidateChars: expect.any(Number),
      dedupedChars: expect.any(Number),
      budgetChars: budget.budgetChars,
      selectedChars: result.prompt.length,
      droppedFiles: expect.any(Number),
      selectedFiles: result.files.length,
      modelContext: 32_768,
      reservedTokens: budget.reservedTokens,
      limitedBy: 'model_context',
      overviewQuery: true,
    }));
  });

  it('an explicit token budget far above the plan can no longer push the package past its character bound', async () => {
    const root = await tempRoot('oa-ctx-legacy-');
    await writeSourceTree(root, 80, 4_000);
    const budget = planRepositoryContextBudget({ modelContextTokens: 32_768, objective: OVERVIEW_QUERY });
    const result = await new RepositoryContextService(root).build({
      query: OVERVIEW_QUERY,
      mode: 'ask',
      model: 'fixture-model',
      providerType: 'ollama',
      tokenBudget: 1_000_000,
      budget,
    });
    assertBounded(result, budget);
    // Without a plan the hard ceiling still applies.
    const unplanned = await new RepositoryContextService(root).build({
      query: OVERVIEW_QUERY, mode: 'agent', model: 'fixture-model', providerType: 'ollama', tokenBudget: 1_000_000,
    });
    expect(unplanned.prompt.length).toBeLessThanOrEqual(REPOSITORY_CONTEXT_HARD_MAX_CHARS);
  });
});
