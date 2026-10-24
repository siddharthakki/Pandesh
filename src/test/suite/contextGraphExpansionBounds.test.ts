import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RepositoryIndex } from '../../context/RepositoryIndex';
import { ContextSelector } from '../../context/ContextSelector';
import { RepositoryContextResult } from '../../context/RepositoryTypes';

async function write(root: string, relative: string, content: string): Promise<void> {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, 'utf8');
}

function scoreOf(result: RepositoryContextResult, target: string): number {
  const entry = result.diagnostics.selectedFiles.find(file => file.path === target);
  if (!entry) { throw new Error(`${target} was not selected: ${result.diagnostics.selectedFiles.map(f => f.path).join(', ')}`); }
  return entry.score;
}

function graphBonusOf(result: RepositoryContextResult, target: string): number {
  const entry = result.diagnostics.selectedFiles.find(file => file.path === target);
  if (!entry) { throw new Error(`${target} was not selected`); }
  return entry.reasons
    .filter(reason => /^direct dependency of |^linked test for /.test(reason.reason))
    .reduce((total, reason) => total + reason.score, 0);
}

function rankOf(result: RepositoryContextResult, target: string): number {
  return result.diagnostics.selectedFiles.findIndex(file => file.path === target);
}

describe('context graph-expansion bounds', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-graph-bounds-'));
    await write(root, '.gitignore', '.ollama-agent/\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('ranks a strongly query-relevant file above high fan-in hub files', async () => {
    await write(root, 'src/models/TaskModelSelection.ts', [
      'export function classifyTaskRequirements() { return { tier: "local" }; }',
      'export function selectTaskModel() { return "qwen3-coder:30b"; }',
    ].join('\n'));
    await write(root, 'src/tools/ToolTypes.ts', 'export interface ToolCall { name: string; }\n');
    await write(root, 'src/tools/ToolRegistry.ts', 'export class Registry { list() { return []; } }\n');

    const dependents: string[] = [];
    for (let index = 0; index < 14; index += 1) {
      const relative = `src/runtime/Worker${index}.ts`;
      dependents.push(relative);
      await write(root, relative, [
        "import { ToolCall } from '../tools/ToolTypes';",
        "import { Registry } from '../tools/ToolRegistry';",
        `export const worker${index} = (call: ToolCall, registry: Registry) => [call, registry];`,
      ].join('\n'));
    }

    const snapshot = await new RepositoryIndex(root).build(true);
    const result = await new ContextSelector(root).select(snapshot, {
      query: 'Where is task-model selection implemented and what does it do?',
      role: 'reviewer',
      model: 'qwen3-coder:30b',
      tokenBudget: 20_000,
      maxFiles: 24,
      hints: { changedFiles: dependents },
    });

    expect(result.files[0]?.path).toBe('src/models/TaskModelSelection.ts');
    expect(rankOf(result, 'src/models/TaskModelSelection.ts')).toBe(0);
    expect(scoreOf(result, 'src/models/TaskModelSelection.ts'))
      .toBeGreaterThan(scoreOf(result, 'src/tools/ToolTypes.ts'));
    expect(scoreOf(result, 'src/models/TaskModelSelection.ts'))
      .toBeGreaterThan(scoreOf(result, 'src/tools/ToolRegistry.ts'));
    expect(graphBonusOf(result, 'src/tools/ToolTypes.ts')).toBeLessThanOrEqual(24);
    expect(graphBonusOf(result, 'src/tools/ToolRegistry.ts')).toBeLessThanOrEqual(24);
  });

  it('still lets graph structure order files of comparable direct relevance', async () => {
    await write(root, 'src/alpha/ClampHelper.ts', 'export function clamp(value: number) { return Math.max(0, value); }\n');
    await write(root, 'src/beta/ClampHelper.ts', 'export function clamp(value: number) { return Math.max(0, value); }\n');
    await write(root, 'src/runtime/Worker0.ts', [
      "import { clamp } from '../beta/ClampHelper';",
      'export const worker0 = (value: number) => clamp(value);',
    ].join('\n'));

    const snapshot = await new RepositoryIndex(root).build(true);
    const result = await new ContextSelector(root).select(snapshot, {
      query: 'clamp helper',
      role: 'reviewer',
      model: 'qwen3-coder:30b',
      tokenBudget: 20_000,
      maxFiles: 24,
      hints: { changedFiles: ['src/runtime/Worker0.ts'] },
    });

    // Both files carry identical direct relevance and 'src/alpha/...' wins the
    // path tie-break, so beta can only lead because the graph signal survives.
    expect(result.files[0]?.path).toBe('src/beta/ClampHelper.ts');
    expect(result.files.some(file => file.path === 'src/alpha/ClampHelper.ts')).toBe(true);
    expect(scoreOf(result, 'src/beta/ClampHelper.ts'))
      .toBeGreaterThan(scoreOf(result, 'src/alpha/ClampHelper.ts'));
    expect(graphBonusOf(result, 'src/beta/ClampHelper.ts')).toBe(8);
    expect(graphBonusOf(result, 'src/alpha/ClampHelper.ts')).toBe(0);
  });

  it('bounds the total graph-expansion bonus regardless of how many dependents point at a file', async () => {
    await write(root, 'src/hubs/AlphaHub.ts', 'export interface AlphaContract { id: string; }\n');
    await write(root, 'src/hubs/BetaHub.ts', 'export interface BetaContract { id: string; }\n');

    const dependents: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const relative = `src/runtime/Worker${index}.ts`;
      dependents.push(relative);
      const imports = index < 4
        ? ["import { AlphaContract } from '../hubs/AlphaHub';", "import { BetaContract } from '../hubs/BetaHub';"]
        : ["import { BetaContract } from '../hubs/BetaHub';"];
      const body = index < 4
        ? `export const worker${index} = (a: AlphaContract, b: BetaContract) => [a, b];`
        : `export const worker${index} = (b: BetaContract) => b;`;
      await write(root, relative, [...imports, body].join('\n'));
    }

    const snapshot = await new RepositoryIndex(root).build(true);
    const result = await new ContextSelector(root).select(snapshot, {
      query: 'unrelated question about scheduling policy',
      role: 'reviewer',
      model: 'qwen3-coder:30b',
      tokenBudget: 20_000,
      maxFiles: 40,
      hints: { changedFiles: dependents },
    });

    // AlphaHub has 4 dependents, BetaHub has 16. Both saturate the cap, so the
    // extra 12 dependents buy BetaHub nothing.
    expect(graphBonusOf(result, 'src/hubs/AlphaHub.ts')).toBe(24);
    expect(graphBonusOf(result, 'src/hubs/BetaHub.ts')).toBe(24);
    expect(scoreOf(result, 'src/hubs/BetaHub.ts')).toBe(scoreOf(result, 'src/hubs/AlphaHub.ts'));
    for (const file of result.diagnostics.selectedFiles) {
      expect(graphBonusOf(result, file.path)).toBeLessThanOrEqual(24);
    }
  });
});
