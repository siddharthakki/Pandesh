import { describe, expect, it } from 'vitest';
import { applyEvent, describePhase, type LiveEvent, type RunState } from '../renderer-v2/src/runModel';
import { liveActivityDetail } from '../src/host/desktopSession';

const A = 'att_1';
const t = 1_700_000_000_000;
const at = (s: number) => new Date(t + s * 1000).toISOString();
const ev = (s: number, e: Partial<LiveEvent>): LiveEvent => ({ kind: 'activity', at: at(s), attemptId: A, ...e });
const fold = (events: LiveEvent[]): RunState => { let r: RunState | null = null; for (const e of events) r = applyEvent(r, e); return r!; };

describe('live run model', () => {
  it('a model-only turn is reasoning, then writing, and says it called no tool', () => {
    const base = [
      ev(0, { domain: 'attempt', eventType: 'attempt_created' }),
      ev(1, { domain: 'model_invocation', eventType: 'model_invocation_started', invocationId: 'minv_1' }),
      ev(1, { domain: 'attempt', eventType: 'model_pass_started', detail: { pass: 1 } }),
    ];
    expect(fold(base).phase).toBe('waiting');
    const reasoning = fold([...base, ev(5, { domain: 'attempt', eventType: 'model_pass_phase', detail: { pass: 1, phase: 'reasoning' } })]);
    expect(reasoning.phase).toBe('reasoning');
    expect(describePhase(reasoning, t + 70_000).sub).toContain('no new signal for');
    const done = fold([...base,
      ev(60, { domain: 'attempt', eventType: 'model_pass_phase', detail: { pass: 1, phase: 'writing' } }),
      ev(62, { domain: 'attempt', eventType: 'model_pass_ended', detail: { pass: 1, toolCalls: 0, textChars: 120, reasoned: true, durationMs: 61000 } }),
      ev(63, { kind: 'result' }),
    ]);
    expect(done.phase).toBe('completed');
    expect(done.toolCallsTotal).toBe(0);
    expect(done.steps.some((s) => s.label.includes('answered without calling a tool'))).toBe(true);
  });

  it('a tool call is running exactly between its start and its completion, with its own timing', () => {
    const r1 = fold([ev(0, { domain: 'tool_invocation', eventType: 'tool_invocation_started', invocationId: 'inv_1', toolName: 'read_file' })]);
    expect(r1.phase).toBe('tool');
    expect(describePhase(r1, t + 4000).label).toBe('Running read file');
    const r2 = applyEvent(r1, ev(3, { domain: 'tool_invocation', eventType: 'tool_invocation_completed', invocationId: 'inv_1', toolName: 'unknown_tool', invocationStatus: 'succeeded' }))!;
    expect(r2.phase).toBe('waiting');
    expect(r2.steps[0]).toMatchObject({ state: 'ok', startedAt: t, endedAt: t + 3000 });
  });

  it('a failed tool call is failed, not done', () => {
    const r = fold([
      ev(0, { domain: 'tool_invocation', eventType: 'tool_invocation_started', invocationId: 'inv_1', toolName: 'run_command' }),
      ev(1, { domain: 'tool_invocation', eventType: 'tool_invocation_completed', invocationId: 'inv_1', toolName: 'unknown_tool', invocationStatus: 'failed' }),
    ]);
    expect(r.steps[0].state).toBe('failed');
  });

  it('approval waiting shows as awaiting permission and ends when Core resolves it', () => {
    const waiting = fold([ev(0, { kind: 'approval', summary: 'Waiting for file approval: notes.txt' })]);
    expect(waiting.phase).toBe('approval');
    const resolved = applyEvent(waiting, { kind: 'assistant_approval_changed', at: at(9), attemptId: A, summary: 'approval_resolved' })!;
    expect(resolved.steps[0].state).toBe('ok');
    expect(resolved.phase).toBe('waiting');
  });

  it('an expired approval is blocked, never approved', () => {
    const r = fold([ev(0, { kind: 'approval', summary: 'Waiting' }), { kind: 'assistant_approval_changed', at: at(5), attemptId: A, summary: 'approval_expired' }]);
    expect(r.steps[0].state).toBe('blocked');
  });

  it('failure carries the Core reason; cancel is a stop; nothing becomes completed without the result', () => {
    const failed = fold([ev(0, { domain: 'attempt', eventType: 'model_pass_started', detail: { pass: 1 } }), ev(2, { domain: 'attempt', eventType: 'attempt_failed', detail: { reason: 'model unreachable' } })]);
    expect(failed.phase).toBe('failed');
    expect(describePhase(failed, t).sub).toBe('model unreachable');
    const cancelled = fold([ev(0, { domain: 'tool_invocation', eventType: 'tool_invocation_started', invocationId: 'i', toolName: 'x_y' }), ev(1, { kind: 'cancelled' })]);
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.steps[0].state).toBe('cancelled');
    const running = fold([ev(0, { domain: 'tool_invocation', eventType: 'tool_invocation_started', invocationId: 'i', toolName: 'x_y' })]);
    expect(running.outcome).toBeUndefined();
  });

  it('a late event after the run ended does not reopen it; an authorized resume does', () => {
    const done = fold([ev(0, { kind: 'result' })]);
    expect(applyEvent(done, ev(5, { kind: 'token' }))!.phase).toBe('completed');
    const interrupted = fold([ev(0, { domain: 'attempt', eventType: 'attempt_approval_orphaned' })]);
    expect(interrupted.phase).toBe('interrupted');
    const resumed = applyEvent(interrupted, ev(9, { domain: 'attempt', eventType: 'attempt_resumed' }))!;
    expect(resumed.outcome).toBeUndefined();
    expect(resumed.phase).toBe('waiting');
  });

  it('final verification is recorded as its own step and marks the run verified', () => {
    const r = fold([ev(0, { domain: 'execution_quality', eventType: 'final_verification_recorded' }), ev(1, { kind: 'result' })]);
    expect(r.verified).toBe(true);
    expect(describePhase(r, t).sub).toContain('Checked');
  });

  it('events of another attempt start a separate run', () => {
    const r1 = fold([ev(0, { kind: 'result' })]);
    const r2 = applyEvent(r1, { kind: 'activity', at: at(10), attemptId: 'att_2', domain: 'attempt', eventType: 'model_pass_started', detail: { pass: 1 } })!;
    expect(r2.attemptId).toBe('att_2');
    expect(r2.outcome).toBeUndefined();
  });
});

