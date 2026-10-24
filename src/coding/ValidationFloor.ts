import * as fs from 'fs/promises';
import * as path from 'path';
import { loadRepositoryIntel } from '../autonomy/RepositoryIntel';
import { isTestPath } from '../context/RepositoryIndex';
import type { CodingValidationCommand } from './CodingProposal';

/**
 * What the run can honestly say about how well the change was validated.
 * `semantic`: at least one test-class validator ran. `structural_only`: only a
 * syntax/type check. `semantic_validation_unavailable`: nothing but
 * whitespace/status checks, because KKD knows of no meaningful validator.
 */
export type ValidationConfidence = 'semantic' | 'structural_only' | 'semantic_validation_unavailable';

export interface ValidationEnvelope {
  /** Governed floor first, then the model's own suggestions (additive, deduplicated). */
  commands: CodingValidationCommand[];
  /** Commands the floor contributed that the model did not already request. */
  floorAdded: CodingValidationCommand[];
  confidence: ValidationConfidence;
  reasons: string[];
  /** Model-requested npm validators that cannot run here (no package.json / no such script). Never a model-quality failure. */
  inapplicableDropped: CodingValidationCommand[];
}

const NPM_PLACEHOLDER_TEST = /no test specified/i;
const NPM_SEMANTIC_SCRIPT = /^(test|verify|check)(:|$)/;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

export function validationCommandKey(command: CodingValidationCommand): string {
  return JSON.stringify({ kind: command.kind, args: command.args ?? [], script: command.script });
}

