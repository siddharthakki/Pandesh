import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { GOVERNED_MODEL_CONTRACT_VERSION, type GovernedModelRequest, type GovernedModelResult } from '../../agent/GovernedModelExecutionTypes';
import type { GovernedModelDispatchSeam } from '../../agent/LocalFirstModelDispatchRouter';
import {
  formatInvestigationProgress,
  runInvestigationLoop,
  type InvestigationLoopResult,
} from '../../coding/InvestigationLoop';
import { WorkspaceInspectionTools } from '../../coding/WorkspaceInspection';

const PROPOSAL = {
  version: 1,
  taskSummary: 'Use the real THRESHOLD',
  operations: [{
    type: 'replace',
    path: 'index.js',
    reason: 'Compare against the real threshold',
    content: "const { THRESHOLD } = require('./helper');\nfunction isValid(n) { return n > THRESHOLD; }\nmodule.exports = { isValid };\n",
  }],
  validationCommands: [{ kind: 'npm-script', script: 'verify' }],
  warnings: [],
  status: 'proposed',
};

function envelope(action: Record<string, unknown>): string {
  return JSON.stringify(action);
}

function result(partial: Partial<GovernedModelResult> & Pick<GovernedModelResult, 'status'>): GovernedModelResult {
  return {
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId: 'investigation:test:1',
    invocationId: 'inv',
    taskId: 'task',
    model: 'qwen3.8:27b-mtp-q4_K_M',
    evidence: { contractVersion: GOVERNED_MODEL_CONTRACT_VERSION } as GovernedModelResult['evidence'],
    ...partial,
  };
}

class ScriptedDispatcher implements GovernedModelDispatchSeam {
  readonly prompts: string[] = [];
  readonly requestIds: string[] = [];
  readonly requests: GovernedModelRequest[] = [];
  constructor(private readonly replies: Array<GovernedModelResult | ((request: GovernedModelRequest) => GovernedModelResult)>) {}
  async dispatch(request: GovernedModelRequest): Promise<GovernedModelResult> {
    this.requests.push(request);
    this.prompts.push(request.prompt);
    this.requestIds.push(request.requestId);
    const next = this.replies[this.prompts.length - 1];
    if (!next) throw new Error(`unexpected extra dispatch ${this.prompts.length}`);
    return typeof next === 'function' ? next(request) : next;
  }
}

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-investigation-reliability-'));
  await fs.writeFile(path.join(root, 'helper.js'), 'module.exports = { THRESHOLD: 42 };\n');
  await fs.writeFile(path.join(root, 'index.js'), 'function isValid(n) { return n > 10; }\nmodule.exports = { isValid };\n');
  return root;
}

function baseParams(root: string, dispatcher: GovernedModelDispatchSeam, extras: Partial<Parameters<typeof runInvestigationLoop>[0]> = {}) {
  return {
    task: 'Fix isValid to use helper.THRESHOLD',
    files: ['helper.js', 'index.js'],
    packageScripts: ['verify'],
    initialRepositoryContext: '',
    dispatcher,
    inspection: new WorkspaceInspectionTools(root),
    validateProposalCoverage: async () => [],
    model: 'qwen3.8:27b-mtp-q4_K_M',
    invocationId: 'inv',
    taskId: 'task',
    maxTurns: 2,
    ...extras,
  };
}

