import { createHash } from 'crypto';
import {
  GhCliCommandRunner,
  GhEngineeringBoard,
} from './GhEngineeringIntegration';
import type { GitHubCommandRunner } from './GhEngineeringIntegration';
import type { VerifiedMerge } from './M22SelfDogfoodOrganization';
import type { CiStatus, ReviewStatus } from '../autonomous/M15AutonomousWork';

export interface PullRequestObservation extends VerifiedMerge {
  pullRequestNumber: number;
  headBranch: string;
  headCommit: string;
  baseBranch: string;
  draft: boolean;
  pipelineId: string;
  ci: CiStatus;
  review: ReviewStatus;
}

type StatusRollupEntry = {
  name?: unknown;
  context?: unknown;
  workflowName?: unknown;
  status?: unknown;
  state?: unknown;
  conclusion?: unknown;
  detailsUrl?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

type PullRequestPayload = {
  number?: unknown;
  url?: unknown;
  isDraft?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  baseRefName?: unknown;
  state?: unknown;
  mergedAt?: unknown;
  mergedBy?: { login?: unknown } | null;
  reviewDecision?: unknown;
  statusCheckRollup?: StatusRollupEntry[] | null;
};

export class GhM22EngineeringBoard extends GhEngineeringBoard {
  constructor(
    cwd: string,
    repository: string,
    private readonly verificationRunner: GitHubCommandRunner = new GhCliCommandRunner(cwd),
  ) {
    super(cwd, repository, verificationRunner);
  }

  async observePullRequest(pullRequestUrl: string): Promise<PullRequestObservation> {
    const raw = await this.verificationRunner.run([
      'pr', 'view', pullRequestUrl,
      '--json', 'number,url,isDraft,headRefName,headRefOid,baseRefName,state,mergedAt,mergedBy,reviewDecision,statusCheckRollup',
    ]);
    const payload = parsePayload(raw);
    const pullRequestNumber = requiredNumber(payload.number, 'number');
    const url = requiredString(payload.url, 'url');
    const headBranch = requiredString(payload.headRefName, 'headRefName');
    const headCommit = requiredString(payload.headRefOid, 'headRefOid');
    const baseBranch = requiredString(payload.baseRefName, 'baseRefName');
    const mergedAt = optionalString(payload.mergedAt);
    const mergedBy = optionalString(payload.mergedBy?.login);
    const observedAt = latestTimestamp(payload.statusCheckRollup ?? []) ?? mergedAt ?? new Date().toISOString();
    const ci = mapCi(payload.statusCheckRollup ?? [], observedAt);
    const review = mapReview(payload.reviewDecision, observedAt);
    const pipelineMaterial = JSON.stringify({
      pullRequestNumber,
      headCommit,
      state: ci.state,
      checks: ci.failedChecks.map(check => [check.name, check.summary]),
    });
    const pipelineId = `pr-${pullRequestNumber}-${createHash('sha256').update(pipelineMaterial, 'utf8').digest('hex').slice(0, 20)}`;
    return {
      pullRequestUrl: url,
      pullRequestNumber,
      headBranch,
      headCommit,
      baseBranch,
      draft: Boolean(payload.isDraft),
      pipelineId,
      ci,
      review,
      merged: Boolean(mergedAt && mergedBy),
      mergedAt,
      mergedBy,
    };
  }

  async supersedePullRequest(previousPullRequestUrl: string, replacementPullRequestUrl: string): Promise<void> {
    if (previousPullRequestUrl === replacementPullRequestUrl) return;
    const observation = await this.observePullRequest(previousPullRequestUrl);
    if (observation.merged) {
      throw new Error(`Cannot supersede already merged pull request ${previousPullRequestUrl}.`);
    }
    await this.verificationRunner.run([
      'pr', 'close', previousPullRequestUrl,
      '--comment', `Superseded by verified repair delivery ${replacementPullRequestUrl}. The replacement passed the governed repair, review, CI, and human-merge flow.`,
    ]);
  }

  async verifyMergedPullRequest(pullRequestUrl: string): Promise<VerifiedMerge> {
    const observation = await this.observePullRequest(pullRequestUrl);
    return {
      pullRequestUrl: observation.pullRequestUrl,
      merged: observation.merged,
      mergedAt: observation.mergedAt,
      mergedBy: observation.mergedBy,
    };
  }
}

function parsePayload(raw: string): PullRequestPayload {
  try {
    return JSON.parse(raw) as PullRequestPayload;
  } catch (error) {
    throw new Error(`gh pr view returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mapCi(entries: StatusRollupEntry[], observedAt: string): CiStatus {
  if (entries.length === 0) return { state: 'unknown', failedChecks: [], observedAt };
  const normalized = entries.map(entry => ({
    name: optionalString(entry.name) ?? optionalString(entry.context) ?? optionalString(entry.workflowName) ?? 'unnamed-check',
    status: String(entry.status ?? entry.state ?? '').toUpperCase(),
    conclusion: String(entry.conclusion ?? '').toUpperCase(),
    detailsUrl: optionalString(entry.detailsUrl),
  }));
  const pending = normalized.some(entry => !entry.conclusion && !['COMPLETED', 'SUCCESS', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'NEUTRAL', 'SKIPPED'].includes(entry.status));
  if (pending) return { state: 'pending', failedChecks: [], observedAt };

  const failed = normalized.filter(entry => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(entry.conclusion || entry.status));
  if (failed.length === 0) return { state: 'success', failedChecks: [], observedAt };
  const actionRequired = failed.some(entry => (entry.conclusion || entry.status) === 'ACTION_REQUIRED');
  const cancelled = failed.every(entry => ['CANCELLED', 'SKIPPED'].includes(entry.conclusion || entry.status));
  return {
    state: actionRequired ? 'action-required' : cancelled ? 'cancelled' : 'failure',
    failedChecks: failed.map(entry => ({
      name: entry.name,
      summary: [entry.conclusion || entry.status || 'failure', entry.detailsUrl].filter(Boolean).join(' — '),
    })),
    observedAt,
  };
}

function mapReview(value: unknown, observedAt: string): ReviewStatus {
  const decision = String(value ?? '').toUpperCase();
  return {
    state: decision === 'APPROVED' ? 'approved'
      : decision === 'CHANGES_REQUESTED' ? 'changes-requested'
      : decision === 'REVIEW_REQUIRED' ? 'waiting'
      : 'unknown',
    unresolvedComments: 0,
    comments: [],
    observedAt,
  };
}

function latestTimestamp(entries: StatusRollupEntry[]): string | undefined {
  const values = entries
    .flatMap(entry => [optionalString(entry.completedAt), optionalString(entry.startedAt)])
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return values[0];
}

function requiredString(value: unknown, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`gh pr view omitted ${name}.`);
  return normalized;
}

function requiredNumber(value: unknown, name: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) throw new Error(`gh pr view omitted ${name}.`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
