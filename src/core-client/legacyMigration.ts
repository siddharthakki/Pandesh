import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { CoreClient } from './CoreClient';
import type { LegacyImportRequest, LegacyImportResult, LegacyStoryRecord } from '../../core/migration/importLegacyBoard';

/**
 * One-time-per-source migration of the legacy `LocalStoryStore` JSON
 * (src/stories/LocalStoryStore.ts) into the Core. Runs on activation for
 * whichever workspace is currently open; each independently-opened legacy
 * workspace gets migrated the same way, idempotently, on its own schedule —
 * there is no requirement to migrate every legacy workspace up front. The
 * legacy file is read raw (not through LocalStoryStore's own strict
 * loader, which throws on the first malformed record) so malformed
 * individual records can be skipped server-side without losing valid ones.
 * The original file is never deleted or modified; a durable backup is
 * written once (first-write-wins) before the import call.
 */
export async function migrateLegacyBoardIfPresent(
  storageRoot: string,
  client: CoreClient,
  log: (message: string) => void = () => {},
): Promise<LegacyImportResult | undefined> {
  const legacyPath = path.join(storageRoot, '.ollama-agent', 'board', 'local-stories.json');
  let raw: string;
  try {
    raw = await fs.readFile(legacyPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log(`legacy Board migration: failed to read ${legacyPath}: ${(err as Error).message}`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`legacy Board migration: ${legacyPath} is not valid JSON; skipping (original left untouched)`);
    return undefined;
  }

  const records = extractLegacyRecords(parsed);
  if (records.length === 0) {
    log(`legacy Board migration: ${legacyPath} has no stories to migrate`);
    return undefined;
  }

  const sourcePathCanonical = path.resolve(legacyPath);
  const contentDigest = crypto.createHash('sha256').update(raw).digest('hex');

  await writeBackupIfAbsent(legacyPath, raw);

  // Each call gets its own HTTP idempotency key: the (sourcePathCanonical, contentDigest) check
  // inside importLegacyBoard itself — not the generic per-request HTTP idempotency cache — is the
  // authoritative "already migrated this source" answer. Reusing one fixed key across separate
  // activations would make the HTTP layer return the *first* call's cached response forever,
  // masking the Core's own dedup result.
  const request: LegacyImportRequest = { sourcePathCanonical, contentDigest, records };
  const result = await client.request<LegacyImportResult>('/v1/migration/import-legacy', {
    method: 'POST',
    idempotencyKey: `legacy-import-${contentDigest}-${crypto.randomUUID()}`,
    body: request,
  });

  log(
    result.alreadyCompleted
      ? `legacy Board migration: ${legacyPath} already migrated (project ${result.projectId})`
      : `legacy Board migration: ${legacyPath} -> project ${result.projectId}: ${result.recordsMigrated} migrated, ${result.recordsSkipped} skipped, ${result.recordsFailed} failed`,
  );
  return result;
}

function extractLegacyRecords(parsed: unknown): LegacyStoryRecord[] {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { stories?: unknown }).stories)) {
    return [];
  }
  return (parsed as { stories: unknown[] }).stories.filter((s): s is LegacyStoryRecord => typeof s === 'object' && s !== null);
}

async function writeBackupIfAbsent(legacyPath: string, raw: string): Promise<void> {
  const backupPath = `${legacyPath}.migration-backup`;
  if (fsSync.existsSync(backupPath)) return;
  const tmpPath = `${backupPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, raw, 'utf8');
  await fs.rename(tmpPath, backupPath);
}
