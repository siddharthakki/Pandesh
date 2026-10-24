import { describe, expect, it } from 'vitest';
import {
  isReadOnlyInspectionRequest,
  resolveExecutionMode,
  resolveExecutionModelOverride,
} from '../../agent/TaskIntent';

describe('task intent routing', () => {
  it('constrains an explicit read-only Agent request to Ask mode', () => {
    const prompt = [
      'Perform read-only repository inspection only.',
      'Read package.json and list src.',
      'Do not modify files. Do not run validation commands.',
    ].join(' ');

    expect(isReadOnlyInspectionRequest(prompt)).toBe(true);
    expect(resolveExecutionMode(prompt, 'agent')).toBe('ask');
  });

  it('preserves the Agent model when Auto is constrained to Ask mode', () => {
    const prompt = 'Perform read-only repository inspection only.';

    expect(resolveExecutionModelOverride(prompt, 'agent', undefined, 'qwen3-coder:30b'))
      .toBe('qwen3-coder:30b');
    expect(resolveExecutionModelOverride(prompt, 'agent', 'custom-coder:14b', 'qwen3-coder:30b'))
      .toBe('custom-coder:14b');
  });

  it('keeps a normal implementation request in Agent mode', () => {
    const prompt = 'Fix src/math.ts. Do not modify test fixtures.';

    expect(isReadOnlyInspectionRequest(prompt)).toBe(false);
    expect(resolveExecutionMode(prompt, 'agent')).toBe('agent');
  });

  it('does not change an explicitly selected non-Agent mode', () => {
    expect(resolveExecutionMode('Perform read-only inspection only.', 'plan')).toBe('plan');
  });
});
