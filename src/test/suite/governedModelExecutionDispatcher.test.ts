import { describe, expect, it, vi } from 'vitest';
import {
  GovernedModelExecutionDependency,
  GovernedModelExecutionDependencyError,
  GovernedModelExecutionDispatcher,
  GovernedModelExecutionOutcome,
} from '../../agent/GovernedModelExecutionDispatcher';
import {
  GOVERNED_MODEL_CONTRACT_VERSION,
  GovernedModelRequest,
  verifyGovernedModelResultCompliance,
} from '../../agent/GovernedModelExecutionTypes';

function baseRequest(overrides: Partial<GovernedModelRequest> = {}): GovernedModelRequest {
  return {
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId: 'req_1',
    invocationId: 'inv_1',
    taskId: 'task_1',
    model: 'qwen2.5-coder:7b',
    prompt: 'Summarize the diff.',
    ...overrides,
  };
}

function fixedClock(...timestamps: string[]): () => string {
  let index = 0;
  return () => timestamps[Math.min(index++, timestamps.length - 1)];
}

function fakeDependency(
  impl: (request: GovernedModelRequest) => Promise<GovernedModelExecutionOutcome>,
): GovernedModelExecutionDependency {
  return { execute: vi.fn(impl) };
}

function dependencyError(
  message: string,
  failureCode?: GovernedModelExecutionDependencyError['failureCode'],
): GovernedModelExecutionDependencyError {
  const error: GovernedModelExecutionDependencyError = new Error(message);
  error.failureCode = failureCode;
  return error;
}

