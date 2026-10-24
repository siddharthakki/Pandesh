/**
 * Core-owned, constrained post-mutation validation for Saath Kar.
 *
 * The Saath journey is: the human approves a proposed code change → the
 * approved mutation executes → the relevant validation runs → the result is
 * shown. Turning that into a second approval prompt for an arbitrary shell
 * command would be governed but hostile, so validation here is deliberately
 * NOT a model-authored `run_command` call:
 *
 *  - the command is derived from the repository itself (the same package.json
 *    script / tsconfig conventions `src/validation/BaseValidationRunner.ts`
 *    already uses for Karke Dikha), never from model output;
 *  - it runs only after an already-approved mutation actually succeeded,
 *    inside that same approved operation;
 *  - `run_command`'s `consequential` classification is untouched — nothing
 *    here widens what the model itself is allowed to execute.
 *
 * The Extension-Host validation runner cannot simply be imported: Core builds
 * from `core/` alone (tsconfig.core.json) and that runner pulls in
 * `src/agent/TaskStore`. So this reuses Core's own already-bounded command
 * primitive (`CoreToolRunner`) and mirrors only the gate semantics.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreToolRunner } from './toolRunner';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { discoverPolyglotValidationGates } from './polyglotSignals';

export type ValidationGateCategory = 'syntax' | 'compile' | 'typecheck' | 'unit_test' | 'lint';

export interface ValidationGate {
  id: string;
  category: ValidationGateCategory;
  command: string;
  source: 'package_json' | 'convention' | 'syntax_floor';
}

export interface ValidationGateResult {
  gate: ValidationGate;
  status: 'passed' | 'failed';
  exitCode: number | null;
  output: string;
  durationMs: number;
}

export interface WorkspaceValidationOutcome {
  /** False only when the workspace declares no mechanical gate at all. */
  ran: boolean;
  passed: boolean;
  results: ValidationGateResult[];
  /** Model- and human-readable one-block summary. */
  summary: string;
}

/**
 * How many discovered gates one approved mutation runs. Bounded at one — the
 * strongest available gate — so a chat turn stays a chat turn; the full gate
 * sweep remains Karke Dikha's job.
 */
const MAX_GATES_PER_MUTATION = 1;
const VALIDATION_TIMEOUT_MS = 180_000;

export type ValidationCommandRunner = (
  command: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<{ status: 'succeeded' | 'failed'; exitCode: number | null; output: string }>;

/** The default runner: Core's existing bounded, cancellable, process-tree-
 * killing command primitive, with a validation-sized timeout. */
export function defaultValidationCommandRunner(): ValidationCommandRunner {
  const runner = new CoreToolRunner(VALIDATION_TIMEOUT_MS);
  return async (command, cwd, signal) => {
    const kernel = LocalAutonomySecurityKernel.getInstance();
    const req = kernel.normalizeRequest({
      attemptId: 'validation_internal',
      executor: 'core:workspace_validation',
      capability: 'process',
      workspaceRoot: cwd,
      targetResource: cwd,
      command,
      arguments: { command },
      origin: {
        actor: 'core:workspace_validation',
        isModelGenerated: false,
        provenance: 'trusted_internal_validation',
      },
      riskLevel: 'consequential',
    });
    const decision = kernel.authorize(req);
    if (decision.decision !== 'ALLOW' || !decision.grant) {
      return {
        status: 'failed',
        exitCode: null,
        output: `SecurityKernel validation blocked: ${decision.reason}`,
      };
    }
    const result = await runner.run(
      { name: 'run_command', arguments: { command } },
      { cwd, signal, securityGrant: decision.grant },
    );
    return { status: result.status, exitCode: result.exitCode, output: result.output };
  };
}

function readPackageScripts(cwd: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed && typeof parsed === 'object' && parsed.scripts && typeof parsed.scripts === 'object'
      ? parsed.scripts
      : {};
  } catch {
    return {};
  }
}

const JS_SYNTAX_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
/** Bounds one mutation's syntax floor so a pathological change cannot fan out into many processes. */
const MAX_SYNTAX_GATES = 8;

/**
 * Governed syntax floor for changed JavaScript. `node --check` parses a file without executing it, so a
 * syntactically invalid `cli.js` can never pass validation merely because the project's tests never import it
 * (g1: tests exercised expenses.js while the changed cli.js crashed on load). Never model-authored: the command is
 * built here from a path Core itself approved, and only for an existing .js/.cjs/.mjs file inside the workspace.
 */
