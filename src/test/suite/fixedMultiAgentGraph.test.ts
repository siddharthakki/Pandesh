import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
  FIXED_MULTI_AGENT_STAGES,
  FixedMultiAgentGraph,
  FixedMultiAgentRepositoryContextProvider,
} from '../../orchestration/FixedMultiAgentGraph';
import {
  GovernedModelExecutionDependency,
  GovernedModelExecutionDispatcher,
  GovernedModelExecutionOutcome,
} from '../../agent/GovernedModelExecutionDispatcher';
import { GovernedModelRequest } from '../../agent/GovernedModelExecutionTypes';
import { CODING_PROPOSAL_MAX_RESPONSE_BYTES } from '../../coding/CodingProposal';
import {
  FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD,
  ReadOnlyForgeCallableSurface,
} from '../../agent/ForgeCallableSurface';
import { ReadOnlyForgeInvocationAdapter } from '../../agent/ForgeInvocationAdapter';

function dependency(
  impl: (request: GovernedModelRequest) => Promise<GovernedModelExecutionOutcome>,
): GovernedModelExecutionDependency {
  return { execute: vi.fn(impl) };
}

function contextProvider(): FixedMultiAgentRepositoryContextProvider {
  return {
    build: vi.fn(async request => ({
      prompt: `context for ${request.role}: RAW_REPOSITORY_CONTENT_SENTINEL`,
      files: [{
        path: `${request.role ?? 'general'}.ts`,
        score: 1,
        estimatedTokens: 7,
        reasons: [{ reason: 'test', score: 1 }],
        snippet: 'RAW_REPOSITORY_CONTENT_SENTINEL',
        truncated: false,
      }],
      diagnostics: {
        queryTerms: [],
        providerContextWindow: 8192,
        inputBudget: 1000,
        estimatedTokens: 7,
        omittedCount: 1,
        selectedFiles: [{
          path: `${request.role ?? 'general'}.ts`,
          score: 1,
          estimatedTokens: 7,
          reasons: [{ reason: 'test', score: 1 }],
        }],
        rejectedFiles: [],
        inventorySize: 1,
        inventoryTruncated: false,
      },
      index: {
        schemaVersion: 2,
        workspaceRoot: '/repo',
        identity: {
          repositoryRoot: '/repo',
          branch: 'main',
          headCommit: 'abc',
          worktree: '/repo',
          detached: false,
          schemaVersion: 1,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        state: 'ready',
        files: [],
        ignoredPatterns: [],
        truncated: false,
        statistics: {
          files: 1,
          symbols: 0,
          imports: 0,
          tests: 0,
          configs: 0,
          buildFiles: 0,
          markdown: 0,
          changedFiles: 0,
          deletedFiles: 0,
        },
        pins: [],
        exclusions: [],
      },
    })),
  };
}

function request(signal?: AbortSignal) {
  return {
    contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
    invocationId: 'inv_graph',
    taskId: 'task_graph',
    goal: 'Ship the fixed graph',
    model: 'test-model',
    signal,
  };
}

function proposal(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Add generated constant',
    operations: [{
      type: 'create',
      path: 'src/generated/example.ts',
      reason: 'requested',
      content: 'export const value = 1;\n',
    }],
    validationCommands: [{ kind: 'tsc-no-emit' }],
    limits: {},
    warnings: [],
    status: 'proposed',
    ...overrides,
  });
}

function longProposal(): string {
  return proposal({
    operations: [{
      type: 'create',
      path: 'src/generated/large.ts',
      reason: 'exercise full proposal handoff',
      content: `export const generated = ${JSON.stringify('x'.repeat(7000))};\n`,
    }],
  });
}

async function workspaceWithPackageJson(scripts: Record<string, string> = { verify: 'tsc --noEmit' }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m13-2-graph-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts }), 'utf8');
  return root;
}