describe('GovernedModelExecutionDispatcher', () => {
  it('delegates a valid request exactly once', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'Done.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest());

    expect(dependency.execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });

  it('rejects an invalid request before delegation', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'Done.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock('2026-01-01T00:00:00.000Z'));

    const result = await dispatcher.dispatch(baseRequest({ requestId: '' }));

    expect(dependency.execute).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('execution_rejected');
  });

  it('prevents delegation when cancellation occurs before execution', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'Done.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock('2026-01-01T00:00:00.000Z'));
    const controller = new AbortController();
    controller.abort();

    const result = await dispatcher.dispatch(baseRequest({ signal: controller.signal }));

    expect(dependency.execute).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
    expect(result.failureCode).toBe('cancelled');
  });

  it('propagates cancellation to the injected dependency', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const dependency = fakeDependency(async request => {
      receivedSignal = request.signal;
      controller.abort();
      throw new Error('aborted by caller');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest({ signal: controller.signal }));

    expect(receivedSignal).toBe(controller.signal);
    expect(result.status).toBe('cancelled');
    expect(result.failureCode).toBe('cancelled');
  });

  it('returns a successful result without mutation', async () => {
    const outcome: GovernedModelExecutionOutcome = {
      completion: 'The diff adds a dispatcher.',
      finishReason: 'stop',
      inputTokens: 42,
      outputTokens: 8,
    };
    const dependency = fakeDependency(async () => outcome);
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.completion).toBe(outcome.completion);
    expect(result.evidence.finishReason).toBe('stop');
    expect(result.evidence.inputTokens).toBe(42);
    expect(result.evidence.outputTokens).toBe(8);
    expect(result.failureCode).toBeUndefined();
  });

  it('normalizes a provider failure deterministically', async () => {
    const dependency = fakeDependency(async () => {
      throw dependencyError('connection refused');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('provider_failure');
  });

  it('normalizes a timeout deterministically', async () => {
    const dependency = fakeDependency(async () => {
      throw dependencyError('deadline exceeded', 'timeout');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('timeout');
    expect(result.evidence.durationMs).toBe(5000);
  });

  it('normalizes a model-unavailable failure deterministically', async () => {
    const dependency = fakeDependency(async () => {
      throw dependencyError('model not found', 'model_unavailable');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('model_unavailable');
  });

  it('normalizes an invalid model response deterministically', async () => {
    const dependency = fakeDependency(async () => ({ completion: undefined as unknown as string }));
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('invalid_model_response');
  });

  it('does not retry after a failure', async () => {
    const dependency = fakeDependency(async () => {
      throw dependencyError('boom');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    await dispatcher.dispatch(baseRequest());

    expect(dependency.execute).toHaveBeenCalledTimes(1);
  });

  it('has no tool or planning dependency', () => {
    const dependency = fakeDependency(async () => ({ completion: 'Done.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);

    expect(Object.keys(dispatcher)).not.toContain('tools');
    expect(Object.keys(dispatcher)).not.toContain('planner');
  });

  it('has no concrete provider dependency', () => {
    const dependency = fakeDependency(async () => ({ completion: 'Done.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);

    expect((dispatcher as unknown as { providerType?: string }).providerType).toBeUndefined();
  });

  it('does not add raw prompt or completion text to evidence', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'Sensitive completion text.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest({ prompt: 'Sensitive prompt text.' }));

    const evidenceKeys = Object.keys(result.evidence);
    expect(evidenceKeys).not.toContain('prompt');
    expect(evidenceKeys).not.toContain('completion');
    expect(JSON.stringify(result.evidence)).not.toContain('Sensitive prompt text.');
    expect(JSON.stringify(result.evidence)).not.toContain('Sensitive completion text.');
  });

  it('records promptCharacterCount as safe input-size metadata on a successful call', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'Done.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest({ prompt: 'Summarize the diff please.' }));

    expect(result.evidence.promptCharacterCount).toBe('Summarize the diff please.'.length);
  });

  it('records promptCharacterCount on a failed call, without any raw prompt text', async () => {
    const dependency = fakeDependency(async () => {
      throw dependencyError('connection refused');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest({ prompt: 'Sensitive prompt text.' }));

    expect(result.status).toBe('failed');
    expect(result.evidence.promptCharacterCount).toBe('Sensitive prompt text.'.length);
    expect(JSON.stringify(result.evidence)).not.toContain('Sensitive prompt text.');
  });

  it('does not add raw provider exception text to failure evidence, using a stable sanitized reason instead', async () => {
    const dependency = fakeDependency(async () => {
      throw new Error('connection to internal-endpoint.example failed for prompt "top secret plan"');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(
      dependency,
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
    );

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('provider_failure');
    expect(result.evidence.failureReason).toBe('The governed model provider failed during execution.');
    expect(JSON.stringify(result.evidence)).not.toContain('internal-endpoint.example');
    expect(JSON.stringify(result.evidence)).not.toContain('top secret plan');
  });

  describe('M4.7-M4.8 contract-compliance verification', () => {
    it('normalizes a malformed provider outcome (negative token count) to one safe failure', async () => {
      const dependency = fakeDependency(async () => ({ completion: 'Done.', inputTokens: -5 }));
      const dispatcher = new GovernedModelExecutionDispatcher(
        dependency,
        fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
      );

      const result = await dispatcher.dispatch(baseRequest());

      expect(dependency.execute).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(result.failureCode).toBe('invalid_model_response');
      expect(result.completion).toBeUndefined();
      expect(result.evidence.inputTokens).toBeUndefined();
    });

    it('normalizes a malformed provider outcome (non-integer token count) to one safe failure', async () => {
      const dependency = fakeDependency(async () => ({ completion: 'Done.', outputTokens: 3.5 }));
      const dispatcher = new GovernedModelExecutionDispatcher(
        dependency,
        fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
      );

      const result = await dispatcher.dispatch(baseRequest());

      expect(result.status).toBe('failed');
      expect(result.failureCode).toBe('invalid_model_response');
    });

    it('normalizes a provider-type mismatch between the requested and resolved provider to one safe failure', async () => {
      const dependency = fakeDependency(async () => ({ completion: 'Done.', providerType: 'openai-compatible' as const }));
      const dispatcher = new GovernedModelExecutionDispatcher(
        dependency,
        fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
      );

      const result = await dispatcher.dispatch(baseRequest({ providerType: 'ollama' }));

      expect(result.status).toBe('failed');
      expect(result.failureCode).toBe('invalid_model_response');
    });

    it('does not expose compliance-violation detail or dependency data through the normalized failure', async () => {
      const dependency = fakeDependency(async () => ({ completion: 'Sensitive completion text.', inputTokens: -1 }));
      const dispatcher = new GovernedModelExecutionDispatcher(
        dependency,
        fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
      );

      const result = await dispatcher.dispatch(baseRequest());

      expect(JSON.stringify(result)).not.toContain('Sensitive completion text.');
      expect(JSON.stringify(result)).not.toContain('violations');
      expect(result.evidence.failureReason).toBe('The governed model provider returned an invalid response.');
    });

    it('leaves a compliant completed result unmodified', async () => {
      const dependency = fakeDependency(async () => ({ completion: 'Done.', inputTokens: 10, outputTokens: 5 }));
      const dispatcher = new GovernedModelExecutionDispatcher(
        dependency,
        fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
      );

      const result = await dispatcher.dispatch(baseRequest());

      expect(result.status).toBe('completed');
      expect(result.completion).toBe('Done.');
      expect(result.evidence.inputTokens).toBe(10);
      expect(result.evidence.outputTokens).toBe(5);
    });

    it('sources fresh, valid timing for the compliance fallback instead of reusing an invalid startedAt', async () => {
      const dependency = fakeDependency(async () => ({ completion: 'Done.', inputTokens: -1 }));
      const dispatcher = new GovernedModelExecutionDispatcher(
        dependency,
        fixedClock('not-a-date', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'),
      );

      const result = await dispatcher.dispatch(baseRequest());

      expect(result.status).toBe('failed');
      expect(result.failureCode).toBe('invalid_model_response');
      expect(result.evidence.startedAt).toBe('2026-01-01T00:00:02.000Z');
      expect(result.evidence.completedAt).toBe('2026-01-01T00:00:02.000Z');
      expect(result.evidence.durationMs).toBe(0);
      expect(verifyGovernedModelResultCompliance(baseRequest(), result).compliant).toBe(true);
    });

    it('sources fresh, valid timing for the compliance fallback instead of reusing an invalid completedAt', async () => {
      const dependency = fakeDependency(async () => ({ completion: 'Done.', inputTokens: -1 }));
      const dispatcher = new GovernedModelExecutionDispatcher(
        dependency,
        fixedClock('2026-01-01T00:00:00.000Z', 'not-a-date', '2026-01-01T00:00:05.000Z'),
      );

      const result = await dispatcher.dispatch(baseRequest());

      expect(result.status).toBe('failed');
      expect(result.failureCode).toBe('invalid_model_response');
      expect(result.evidence.startedAt).toBe('2026-01-01T00:00:05.000Z');
      expect(result.evidence.completedAt).toBe('2026-01-01T00:00:05.000Z');
      expect(result.evidence.durationMs).toBe(0);
      expect(verifyGovernedModelResultCompliance(baseRequest(), result).compliant).toBe(true);
    });

    it('sources fresh, valid timing for the compliance fallback instead of reusing a completedAt earlier than startedAt', async () => {
      const dependency = fakeDependency(async () => ({ completion: 'Done.', inputTokens: -1 }));
      const dispatcher = new GovernedModelExecutionDispatcher(
        dependency,
        fixedClock('2026-01-01T00:00:05.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z'),
      );

      const result = await dispatcher.dispatch(baseRequest());

      expect(result.status).toBe('failed');
      expect(result.failureCode).toBe('invalid_model_response');
      expect(result.evidence.startedAt).toBe('2026-01-01T00:00:10.000Z');
      expect(result.evidence.completedAt).toBe('2026-01-01T00:00:10.000Z');
      expect(result.evidence.durationMs).toBe(0);
      expect(verifyGovernedModelResultCompliance(baseRequest(), result).compliant).toBe(true);
    });
  });
});
