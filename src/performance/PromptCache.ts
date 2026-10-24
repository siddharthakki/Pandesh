import { createHash } from 'crypto';

export interface PromptCacheEntry<T> {
  key: string;
  value: T;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt?: string;
  sizeBytes: number;
  hits: number;
}

export interface PromptCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  defaultTtlMs?: number;
}

export class PromptCache<T> {
  private readonly entries = new Map<string, PromptCacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly defaultTtlMs?: number;
  private bytes = 0;

  constructor(options: PromptCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.defaultTtlMs = options.defaultTtlMs;
  }

  static key(parts: readonly unknown[]): string {
    return createHash('sha256').update(stableStringify(parts)).digest('hex');
  }

  get(key: string, now = new Date()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= now.getTime()) {
      this.delete(key);
      return undefined;
    }
    entry.lastAccessedAt = now.toISOString();
    entry.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return clone(entry.value);
  }

  set(key: string, value: T, options: { ttlMs?: number; sizeBytes?: number } = {}): PromptCacheEntry<T> {
    if (!/^[a-f0-9]{32,128}$/i.test(key)) throw new Error('Prompt cache key must be a hexadecimal digest.');
    const serialized = JSON.stringify(value);
    const sizeBytes = options.sizeBytes ?? Buffer.byteLength(serialized, 'utf8');
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > this.maxBytes) {
      throw new Error('Prompt cache entry size is invalid.');
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.sizeBytes;
      this.entries.delete(key);
    }
    const now = new Date();
    const ttl = options.ttlMs ?? this.defaultTtlMs;
    const entry: PromptCacheEntry<T> = {
      key,
      value: clone(value),
      createdAt: now.toISOString(),
      lastAccessedAt: now.toISOString(),
      expiresAt: ttl !== undefined ? new Date(now.getTime() + ttl).toISOString() : undefined,
      sizeBytes,
      hits: 0,
    };
    this.entries.set(key, entry);
    this.bytes += sizeBytes;
    this.evict();
    return clone(entry);
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.sizeBytes;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  snapshot(): { entries: number; bytes: number; items: PromptCacheEntry<T>[] } {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      items: [...this.entries.values()].map(clone),
    };
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.delete(oldestKey);
    }
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
