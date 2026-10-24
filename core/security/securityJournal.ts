/**
 * M54-A0 Security Event Journal.
 *
 * Persists structured, immutable security audit records.
 * Redacts tokens, passwords, and secret key blocks before persistence.
 */

import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import type { SecurityEventRecord, SecurityEventType } from './types';

const MAX_IN_MEMORY_EVENTS = 200;

const SECRET_VALUE_PATTERNS = [
  /(?:gh[pousr]_[A-Za-z0-9_]{16,})/gi,
  /(?:sk-[A-Za-z0-9_-]{20,})/gi,
  /(?:kdk-[A-Za-z0-9_-]{16,})/gi,
  /(?:Bearer\s+[A-Za-z0-9_.-]{16,})/gi,
  /(-{5}BEGIN[A-Z\s_-]*KEY-{5}[\s\S]*?-{5}END[A-Z\s_-]*KEY-{5})/gi,
];

const HAS_POTENTIAL_SECRET = /(?:gh[pousr]_|sk-|kdk-|Bearer|API_KEY|TOKEN|PASSWORD|SECRET|BEGIN)/i;

/**
 * Recursively redacts sensitive keys and values from an event payload.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!HAS_POTENTIAL_SECRET.test(value)) {
      return value;
    }
    let sanitized = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED_SECRET]');
    }
    return sanitized;
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|passwd|key|auth|credential/i.test(k)) {
        result[k] = '[REDACTED_SECRET]';
      } else {
        result[k] = redactSecrets(v);
      }
    }
    return result;
  }
  return value;
}

export class SecurityJournal {
  private readonly inMemoryEvents: SecurityEventRecord[] = [];
  private readonly epoch: string;

  constructor(
    private readonly db?: CoreDatabase | null,
    epoch?: string,
  ) {
    this.epoch = epoch ?? `epoch_${Date.now()}`;
  }

  public getEpoch(): string {
    return this.epoch;
  }

  /**
   * Persists a structured security event.
   */
  public record(event: {
    eventType: SecurityEventType;
    requestId?: string | null;
    actionId?: string | null;
    attemptId?: string | null;
    objectiveId?: string | null;
    executor?: string | null;
    capability?: string | null;
    targetResource?: string | null;
    riskLevel?: string | null;
    payload?: Record<string, unknown>;
  }): SecurityEventRecord {
    const id = `sec_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const redactedPayload = (redactSecrets(event.payload ?? {}) as Record<string, unknown>) ?? {};

    const record: SecurityEventRecord = {
      id,
      eventType: event.eventType,
      requestId: event.requestId ?? null,
      actionId: event.actionId ?? null,
      attemptId: event.attemptId ?? null,
      objectiveId: event.objectiveId ?? null,
      executor: event.executor ?? 'core:security_kernel',
      capability: event.capability ?? null,
      targetResource: event.targetResource ? String(redactSecrets(event.targetResource)) : null,
      riskLevel: event.riskLevel ?? null,
      payload: redactedPayload,
      createdAt,
    };

    // Retain in memory buffer
    this.inMemoryEvents.push(record);
    if (this.inMemoryEvents.length > MAX_IN_MEMORY_EVENTS) {
      this.inMemoryEvents.shift();
    }

    // Persist to database if available
    if (this.db) {
      try {
        this.db.run(
          `INSERT INTO security_events (
            id, eventType, requestId, actionId, attemptId, objectiveId,
            executor, capability, targetResource, riskLevel, payload, createdAt, epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.eventType,
            record.requestId,
            record.actionId,
            record.attemptId,
            record.objectiveId,
            record.executor,
            record.capability,
            record.targetResource,
            record.riskLevel,
            JSON.stringify(record.payload),
            record.createdAt,
            this.epoch,
          ],
        );
      } catch (err) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`Security state write failure: failed to persist security journal event: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return record;
  }

  public listEvents(filter?: { attemptId?: string; eventType?: SecurityEventType }): readonly SecurityEventRecord[] {
    const events = this.getRecentEvents(200);
    if (!filter) return events;
    return events.filter((e) => {
      if (filter.attemptId && e.attemptId !== filter.attemptId) return false;
      if (filter.eventType && e.eventType !== filter.eventType) return false;
      return true;
    });
  }

  public getRecentEvents(limit = 50): readonly SecurityEventRecord[] {
    if (this.db) {
      try {
        const rows = this.db.all<{
          id: string;
          eventType: string;
          requestId: string | null;
          actionId: string | null;
          attemptId: string | null;
          objectiveId: string | null;
          executor: string;
          capability: string | null;
          targetResource: string | null;
          riskLevel: string | null;
          payload: string;
          createdAt: string;
        }>(
          `SELECT id, eventType, requestId, actionId, attemptId, objectiveId,
                  executor, capability, targetResource, riskLevel, payload, createdAt
           FROM security_events
           ORDER BY createdAt DESC
           LIMIT ?`,
          [limit],
        );

        return rows.map((r) => ({
          id: r.id,
          eventType: r.eventType as SecurityEventType,
          requestId: r.requestId,
          actionId: r.actionId,
          attemptId: r.attemptId,
          objectiveId: r.objectiveId,
          executor: r.executor,
          capability: r.capability,
          targetResource: r.targetResource,
          riskLevel: r.riskLevel,
          payload: JSON.parse(r.payload),
          createdAt: r.createdAt,
        }));
      } catch {
        // Fall back to memory buffer if table not yet migrated
      }
    }
    return this.inMemoryEvents.slice(-limit).reverse();
  }
}
