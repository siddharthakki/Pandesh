import type { CoreDatabase } from './connection';

export function getMetadata<T>(db: CoreDatabase, key: string): T | undefined {
  const row = db.get<{ value: string }>('SELECT value FROM core_metadata WHERE key = ?', [key]);
  if (!row) return undefined;
  return JSON.parse(row.value) as T;
}

export function setMetadata(db: CoreDatabase, key: string, value: unknown): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO core_metadata (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    [key, JSON.stringify(value), now],
  );
}
