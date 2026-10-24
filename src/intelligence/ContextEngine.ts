import { createHash } from 'crypto';

export type ContextKind = 'system' | 'instruction' | 'plan' | 'approval' | 'failure' | 'message' | 'tool' | 'code' | 'memory' | 'summary';

export interface ContextSegment {
  id: string;
  kind: ContextKind;
  content: string;
  priority: number;
  pinned?: boolean;
  createdAt?: string;
  source?: string;
  estimatedTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextSummaryRequest {
  segments: ContextSegment[];
  maxTokens: number;
}

export type ContextSummarizer = (request: ContextSummaryRequest) => Promise<string>;

export interface ContextCompactionOptions {
  maxTokens: number;
  reservedTokens?: number;
  summaryTokens?: number;
  summarizer?: ContextSummarizer;
}

export interface ContextCompactionResult {
  schemaVersion: 1;
  budgetTokens: number;
  usedTokens: number;
  segments: ContextSegment[];
  includedIds: string[];
  summarizedIds: string[];
  droppedIds: string[];
  stablePrefixHash: string;
}

export class ContextEngine {
  compactSync(segments: readonly ContextSegment[], options: Omit<ContextCompactionOptions, 'summarizer'>): ContextCompactionResult {
    return this.buildResult(segments, options, undefined);
  }

  async compact(segments: readonly ContextSegment[], options: ContextCompactionOptions): Promise<ContextCompactionResult> {
    validateOptions(options);
    const normalized = normalizeSegments(segments);
    const budget = options.maxTokens - (options.reservedTokens ?? 0);
    const pinned = normalized.filter(segment => segment.pinned);
    const pinnedTokens = totalTokens(pinned);
    if (pinnedTokens > budget) {
      throw new Error(`Pinned context requires ${pinnedTokens} tokens but only ${budget} are available.`);
    }

    const chosen = chooseSegments(normalized.filter(segment => !segment.pinned), budget - pinnedTokens);
    const included = [...pinned, ...chosen.included].sort(compareForPrompt);
    const omitted = chosen.omitted;
    const summaryTokens = Math.min(options.summaryTokens ?? Math.max(128, Math.floor(budget * 0.15)), Math.max(0, budget - totalTokens(included)));
    let summary: ContextSegment | undefined;
    let summarizedIds: string[] = [];

    if (omitted.length > 0 && options.summarizer && summaryTokens >= 64) {
      const content = (await options.summarizer({ segments: omitted.map(cloneSegment), maxTokens: summaryTokens })).trim();
      if (content) {
        summary = {
          id: `summary:${hashIds(omitted.map(segment => segment.id))}`,
          kind: 'summary',
          content,
          priority: Math.max(...omitted.map(segment => segment.priority), 0),
          pinned: false,
          source: 'context-compaction',
          estimatedTokens: estimateTokens(content),
          metadata: { summarizedIds: omitted.map(segment => segment.id) },
        };
        if (summary.estimatedTokens! <= summaryTokens && totalTokens(included) + summary.estimatedTokens! <= budget) {
          included.push(summary);
          summarizedIds = omitted.map(segment => segment.id);
        } else {
          summary = undefined;
        }
      }
    }

    const droppedIds = omitted
      .filter(segment => !summarizedIds.includes(segment.id))
      .map(segment => segment.id);
    const ordered = included.sort(compareForPrompt);
    return {
      schemaVersion: 1,
      budgetTokens: budget,
      usedTokens: totalTokens(ordered),
      segments: ordered.map(cloneSegment),
      includedIds: ordered.filter(segment => segment.kind !== 'summary').map(segment => segment.id),
      summarizedIds,
      droppedIds,
      stablePrefixHash: stablePrefixHash(ordered),
    };
  }