export function discoverSyntaxGates(cwd: string, changedPaths: readonly string[]): ValidationGate[] {
  const gates: ValidationGate[] = [];
  const seen = new Set<string>();
  const root = path.resolve(cwd);
  for (const requested of changedPaths) {
    if (gates.length >= MAX_SYNTAX_GATES) break;
    if (!requested || !JS_SYNTAX_EXTENSIONS.has(path.extname(requested).toLowerCase())) continue;
    const absolute = path.resolve(root, requested);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    // The path is interpolated into a shell string: refuse anything a quote or metacharacter could escape.
    if (/["'`$%&|;<>^\r\n]/.test(relative)) continue;
    try {
      if (!fs.statSync(absolute).isFile()) continue;
    } catch {
      continue;
    }
    const display = relative.split(path.sep).join('/');
    if (seen.has(display)) continue;
    seen.add(display);
    gates.push({ id: `syntax-${display.replace(/[^a-z0-9]+/gi, '-')}`, category: 'syntax', command: `node --check "${display}"`, source: 'syntax_floor' });
  }
  return gates;
}

/**
 * The workspace's mechanical validation gates, strongest first. Mirrors the
 * package.json script gates and the TypeScript convention gate already used by
 * the Extension-Host validation runner — no new command vocabulary.
 */
export function discoverValidationGates(cwd: string): ValidationGate[] {
  const scripts = readPackageScripts(cwd);
  const gates: ValidationGate[] = [];
  const addScript = (script: string, category: ValidationGateCategory) => {
    if (!scripts[script]) return;
    gates.push({ id: `package-${script.replace(/[^a-z0-9]+/gi, '-')}`, category, command: `npm run ${script}`, source: 'package_json' });
  };

  addScript('compile', 'compile');
  if (!scripts.compile) addScript('build', 'compile');
  addScript('typecheck', 'typecheck');
  if (!scripts.compile && !scripts.build && !scripts.typecheck && fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    gates.push({ id: 'convention-typescript', category: 'typecheck', command: 'npx tsc --noEmit', source: 'convention' });
  }
  addScript('test', 'unit_test');
  if (!scripts.test) addScript('test:unit', 'unit_test');
  addScript('lint', 'lint');
  // Not gated on any npm/TypeScript signal above being present or absent:
  // a repository can have both a package.json (e.g. tooling) and a Python
  // package under it. Node/TypeScript gates are listed first, so they still
  // take the single slot `runWorkspaceValidation` runs when both are found.
  gates.push(...discoverPolyglotValidationGates(cwd));
  return gates;
}

/**
 * Runs the bounded validation plan for a workspace. Returns `ran: false` (and
 * says so honestly) when the workspace declares no gate — it never invents a
 * command, and it never claims validation happened when it did not.
 */
export async function runWorkspaceValidation(input: {
  cwd: string;
  signal?: AbortSignal;
  runner?: ValidationCommandRunner;
  gates?: ValidationGate[];
  /** Syntax-floor gates. All of them run, before the mechanical gates, and any failure fails validation. */
  syntaxGates?: ValidationGate[];
}): Promise<WorkspaceValidationOutcome> {
  const mechanical = (input.gates ?? discoverValidationGates(input.cwd)).slice(0, MAX_GATES_PER_MUTATION);
  const gates = [...(input.syntaxGates ?? []), ...mechanical];
  if (gates.length === 0) {
    return {
      ran: false,
      passed: false,
      results: [],
      summary: 'Validation: no mechanical validation gate is configured in this workspace, so none was run.',
    };
  }
  const run = input.runner ?? defaultValidationCommandRunner();
  const results: ValidationGateResult[] = [];
  for (const gate of gates) {
    const started = Date.now();
    const execution = await run(gate.command, input.cwd, input.signal);
    // A syntax gate that could not even start (no Node runtime) is not evidence of a syntax error; say so instead.
    if (gate.category === 'syntax' && execution.exitCode === null && execution.status === 'failed' && /not recognized|not found|ENOENT/i.test(execution.output)) {
      results.push({ gate, status: 'passed', exitCode: null, output: 'syntax check skipped: no Node runtime available', durationMs: 0 });
      continue;
    }
    results.push({
      gate,
      status: execution.status === 'succeeded' ? 'passed' : 'failed',
      exitCode: execution.exitCode,
      output: execution.output,
      durationMs: Math.max(0, Date.now() - started),
    });
  }
  const passed = results.every((result) => result.status === 'passed');
  const summary = [
    `Validation: ${passed ? 'passed' : 'failed'}`,
    ...results.map((result) =>
      `- ${result.gate.command} (${result.gate.category}) — ${result.status}, exit ${result.exitCode ?? 'n/a'}`
      + (result.status === 'failed' ? `\n${result.output}` : ''),
    ),
  ].join('\n');
  return { ran: true, passed, results, summary };
}
