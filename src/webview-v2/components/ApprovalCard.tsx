import React, { useState } from 'react';
import type { ApprovalProjection } from '../state/types';

export interface ApprovalCardHandlers {
  onApproveProposal: (taskId: string, proposalId: string) => void;
  onRejectProposal: (taskId: string, proposalId: string) => void;
  onRequestProposalRevision: (taskId: string, proposalId: string, instructions: string) => void;
  onApproveMutation: (taskId: string, requestId: string) => void;
  onDenyMutation: (taskId: string, requestId: string) => void;
  onApproveDelivery: (taskId: string) => void;
  onRejectDelivery: (taskId: string) => void;
}

/**
 * Renders exactly one approval gate. Clicking a button only sends the host
 * intent — it never marks itself resolved. The card disappears from state
 * only when the reducer removes it in response to the authoritative
 * `*ApprovalResolved` event (see reduceUiV2's `proposal_approval_resolved` /
 * `mutation_approval_resolved` / `delivery_approval_resolved` cases).
 */
export function ApprovalCard({ approval, handlers }: { approval: ApprovalProjection; handlers: ApprovalCardHandlers }) {
  const [revisionText, setRevisionText] = useState('');
  const [showRevision, setShowRevision] = useState(false);

  if (approval.kind === 'proposal') {
    const { taskId, proposalId } = approval;
    if (!proposalId) return null;
    return (
      <div className="kd2-approval-card kd2-approval-card--proposal" data-testid="approval-card" data-approval-kind="proposal">
        <div className="kd2-approval-card__title">Proposal approval</div>
        {approval.taskSummary ? <div className="kd2-approval-card__summary">{approval.taskSummary}</div> : null}
        {approval.operations && approval.operations.length > 0 ? (
          <div className="kd2-approval-card__ops">{approval.operations.length} operation(s)</div>
        ) : null}
        {approval.validationCommands && approval.validationCommands.length > 0 ? (
          <div className="kd2-approval-card__validation">{approval.validationCommands.length} validation command(s)</div>
        ) : null}
        <div className="kd2-approval-card__actions">
          <button type="button" onClick={() => handlers.onApproveProposal(taskId, proposalId)}>Approve</button>
          <button type="button" onClick={() => handlers.onRejectProposal(taskId, proposalId)}>Reject</button>
          <button type="button" onClick={() => setShowRevision((v) => !v)}>Request revision</button>
        </div>
        {showRevision ? (
          <div className="kd2-approval-card__revision">
            <textarea
              placeholder="Revision instructions"
              value={revisionText}
              onChange={(e) => setRevisionText(e.target.value)}
            />
            <button
              type="button"
              onClick={() => handlers.onRequestProposalRevision(taskId, proposalId, revisionText)}
              disabled={!revisionText.trim()}
            >
              Send revision
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (approval.kind === 'mutation') {
    const { taskId, requestId } = approval;
    if (!requestId) return null;
    return (
      <div className="kd2-approval-card kd2-approval-card--mutation" data-testid="approval-card" data-approval-kind="mutation">
        <div className="kd2-approval-card__title">Mutation approval</div>
        {typeof approval.operationCount === 'number' ? (
          <div className="kd2-approval-card__ops">{approval.operationCount} operation(s)</div>
        ) : null}
        {approval.targets && approval.targets.length > 0 ? (
          <div className="kd2-approval-card__targets">{approval.targets.join(', ')}</div>
        ) : null}
        {approval.elevatedConfirmationRequired ? (
          <div className="kd2-approval-card__elevated" role="alert">Elevated confirmation required</div>
        ) : null}
        <div className="kd2-approval-card__actions">
          <button type="button" onClick={() => handlers.onApproveMutation(taskId, requestId)}>Approve</button>
          <button type="button" onClick={() => handlers.onDenyMutation(taskId, requestId)}>Deny</button>
        </div>
      </div>
    );
  }

  // delivery
  const { taskId } = approval;
  return (
    <div className="kd2-approval-card kd2-approval-card--delivery" data-testid="approval-card" data-approval-kind="delivery">
      <div className="kd2-approval-card__title">Delivery approval</div>
      <div className="kd2-approval-card__actions">
        <button type="button" onClick={() => handlers.onApproveDelivery(taskId)}>Approve</button>
        <button type="button" onClick={() => handlers.onRejectDelivery(taskId)}>Reject</button>
      </div>
    </div>
  );
}
