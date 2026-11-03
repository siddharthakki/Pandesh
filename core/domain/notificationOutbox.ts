/**
 * Notification outbox: the durable record of every notification Pandesh intends to deliver, and what really happened.
 *
 * Core cannot show a Windows toast; the desktop host can. So Core writes a `pending` row, the host shows the toast and
 * reports back, and only that report makes a row `delivered`. A row that was never reported stays `pending` and is
 * retried when the host next starts, so a notification survives a restart and a failure is on record, never silent.
 *
 * Pandesh may promise a notification only while `notificationCapability` says a delivery channel is registered by a
 * running host. No registered host means no promise.
 */
import type { CoreDatabase } from '../db/connection';
import { newId, nowIso } from './ids';
import { CoreError } from './errors';
import { recordRuntimeEvent } from './runtimeEvents';

export type NotificationStatus = 'pending' | 'delivered' | 'failed';
export type NotificationKind = 'task_completed' | 'task_blocked' | 'task_failed' | 'test';

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  /** The task or plan the notification is about; with `kind` it makes enqueueing idempotent. */
  sourceId: string;
  title: string;
  body: string;
  status: NotificationStatus;
  attempts: number;
  lastError: string | null;
  deliveredVia: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface NotificationChannel {
  channel: string;
  supported: boolean;
  detail: string;
  registeredAt: string;
  lastSeenAt: string;
}

/** A registered host that has not checked in for this long is treated as gone. */
export const CHANNEL_FRESH_MS = 3 * 60_000;
/** A failed delivery is retried this many times in total, then left `failed` on record. */
export const MAX_DELIVERY_ATTEMPTS = 3;
const ACTOR = 'notification_outbox';

