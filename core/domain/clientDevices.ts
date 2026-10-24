import type { CoreDatabase } from '../db/connection';
import type { ClientDeviceRecord, ClientType } from '../shared/wireTypes';
import { nowIso } from './ids';

const SUPPORTED_CLIENT_TYPES: ClientType[] = ['vscode', 'desktop', 'ios', 'headless'];

/**
 * Upserts a client_devices row. Never stores the auth token (per M31 §5) —
 * only identity/version/label metadata used for diagnostics.
 */
export function registerClientDevice(
  db: CoreDatabase,
  input: { id: string; clientType: ClientType; clientVersion: string; deviceLabel?: string | null },
): ClientDeviceRecord {
  const compatibilityStatus = SUPPORTED_CLIENT_TYPES.includes(input.clientType) ? 'compatible' : 'incompatible';
  const now = nowIso();
  const existing = db.get<Record<string, unknown>>('SELECT id FROM client_devices WHERE id = ?', [input.id]);
  if (existing) {
    db.run(
      'UPDATE client_devices SET clientVersion = ?, lastSeenAt = ?, deviceLabel = ?, compatibilityStatus = ? WHERE id = ?',
      [input.clientVersion, now, input.deviceLabel ?? null, compatibilityStatus, input.id],
    );
  } else {
    db.run(
      `INSERT INTO client_devices (id, clientType, clientVersion, firstSeenAt, lastSeenAt, deviceLabel, compatibilityStatus)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.clientType, input.clientVersion, now, now, input.deviceLabel ?? null, compatibilityStatus],
    );
  }
  const row = db.get<Record<string, unknown>>('SELECT * FROM client_devices WHERE id = ?', [input.id])!;
  return {
    id: String(row.id),
    clientType: row.clientType as ClientType,
    clientVersion: String(row.clientVersion),
    firstSeenAt: String(row.firstSeenAt),
    lastSeenAt: String(row.lastSeenAt),
    deviceLabel: (row.deviceLabel as string) ?? null,
    compatibilityStatus: row.compatibilityStatus as 'compatible' | 'incompatible',
  };
}
