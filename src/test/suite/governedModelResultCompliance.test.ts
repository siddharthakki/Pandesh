import { describe, expect, it } from 'vitest';
import {
  GOVERNED_MODEL_CONTRACT_VERSION,
  GovernedModelRequest,
  GovernedModelResult,
  ModelExecutionEvidence,
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

function baseEvidence(overrides: Partial<ModelExecutionEvidence> = {}): ModelExecutionEvidence {
  return {
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId: 'req_1',
    invocationId: 'inv_1',
    taskId: 'task_1',
    model: 'qwen2.5-coder:7b',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    status: 'completed',
    ...overrides,
  };
}

function baseResult(overrides: Partial<GovernedModelResult> = {}, evidenceOverrides: Partial<ModelExecutionEvidence> = {}): GovernedModelResult {
  return {
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId: 'req_1',
    invocationId: 'inv_1',
    taskId: 'task_1',
    model: 'qwen2.5-coder:7b',
    status: 'completed',
    completion: 'Done.',
    evidence: baseEvidence(evidenceOverrides),
    ...overrides,
  };
}

describe('verifyGovernedModelResultCompliance', () => {
  it('accepts a valid completed result', () => {
    const report = verifyGovernedModelResultCompliance(baseRequest(), baseResult());
    expect(report).toEqual({ compliant: true, violations: [] });
  });

  it('accepts a valid failed result', () => {
    const result = baseResult(
      { status: 'failed', completion: undefined, failureCode: 'provider_failure', failureReason: 'The governed model provider failed during execution.' },
      { status: 'failed', failureCode: 'provider_failure', failureReason: 'The governed model provider failed during execution.' },
    );
    expect(verifyGovernedModelResultCompliance(baseRequest(), result)).toEqual({ compliant: true, violations: [] });
  });

  it('accepts a valid cancelled result', () => {
    const result = baseResult(
      { status: 'cancelled', completion: undefined, failureCode: 'cancelled', failureReason: 'The governed model call was cancelled before completion.' },
      { status: 'cancelled', failureCode: 'cancelled', failureReason: 'The governed model call was cancelled before completion.' },
    );
    expect(verifyGovernedModelResultCompliance(baseRequest(), result)).toEqual({ compliant: true, violations: [] });
  });

  it('rejects a request/result requestId mismatch', () => {
    const result = baseResult({ requestId: 'req_other' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.compliant).toBe(false);
    expect(report.violations).toContain('request_id_mismatch');
  });

  it('rejects an invocationId/taskId mismatch', () => {
    const result = baseResult({ invocationId: 'inv_other', taskId: 'task_other' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('invocation_id_mismatch');
    expect(report.violations).toContain('task_id_mismatch');
  });

  it('rejects a model mismatch between request and result', () => {
    const result = baseResult({ model: 'other-model' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('model_mismatch');
  });

  it('rejects a provider mismatch between requested and returned provider', () => {
    const request = baseRequest({ providerType: 'ollama' });
    const result = baseResult({ providerType: 'openai-compatible' }, { providerType: 'openai-compatible' });
    const report = verifyGovernedModelResultCompliance(request, result);
    expect(report.violations).toContain('provider_mismatch');
  });

  it('does not flag a provider mismatch when the request left providerType unspecified', () => {
    const result = baseResult({ providerType: 'ollama' }, { providerType: 'ollama' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).not.toContain('provider_mismatch');
  });

  it('rejects an invalid status value', () => {
    const result = baseResult({ status: 'in_progress' as unknown as GovernedModelResult['status'] });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('invalid_status');
  });

  it('rejects a completed status without a completion', () => {
    const result = baseResult({ completion: undefined });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('missing_completion_for_completed_status');
  });

  it('rejects a failed status without a failure code', () => {
    const result = baseResult({ status: 'failed', completion: undefined }, { status: 'failed' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('missing_failure_code_for_non_completed_status');
  });

  it('rejects a completed status carrying a failure code', () => {
    const result = baseResult({ failureCode: 'provider_failure' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('unexpected_failure_code_for_completed_status');
  });

  it('rejects a failed status carrying a completion (completion/failure contradiction)', () => {
    const result = baseResult(
      { status: 'failed', completion: 'Done.', failureCode: 'provider_failure' },
      { status: 'failed', failureCode: 'provider_failure' },
    );
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('unexpected_completion_for_non_completed_status');
  });

  it('rejects a result/evidence identity mismatch', () => {
    const result = baseResult({}, { taskId: 'task_other' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('evidence_identity_mismatch');
  });

  it('rejects a result/evidence status mismatch', () => {
    const result = baseResult({}, { status: 'failed', failureCode: 'provider_failure' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('evidence_status_mismatch');
  });

  it('rejects a result/evidence provider mismatch', () => {
    const result = baseResult({ providerType: 'ollama' }, { providerType: 'openai-compatible' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('evidence_provider_mismatch');
  });

  it('does not flag a provider mismatch when only one side defines providerType', () => {
    const result = baseResult({}, { providerType: 'ollama' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).not.toContain('evidence_provider_mismatch');
  });

  it('rejects a result/evidence failure-code mismatch', () => {
    const result = baseResult(
      { status: 'failed', completion: undefined, failureCode: 'provider_failure', failureReason: 'x' },
      { status: 'failed', failureCode: 'timeout', failureReason: 'x' },
    );
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('evidence_failure_code_mismatch');
  });

  it('rejects a result/evidence failure-reason mismatch', () => {
    const result = baseResult(
      { status: 'failed', completion: undefined, failureCode: 'provider_failure', failureReason: 'Reason A' },
      { status: 'failed', failureCode: 'provider_failure', failureReason: 'Reason B' },
    );
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('evidence_failure_reason_mismatch');
  });

  it('rejects completed evidence that still carries failure metadata', () => {
    const result = baseResult({}, { failureCode: 'provider_failure', failureReason: 'x' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('completed_evidence_with_failure_metadata');
  });

  it('rejects failed evidence that is missing its failure code', () => {
    const result = baseResult(
      { status: 'failed', completion: undefined, failureCode: 'provider_failure', failureReason: 'x' },
      { status: 'failed', failureCode: undefined },
    );
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('failed_evidence_missing_failure_code');
  });

  it('rejects invalid timestamps', () => {
    const result = baseResult({}, { startedAt: 'not-a-date' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('invalid_timestamps');
  });

  it('rejects a completedAt earlier than startedAt', () => {
    const result = baseResult({}, { startedAt: '2026-01-01T00:00:05.000Z', completedAt: '2026-01-01T00:00:00.000Z' });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('invalid_timestamps');
  });

  it('rejects a negative duration', () => {
    const result = baseResult({}, { durationMs: -1 });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('invalid_duration');
  });

  it('rejects a non-finite duration', () => {
    const result = baseResult({}, { durationMs: Number.POSITIVE_INFINITY });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('invalid_duration');
  });

  it('rejects negative token counts', () => {
    const result = baseResult({}, { inputTokens: -1 });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('invalid_token_count');
  });

  it('rejects non-integer token counts', () => {
    const result = baseResult({}, { outputTokens: 3.5 });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.violations).toContain('invalid_token_count');
  });

  it('accepts valid zero token counts', () => {
    const result = baseResult({}, { inputTokens: 0, outputTokens: 0 });
    const report = verifyGovernedModelResultCompliance(baseRequest(), result);
    expect(report.compliant).toBe(true);
  });
});
