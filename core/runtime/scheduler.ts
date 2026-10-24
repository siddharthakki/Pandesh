import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { latestRuntimeSequence, listRuntimeEventsAfter } from '../domain/runtimeEvents';
import { claimDueScheduledTasks, recordScheduledRun } from '../domain/scheduledTasks';
import { submitRequest } from '../domain/submission';
import type { EventBroadcaster } from '../ws/broadcaster';
import type { RuntimeExecutor } from './executor';
import { runDailyBriefRoutine } from './assistantRoutine';
import { DAILY_BRIEF_ROUTINE } from '../domain/assistantRoutine';
import { runIntelligenceScoutRoutine } from './scoutRoutine';
import { SCOUT_ROUTINE } from '../domain/scoutRoutine';
import type { IntelligenceScout } from './intelligenceScout';
import type { ConnectorAdapter } from './connectors/connectorCapability';
import type { ConnectorId } from '../shared/wireTypes';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';

const ACTOR = SCHEDULER_CLIENT_ID;

export interface ScheduledTaskLoopOptions {
  /** The connector registry, so a routine can read live calendar/email. */
  connectorRegistry?: Map<ConnectorId, ConnectorAdapter>;
  /** Working directory a routine's reads run in. */
  cwd?: string;
  /** The Intelligence Scout, so a watch can be checked by the scheduler itself. */
  scout?: IntelligenceScout;
}

/**
 * Fires due scheduled tasks as ordinary Core attempts in each task's own
 * conversation, so the result shows up in Panda (desktop and mobile) like any
 * other turn. Runs in Core, independent of which client is open.
 *
 * A task marked with a `routine` is not an instruction for the model: Core
 * executes it itself, deterministically, and delivers the result once per
 * occurrence (see `core/runtime/assistantRoutine.ts`).
 */
export function startScheduledTaskLoop(
  db: CoreDatabase,
  broadcaster: EventBroadcaster,
  executor: RuntimeExecutor,
  intervalMs = 30_000,
  options: ScheduledTaskLoopOptions = {},
): () => void {
  const tick = () => {
    let claimed: ReturnType<typeof claimDueScheduledTasks>;
    try {
      claimed = claimDueScheduledTasks(db);
    } catch (err) {
      console.error(`[karkedikha-core ${new Date().toISOString()}] scheduler claim failed:`, err instanceof Error ? err.message : err);
      return;
    }
    for (const { task, late } of claimed) {
      const before = latestRuntimeSequence(db);
      try {
        if (task.routine === DAILY_BRIEF_ROUTINE) {
          void runDailyBriefRoutine(db, broadcaster, {
            task,
            connectorRegistry: options.connectorRegistry,
            cwd: options.cwd,
          }).then((result) => {
            console.log(`[karkedikha-core ${new Date().toISOString()}] daily brief ${task.id} ${result.delivered ? 'delivered' : 'skipped'} (${result.reason})`);
          }).catch((err) => {
            console.error(`[karkedikha-core ${new Date().toISOString()}] daily brief ${task.id} failed:`, err instanceof Error ? err.message : err);
          });
          continue;
        }
        if (task.routine === SCOUT_ROUTINE) {
          if (!options.scout) {
            console.error(`[karkedikha-core ${new Date().toISOString()}] scout watch ${task.id} skipped: no Intelligence Scout is registered`);
            continue;
          }
          void runIntelligenceScoutRoutine(db, broadcaster, { task, scout: options.scout })
            .then((result) => {
              console.log(`[karkedikha-core ${new Date().toISOString()}] scout watch ${task.id} ${result.delivered ? 'delivered' : 'skipped'} (${result.reason})`);
            })
            .catch((err) => {
              console.error(`[karkedikha-core ${new Date().toISOString()}] scout watch ${task.id} failed:`, err instanceof Error ? err.message : err);
            });
          continue;
        }
        const conversationId = task.conversationId
          ?? createConversation(db, { mode: 'saath_kar', title: task.title, actor: ACTOR }).id;
        const model = task.model ?? executor.contextDefaults().selectedModel;
        const key = `sched:${task.id}:${Date.now()}`;
        const result = submitRequest(db, {
          clientId: ACTOR,
          currentMessage: `[Scheduled task "${task.title}"${late ? ', running late because KarkeDikha was not running at the scheduled time' : ''}] ${task.instruction}`,
          requestedMode: 'saath_kar',
          conversationId,
          requestedProvider: 'ollama',
          requestedModel: model,
          selectedProvider: 'ollama',
          selectedModel: model,
          effectiveAllowedTools: [],
          toolPermissionPolicy: {},
          capability: { hasWorkspace: false, gitCapable: false },
          correlationId: key,
          idempotencyKey: key,
        });
        recordScheduledRun(db, task.id, { attemptId: result.attempt.id, conversationId });
        console.log(`[karkedikha-core ${new Date().toISOString()}] scheduled task ${task.id} fired attempt=${result.attempt.id}`);
        void executor.execute(result.attempt.id).catch(() => { /* terminal failure is durably recorded */ });
      } catch (err) {
        console.error(`[karkedikha-core ${new Date().toISOString()}] scheduled task ${task.id} failed to submit:`, err instanceof Error ? err.message : err);
      } finally {
        for (const event of listRuntimeEventsAfter(db, before, 200)) broadcaster.publishRuntime(event);
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return () => clearInterval(timer);
}
