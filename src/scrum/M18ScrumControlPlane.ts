import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export type ScrumIssueType = 'epic' | 'story' | 'bug';
export type ScrumBoardStatus = 'backlog' | 'ready' | 'in-progress' | 'review' | 'blocked' | 'done';

export interface ProjectLabelDefinition {
  name: string;
  color: string;
  description: string;
}

export interface ProjectFieldDefinition {
  name: string;
  type: 'single-select' | 'number' | 'text';
  options?: string[];
}

export interface GitHubProjectBoardSchema {
  schemaVersion: 1;
  title: string;
  fields: ProjectFieldDefinition[];
  labels: ProjectLabelDefinition[];
  milestoneTitles: string[];
  statuses: ScrumBoardStatus[];
}

export const M18_PROJECT_BOARD_SCHEMA: GitHubProjectBoardSchema = {
  schemaVersion: 1,
  title: 'KarkeDikha Autonomous Engineering',
  fields: [
    { name: 'Status', type: 'single-select', options: ['Backlog', 'Ready', 'In Progress', 'Review', 'Blocked', 'Done'] },
    { name: 'Type', type: 'single-select', options: ['Epic', 'Story', 'Bug'] },
    { name: 'Priority', type: 'single-select', options: ['Urgent', 'High', 'Normal', 'Low'] },
    { name: 'Story Points', type: 'number' },
    { name: 'Owner', type: 'text' },
  ],
  labels: [
    { name: 'type:epic', color: '6f42c1', description: 'Epic containing child stories' },
    { name: 'type:story', color: '0e8a16', description: 'Deliverable Scrum story' },
    { name: 'type:bug', color: 'd73a4a', description: 'Defect requiring regression coverage' },
    { name: 'priority:urgent', color: 'b60205', description: 'Highest scheduling priority' },
    { name: 'priority:high', color: 'd93f0b', description: 'High scheduling priority' },
    { name: 'priority:normal', color: 'fbca04', description: 'Normal scheduling priority' },
    { name: 'priority:low', color: 'c5def5', description: 'Low scheduling priority' },
    { name: 'ai-ready', color: '1f883d', description: 'Definition of Ready has passed' },
    { name: 'ai-in-progress', color: '0969da', description: 'Claimed by the autonomous Scrum team' },
    { name: 'ai-review', color: '8250df', description: 'Draft PR is ready for human review' },
    { name: 'ai-blocked', color: 'd1242f', description: 'Autonomous work requires attention' },
    { name: 'ai-done', color: '0e8a16', description: 'Definition of Done has passed' },
    { name: 'needs-regression-test', color: 'e99695', description: 'Bug fix must add regression coverage' },
  ],
  milestoneTitles: ['Current Sprint', 'Next Sprint', 'Engineering Backlog'],
  statuses: ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'],
};

export interface ScrumIssueRecord {
  repository: string;
  number: number;
  title: string;
  body: string;
  type: ScrumIssueType;
  labels: string[];
  milestone?: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  estimate: number;
  status: ScrumBoardStatus;
  updatedAt?: string;
}

export interface DefinitionCheck {
  passed: boolean;
  errors: string[];
}

export interface DefinitionOfDoneEvidence {
  pullRequestUrl?: string;
  validationPassed: boolean;
  ciPassed: boolean;
  reviewPassed: boolean;
  regressionTests: string[];
  humanMergeApproved: boolean;
}

export function checkDefinitionOfReady(issue: ScrumIssueRecord): DefinitionCheck {
  const errors: string[] = [];
  if (!issue.title.trim()) errors.push('title_required');
  if (!issue.body.trim()) errors.push('description_required');
  if (!issue.labels.includes(`type:${issue.type}`)) errors.push('type_label_required');
  if (!issue.milestone) errors.push('milestone_required');
  if (issue.type !== 'epic' && issue.acceptanceCriteria.filter(Boolean).length === 0) errors.push('acceptance_criteria_required');
  if (!Number.isFinite(issue.estimate) || issue.estimate < 1 || issue.estimate > 13) errors.push('story_points_must_be_1_to_13');
  if (issue.dependencies.some(value => !value.trim())) errors.push('dependency_reference_invalid');
  if (issue.status !== 'ready' && !issue.labels.includes('ai-ready')) errors.push('ready_status_required');
  if (issue.type === 'bug' && !issue.labels.includes('needs-regression-test')) errors.push('bug_regression_label_required');
  return { passed: errors.length === 0, errors };
}

export function checkDefinitionOfDone(issue: ScrumIssueRecord, evidence: DefinitionOfDoneEvidence): DefinitionCheck {
  const errors: string[] = [];
  if (!evidence.pullRequestUrl) errors.push('pull_request_required');
  if (!evidence.validationPassed) errors.push('validation_required');
  if (!evidence.ciPassed) errors.push('ci_success_required');
  if (!evidence.reviewPassed) errors.push('review_required');
  if (issue.type === 'bug' && evidence.regressionTests.length === 0) errors.push('regression_test_required');
  if (!evidence.humanMergeApproved) errors.push('human_merge_approval_required');
  return { passed: errors.length === 0, errors };
}

export interface M18BoardEvent {
  id: string;
  repository: string;
  issueNumber: number;
  action: 'created' | 'edited' | 'labeled' | 'unlabeled' | 'moved' | 'closed' | 'reopened';
  occurredAt: string;
  payloadDigest: string;
}

interface BoardEventState {
  schemaVersion: 1;
  processedEventIds: string[];
  events: M18BoardEvent[];
}