describe('FixedMultiAgentGraph', () => {
  it('folds two ordered steering receipts into the same task at the next stage boundary', async () => {
    const prompts: string[] = [];
    let boundary = 0;
    const dep = dependency(async modelRequest => {
      prompts.push(modelRequest.prompt);
      const stage = modelRequest.requestId.split(':').pop();
      return { completion: stage === 'validator' ? proposal() : `output from ${stage}` };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    const result = await graph.execute({
      ...request(),
      pendingSteering: async () => {
        boundary += 1;
        return boundary === 2
          ? ['[1] Use greeting.txt instead.', '[2] Keep the content to one line.']
          : [];
      },
    });

    expect(result.status).toBe('completed');
    expect(prompts[0]).not.toContain('Use greeting.txt instead.');
    expect(prompts.slice(1).every(prompt => prompt.includes('[1] Use greeting.txt instead.'))).toBe(true);
    expect(prompts.slice(1).every(prompt => prompt.includes('[2] Keep the content to one line.'))).toBe(true);
  });

  it('executes all five stages in exact order and passes preceding output forward', async () => {
    const seenPrompts: string[] = [];
    const dep = dependency(async modelRequest => {
      seenPrompts.push(modelRequest.prompt);
      const stage = modelRequest.requestId.split(':').pop()!;
      return { completion: `output from ${stage}`, providerType: 'ollama' };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    const result = await graph.execute(request());

    expect(result.status).toBe('completed');
    expect(result.completedStages).toEqual([...FIXED_MULTI_AGENT_STAGES]);
    expect(result.finalValidatorOutput).toBe('output from validator');
    expect((dep.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].requestId.split(':').pop())).toEqual([...FIXED_MULTI_AGENT_STAGES]);
    expect(seenPrompts[1]).toContain('output from repository-analyst');
    expect(seenPrompts[2]).toContain('output from planner');
    expect(seenPrompts[3]).toContain('output from implementer');
    expect(seenPrompts[4]).toContain('output from reviewer');
  });

  it('turns a canonical validator CodingProposal into a ready typed proposal', async () => {
    const root = await workspaceWithPackageJson();
    try {
      const dep = dependency(async modelRequest => {
        const stage = modelRequest.requestId.split(':').pop();
        return { completion: stage === 'validator' ? proposal() : `output from ${stage}` };
      });
      const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

      const result = await graph.execute({ ...request(), workspaceRoot: root });

      expect(result.status).toBe('completed');
      expect(result.proposalConsumption).toMatchObject({
        status: 'ready',
        errors: [],
        sourceStage: 'validator',
        invocationId: 'inv_graph',
        taskId: 'task_graph',
      });
      expect(result.proposalConsumption?.proposal?.taskSummary).toBe('Add generated constant');
      expect(result.proposalConsumption?.proposal?.operations[0].path).toBe('src/generated/example.ts');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('transmits a valid CodingProposal larger than the prose handoff limit intact through reviewer and validator', async () => {
    const root = await workspaceWithPackageJson();
    const candidate = longProposal();
    expect(candidate.length).toBeGreaterThan(6000);
    const seenPrompts = new Map<string, string>();
    try {
      const dep = dependency(async modelRequest => {
        const stage = modelRequest.requestId.split(':').pop()!;
        seenPrompts.set(stage, modelRequest.prompt);
        if (stage === 'implementer' || stage === 'reviewer' || stage === 'validator') {
          return { completion: candidate };
        }
        return { completion: `bounded prose from ${stage}` };
      });
      const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

      const result = await graph.execute({ ...request(), workspaceRoot: root });

      expect(result.status).toBe('completed');
      expect(seenPrompts.get('reviewer')).toContain(candidate);
      expect(seenPrompts.get('validator')).toContain(candidate);
      expect(seenPrompts.get('reviewer')).not.toContain('[previous stage output truncated]');
      expect(seenPrompts.get('validator')).not.toContain('[previous stage output truncated]');
      expect(result.proposalConsumption?.status).toBe('ready');
      expect(result.proposalConsumption?.proposal?.taskSummary).toBe(JSON.parse(candidate).taskSummary);
      expect(result.proposalConsumption?.proposal?.operations[0].content).toBe(JSON.parse(candidate).operations[0].content);
      expect(dep.execute).toHaveBeenCalledTimes(5);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed before reviewer when an implementer candidate exceeds the authoritative response bound', async () => {
    const secret = 'RAW_OVERSIZED_CANDIDATE_SENTINEL';
    const oversized = `${' '.repeat(CODING_PROPOSAL_MAX_RESPONSE_BYTES + 1)}${secret}`;
    const dep = dependency(async modelRequest => {
      const stage = modelRequest.requestId.split(':').pop()!;
      return { completion: stage === 'implementer' ? oversized : `ok ${stage}` };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    const result = await graph.execute(request());

    expect(result.status).toBe('failed');
    expect(result.failedStage).toBe('reviewer');
    expect(result.failureCode).toBe('execution_rejected');
    expect(result.proposalConsumption).toBeUndefined();
    expect((dep.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].requestId.split(':').pop())).toEqual([
      'repository-analyst',
      'planner',
      'implementer',
    ]);
    expect(JSON.stringify(result.evidence)).not.toContain(secret);
    expect(JSON.stringify(result.failureReason)).not.toContain(secret);
  });

  it('keeps analyst and planner prose handoffs bounded', async () => {
    const longProse = 'p'.repeat(7000);
    const seenPrompts = new Map<string, string>();
    const dep = dependency(async modelRequest => {
      const stage = modelRequest.requestId.split(':').pop()!;
      seenPrompts.set(stage, modelRequest.prompt);
      return { completion: stage === 'validator' ? proposal() : longProse };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    await graph.execute(request());

    expect(seenPrompts.get('planner')).toContain('[previous stage output truncated]');
    expect(seenPrompts.get('implementer')).toContain('[previous stage output truncated]');
    expect(seenPrompts.get('planner')).not.toContain('p'.repeat(6500));
    expect(seenPrompts.get('implementer')).not.toContain('p'.repeat(6500));
  });

  it('normalizes supported conformance aliases through the M9 proposal parser', async () => {
    const dep = dependency(async modelRequest => {
      const stage = modelRequest.requestId.split(':').pop();
      return {
        completion: stage === 'validator'
          ? JSON.stringify({
            version: '1',
            task_summary: 'Alias summary',
            file_operations: [{ type: 'add', path: 'src/alias.ts', reason: 'alias', content: 'export const alias = true;\n' }],
            validationCommands: [],
            warnings: [],
            status: 'proposed',
          })
          : `output from ${stage}`,
      };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    const result = await graph.execute(request());

    expect(result.status).toBe('completed');
    expect(result.proposalConsumption?.status).toBe('ready');
    expect(result.proposalConsumption?.proposal?.operations[0].type).toBe('create');
    expect(result.proposalConsumption?.conformance).toMatchObject({
      versionRepresentationNormalized: true,
      taskSummaryAliasNormalized: true,
      operationContainerAliasNormalized: true,
      operationAliasNormalized: true,
    });
  });

  it('lets strict host validation decide validity even when model text claims success', async () => {
    const dep = dependency(async modelRequest => {
      const stage = modelRequest.requestId.split(':').pop();
      return { completion: stage === 'validator' ? 'The proposal is valid.' : `output from ${stage}` };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    const result = await graph.execute(request());

    expect(result.status).toBe('completed');
    expect(result.proposalConsumption).toMatchObject({
      status: 'invalid',
      errors: ['proposal_not_object'],
    });
    expect(result.proposalConsumption?.proposal).toBeUndefined();
  });

  it('keeps graph completion separate from malformed validator proposal status', async () => {
    const dep = dependency(async modelRequest => {
      const stage = modelRequest.requestId.split(':').pop();
      return { completion: stage === 'validator' ? '{"version":1' : `output from ${stage}` };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    const result = await graph.execute(request());

    expect(result.status).toBe('completed');
    expect(result.proposalConsumption?.status).toBe('invalid');
    expect(result.proposalConsumption?.errors).toContain('malformed_model_response');
    expect(result.proposalConsumption?.proposal).toBeUndefined();
  });

  it('does not parse or expose proposals for failed or cancelled graphs', async () => {
    const failedDep = dependency(async modelRequest => {
      if (modelRequest.requestId.endsWith(':validator')) {
        throw new Error('validator unavailable');
      }
      return { completion: 'ok' };
    });
    const failed = await new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(failedDep), contextProvider()).execute(request());
    expect(failed.status).toBe('failed');
    expect(failed.proposalConsumption).toBeUndefined();

    const controller = new AbortController();
    controller.abort();
    const cancelledDep = dependency(async () => ({ completion: proposal() }));
    const cancelled = await new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(cancelledDep), contextProvider()).execute(request(controller.signal));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.proposalConsumption).toBeUndefined();
  });

  it('does not advance a late validator completion into proposal consumption after cancellation', async () => {
    const controller = new AbortController();
    let releaseValidator: ((value: GovernedModelExecutionOutcome) => void) | undefined;
    const dep = dependency(modelRequest => {
      const stage = modelRequest.requestId.split(':').pop();
      if (stage === 'validator') {
        controller.abort();
        return new Promise(resolve => {
          releaseValidator = resolve;
        });
      }
      return Promise.resolve({ completion: stage === 'reviewer' ? proposal() : `ok ${stage}` });
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());
    const pending = graph.execute(request(controller.signal));
    for (let i = 0; i < 20 && !releaseValidator; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    releaseValidator?.({ completion: proposal() });
    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(result.finalValidatorOutput).toBeUndefined();
    expect(result.proposalConsumption).toBeUndefined();
  });

  it('surfaces existing M9 rejection codes for unsafe paths, unsupported commands and limits', async () => {
    const cases = [
      { operations: [{ type: 'create', path: '/tmp/a', reason: 'x', content: 'x' }], code: 'absolute_path_rejected' },
      { operations: [{ type: 'create', path: '../a', reason: 'x', content: 'x' }], code: 'path_traversal_rejected' },
      { operations: [{ type: 'create', path: '.git/config', reason: 'x', content: 'x' }], code: 'excluded_path_rejected' },
      { operations: [{ type: 'create', path: '.env', reason: 'x', content: 'x' }], code: 'credential_path_rejected' },
      { validationCommands: [{ kind: 'vitest', args: ['run', 'src/a.test.ts', '&&'] }], code: 'validation_command_unsupported' },
      { operations: Array.from({ length: 13 }, (_, i) => ({ type: 'create', path: `src/${i}.ts`, reason: 'x', content: 'x' })), code: 'file_count_limit_exceeded' },
      { operations: [{ type: 'create', path: 'src/large.ts', reason: 'x', content: 'x'.repeat(200_001) }], code: 'file_byte_limit_exceeded' },
      { operations: Array.from({ length: 4 }, (_, i) => ({ type: 'create', path: `src/large-${i}.ts`, reason: 'x', content: 'x'.repeat(160_000) })), code: 'total_byte_limit_exceeded' },
    ];

    for (const item of cases) {
      const dep = dependency(async modelRequest => ({
        completion: modelRequest.requestId.endsWith(':validator') ? proposal(item) : 'ok',
      }));
      const result = await new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider()).execute(request());
      expect(result.proposalConsumption?.status).toBe('invalid');
      expect(result.proposalConsumption?.errors).toContain(item.code);
    }
  });

  it('uses host package scripts and rejects model-invented npm scripts', async () => {
    const root = await workspaceWithPackageJson({ verify: 'tsc --noEmit' });
    try {
      const dep = dependency(async modelRequest => ({
        completion: modelRequest.requestId.endsWith(':validator')
          ? proposal({ validationCommands: [{ kind: 'npm-script', script: 'invented' }] })
          : 'ok',
      }));
      const result = await new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider()).execute({ ...request(), workspaceRoot: root });

      expect(result.proposalConsumption?.status).toBe('invalid');
      expect(result.proposalConsumption?.errors).toContain('validation_command_unsupported');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not copy raw validator completion, prompts or repository snippets into proposal evidence', async () => {
    const dep = dependency(async modelRequest => ({
      completion: modelRequest.requestId.endsWith(':validator')
        ? proposal({ taskSummary: 'RAW_VALIDATOR_COMPLETION_SENTINEL' })
        : 'ok',
    }));
    const result = await new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider()).execute(request());

    const evidence = JSON.stringify(result.proposalConsumption?.evidence);
    const errors = JSON.stringify(result.proposalConsumption?.errors);
    expect(evidence).not.toContain('RAW_VALIDATOR_COMPLETION_SENTINEL');
    expect(evidence).not.toContain('Ship the fixed graph');
    expect(evidence).not.toContain('RAW_REPOSITORY_CONTENT_SENTINEL');
    expect(errors).not.toContain('RAW_VALIDATOR_COMPLETION_SENTINEL');
  });

  it('requests the canonical CodingProposal response format for implementer, reviewer and validator', async () => {
    const dep = dependency(async modelRequest => ({ completion: modelRequest.requestId.endsWith(':validator') ? proposal() : 'ok' }));
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    await graph.execute(request());

    const calls = (dep.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0] as GovernedModelRequest);
    expect(calls.filter(call => call.responseFormat).map(call => call.requestId.split(':').pop())).toEqual(['implementer', 'reviewer', 'validator']);
    for (const call of calls.filter(call => call.responseFormat)) {
      expect(call.responseFormat?.name).toBe('forge_coding_proposal');
      expect(call.responseFormat?.schema).toBeDefined();
    }
  });

  it('stops deterministically when planner fails', async () => {
    const dep = dependency(async modelRequest => {
      const stage = modelRequest.requestId.split(':').pop();
      if (stage === 'planner') {
        throw new Error('raw planner provider detail');
      }
      return { completion: `ok ${stage}` };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    const result = await graph.execute(request());

    expect(result.status).toBe('failed');
    expect(result.failedStage).toBe('planner');
    expect(result.completedStages).toEqual(['repository-analyst']);
    expect((dep.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].requestId.split(':').pop())).toEqual(['repository-analyst', 'planner']);
  });

  it('cancels during implementer and never starts reviewer or validator, including late completion', async () => {
    const controller = new AbortController();
    let releaseImplementer: ((value: GovernedModelExecutionOutcome) => void) | undefined;
    const dep = dependency(modelRequest => {
      const stage = modelRequest.requestId.split(':').pop();
      if (stage === 'implementer') {
        controller.abort();
        return new Promise(resolve => {
          releaseImplementer = resolve;
        });
      }
      return Promise.resolve({ completion: `ok ${stage}` });
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());
    const pending = graph.execute(request(controller.signal));
    for (let i = 0; i < 20 && !releaseImplementer; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(releaseImplementer).toBeDefined();

    releaseImplementer?.({ completion: 'late implementer success' });
    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(result.failedStage).toBe('implementer');
    expect(result.completedStages).toEqual(['repository-analyst', 'planner']);
    expect((dep.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].requestId.split(':').pop())).toEqual(['repository-analyst', 'planner', 'implementer']);
    expect(result.finalValidatorOutput).toBeUndefined();
  });

  it('has only one active stage at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const dep = dependency(async modelRequest => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { completion: `ok ${modelRequest.requestId}` };
    });
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    await graph.execute(request());

    expect(maxActive).toBe(1);
  });

  it('returns all five sanitized stage evidence records on success', async () => {
    const dep = dependency(async modelRequest => ({ completion: `ok ${modelRequest.requestId}` }));
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());

    const result = await graph.execute(request());

    expect(result.evidence).toHaveLength(5);
    expect(result.evidence.map(evidence => evidence.stage)).toEqual([...FIXED_MULTI_AGENT_STAGES]);
    const serialized = JSON.stringify(result.evidence);
    expect(serialized).not.toContain('Ship the fixed graph');
    expect(serialized).not.toContain('RAW_REPOSITORY_CONTENT_SENTINEL');
    expect(serialized).not.toContain('ok fixed-multi-agent');
    expect(result.evidence[0].selectedContextFiles).toEqual(['general.ts']);
  });

  it('does not change governed dispatcher behavior', async () => {
    const dep = dependency(async () => ({ completion: 'single governed completion' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dep);

    const result = await dispatcher.dispatch({
      contractVersion: 1,
      requestId: 'req_single',
      invocationId: 'inv_single',
      taskId: 'task_single',
      model: 'm',
      prompt: 'prompt',
    });

    expect(result.status).toBe('completed');
    expect(result.completion).toBe('single governed completion');
    expect(dep.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed callable requests before graph execution', async () => {
    const dep = dependency(async () => ({ completion: 'should not run' }));
    const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep), contextProvider());
    const adapter = {} as ReadOnlyForgeInvocationAdapter;
    const surface = new ReadOnlyForgeCallableSurface(adapter, graph);

    const response = await surface.call({
      method: FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD,
      params: { invocationId: '', taskId: 'task', goal: 'goal', model: 'm' },
    } as unknown as { method: string; params?: unknown });

    expect(response.ok).toBe(false);
    expect(dep.execute).not.toHaveBeenCalled();
  });
});
