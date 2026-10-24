import { describe, expect, it } from 'vitest';
import { SessionContextGate } from '../../agent/SessionContextGate';

describe('session context gate', () => {
  it.each(['executing', 'completed', 'blocked', 'paused'] as const)(
    'starts clean for a prior %s task',
    currentPhase => {
      const result = new SessionContextGate().resolve({
        conversationId: 'fresh-chat',
        currentHead: 'prior-task',
        currentPhase,
      });

      expect(result.decision).toBe('start-clean');
      expect(result.includeCompletedHistory).toBe(false);
    },
  );

  it('requires an explicit resume action', () => {
    const result = new SessionContextGate().resolve({
      conversationId: 'fresh-chat',
      currentHead: 'prior-task',
      currentPhase: 'paused',
      explicitResumeTaskId: 'chosen-task',
    });

    expect(result.decision).toBe('explicit-resume');
    expect(result.taskId).toBe('chosen-task');
    expect(result.includeCompletedHistory).toBe(false);
  });
});
