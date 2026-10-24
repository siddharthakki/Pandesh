import React from 'react';
import type { TaskProjection } from '../state/types';

/** Renders only real deliveryEvidence fields the backend supplied — never
 * fabricates a branch/commit that wasn't actually given. */
export function DeliverySummary({ task }: { task: TaskProjection }) {
  const evidence = task.deliveryEvidence;
  if (!evidence) return null;
  const hasAnyField =
    evidence.destinationBranch || evidence.deliveryCommitSha || typeof evidence.changedFileCount === 'number';
  if (!hasAnyField) return null;
  return (
    <div className="kd2-delivery-summary" data-testid="delivery-summary">
      <div className="kd2-delivery-summary__title">Delivery</div>
      {evidence.destinationBranch ? (
        <div className="kd2-delivery-summary__row">Destination: {evidence.destinationBranch}</div>
      ) : null}
      {typeof evidence.changedFileCount === 'number' ? (
        <div className="kd2-delivery-summary__row">Changed files: {evidence.changedFileCount}</div>
      ) : null}
      {evidence.deliveryCommitSha ? (
        <div className="kd2-delivery-summary__row">Commit: {evidence.deliveryCommitSha}</div>
      ) : null}
      {typeof evidence.validationPassCount === 'number' ? (
        <div className="kd2-delivery-summary__row">Validation: {evidence.validationPassCount} passed</div>
      ) : null}
    </div>
  );
}