/** A validator that exercises behaviour, as opposed to whitespace/status/type checks. */
export function isSemanticValidator(command: CodingValidationCommand): boolean {
  switch (command.kind) {
    case 'vitest':
    case 'pytest':
    case 'npm-test':
      return true;
    case 'npm-script':
      return NPM_SEMANTIC_SCRIPT.test(command.script ?? '');
    default:
      return false;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

function stem(file: string): string {
  return path.posix.basename(file, path.posix.extname(file)).replace(/^test_|_test$|\.(test|spec)$/g, '').toLowerCase();
}

/**
 * Builds the governed minimum validation envelope for a change. The model may
 * add validators but can never remove or weaken what KKD requires. Reuses the
 * existing repository intelligence, manifest scripts and command kinds; it
 * never requires Git and never invents a validator KKD cannot already run.
 */
export async function deriveValidationEnvelope(input: {
  workspaceRoot: string;
  /** Workspace-relative paths the proposal creates or replaces. */
  changedPaths: readonly string[];
  modelCommands: readonly CodingValidationCommand[];
  signal?: AbortSignal;
}): Promise<ValidationEnvelope> {
  const reasons: string[] = [];
  const floor: CodingValidationCommand[] = [];
  const changed = input.changedPaths.map(item => item.replace(/\\/g, '/'));
  const production = changed.filter(item => SOURCE_EXTENSIONS.has(path.posix.extname(item)) && !isTestPath(item));

  if (production.length > 0) {
    const pkg = await readJson(path.join(input.workspaceRoot, 'package.json'));
    const scripts = (pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, unknown>;
    const testScript = typeof scripts.test === 'string' && !NPM_PLACEHOLDER_TEST.test(scripts.test) ? scripts.test : undefined;
    const intel = await loadRepositoryIntel({ workspaceRoot: input.workspaceRoot, signal: input.signal });

    // Relevant tests: import/reference links first, then same-basename tests.
    const relevant = new Set<string>();
    for (const file of production) {
      for (const test of intel.testsFor(file)) relevant.add(test);
    }
    const testPaths = intel.testPaths();
    for (const candidate of production) {
      const base = stem(candidate);
      for (const testPath of testPaths) {
        if (stem(testPath) === base) relevant.add(testPath);
      }
    }
    const relevantTests = [...relevant].sort();
    const pythonChanged = production.some(item => item.endsWith('.py'));
    const jsChanged = production.some(item => !item.endsWith('.py'));

    if (pythonChanged) {
      let pyTests = relevantTests.filter(item => item.endsWith('.py'));
      // No test links to the changed module by name or import: a lightweight repo (test_*.py, no manifest) is still
      // validated by its own python tests rather than by nothing.
      if (pyTests.length === 0) pyTests = testPaths.filter(item => item.endsWith('.py')).sort().slice(0, 8);
      if (pyTests.length > 0) {
        floor.push({ kind: 'pytest', args: pyTests });
        reasons.push(`relevant python tests: ${pyTests.join(', ')}`);
      }
    }
    // Syntax floor: a changed JS file must parse even when no test imports it (g1: cli.js crashed on load while the
    // project's tests, which only import expenses.js, passed).
    for (const file of production.filter(item => /\.(c|m)?js$/i.test(item)).slice(0, 8)) {
      if (await exists(path.join(input.workspaceRoot, file))) {
        floor.push({ kind: 'node-check', args: [file] });
      }
    }
    if (jsChanged) {
      const tsTests = relevantTests.filter(item => item.endsWith('.test.ts'));
      const hasVitest = await exists(path.join(input.workspaceRoot, 'node_modules', 'vitest', 'vitest.mjs'));
      if (testScript) {
        floor.push({ kind: 'npm-test' });
        reasons.push('manifest test script');
      } else if (tsTests.length > 0 && hasVitest) {
        floor.push({ kind: 'vitest', args: ['--run', ...tsTests] });
        reasons.push(`relevant vitest tests: ${tsTests.join(', ')}`);
      }
    }
    if (
      production.some(item => TS_EXTENSIONS.has(path.posix.extname(item)))
      && await exists(path.join(input.workspaceRoot, 'tsconfig.json'))
      && await exists(path.join(input.workspaceRoot, 'node_modules', 'typescript', 'bin', 'tsc'))
    ) {
      floor.push({ kind: 'tsc-no-emit' });
      reasons.push('typescript project structural check');
    }
  }

  // An npm validator is only applicable when the workspace's package.json declares the script it would run. Dropping
  // an inapplicable one (e.g. `npm test` in a Python-only workspace) is not weakening the floor: the floor above is
  // derived independently and is never reduced.
  const pkgNow = await readJson(path.join(input.workspaceRoot, 'package.json'));
  const scriptsNow = (pkgNow?.scripts && typeof pkgNow.scripts === 'object' ? pkgNow.scripts : {}) as Record<string, unknown>;
  const inapplicableDropped: CodingValidationCommand[] = [];
  const applicableModelCommands = input.modelCommands.filter(command => {
    const script = command.kind === 'npm-test' ? 'test' : command.kind === 'npm-script' ? command.script : undefined;
    if (script === undefined || typeof scriptsNow[script] === 'string') return true;
    inapplicableDropped.push(command);
    reasons.push(`inapplicable validator dropped: npm ${script === 'test' ? 'test' : `run ${script}`} (${pkgNow ? `package.json has no "${script}" script` : 'package.json was not found in the workspace'})`);
    return false;
  });

  const seen = new Set<string>();
  const commands: CodingValidationCommand[] = [];
  for (const command of [...floor, ...applicableModelCommands]) {
    const key = validationCommandKey(command);
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(command);
  }
  const modelKeys = new Set(applicableModelCommands.map(validationCommandKey));
  const floorAdded = floor.filter((command, index) =>
    !modelKeys.has(validationCommandKey(command)) && floor.findIndex(other => validationCommandKey(other) === validationCommandKey(command)) === index);

  let confidence: ValidationConfidence;
  if (commands.some(isSemanticValidator)) confidence = 'semantic';
  else if (commands.some(command => command.kind === 'tsc-no-emit' || command.kind === 'node-check')) confidence = 'structural_only';
  else confidence = 'semantic_validation_unavailable';
  if (confidence !== 'semantic' && production.length > 0) reasons.push('no semantic validator identified for the changed source');
  return { commands, floorAdded, confidence, reasons, inapplicableDropped };
}
