/**
 * Runs Pandesh's daily brief routine.
 *
 * The routine is deterministic: it reads Core's own state (and the live
 * calendar/email when they are connected), writes one message into its own
 * conversation, and records the delivery. It never opens an agent attempt, so
 * a daily brief costs no model call and no GPU time.
 *
 * It is also strictly once per occurrence: the caller claims the occurrence in
 * `routine_deliveries` before anything is written, and the database's primary
 * key refuses a second claim.
 */
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { appendMessage, createConversation } from '../domain/conversations';
import {
  claimRoutineDelivery,
  completeRoutineDelivery,
  dailyBriefOccurrenceKey,
  releaseRoutineDelivery,
} from '../domain/assistantRoutine';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { nowIso } from '../domain/ids';
import type { ScheduledTaskRecord } from '../domain/scheduledTasks';
import { buildAssistantBrief, readConnector } from './assistantBrief';
import { buildDailyBriefing, renderDailyBriefing, type BriefingReader } from './dailyBriefing';
import type { ConnectorAdapter } from './connectors/connectorCapability';
import type { ConnectorId } from '../shared/wireTypes';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';

const ACTOR = 'kkd:assistant_routine';
const CLIENT_ID = SCHEDULER_CLIENT_ID;
/** The briefing reads a handful of mail and calendar calls; this bounds the whole fan-out. */
const BRIEFING_READ_TIMEOUT_MS = 30_000;

/** Keeps the routine's conversation on the schedule row, so later briefs land
 * in the same thread and stay discoverable from the conversation rail. */
function linkRoutineConversation(db: CoreDatabase, routineId: string, conversationId: string): void {
  db.run('UPDATE scheduled_tasks SET conversationId = ?, updatedAt = ? WHERE id = ?', [
    conversationId, nowIso(), routineId,
  ]);
}

export interface DailyBriefRunResult {
  delivered: boolean;
  reason: string;
  conversationId: string | null;
  messageId: string | null;
  occurrenceKey: string;
}

/**
 * Delivers one occurrence of the daily brief.
 *
 * The occurrence is claimed before anything is written. If the claim is lost
 * (the same occurrence was already claimed), nothing is delivered and nothing
 * is notified — that is the duplicate guard.
 *
 * If the delivery itself fails, the claim is given back: the ledger then says
 * "not delivered" rather than holding a reservation for work that never
 * happened. A delivered occurrence is never released, so it can never be
 * delivered — or notified — twice.
 */
export async function runDailyBriefRoutine(
  db: CoreDatabase,
  broadcaster: EventBroadcaster,
  input: {
    task: ScheduledTaskRecord;
    connectorRegistry?: Map<ConnectorId, ConnectorAdapter>;
    cwd?: string;
    nowMs?: number;
  },
): Promise<DailyBriefRunResult> {
  const task = input.task;
  const occurrenceKey = dailyBriefOccurrenceKey(task.id, task.nextRunAt);
  if (!claimRoutineDelivery(db, task.id, occurrenceKey)) {
    return {
      delivered: false,
      reason: 'this occurrence was already delivered',
      conversationId: null,
      messageId: null,
      occurrenceKey,
    };
  }

  try {
    const nowMs = input.nowMs ?? Date.now();
    // Home items and service status come from the Core-only brief; the message itself is the
    // triaged briefing, which reads calendar and mail through the same permission gate.
    const brief = await buildAssistantBrief(db, { connectorRegistry: input.connectorRegistry, nowMs, includeExternal: false });
    const adapters = input.connectorRegistry ?? new Map();
    const cwd = input.cwd ?? process.cwd();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIEFING_READ_TIMEOUT_MS);
    let markdown: string;
    try {
      const read: BriefingReader = async (toolName, args) => {
        const result = await readConnector(db, adapters, toolName === 'gmail_search' ? 'gmail' : 'google_calendar', toolName, args, cwd, controller.signal);
        return result.ok ? { ok: true, data: result.data } : { ok: false, reason: result.reason ?? 'the service could not be read' };
      };
      markdown = renderDailyBriefing(await buildDailyBriefing(db, { nowMs, timeZone: brief.timezone, read }));
    } finally {
      clearTimeout(timer);
    }

    const conversationId = task.conversationId
      ?? createConversation(db, { mode: 'saath_kar', title: 'Daily brief', actor: ACTOR }).id;
    const message = appendMessage(db, conversationId, {
      role: 'assistant',
      content: markdown,
      actor: ACTOR,
      clientId: CLIENT_ID,
    });
    completeRoutineDelivery(db, task.id, occurrenceKey, {
      conversationId,
      messageId: message.id,
    });
    linkRoutineConversation(db, task.id, conversationId);

    // The routine's own clock: the moment the brief was actually delivered,
    // which is what the operator reads as "last brief". The scheduler's claim
    // time is not the same thing, and Core records the delivery time here.
    const deliveredAt = nowIso();
    db.run('UPDATE scheduled_tasks SET lastRunAt = ?, updatedAt = ? WHERE id = ?', [
      deliveredAt, deliveredAt, task.id,
    ]);

    const event = recordRuntimeEvent(db, {
      domain: 'assistant_routine',
      entityId: task.id,
      eventType: 'daily_brief_delivered',
      actor: ACTOR,
      clientId: CLIENT_ID,
      idempotencyKey: `daily_brief:${occurrenceKey}`,
      metadata: {
        occurrenceKey,
        conversationId,
        messageId: message.id,
        deliveredAt,
        generatedAt: brief.generatedAt,
        title: 'Your daily brief is ready',
        body: brief.home.length
          ? `${brief.home.length} item${brief.home.length === 1 ? '' : 's'} need attention.`
          : 'Nothing needs attention right now.',
      },
    });
    broadcaster.publishRuntime(event);

    return {
      delivered: true,
      reason: 'delivered',
      conversationId,
      messageId: message.id,
      occurrenceKey,
    };
  } catch (err) {
    // Nothing was delivered, so the claim is given back. The occurrence is
    // still spent (the scheduler already advanced the schedule), but the ledger
    // no longer claims a delivery that never happened.
    releaseRoutineDelivery(db, task.id, occurrenceKey);
    throw err;
  }
}
