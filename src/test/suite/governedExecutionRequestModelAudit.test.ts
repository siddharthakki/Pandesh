import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Full model-selection authority regression (item 1 of the trivial-task-routing
 * fix): enumerates every production source file that constructs a
 * GovernedCodingExecutionRequest (i.e. calls a GovernedCodingExecutor's
 * `.execute({ ... })`) and asserts each call site sets `model:` explicitly.
 *
 * `GovernedCodingExecutor.execute` itself falls back to `Config.getCodingModel()`
 * when `request.model` is omitted (see GovernedCodingExecutor.ts). That fallback
 * must only ever be reached because a caller *deliberately* passed no
 * per-task-selected model (e.g. a manual command with no task-model-selection
 * UI, which must say so in a comment) — never because a call site forgot the
 * field. If a new production call site is added without a `model:` key, this
 * test fails and forces an explicit, reviewed decision instead of a silent
 * fallthrough.
 */
describe('GovernedCodingExecutionRequest construction sites always set model explicitly', () => {
  const srcRoot = path.resolve(__dirname, '../../..', 'src');

  function listProductionTsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test') continue;
        out.push(...listProductionTsFiles(full));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  /** Finds `<expr>.execute({ ... })` call sites and returns the object-literal body text. */
  function findExecuteCallBodies(source: string): string[] {
    const bodies: string[] = [];
    const callRegex = /\.execute\(\{/g;
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(source))) {
      const start = match.index + match[0].length - 1; // index of the opening '{'
      let depth = 0;
      let end = -1;
      for (let i = start; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) continue;
      bodies.push(source.slice(start, end + 1));
    }
    return bodies;
  }

  /** A call site is a GovernedCodingExecutionRequest construction if it has the
   * request shape's load-bearing fields (runId + goal + workspaceRoot + callbacks),
   * which no other `.execute({` call in this codebase shares. */
  function looksLikeGovernedCodingExecutionRequest(body: string): boolean {
    return ['runId', 'goal', 'workspaceRoot', 'callbacks'].every(token => new RegExp(`\\b${token}\\b`).test(body));
  }

  const knownProductionCallSites = ['ForgeCodingTaskController.ts', 'M15AutonomousRuntime.ts'];

  it('every known production call site is still present and sets model and execution profile explicitly', () => {
    const files = listProductionTsFiles(srcRoot);
    const seen = new Set<string>();

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const bodies = findExecuteCallBodies(source).filter(looksLikeGovernedCodingExecutionRequest);
      if (bodies.length === 0) continue;
      seen.add(path.basename(file));
      for (const body of bodies) {
        expect(
          /\bmodel:\s*\S/.test(body) || /[{,]\s*model\s*[,}]/.test(body),
          `${path.relative(srcRoot, file)}: GovernedCodingExecutionRequest construction is missing an explicit ` +
            `'model:' field. If this call site genuinely has no per-task selected model, pass ` +
            `'model: Config.getCodingModel()' explicitly (with a comment explaining why) rather than omitting ` +
            'the field and relying on the executor\'s implicit fallback.',
        ).toBe(true);
        expect(
          /\bexecutionProfile:\s*\S/.test(body) || /[{,]\s*executionProfile\s*[,}]/.test(body),
          `${path.relative(srcRoot, file)}: GovernedCodingExecutionRequest construction is missing an explicit execution profile. ` +
            'A missing profile must fail closed instead of silently selecting the full graph.',
        ).toBe(true);
      }
    }

    // Guards against a new production call site slipping in unaudited, and
    // against this test silently going blind if a known site is renamed/removed.
    for (const known of knownProductionCallSites) {
      expect(seen.has(known), `expected a GovernedCodingExecutionRequest construction in ${known}`).toBe(true);
    }
    expect(seen.size, `unexpected new/removed production call sites: ${[...seen].join(', ')}`).toBe(
      knownProductionCallSites.length,
    );
  });
});
