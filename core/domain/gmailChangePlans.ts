/**
 * Durable journal of Gmail bulk-change plans (`gmail_change_plans`, migration 35).
 *
 * A plan keeps the labels every message carried before the change, so an applied change can be undone and so a
 * restart never loses what was approved. Only sender/subject/date/labels are stored, never a body or a snippet.
 * Plans older than 30 days are dropped whenever a new one is saved.
 */
import type { CoreDatabase } from '../db/connection';
import type { GmailChangePlan, GmailOrganizeStore } from '../runtime/connectors/gmailOrganize';
import type { GmailOrganizeTask, GmailTaskStore } from '../runtime/connectors/gmailTask';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface PlanRow { planJson: string }

export function createGmailOrganizeStore(db: CoreDatabase, nowMs: () => number = Date.now): GmailOrganizeStore {
  return {
    save(plan: GmailChangePlan): void {
      db.run('DELETE FROM gmail_change_plans WHERE createdAt < ?', [new Date(nowMs() - RETENTION_MS).toISOString()]);
      const at = new Date(nowMs()).toISOString();
      db.run(
        `INSERT INTO gmail_change_plans (planId, accountEmail, status, digest, planJson, createdAt, updatedAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(planId) DO UPDATE SET status = excluded.status, digest = excluded.digest, planJson = excluded.planJson, updatedAt = excluded.updatedAt, expiresAt = excluded.expiresAt`,
        [plan.planId, plan.accountEmail, plan.status, plan.digest, JSON.stringify(plan), plan.createdAt, at, plan.expiresAt],
      );
    },
    get(planId: string): GmailChangePlan | undefined {
      const row = db.get<PlanRow>('SELECT planJson FROM gmail_change_plans WHERE planId = ?', [planId]);
      return row ? (JSON.parse(row.planJson) as GmailChangePlan) : undefined;
    },
    update(planId: string, patch: Partial<GmailChangePlan>): GmailChangePlan | undefined {
      const current = this.get(planId);
      if (!current) return undefined;
      const next = { ...current, ...patch, planId: current.planId } as GmailChangePlan;
      this.save(next);
      return next;
    },
    listOpen(accountEmail: string, nowIso: string, limit: number): GmailChangePlan[] {
      return db
        .all<PlanRow>(
          `SELECT planJson FROM gmail_change_plans
            WHERE lower(accountEmail) = lower(?) AND status = 'planned' AND expiresAt > ?
            ORDER BY createdAt DESC LIMIT ?`,
          [accountEmail, nowIso, Math.max(1, Math.floor(limit))],
        )
        .map((row) => JSON.parse(row.planJson) as GmailChangePlan);
    },
  };
}

/** Durable store for Gmail-organization tasks (`gmail_organize_tasks`, migration 39). */
/** `onSaved` runs after every durable save, so a task reaching a state the user must hear about is noticed once, in one place. */
export function createGmailTaskStore(db: CoreDatabase, onSaved?: (task: GmailOrganizeTask) => void): GmailTaskStore {
  return {
    save(task: GmailOrganizeTask): void {
      db.run(
        `INSERT INTO gmail_organize_tasks (taskId, accountEmail, status, taskJson, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(taskId) DO UPDATE SET status = excluded.status, taskJson = excluded.taskJson, updatedAt = excluded.updatedAt`,
        [task.taskId, task.accountEmail, task.status, JSON.stringify(task), task.createdAt, task.updatedAt],
      );
      try { onSaved?.(task); } catch { /* a notification problem never loses task progress */ }
    },
    get(taskId: string): GmailOrganizeTask | undefined {
      const row = db.get<{ taskJson: string }>('SELECT taskJson FROM gmail_organize_tasks WHERE taskId = ?', [taskId]);
      return row ? (JSON.parse(row.taskJson) as GmailOrganizeTask) : undefined;
    },
    findActive(accountEmail: string): GmailOrganizeTask[] {
      return db
        .all<{ taskJson: string }>(`SELECT taskJson FROM gmail_organize_tasks WHERE lower(accountEmail) = lower(?) AND status = 'active' ORDER BY createdAt DESC`, [accountEmail])
        .map((row) => JSON.parse(row.taskJson) as GmailOrganizeTask);
    },
  };
}
