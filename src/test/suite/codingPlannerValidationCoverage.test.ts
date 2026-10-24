import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { findValidationPlanCoverageErrors } from '../../coding/CodingPlanner';

/**
 * Regression coverage for the M-dogfood defect: a schema-valid CodingProposal
 * that named a nonexistent Vitest test path, and separately claimed
 * tsc-no-emit coverage for a file outside the compiler's own tsconfig scope,
 * both passed structural validation and nearly reached delivery. See
 * src/coding/CodingPlanner.ts (findValidationPlanCoverageErrors) and its
 * wiring into CodingPlanner.plan() and FixedMultiAgentGraph's
 * consumeValidatorProposal().
 */
describe('findValidationPlanCoverageErrors', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-validation-coverage-'));
    await fs.mkdir(path.join(workspaceRoot, 'src', 'test', 'suite'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, 'tsconfig.json'),
      JSON.stringify({ include: ['src/**/*.ts'], exclude: ['src/test/**'] }),
    );
    await fs.writeFile(path.join(workspaceRoot, 'src', 'test', 'suite', 'real.test.ts'), 'export {};\n');
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('rejects a vitest command naming a test file that does not exist', async () => {
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'create', path: 'src/a.ts', reason: 'x', content: 'x' }],
      validationCommands: [{ kind: 'vitest', args: ['run', 'src/test/suite/does-not-exist.test.ts'] }],
    });
    expect(errors).toContain('validation_command_test_path_missing');
  });

  it('accepts a vitest command naming a real, existing test file', async () => {
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'create', path: 'src/a.ts', reason: 'x', content: 'x' }],
      validationCommands: [{ kind: 'vitest', args: ['run', 'src/test/suite/real.test.ts'] }],
    });
    expect(errors).not.toContain('validation_command_test_path_missing');
  });

  it('rejects tsc-no-emit as coverage for a changed path outside the tsconfig scope', async () => {
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'replace', path: 'lib/outside.ts', reason: 'x', content: 'x' }],
      validationCommands: [{ kind: 'tsc-no-emit' }],
    });
    expect(errors).toContain('validation_command_scope_uncovered');
  });

  it('accepts tsc-no-emit as coverage for a changed path inside the tsconfig scope', async () => {
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'replace', path: 'src/inside.ts', reason: 'x', content: 'x' }],
      validationCommands: [{ kind: 'tsc-no-emit' }],
    });
    expect(errors).toEqual([]);
  });

  it('accepts an out-of-scope tsc path when a real test-shaped command is also present', async () => {
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'replace', path: 'lib/outside.ts', reason: 'x', content: 'x' }],
      validationCommands: [{ kind: 'tsc-no-emit' }, { kind: 'npm-test' }],
    });
    expect(errors).toEqual([]);
  });

  it('does not newly police a plan with no tsc-no-emit command at all (unchanged, pre-existing behavior)', async () => {
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'create', path: 'lib/outside.ts', reason: 'x', content: 'x' }],
      validationCommands: [],
    });
    expect(errors).toEqual([]);
  });

  it('treats a missing tsconfig.json as tsc default (broad) coverage rather than uncovered', async () => {
    await fs.rm(path.join(workspaceRoot, 'tsconfig.json'));
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'create', path: 'lib/outside.ts', reason: 'x', content: 'x' }],
      validationCommands: [{ kind: 'tsc-no-emit' }],
    });
    expect(errors).toEqual([]);
  });

  it('reproduces the exact observed dogfood shape: nonexistent vitest path AND out-of-scope tsc together', async () => {
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'replace', path: 'lib/approvals.ts', reason: 'x', content: 'x' }],
      validationCommands: [
        { kind: 'tsc-no-emit' },
        { kind: 'vitest', args: ['run', 'src/test/suite/approvals.test.ts'] },
      ],
    });
    expect(errors).toEqual(expect.arrayContaining(['validation_command_test_path_missing', 'validation_command_scope_uncovered']));
  });

  it('a delete operation is never subject to the scope-coverage check', async () => {
    const errors = await findValidationPlanCoverageErrors(workspaceRoot, {
      operations: [{ type: 'delete', path: 'lib/outside.ts', reason: 'x' }],
      validationCommands: [{ kind: 'tsc-no-emit' }],
    });
    expect(errors).toEqual([]);
  });
});
