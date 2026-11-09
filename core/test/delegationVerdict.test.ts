import { describe, expect, it } from 'vitest';
import { evaluateTurnOutcome } from '../runtime/turnOutcome';

const failedRun = { tool: 'run_checks', status: 'completed', result: { content: [{ type: 'text', text: 'npm test exited 1: 1 failing' }], isError: true } };
const delegation = { tool: 'delegate_to_opencode', status: 'completed', result: { content: [{ type: 'text', text: 'fixed src/cart.js' }] } };
const coreRerun = (passed: boolean) => ({
  tool: 'run_checks', status: passed ? 'completed' : 'failed',
  result: { content: [{ type: 'text', text: `npm test → ${passed ? 'PASSED' : 'FAILED (exit 1)'}` }], isError: !passed },
});

// M8 re-run (build ee06c90): the diagnostic test run before the fix failed, OpenCode fixed it, Core's re-run passed —
// but the turn was recorded as "attempted_failed: run_checks ran and reported a failure".
describe('turn verdict after a verified delegation (D12)', () => {
  it('Core\'s passing post-fix test run decides the verdict', () => {
    expect(evaluateTurnOutcome([failedRun, delegation, coreRerun(true)] as any).verdict).toBe('verified');
  });

  it('a failing post-fix run keeps the turn failed', () => {
    expect(evaluateTurnOutcome([failedRun, delegation, coreRerun(false)] as any).verdict).toBe('attempted_failed');
  });
});
