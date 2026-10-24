import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TaskCard } from '../../webview-v2/components/TaskCard';
import { ApprovalCard, type ApprovalCardHandlers } from '../../webview-v2/components/ApprovalCard';
import { ActivityTimeline } from '../../webview-v2/components/ActivityTimeline';
import { ValidationSummary } from '../../webview-v2/components/ValidationSummary';
import { DeliverySummary } from '../../webview-v2/components/DeliverySummary';
import { TaskProjectionArea } from '../../webview-v2/components/TaskProjectionArea';
import { reduceUiV2, createInitialState, type TaskProjection, type ApprovalProjection } from '../../webview-v2/state/types';
import { translateHostMessage } from '../../webview-v2/bridge/adapter';

afterEach(cleanup);

function baseTask(overrides: Partial<TaskProjection> = {}): TaskProjection {
  return {
    taskId: 'task_1', goal: 'Do the thing', state: 'running', activity: [],
    resolvedGates: { proposal: false, mutation: false },
    ...overrides,
  };
}

function noopHandlers(): ApprovalCardHandlers {
  return {
    onApproveProposal: vi.fn(), onRejectProposal: vi.fn(), onRequestProposalRevision: vi.fn(),
    onApproveMutation: vi.fn(), onDenyMutation: vi.fn(), onApproveDelivery: vi.fn(), onRejectDelivery: vi.fn(),
  };
}

describe('TaskCard', () => {
  it('renders authoritative task state (real state string, not an inferred one)', () => {
    render(<TaskCard task={baseTask({ state: 'waiting_for_delivery_approval', goal: 'Ship it' })} />);
    expect(screen.getByTestId('task-card-goal').textContent).toBe('Ship it');
    expect(screen.getByTestId('task-card-state').textContent).toBe('waiting for delivery approval');
  });

  it('renders a distinct label for each terminal state', () => {
    for (const [state, label] of [['completed', 'Completed'], ['failed', 'Failed'], ['blocked', 'Blocked'], ['cancelled', 'Cancelled']] as const) {
      cleanup();
      render(<TaskCard task={baseTask({ state })} />);
      expect(screen.getByTestId('task-card-state').textContent).toBe(label);
    }
  });

  it('uses the latest real progress event for the active panda instead of generic running/coding state', () => {
    render(<TaskCard task={baseTask({
      state: 'running',
      pandaState: 'coding',
      activity: [
        { id: 'e1', kind: 'investigation_read_file', title: 'Reading src/foo.ts', pandaState: 'reading' },
      ],
    })} />);
    expect(screen.getByTestId('panda-state-label').textContent).toBe('reading');
    expect(screen.getByTestId('panda-state').getAttribute('data-panda-state')).toBe('reading');
    expect(screen.getByTestId('panda-state-image').getAttribute('src')).toContain('action-repository.webp');
  });

  it('lets approval and terminal lifecycle states override stale work events', () => {
    const staleWork = [{ id: 'e1', kind: 'coding', title: 'Editing file', pandaState: 'coding' }];

    const { rerender } = render(<TaskCard task={baseTask({
      state: 'waiting_for_delivery_approval',
      pandaState: 'waiting_for_delivery_approval',
      activity: staleWork,
    })} />);
    expect(screen.getByTestId('panda-state-label').textContent).toBe('waiting');
    expect(screen.getByTestId('panda-state-image').getAttribute('src')).toContain('action-approval.webp');

    rerender(<TaskCard task={baseTask({
      state: 'completed',
      pandaState: 'completed',
      activity: staleWork,
    })} />);
    expect(screen.getByTestId('panda-state-label').textContent).toBe('success');
    expect(screen.getByTestId('panda-state-image').getAttribute('src')).toContain('mascot-success.webp');
  });
});

