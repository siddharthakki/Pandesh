import { randomUUID } from 'crypto';
import { MemoryRecord, MemoryScope, MemorySearchRequest, MemorySearchResult, MemorySensitivity } from './MemoryTypes';

export interface KnowledgeLedgerStorage {
  load(): Promise<MemoryRecord[]>;
  save(records: MemoryRecord[]): Promise<void>;
}

export interface KnowledgeLedgerOptions {
  enabled: boolean;
  storage: KnowledgeLedgerStorage;
  sanitize?: (value: string, sensitivity: MemorySensitivity) => string;
  maxRecords?: number;
  maxAuditEvents?: number;
}

export type KnowledgeAuditAction = 'initialize' | 'add' | 'read' | 'search' | 'update' | 'remove' | 'remove-scope' | 'expire' | 'export';

export interface KnowledgeAuditEvent {
  id: string;
  timestamp: string;
  action: KnowledgeAuditAction;
  recordId?: string;
  scope?: MemoryScope;
  detail?: Record<string, unknown>;
}

export class KnowledgeLedger {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly auditEvents: KnowledgeAuditEvent[] = [];
  private readonly maxRecords: number;
  private readonly maxAuditEvents: number;

  constructor(private readonly options: KnowledgeLedgerOptions) {
    this.maxRecords = options.maxRecords ?? 10_000;
    this.maxAuditEvents = options.maxAuditEvents ?? 10_000;
  }

  async initialize(): Promise<void> {
    this.records.clear();
    if (!this.options.enabled) return;
    for (const record of await this.options.storage.load()) {
      validate(record);
      this.records.set(record.id, clone(record));
    }
    this.audit('initialize', { detail: { records: this.records.size } });
  }