  private buildResult(
    segments: readonly ContextSegment[],
    options: Omit<ContextCompactionOptions, 'summarizer'>,
    _unused: undefined,
  ): ContextCompactionResult {
    validateOptions(options);
    const normalized = normalizeSegments(segments);
    const budget = options.maxTokens - (options.reservedTokens ?? 0);
    const pinned = normalized.filter(segment => segment.pinned);
    const pinnedTokens = totalTokens(pinned);
    if (pinnedTokens > budget) {
      throw new Error(`Pinned context requires ${pinnedTokens} tokens but only ${budget} are available.`);
    }
    const chosen = chooseSegments(normalized.filter(segment => !segment.pinned), budget - pinnedTokens);
    const ordered = [...pinned, ...chosen.included].sort(compareForPrompt);
    return {
      schemaVersion: 1,
      budgetTokens: budget,
      usedTokens: totalTokens(ordered),
      segments: ordered.map(cloneSegment),
      includedIds: ordered.map(segment => segment.id),
      summarizedIds: [],
      droppedIds: chosen.omitted.map(segment => segment.id),
      stablePrefixHash: stablePrefixHash(ordered),
    };
  }
}

function normalizeSegments(segments: readonly ContextSegment[]): ContextSegment[] {
  const seen = new Set<string>();
  return segments.map((segment, index) => {
    if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(segment.id)) throw new Error(`Invalid context segment id: ${segment.id}`);
    if (seen.has(segment.id)) throw new Error(`Duplicate context segment id: ${segment.id}`);
    seen.add(segment.id);
    if (!Number.isFinite(segment.priority)) throw new Error(`Invalid priority for context segment ${segment.id}.`);
    return {
      ...segment,
      content: segment.content.trim(),
      createdAt: segment.createdAt ?? new Date(index).toISOString(),
      estimatedTokens: segment.estimatedTokens ?? estimateTokens(segment.content),
      metadata: segment.metadata ? { ...segment.metadata } : undefined,
    };
  }).filter(segment => segment.content.length > 0);
}

function chooseSegments(segments: ContextSegment[], budget: number): { included: ContextSegment[]; omitted: ContextSegment[] } {
  const ranked = [...segments].sort((left, right) =>
    right.priority - left.priority ||
    recency(right.createdAt) - recency(left.createdAt) ||
    left.id.localeCompare(right.id));
  const included: ContextSegment[] = [];
  const omitted: ContextSegment[] = [];
  let used = 0;
  for (const segment of ranked) {
    const tokens = segment.estimatedTokens ?? estimateTokens(segment.content);
    if (used + tokens <= budget) {
      included.push(segment);
      used += tokens;
    } else {
      omitted.push(segment);
    }
  }
  return { included, omitted };
}

function compareForPrompt(left: ContextSegment, right: ContextSegment): number {
  const kindOrder: Record<ContextKind, number> = {
    system: 0,
    instruction: 1,
    plan: 2,
    approval: 3,
    failure: 4,
    memory: 5,
    code: 6,
    message: 7,
    tool: 8,
    summary: 9,
  };
  return kindOrder[left.kind] - kindOrder[right.kind] ||
    recency(left.createdAt) - recency(right.createdAt) ||
    left.id.localeCompare(right.id);
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4));
}

function totalTokens(segments: ContextSegment[]): number {
  return segments.reduce((sum, segment) => sum + (segment.estimatedTokens ?? estimateTokens(segment.content)), 0);
}

function stablePrefixHash(segments: ContextSegment[]): string {
  const stable = segments.filter(segment => segment.pinned || segment.kind === 'system' || segment.kind === 'instruction');
  return createHash('sha256')
    .update(stable.map(segment => `${segment.id}\0${segment.content}`).join('\n'))
    .digest('hex');
}

function hashIds(ids: string[]): string {
  return createHash('sha256').update(ids.sort().join('\n')).digest('hex').slice(0, 16);
}

function recency(value?: string): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function cloneSegment(segment: ContextSegment): ContextSegment {
  return { ...segment, metadata: segment.metadata ? { ...segment.metadata } : undefined };
}

function validateOptions(options: Omit<ContextCompactionOptions, 'summarizer'>): void {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 128) throw new Error('Context maxTokens must be an integer of at least 128.');
  const reserved = options.reservedTokens ?? 0;
  if (!Number.isInteger(reserved) || reserved < 0 || reserved >= options.maxTokens) throw new Error('Context reservedTokens is invalid.');
}
