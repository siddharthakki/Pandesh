import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodingPlanner } from '../../coding/CodingPlanner';
import { GovernedModelExecutionDependency, GovernedModelExecutionOutcome } from '../../agent/GovernedModelExecutionDispatcher';
import { GovernedModelRequest } from '../../agent/GovernedModelExecutionTypes';
import { ResolvedModelDefaults } from '../../config/ResolvedModelDefaults';

function validProposal(summary = 'Create generated file'): string {
  return JSON.stringify({
    version: 1,
    taskSummary: summary,
    operations: [{ type: 'create', path: 'src/generated/planner.ts', reason: 'requested', content: 'export const planned = true;\n' }],
    validationCommands: [],
    warnings: [],
    status: 'proposed',
  });
}

class QueueDependency implements GovernedModelExecutionDependency {
  readonly requests: GovernedModelRequest[] = [];
  constructor(private readonly completions: string[]) {}
  async execute(request: GovernedModelRequest): Promise<GovernedModelExecutionOutcome> {
    this.requests.push(request);
    const completion = this.completions.shift();
    if (completion === undefined) {
      throw new Error('unexpected extra provider call');
    }
    return { completion, providerType: 'ollama' };
  }
}

describe('CodingPlanner bounded proposal repair', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-coding-planner-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'tsc --noEmit', test: 'vitest run' } }));
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'lib'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'existing.ts'), 'export const existing = true;\n');
    // codingModel defaults to '' ("Auto" — see Defaults.ts). In real usage
    // AgentPanel.loadModels() always runs discovery before CodingPlanner can
    // be reached and populates ResolvedModelDefaults with what Auto actually
    // selected (see Config.ts); GovernedModelExecutionDispatcher's request
    // contract requires a non-empty model, so this simulates that ordering.
    ResolvedModelDefaults.set('agent', 'qwen3-coder:30b');
  });

  afterEach(async () => {
    ResolvedModelDefaults.clear();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('accepts a valid first response with one structured provider call', async () => {
    const dependency = new QueueDependency([validProposal()]);
    const result = await new CodingPlanner(root, dependency).plan('create file');
    expect(result.proposal?.taskSummary).toBe('Create generated file');
    expect(result.metadata).toMatchObject({
      structuredOutputRequested: true,
      firstProposalCanonicalAndValid: true,
      repairAttempted: false,
      providerCallCount: 1,
    });
    expect(dependency.requests).toHaveLength(1);
    expect(dependency.requests[0].responseFormat?.schema).toBeDefined();
  });

  it('accepts a safely normalized first response with one provider call', async () => {
    const dependency = new QueueDependency([JSON.stringify({
      version: '1',
      task_summary: 'Alias proposal',
      file_operations: [{ type: 'add', path: 'src/generated/alias.ts', reason: 'alias', content: 'export const alias = true;\n' }],
      validationCommands: [],
      warnings: [],
      status: 'proposed',
    })]);
    const result = await new CodingPlanner(root, dependency).plan('create alias file');
    expect(result.proposal?.taskSummary).toBe('Alias proposal');
    expect(result.metadata.firstProposalNormalizedAndValid).toBe(true);
    expect(dependency.requests).toHaveLength(1);
  });

  it('repairs missing operation reason exactly once and reaches review', async () => {
    const dependency = new QueueDependency([
      JSON.stringify({
        version: 1,
        taskSummary: 'Missing reason',
        operations: [{ type: 'create', path: 'src/generated/missing.ts', content: 'export const missing = true;\n' }],
        validationCommands: [],
        warnings: [],
        status: 'proposed',
      }),
      validProposal('Repaired proposal'),
    ]);
    const result = await new CodingPlanner(root, dependency).plan('create repaired file');
    expect(result.proposal?.taskSummary).toBe('Repaired proposal');
    expect(result.metadata.repairAttempted).toBe(true);
    expect(result.metadata.repairedProposalValid).toBe(true);
    expect(result.metadata.providerCallCount).toBe(2);
    expect(dependency.requests).toHaveLength(2);
    expect(dependency.requests[1].prompt).toContain('operation_reason_required');
    expect(dependency.requests[1].responseFormat?.schema).toEqual(dependency.requests[0].responseFormat?.schema);
  });

  it('rejects invalid repaired proposals without a third provider call', async () => {
    const dependency = new QueueDependency([
      JSON.stringify({ version: 2, taskSummary: 'Wrong version', operations: [], validationCommands: [], warnings: [], status: 'proposed' }),
      JSON.stringify({ version: 2, taskSummary: 'Still wrong', operations: [], validationCommands: [], warnings: [], status: 'proposed' }),
    ]);
    const result = await new CodingPlanner(root, dependency).plan('create rejected file');
    expect(result.proposal).toBeUndefined();
    expect(result.errors).toContain('version_unsupported');
    expect(result.metadata.repairAttempted).toBe(true);
    expect(result.metadata.repairedProposalValid).toBe(false);
    expect(dependency.requests).toHaveLength(2);
  });

  it('does not repair non-repairable traversal, dangerous command or limit failures', async () => {
    for (const completion of [
      JSON.stringify({ version: 1, taskSummary: 'Traversal', operations: [{ type: 'create', path: '../x.ts', reason: 'x', content: 'x' }], validationCommands: [], warnings: [], status: 'proposed' }),
      JSON.stringify({ version: 1, taskSummary: 'Command', operations: [{ type: 'create', path: 'src/x.ts', reason: 'x', content: 'x' }], validationCommands: [{ kind: 'vitest', args: ['run', '&&'] }], warnings: [], status: 'proposed' }),
      JSON.stringify({ version: 1, taskSummary: 'Limit', operations: Array.from({ length: 13 }, (_, index) => ({ type: 'create', path: `src/${index}.ts`, reason: 'x', content: 'x' })), validationCommands: [], warnings: [], status: 'proposed' }),
    ]) {
      const dependency = new QueueDependency([completion]);
      const result = await new CodingPlanner(root, dependency).plan('bad proposal');
      expect(result.metadata.repairAttempted).toBe(false);
      expect(dependency.requests).toHaveLength(1);
    }
  });

  // Regression for the M-dogfood observed defect: a schema-valid proposal
  // naming a nonexistent Vitest path and claiming tsc-no-emit coverage for a
  // file outside the tsconfig scope must not reach `plan()`'s caller as a
  // usable proposal — even though parseAndValidateCodingProposal alone would
  // have accepted it.
  function observedDefectShapedProposal(summary: string): string {
    return JSON.stringify({
      version: 1,
      taskSummary: summary,
      operations: [{ type: 'replace', path: 'lib/outside.ts', reason: 'x', content: 'export const outside = true;\n' }],
      validationCommands: [
        { kind: 'tsc-no-emit' },
        { kind: 'vitest', args: ['run', 'src/does-not-exist.test.ts'] },
      ],
      warnings: [],
      status: 'proposed',
    });
  }

  it('rejects a validation plan with a nonexistent test path and out-of-scope tsc coverage, and repairs it via the bounded correction turn', async () => {
    const dependency = new QueueDependency([
      observedDefectShapedProposal('Bad plan'),
      validProposal('Repaired with real coverage'),
    ]);
    const result = await new CodingPlanner(root, dependency).plan('fix outside.ts');
    expect(result.proposal?.taskSummary).toBe('Repaired with real coverage');
    expect(result.metadata.repairAttempted).toBe(true);
    expect(result.metadata.repairedProposalValid).toBe(true);
    expect(dependency.requests).toHaveLength(2);
    expect(dependency.requests[1].prompt).toContain('validation_command_test_path_missing');
    expect(dependency.requests[1].prompt).toContain('validation_command_scope_uncovered');
  });

  it('never returns a usable proposal when the repaired plan repeats the same coverage gap', async () => {
    const dependency = new QueueDependency([
      observedDefectShapedProposal('Bad plan'),
      observedDefectShapedProposal('Still bad plan'),
    ]);
    const result = await new CodingPlanner(root, dependency).plan('fix outside.ts');
    expect(result.proposal).toBeUndefined();
    expect(result.errors).toEqual(expect.arrayContaining(['validation_command_test_path_missing', 'validation_command_scope_uncovered']));
    expect(result.metadata.repairedProposalValid).toBe(false);
    expect(dependency.requests).toHaveLength(2);
  });

  // End-to-end regression for the real OrcaRouter/gpt-5.6-sol direct-cloud
  // baseline run: an `operations: []` response (structurally present, but
  // empty — the provider did not honor the request schema's `minItems: 1`
  // the way Ollama's grammar-constrained decoding does) gets ONE bounded
  // repair turn like any other repairable structural failure, and — when
  // the repair turn ALSO comes back empty — fails closed as `invalid`
  // rather than ever reaching a usable proposal. Confirms CodingPlanner
  // never silently treats "the model said nothing" as "nothing to do".
  function emptyOperationsProposal(summary: string): string {
    return JSON.stringify({
      version: 1,
      taskSummary: summary,
      operations: [],
      validationCommands: [],
      warnings: [],
      status: 'proposed',
    });
  }

  it('repairs an empty-operations response once, and reaches a usable proposal if the repair names a real operation', async () => {
    const dependency = new QueueDependency([
      emptyOperationsProposal('No changes needed'),
      validProposal('Repaired with a real operation'),
    ]);
    const result = await new CodingPlanner(root, dependency).plan('investigate and fix the defect');
    expect(result.proposal?.taskSummary).toBe('Repaired with a real operation');
    expect(result.proposal?.operations.length).toBeGreaterThan(0);
    expect(result.metadata.repairAttempted).toBe(true);
    expect(dependency.requests).toHaveLength(2);
    expect(dependency.requests[1].prompt).toContain('operations_empty');
  });

  it('never returns a usable proposal, and never treats it as "no changes needed", when the repair is ALSO empty', async () => {
    const dependency = new QueueDependency([
      emptyOperationsProposal('No changes needed'),
      emptyOperationsProposal('Still no changes needed'),
    ]);
    const result = await new CodingPlanner(root, dependency).plan('investigate and fix the defect');
    expect(result.proposal).toBeUndefined();
    expect(result.errors).toContain('operations_empty');
    expect(result.metadata.repairedProposalValid).toBe(false);
    expect(dependency.requests).toHaveLength(2);
  });

  it('accepts the same changed path once backed by a real npm-test command instead of an out-of-scope tsc claim alone', async () => {
    const dependency = new QueueDependency([JSON.stringify({
      version: 1,
      taskSummary: 'Covered by npm-test',
      operations: [{ type: 'replace', path: 'lib/outside.ts', reason: 'x', content: 'export const outside = true;\n' }],
      validationCommands: [{ kind: 'tsc-no-emit' }, { kind: 'npm-test' }],
      warnings: [],
      status: 'proposed',
    })]);
    const result = await new CodingPlanner(root, dependency).plan('fix outside.ts');
    expect(result.proposal?.taskSummary).toBe('Covered by npm-test');
    expect(result.metadata.repairAttempted).toBe(false);
  });
});
