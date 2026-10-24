import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type {
  AgentExecutionStatus,
  AgentRole,
  AgentTaskRequest,
  HermesWorkforceCoordinator,
} from '../workforce/M19AgentWorkforceRuntime';

export type SprintStoryKind = 'epic' | 'story' | 'bug' | 'repair';
export type SprintStoryState = 'backlog' | 'ready' | 'assigned' | 'in-progress' | 'review' | 'done' | 'blocked' | 'cancelled';

export interface SprintStory {
  id: string;
  externalRef?: string;
  parentId?: string;
  title: string;
  goal: string;
  kind: SprintStoryKind;
  acceptanceCriteria: string[];
  dependencies: string[];
  estimate: number;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  requiredCapabilities: string[];
  role: AgentRole;
  state: SprintStoryState;
  progress: number;
  executionId?: string;
  assignedWorkerId?: string;
  blockedReason?: string;
  blockedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface SprintDefinition {
  id: string;
  name: string;
  goal: string;
  startedAt: string;
  endsAt: string;
  capacityPoints: number;
  wipLimit: number;
  status: 'planned' | 'active' | 'review' | 'closed';
  storyIds: string[];
}

export interface SprintEvent {
  id: string;
  at: string;
  type: 'planned' | 'assigned' | 'progress' | 'blocked' | 'escalated' | 'review' | 'completed' | 'cancelled';
  storyId?: string;
  summary: string;
}

export interface DailyScrumSummary {
  generatedAt: string;
  sprintId: string;
  done: string[];
  inProgress: string[];
  blocked: string[];
  next: string[];
}

export interface SprintReview {
  generatedAt: string;
  sprintId: string;
  completedStories: string[];
  incompleteStories: string[];
  deliveredPoints: number;
  plannedPoints: number;
}

export interface SprintRetrospective {
  generatedAt: string;
  sprintId: string;
  wentWell: string[];
  needsImprovement: string[];
  actions: string[];
}

export interface SprintState {
  schemaVersion: 1;
  sprints: SprintDefinition[];
  stories: SprintStory[];
  events: SprintEvent[];
  dailySummaries: DailyScrumSummary[];
  reviews: SprintReview[];
  retrospectives: SprintRetrospective[];
}

export interface SprintStore {
  load(): Promise<SprintState>;
  save(state: SprintState): Promise<void>;
}

export class InMemorySprintStore implements SprintStore {
  private value: SprintState = emptySprintState();
  async load(): Promise<SprintState> { return structuredClone(this.value); }
  async save(state: SprintState): Promise<void> { this.value = structuredClone(state); }
}

export class JsonSprintStore implements SprintStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<SprintState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as SprintState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sprints) || !Array.isArray(parsed.stories)) {
        throw new Error('Invalid M20 sprint state.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return emptySprintState();
    }
  }

  async save(state: SprintState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filePath);
  }
}

export interface StoryDecomposer {
  decompose(epic: SprintStory): Promise<SprintStory[]>;
}

export interface SprintBoardReporter {
  update(story: SprintStory, message: string): Promise<void>;
  escalate(story: SprintStory, message: string): Promise<void>;
}

export class NoopSprintBoardReporter implements SprintBoardReporter {
  async update(): Promise<void> {}
  async escalate(): Promise<void> {}
}

export interface AutonomousSprintOptions {
  repositoryRoot: string;
  blockedEscalationMs: number;
  now?: () => Date;
}

export class AutonomousSprintEngine {
  private readonly now: () => Date;

