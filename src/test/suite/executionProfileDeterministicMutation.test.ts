import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { GovernedCodingExecutor, GovernedCodingExecutionRequest } from '../../coding/GovernedCodingExecutor';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { classifyExecutionProfile, parseDeterministicFileWrite } from '../../orchestration/ExecutionProfile';

describe('Deterministic trivial-mutation execution path', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-trivial-mutation-'));
    await initGit(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function baseRequest(overrides: Partial<GovernedCodingExecutionRequest> = {}): GovernedCodingExecutionRequest {
    return {
      runId: 'trivial-test-1',
      goal: 'add a new file test.txt and write only Hello in it',
      workspaceRoot: root,
      signal: new AbortController().signal,
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
      auditSource: 'test',
      extensionBuild: 'test-build',
      executionProfile: classifyExecutionProfile('add a new file test.txt and write only Hello in it'),
      callbacks: {
        checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
        reviewProposal: async () => true,
        approveExecution: async () => true,
        confirmElevated: async () => true,
      },
      ...overrides,
    };
  }

  it('the exact acceptance-scenario goal is classified as trivial with a deterministic exact-content write extracted', () => {
    const profile = classifyExecutionProfile('add a new file test.txt and write only Hello in it');
    expect(profile.tier).toBe('trivial');
    const write = parseDeterministicFileWrite('add a new file test.txt and write only Hello in it');
    expect(write).toEqual({ path: 'test.txt', content: 'Hello' });
  });

  // PHASE 3 PHYSICAL DEFECT 1/3 regression: a physical acceptance run asked for
  // "Create healthcheck.txt with two exact lines. / Add an automated test
  // verifying the file exists and has exactly those lines. / Run validation."
  // as separate imperative sentences with no "and/then/also" conjunction. The
  // unbounded, unquoted content capture in CONTENT_FORMS swallowed the whole
  // trailing "Add an automated test..." sentence as literal file content, so
  // the goal was wrongly classified `trivial`/`useDeterministicProposal: true`
  // (surfaced in the UI as `host/deterministic`) even though the objective
  // required a second file (the test) that the deterministic single-create
  // path can never produce (`buildDeterministicCodingProposal` always emits
  // exactly one `create` operation and a no-op `git-status-short`
  // validation command). The task's real provider/model config
  // (ollama/qwen3.8) was never consulted because the classifier never routed
  // to the model at all — this was not a provider leak.
  it('does not extract a deterministic single-file write when a second imperative instruction follows on its own line', () => {
    const goal = [
      'Create healthcheck.txt with two exact lines.',
      'Add an automated test verifying the file exists and has exactly those lines.',
      'Run validation.',
      'Do not modify unrelated files.',
    ].join('\n');

    const write = parseDeterministicFileWrite(goal);
    expect(write).toBeUndefined();

    const profile = classifyExecutionProfile(goal);
    expect(profile.useDeterministicProposal).toBe(false);
    expect(profile.deterministicExtraction.status).toBe('unavailable');
    expect(profile.deterministicExtraction.reason).toBe('multiple_instructions');
  });

  it('still extracts a deterministic write for genuinely single-instruction, multi-line literal content', () => {
    const write = parseDeterministicFileWrite('create notes.txt with the exact content "first line\nsecond line"');
    expect(write).toEqual({ path: 'notes.txt', content: 'first line\nsecond line' });
  });

  it('fails closed before model or graph construction when the execution profile is missing', async () => {
    const progressEvents: string[] = [];
    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest({
      executionProfile: undefined,
      callbacks: {
        checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
        reviewProposal: async () => true,
        approveExecution: async () => true,
        confirmElevated: async () => true,
        onProgress: phase => progressEvents.push(phase),
      },
    }));

    expect(result.status).toBe('execution_profile_missing');
    expect(result.graph).toBeUndefined();
    expect(progressEvents).toEqual(['execution_profile_rejected reason=missing']);
  });

  it('rejects a caller-forged complex profile for the trivial goal before graph construction', async () => {
    const forged = classifyExecutionProfile('implement a cross-cutting architecture redesign');
    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest({
      executionProfile: forged,
      deterministicProposal: undefined,
    }));

    expect(result.status).toBe('execution_profile_invalid');
    expect(result.graph).toBeUndefined();
  });

  it('completes via the deterministic path — no graph_execution progress event, no model, exact file content', async () => {
    const progressEvents: string[] = [];
    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest({
      deterministicProposal: { path: 'test.txt', content: 'Hello', reason: 'Deterministic exact-content file write.' },
      callbacks: {
        checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
        reviewProposal: async () => true,
        approveExecution: async () => true,
        confirmElevated: async () => true,
        onProgress: phase => progressEvents.push(phase),
      },
    }));

    expect(result.status).toBe('completed');
    expect(result.graph).toBeUndefined();
    expect(progressEvents.some(event => event.startsWith('graph_execution'))).toBe(false);
    expect(progressEvents.some(event => event.startsWith('graph_stage'))).toBe(false);
    expect(progressEvents).toContain('deterministic_proposal_generated');
    expect(result.mutationEvidence).toMatchObject({
      instructionRevision: 0,
      expectedPaths: ['test.txt'],
      changedPaths: ['test.txt'],
      contentVerified: true,
      gitDiffPresent: true,
      alreadySatisfied: false,
    });

    const written = await fs.readFile(path.join(root, 'test.txt'), 'utf8');
    expect(written).toBe('Hello');
  });

  it('still requires proposal and execution approval for a deterministic mutation', async () => {
    let reviewCalled = false;
    let approveCalled = false;
    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest({
      deterministicProposal: { path: 'test.txt', content: 'Hello', reason: 'Deterministic exact-content file write.' },
      callbacks: {
        checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
        reviewProposal: async () => { reviewCalled = true; return false; },
        approveExecution: async () => { approveCalled = true; return true; },
        confirmElevated: async () => true,
      },
    }));

    expect(reviewCalled).toBe(true);
    expect(approveCalled).toBe(false);
    expect(result.status).toBe('proposal_rejected');
    await expect(fs.access(path.join(root, 'test.txt'))).rejects.toThrow();
  });

  it('surfaces a create-target-exists conflict as evidence rather than silently succeeding or retrying with a model', async () => {
    await fs.writeFile(path.join(root, 'test.txt'), 'already here');
    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest({
      deterministicProposal: { path: 'test.txt', content: 'Hello', reason: 'Deterministic exact-content file write.' },
    }));

    expect(result.status).toBe('create_target_exists');
    expect(result.proposalConflictEvidence?.regeneratedProposalValidationResult).toBe('unavailable');
  });

  it('cannot report successful validation when a requested create has no Git delivery candidate', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), '*.txt\n');
    await git(root, ['add', '.gitignore']);
    await git(root, ['commit', '-m', 'ignore txt fixtures']);
    const executor = new GovernedCodingExecutor();
    const progressEvents: string[] = [];
    const result = await executor.execute(baseRequest({
      deterministicProposal: { path: 'note.txt', content: 'Hello', reason: 'Create exact file.' },
      callbacks: {
        checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
        reviewProposal: async () => true,
        approveExecution: async () => true,
        confirmElevated: async () => true,
        onProgress: phase => progressEvents.push(phase),
      },
    }));

    expect(result.status).toBe('mutation_evidence_missing');
    expect(result.validationPhase.status).toBe('not_started');
    expect(progressEvents.some(event => event.startsWith('validating'))).toBe(false);
    await expect(fs.readFile(path.join(root, 'note.txt'), 'utf8')).resolves.toBe('Hello');
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  });
});

async function git(root: string, args: string[]): Promise<string> {
  const { execFile } = await import('child_process');
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

async function initGit(root: string): Promise<void> {
  const { spawn } = await import('child_process');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['commit', '--allow-empty', '-m', 'init'],
  ]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`)));
    });
  }
}
