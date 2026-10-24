import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export type PipelineConclusion = 'success' | 'failure' | 'cancelled' | 'timed-out';
export type FlakyClassification = 'stable-failure' | 'flaky' | 'unknown';
export type RepairBugState = 'open' | 'repairing' | 'verified' | 'closed' | 'exhausted';

export interface PipelineResult {
  id: string;
  repository: string;
  branch: string;
  commitSha: string;
  workflow: string;
  runUrl?: string;
  conclusion: PipelineConclusion;
  failedChecks: string[];
  failingTests: string[];
  errorSummary?: string;
  startedAt: string;
  completedAt: string;
  attempt: number;
  rerunOf?: string;
  sourceTaskId?: string;
  sourceIssueNumber?: number;
}

export interface FailureFingerprint {
  value: string;
  signalKey: string;
  normalizedSummary: string;
}

export interface RepairBugRecord {
  id: string;
  repository: string;
  fingerprint: string;
  signalKey: string;
  title: string;
  state: RepairBugState;
  flaky: FlakyClassification;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  sourceRunIds: string[];
  sourceTaskId?: string;
  sourceIssueNumber?: number;
  sourcePullRequestUrl?: string;
  issueNumber?: number;
  issueUrl?: string;
  repairAttempts: number;
  maxRepairAttempts: number;
  regressionTests: string[];
  verifiedByRunId?: string;
  repairTaskId?: string;
  repairPullRequestUrl?: string;
}

export interface RepairAssignment {
  id: string;
  bugId: string;
  attempt: number;
  assignedAt: string;
  workerId: string;
  taskId: string;
  state: 'assigned' | 'completed' | 'failed' | 'cancelled';
}

export interface RepairOutcome {
  assignmentId: string;
  succeeded: boolean;
  regressionTests: string[];
  validationPassed: boolean;
  reviewPassed: boolean;
  pipelinePassed: boolean;
  pipelineRunId?: string;
  taskId?: string;
  pullRequestUrl?: string;
  summary: string;
}

export interface IncidentEvidence {
  id: string;
  bugId: string;
  createdAt: string;
  severity: 'sev1' | 'sev2' | 'sev3';
  fingerprint: string;
  sourceRuns: string[];
  repairAssignments: string[];
  summary: string;
}

export interface RepairLoopState {
  schemaVersion: 1;
  pipelineResults: PipelineResult[];
  bugs: RepairBugRecord[];
  assignments: RepairAssignment[];
  incidents: IncidentEvidence[];
}

export interface RepairLoopStore {
  load(): Promise<RepairLoopState>;
  save(state: RepairLoopState): Promise<void>;
}

export class InMemoryRepairLoopStore implements RepairLoopStore {
  private state: RepairLoopState = emptyState();
  async load(): Promise<RepairLoopState> { return structuredClone(this.state); }
  async save(state: RepairLoopState): Promise<void> { this.state = structuredClone(state); }
}

export class JsonRepairLoopStore implements RepairLoopStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RepairLoopState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as RepairLoopState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.pipelineResults) || !Array.isArray(parsed.bugs)) {
        throw new Error('Invalid M21 repair-loop state.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return emptyState();
    }
  }

  async save(state: RepairLoopState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filePath);
  }
}

export interface BugPublisher {
  ensureBug(record: RepairBugRecord, pipeline: PipelineResult): Promise<{ issueNumber: number; issueUrl: string }>;
  updateBug(record: RepairBugRecord, message: string): Promise<void>;
}

export interface RepairAgentAssigner {
  assign(record: RepairBugRecord, pipeline: PipelineResult, attempt: number): Promise<{ workerId: string; taskId: string }>;
  cancel(taskId: string, reason: string): Promise<boolean>;
}

export interface CIBugRepairLoopOptions {
  maxRepairAttempts: number;
  flakyLookback: number;
  incidentSeverityAfterAttempts: number;
  now?: () => Date;
}

