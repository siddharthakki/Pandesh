/**
 * The Mail Hub's local index and its read-only sync from Outlook.
 *
 * Bounded by settings (window, per-account cap, retention, body size); incremental (since the last watermark, with a
 * full reconcile of the window once a day so moved and deleted mail disappears instead of lingering); deduplicated on
 * the internet message id. Only accounts the owner has authorized are ever read or queried. Nothing here writes to
 * Outlook, and nothing writes a subject, address or body into the activity log.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../../db/connection';
import { OutlookConnector, OutlookError, type OutlookAccount, type OutlookMessage } from './outlookConnector';
import { readMessage, type MailCategory, type MailFacts } from './mailRules';

export interface MailSettings { windowDays: number; maxPerAccount: number; maxPerSync: number; bodyChars: number; retentionDays: number }
export const DEFAULT_MAIL_SETTINGS: MailSettings = { windowDays: 30, maxPerAccount: 2000, maxPerSync: 500, bodyChars: 4000, retentionDays: 90 };
const LIMITS: Record<keyof MailSettings, [number, number]> = { windowDays: [1, 365], maxPerAccount: [100, 20000], maxPerSync: [50, 2000], bodyChars: [0, 20000], retentionDays: [7, 730] };
const RECONCILE_EVERY_MS = 24 * 3_600_000;
const ACTIVITY_KEEP = 500;

export interface MailRow {
  id: string; storeId: string; account: string; folder: string; subject: string; fromName: string; fromAddress: string; toText: string; received: string;
  unread: boolean; attachments: number; category: MailCategory; facts: MailFacts; snippet: string; duplicates: number;
}
export interface MailQuery { storeIds?: string[]; category?: MailCategory; unreadOnly?: boolean; needsReply?: boolean; q?: string; sinceIso?: string; limit?: number; offset?: number }
export interface SyncResult { storeId: string; ok: boolean; indexed: number; removed: number; complete: boolean; mode: 'reconcile' | 'incremental'; error?: string }

interface DbMessage {
  id: string; storeId: string; folder: string; entryId: string; subject: string; fromName: string; fromAddress: string; toText: string; received: string;
  unread: number; attachments: number; body: string; category: MailCategory; facts: string; dupes?: number; accountName?: string;
}

const clampSetting = (k: keyof MailSettings, v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], Math.round(n))) : fallback; };
const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

export class MailIndex {
  constructor(readonly db: CoreDatabase, readonly connector: OutlookConnector, private readonly now: () => Date = () => new Date()) {}

  // ── settings and activity ───────────────────────────────────────────────────────────────────

  settings(): MailSettings {
    const out = { ...DEFAULT_MAIL_SETTINGS };
    for (const r of this.db.all<{ key: string; value: string }>('SELECT key, value FROM mail_settings')) if (r.key in out) (out as Record<string, number>)[r.key] = clampSetting(r.key as keyof MailSettings, r.value, out[r.key as keyof MailSettings]);
    return out;
  }
  updateSettings(patch: Partial<Record<keyof MailSettings, unknown>>): MailSettings {
    for (const k of Object.keys(LIMITS) as Array<keyof MailSettings>) {
      if (patch[k] === undefined) continue;
      this.db.run('INSERT INTO mail_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, String(clampSetting(k, patch[k], DEFAULT_MAIL_SETTINGS[k]))]);
    }
    return this.settings();
  }
  activity(kind: string, storeId: string | null, ok: boolean, detail: string): void {
    this.db.run('INSERT INTO mail_activity (at, kind, storeId, ok, detail) VALUES (?, ?, ?, ?, ?)', [this.now().toISOString(), kind, storeId, ok ? 1 : 0, detail.slice(0, 300)]);
    this.db.run('DELETE FROM mail_activity WHERE id <= (SELECT MAX(id) FROM mail_activity) - ?', [ACTIVITY_KEEP]);
  }
  recentActivity(limit = 100) { return this.db.all<{ id: number; at: string; kind: string; storeId: string | null; ok: number; detail: string }>('SELECT * FROM mail_activity ORDER BY id DESC LIMIT ?', [Math.min(limit, 300)]).map((r) => ({ ...r, ok: Boolean(r.ok) })); }

  // ── accounts and authorization ──────────────────────────────────────────────────────────────

  /** Discovers the Outlook accounts (a read of names and counts only) and joins them with the owner's authorization. */
  async accounts(signal?: AbortSignal): Promise<Array<OutlookAccount & { enabled: boolean; authorizedAt: string | null; lastSyncAt: string | null; indexed: number; lastError: string | null }>> {
    const live = await this.connector.accounts(signal);
    const out = [];
    for (const a of live) {
      this.db.run('INSERT INTO mail_accounts (storeId, name) VALUES (?, ?) ON CONFLICT(storeId) DO UPDATE SET name = excluded.name', [a.storeId, a.name]);
      const row = this.db.get<{ enabled: number; authorizedAt: string | null; lastSyncAt: string | null; lastError: string | null }>('SELECT enabled, authorizedAt, lastSyncAt, lastError FROM mail_accounts WHERE storeId = ?', [a.storeId])!;
      const n = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM mail_messages WHERE storeId = ?', [a.storeId])?.n ?? 0;
      out.push({ ...a, enabled: Boolean(row.enabled), authorizedAt: row.authorizedAt, lastSyncAt: row.lastSyncAt, indexed: n, lastError: row.lastError });
    }
    this.activity('discover', null, true, `${live.length} Outlook account(s) found`);
    return out;
  }
  knownAccounts() { return this.db.all<{ storeId: string; name: string; enabled: number; authorizedAt: string | null; lastSyncAt: string | null; lastError: string | null }>('SELECT * FROM mail_accounts ORDER BY name').map((r) => ({ ...r, enabled: Boolean(r.enabled) })); }
  enabledStoreIds(): string[] { return this.db.all<{ storeId: string }>('SELECT storeId FROM mail_accounts WHERE enabled = 1').map((r) => r.storeId); }

  /** The owner's decision. Turning an account off also forgets what was indexed from it. */
  setAuthorized(storeId: string, enabled: boolean): void {
    const r = this.db.run('UPDATE mail_accounts SET enabled = ?, authorizedAt = ? WHERE storeId = ?', [enabled ? 1 : 0, enabled ? this.now().toISOString() : null, storeId]);
    if (Number(r.changes) === 0) throw new OutlookError('failed', 'unknown account: discover accounts first');
    if (!enabled) this.forget(storeId);
    this.activity(enabled ? 'authorize' : 'revoke', storeId, true, enabled ? 'read-only access granted' : 'access revoked, index removed');
  }
  forget(storeId?: string): number {
    const ids = this.db.all<{ id: string }>(storeId ? 'SELECT id FROM mail_messages WHERE storeId = ?' : 'SELECT id FROM mail_messages', storeId ? [storeId] : []);
    this.db.transaction(() => {
      for (const { id } of ids) this.db.run('DELETE FROM mail_fts WHERE msgId = ?', [id]);
      this.db.run(storeId ? 'DELETE FROM mail_messages WHERE storeId = ?' : 'DELETE FROM mail_messages', storeId ? [storeId] : []);
      this.db.run(storeId ? 'UPDATE mail_accounts SET watermark = NULL, lastReconcileAt = NULL WHERE storeId = ?' : 'UPDATE mail_accounts SET watermark = NULL, lastReconcileAt = NULL', storeId ? [storeId] : []);
    });
    this.activity('clear', storeId ?? null, true, `${ids.length} indexed message(s) removed`);
    return ids.length;
  }

  // ── sync ────────────────────────────────────────────────────────────────────────────────────

  private upsert(storeId: string, folder: string, m: OutlookMessage, gen: number, bodyChars: number): void {
    const dedupeKey = m.internetMessageId ? m.internetMessageId.toLowerCase() : `h:${sha(`${m.fromAddress}|${m.subject}|${m.received}`)}`;
    const id = `mail_${sha(`${storeId}|${dedupeKey}`).slice(0, 24)}`;
    const received = new Date(m.received).toISOString();
    const body = (m.body ?? '').slice(0, bodyChars);
    const reading = readMessage({ subject: m.subject, fromName: m.fromName, fromAddress: m.fromAddress, body, received, bulkHint: m.bulkHint });
    const had = this.db.get<{ id: string }>('SELECT id FROM mail_messages WHERE id = ?', [id]);
    this.db.run(
      `INSERT INTO mail_messages (id, storeId, folder, entryId, dedupeKey, conversationId, subject, fromName, fromAddress, toText, received, unread, attachments, body, category, facts, seenGen, indexedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET folder = excluded.folder, entryId = excluded.entryId, unread = excluded.unread, attachments = excluded.attachments, seenGen = excluded.seenGen,
         body = CASE WHEN length(excluded.body) > 0 THEN excluded.body ELSE mail_messages.body END, category = excluded.category, facts = excluded.facts`,
      [id, storeId, folder, m.entryId, dedupeKey, m.conversationId || null, m.subject, m.fromName, m.fromAddress, m.to, received, m.unread ? 1 : 0, m.attachments, body, reading.category, JSON.stringify(reading.facts), gen, this.now().toISOString()]);
    if (had) this.db.run('DELETE FROM mail_fts WHERE msgId = ?', [id]);
    this.db.run('INSERT INTO mail_fts (subject, sender, body, msgId) VALUES (?, ?, ?, ?)', [m.subject, `${m.fromName} ${m.fromAddress}`, body, id]);
  }

  async sync(storeId: string, signal?: AbortSignal): Promise<SyncResult> {
    const acct = this.db.get<{ enabled: number; watermark: string | null; lastReconcileAt: string | null }>('SELECT enabled, watermark, lastReconcileAt FROM mail_accounts WHERE storeId = ?', [storeId]);
    if (!acct?.enabled) throw new OutlookError('failed', 'this account is not authorized for Mail Hub');
    const s = this.settings();
    const now = this.now();
    const gen = now.getTime();
    const reconcile = !acct.watermark || !acct.lastReconcileAt || now.getTime() - Date.parse(acct.lastReconcileAt) > RECONCILE_EVERY_MS;
    const sinceIso = reconcile ? new Date(now.getTime() - s.windowDays * 86_400_000).toISOString() : new Date(Date.parse(acct.watermark!) - 2 * 86_400_000).toISOString();
    const result: SyncResult = { storeId, ok: false, indexed: 0, removed: 0, complete: true, mode: reconcile ? 'reconcile' : 'incremental' };
    try {
      let offset = 0; let newest: string | null = null;
      for (;;) {
        const page = await this.connector.list({ storeId, folder: '@inbox', sinceIso, limit: Math.min(200, s.maxPerSync - result.indexed), offset, bodyChars: s.bodyChars }, signal);
        this.db.transaction(() => { for (const m of page.messages) this.upsert(storeId, '@inbox', m, gen, s.bodyChars); });
        for (const m of page.messages) { const iso = new Date(m.received).toISOString(); if (!newest || iso > newest) newest = iso; }
        result.indexed += page.messages.length; offset += page.messages.length;
        if (!page.hasMore || page.messages.length === 0) break;
        if (result.indexed >= s.maxPerSync) { result.complete = false; break; }
      }
      // A complete scan of the window is the only evidence that a message is gone: anything not seen was moved or deleted.
      if (reconcile && result.complete) {
        const stale = this.db.all<{ id: string }>('SELECT id FROM mail_messages WHERE storeId = ? AND folder = ? AND received >= ? AND seenGen < ?', [storeId, '@inbox', sinceIso, gen]);
        this.db.transaction(() => { for (const { id } of stale) { this.db.run('DELETE FROM mail_fts WHERE msgId = ?', [id]); this.db.run('DELETE FROM mail_messages WHERE id = ?', [id]); } });
        result.removed = stale.length;
      }
      result.removed += this.prune(storeId, s);
      this.db.run('UPDATE mail_accounts SET lastSyncAt = ?, lastError = NULL, watermark = COALESCE(?, watermark), lastReconcileAt = ? WHERE storeId = ?',
        [now.toISOString(), newest, reconcile && result.complete ? now.toISOString() : acct.lastReconcileAt, storeId]);
      result.ok = true;
      this.activity('sync', storeId, true, `${result.mode}: ${result.indexed} read, ${result.removed} removed${result.complete ? '' : ', partial (limit reached)'}`);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      this.db.run('UPDATE mail_accounts SET lastError = ? WHERE storeId = ?', [result.error.slice(0, 300), storeId]);
      this.activity('sync', storeId, false, result.error);
    }
    return result;
  }

  /** Retention and the per-account cap: the oldest mail leaves the index first. */
  private prune(storeId: string, s: MailSettings): number {
    const cutoff = new Date(this.now().getTime() - s.retentionDays * 86_400_000).toISOString();
    const old = this.db.all<{ id: string }>(
      `SELECT id FROM mail_messages WHERE storeId = ? AND (received < ? OR id IN (SELECT id FROM mail_messages WHERE storeId = ? ORDER BY received DESC LIMIT -1 OFFSET ?))`, [storeId, cutoff, storeId, s.maxPerAccount]);
    this.db.transaction(() => { for (const { id } of old) { this.db.run('DELETE FROM mail_fts WHERE msgId = ?', [id]); this.db.run('DELETE FROM mail_messages WHERE id = ?', [id]); } });
    return old.length;
  }

  // ── reading the index (authorized accounts only) ────────────────────────────────────────────

  private scope(storeIds?: string[]): string[] {
    const enabled = this.enabledStoreIds();
    return storeIds?.length ? storeIds.filter((s) => enabled.includes(s)) : enabled;
  }
  private toRow(r: DbMessage): MailRow {
    return { id: r.id, storeId: r.storeId, account: r.accountName ?? '', folder: r.folder, subject: r.subject, fromName: r.fromName, fromAddress: r.fromAddress, toText: r.toText, received: r.received, unread: Boolean(r.unread),
      attachments: r.attachments, category: r.category, facts: JSON.parse(r.facts) as MailFacts, snippet: r.body.replace(/\s+/g, ' ').trim().slice(0, 220), duplicates: Math.max(0, (r.dupes ?? 1) - 1) };
  }

  /** FTS query from free text: plain words only, so nothing a user (or an email) types can become query syntax. */
  static ftsQuery(q: string): string | null {
    const words = (q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 8);
    return words.length ? words.map((w) => `"${w}"*`).join(' AND ') : null;
  }

  list(query: MailQuery): { rows: MailRow[]; total: number } {
    const stores = this.scope(query.storeIds);
    if (stores.length === 0) return { rows: [], total: 0 };
    const where: string[] = [`m.storeId IN (${stores.map(() => '?').join(',')})`];
    const params: unknown[] = [...stores];
    // One row per message even when two accounts hold the same one.
    where.push('m.id = (SELECT m2.id FROM mail_messages m2 WHERE m2.dedupeKey = m.dedupeKey AND m2.storeId IN (' + stores.map(() => '?').join(',') + ') ORDER BY m2.received DESC, m2.id LIMIT 1)');
    params.push(...stores);
    if (query.category) { where.push('m.category = ?'); params.push(query.category); }
    if (query.unreadOnly) where.push('m.unread = 1');
    if (query.needsReply) where.push(`json_extract(m.facts, '$.needsReply') = 1`);
    if (query.sinceIso) { where.push('m.received >= ?'); params.push(query.sinceIso); }
    if (query.q?.trim()) {
      const fts = MailIndex.ftsQuery(query.q);
      if (!fts) return { rows: [], total: 0 };
      where.push('m.id IN (SELECT msgId FROM mail_fts WHERE mail_fts MATCH ?)'); params.push(fts);
    }
    const w = where.join(' AND ');
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM mail_messages m WHERE ${w}`, params)?.n ?? 0;
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const rows = this.db.all<DbMessage>(
      `SELECT m.*, a.name AS accountName, (SELECT COUNT(*) FROM mail_messages d WHERE d.dedupeKey = m.dedupeKey) AS dupes
       FROM mail_messages m JOIN mail_accounts a ON a.storeId = m.storeId WHERE ${w} ORDER BY m.received DESC LIMIT ? OFFSET ?`, [...params, limit, Math.max(query.offset ?? 0, 0)]);
    return { rows: rows.map((r) => this.toRow(r)), total };
  }

  row(id: string): MailRow | null {
    const r = this.db.get<DbMessage>('SELECT m.*, a.name AS accountName FROM mail_messages m JOIN mail_accounts a ON a.storeId = m.storeId WHERE m.id = ? AND a.enabled = 1', [id]);
    return r ? this.toRow(r) : null;
  }

  /** The message as Outlook has it now (body, attachment names). Falls back to the indexed text if Outlook is unavailable. */
  async read(id: string, signal?: AbortSignal): Promise<{ row: MailRow; body: string; attachments: Array<{ name: string; size: number }>; source: 'outlook' | 'index'; note?: string } | null> {
    const r = this.db.get<DbMessage>('SELECT m.*, a.name AS accountName FROM mail_messages m JOIN mail_accounts a ON a.storeId = m.storeId WHERE m.id = ? AND a.enabled = 1', [id]);
    if (!r) return null;
    const row = this.toRow(r);
    try {
      const live = await this.connector.get({ storeId: r.storeId, entryId: r.entryId, bodyChars: 60_000 }, signal);
      this.activity('read', r.storeId, true, 'one message body read on demand');
      return { row, body: live.body, attachments: live.attachmentList, source: 'outlook' };
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      this.activity('read', r.storeId, false, note);
      return { row, body: r.body, attachments: [], source: 'index', note: `Outlook could not return the full message (${note}); showing the indexed text.` };
    }
  }

  /** The indexed text of one message of an authorized account, for a local model to read as data. */
  excerpt(id: string, chars = 3000): { row: MailRow; text: string } | null {
    const r = this.db.get<DbMessage>('SELECT m.*, a.name AS accountName FROM mail_messages m JOIN mail_accounts a ON a.storeId = m.storeId WHERE m.id = ? AND a.enabled = 1', [id]);
    return r ? { row: this.toRow(r), text: r.body.slice(0, chars) } : null;
  }

  /** Authorized accounts whose index is older than maxAgeMs (or never synced). */
  staleStoreIds(maxAgeMs: number): string[] {
    const now = this.now().getTime();
    return this.db.all<{ storeId: string; lastSyncAt: string | null }>('SELECT storeId, lastSyncAt FROM mail_accounts WHERE enabled = 1').filter((a) => !a.lastSyncAt || now - Date.parse(a.lastSyncAt) > maxAgeMs).map((a) => a.storeId);
  }

  overview() {
    const stores = this.enabledStoreIds();
    const accounts = this.knownAccounts().filter((a) => a.enabled);
    if (stores.length === 0) return { accounts, counts: { indexed: 0, unread: 0, needsReply: 0, byCategory: {} as Record<string, number> }, priority: [] as MailRow[], dateRange: null as null | { from: string; to: string } };
    const marks = stores.map(() => '?').join(',');
    const base = `FROM mail_messages m WHERE m.storeId IN (${marks}) AND m.id = (SELECT m2.id FROM mail_messages m2 WHERE m2.dedupeKey = m.dedupeKey AND m2.storeId IN (${marks}) ORDER BY m2.received DESC, m2.id LIMIT 1)`;
    const p = [...stores, ...stores];
    const one = (extra: string) => this.db.get<{ n: number }>(`SELECT COUNT(*) n ${base} ${extra}`, p)?.n ?? 0;
    const byCategory: Record<string, number> = {};
    for (const r of this.db.all<{ category: string; n: number }>(`SELECT m.category, COUNT(*) n ${base} AND m.unread = 1 GROUP BY m.category`, p)) byCategory[r.category] = r.n;
    const range = this.db.get<{ a: string | null; b: string | null }>(`SELECT MIN(m.received) a, MAX(m.received) b ${base}`, p);
    const priority = this.list({ unreadOnly: true, limit: 8 }).rows.filter((r) => r.category !== 'other' || r.facts.needsReply);
    return { accounts, counts: { indexed: one(''), unread: one('AND m.unread = 1'), needsReply: one(`AND m.unread = 1 AND json_extract(m.facts, '$.needsReply') = 1`), byCategory }, priority, dateRange: range?.a ? { from: range.a, to: range.b! } : null };
  }

  stats() { return { messages: this.db.get<{ n: number }>('SELECT COUNT(*) n FROM mail_messages')?.n ?? 0, approxBytes: this.db.get<{ n: number | null }>('SELECT SUM(length(body) + length(subject) + 400) n FROM mail_messages')?.n ?? 0 }; }
}
