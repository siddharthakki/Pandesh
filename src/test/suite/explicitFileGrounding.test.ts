import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RepositoryIndex } from '../../context/RepositoryIndex';
import { ContextSelector } from '../../context/ContextSelector';

async function write(root: string, relative: string, content: string): Promise<void> {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, 'utf8');
}

/**
 * Baat Kar release invariant: when the user names a file that exists in the
 * workspace, that file's real bytes must reach the model. The live failure
 * this protects against was silent — hub files with high incidental term
 * overlap outscored the named `package.json`, exhausted the token budget, and
 * the named file was dropped with no signal, so the model refused a question
 * the repository could have answered.
 */
describe('explicit repository grounding', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-explicit-grounding-'));
    await write(root, '.gitignore', '.ollama-agent/\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('gives an explicitly named file the context budget before generic relevance fills it', async () => {
    await write(root, 'package.json', JSON.stringify({
      name: 'fixture',
      scripts: { compile: 'tsc -p ./', test: 'vitest run', bundle: 'node esbuild.js' },
    }, null, 2));
    // Decoys that mention the query's words far more often than package.json
    // does, and are large enough to exhaust a small budget between them.
    for (let index = 0; index < 6; index += 1) {
      await write(root, `src/hub${index}.ts`, [
        '// build test scripts repository npm build test scripts repository npm'.repeat(20),
        `export const hub${index} = () => 'build test scripts npm repository';`,
      ].join('\n'));
    }

    const snapshot = await new RepositoryIndex(root).build(true);
    const result = await new ContextSelector(root).select(snapshot, {
      query: 'Inspect package.json and tell me the exact npm scripts used to build and test this repository.',
      role: 'explainer',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      providerType: 'ollama',
      tokenBudget: 1_200,
      hints: { explicitFiles: ['package.json'] },
    });

    expect(result.files[0]?.path).toBe('package.json');
    expect(result.prompt).toContain('"compile": "tsc -p ./"');
    expect(result.diagnostics.rejectedFiles.some(file => file.path === 'package.json')).toBe(false);
  });

  it('names an explicitly requested file that could not be included instead of dropping it silently', async () => {
    // A single explicit file too large for the budget: the package must say so
    // rather than presenting itself as complete grounding.
    await write(root, 'huge.ts', `export const rows = [\n${'  "x",\n'.repeat(20_000)}];\n`);
    await write(root, 'src/small.ts', 'export const small = () => "huge rows";\n');

    const snapshot = await new RepositoryIndex(root).build(true);
    const result = await new ContextSelector(root).select(snapshot, {
      query: 'Explain huge.ts rows',
      role: 'explainer',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      providerType: 'ollama',
      tokenBudget: 60,
      hints: { explicitFiles: ['huge.ts'] },
    });

    if (!result.files.some(file => file.path === 'huge.ts') && result.prompt) {
      expect(result.prompt).toContain('could NOT be included');
      expect(result.prompt).toContain('huge.ts');
    }
  });
});