describe('liveActivityDetail privacy', () => {
  it('copies only numbers, phase words and a clipped reason, never text or arguments', () => {
    const d = liveActivityDetail({ pass: 2, phase: 'reasoning', toolCalls: 1, textChars: 9, text: 'SECRET message body', argsSummary: { path: 'C:/private.txt' }, apiKey: 'sk-1', failureReason: 'x'.repeat(500) })!;
    expect(JSON.stringify(d)).not.toContain('SECRET');
    expect(JSON.stringify(d)).not.toContain('private');
    expect(JSON.stringify(d)).not.toContain('sk-1');
    expect(d.reason!.length).toBeLessThanOrEqual(240);
    expect(d).toMatchObject({ pass: 2, phase: 'reasoning', toolCalls: 1, textChars: 9 });
  });
  it('rejects a phase that is not a plain word', () => {
    expect(liveActivityDetail({ phase: 'reasoning; drop' })?.phase).toBeUndefined();
  });
});

describe('model loading', () => {
  it('is its own phase between start and the first model call', () => {
    const r = fold([ev(0, { domain: 'attempt', eventType: 'step_start' }), ev(1, { domain: 'attempt', eventType: 'model_loading_started', detail: { phase: 'loading' } })]);
    expect(r.phase).toBe('loading');
    expect(describePhase(r, t + 100_000).label).toBe('Loading the model');
    const r2 = applyEvent(r, ev(180, { domain: 'attempt', eventType: 'model_loading_finished', detail: { ok: true } }))!;
    expect(r2.phase).toBe('preparing');
  });
});

describe('approval de-duplication', () => {
  it('two approval events for the same wait make one step', () => {
    const r = fold([ev(0, { kind: 'approval', summary: 'Waiting for mutation approval: x' }), ev(0, { kind: 'approval', summary: 'Waiting for mutation approval: x' })]);
    expect(r.steps.filter((s) => s.kind === 'approval')).toHaveLength(1);
  });
});
