/**
 * The AI Radar scan as a durable daily schedule (routine 'ai_radar', default 06:30 Europe/Berlin, before the morning
 * briefing). A scan stores its findings; it does not post a message of its own — the one morning briefing summarises
 * what is new. The only immediate alert is a recent high/critical security advisory for software installed here.
 */
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { createScheduledTask, listRoutineTasks, setScheduledTaskEnabled, type ScheduledTaskRecord } from '../domain/scheduledTasks';
import { enqueueNotification } from '../domain/notificationOutbox';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';
import { scanAiRadar, type InstalledTool, type RadarScanResult } from './aiRadar';
import { collectSoftwareInventory } from './software/inventory';

export const AI_RADAR_ROUTINE = 'ai_radar';
const ACTOR = 'kkd:ai_radar';

export function aiRadarSchedule(db: CoreDatabase): ScheduledTaskRecord | null {
  return listRoutineTasks(db, AI_RADAR_ROUTINE)[0] ?? null;
}

export function scheduleAiRadar(db: CoreDatabase, input: { enabled?: boolean; dailyTime?: string; timezone?: string } = {}): ScheduledTaskRecord | null {
  const existing = aiRadarSchedule(db);
  if (input.enabled === false) return existing ? setScheduledTaskEnabled(db, existing.id, false) : null;
  if (existing) return existing.enabled ? existing : setScheduledTaskEnabled(db, existing.id, true);
  return createScheduledTask(db, {
    title: 'AI Radar scan',
    instruction: 'Check official releases and security advisories of the local-AI tools on the watchlist against this PC.',
    dailyTime: input.dailyTime ?? '06:30',
    timezone: input.timezone ?? 'Europe/Berlin',
    routine: AI_RADAR_ROUTINE,
    purpose: 'Public GitHub releases and advisories only; nothing private is sent; nothing is installed.',
  });
}

export async function runAiRadarRoutine(
  db: CoreDatabase,
  broadcaster: EventBroadcaster,
  input: { task: ScheduledTaskRecord; dataDir: string; installed?: () => Promise<InstalledTool[]>; scan?: typeof scanAiRadar },
): Promise<RadarScanResult> {
  const installed = await (input.installed ?? (async () => (await collectSoftwareInventory({ dataDir: input.dataDir })).items.filter((i) => i.kind !== 'model').map((i) => ({ name: i.name, version: i.version }))))();
  const result = await (input.scan ?? scanAiRadar)({ dataDir: input.dataDir, installed });
  for (const f of result.urgent) {
    enqueueNotification(db, { kind: 'routine_report', sourceId: `radar:${f.id}`, title: `Security: ${f.title}`.slice(0, 120), body: `${f.why} ${f.action}`.slice(0, 400) });
  }
  const event = recordRuntimeEvent(db, {
    domain: 'scout_routine', entityId: input.task.id, eventType: 'ai_radar_scanned', actor: ACTOR, clientId: SCHEDULER_CLIENT_ID,
    idempotencyKey: `radar:${input.task.id}@${input.task.nextRunAt}`,
    metadata: { newFindings: result.newFindings.length, urgent: result.urgent.length, errors: result.errors.slice(0, 5) },
  });
  broadcaster.publishRuntime(event);
  db.run('UPDATE scheduled_tasks SET lastRunAt = ?, updatedAt = ? WHERE id = ?', [result.scannedAt, result.scannedAt, input.task.id]);
  return result;
}
