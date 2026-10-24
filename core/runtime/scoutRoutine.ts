/**
 * The Intelligence Scout routine — a watch that fires on its own schedule.
 *
 * The routine is deterministic and Core-owned: it runs the watch, compares
 * what it finds with what the watch last saw, and delivers *one* message when
 * — and only when — something actually changed. It never opens an agent
 * attempt, so a watch costs no model call and no GPU time.
 *
 * Delivery is exactly once per occurrence. The occurrence is claimed in
 * `routine_deliveries` (the (routine, occurrence) primary key is the
 * primitive) before anything is written; a delivery that never happened
 * gives the claim back, so the ledger always says the truth.
 */
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { appendMessage, createConversation } from '../domain/conversations';
import {
  claimRoutineDelivery,
  completeRoutineDelivery,
  releaseRoutineDelivery,
} from '../domain/assistantRoutine';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { nowIso } from '../domain/ids';
import type { ScheduledTaskRecord } from '../domain/scheduledTasks';
import { parseScoutWatchId } from '../domain/scoutRoutine';
import type { IntelligenceScout } from './intelligenceScout';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';

const ACTOR = 'kkd:scout_routine';
const CLIENT_ID = SCHEDULER_CLIENT_ID;

export interface ScoutRoutineRunResult {
  delivered: boolean;
  reason: string;
  conversationId: string | null;
  messageId: string | null;
  occurrenceKey: string;
  changed: boolean;
  baseline: boolean;
}

function renderFinding(input: {
  watchName: string;
  target: string;
  kind: string;
  baseline: boolean;
  message: string;
  finding: { source: string; title: string; url: string; publishedAt: string | null; summary: string } | null;
}): string {
  const heading = input.baseline
    ? `### Watching ${input.watchName}`
    : `### ${input.watchName} changed`;
  const lines = [heading, '', input.message];
  if (input.finding) {
    lines.push('', `**Source:** ${input.finding.source}`, `**Link:** ${input.finding.url}`);
    if (input.finding.publishedAt) lines.push(`**Published:** ${input.finding.publishedAt}`);
    if (input.finding.summary) lines.push('', input.finding.summary);
  }
  lines.push('', `_Watch target: ${input.target} (${input.kind})_`);
  return lines.join('\n');
}

/**
 * Runs one occurrence of a watch.
 *
 * The occurrence is claimed before anything is written. If the claim is lost
 * (the same occurrence was already claimed), nothing is delivered — that is
 * the duplicate guard. A delivery that fails gives the claim back, so the
 * ledger never claims a delivery that did not happen.
 */
export async function runIntelligenceScoutRoutine(
  db: CoreDatabase,
  broadcaster: EventBroadcaster,
  input: {
    task: ScheduledTaskRecord;
    scout: IntelligenceScout;
    nowMs?: number;
  },
): Promise<ScoutRoutineRunResult> {
  const task = input.task;
  const watchId = parseScoutWatchId(task.instruction);
  const occurrenceKey = `${task.id}@${task.nextRunAt}`;
  if (!watchId) {
    return {
      delivered: false, reason: 'this schedule is not bound to a watch', conversationId: null,
      messageId: null, occurrenceKey, changed: false, baseline: false,
    };
  }
  if (!claimRoutineDelivery(db, task.id, occurrenceKey)) {
    return {
      delivered: false, reason: 'this occurrence was already delivered', conversationId: null,
      messageId: null, occurrenceKey, changed: false, baseline: false,
    };
  }

  const watch = input.scout.listWatches().find((candidate) => candidate.id === watchId);
  if (!watch) {
    releaseRoutineDelivery(db, task.id, occurrenceKey);
    return {
      delivered: false, reason: 'the watch no longer exists', conversationId: null,
      messageId: null, occurrenceKey, changed: false, baseline: false,
    };
  }
  if (watch.paused) {
    releaseRoutineDelivery(db, task.id, occurrenceKey);
    return {
      delivered: false, reason: 'the watch is paused', conversationId: null,
      messageId: null, occurrenceKey, changed: false, baseline: false,
    };
  }

  try {
    // The first observation establishes the baseline: it is reported as
    // "this is what I am watching", never as a change that did not happen.
    const baseline = !watch.lastCheckedAt;
    const result = await input.scout.runWatch(watchId);
    if (!result.changed && !baseline) {
      // Nothing changed: no message, and the claim goes back so the ledger
      // says "not delivered" instead of holding a reservation for nothing.
      releaseRoutineDelivery(db, task.id, occurrenceKey);
      const event = recordRuntimeEvent(db, {
        domain: 'scout_routine',
        entityId: task.id,
        eventType: 'scout_watch_unchanged',
        actor: ACTOR,
        clientId: CLIENT_ID,
        idempotencyKey: `scout:${occurrenceKey}`,
        metadata: { occurrenceKey, watchId, watchName: watch.name, message: result.message },
      });
      broadcaster.publishRuntime(event);
      return {
        delivered: false, reason: 'no change', conversationId: null, messageId: null,
        occurrenceKey, changed: false, baseline,
      };
    }

    const markdown = renderFinding({
      watchName: watch.name,
      target: watch.target,
      kind: watch.kind,
      baseline,
      message: baseline
        ? `Watching ${watch.target}. Current state: ${result.message}`
        : result.message,
      finding: result.finding,
    });

    const conversationId = task.conversationId
      ?? createConversation(db, { mode: 'saath_kar', title: `Scout: ${watch.name}`, actor: ACTOR }).id;
    const message = appendMessage(db, conversationId, {
      role: 'assistant',
      content: markdown,
      actor: ACTOR,
      clientId: CLIENT_ID,
    });
    completeRoutineDelivery(db, task.id, occurrenceKey, { conversationId, messageId: message.id });
    db.run('UPDATE scheduled_tasks SET conversationId = ?, lastRunAt = ?, updatedAt = ? WHERE id = ?', [
      conversationId, nowIso(), nowIso(), task.id,
    ]);

    const event = recordRuntimeEvent(db, {
      domain: 'scout_routine',
      entityId: task.id,
      eventType: baseline ? 'scout_watch_baseline' : 'scout_watch_changed',
      actor: ACTOR,
      clientId: CLIENT_ID,
      idempotencyKey: `scout:${occurrenceKey}`,
      metadata: {
        occurrenceKey,
        watchId,
        watchName: watch.name,
        conversationId,
        messageId: message.id,
        title: baseline ? `Watching ${watch.name}` : `${watch.name} changed`,
        body: result.message,
      },
    });
    broadcaster.publishRuntime(event);

    return {
      delivered: true, reason: baseline ? 'baseline' : 'delivered', conversationId,
      messageId: message.id, occurrenceKey, changed: result.changed, baseline,
    };
  } catch (err) {
    releaseRoutineDelivery(db, task.id, occurrenceKey);
    throw err;
  }
}
