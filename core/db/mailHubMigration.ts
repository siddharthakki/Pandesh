/**
 * Mail Hub (read-only): the local index of mail read through Classic Outlook. Bounded (see core/runtime/mail/mailIndex.ts),
 * one row per message per Outlook store, deduplicated on the internet message id; bodies are capped plain text and are
 * never written to logs. mail_activity is the audit trail (health, sync, inference) and holds no message text.
 */
export const MIGRATION_54_MAIL_HUB = `
CREATE TABLE IF NOT EXISTS mail_accounts (
  storeId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  authorizedAt TEXT,
  lastSyncAt TEXT,
  lastReconcileAt TEXT,
  watermark TEXT,
  lastError TEXT
);
CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  storeId TEXT NOT NULL,
  folder TEXT NOT NULL,
  entryId TEXT NOT NULL,
  dedupeKey TEXT NOT NULL,
  conversationId TEXT,
  subject TEXT NOT NULL,
  fromName TEXT NOT NULL,
  fromAddress TEXT NOT NULL,
  toText TEXT NOT NULL,
  received TEXT NOT NULL,
  unread INTEGER NOT NULL,
  attachments INTEGER NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  facts TEXT NOT NULL,
  seenGen INTEGER NOT NULL,
  indexedAt TEXT NOT NULL,
  UNIQUE(storeId, dedupeKey)
);
CREATE INDEX IF NOT EXISTS idx_mail_received ON mail_messages(received DESC);
CREATE INDEX IF NOT EXISTS idx_mail_store_received ON mail_messages(storeId, received DESC);
CREATE INDEX IF NOT EXISTS idx_mail_category ON mail_messages(category, received DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
  subject, sender, body, msgId UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS mail_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  storeId TEXT,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL
);
`;
