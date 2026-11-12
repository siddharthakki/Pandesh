import { describe, it, expect } from 'vitest';
import { columnOf, needsYouCount } from '../renderer-v2/src/boardModel';

describe('UI v2 Board model — Core attempt status to column', () => {
  it('shows running only while Core proves a worker holds the task', () => {
    expect(columnOf({ status: 'running', live: true, interrupted: false })).toBe('running');
    expect(columnOf({ status: 'running', live: false, interrupted: false })).toBe('blocked');
    expect(columnOf({ status: 'validating', live: true, interrupted: true })).toBe('blocked');
  });

  it('never shows success before Core records completion', () => {
    for (const status of ['created', 'queued', 'running', 'validating', 'waiting_for_approval', 'cancelling', 'paused', 'blocked', 'recovery_required']) {
      expect(columnOf({ status, live: true, interrupted: false })).not.toBe('completed');
    }
    expect(columnOf({ status: 'completed', live: false, interrupted: false })).toBe('completed');
  });

  it('maps approvals, failures, cancellations and unknown states truthfully', () => {
    expect(columnOf({ status: 'waiting_for_approval', live: false, interrupted: false })).toBe('needs');
    expect(columnOf({ status: 'failed', live: false, interrupted: false })).toBe('failed');
    expect(columnOf({ status: 'cancelled', live: false, interrupted: false })).toBe('failed');
    expect(columnOf({ status: 'recovery_required', live: false, interrupted: true })).toBe('blocked');
    expect(columnOf({ status: 'queued', live: false, interrupted: true })).toBe('blocked');
    expect(columnOf({ status: 'something_new', live: true, interrupted: false })).toBe('blocked');
  });

  it('counts what needs the user from Core records, falling back to a pending snapshot approval', () => {
    const tasks = [
      { status: 'waiting_for_approval', live: false, interrupted: false },
      { status: 'running', live: true, interrupted: false },
      { status: 'waiting_for_approval', live: false, interrupted: false },
    ];
    expect(needsYouCount(tasks, false)).toBe(2);
    expect(needsYouCount([], true)).toBe(1);
    expect(needsYouCount([], false)).toBe(0);
  });
});
