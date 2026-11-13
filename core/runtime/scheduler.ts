import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { latestRuntimeSequence, listRuntimeEventsAfter } from '../domain/runtimeEvents';
import { claimDueScheduledTasks, recordScheduledRun } from '../domain/scheduledTasks';
import { submitRequest } from '../domain/submission';
import { enqueueNotification } from '../domain/notificationOutbox';
import { deriveResultStatus } from '../domain/resultStatus';
import * as fs from 'node:fs';
import type { EventBroadcaster } from '../ws/broadcaster';
import type { RuntimeExecutor } from './executor';
import { runDailyBriefRoutine } from './assistantRoutine';
import { DAILY_BRIEF_ROUTINE } from '../domain/assistantRoutine';
import { runIntelligenceScoutRoutine } from './scoutRoutine';
import { SCOUT_ROUTINE } from '../domain/scoutRoutine';
import { WATCHDOG_ROUTINE } from '../domain/watchdogRoutine';
import { runReliabilityWatchdogRoutine } from './watchdogRoutine';
import { AI_RADAR_ROUTINE, runAiRadarRoutine } from './aiRadarRoutine';
import { FREE_MODEL_ROUTINE, runFreeModelRoutine } from './freeModelRegistryRoutine';
import type { IntelligenceScout } from './intelligenceScout';
import type { ConnectorAdapter } from './connectors/connectorCapability';
import type { ConnectorId } from '../shared/wireTypes';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';
import { HOUSEHOLD_ROUTINES, recordMissedRun, settleInterruptedRuns } from '../domain/householdRoutines';
import { runHouseholdRoutine } from './householdRoutineRunner';

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
  try {
    const settled = settleInterruptedRuns(db);
    if (settled) console.log(`[karkedikha-core ${new Date().toISOString()}] ${settled} household routine run(s) interrupted by the last shutdown recorded as failed`);
  } catch { /* the routine tables are optional in very old databases */ }
  const tick = () => {
    let claimed: ReturnType<typeof claimDueScheduledTasks>;
    try {
      claimed = claimDueScheduledTasks(db, new Date(), (task, dueAt) => {
        recordMissedRun(db, task, dueAt);
        console.log(`[karkedikha-core ${new Date().toISOString()}] scheduled task ${task.id} missed its ${dueAt} run (outside the catch-up window); recorded`);
      });
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
        if (task.routine && HOUSEHOLD_ROUTINES.has(task.routine)) {
          void runHouseholdRoutine(db, broadcaster, task, late ? 'catch_up' : 'schedule', { connectorRegistry: options.connectorRegistry, cwd: options.cwd })
            .then((result) => {
              console.log(`[karkedikha-core ${new Date().toISOString()}] household routine ${task.id} (${task.routine}) ${result.reason}`);
            })
            .catch((err) => {
              console.error(`[karkedikha-core ${new Date().toISOString()}] household routine ${task.id} failed:`, err instanceof Error ? err.message : err);
            });
          continue;
        }
        if (task.routine === WATCHDOG_ROUTINE) {
          void runReliabilityWatchdogRoutine(db, broadcaster, { task })
            .then((result) => {
              console.log(`[karkedikha-core ${new Date().toISOString()}] reliability watchdog ${task.id} ${result.delivered ? 'reported' : 'quiet'} (${result.reason})`);
            })
            .catch((err) => {
              console.error(`[karkedikha-core ${new Date().toISOString()}] reliability watchdog ${task.id} failed:`, err instanceof Error ? err.message : err);
            });
          continue;
        }
        if (task.routine === AI_RADAR_ROUTINE) {
          if (!options.cwd) { console.error(`[karkedikha-core ${new Date().toISOString()}] ai radar ${task.id} skipped: no data dir`); continue; }
          void runAiRadarRoutine(db, broadcaster, { task, dataDir: options.cwd })
            .then((r) => console.log(`[karkedikha-core ${new Date().toISOString()}] ai radar ${task.id}: ${r.newFindings.length} new, ${r.urgent.length} urgent, ${r.errors.length} errors`))
            .catch((err) => console.error(`[karkedikha-core ${new Date().toISOString()}] ai radar ${task.id} failed:`, err instanceof Error ? err.message : err));
          continue;
        }
        if (task.routine === FREE_MODEL_ROUTINE) {
          void runFreeModelRoutine(db, broadcaster, { task })
            .then((summary) => console.log(`[karkedikha-core ${new Date().toISOString()}] free model registry ${task.id}: ${summary}`))
            .catch((err) => console.error(`[karkedikha-core ${new Date().toISOString()}] free model registry ${task.id} failed:`, err instanceof Error ? err.message : err));
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
        // M3: the folder and access the routine was created with (frozen by schedule_task). A routine whose folder is gone does
        // not run blind: the owner is told.
        const scope = task.scope as { workspaceRoot?: string; workspaceAccess?: 'read' | 'read_write' } | null;
        const workspaceRoot = scope?.workspaceRoot && typeof scope.workspaceRoot === 'string' ? scope.workspaceRoot : null;
        if (workspaceRoot && !fs.existsSync(workspaceRoot)) {
          enqueueNotification(db, { kind: 'task_failed', sourceId: `sched-missing:${task.id}:${new Date().toISOString().slice(0, 10)}`, title: `Routine "${task.title}" did not run`, body: `Its folder ${workspaceRoot} no longer exists, so it was not run. Nothing was changed.` });
          console.error(`[karkedikha-core ${new Date().toISOString()}] scheduled task ${task.id} not run: its folder ${workspaceRoot} is gone`);
          continue;
        }
        const result = submitRequest(db, {
          clientId: ACTOR,
          currentMessage: `[Scheduled task "${task.title}"${late ? ', running late because KarkeDikha was not running at the scheduled time' : ''}] ${task.instruction}`,
          requestedMode: 'saath_kar',
          conversationId,
          requestedProvider: 'ollama',
          requestedModel: model,
          selectedProvider: 'ollama',
          selectedModel: model,
          workspaceRoot,
          effectiveAllowedTools: [],
          toolPermissionPolicy: workspaceRoot ? { profile: 'local-core-question', worker: 'local-core', workspaceAccess: scope?.workspaceAccess === 'read_write' ? 'read_write' : 'read' } : {},
          capability: { hasWorkspace: Boolean(workspaceRoot), gitCapable: false },
          correlationId: key,
          idempotencyKey: key,
        });
        recordScheduledRun(db, task.id, { attemptId: result.attempt.id, conversationId });
        console.log(`[karkedikha-core ${new Date().toISOString()}] scheduled task ${task.id} fired attempt=${result.attempt.id}`);
        const attemptId = result.attempt.id;
        void executor.execute(attemptId, workspaceRoot ? { workingDirectory: workspaceRoot } : undefined)
          .catch(() => { /* terminal failure is durably recorded */ })
          .finally(() => {
            // A scheduled run that did not finish its work must reach the owner: a notification, not a silent record.
            try {
              const outcome = deriveResultStatus(db, attemptId);
              if (outcome.status !== 'completed' && outcome.status !== 'running' && outcome.status !== 'cancelled') {
                enqueueNotification(db, { kind: outcome.status === 'blocked' ? 'task_blocked' : 'task_failed', sourceId: `sched-run:${attemptId}`, title: `Routine "${task.title}" ${outcome.status === 'partial' ? 'did part of its work' : outcome.status === 'blocked' ? 'is waiting' : outcome.status === 'interrupted' ? 'was interrupted' : 'failed'}`, body: outcome.reason ?? 'It did not finish; open the conversation for details.' });
              }
            } catch { /* the notification is best effort; the attempt record stays */ }
          });
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
