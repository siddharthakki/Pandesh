import React from 'react';
import type { TaskProjection } from '../state/types';

/** Success is only ever shown when `validationTotals` says `failed === 0` —
 * never inferred from the mere absence of `validationFailure`. */
export function ValidationSummary({ task }: { task: TaskProjection }) {
  const { validationFailure, validationTotals, validationRepairAttempts } = task;
  if (!validationFailure && !validationTotals) return null;

  if (validationFailure) {
    const message =
      typeof validationFailure === 'string'
        ? validationFailure
        : (validationFailure as { message?: string })?.message ?? 'Validation failed.';
    return (
      <div className="kd2-validation-summary kd2-validation-summary--failure" data-testid="validation-summary" data-validation-state="failure">
        <div className="kd2-validation-summary__title">Validation failed</div>
        <div className="kd2-validation-summary__detail">{message}</div>
        {validationRepairAttempts ? (
          <div className="kd2-validation-summary__repair">Repair attempted ({validationRepairAttempts})</div>
        ) : null}
      </div>
    );
  }

  if (validationTotals) {
    const success = validationTotals.failed === 0;
    return (
      <div
        className={`kd2-validation-summary kd2-validation-summary--${success ? 'success' : 'failure'}`}
        data-testid="validation-summary"
        data-validation-state={success ? 'success' : 'failure'}
      >
        <div className="kd2-validation-summary__title">{success ? 'Validation passed' : 'Validation failed'}</div>
        <div className="kd2-validation-summary__totals">
          {validationTotals.commands} command(s), {validationTotals.failed} failed
        </div>
      </div>
    );
  }

  return null;
}
