import { describe, expect, it, vi } from 'vitest';
import { CoreModelTruthRecorder, ModelTruthSink } from '../../agent/CoreModelTruthRecorder';
import { GovernedModelExecutionDispatcher, GovernedModelExecutionDependency, GovernedModelExecutionOutcome } from '../../agent/GovernedModelExecutionDispatcher';
import { GOVERNED_MODEL_CONTRACT_VERSION, GovernedModelRequest } from '../../agent/GovernedModelExecutionTypes';

function baseRequest(overrides: Partial<GovernedModelRequest> = {}): GovernedModelRequest {
  return {
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId: 'req_1',
    invocationId: 'inv_1',
    taskId: 'task_1',
    model: 'qwen2.5-coder:1.5b',
    providerType: 'ollama',
    prompt: 'hello',
    ...overrides,
  };
}

function fakeDependency(impl: (request: GovernedModelRequest) => Promise<GovernedModelExecutionOutcome>): GovernedModelExecutionDependency {
  return { execute: vi.fn(impl) };
}

function fakeSink(): ModelTruthSink & { started: unknown[]; completed: unknown[] } {
  const started: unknown[] = [];
  const completed: unknown[] = [];
  return {
    started,
    completed,
    async startModelInvocation(attemptId, input) {
      started.push({ attemptId, ...input });
      return { id: `minv_${started.length}` };
    },
    async completeModelInvocation(id, input) {
      completed.push({ id, ...input });
      return {};
    },
  };
}

describe('CoreModelTruthRecorder', () => {
  it('records requested provider/model before dispatch, and actual/status after', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'hi', providerType: 'ollama' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const sink = fakeSink();
    const recorder = new CoreModelTruthRecorder(dispatcher, sink, 'att_1');

    const result = await recorder.dispatch(baseRequest());

    expect(result.status).toBe('completed');
    expect(sink.started).toEqual([{ attemptId: 'att_1', requestedProvider: 'ollama', requestedModel: 'qwen2.5-coder:1.5b' }]);
    expect(sink.completed).toHaveLength(1);
    const [completed] = sink.completed as Array<{ status: string; fallbackUsed: boolean; actualProvider: string }>;
    expect(completed.status).toBe('succeeded');
    expect(completed.fallbackUsed).toBe(false);
    expect(completed.actualProvider).toBe('ollama');
  });

  it('regression: a provider mismatch never surfaces as a silent successful fallback — the dispatcher itself converts it to a recorded failure', async () => {
    // GovernedModelExecutionDispatcher's own compliance verification rejects a
    // completed result whose providerType differs from the request's, converting it
    // to an invalid_model_response failure before this recorder ever sees a
    // "success" — so fallbackUsed can never read true for a masked substitution.
    const dependency = fakeDependency(async () => ({ completion: 'hi', providerType: 'openai-compatible' as const }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const sink = fakeSink();
    const recorder = new CoreModelTruthRecorder(dispatcher, sink, 'att_1');

    const result = await recorder.dispatch(baseRequest({ providerType: 'ollama' }));

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('invalid_model_response');
    const [completed] = sink.completed as Array<{ status: string; fallbackUsed: boolean }>;
    expect(completed.status).toBe('failed');
    expect(completed.fallbackUsed).toBe(false);
  });

  it('records a failed dispatch as status failed, not succeeded', async () => {
    const dependency = fakeDependency(async () => {
      throw new Error('boom');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const sink = fakeSink();
    const recorder = new CoreModelTruthRecorder(dispatcher, sink, 'att_1');

    const result = await recorder.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    const [completed] = sink.completed as Array<{ status: string }>;
    expect(completed.status).toBe('failed');
  });

  it('records a cancelled dispatch as status cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const dependency = fakeDependency(async () => ({ completion: 'hi' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const sink = fakeSink();
    const recorder = new CoreModelTruthRecorder(dispatcher, sink, 'att_1');

    const result = await recorder.dispatch(baseRequest({ signal: controller.signal }));

    expect(result.status).toBe('cancelled');
    const [completed] = sink.completed as Array<{ status: string }>;
    expect(completed.status).toBe('cancelled');
  });

  it('never calls the dependency more than once per dispatch, even with recording wrapped around it', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'hi' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const sink = fakeSink();
    const recorder = new CoreModelTruthRecorder(dispatcher, sink, 'att_1');

    await recorder.dispatch(baseRequest());

    expect(dependency.execute).toHaveBeenCalledTimes(1);
  });
});
