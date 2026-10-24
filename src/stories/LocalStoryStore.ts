import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export type LocalStoryStatus = 'backlog' | 'ready' | 'in_progress' | 'review' | 'blocked' | 'done';

export interface LocalStoryDraft {
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  validation: string[];
  dependencies: string[];
  estimatedPoints: number;
}

export interface LocalStory extends LocalStoryDraft {
  id: string;
  status: LocalStoryStatus;
  source: 'chat' | 'user';
  sourceConversationId?: string;
  sourceText?: string;
  createdAt: string;
  updatedAt: string;
  blockedReason?: string;
}

interface LocalStoryState {
  schemaVersion: 1;
  stories: LocalStory[];
}

export interface CreateLocalStoryInput {
  draft: LocalStoryDraft;
  source?: 'chat' | 'user';
  sourceConversationId?: string;
  sourceText?: string;
}

export class LocalStoryStore {
  readonly filePath: string;

  constructor(root: string) {
    this.filePath = path.join(root, '.ollama-agent', 'board', 'local-stories.json');
  }

  async list(): Promise<LocalStory[]> {
    const state = await this.load();
    return state.stories
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(story => structuredClone(story));
  }

  async create(input: CreateLocalStoryInput): Promise<{ story: LocalStory; created: boolean }> {
    const draft = normalizeLocalStoryDraft(input.draft);
    const state = await this.load();
    const fingerprint = storyFingerprint(draft, input.sourceText);
    const existing = state.stories.find(story => storyFingerprint(story, story.sourceText) === fingerprint);
    if (existing) return { story: structuredClone(existing), created: false };

    const now = new Date().toISOString();
    const story: LocalStory = {
      ...draft,
      id: `local-story-${randomUUID()}`,
      status: 'backlog',
      source: input.source ?? 'chat',
      sourceConversationId: optionalBounded(input.sourceConversationId, 160),
      sourceText: optionalBounded(input.sourceText, 4_000),
      createdAt: now,
      updatedAt: now,
    };
    state.stories.push(story);
    await this.save(state);
    return { story: structuredClone(story), created: true };
  }

  async updateStatus(id: string, status: LocalStoryStatus, blockedReason?: string): Promise<LocalStory> {
    const state = await this.load();
    const story = state.stories.find(candidate => candidate.id === id);
    if (!story) throw new Error(`Local story not found: ${id}`);
    story.status = status;
    story.updatedAt = new Date().toISOString();
    story.blockedReason = status === 'blocked' ? optionalBounded(blockedReason, 500) ?? 'Needs attention' : undefined;
    await this.save(state);
    return structuredClone(story);
  }

  private async load(): Promise<LocalStoryState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<LocalStoryState>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.stories)) throw new Error('Invalid local story state.');
      return { schemaVersion: 1, stories: parsed.stories.map(normalizeStoredStory) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { schemaVersion: 1, stories: [] };
    }
  }

  private async save(state: LocalStoryState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filePath);
  }
}

export function normalizeLocalStoryDraft(value: unknown): LocalStoryDraft {
  const candidate = asRecord(value);
  const title = requiredString(candidate.title, 'title', 120);
  const goal = requiredString(candidate.goal, 'goal', 2_000);
  const acceptanceCriteria = boundedStringArray(candidate.acceptanceCriteria, 'acceptanceCriteria', 12, 500);
  if (acceptanceCriteria.length === 0) throw new Error('Story requires at least one acceptance criterion.');
  return {
    title,
    goal,
    acceptanceCriteria,
    constraints: boundedStringArray(candidate.constraints, 'constraints', 12, 500),
    validation: boundedStringArray(candidate.validation, 'validation', 12, 500),
    dependencies: boundedStringArray(candidate.dependencies, 'dependencies', 12, 160),
    estimatedPoints: normalizePoints(candidate.estimatedPoints),
  };
}

function normalizeStoredStory(value: unknown): LocalStory {
  const candidate = asRecord(value);
  const draft = normalizeLocalStoryDraft(candidate);
  const status = candidate.status;
  if (!['backlog', 'ready', 'in_progress', 'review', 'blocked', 'done'].includes(String(status))) {
    throw new Error('Invalid local story status.');
  }
  return {
    ...draft,
    id: requiredString(candidate.id, 'id', 160),
    status: status as LocalStoryStatus,
    source: candidate.source === 'user' ? 'user' : 'chat',
    sourceConversationId: optionalBounded(candidate.sourceConversationId, 160),
    sourceText: optionalBounded(candidate.sourceText, 4_000),
    createdAt: requiredString(candidate.createdAt, 'createdAt', 80),
    updatedAt: requiredString(candidate.updatedAt, 'updatedAt', 80),
    blockedReason: optionalBounded(candidate.blockedReason, 500),
  };
}

function storyFingerprint(draft: LocalStoryDraft, sourceText?: string): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: draft.title.toLowerCase(),
      goal: draft.goal.toLowerCase(),
      sourceText: sourceText?.trim().toLowerCase() ?? '',
    }))
    .digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Story draft must be an object.');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, max: number): string {
  const normalized = optionalBounded(value, max);
  if (!normalized) throw new Error(`Story ${field} is required.`);
  return normalized;
}

function optionalBounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.slice(0, max);
}

function boundedStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Story ${field} must be an array.`);
  return value
    .slice(0, maxItems)
    .map(item => requiredString(item, field, maxLength));
}

function normalizePoints(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 3;
  const allowed = [1, 2, 3, 5, 8, 13];
  return allowed.reduce((best, candidate) => Math.abs(candidate - numeric) < Math.abs(best - numeric) ? candidate : best, 3);
}
