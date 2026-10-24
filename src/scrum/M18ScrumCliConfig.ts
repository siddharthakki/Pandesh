import type { ScrumLabels } from './M18AutonomousScrum';

export type M18ScrumLabelEnvironment = Partial<Record<
  | 'OA_M18_READY_LABEL'
  | 'OA_M18_IN_PROGRESS_LABEL'
  | 'OA_M18_REVIEW_LABEL'
  | 'OA_M18_BLOCKED_LABEL',
  string | undefined
>>;

/**
 * Builds only explicitly configured label overrides.
 * Missing environment variables must remain absent so coordinator defaults are
 * preserved instead of being overwritten by `undefined` values.
 */
export function resolveM18ScrumLabelOverrides(
  environment: M18ScrumLabelEnvironment,
): Partial<ScrumLabels> {
  const labels: Partial<ScrumLabels> = {};
  const ready = normalize(environment.OA_M18_READY_LABEL);
  const inProgress = normalize(environment.OA_M18_IN_PROGRESS_LABEL);
  const review = normalize(environment.OA_M18_REVIEW_LABEL);
  const blocked = normalize(environment.OA_M18_BLOCKED_LABEL);

  if (ready) labels.ready = ready;
  if (inProgress) labels.inProgress = inProgress;
  if (review) labels.review = review;
  if (blocked) labels.blocked = blocked;
  return labels;
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
