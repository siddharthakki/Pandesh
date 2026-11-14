import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { latestRuntimeSequence, listRuntimeEventsAfter, recordRuntimeEvent } from '../domain/runtimeEvents';
import { verifyGrantRun, verifyRoutineSemantics } from '../domain/routineWriteGrants';
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
        const fire = (retry: boolean): void => {
        const runKey = retry ? `sched:${task.id}:${Date.now()}` : key;
        const result = submitRequest(db, {
          clientId: ACTOR,
          currentMessage: `[Scheduled task${workspaceRoot ? '' : ` "${task.title}"`}${late ? ', running late because KarkeDikha was not running at the scheduled time' : ''}]${retry ? ' YOUR PREVIOUS ANSWER CALLED NO TOOL, SO NOTHING WAS DONE. Call the tool now.' : ''} This is the scheduled run itself, not a request to set up a schedule. Earlier runs in this conversation that were declined, blocked or failed do not apply to this one: every run is a new request, and the owner's current permission is decided by Core, not by that history, so attempt the write again: carry out the task now with your tools, every time, even if the result looks the same as last time: do not answer from memory. Call the tool that does the work (for a file: write_file with the exact required text; an UNCHANGED answer means it is already right, which is success), then report what it returned. ${task.instruction}`,
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
          correlationId: runKey,
          idempotencyKey: runKey,
        });
        recordScheduledRun(db, task.id, { attemptId: result.attempt.id, conversationId });
        console.log(`[karkedikha-core ${new Date().toISOString()}] scheduled task ${task.id} fired attempt=${result.attempt.id}`);
        const attemptId = result.attempt.id;
        void executor.execute(attemptId, workspaceRoot ? { workingDirectory: workspaceRoot } : undefined)
          .catch(() => { /* terminal failure is durably recorded */ })
          .finally(() => {
            // A scheduled run that did not finish its work must reach the owner: a notification, not a silent record.
            try {
              // A run that wrote under a standing permission is checked against the disk, not against what the model said.
              const audit = verifyGrantRun(db, attemptId);
              if (audit.uses > 0) {
                // Read-back proves the file holds what was written; the semantic check proves what was written is right.
                const semantic = verifyRoutineSemantics(db, attemptId, task.instruction, workspaceRoot);
                const problems = [...audit.problems, ...semantic.problems];
                recordRuntimeEvent(db, { domain: 'authorization', entityId: attemptId, eventType: problems.length ? 'routine_run_verification_failed' : 'routine_run_verified', actor: ACTOR, metadata: { taskId: task.id, writes: audit.uses, matched: audit.matched, semanticChecked: semantic.checked, problems: problems.slice(0, 5) } });
                if (problems.length) enqueueNotification(db, { kind: 'task_failed', sourceId: `sched-verify:${attemptId}`, title: `Routine "${task.title}": the result is not correct`, body: problems.join('; ') });
              }
            } catch { /* the audit record is best effort; the grant-use rows stay */ }
            try {
              // A run that answered without calling a single tool did nothing (day 5 of the grant evaluation: a routine ended
              // "completed" with no write). Nothing ran, so repeating it once is safe; a second empty run is reported.
              const toolCalls = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tool_invocations WHERE attemptId = ?', [attemptId])?.n ?? 0;
              const finished = db.get<{ status: string }>('SELECT status FROM attempts WHERE id = ?', [attemptId])?.status;
              if (toolCalls === 0 && finished === 'completed' && workspaceRoot) {
                if (!retry) { console.log(`[karkedikha-core ${new Date().toISOString()}] scheduled task ${task.id} attempt ${attemptId} called no tool; running it once more`); fire(true); return; }
                enqueueNotification(db, { kind: 'task_failed', sourceId: `sched-run:${attemptId}`, title: `Routine "${task.title}" did not do its work`, body: 'The run answered without using any tool, twice, so nothing was done. Open the conversation for details.' });
                return;
              }
            } catch { /* fall through to the ordinary outcome check */ }
            try {
              const outcome = deriveResultStatus(db, attemptId);
              if (outcome.status !== 'completed' && outcome.status !== 'running' && outcome.status !== 'cancelled') {
                enqueueNotification(db, { kind: outcome.status === 'blocked' ? 'task_blocked' : 'task_failed', sourceId: `sched-run:${attemptId}`, title: `Routine "${task.title}" ${outcome.status === 'partial' ? 'did part of its work' : outcome.status === 'blocked' ? 'is waiting' : outcome.status === 'interrupted' ? 'was interrupted' : 'failed'}`, body: outcome.reason ?? 'It did not finish; open the conversation for details.' });
              }
            } catch { /* the notification is best effort; the attempt record stays */ }
          });
        };
        fire(false);
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