export interface PipelineIngestionResult {
  accepted: boolean;
  fingerprint?: FailureFingerprint;
  bug?: RepairBugRecord;
  assignment?: RepairAssignment;
}

export interface RepairOutcomeResult {
  bug: RepairBugRecord;
  nextAssignment?: RepairAssignment;
  incident?: IncidentEvidence;
}

export class CIBugRepairLoop {
  private readonly now: () => Date;

  constructor(
    private readonly store: RepairLoopStore,
    private readonly publisher: BugPublisher,
    private readonly assigner: RepairAgentAssigner,
    private readonly options: CIBugRepairLoopOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async ingest(result: PipelineResult): Promise<PipelineIngestionResult> {
    const state = await this.store.load();
    if (state.pipelineResults.some(value => value.id === result.id)) return { accepted: false };
    state.pipelineResults.push(structuredClone(result));
    if (result.conclusion !== 'failure' && result.conclusion !== 'timed-out') {
      await this.store.save(state);
      return { accepted: true };
    }

    const fingerprint = fingerprintFailure(result);
    let bug = state.bugs.find(value => value.repository === result.repository && value.fingerprint === fingerprint.value && value.state !== 'closed');
    if (!bug) {
      bug = {
        id: `bug-${randomUUID()}`,
        repository: result.repository,
        fingerprint: fingerprint.value,
        signalKey: fingerprint.signalKey,
        title: buildBugTitle(result, fingerprint),
        state: 'open',
        flaky: classifyFlaky(state.pipelineResults, result, this.options.flakyLookback),
        firstSeenAt: result.completedAt,
        lastSeenAt: result.completedAt,
        occurrences: 1,
        sourceRunIds: [result.id],
        sourceTaskId: result.sourceTaskId,
        sourceIssueNumber: result.sourceIssueNumber,
        sourcePullRequestUrl: result.runUrl,
        repairAttempts: 0,
        maxRepairAttempts: this.options.maxRepairAttempts,
        regressionTests: [],
      };
      const published = await this.publisher.ensureBug(bug, result);
      bug.issueNumber = published.issueNumber;
      bug.issueUrl = published.issueUrl;
      state.bugs.push(bug);
    } else {
      bug.lastSeenAt = result.completedAt;
      bug.occurrences += 1;
      if (!bug.sourceRunIds.includes(result.id)) bug.sourceRunIds.push(result.id);
      bug.sourceTaskId ??= result.sourceTaskId;
      bug.sourceIssueNumber ??= result.sourceIssueNumber;
      bug.sourcePullRequestUrl ??= result.runUrl;
      bug.flaky = classifyFlaky(state.pipelineResults, result, this.options.flakyLookback);
      await this.publisher.updateBug(bug, `Failure observed again in ${result.runUrl ?? result.id}; occurrence ${bug.occurrences}.`);
    }

    const activeRepair = state.assignments.some(value => value.bugId === bug.id && value.state === 'assigned');
    const assignment = bug.flaky === 'flaky' || activeRepair
      ? undefined
      : await this.assignRepair(state, bug, result);
    await this.store.save(state);
    return {
      accepted: true,
      fingerprint,
      bug: structuredClone(bug),
      assignment: assignment ? structuredClone(assignment) : undefined,
    };
  }

  async recordRepairOutcome(outcome: RepairOutcome): Promise<RepairOutcomeResult> {
    const state = await this.store.load();
    const assignment = state.assignments.find(value => value.id === outcome.assignmentId);
    if (!assignment) throw new Error(`Unknown repair assignment ${outcome.assignmentId}.`);
    if (assignment.state !== 'assigned') throw new Error(`Repair assignment ${outcome.assignmentId} is already ${assignment.state}.`);
    const bug = requiredBug(state, assignment.bugId);

    if (outcome.regressionTests.filter(Boolean).length === 0) {
      assignment.state = 'failed';
      await this.publisher.updateBug(bug, 'Repair rejected: automated regression-test evidence is required.');
      const result = await this.retryOrExhaust(state, bug, assignment, 'missing_regression_test');
      await this.store.save(state);
      return result;
    }

    assignment.state = outcome.succeeded && outcome.validationPassed && outcome.reviewPassed && outcome.pipelinePassed ? 'completed' : 'failed';
    bug.regressionTests = unique([...bug.regressionTests, ...outcome.regressionTests]);
    if (assignment.state === 'completed') {
      bug.state = 'verified';
      bug.verifiedByRunId = outcome.pipelineRunId;
      bug.repairTaskId = outcome.taskId ?? assignment.taskId;
      bug.repairPullRequestUrl = outcome.pullRequestUrl;
      await this.publisher.updateBug(
        bug,
        `Repair verified${bug.repairPullRequestUrl ? ` in ${bug.repairPullRequestUrl}` : ''}. Regression tests: ${bug.regressionTests.join(', ')}. Awaiting human merge.`,
      );
      await this.store.save(state);
      return { bug: structuredClone(bug) };
    }

    await this.publisher.updateBug(bug, `Repair attempt ${assignment.attempt} failed: ${sanitize(outcome.summary)}.`);
    const result = await this.retryOrExhaust(state, bug, assignment, sanitize(outcome.summary));
    await this.store.save(state);
    return result;
  }

  async closeVerifiedBug(bugId: string, mergedPullRequestUrl: string): Promise<RepairBugRecord> {
    const state = await this.store.load();
    const bug = requiredBug(state, bugId);
    if (bug.state !== 'verified') throw new Error(`Bug ${bugId} is not verified.`);
    if (bug.repairPullRequestUrl && bug.repairPullRequestUrl !== mergedPullRequestUrl) {
      throw new Error(`Merged pull request does not match verified repair for bug ${bugId}.`);
    }
    bug.state = 'closed';
    bug.repairPullRequestUrl = mergedPullRequestUrl;
    await this.publisher.updateBug(bug, `Verified repair merged through ${mergedPullRequestUrl}; closing automated CI bug.`);
    await this.store.save(state);
    return structuredClone(bug);
  }

  async cancelBug(bugId: string, reason: string): Promise<boolean> {
    const state = await this.store.load();
    const bug = requiredBug(state, bugId);
    const active = state.assignments.filter(value => value.bugId === bugId && value.state === 'assigned');
    for (const assignment of active) {
      await this.assigner.cancel(assignment.taskId, reason);
      assignment.state = 'cancelled';
    }
    bug.state = 'closed';
    await this.publisher.updateBug(bug, `Repair loop cancelled: ${sanitize(reason)}.`);
    await this.store.save(state);
    return true;
  }

  async state(): Promise<RepairLoopState> {
    return this.store.load();
  }

  private async assignRepair(
    state: RepairLoopState,
    bug: RepairBugRecord,
    pipeline: PipelineResult,
  ): Promise<RepairAssignment | undefined> {
    if (bug.repairAttempts >= bug.maxRepairAttempts) return undefined;
    if (state.assignments.some(value => value.bugId === bug.id && value.state === 'assigned')) return undefined;
    bug.repairAttempts += 1;
    bug.state = 'repairing';
    const assigned = await this.assigner.assign(bug, pipeline, bug.repairAttempts);
    const assignment: RepairAssignment = {
      id: `repair-${randomUUID()}`,
      bugId: bug.id,
      attempt: bug.repairAttempts,
      assignedAt: this.now().toISOString(),
      workerId: assigned.workerId,
      taskId: assigned.taskId,
      state: 'assigned',
    };
    state.assignments.push(assignment);
    await this.publisher.updateBug(bug, `Repair attempt ${assignment.attempt} assigned to ${assignment.workerId} as ${assignment.taskId}.`);
    return assignment;
  }

  private async retryOrExhaust(
    state: RepairLoopState,
    bug: RepairBugRecord,
    assignment: RepairAssignment,
    reason: string,
  ): Promise<RepairOutcomeResult> {
    if (bug.repairAttempts < bug.maxRepairAttempts) {
      const source = [...state.pipelineResults].reverse().find(value => bug.sourceRunIds.includes(value.id) && value.conclusion === 'failure')
        ?? [...state.pipelineResults].reverse().find(value => bug.sourceRunIds.includes(value.id));
      if (!source) throw new Error(`Bug ${bug.id} has no source pipeline result.`);
      const nextAssignment = await this.assignRepair(state, bug, source);
      return {
        bug: structuredClone(bug),
        nextAssignment: nextAssignment ? structuredClone(nextAssignment) : undefined,
      };
    }
    bug.state = 'exhausted';
    const incident = this.createIncident(state, bug, reason);
    await this.publisher.updateBug(bug, `Repair budget exhausted after ${assignment.attempt} attempts. Incident ${incident.id} created.`);
    return { bug: structuredClone(bug), incident: structuredClone(incident) };
  }

  private createIncident(state: RepairLoopState, bug: RepairBugRecord, summary: string): IncidentEvidence {
    const attempts = state.assignments.filter(value => value.bugId === bug.id);
    const severity: IncidentEvidence['severity'] = attempts.length >= this.options.incidentSeverityAfterAttempts ? 'sev2' : 'sev3';
    const incident: IncidentEvidence = {
      id: `incident-${randomUUID()}`,
      bugId: bug.id,
      createdAt: this.now().toISOString(),
      severity,
      fingerprint: bug.fingerprint,
      sourceRuns: [...bug.sourceRunIds],
      repairAssignments: attempts.map(value => value.id),
      summary: sanitize(summary),
    };
    state.incidents.push(incident);
    return incident;
  }
}

export function fingerprintFailure(result: PipelineResult): FailureFingerprint {
  const failedChecks = unique(result.failedChecks.map(normalizeSignal)).sort();
  const failingTests = unique(result.failingTests.map(normalizeSignal)).sort();
  const normalizedSummary = normalizeSummary(result.errorSummary ?? 'pipeline failure');
  const signalKey = [...failedChecks, ...failingTests].join('|') || normalizeSignal(result.workflow);
  const material = [result.repository.toLowerCase(), result.workflow.toLowerCase(), signalKey, normalizedSummary].join('\n');
  return { value: createHash('sha256').update(material, 'utf8').digest('hex'), signalKey, normalizedSummary };
}

export function classifyFlaky(history: PipelineResult[], current: PipelineResult, lookback: number): FlakyClassification {
  const related = history
    .filter(value => value.repository === current.repository && value.commitSha === current.commitSha && value.workflow === current.workflow)
    .slice(-Math.max(2, lookback));
  const conclusions = new Set(related.map(value => value.conclusion));
  if (conclusions.has('failure') && conclusions.has('success')) return 'flaky';
  if (related.filter(value => value.conclusion === 'failure').length >= 2) return 'stable-failure';
  return 'unknown';
}

export function defaultM21RepairLoopPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, '.ollama-agent', 'ci-repair', 'state.json');
}

function emptyState(): RepairLoopState {
  return { schemaVersion: 1, pipelineResults: [], bugs: [], assignments: [], incidents: [] };
}

function requiredBug(state: RepairLoopState, id: string): RepairBugRecord {
  const bug = state.bugs.find(value => value.id === id);
  if (!bug) throw new Error(`Unknown repair bug ${id}.`);
  return bug;
}

function buildBugTitle(result: PipelineResult, fingerprint: FailureFingerprint): string {
  const check = result.failedChecks[0] ?? result.failingTests[0] ?? result.workflow;
  return `[CI] ${sanitize(check)} (${fingerprint.value.slice(0, 8)})`;
}

function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/\\/g, '/').replace(/[a-f0-9]{7,40}/g, '<sha>').replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function normalizeSummary(value: string): string {
  return normalizeSignal(value).replace(/(?:[a-z]:)?\/[\w./-]+/g, '<path>');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function sanitize(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2_000);
}
