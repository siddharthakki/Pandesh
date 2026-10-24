/**
 * Durable journal of Gmail bulk-change plans (`gmail_change_plans`, migration 35).
 *
 * A plan keeps the labels every message carried before the change, so an applied change can be undone and so a
 * restart never loses what was approved. Only sender/subject/date/labels are stored, never a body or a snippet.
 * Plans older than 30 days are dropped whenever a new one is saved.
 */
import type { CoreDatabase } from '../db/connection';
import type { GmailChangePlan, GmailOrganizeStore } from '../runtime/connectors/gmailOrganize';

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
  };
}
