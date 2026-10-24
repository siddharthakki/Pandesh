import { describe, expect, it } from 'vitest';
import { ProviderType } from '../../providers/ProviderTypes';
import {
  GOVERNED_MODEL_CONTRACT_VERSION,
  GOVERNED_MODEL_FAILURE_CODES,
  GovernedModelFailureCode,
  GovernedModelRequest,
  GovernedModelResult,
  ModelExecutionEvidence,
  isGovernedModelFailureCode,
  validateGovernedModelRequest,
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

describe('GovernedModelExecutionTypes', () => {
  it('accepts a valid request representing one prompt', () => {
    const request = baseRequest();
    const validation = validateGovernedModelRequest(request);

    expect(validation.accepted).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(typeof request.prompt).toBe('string');
  });

  it('represents a valid successful result for one completion', () => {
    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'req_2',
      invocationId: 'inv_2',
      taskId: 'task_2',
      model: 'qwen2.5-coder:7b',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      status: 'completed',
    };
    const result: GovernedModelResult = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'req_2',
      invocationId: 'inv_2',
      taskId: 'task_2',
      model: 'qwen2.5-coder:7b',
      status: 'completed',
      completion: 'Done.',
      evidence,
    };

    expect(result.status).toBe('completed');
    expect(result.completion).toBe('Done.');
    expect(result.failureCode).toBeUndefined();
  });

  it('captures evidence with token usage when available', () => {
    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'req_3',
      invocationId: 'inv_3',
      taskId: 'task_3',
      model: 'llama3.1:8b',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:02.000Z',
      durationMs: 2000,
      inputTokens: 128,
      outputTokens: 64,
      finishReason: 'stop',
      status: 'completed',
    };

    expect(evidence.inputTokens).toBe(128);
    expect(evidence.outputTokens).toBe(64);
  });

  it('captures evidence without token usage when unavailable', () => {
    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'req_4',
      invocationId: 'inv_4',
      taskId: 'task_4',
      model: 'mistral:7b',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      status: 'completed',
    };

    expect(evidence.inputTokens).toBeUndefined();
    expect(evidence.outputTokens).toBeUndefined();
  });

  it('captures promptCharacterCount as safe input-size metadata, never the prompt text', () => {
    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'req_4b',
      invocationId: 'inv_4b',
      taskId: 'task_4b',
      model: 'mistral:7b',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      promptCharacterCount: 27,
      status: 'completed',
    };

    expect(evidence.promptCharacterCount).toBe(27);
    expect(Object.keys(evidence)).not.toContain('prompt');
    expect(JSON.stringify(evidence)).not.toContain('"prompt"');
  });

  it('represents a cancellation status with a deterministic failure code', () => {
    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'req_5',
      invocationId: 'inv_5',
      taskId: 'task_5',
      model: 'qwen2.5-coder:7b',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.500Z',
      durationMs: 500,
      status: 'cancelled',
      failureCode: 'cancelled',
      failureReason: 'Cancelled via existing AbortSignal cancellation mechanism.',
    };

    expect(evidence.status).toBe('cancelled');
    expect(evidence.failureCode).toBe('cancelled');
    expect(isGovernedModelFailureCode(evidence.failureCode)).toBe(true);
  });

  it('represents a timeout status with a deterministic failure code', () => {
    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'req_6',
      invocationId: 'inv_6',
      taskId: 'task_6',
      model: 'qwen2.5-coder:7b',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'failed',
      failureCode: 'timeout',
      failureReason: 'Model call exceeded the configured deadline.',
    };

    expect(evidence.failureCode).toBe('timeout');
    expect(evidence.completedAt).toBeUndefined();
  });

  it('represents a provider failure status with a deterministic failure code', () => {
    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'req_7',
      invocationId: 'inv_7',
      taskId: 'task_7',
      model: 'qwen2.5-coder:7b',
      providerType: 'ollama',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'failed',
      failureCode: 'provider_failure',
      failureReason: 'Provider connection was refused.',
    };

    expect(evidence.failureCode).toBe('provider_failure');
    expect(evidence.providerType).toBe('ollama');
  });

  it('excludes tool and planning fields from the governed model request', () => {
    const request = baseRequest();
    const keys = Object.keys(request);

    expect(keys).not.toContain('tools');
    expect(keys).not.toContain('toolCalls');
    expect(keys).not.toContain('plan');
    expect(keys).not.toContain('mode');
    expect(keys).not.toContain('images');
    expect(keys.sort()).toEqual(
      ['contractVersion', 'invocationId', 'model', 'prompt', 'requestId', 'taskId'].sort(),
    );
  });

  it('is provider-independent: providerType is optional and reuses the shared ProviderType union', () => {
    const withoutProvider = baseRequest();
    const withOllama = baseRequest({ providerType: 'ollama' as ProviderType });
    const withOpenAiCompatible = baseRequest({ providerType: 'openai-compatible' as ProviderType });

    expect(validateGovernedModelRequest(withoutProvider).accepted).toBe(true);
    expect(validateGovernedModelRequest(withOllama).accepted).toBe(true);
    expect(validateGovernedModelRequest(withOpenAiCompatible).accepted).toBe(true);
  });

  it('has stable failure-code values', () => {
    expect([...GOVERNED_MODEL_FAILURE_CODES]).toEqual([
      'model_unavailable',
      'timeout',
      'provider_failure',
      'cancelled',
      'invalid_model_response',
      'execution_rejected',
    ]);

    const notAFailureCode: string = 'not_a_code';
    expect(isGovernedModelFailureCode(notAFailureCode satisfies string)).toBe(false);

    const allValid: GovernedModelFailureCode[] = [...GOVERNED_MODEL_FAILURE_CODES];
    for (const code of allValid) {
      expect(isGovernedModelFailureCode(code)).toBe(true);
    }
  });

  it('rejects an invalid request shape with deterministic error messages', () => {
    const invalid = baseRequest({ requestId: '', model: '' });
    const validation = validateGovernedModelRequest(invalid);

    expect(validation.accepted).toBe(false);
    expect(validation.errors).toEqual([
      'requestId must be a non-empty string',
      'model must be a non-empty string',
    ]);
  });

  it('rejects an untrusted deserialized payload with a non-string prompt, with no unsafe cast needed', () => {
    // JSON.parse yields `any`, matching how a request actually arrives over
    // a transport boundary — no `as unknown as` cast is needed to exercise
    // this rejection path, unlike forcing an invalid value into an
    // already-typed GovernedModelRequest.
    const untrusted = JSON.parse(
      '{"contractVersion":1,"requestId":"req_untrusted","invocationId":"inv_untrusted","taskId":"task_untrusted","model":"m","prompt":null}',
    );

    const validation = validateGovernedModelRequest(untrusted);

    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContain('prompt must be a string');
  });
});
