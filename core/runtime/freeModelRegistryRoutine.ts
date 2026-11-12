/**
 * The free-model registry refresh as a durable daily routine (routine 'free_model_registry', default 05:45 local).
 * It fetches only the two pinned public registry files, then health-checks (one GET /models each) the providers the
 * user approved for automatic routing. It never qualifies models, never enables a provider and sends no user data.
 * The routine is created the first time the user refreshes the registry, and can be switched off from the app.
 */
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { createScheduledTask, listRoutineTasks, setScheduledTaskEnabled, type ScheduledTaskRecord } from '../domain/scheduledTasks';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';
import { activeFreeModelRegistry } from './freeModelRegistryService';

export const FREE_MODEL_ROUTINE = 'free_model_registry';
const ACTOR = 'kkd:free_model_registry';

export function freeModelSchedule(db: CoreDatabase): ScheduledTaskRecord | null {
  return listRoutineTasks(db, FREE_MODEL_ROUTINE)[0] ?? null;
}

export function scheduleFreeModelRefresh(db: CoreDatabase, input: { enabled?: boolean; dailyTime?: string; timezone?: string } = {}): ScheduledTaskRecord | null {
  const existing = freeModelSchedule(db);
  if (input.enabled === false) return existing ? setScheduledTaskEnabled(db, existing.id, false) : null;
  if (existing) return existing.enabled ? existing : setScheduledTaskEnabled(db, existing.id, true);
  return createScheduledTask(db, {
    title: 'Free model registry refresh',
    instruction: 'Refresh the free AI model registry from its two pinned public sources and health-check approved providers.',
    dailyTime: input.dailyTime ?? '05:45',
    timezone: input.timezone ?? 'Europe/Berlin',
    routine: FREE_MODEL_ROUTINE,
    purpose: 'Public registry files only; nothing private is sent; no provider is enabled and no model is benchmarked.',
  });
}

export async function runFreeModelRoutine(db: CoreDatabase, broadcaster: EventBroadcaster, input: { task: ScheduledTaskRecord }): Promise<string> {
  const registry = activeFreeModelRegistry();
  if (!registry) return 'skipped: the registry is not active in this Core';
  const outcome = await registry.refresh();
  const checked = await registry.healthCheckApproved();
  const event = recordRuntimeEvent(db, {
    domain: 'scout_routine', entityId: input.task.id, eventType: 'free_model_registry_refreshed', actor: ACTOR, clientId: SCHEDULER_CLIENT_ID,
    idempotencyKey: `free-models:${input.task.id}@${input.task.nextRunAt}`,
    metadata: { ok: outcome.ok, keptLastKnownGood: outcome.keptLastKnownGood, summary: outcome.report.summary, errors: outcome.errors.slice(0, 5), healthChecked: checked },
  });
  broadcaster.publishRuntime(event);
  const at = new Date().toISOString();
  db.run('UPDATE scheduled_tasks SET lastRunAt = ?, updatedAt = ? WHERE id = ?', [at, at, input.task.id]);
  return outcome.report.summary;
}