describe('InvestigationLoop reliability', () => {
  let root: string;

  beforeEach(async () => {
    root = await workspace();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('reserves a finalization call after the investigation allowance is spent', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'index.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const progress: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      onProgress: phase => progress.push(phase),
    }));

    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.prompts).toHaveLength(3);
    expect(dispatcher.prompts[0]).toMatch(/Remaining investigation allowance \(including this turn\): 2 of 2/);
    expect(dispatcher.prompts[0]).toMatch(/Reserved finalization calls after investigation: 1/);
    expect(dispatcher.prompts[1]).toMatch(/Remaining investigation allowance \(including this turn\): 1 of 2/);
    expect(dispatcher.prompts[2]).toMatch(/Reserved finalization turn/);
    expect(dispatcher.prompts[2]).toMatch(/Remaining investigation allowance: 0/);
    expect(dispatcher.prompts[2]).toMatch(/Do not read or search/);
    expect(progress.some(phase => phase.startsWith('investigation_stop reason=proposal'))).toBe(true);
  });

  it('retries empty unusable output once and preserves the exact subreason', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const progress: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 1,
      onProgress: phase => progress.push(phase),
    }));

    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requestIds[1]).toMatch(/:retry$/);
    expect(progress).toContain('investigation_recovery reason=empty_content attempt=1/1');
    expect(loop.turns.some(turn => turn.recovery === 'empty_content')).toBe(true);
  });

  it('escalates once to cloud after persistent unusable output and records the destination model', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
    ]);
    const cloudCalls: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 1,
      onProgress: phase => cloudCalls.push(phase),
      escalateToCloud: async (_request, reason, local) => {
        expect(reason).toBe('persistent_unusable_output');
        expect(local?.invalidResponseReason).toBe('empty_content');
        return result({
          status: 'completed',
          model: 'openai/gpt-5.6-sol',
          completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }),
        });
      },
    }));

    expect(loop.outcome.kind).toBe('proposal');
    expect(cloudCalls).toContain('investigation_recovery reason=empty_content attempt=1/1');
    expect(cloudCalls.some(phase => phase === 'investigation_cloud_recovery reason=persistent_unusable_output from=qwen3.8:27b-mtp-q4_K_M to=openai/gpt-5.6-sol')).toBe(true);
  });

  it('escalates once to cloud after exhausted investigation without forcing an edit', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'THRESHOLD' }) }),
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'index.js' }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 2,
      escalateToCloud: async (request, reason) => {
        expect(reason).toBe('investigation_exhausted');
        expect(request.prompt).toMatch(/Cloud recovery investigation/);
        expect(request.prompt).toContain('Investigation so far');
        return result({
          status: 'completed',
          model: 'openai/gpt-5.6-sol',
          completion: envelope({
            action: 'insufficient_context',
            reason: 'Need the delivery catch site',
            missing: ['approveDelivery'],
          }),
        });
      },
    }));

    expect(loop.outcome.kind).toBe('insufficient_context');
    if (loop.outcome.kind === 'insufficient_context') {
      expect(loop.outcome.missing).toContain('approveDelivery');
    }
  });

  it('escalates to cloud when local finalization reports insufficient_context after the investigation budget is spent', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'index.js' }) }),
      result({
        status: 'completed',
        completion: envelope({
          action: 'insufficient_context',
          reason: 'Need the catch site',
          missing: ['approveDelivery'],
        }),
      }),
    ]);
    const progress: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 2,
      onProgress: phase => progress.push(phase),
      escalateToCloud: async (request, reason) => {
        expect(reason).toBe('investigation_exhausted');
        expect(request.prompt).toContain('insufficient_context');
        return result({
          status: 'completed',
          model: 'openai/gpt-5.6-sol',
          completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }),
        });
      },
    }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(progress.some(phase => phase.includes('investigation_cloud_recovery reason=investigation_exhausted'))).toBe(true);
  });

  it('gives cloud recovery a small read/search allowance before finalization', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'ABSENT_SYMBOL' }) }),
      result({
        status: 'completed',
        completion: envelope({
          action: 'insufficient_context',
          reason: 'Need the implementation file',
          missing: ['index.js'],
        }),
      }),
    ]);
    const cloudPrompts: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 2,
      escalateToCloud: async (request, reason) => {
        expect(reason).toBe('investigation_exhausted');
        cloudPrompts.push(request.prompt);
        if (cloudPrompts.length === 1) {
          expect(request.prompt).toMatch(/Cloud recovery investigation/);
          expect(request.prompt).toMatch(/complete miss/);
          return result({
            status: 'completed',
            model: 'openai/gpt-5.6-sol',
            completion: envelope({ action: 'read_file', path: 'helper.js' }),
          });
        }
        expect(request.prompt).toMatch(/Cloud recovery investigation|Cloud recovery finalization/);
        expect(request.prompt).toContain('### read_file: helper.js');
        return result({
          status: 'completed',
          model: 'openai/gpt-5.6-sol',
          completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }),
        });
      },
    }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(cloudPrompts.length).toBeGreaterThanOrEqual(2);
  });

  it('tells the model to change approach after repeated zero-result searches', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'ABSENT_SYMBOL' }) }),
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'ABSENT_SYMBOL' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 2 }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.prompts[1]).toMatch(/complete miss/);
    expect(dispatcher.prompts[2]).toMatch(/already returned no matches|Repeating it will not produce new evidence/);
  });

  it('does not escalate an early honest insufficient_context before the investigation budget is spent', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({
        status: 'completed',
        completion: envelope({
          action: 'insufficient_context',
          reason: 'Need a file that is not in this workspace',
          missing: ['missing.js'],
        }),
      }),
    ]);
    let cloudCalled = false;
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 2,
      escalateToCloud: async () => {
        cloudCalled = true;
        return undefined;
      },
    }));
    expect(loop.outcome.kind).toBe('insufficient_context');
    expect(cloudCalled).toBe(false);
  });

  it('does not escalate cancelled or execution_rejected failures', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'cancelled', failureCode: 'cancelled' }),
    ]);
    let cloudCalled = false;
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 1,
      escalateToCloud: async () => {
        cloudCalled = true;
        return undefined;
      },
    }));
    expect(loop.outcome.kind).toBe('dispatch_failed');
    if (loop.outcome.kind === 'dispatch_failed') {
      expect(loop.outcome.errors).toContain('cancelled');
    }
    expect(cloudCalled).toBe(false);
  });

  it('exposes read path/range and search query/scope/result counts in progress evidence', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js', startLine: 1, endLine: 1 }) }),
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'THRESHOLD', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const turns: string[] = [];
    await runInvestigationLoop(baseParams(root, dispatcher, {
      onTurn: evidence => turns.push(formatInvestigationProgress(evidence)),
    }));

    expect(turns[0]).toContain('investigation_turn turn=1 action=read_file');
    expect(turns[0]).toContain('path=helper.js');
    expect(turns[0]).toMatch(/range=1-1/);
    expect(turns[0]).toContain('requested=read_file');
    expect(turns[0]).toContain('completed=read_file');
    expect(turns[1]).toContain('action=search');
    expect(turns[1]).toContain('query=THRESHOLD');
    expect(turns[1]).toContain('scope=helper.js');
    expect(turns[1]).toMatch(/results=\d+/);
    expect(turns[1]).toContain('reads=1');
    expect(turns[1]).toContain('unique_files=1');
    expect(turns[0]).toMatch(/delivered_chars=\d+/);
  });

  it('puts the ranged file slice in the next model prompt as COMPLETE', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'index.js', startLine: 2, endLine: 2 }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 1 }));
    expect(dispatcher.prompts[1]).toContain('### read_file: index.js range=2-2');
    expect(dispatcher.prompts[1]).toMatch(/\nCOMPLETE\n/);
    expect(dispatcher.prompts[1]).toContain('module.exports = { isValid };');
    expect(dispatcher.prompts[1]).not.toContain('function isValid');
  });

  it('tells the model a search FAILED instead of treating the failure as a zero-match', async () => {
    class FailingSearch extends WorkspaceInspectionTools {
      override async searchText() {
        return { ok: false as const, error: 'search_timed_out' };
      }
    }
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'classifyRuntimeError' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const turns: string[] = [];
    await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 1,
      inspection: new FailingSearch(root),
      onTurn: evidence => turns.push(formatInvestigationProgress(evidence)),
    }));
    expect(dispatcher.prompts[1]).toMatch(/FAILED: search_timed_out/);
    expect(dispatcher.prompts[1]).toMatch(/not a confirmed zero-match/);
    expect(dispatcher.prompts[1]).not.toMatch(/complete miss/);
    expect(turns[0]).toContain('ok=false');
    expect(turns[0]).toContain('error=search_timed_out');
    expect(turns[0]).not.toMatch(/results=/);
  });

  it('does not escalate to cloud when investigation gathered no file contents', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'ABSENT_SYMBOL' }) }),
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'ABSENT_SYMBOL' }) }),
      result({
        status: 'completed',
        completion: envelope({
          action: 'insufficient_context',
          reason: 'Need the catch site',
          missing: ['approveDelivery'],
        }),
      }),
    ]);
    let cloudCalled = false;
    const progress: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 2,
      onProgress: phase => progress.push(phase),
      escalateToCloud: async () => {
        cloudCalled = true;
        return result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) });
      },
    }));
    expect(loop.outcome.kind).toBe('insufficient_context');
    expect(cloudCalled).toBe(false);
    expect(progress.some(phase => phase.includes('investigation_cloud_skipped reason=insufficient_evidence'))).toBe(true);
  });

  it('stays on the local model across every turn when cloud escalation is not provided', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 2,
    }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(loop.governedResult.model).toBe('qwen3.8:27b-mtp-q4_K_M');
    expect(dispatcher.requestIds.every(id => !id.includes(':cloud'))).toBe(true);
    expect(dispatcher.prompts[2]).toMatch(/previous model response unusable \(empty_content\)/);
  });

  it('fails closed after persistent empty_content on the reserved finalization turn without calling cloud', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 1,
    }));
    expect(loop.outcome.kind).toBe('dispatch_failed');
    expect(loop.governedResult.model).toBe('qwen3.8:27b-mtp-q4_K_M');
    expect(dispatcher.requestIds).toHaveLength(6);
    expect(dispatcher.requestIds.every(id => !id.includes(':cloud'))).toBe(true);
  });

  it('uses one extra local finalization attempt after persistent empty_content without calling cloud', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const progress: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 1,
      onProgress: phase => progress.push(phase),
    }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requestIds.every(id => !id.includes(':cloud'))).toBe(true);
    expect(progress).toContain('investigation_recovery reason=local_finalize_retry attempt=1/1');
  });

  it('compacts a large investigation transcript before the next dispatch and keeps the latest read', async () => {
    await fs.writeFile(path.join(root, 'padding.js'), `const PADDING = ${JSON.stringify('PAD_UNIQUE_TOKEN '.repeat(500))};\n`);
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'padding.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const progress: string[] = [];
    await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 2,
      onProgress: phase => progress.push(phase),
    }));
    const proposalPrompt = dispatcher.prompts[2];
    expect(proposalPrompt).toContain('THRESHOLD: 42');
    expect(proposalPrompt).toContain('fingerprint=');
    expect(proposalPrompt.length).toBeLessThan(dispatcher.prompts[1].length + 4000);
    expect(proposalPrompt).toContain('### read_file: helper.js');
  });

  it('retries once after a context-overflow rejection using the compacted prompt', async () => {
    const overflow = result({
      status: 'failed',
      failureCode: 'execution_rejected',
      evidence: {
        contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
        requestId: 'investigation:test:1',
        invocationId: 'inv',
        taskId: 'task',
        model: 'qwen3.8:27b-mtp-q4_K_M',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'failed',
        failureCode: 'execution_rejected',
        context: {
          profileId: 'qwen-general-local',
          effectiveContextLimit: 16384,
          provenance: 'profile',
          estimated: true,
          fallback: false,
          contentTokens: 20_000,
          projectedTotalTokens: 25_000,
          outputReserveTokens: 4096,
          percentUsed: 152,
          status: 'blocked',
          structuredOutput: { requested: true, supported: true, active: true },
        },
      },
    });
    const dispatcher = new ScriptedDispatcher([
      overflow,
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const progress: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 1,
      onProgress: phase => progress.push(phase),
    }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requestIds[1]).toMatch(/:compact$/);
    expect(progress).toContain('investigation_recovery reason=context_overflow attempt=1/1');
    expect(dispatcher.prompts[2]).toContain('THRESHOLD: 42');
  });

  it('hydrates search hits before accepting an insufficient-context finalization', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'search', query: 'isValid' }) }),
      result({ status: 'completed', completion: envelope({
        action: 'insufficient_context',
        reason: 'Need the exact implementation around the search hit',
        missing: ['index.js implementation'],
      }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const progress: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 1,
      onProgress: phase => progress.push(phase),
    }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(progress).toContain('investigation_context_hydrated reads=2 unique_files=1');
    expect(dispatcher.prompts[2]).toContain('### read_file: index.js');
  });

  it('tightens the transcript before the empty_content retry so evidence still reaches the proposal', async () => {
    await fs.writeFile(path.join(root, 'padding.js'), `const PADDING = ${JSON.stringify('PAD_UNIQUE_TOKEN '.repeat(300))};\n`);
    await fs.writeFile(path.join(root, 'middle.js'), `const MIDDLE = ${JSON.stringify('MID_UNIQUE_TOKEN '.repeat(350))};\n`);
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'padding.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'middle.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'failed', failureCode: 'invalid_model_response', invalidResponseReason: 'empty_content' }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const progress: string[] = [];
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 3,
      files: Array.from({ length: 40 }, (_, index) => `file-${index}.js`),
      initialRepositoryContext: 'INITIAL_CONTEXT_SHOULD_DROP',
      onProgress: phase => progress.push(phase),
    }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requestIds[4]).toMatch(/:retry$/);
    expect(dispatcher.prompts[4].length).toBeLessThan(dispatcher.prompts[3].length);
  });

  it('still validates an evidence-backed proposal after compaction', async () => {
    await fs.writeFile(path.join(root, 'padding.js'), `const PADDING = ${JSON.stringify('PAD_UNIQUE_TOKEN '.repeat(500))};\n`);
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'padding.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 2 }));
    expect(loop.outcome.kind).toBe('proposal');
    if (loop.outcome.kind === 'proposal') {
      expect(loop.outcome.proposal.operations[0].path).toBe('index.js');
      expect(loop.outcome.proposal.operations[0].content).toContain('THRESHOLD');
    }
    expect(dispatcher.prompts[2]).toContain('THRESHOLD: 42');
  });

  it('omits bulky repository overview and compacts file list after the first investigation observation', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, {
      maxTurns: 2,
      files: Array.from({ length: 40 }, (_, index) => `file-${index}.js`),
      initialRepositoryContext: 'BULKY_INITIAL_REPO_CONTEXT_SHOULD_DISAPPEAR',
    }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.prompts).toHaveLength(2);
    // Turn 1 prompt includes bulky repository context and full files list
    expect(dispatcher.prompts[0]).toContain('BULKY_INITIAL_REPO_CONTEXT_SHOULD_DISAPPEAR');
    expect(dispatcher.prompts[0]).toContain('file-39.js');
    expect(dispatcher.prompts[0]).not.toContain(' …');
    // Turn 2 prompt (after first observation) omits bulky repository context and compacts files list
    expect(dispatcher.prompts[1]).not.toContain('BULKY_INITIAL_REPO_CONTEXT_SHOULD_DISAPPEAR');
    expect(dispatcher.prompts[1]).toContain('Available workspace files: file-0.js');
    expect(dispatcher.prompts[1]).toContain(' …');
    expect(dispatcher.prompts[1]).not.toContain('file-39.js');
    expect(dispatcher.prompts[1]).toContain('THRESHOLD: 42');
    expect(dispatcher.prompts[1].length).toBeLessThan(dispatcher.prompts[0].length);
  });

  it('repairs one invalid action response using compact format repair and succeeds', async () => {
    const dispatcher = new ScriptedDispatcher([
      // Turn 1 returns invalid action (missing required path)
      result({ status: 'completed', completion: '{"action":"read_file"}' }),
      // Format-repair model call returns valid read_file action
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) }),
      // Turn 2 returns final proposal
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 2 }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requestIds).toHaveLength(3);
    expect(dispatcher.requestIds[1]).toMatch(/:repair$/);
    expect(dispatcher.prompts[1]).toContain('The previous action response was invalid');
    expect(dispatcher.prompts[1]).toContain('read_file_path_required');
    expect(loop.turns[0].isRepair).toBe(true);
    expect(loop.turns[0].action).toBe('read_file');
    expect(loop.turns[0].ok).toBe(true);
    expect(loop.turns[0].path).toBe('helper.js');
    expect(loop.turns[0].promptChars).toBeGreaterThan(0);
    expect(loop.turns[0].durationMs).toBeDefined();
  });

  it('fails safely when repair also returns an invalid response', async () => {
    const dispatcher = new ScriptedDispatcher([
      // Turn 1 returns invalid action
      result({ status: 'completed', completion: '{"action":"unknown_tool"}' }),
      // Repair call also returns invalid action
      result({ status: 'completed', completion: '{"action":"still_invalid"}' }),
      // Next turn submits proposal
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 2 }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requestIds[1]).toMatch(/:repair$/);
    expect(dispatcher.requestIds[2]).not.toMatch(/:repair$/);
    expect(loop.turns[0].action).toBe('invalid_action');
    expect(loop.turns[0].isRepair).toBe(true);
  });

  it('fails safely on finalization when both initial and repair responses are invalid', async () => {
    const dispatcher = new ScriptedDispatcher([
      // Finalize turn returns invalid response
      result({ status: 'completed', completion: 'invalid json' }),
      // Repair call also returns invalid response
      result({ status: 'completed', completion: 'still invalid' }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 0 }));
    expect(loop.outcome.kind).toBe('dispatch_failed');
    expect(dispatcher.requestIds).toHaveLength(2);
    expect(dispatcher.requestIds[1]).toMatch(/:repair$/);
  });

  it('preserves governance and never mutates the workspace directly', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const beforeIndex = await fs.readFile(path.join(root, 'index.js'), 'utf8');
    const loop = await runInvestigationLoop(baseParams(root, dispatcher));
    const afterIndex = await fs.readFile(path.join(root, 'index.js'), 'utf8');
    expect(loop.outcome.kind).toBe('proposal');
    expect(afterIndex).toBe(beforeIndex);
  });

  it('requests nativeThinking=false on all investigation and repair dispatches', async () => {
    const requests: GovernedModelRequest[] = [];
    const dispatcher: GovernedModelDispatchSeam = {
      async dispatch(request: GovernedModelRequest): Promise<GovernedModelResult> {
        requests.push(request);
        if (requests.length === 1) {
          return result({ status: 'completed', completion: '{"action":"invalid_action_triggering_repair"}' });
        }
        if (requests.length === 2) {
          return result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'helper.js' }) });
        }
        return result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) });
      },
    };
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 2 }));
    expect(loop.outcome.kind).toBe('proposal');
    expect(requests.length).toBe(3);
    for (const req of requests) {
      expect(req.nativeThinking).toBe(false);
    }
  });

  it('repairs duplicate_operation_path in exactly one compact repair turn with nativeThinking=false and records telemetry', async () => {
    const invalidDuplicateOpProposal = {
      ...PROPOSAL,
      operations: [
        { type: 'replace', path: 'index.js', reason: 'part 1', content: 'content 1' },
        { type: 'replace', path: 'index.js', reason: 'part 2', content: 'content 2' },
      ],
    };
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: invalidDuplicateOpProposal }) }),
      result({ status: 'completed', completion: JSON.stringify(PROPOSAL) }),
    ]);

    const loop = await runInvestigationLoop(baseParams(root, dispatcher));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requests).toHaveLength(2);

    // Turn 2 is the proposal repair turn
    const repairReq = dispatcher.requests[1];
    expect(repairReq.nativeThinking).toBe(false);
    expect(repairReq.prompt).toContain('duplicate_operation_path');
    expect(repairReq.prompt).toContain('Contract constraints required for repair:');
    expect(repairReq.prompt).not.toContain('Available workspace files:');
    expect(repairReq.prompt).not.toContain('Investigation so far:');

    // Telemetry recorded
    expect(loop.turns[0].action).toBe('submit_proposal');
    expect(loop.turns[0].repairAttempted).toBe(true);
    expect(loop.turns[0].initialValidationCodes).toContain('duplicate_operation_path');
    expect(loop.turns[0].repairedValidationResult).toBe('valid');
    expect(typeof loop.turns[0].repairDurationMs).toBe('number');
  });

  it('repairs validation_command_unsupported in exactly one compact repair turn with nativeThinking=false', async () => {
    const invalidCommandProposal = {
      ...PROPOSAL,
      validationCommands: [{ kind: 'npm-script', script: 'unsupported-tool' }],
    };
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: invalidCommandProposal }) }),
      result({ status: 'completed', completion: JSON.stringify(PROPOSAL) }),
    ]);

    const loop = await runInvestigationLoop(baseParams(root, dispatcher));
    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requests).toHaveLength(2);
    expect(dispatcher.requests[1].nativeThinking).toBe(false);
    expect(dispatcher.prompts[1]).toContain('validation_command_unsupported');

    expect(loop.turns[0].repairAttempted).toBe(true);
    expect(loop.turns[0].initialValidationCodes).toContain('validation_command_unsupported');
    expect(loop.turns[0].repairedValidationResult).toBe('valid');
  });

  it('fails closed when proposal repair remains invalid without executing a second repair', async () => {
    const invalidDuplicateOpProposal = {
      ...PROPOSAL,
      operations: [
        { type: 'replace', path: 'index.js', reason: 'part 1', content: 'content 1' },
        { type: 'replace', path: 'index.js', reason: 'part 2', content: 'content 2' },
      ],
    };
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: invalidDuplicateOpProposal }) }),
      // Repaired output is still invalid
      result({ status: 'completed', completion: JSON.stringify(invalidDuplicateOpProposal) }),
    ]);

    // maxTurns 1: the submit consumes the whole investigation allowance.
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 1 }));
    expect(loop.outcome.kind).toBe('invalid_proposal');
    expect(dispatcher.requests).toHaveLength(2); // At most one repair attempt!

    expect(loop.turns[0].repairAttempted).toBe(true);
    expect(loop.turns[0].repairedValidationResult).toBe('invalid');
  });

  const MISSING_CONTENT_PROPOSAL = {
    ...PROPOSAL,
    operations: [{ type: 'replace', path: 'index.js', reason: 'Use the threshold' }],
  };

  it('returns to investigation after a failed compact repair, then accepts a grounded proposal', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: MISSING_CONTENT_PROPOSAL }) }),
      // Compact repair is still missing operation content.
      result({ status: 'completed', completion: JSON.stringify(MISSING_CONTENT_PROPOSAL) }),
      result({ status: 'completed', completion: envelope({ action: 'read_file', path: 'index.js' }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher));

    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requests).toHaveLength(4);
    expect(loop.turns[0].repairAttempted).toBe(true);
    expect(loop.turns[0].repairedValidationResult).toBe('invalid');
    expect(loop.turns[1].action).toBe('read_file');
    expect(loop.turns[2].action).toBe('submit_proposal');
    // Next turn's prompt carries sanitized rejection evidence.
    expect(dispatcher.prompts[2]).toContain('submit_proposal rejected');
    expect(dispatcher.prompts[2]).toContain('operation_content_required');
    // Exactly one compact repair ran.
    expect(dispatcher.prompts.filter(p => p.includes('Contract constraints required for repair:'))).toHaveLength(1);
  });

  it('never runs a second compact repair when a later proposal is also invalid', async () => {
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: MISSING_CONTENT_PROPOSAL }) }),
      result({ status: 'completed', completion: JSON.stringify(MISSING_CONTENT_PROPOSAL) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: MISSING_CONTENT_PROPOSAL }) }),
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: PROPOSAL }) }),
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 3 }));

    expect(loop.outcome.kind).toBe('proposal');
    expect(dispatcher.requests).toHaveLength(4);
    expect(dispatcher.prompts.filter(p => p.includes('Contract constraints required for repair:'))).toHaveLength(1);
    expect(loop.turns[1].repairAttempted).toBe(false);
  });

  it('fails closed with the repair result as governed evidence when no allowance remains', async () => {
    const repairReply = result({
      status: 'completed',
      requestId: 'repair-authoritative',
      completion: JSON.stringify(MISSING_CONTENT_PROPOSAL),
    });
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: MISSING_CONTENT_PROPOSAL }) }),
      repairReply,
    ]);
    const loop = await runInvestigationLoop(baseParams(root, dispatcher, { maxTurns: 1 }));

    expect(loop.outcome.kind).toBe('invalid_proposal');
    expect(loop.governedResult.requestId).toBe('repair-authoritative');
    expect(dispatcher.requests).toHaveLength(2);
  });

  it('fails closed without attempting repair when proposal errors are non-repairable', async () => {
    const nonRepairableProposal = {
      ...PROPOSAL,
      operations: [
        { type: 'replace', path: '/tmp/abs.js', reason: 'bad', content: 'console.log()' },
      ],
    };
    const dispatcher = new ScriptedDispatcher([
      result({ status: 'completed', completion: envelope({ action: 'submit_proposal', proposal: nonRepairableProposal }) }),
    ]);

    const loop = await runInvestigationLoop(baseParams(root, dispatcher));
    expect(loop.outcome.kind).toBe('invalid_proposal');
    expect(dispatcher.requests).toHaveLength(1); // No repair attempted!
    expect(loop.turns[0].repairAttempted).toBe(false);
  });
});
