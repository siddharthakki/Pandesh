/**
 * Empirical routing evidence data model — designed for later milestones, not
 * activated anywhere in this milestone. Nothing writes to or reads this
 * shape yet; shadow telemetry (see SystemOneDecisionService.record) is the
 * only live evidence output today.
 *
 * Intent: once enough shadow evidence has accumulated, a future milestone
 * can aggregate raw telemetry lines into rows like this per (model,
 * decisionType, taskClass) to pick a model per decision empirically, rather
 * than hardcoding a reliability floor (e.g. "score >= 0.82 or fail").
 */
import type { SystemOneDecisionType } from './types';

export interface SystemOneModelEvidence {
  model: string;
  decisionType: SystemOneDecisionType;
  taskClass: string | null;
  attempts: number;
  correct: number;
  incorrect: number;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  confidenceMean: number | null;
  lastObserved: string;
}