  async add(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    this.assertEnabled();
    if (this.records.size >= this.maxRecords) throw new Error('Knowledge ledger capacity reached.');
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      ...input,
      id: randomUUID(),
      key: input.key.trim(),
      value: this.sanitize(input.value.trim(), input.sensitivity),
      tags: [...new Set(input.tags)].sort(),
      provenance: { ...input.provenance },
      supersedes: [...new Set(input.supersedes ?? [])],
      createdAt: now,
      updatedAt: now,
    };
    validate(record);
    for (const id of record.supersedes ?? []) {
      if (!this.records.has(id)) throw new Error(`Unknown superseded record: ${id}`);
    }
    this.records.set(record.id, record);
    await this.persist();
    this.audit('add', { recordId: record.id, scope: record.scope, detail: { key: record.key } });
    return clone(record);
  }

  get(id: string): MemoryRecord | undefined {
    this.assertEnabled();
    const record = this.records.get(id);
    this.audit('read', { recordId: id, scope: record?.scope, detail: { found: Boolean(record) } });
    return record ? clone(record) : undefined;
  }

  search(request: MemorySearchRequest): MemorySearchResult[] {
    this.assertEnabled();
    const now = Date.parse(request.now ?? new Date().toISOString());
    const scopes = new Set(request.scopes ?? ['user', 'project', 'repository', 'task', 'agent', 'operational']);
    const tags = new Set((request.tags ?? []).map(tag => tag.toLowerCase()));
    const maximum = rank(request.maximumSensitivity ?? 'restricted');
    const terms = tokenize(request.query);
    const superseded = new Set([...this.records.values()].flatMap(record => record.supersedes ?? []));
    const results = [...this.records.values()]
      .filter(record => scopes.has(record.scope))
      .filter(record => rank(record.sensitivity) <= maximum)
      .filter(record => record.pinned || !record.expiresAt || Date.parse(record.expiresAt) > now)
      .filter(record => !superseded.has(record.id))
      .filter(record => [...tags].every(tag => record.tags.map(value => value.toLowerCase()).includes(tag)))
      .map(record => ({ record, score: score(record, terms) }))
      .filter(result => result.score > 0 || terms.length === 0)
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
      .slice(0, Math.max(1, Math.min(request.limit ?? 20, 200)))
      .map(result => ({ score: result.score, record: clone(result.record) }));
    this.audit('search', {
      detail: {
        scopes: [...scopes],
        tags: [...tags],
        maximumSensitivity: request.maximumSensitivity ?? 'restricted',
        resultCount: results.length,
      },
    });
    return results;
  }

  async update(
    id: string,
    changes: Partial<Pick<MemoryRecord, 'key' | 'value' | 'tags' | 'confidence' | 'sensitivity' | 'expiresAt' | 'pinned'>>,
  ): Promise<MemoryRecord> {
    this.assertEnabled();
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown knowledge record: ${id}`);
    if (changes.key !== undefined) record.key = changes.key.trim();
    if (changes.value !== undefined) record.value = this.sanitize(changes.value.trim(), changes.sensitivity ?? record.sensitivity);
    if (changes.tags !== undefined) record.tags = [...new Set(changes.tags)].sort();
    if (changes.confidence !== undefined) record.confidence = changes.confidence;
    if (changes.sensitivity !== undefined) record.sensitivity = changes.sensitivity;
    if (changes.expiresAt !== undefined) record.expiresAt = changes.expiresAt;
    if (changes.pinned !== undefined) record.pinned = changes.pinned;
    record.updatedAt = new Date().toISOString();
    validate(record);
    await this.persist();
    this.audit('update', { recordId: id, scope: record.scope, detail: { fields: Object.keys(changes).sort() } });
    return clone(record);
  }

  async remove(id: string): Promise<boolean> {
    this.assertEnabled();
    const existing = this.records.get(id);
    if (!existing) return false;

    const removalIds = this.supersessionClosure(id);
    for (const removalId of removalIds) this.records.delete(removalId);
    await this.persist();
    this.audit('remove', {
      recordId: id,
      scope: existing.scope,
      detail: { removedIds: removalIds },
    });
    return true;
  }

  async removeScope(scope: MemoryScope): Promise<number> {
    this.assertEnabled();
    let count = 0;
    for (const [id, record] of this.records) {
      if (record.scope === scope) {
        this.records.delete(id);
        count += 1;
      }
    }
    if (count > 0) await this.persist();
    this.audit('remove-scope', { scope, detail: { count } });
    return count;
  }

  async expire(now = new Date()): Promise<number> {
    this.assertEnabled();
    let count = 0;
    for (const [id, record] of this.records) {
      if (!record.pinned && record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) {
        this.records.delete(id);
        count += 1;
      }
    }
    if (count > 0) await this.persist();
    this.audit('expire', { detail: { count, now: now.toISOString() } });
    return count;
  }

  export(maximumSensitivity: MemorySensitivity = 'internal'): MemoryRecord[] {
    this.assertEnabled();
    const maximum = rank(maximumSensitivity);
    const values = [...this.records.values()]
      .filter(record => rank(record.sensitivity) <= maximum)
      .map(clone)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.audit('export', { detail: { maximumSensitivity, count: values.length } });
    return values;
  }

  conflicts(scope: MemoryScope, key: string): MemoryRecord[] {
    this.assertEnabled();
    return [...this.records.values()]
      .filter(record => record.scope === scope && record.key.toLowerCase() === key.toLowerCase())
      .map(clone)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  auditTrail(limit = 500): KnowledgeAuditEvent[] {
    this.assertEnabled();
    const safeLimit = Math.max(1, Math.min(limit, this.maxAuditEvents));
    return this.auditEvents.slice(-safeLimit).map(clone);
  }

  private supersessionClosure(id: string): string[] {
    const output: string[] = [];
    const pending = [id];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const record = this.records.get(current);
      if (!record) continue;
      output.push(current);
      pending.push(...(record.supersedes ?? []));
    }
    return output;
  }

  private sanitize(value: string, sensitivity: MemorySensitivity): string {
    const redacted = defaultSanitize(value);
    return this.options.sanitize ? this.options.sanitize(redacted, sensitivity) : redacted;
  }

  private async persist(): Promise<void> {
    await this.options.storage.save(
      [...this.records.values()].map(clone).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  private audit(
    action: KnowledgeAuditAction,
    values: Omit<KnowledgeAuditEvent, 'id' | 'timestamp' | 'action'> = {},
  ): void {
    this.auditEvents.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      ...clone(values),
    });
    while (this.auditEvents.length > this.maxAuditEvents) this.auditEvents.shift();
  }

  private assertEnabled(): void {
    if (!this.options.enabled) throw new Error('Knowledge ledger is disabled.');
  }
}

function validate(record: MemoryRecord): void {
  if (!record.id || !record.key.trim() || !record.value.trim()) throw new Error('Knowledge record is incomplete.');
  if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) throw new Error('Knowledge confidence must be between 0 and 1.');
  if (record.expiresAt && !Number.isFinite(Date.parse(record.expiresAt))) throw new Error('Knowledge expiry is invalid.');
}

function score(record: MemoryRecord, terms: string[]): number {
  const text = `${record.key} ${record.value} ${record.tags.join(' ')}`.toLowerCase();
  return terms.reduce((value, term) => value + (text.includes(term) ? 10 : 0), 0) + record.confidence * 5 + (record.pinned ? 5 : 0);
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_.-]+/).filter(term => term.length > 1))];
}

function rank(value: MemorySensitivity): number {
  return value === 'public' ? 0 : value === 'internal' ? 1 : value === 'confidential' ? 2 : 3;
}

function defaultSanitize(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/ig, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)\s*[:=]\s*)([^\s,;]+)/ig, '$1[REDACTED]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
