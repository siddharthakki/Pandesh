import { describe, expect, it } from 'vitest';
import { ToolLoopDetector, ToolResultObservation } from '../../reliability/ToolCallReliability';
import { ToolCall } from '../../tools/ToolTypes';

const readA: ToolCall = { function: { name: 'read_file', arguments: { path: 'a.ts' } } };
const readB: ToolCall = { function: { name: 'read_file', arguments: { path: 'b.ts' } } };
const write: ToolCall = { function: { name: 'write_file', arguments: { path: 'a.ts', content: 'v2' } } };
const validate: ToolCall = { function: { name: 'run_command', arguments: { command: 'npm test' } } };

function ok(resultFingerprint: string, mutatedWorkspace = false): ToolResultObservation {
  return { ok: true, mutatedWorkspace, classification: 'success', resultFingerprint };
}

function failed(classification = 'failed'): ToolResultObservation {
  return { ok: false, mutatedWorkspace: false, classification, resultFingerprint: `failure:${classification}` };
}

describe('M11 progress-aware loop detection (Blocker 12)', () => {
  it('blocks a duplicate call with no intervening progress', () => {
    const detector = new ToolLoopDetector(2);
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('same-content'));
    const blocked = detector.beforeDispatch(readA);
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('duplicate_tool_call');
  });

  it('allows the same call again after a successful workspace mutation', () => {
    const detector = new ToolLoopDetector(2);
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('v1-content'));
    expect(detector.beforeDispatch(write).ok).toBe(true);
    detector.recordResult(write, ok('written', true));
    // Rereading the file after the mutation is legitimate verification.
    expect(detector.beforeDispatch(readA).ok).toBe(true);
  });

  it('allows the same read again after its result changed (changed result resets no-progress history)', () => {
    const detector = new ToolLoopDetector(2);
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('content-v1'));
    expect(detector.beforeDispatch(readB).ok).toBe(true);
    detector.recordResult(readB, ok('b-content'));
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('content-v2')); // result changed → progress
    // The changed result advanced the progress epoch, so observing again is allowed.
    expect(detector.beforeDispatch(readA).ok).toBe(true);
  });

  it('blocks an A/B/A/B cycle when the intervening results show no progress', () => {
    const detector = new ToolLoopDetector(2);
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('a-static'));
    expect(detector.beforeDispatch(readB).ok).toBe(true);
    detector.recordResult(readB, ok('b-static'));
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('a-static'));
    const blocked = detector.beforeDispatch(readB);
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('tool_loop_detected');
    expect(blocked.pattern).toBe('A -> B -> A -> B');
  });

  it('allows an A/B sequence when the results show progress', () => {
    const detector = new ToolLoopDetector(2);
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('a-v1'));
    expect(detector.beforeDispatch(readB).ok).toBe(true);
    detector.recordResult(readB, ok('b-v1'));
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('a-v2')); // A's result changed → progress
    expect(detector.beforeDispatch(readB).ok).toBe(true);
  });

  it('blocks repeated identical failures at the profile threshold', () => {
    const detector = new ToolLoopDetector(2);
    expect(detector.beforeDispatch(validate).ok).toBe(true);
    expect(detector.recordResult(validate, failed()).ok).toBe(true);
    expect(detector.beforeDispatch(readA).ok).toBe(true);
    detector.recordResult(readA, ok('a'));
    expect(detector.beforeDispatch(validate).ok).toBe(true);
    const blocked = detector.recordResult(validate, failed());
    expect(blocked.ok).toBe(false);
    expect(blocked.pattern).toBe('repeated_failure');
  });

  it('allows intentionally repeated validation after a repair (mutation resets failure counts)', () => {
    const detector = new ToolLoopDetector(2);
    expect(detector.beforeDispatch(validate).ok).toBe(true);
    expect(detector.recordResult(validate, failed()).ok).toBe(true);
    expect(detector.beforeDispatch(write).ok).toBe(true);
    detector.recordResult(write, ok('fixed', true));
    expect(detector.beforeDispatch(validate).ok).toBe(true);
    // The first failure after the repair does not trip the threshold.
    expect(detector.recordResult(validate, failed()).ok).toBe(true);
  });
});
