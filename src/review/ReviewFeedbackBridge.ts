import { ReviewFinding, ReviewValidation, ReviewWorkflow } from './ReviewWorkflow';

export interface ExternalReviewComment {
  id: string;
  file: string;
  line?: number;
  hunkId?: string;
  author: string;
  body: string;
  severity?: ReviewFinding['severity'];
  resolved: boolean;
  url?: string;
}

export interface ExternalStatusCheck {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'skipped';
  detail?: string;
  url?: string;
}

export interface ReviewFeedbackProvider {
  listComments(changeId: string, signal: AbortSignal): Promise<ExternalReviewComment[]>;
  listChecks(changeId: string, signal: AbortSignal): Promise<ExternalStatusCheck[]>;
  reply(commentId: string, message: string, signal: AbortSignal): Promise<void>;
  resolve(commentId: string, signal: AbortSignal): Promise<void>;
}

export interface ReviewFeedbackImportResult {
  findings: ReviewFinding[];
  validations: ReviewValidation[];
  ignoredResolvedComments: string[];
}

export class ReviewFeedbackBridge {
  constructor(private readonly provider: ReviewFeedbackProvider) {}

  async import(
    changeId: string,
    workflow: ReviewWorkflow,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ReviewFeedbackImportResult> {
    if (!changeId.trim()) throw new Error('Change id is required.');
    const [comments, checks] = await Promise.all([
      this.provider.listComments(changeId, signal),
      this.provider.listChecks(changeId, signal),
    ]);
    const ignoredResolvedComments = comments.filter(comment => comment.resolved).map(comment => comment.id);
    const openComments = comments.filter(comment => !comment.resolved);
    const findings = openComments.map(toFinding);
    if (findings.length > 0) workflow.ingestFindings(findings.map(({ decision: _decision, ...finding }) => finding));

    const validations = checks.map(toValidation);
    for (const validation of validations) workflow.addValidation(validation);
    return {
      findings: findings.map(finding => ({ ...finding })),
      validations: validations.map(validation => ({ ...validation })),
      ignoredResolvedComments,
    };
  }

  async publishResolution(
    comment: ExternalReviewComment,
    message: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    if (comment.resolved) return;
    if (!message.trim()) throw new Error('Review resolution message is required.');
    await this.provider.reply(comment.id, message.trim(), signal);
    await this.provider.resolve(comment.id, signal);
  }
}

function toFinding(comment: ExternalReviewComment): ReviewFinding {
  return {
    id: `external:${comment.id}`,
    source: 'pr',
    file: normalizePath(comment.file),
    line: comment.line,
    hunkId: comment.hunkId,
    severity: comment.severity ?? 'warning',
    confidence: 1,
    message: comment.body,
    evidence: [comment.author, comment.url].filter(Boolean).join(' · '),
    decision: 'pending',
    threadId: comment.id,
  };
}

function toValidation(check: ExternalStatusCheck): ReviewValidation {
  return {
    id: `external:${check.id}`,
    name: check.name,
    status: check.status === 'passed'
      ? 'passed'
      : check.status === 'failed'
        ? 'failed'
        : 'skipped',
    detail: [check.detail, check.url].filter(Boolean).join(' · '),
  };
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^(?:a|b)\//, '').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Invalid review feedback path: ${value}`);
  }
  return normalized;
}
