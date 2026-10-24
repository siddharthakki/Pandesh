import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  M18_PROJECT_BOARD_SCHEMA,
  ScrumBoardStatus,
  ScrumIssueRecord,
  ScrumIssueType,
} from '../scrum/M18ScrumControlPlane';
import type { SprintBoardReporter, SprintStory } from '../sprint/M20AutonomousSprint';
import type { BugPublisher, PipelineResult, RepairBugRecord } from '../repair/M21CIBugRepairLoop';

const execFileAsync = promisify(execFile);

export interface GitHubCommandRunner {
  run(args: string[]): Promise<string>;
}

export class GhCliCommandRunner implements GitHubCommandRunner {
  constructor(private readonly cwd: string) {}

  async run(args: string[]): Promise<string> {
    const result = await execFileAsync('gh', args, {
      cwd: this.cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return String(result.stdout).trim();
  }
}

type GhIssuePayload = {
  number: number;
  title: string;
  body?: string;
  url: string;
  updatedAt?: string;
  labels?: Array<{ name?: string }>;
  milestone?: { title?: string } | null;
};

export class GhEngineeringBoard implements SprintBoardReporter, BugPublisher {
  private readonly owner: string;

  constructor(
    private readonly cwd: string,
    readonly repository: string,
    private readonly runner: GitHubCommandRunner = new GhCliCommandRunner(cwd),
  ) {
    const parts = repository.split('/');
    if (parts.length !== 2 || parts.some(part => !part.trim())) {
      throw new Error(`Invalid GitHub repository: ${repository}`);
    }
    this.owner = parts[0];
  }

  async provision(): Promise<{ projectNumber: number; projectUrl?: string }> {
    await this.ensureLabels();
    await this.ensureMilestones();
    const project = await this.ensureProject();
    await this.ensureProjectFields(project.number);
    return { projectNumber: project.number, projectUrl: project.url };
  }

  async listReadyIssues(): Promise<ScrumIssueRecord[]> {
    const raw = await this.runner.run([
      'issue', 'list', '--repo', this.repository, '--state', 'open',
      '--label', 'ai-ready', '--limit', '100',
      '--json', 'number,title,body,url,labels,milestone,updatedAt',
    ]);
    const payload = parseJson<unknown>(raw, 'gh issue list');
    if (!Array.isArray(payload)) throw new Error('gh issue list returned a non-array payload.');
    return payload.map(value => this.parseIssue(value as GhIssuePayload));
  }

  async issue(number: number): Promise<ScrumIssueRecord> {
    const raw = await this.runner.run([
      'issue', 'view', String(number), '--repo', this.repository,
      '--json', 'number,title,body,url,labels,milestone,updatedAt',
    ]);
    return this.parseIssue(parseJson<GhIssuePayload>(raw, 'gh issue view'));
  }

  async transition(issue: Pick<ScrumIssueRecord, 'number'>, status: ScrumBoardStatus, message: string): Promise<void> {
    const desired = labelForStatus(status);
    const current = await this.issue(issue.number);
    const managed = ['ai-ready', 'ai-in-progress', 'ai-review', 'ai-blocked', 'ai-done'];
    const args = ['issue', 'edit', String(issue.number), '--repo', this.repository];
    for (const label of managed) {
      if (label !== desired && current.labels.includes(label)) args.push('--remove-label', label);
    }
    if (!current.labels.includes(desired)) args.push('--add-label', desired);
    if (args.length > 6) await this.runner.run(args);
    await this.runner.run([
      'issue', 'comment', String(issue.number), '--repo', this.repository,
      '--body', sanitize(message),
    ]);
  }

  async update(story: SprintStory, message: string): Promise<void> {
    const number = issueNumberFromRef(story.externalRef);
    if (!number) return;
    const status: ScrumBoardStatus = story.state === 'done' || story.state === 'review' ? 'review'
      : story.state === 'blocked' ? 'blocked'
      : 'in-progress';
    await this.transition({ number }, status, message);
  }

  async escalate(story: SprintStory, message: string): Promise<void> {
    const number = issueNumberFromRef(story.externalRef);
    if (!number) return;
    await this.transition({ number }, 'blocked', `Escalation: ${message}`);
  }

  async ensureBug(record: RepairBugRecord, pipeline: PipelineResult): Promise<{ issueNumber: number; issueUrl: string }> {
    if (record.issueNumber && record.issueUrl) return { issueNumber: record.issueNumber, issueUrl: record.issueUrl };
    const existingRaw = await this.runner.run([
      'issue', 'list', '--repo', this.repository, '--state', 'all',
      '--label', 'type:bug', '--search', `"${record.fingerprint}" in:body`,
      '--limit', '20', '--json', 'number,url,body',
    ]);
    const existing = parseJson<Array<{ number: number; url: string; body?: string }>>(existingRaw, 'gh issue list bug dedupe');
    const match = existing.find(issue => issue.body?.includes(record.fingerprint));
    if (match) return { issueNumber: match.number, issueUrl: match.url };

    const body = [
      '## Automated CI failure',
      '',
      `Fingerprint: \`${record.fingerprint}\``,
      `Signal: \`${record.signalKey}\``,
      `Classification: **${record.flaky}**`,
      `Workflow: \`${pipeline.workflow}\``,
      `Commit: \`${pipeline.commitSha}\``,
      pipeline.runUrl ? `Run: ${pipeline.runUrl}` : undefined,
      '',
      '## Failure evidence',
      ...pipeline.failedChecks.map(value => `- Failed check: ${value}`),
      ...pipeline.failingTests.map(value => `- Failing test: ${value}`),
      pipeline.errorSummary ? `- Summary: ${sanitize(pipeline.errorSummary)}` : undefined,
      '',
      '## Required repair evidence',
      '- [ ] Root cause identified',
      '- [ ] Automated regression test added or identified',
      '- [ ] Focused validation passed',
      '- [ ] Review passed',
      '- [ ] CI passed',
    ].filter((value): value is string => Boolean(value)).join('\n');

    const url = await this.runner.run([
      'issue', 'create', '--repo', this.repository,
      '--title', record.title, '--body', body,
      '--label', 'type:bug', '--label', 'needs-regression-test',
      '--label', 'ai-ready', '--label', 'priority:high',
    ]);
    const number = issueNumberFromUrl(url);
    if (!number) throw new Error(`Cannot parse issue number from gh issue create output: ${url}`);
    return { issueNumber: number, issueUrl: url.trim() };
  }

  async updateBug(record: RepairBugRecord, message: string): Promise<void> {
    if (!record.issueNumber) return;
    await this.runner.run([
      'issue', 'comment', String(record.issueNumber), '--repo', this.repository,
      '--body', sanitize(message),
    ]);
    if (record.state === 'verified') {
      await this.runner.run([
        'issue', 'edit', String(record.issueNumber), '--repo', this.repository,
        '--remove-label', 'ai-in-progress', '--remove-label', 'ai-blocked',
        '--add-label', 'ai-review',
      ]);
    }
    if (record.state === 'closed') {
      await this.runner.run([
        'issue', 'close', String(record.issueNumber), '--repo', this.repository,
        '--reason', 'completed',
      ]);
    }
  }

  private async ensureLabels(): Promise<void> {
    for (const label of M18_PROJECT_BOARD_SCHEMA.labels) {
      await this.runner.run([
        'label', 'create', label.name, '--repo', this.repository,
        '--color', label.color, '--description', label.description, '--force',
      ]);
    }
  }

  private async ensureMilestones(): Promise<void> {
    const raw = await this.runner.run([
      'api', `repos/${this.repository}/milestones?state=all&per_page=100`, '--paginate',
    ]);
    const milestones = parseJson<Array<{ title?: string }>>(raw || '[]', 'GitHub milestones');
    const existing = new Set(milestones.map(value => String(value.title ?? '')));
    for (const title of M18_PROJECT_BOARD_SCHEMA.milestoneTitles) {
      if (existing.has(title)) continue;
      await this.runner.run([
        'api', `repos/${this.repository}/milestones`, '--method', 'POST', '-f', `title=${title}`,
      ]);
    }
  }

  private async ensureProject(): Promise<{ number: number; title: string; url?: string }> {
    const raw = await this.runner.run([
      'project', 'list', '--owner', this.owner, '--format', 'json', '--limit', '100',
    ]);
    const listed = parseJson<{ projects?: Array<{ number: number; title: string; url?: string }> }>(raw, 'gh project list');
    const existing = listed.projects?.find(project => project.title === M18_PROJECT_BOARD_SCHEMA.title);
    if (existing) return existing;
    const createdRaw = await this.runner.run([
      'project', 'create', '--owner', this.owner,
      '--title', M18_PROJECT_BOARD_SCHEMA.title, '--format', 'json',
    ]);
    const created = parseJson<{ number?: number; title?: string; url?: string }>(createdRaw, 'gh project create');
    if (!created.number) throw new Error('gh project create did not return a project number.');
    return { number: created.number, title: created.title ?? M18_PROJECT_BOARD_SCHEMA.title, url: created.url };
  }

  private async ensureProjectFields(projectNumber: number): Promise<void> {
    const raw = await this.runner.run([
      'project', 'field-list', String(projectNumber), '--owner', this.owner, '--format', 'json',
    ]);
    const listed = parseJson<{ fields?: Array<{ name: string }> }>(raw, 'gh project field-list');
    const existing = new Set((listed.fields ?? []).map(field => field.name));
    for (const field of M18_PROJECT_BOARD_SCHEMA.fields) {
      if (field.name === 'Status' || existing.has(field.name)) continue;
      const args = [
        'project', 'field-create', String(projectNumber), '--owner', this.owner,
        '--name', field.name, '--data-type', field.type === 'single-select' ? 'SINGLE_SELECT' : field.type === 'number' ? 'NUMBER' : 'TEXT',
      ];
      if (field.type === 'single-select' && field.options?.length) {
        args.push('--single-select-options', field.options.join(','));
      }
      await this.runner.run(args);
    }
  }

  private parseIssue(payload: GhIssuePayload): ScrumIssueRecord {
    if (!Number.isInteger(payload.number) || !payload.url) throw new Error('Invalid GitHub issue payload.');
    const labels = (payload.labels ?? []).map(label => String(label.name ?? '')).filter(Boolean);
    const body = String(payload.body ?? '');
    return {
      repository: this.repository,
      number: payload.number,
      title: String(payload.title ?? '').trim(),
      body,
      type: issueTypeFromLabels(labels),
      labels,
      milestone: payload.milestone?.title,
      acceptanceCriteria: extractChecklistSection(body, ['Acceptance criteria', 'Expected behavior']),
      dependencies: extractDependencies(body),
      estimate: extractStoryPoints(body),
      status: statusFromLabels(labels),
      updatedAt: payload.updatedAt,
    };
  }
}

export function pipelineResultFromGitHub(payload: {
  id: number | string;
  repository: string;
  branch: string;
  headSha: string;
  workflow: string;
  conclusion?: string | null;
  runUrl?: string;
  failedChecks?: string[];
  failingTests?: string[];
  errorSummary?: string;
  startedAt: string;
  completedAt: string;
  attempt?: number;
  rerunOf?: string;
}): PipelineResult {
  return {
    id: String(payload.id),
    repository: payload.repository,
    branch: payload.branch,
    commitSha: payload.headSha,
    workflow: payload.workflow,
    runUrl: payload.runUrl,
    conclusion: payload.conclusion === 'success' ? 'success'
      : payload.conclusion === 'cancelled' ? 'cancelled'
      : payload.conclusion === 'timed_out' || payload.conclusion === 'timed-out' ? 'timed-out'
      : 'failure',
    failedChecks: unique(payload.failedChecks ?? []),
    failingTests: unique(payload.failingTests ?? []),
    errorSummary: payload.errorSummary,
    startedAt: payload.startedAt,
    completedAt: payload.completedAt,
    attempt: Math.max(1, Math.trunc(payload.attempt ?? 1)),
    rerunOf: payload.rerunOf,
  };
}

function issueTypeFromLabels(labels: string[]): ScrumIssueType {
  const types = labels.filter(label => /^type:(epic|story|bug)$/.test(label));
  if (types.length !== 1) throw new Error(`Issue requires exactly one type label; found ${types.join(', ') || 'none'}.`);
  return types[0].slice('type:'.length) as ScrumIssueType;
}

function statusFromLabels(labels: string[]): ScrumBoardStatus {
  if (labels.includes('ai-done')) return 'done';
  if (labels.includes('ai-blocked')) return 'blocked';
  if (labels.includes('ai-review')) return 'review';
  if (labels.includes('ai-in-progress')) return 'in-progress';
  if (labels.includes('ai-ready')) return 'ready';
  return 'backlog';
}

function labelForStatus(status: ScrumBoardStatus): string {
  if (status === 'in-progress') return 'ai-in-progress';
  if (status === 'review') return 'ai-review';
  if (status === 'blocked') return 'ai-blocked';
  if (status === 'done') return 'ai-done';
  return 'ai-ready';
}

function extractChecklistSection(body: string, headings: string[]): string[] {
  const sections = splitMarkdownSections(body);
  for (const heading of headings) {
    const section = sections.get(heading.toLowerCase());
    if (!section) continue;
    const values = section.split(/\r?\n/)
      .map(line => line.replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/, '').trim())
      .filter(Boolean);
    if (values.length > 0) return values;
  }
  return [];
}

function extractDependencies(body: string): string[] {
  const section = splitMarkdownSections(body).get('dependencies') ?? '';
  if (/^\s*none\s*$/im.test(section)) return [];
  return unique([...section.matchAll(/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+/g)].map(match => match[0]));
}

function extractStoryPoints(body: string): number {
  const sections = splitMarkdownSections(body);
  const raw = sections.get('story points') ?? sections.get('estimate') ?? '';
  const match = /\b(1|2|3|5|8|13)\b/.exec(raw);
  return match ? Number(match[1]) : 0;
}

function splitMarkdownSections(body: string): Map<string, string> {
  const result = new Map<string, string>();
  const matches = [...body.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const start = (current.index ?? 0) + current[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    result.set(current[1].trim().toLowerCase(), body.slice(start, end).trim());
  }
  return result;
}

function issueNumberFromRef(reference?: string): number | undefined {
  const match = /#(\d+)$/.exec(reference ?? '');
  return match ? Number(match[1]) : undefined;
}

function issueNumberFromUrl(value: string): number | undefined {
  const match = /\/issues\/(\d+)\s*$/.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sanitize(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 8_000);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