export class JsonBoardEventStore {
  constructor(private readonly filePath: string) {}

  async ingest(event: Omit<M18BoardEvent, 'payloadDigest'>, payload: unknown): Promise<{ accepted: boolean; event: M18BoardEvent }> {
    const state = await this.read();
    const normalized: M18BoardEvent = {
      ...event,
      payloadDigest: sha256(stableJson(payload)),
    };
    if (state.processedEventIds.includes(event.id)) return { accepted: false, event: normalized };
    state.processedEventIds.push(event.id);
    state.events.push(normalized);
    await writeJsonAtomic(this.filePath, state);
    return { accepted: true, event: normalized };
  }

  async list(): Promise<M18BoardEvent[]> {
    return (await this.read()).events;
  }

  private async read(): Promise<BoardEventState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as BoardEventState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.processedEventIds) || !Array.isArray(parsed.events)) {
        throw new Error('Invalid M18 board event store.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { schemaVersion: 1, processedEventIds: [], events: [] };
    }
  }
}

export interface IssueLease {
  issueKey: string;
  ownerId: string;
  token: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

interface IssueLeaseState {
  schemaVersion: 1;
  leases: Record<string, IssueLease>;
}

export class JsonIssueLeaseStore {
  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claim(issueKey: string, ownerId: string, ttlMs = 60_000): Promise<IssueLease | undefined> {
    const state = await this.read();
    this.removeExpired(state);
    const existing = state.leases[issueKey];
    if (existing && existing.ownerId !== ownerId) return undefined;
    const now = this.now();
    const lease: IssueLease = {
      issueKey,
      ownerId,
      token: existing?.token ?? randomUUID(),
      acquiredAt: existing?.acquiredAt ?? now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    state.leases[issueKey] = lease;
    await writeJsonAtomic(this.filePath, state);
    return lease;
  }

  async heartbeat(issueKey: string, token: string, ttlMs = 60_000): Promise<IssueLease | undefined> {
    const state = await this.read();
    this.removeExpired(state);
    const lease = state.leases[issueKey];
    if (!lease || lease.token !== token) return undefined;
    const now = this.now();
    const renewed = { ...lease, heartbeatAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    state.leases[issueKey] = renewed;
    await writeJsonAtomic(this.filePath, state);
    return renewed;
  }

  async release(issueKey: string, token: string): Promise<boolean> {
    const state = await this.read();
    const lease = state.leases[issueKey];
    if (!lease || lease.token !== token) return false;
    delete state.leases[issueKey];
    await writeJsonAtomic(this.filePath, state);
    return true;
  }

  async get(issueKey: string): Promise<IssueLease | undefined> {
    const state = await this.read();
    const before = Object.keys(state.leases).length;
    this.removeExpired(state);
    if (Object.keys(state.leases).length !== before) await writeJsonAtomic(this.filePath, state);
    return state.leases[issueKey];
  }

  private removeExpired(state: IssueLeaseState): void {
    const now = this.now().getTime();
    for (const [key, lease] of Object.entries(state.leases)) {
      if (Date.parse(lease.expiresAt) <= now) delete state.leases[key];
    }
  }

  private async read(): Promise<IssueLeaseState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as IssueLeaseState;
      if (parsed.schemaVersion !== 1 || typeof parsed.leases !== 'object' || parsed.leases === null) {
        throw new Error('Invalid M18 issue lease store.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { schemaVersion: 1, leases: {} };
    }
  }
}

export interface KarkeDikhaTaskConversion {
  origin: 'github-project';
  repositoryId: string;
  repositoryRoot: string;
  baseBranch: string;
  issue: { repository: string; number: number; title: string };
  goal: string;
  instructions: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  validationCommands: string[];
  requireHumanMergeApproval: true;
}

export function convertBoardIssueToKarkeDikhaTask(
  issue: ScrumIssueRecord,
  repositoryRoot: string,
  baseBranch: string,
  validationCommands: string[],
): KarkeDikhaTaskConversion {
  const ready = checkDefinitionOfReady(issue);
  if (!ready.passed) throw new Error(`Issue is not Ready: ${ready.errors.join(', ')}`);
  return {
    origin: 'github-project',
    repositoryId: issue.repository,
    repositoryRoot,
    baseBranch,
    issue: { repository: issue.repository, number: issue.number, title: issue.title },
    goal: issue.title.trim(),
    instructions: [
      `Work item type: ${issue.type}`,
      `GitHub issue: ${issue.repository}#${issue.number}`,
      'Acceptance criteria:',
      ...issue.acceptanceCriteria.map(value => `- ${value}`),
      issue.dependencies.length > 0 ? `Dependencies: ${issue.dependencies.join(', ')}` : 'Dependencies: none',
      'Use an isolated worktree. Preserve proposal, mutation, validation, review, delivery, and human merge approval gates.',
    ].join('\n'),
    priority: priorityFromLabels(issue.labels),
    validationCommands: [...validationCommands],
    requireHumanMergeApproval: true,
  };
}

export function defaultM18ControlPlanePaths(repositoryRoot: string): { events: string; leases: string } {
  const root = path.join(repositoryRoot, '.ollama-agent', 'scrum');
  return {
    events: path.join(root, 'board-events.json'),
    leases: path.join(root, 'issue-leases.json'),
  };
}

function priorityFromLabels(labels: string[]): 'urgent' | 'high' | 'normal' | 'low' {
  if (labels.includes('priority:urgent')) return 'urgent';
  if (labels.includes('priority:high')) return 'high';
  if (labels.includes('priority:low')) return 'low';
  return 'normal';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}
