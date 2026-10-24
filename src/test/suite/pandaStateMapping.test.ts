import { describe, expect, it } from 'vitest';
import {
  pandaStateForEventKind,
  pandaStateForLifecycleState,
  connectorStateForLifecycleState,
  isSubagentEventKind,
} from '../../autonomous/PandaStateMapping';

describe('pandaStateForEventKind', () => {
  it('maps known progress-event kinds to their documented panda state', () => {
    expect(pandaStateForEventKind('preparing')).toBe('thinking');
    expect(pandaStateForEventKind('graph_execution')).toBe('planning');
    expect(pandaStateForEventKind('graph_stage_started')).toBe('delegating');
    expect(pandaStateForEventKind('proposal_generated')).toBe('coding');
    expect(pandaStateForEventKind('mutation_completed')).toBe('building');
    expect(pandaStateForEventKind('validating')).toBe('testing');
    expect(pandaStateForEventKind('proposal_ready')).toBe('reviewing');
    expect(pandaStateForEventKind('waiting_for_delivery_approval')).toBe('waiting_for_delivery_approval');
    expect(pandaStateForEventKind('blocked')).toBe('blocked');
    expect(pandaStateForEventKind('runtime_error')).toBe('failed');
    expect(pandaStateForEventKind('investigation_read_file')).toBe('reading');
    expect(pandaStateForEventKind('investigation_search')).toBe('searching');
    expect(pandaStateForEventKind('investigation_submit_proposal')).toBe('coding');
  });

  it('maps the cancelled event kind to its own calm/stopped state, distinct from blocked', () => {
    expect(pandaStateForEventKind('cancelled')).toBe('cancelled');
    expect(pandaStateForEventKind('cancelled')).not.toBe(pandaStateForEventKind('blocked'));
  });

  it('degrades unknown kinds to thinking rather than throwing', () => {
    expect(pandaStateForEventKind('some_future_kind')).toBe('thinking');
  });
});

describe('pandaStateForLifecycleState', () => {
  it('maps terminal states to completed/failed/blocked', () => {
    expect(pandaStateForLifecycleState('completed')).toBe('completed');
    expect(pandaStateForLifecycleState('failed')).toBe('failed');
    expect(pandaStateForLifecycleState('blocked')).toBe('blocked');
  });

  it('maps cancelled to its own calm/stopped state, distinct from blocked/failed', () => {
    // Regression: cancelled previously fell through to 'blocked', showing the
    // same concerned/blocker pose as an actual failure even though the user
    // deliberately stopped the task.
    expect(pandaStateForLifecycleState('cancelled')).toBe('cancelled');
    expect(pandaStateForLifecycleState('cancelling')).toBe('cancelled');
    expect(pandaStateForLifecycleState('cancelled')).not.toBe(pandaStateForLifecycleState('blocked'));
    expect(pandaStateForLifecycleState('cancelled')).not.toBe(pandaStateForLifecycleState('failed'));
  });

  it('maps queued-family states to idle', () => {
    expect(pandaStateForLifecycleState('queued')).toBe('idle');
    expect(pandaStateForLifecycleState('scheduled')).toBe('idle');
    expect(pandaStateForLifecycleState('waiting_for_resources')).toBe('idle');
  });

  it('maps waiting_for_delivery_approval to the approval panda state', () => {
    expect(pandaStateForLifecycleState('waiting_for_delivery_approval')).toBe('waiting_for_delivery_approval');
  });

  it('maps waiting_for_proposal_approval and waiting_for_mutation_approval to the approval panda state, not the idle fallback', () => {
    // Regression: these two lifecycle states were previously absent from the
    // map, silently falling through to the 'idle' default and surfacing as
    // "Ready when you are" while a proposal/mutation gate was actively pending.
    expect(pandaStateForLifecycleState('waiting_for_proposal_approval')).toBe('waiting_for_delivery_approval');
    expect(pandaStateForLifecycleState('waiting_for_mutation_approval')).toBe('waiting_for_delivery_approval');
  });

  it('degrades unknown lifecycle states to idle', () => {
    expect(pandaStateForLifecycleState('not_a_real_state')).toBe('idle');
  });
});

describe('connectorStateForLifecycleState', () => {
  it('maps lifecycle states to Kaam ka Dhaaga connector visual states', () => {
    expect(connectorStateForLifecycleState('queued')).toBe('queued');
    expect(connectorStateForLifecycleState('running')).toBe('active');
    expect(connectorStateForLifecycleState('waiting_for_delivery_approval')).toBe('waiting');
    expect(connectorStateForLifecycleState('completed')).toBe('done');
    expect(connectorStateForLifecycleState('blocked')).toBe('blocked');
    expect(connectorStateForLifecycleState('failed')).toBe('failed');
    expect(connectorStateForLifecycleState('cancelled')).toBe('cancelled');
  });

  it('maps waiting_for_proposal_approval and waiting_for_mutation_approval to the waiting connector state, not the queued fallback', () => {
    expect(connectorStateForLifecycleState('waiting_for_proposal_approval')).toBe('waiting');
    expect(connectorStateForLifecycleState('waiting_for_mutation_approval')).toBe('waiting');
  });
});

describe('isSubagentEventKind', () => {
  it('identifies graph-stage kinds as bounded subagent branches', () => {
    expect(isSubagentEventKind('graph_stage_started')).toBe(true);
    expect(isSubagentEventKind('graph_stage_completed')).toBe(true);
    expect(isSubagentEventKind('graph_stage_failed')).toBe(true);
  });

  it('does not treat non-stage kinds as subagent branches', () => {
    expect(isSubagentEventKind('preparing')).toBe(false);
    expect(isSubagentEventKind('waiting_for_delivery_approval')).toBe(false);
  });
});
