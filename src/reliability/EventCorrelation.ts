import { createHash, randomUUID } from 'crypto';

export interface CorrelatedEvent {
  id: string;
  traceId: string;
  taskId?: string;
  category: 'model' | 'tool' | 'process' | 'test' | 'diagnostic' | 'change' | 'validation' | 'feedback';
  timestamp: string;
  outcome: 'started' | 'passed' | 'failed' | 'completed' | 'cancelled' | 'observed';
  summary: string;
  files: string[];
  durationMs?: number;
  detail?: string;
}

export interface EventCluster {
  signature: string;
  count: number;
  eventIds: string[];
  taskIds: string[];
  files: string[];
  firstSeen: string;
  lastSeen: string;
  representative: string;
}

export interface CorrelationCandidate {
  rank: number;
  score: number;
  eventId: string;
  summary: string;
  reasons: string[];
}

export class EventCorrelation {
  private readonly events: CorrelatedEvent[] = [];

  constructor(private readonly capacity = 50_000) {
    if (!Number.isInteger(capacity) || capacity < 100) throw new Error('Event capacity is invalid.');
  }

  add(input: Omit<CorrelatedEvent, 'id' | 'timestamp' | 'files'> & {
    id?: string;
    timestamp?: string;
    files?: string[];
  }): CorrelatedEvent {
    const event: CorrelatedEvent = {
      ...input,
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      summary: input.summary.slice(0, 4000),
      detail: input.detail?.slice(0, 20_000),
      files: [...new Set((input.files ?? []).map(value => value.replace(/\\/g, '/')))].sort(),
    };
    if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(event.traceId)) throw new Error('Trace id is invalid.');
    if (this.events.some(existing => existing.id === event.id)) throw new Error(`Duplicate event: ${event.id}`);
    this.events.push(event);
    while (this.events.length > this.capacity) this.events.shift();
    return clone(event);
  }

  trace(traceId: string): CorrelatedEvent[] {
    return this.events
      .filter(event => event.traceId === traceId)
      .map(clone)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  clusters(): EventCluster[] {
    const output = new Map<string, EventCluster>();
    for (const event of this.events.filter(item => item.outcome === 'failed')) {
      const representative = event.detail ?? event.summary;
      const signature = createHash('sha256').update(normalize(representative)).digest('hex').slice(0, 24);
      const current = output.get(signature);
      if (current) {
        current.count += 1;
        current.eventIds.push(event.id);
        if (event.taskId) current.taskIds.push(event.taskId);
        current.files.push(...event.files);
        if (event.timestamp < current.firstSeen) current.firstSeen = event.timestamp;
        if (event.timestamp > current.lastSeen) current.lastSeen = event.timestamp;
      } else {
        output.set(signature, {
          signature,
          count: 1,
          eventIds: [event.id],
          taskIds: event.taskId ? [event.taskId] : [],
          files: [...event.files],
          firstSeen: event.timestamp,
          lastSeen: event.timestamp,
          representative,
        });
      }
    }
    return [...output.values()]
      .map(cluster => ({
        ...cluster,
        eventIds: [...new Set(cluster.eventIds)],
        taskIds: [...new Set(cluster.taskIds)].sort(),
        files: [...new Set(cluster.files)].sort(),
      }))
      .sort((left, right) => right.count - left.count || right.lastSeen.localeCompare(left.lastSeen));
  }

  candidates(traceId: string, limit = 10): CorrelationCandidate[] {
    const events = this.trace(traceId);
    const failureIndex = lastFailureIndex(events);
    if (failureIndex < 0) return [];
    const failure = events[failureIndex];
    const candidates: CorrelationCandidate[] = [];
    for (let index = 0; index < failureIndex; index += 1) {
      const event = events[index];
      let score = Math.max(0, 30 - (failureIndex - index));
      const reasons: string[] = [];
      if (event.category === 'change') { score += 25; reasons.push('change preceded failure'); }
      if (event.category === 'tool' || event.category === 'process') { score += 10; reasons.push('execution preceded failure'); }
      if (event.outcome === 'failed') { score += 20; reasons.push('earlier failure in trace'); }
      const shared = event.files.filter(file => failure.files.includes(file));
      if (shared.length > 0) { score += shared.length * 10; reasons.push(`shared files: ${shared.join(', ')}`); }
      if (score > 0) candidates.push({ rank: 0, score, eventId: event.id, summary: event.summary, reasons });
    }
    return candidates
      .sort((left, right) => right.score - left.score || left.eventId.localeCompare(right.eventId))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[a-f0-9]{7,40}/g, '<hash>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastFailureIndex(events: CorrelatedEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].outcome === 'failed') return index;
  }
  return -1;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