  constructor(
    private readonly store: SprintStore,
    private readonly workforce: HermesWorkforceCoordinator,
    private readonly reporter: SprintBoardReporter = new NoopSprintBoardReporter(),
    private readonly decomposer?: StoryDecomposer,
    private readonly options: AutonomousSprintOptions = { repositoryRoot: process.cwd(), blockedEscalationMs: 15 * 60_000 },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async planSprint(input: {
    name: string;
    goal: string;
    startsAt?: string;
    endsAt: string;
    capacityPoints: number;
    wipLimit: number;
    backlog: SprintStory[];
  }): Promise<SprintDefinition> {
    if (input.capacityPoints < 1) throw new Error('Sprint capacity must be positive.');
    if (input.wipLimit < 1) throw new Error('Sprint WIP limit must be positive.');
    const expanded: SprintStory[] = [];
    for (const story of input.backlog) {
      if (story.kind === 'epic') {
        if (!this.decomposer) throw new Error(`Epic ${story.id} requires a story decomposer.`);
        const children = await this.decomposer.decompose(story);
        for (const child of children) expanded.push({ ...child, parentId: story.id });
      } else {
        expanded.push(structuredClone(story));
      }
    }
    const ordered = dependencyAwareOrder([...expanded].sort(compareStoryPriority));
    const selected: SprintStory[] = [];
    const selectedIds = new Set<string>();
    let used = 0;
    for (const story of ordered) {
      if (!story.dependencies.every(dependency => selectedIds.has(dependency))) continue;
      if (used + story.estimate > input.capacityPoints) continue;
      selected.push({ ...story, state: story.dependencies.length === 0 ? 'ready' : 'backlog', progress: 0 });
      selectedIds.add(story.id);
      used += story.estimate;
    }
    const state = await this.store.load();
    const sprint: SprintDefinition = {
      id: `sprint-${randomUUID()}`,
      name: input.name,
      goal: input.goal,
      startedAt: input.startsAt ?? this.now().toISOString(),
      endsAt: input.endsAt,
      capacityPoints: input.capacityPoints,
      wipLimit: input.wipLimit,
      status: 'planned',
      storyIds: selected.map(story => story.id),
    };
    state.sprints.push(sprint);
    upsertStories(state, selected);
    state.events.push(event(this.now(), 'planned', undefined, `Planned ${selected.length} stories for ${sprint.name}.`));
    await this.store.save(state);
    return structuredClone(sprint);
  }

  async startSprint(sprintId: string): Promise<SprintDefinition> {
    const state = await this.store.load();
    const sprint = requiredSprint(state, sprintId);
    if (sprint.status !== 'planned' && sprint.status !== 'active') throw new Error(`Sprint ${sprintId} cannot start from ${sprint.status}.`);
    sprint.status = 'active';
    unlockDependencies(state, sprint);
    await this.assignAvailable(state, sprint);
    await this.store.save(state);
    return structuredClone(sprint);
  }

  async tick(sprintId: string): Promise<{ changed: SprintStory[]; escalated: SprintStory[] }> {
    const state = await this.store.load();
    const sprint = requiredSprint(state, sprintId);
    const observed = await this.workforce.reconcile();
    const changed: SprintStory[] = [];
    for (const status of observed) {
      const story = state.stories.find(candidate => candidate.executionId === status.executionId);
      if (!story) continue;
      applyExecutionStatus(story, status, this.now());
      state.events.push(event(this.now(), eventTypeForStory(story), story.id, `${story.title}: ${story.state}.`));
      await this.reporter.update(story, `Autonomous sprint progress: ${story.state} (${story.progress}%).`);
      changed.push(structuredClone(story));
    }
    unlockDependencies(state, sprint);
    const escalated = await this.escalateBlocked(state, sprint);
    await this.assignAvailable(state, sprint);
    if (sprint.storyIds.every(id => terminalStory(requiredStory(state, id).state))) sprint.status = 'review';
    await this.store.save(state);
    return { changed, escalated };
  }

  async updateProgress(storyId: string, progress: number, message: string): Promise<SprintStory> {
    const state = await this.store.load();
    const story = requiredStory(state, storyId);
    story.progress = Math.max(0, Math.min(100, Math.round(progress)));
    if (story.progress > 0 && story.state === 'assigned') story.state = 'in-progress';
    state.events.push(event(this.now(), 'progress', story.id, message));
    await this.reporter.update(story, message);
    await this.store.save(state);
    return structuredClone(story);
  }

  async blockStory(storyId: string, reason: string): Promise<SprintStory> {
    const state = await this.store.load();
    const story = requiredStory(state, storyId);
    story.state = 'blocked';
    story.blockedReason = sanitize(reason);
    story.blockedAt = this.now().toISOString();
    state.events.push(event(this.now(), 'blocked', story.id, story.blockedReason));
    await this.reporter.update(story, `Blocked: ${story.blockedReason}`);
    await this.store.save(state);
    return structuredClone(story);
  }

  async dailyScrum(sprintId: string): Promise<DailyScrumSummary> {
    const state = await this.store.load();
    const sprint = requiredSprint(state, sprintId);
    const stories = sprint.storyIds.map(id => requiredStory(state, id));
    const summary: DailyScrumSummary = {
      generatedAt: this.now().toISOString(),
      sprintId,
      done: stories.filter(story => story.state === 'done').map(story => story.title),
      inProgress: stories.filter(story => story.state === 'assigned' || story.state === 'in-progress' || story.state === 'review').map(story => `${story.title} (${story.progress}%)`),
      blocked: stories.filter(story => story.state === 'blocked').map(story => `${story.title}: ${story.blockedReason ?? 'unknown'}`),
      next: stories.filter(story => story.state === 'ready' || story.state === 'backlog').map(story => story.title),
    };
    state.dailySummaries.push(summary);
    await this.store.save(state);
    return structuredClone(summary);
  }

  async closeSprint(sprintId: string): Promise<{ review: SprintReview; retrospective: SprintRetrospective }> {
    const state = await this.store.load();
    const sprint = requiredSprint(state, sprintId);
    const stories = sprint.storyIds.map(id => requiredStory(state, id));
    const completed = stories.filter(story => story.state === 'done');
    const incomplete = stories.filter(story => story.state !== 'done' && story.state !== 'cancelled');
    const review: SprintReview = {
      generatedAt: this.now().toISOString(),
      sprintId,
      completedStories: completed.map(story => story.title),
      incompleteStories: incomplete.map(story => story.title),
      deliveredPoints: completed.reduce((sum, story) => sum + story.estimate, 0),
      plannedPoints: stories.reduce((sum, story) => sum + story.estimate, 0),
    };
    const blockedEvents = state.events.filter(value => value.type === 'blocked' || value.type === 'escalated');
    const retrospective: SprintRetrospective = {
      generatedAt: this.now().toISOString(),
      sprintId,
      wentWell: [
        `${completed.length} stories reached Definition of Done.`,
        review.deliveredPoints === review.plannedPoints ? 'The sprint delivered its full planned capacity.' : 'Completed work retained validation and review evidence.',
      ],
      needsImprovement: [
        ...incomplete.map(story => `${story.title} did not reach Done.`),
        ...(blockedEvents.length > 0 ? [`${blockedEvents.length} blocked or escalated events occurred.`] : []),
      ],
      actions: incomplete.map(story => `Re-plan ${story.id} with its blocker and dependency evidence.`),
    };
    sprint.status = 'closed';
    state.reviews.push(review);
    state.retrospectives.push(retrospective);
    await this.store.save(state);
    return { review: structuredClone(review), retrospective: structuredClone(retrospective) };
  }

  async state(): Promise<SprintState> {
    return this.store.load();
  }

  private async assignAvailable(state: SprintState, sprint: SprintDefinition): Promise<void> {
    const active = sprint.storyIds.map(id => requiredStory(state, id)).filter(story => activeStory(story.state));
    let slots = Math.max(0, sprint.wipLimit - active.length);
    if (slots === 0) return;
    const candidates = sprint.storyIds
      .map(id => requiredStory(state, id))
      .filter(story => story.state === 'ready')
      .sort(compareStoryPriority);
    for (const story of candidates) {
      if (slots <= 0) break;
      const request: AgentTaskRequest = {
        requestId: `m20:${sprint.id}:${story.id}`,
        role: story.role,
        goal: `${story.title}\n${story.goal}\nAcceptance:\n${story.acceptanceCriteria.map(value => `- ${value}`).join('\n')}`,
        repositoryRoot: this.options.repositoryRoot,
        requiredCapabilities: story.requiredCapabilities,
        requiredPermissions: story.role === 'reviewer'
          ? ['repository:read', 'validation:run']
          : ['repository:read', 'worktree:write', 'validation:run'],
        timeoutMs: 30 * 60_000,
        payloadReference: story.externalRef,
      };
      try {
        const handle = await this.workforce.dispatch(request);
        story.executionId = handle.executionId;
        story.assignedWorkerId = handle.workerId;
        story.state = 'assigned';
        story.startedAt = this.now().toISOString();
        state.events.push(event(this.now(), 'assigned', story.id, `Assigned to ${handle.workerId} using ${handle.model}.`));
        await this.reporter.update(story, `Assigned to ${handle.workerId}.`);
        slots -= 1;
      } catch (error) {
        story.state = 'blocked';
        story.blockedReason = sanitize(error instanceof Error ? error.message : String(error));
        story.blockedAt = this.now().toISOString();
        state.events.push(event(this.now(), 'blocked', story.id, story.blockedReason));
      }
    }
  }

  private async escalateBlocked(state: SprintState, sprint: SprintDefinition): Promise<SprintStory[]> {
    const escalated: SprintStory[] = [];
    for (const storyId of sprint.storyIds) {
      const story = requiredStory(state, storyId);
      if (story.state !== 'blocked' || !story.blockedAt) continue;
      if (this.now().getTime() - Date.parse(story.blockedAt) < this.options.blockedEscalationMs) continue;
      const alreadyEscalated = state.events.some(value => value.type === 'escalated' && value.storyId === story.id && Date.parse(value.at) >= Date.parse(story.blockedAt!));
      if (alreadyEscalated) continue;
      const summary = `Escalation: ${story.title} has remained blocked. ${story.blockedReason ?? ''}`.trim();
      state.events.push(event(this.now(), 'escalated', story.id, summary));
      await this.reporter.escalate(story, summary);
      escalated.push(structuredClone(story));
    }
    return escalated;
  }
}

export function defaultM20SprintStatePath(repositoryRoot: string): string {
  return path.join(repositoryRoot, '.ollama-agent', 'sprints', 'state.json');
}

function emptySprintState(): SprintState {
  return { schemaVersion: 1, sprints: [], stories: [], events: [], dailySummaries: [], reviews: [], retrospectives: [] };
}

function event(now: Date, type: SprintEvent['type'], storyId: string | undefined, summary: string): SprintEvent {
  return { id: randomUUID(), at: now.toISOString(), type, storyId, summary: sanitize(summary) };
}

function requiredSprint(state: SprintState, id: string): SprintDefinition {
  const sprint = state.sprints.find(value => value.id === id);
  if (!sprint) throw new Error(`Unknown sprint ${id}.`);
  return sprint;
}

function requiredStory(state: SprintState, id: string): SprintStory {
  const story = state.stories.find(value => value.id === id);
  if (!story) throw new Error(`Unknown story ${id}.`);
  return story;
}

function upsertStories(state: SprintState, stories: SprintStory[]): void {
  for (const story of stories) {
    const index = state.stories.findIndex(value => value.id === story.id);
    if (index >= 0) state.stories[index] = structuredClone(story);
    else state.stories.push(structuredClone(story));
  }
}

function unlockDependencies(state: SprintState, sprint: SprintDefinition): void {
  for (const storyId of sprint.storyIds) {
    const story = requiredStory(state, storyId);
    if (story.state !== 'backlog') continue;
    const satisfied = story.dependencies.every(dependency => state.stories.find(value => value.id === dependency)?.state === 'done');
    if (satisfied) story.state = 'ready';
  }
}

function applyExecutionStatus(story: SprintStory, status: AgentExecutionStatus, now: Date): void {
  story.assignedWorkerId = status.workerId;
  if (status.state === 'queued') story.state = 'assigned';
  if (status.state === 'running') {
    story.state = 'in-progress';
    story.progress = Math.max(story.progress, 25);
  }
  if (status.state === 'completed') {
    story.state = 'done';
    story.progress = 100;
    story.completedAt = status.finishedAt ?? now.toISOString();
  }
  if (status.state === 'failed' || status.state === 'timed-out') {
    story.state = 'blocked';
    story.blockedReason = status.errorSummary ?? status.state;
    story.blockedAt = status.finishedAt ?? now.toISOString();
  }
  if (status.state === 'cancelled') story.state = 'cancelled';
}

function eventTypeForStory(story: SprintStory): SprintEvent['type'] {
  if (story.state === 'done') return 'completed';
  if (story.state === 'blocked') return 'blocked';
  if (story.state === 'cancelled') return 'cancelled';
  if (story.state === 'review') return 'review';
  return 'progress';
}

function dependencyAwareOrder(stories: SprintStory[]): SprintStory[] {
  const byId = new Map(stories.map(story => [story.id, story]));
  for (const story of stories) {
    for (const dependency of story.dependencies) {
      if (!byId.has(dependency)) throw new Error(`Story ${story.id} depends on missing story ${dependency}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: SprintStory[] = [];
  const visit = (story: SprintStory): void => {
    if (visited.has(story.id)) return;
    if (visiting.has(story.id)) throw new Error(`Dependency cycle detected at ${story.id}.`);
    visiting.add(story.id);
    for (const dependency of story.dependencies) visit(byId.get(dependency)!);
    visiting.delete(story.id);
    visited.add(story.id);
    ordered.push(story);
  };
  for (const story of stories) visit(story);
  return ordered;
}

function compareStoryPriority(left: SprintStory, right: SprintStory): number {
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  return rank[left.priority] - rank[right.priority] || left.estimate - right.estimate || left.id.localeCompare(right.id);
}

function activeStory(state: SprintStoryState): boolean {
  return state === 'assigned' || state === 'in-progress' || state === 'review';
}

function terminalStory(state: SprintStoryState): boolean {
  return state === 'done' || state === 'cancelled' || state === 'blocked';
}

function sanitize(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2_000);
}