const COLUMNS = 'id, kind, sourceId, title, body, status, attempts, lastError, deliveredVia, createdAt, deliveredAt';

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function enqueueNotification(
  db: CoreDatabase,
  input: { kind: NotificationKind; sourceId: string; title: string; body: string },
): { record: NotificationRecord; created: boolean } {
  const existing = db.get<NotificationRecord>(`SELECT ${COLUMNS} FROM notification_outbox WHERE kind = ? AND sourceId = ?`, [input.kind, input.sourceId]);
  if (existing) return { record: existing, created: false };
  const id = newId('notif');
  const now = nowIso();
  db.run(
    `INSERT INTO notification_outbox (id, kind, sourceId, title, body, status, attempts, createdAt) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [id, input.kind, input.sourceId, clip(input.title, 120), clip(input.body, 400), now],
  );
  recordRuntimeEvent(db, {
    domain: 'notification',
    entityId: id,
    eventType: 'notification_enqueued',
    actor: ACTOR,
    metadata: { notificationId: id, kind: input.kind, sourceId: input.sourceId },
  });
  return { record: db.get<NotificationRecord>(`SELECT ${COLUMNS} FROM notification_outbox WHERE id = ?`, [id])!, created: true };
}

/** Rows the host still has to show: never shown, or failed with attempts left. Oldest first. */
export function listDeliverable(db: CoreDatabase, limit = 20): NotificationRecord[] {
  return db.all<NotificationRecord>(
    `SELECT ${COLUMNS} FROM notification_outbox WHERE status = 'pending' OR (status = 'failed' AND attempts < ?) ORDER BY createdAt LIMIT ?`,
    [MAX_DELIVERY_ATTEMPTS, limit],
  );
}

export function listNotifications(db: CoreDatabase, limit = 20): NotificationRecord[] {
  return db.all<NotificationRecord>(`SELECT ${COLUMNS} FROM notification_outbox ORDER BY createdAt DESC LIMIT ?`, [limit]);
}

/** The host's own report of what the operating system did. This is the only way a row becomes `delivered`. */
export function recordDelivery(
  db: CoreDatabase,
  id: string,
  report: { status: 'delivered' | 'failed'; via: string; error?: string },
): NotificationRecord {
  const row = db.get<NotificationRecord>(`SELECT ${COLUMNS} FROM notification_outbox WHERE id = ?`, [id]);
  if (!row) throw new CoreError('not_found', `notification '${id}' not found`);
  if (row.status === 'delivered') return row;
  const now = nowIso();
  if (report.status === 'delivered') {
    db.run(`UPDATE notification_outbox SET status = 'delivered', attempts = attempts + 1, lastError = NULL, deliveredVia = ?, deliveredAt = ? WHERE id = ?`, [report.via, now, id]);
  } else {
    db.run(`UPDATE notification_outbox SET status = 'failed', attempts = attempts + 1, lastError = ? WHERE id = ?`, [clip(report.error ?? 'delivery failed', 300), id]);
  }
  recordRuntimeEvent(db, {
    domain: 'notification',
    entityId: id,
    eventType: report.status === 'delivered' ? 'notification_delivered' : 'notification_failed',
    actor: ACTOR,
    metadata: { notificationId: id, via: report.via, ...(report.error ? { error: clip(report.error, 300) } : {}) },
  });
  return db.get<NotificationRecord>(`SELECT ${COLUMNS} FROM notification_outbox WHERE id = ?`, [id])!;
}

/** The host announces (and re-announces, as a heartbeat) the channel it can deliver through. */
export function registerChannel(db: CoreDatabase, input: { channel: string; supported: boolean; detail: string }): NotificationChannel {
  const now = nowIso();
  db.run(
    `INSERT INTO notification_channels (channel, supported, detail, registeredAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel) DO UPDATE SET supported = excluded.supported, detail = excluded.detail, lastSeenAt = excluded.lastSeenAt`,
    [input.channel, input.supported ? 1 : 0, clip(input.detail, 200), now, now],
  );
  return listChannels(db).find((c) => c.channel === input.channel)!;
}

export function listChannels(db: CoreDatabase): NotificationChannel[] {
  return db.all<{ channel: string; supported: number; detail: string; registeredAt: string; lastSeenAt: string }>(
    'SELECT channel, supported, detail, registeredAt, lastSeenAt FROM notification_channels ORDER BY channel',
  ).map((c) => ({ ...c, supported: Number(c.supported) === 1 }));
}

export interface NotificationCapability {
  /** True only when a running host has recently registered a channel that supports notifications. */
  canNotify: boolean;
  channel: string | null;
  /** Plain words: why notifications can or cannot be promised right now. */
  statement: string;
}

export function notificationCapability(db: CoreDatabase, nowMs: number = Date.now()): NotificationCapability {
  const fresh = listChannels(db).filter((c) => nowMs - Date.parse(c.lastSeenAt) <= CHANNEL_FRESH_MS);
  const usable = fresh.find((c) => c.supported);
  if (usable) {
    return { canNotify: true, channel: usable.channel, statement: `Desktop notifications are available through ${usable.detail || usable.channel}. They appear only while Pandesh is running (the window may be minimized or hidden to the tray); anything queued while it is closed is shown when it next starts.` };
  }
  if (fresh.length > 0) return { canNotify: false, channel: null, statement: `The desktop reports that notifications are not supported (${fresh[0].detail || fresh[0].channel}). Pandesh cannot notify you; ask again in chat instead.` };
  return { canNotify: false, channel: null, statement: 'No Pandesh desktop is currently connected to deliver notifications, so none can be promised. Results appear in this chat.' };
}

export interface NotificationReport {
  capability: NotificationCapability;
  channels: NotificationChannel[];
  counts: { pending: number; delivered: number; failed: number };
  recent: NotificationRecord[];
}

export function notificationReport(db: CoreDatabase, nowMs: number = Date.now()): NotificationReport {
  const counts = { pending: 0, delivered: 0, failed: 0 };
  for (const row of db.all<{ status: NotificationStatus; n: number }>('SELECT status, COUNT(*) AS n FROM notification_outbox GROUP BY status')) {
    counts[row.status] = Number(row.n);
  }
  return { capability: notificationCapability(db, nowMs), channels: listChannels(db), counts, recent: listNotifications(db, 5) };
}

/** Plain-language configuration answer built only from the recorded state above. */
export function describeNotifications(report: NotificationReport): string {
  const lines = ['**How notifications work in Pandesh (from the live system, not from memory):**', '', `- ${report.capability.statement}`];
  lines.push('- Every notification is first written to a durable outbox; the desktop shows it and reports back, and only that report marks it delivered.');
  lines.push('- Reminders are shown by the desktop when they fall due, while Pandesh is running. There is no phone, email or cloud notification.');
  lines.push(`- Outbox: ${report.counts.delivered} delivered, ${report.counts.pending} pending, ${report.counts.failed} failed.`);
  for (const n of report.recent.slice(0, 3)) {
    lines.push(`  - ${n.createdAt} ${n.kind} "${n.title}": ${n.status}${n.deliveredAt ? ` at ${n.deliveredAt}` : ''}${n.lastError ? ` (${n.lastError})` : ''}`);
  }
  if (report.counts.delivered + report.counts.pending + report.counts.failed === 0) lines.push('  - No notification has been recorded yet.');
  lines.push('- Windows can still hide a delivered toast (Focus Assist / Do Not Disturb); the status above means Windows accepted it, not that you saw it.');
  return lines.join('\n');
}