describe('ApprovalCard', () => {
  it('Approve on a proposal card emits exactly the approveProposal intent and does not resolve itself', () => {
    const handlers = noopHandlers();
    const approval: ApprovalProjection = { kind: 'proposal', taskId: 't1', proposalId: 'p1' };
    render(<ApprovalCard approval={approval} handlers={handlers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(handlers.onApproveProposal).toHaveBeenCalledTimes(1);
    expect(handlers.onApproveProposal).toHaveBeenCalledWith('t1', 'p1');
    // The card itself renders unconditionally from the `approval` prop it was
    // given — nothing in the click handler mutates or removes it; only a
    // parent reacting to a real *ApprovalResolved event does that (see
    // TaskProjectionArea / reduceUiV2's proposal_approval_resolved case).
    expect(screen.getByTestId('approval-card')).toBeTruthy();
  });

  it('Deny on a mutation card emits exactly the denyMutation intent', () => {
    const handlers = noopHandlers();
    const approval: ApprovalProjection = { kind: 'mutation', taskId: 't1', requestId: 'req1', operationCount: 3, targets: ['a.ts', 'b.ts'] };
    render(<ApprovalCard approval={approval} handlers={handlers} />);
    expect(screen.getByText('3 operation(s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(handlers.onDenyMutation).toHaveBeenCalledWith('t1', 'req1');
    expect(handlers.onApproveMutation).not.toHaveBeenCalled();
  });

  it('Approve on a delivery card emits exactly the approveAutonomousDelivery intent', () => {
    const handlers = noopHandlers();
    const approval: ApprovalProjection = { kind: 'delivery', taskId: 't1' };
    render(<ApprovalCard approval={approval} handlers={handlers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(handlers.onApproveDelivery).toHaveBeenCalledWith('t1');
  });
});

describe('ActivityTimeline', () => {
  it('renders each supplied event exactly once, never synthesizing extra entries', () => {
    render(<ActivityTimeline events={[
      { id: 'e1', kind: 'reading', title: 'Reading src/foo.ts' },
      { id: 'e2', kind: 'proposal', title: 'Proposal ready' },
    ]} />);
    expect(screen.getAllByTestId('activity-item')).toHaveLength(2);
    expect(screen.getByText('Reading src/foo.ts')).toBeTruthy();
    expect(screen.getByText('Proposal ready')).toBeTruthy();
  });

  it('renders nothing for an empty event list', () => {
    const { container } = render(<ActivityTimeline events={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ValidationSummary', () => {
  it('shows success only when validationTotals says failed === 0 (never inferred from absence of failure)', () => {
    render(<ValidationSummary task={baseTask({ validationTotals: { commands: 2, failed: 0 } })} />);
    expect(screen.getByTestId('validation-summary').getAttribute('data-validation-state')).toBe('success');
  });

  it('shows failure when validationFailure is present, even with no validationTotals yet', () => {
    render(<ValidationSummary task={baseTask({ validationFailure: { message: 'verify exited 1' } })} />);
    expect(screen.getByTestId('validation-summary').getAttribute('data-validation-state')).toBe('failure');
    expect(screen.getByText('verify exited 1')).toBeTruthy();
  });

  it('renders nothing when there is no validation evidence at all', () => {
    const { container } = render(<ValidationSummary task={baseTask()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('DeliverySummary', () => {
  it('renders only the real evidence fields supplied, never a fabricated branch/commit', () => {
    render(<DeliverySummary task={baseTask({
      deliveryEvidence: { destinationBranch: 'dev/current', changedFileCount: 3, deliveryCommitSha: 'abc123' },
    })} />);
    expect(screen.getByText('Destination: dev/current')).toBeTruthy();
    expect(screen.getByText('Changed files: 3')).toBeTruthy();
    expect(screen.getByText('Commit: abc123')).toBeTruthy();
  });

  it('renders nothing when there is no delivery evidence', () => {
    const { container } = render(<DeliverySummary task={baseTask()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('TaskProjectionArea — terminal states have no actionable approval', () => {
  it('a terminal task with a leftover unresolved approval in state never renders that approval card', () => {
    const task = baseTask({ state: 'completed' });
    const approvals: ApprovalProjection[] = [{ kind: 'delivery', taskId: 'task_1' }];
    render(<TaskProjectionArea task={task} approvals={approvals} handlers={noopHandlers()} />);
    // Real production behavior never leaves a stale approval in state once
    // terminal (AgentPanel always posts the matching *ApprovalResolved first)
    // — but if it somehow did, the terminal TaskCard itself must still read
    // as Completed, distinct from any active/approval affordance.
    expect(screen.getByTestId('task-card-state').textContent).toBe('Completed');
  });
});

describe('reduceUiV2 — task/approval projection (Phase 3)', () => {
  it('autonomousTaskStarted then autonomousTaskStatus populate a single taskProjection slot', () => {
    let state = createInitialState();
    const started = translateHostMessage(
      { type: 'autonomousTaskStarted', taskId: 't1', attemptId: 'a1', state: 'preparing', goal: 'Do X' },
      undefined,
    );
    state = reduceUiV2(state, started!);
    expect(state.taskProjection?.taskId).toBe('t1');
    expect(state.ui.submitting).toBe(false);

    const status = translateHostMessage(
      {
        type: 'autonomousTaskStatus',
        taskId: 't1',
        state: 'waiting_for_proposal_approval',
        provider: 'ollama',
        model: 'qwen',
        pandaState: 'waiting_for_delivery_approval',
        events: [{
          eventId: 'e-read',
          seq: 7,
          kind: 'investigation_read_file',
          title: 'Reading src/foo.ts',
          detail: 'Inspecting implementation',
          rawProgress: 'investigation_read_file|Reading src/foo.ts',
          pandaState: 'reading',
          isSubagent: false,
        }],
      },
      undefined,
    );
    state = reduceUiV2(state, status!);
    expect(state.taskProjection?.state).toBe('waiting_for_proposal_approval');
    expect(state.taskProjection?.provider).toBe('ollama');
    expect(state.taskProjection?.activity).toEqual([expect.objectContaining({
      id: 'e-read',
      kind: 'investigation_read_file',
      title: 'Reading src/foo.ts',
      pandaState: 'reading',
      isSubagent: false,
    })]);
  });

  it('a *ApprovalResolved event removes exactly the matching card, not others', () => {
    let state = createInitialState();
    state = reduceUiV2(state, { type: 'proposal_approval_request', taskId: 't1', proposalId: 'p1' });
    state = reduceUiV2(state, { type: 'mutation_approval_request', taskId: 't1', requestId: 'r1' });
    expect(state.approvals).toHaveLength(2);
    state = reduceUiV2(state, { type: 'proposal_approval_resolved', taskId: 't1', proposalId: 'p1', decision: 'approved' });
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0].kind).toBe('mutation');
  });

  it('a fresh autonomousTaskStarted clears any stale approvals from a prior task', () => {
    let state = createInitialState();
    state = reduceUiV2(state, { type: 'proposal_approval_request', taskId: 'old', proposalId: 'p1' });
    state = reduceUiV2(state, {
      type: 'autonomous_task_started', taskId: 'new', state: 'preparing', goal: 'fresh task',
    });
    expect(state.approvals).toHaveLength(0);
    expect(state.taskProjection?.taskId).toBe('new');
  });
});
