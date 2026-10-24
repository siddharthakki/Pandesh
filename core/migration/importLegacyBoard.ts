import type { CoreDatabase } from '../db/connection';
import type { StoryStatus } from '../shared/wireTypes';
import { getOrCreateImportedDefaultProject, resolveProjectReference } from '../domain/projects';
import { createStory } from '../domain/stories';
import { recordStoryEvent } from '../domain/events';
import { newId, nowIso } from '../domain/ids';

/** Shape of a single record from the legacy `LocalStoryStore` JSON file (src/stories/LocalStoryStore.ts). Loosely typed and defensively read since legacy records may be malformed. */
export interface LegacyStoryRecord {
  id?: unknown;
  title?: unknown;
  goal?: unknown;
  acceptanceCriteria?: unknown;
  status?: unknown;
  source?: unknown;
  sourceConversationId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  blockedReason?: unknown;
}

export interface LegacyImportRequest {
  sourcePathCanonical: string;
  contentDigest: string;
  projectHint?: string;
  records: LegacyStoryRecord[];
}

export interface LegacyImportPerRecordResult {
  legacyId: string | null;
  outcome: 'migrated' | 'skipped' | 'failed';
  reason?: string;
}

export interface LegacyImportResult {
  sourcePathCanonical: string;
  projectId: string;
  recordsMigrated: number;
  recordsSkipped: number;
  recordsFailed: number;
  perRecord: LegacyImportPerRecordResult[];
  alreadyCompleted: boolean;
}

const STATUS_MAP: Record<string, StoryStatus> = {
  backlog: 'inbox',
  ready: 'ready',
  in_progress: 'implementing',
  review: 'review',
  blocked: 'blocked',
  done: 'done',
};

function mapLegacyStatus(status: unknown): StoryStatus {
  if (typeof status === 'string' && STATUS_MAP[status]) return STATUS_MAP[status];
  return 'inbox';
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Imports one legacy Board JSON source into the Core, idempotently keyed by
 * (sourcePathCanonical, contentDigest). Malformed individual records are
 * skipped/failed without aborting the rest of the batch — each record is
 * migrated via its own `createStory` call, which is itself transactional,
 * so a failure partway through never leaves a half-written story. Legacy
 * IDs are reused as the new story's ID where possible (both to satisfy
 * "preserve IDs where safe" and to make re-imports of a not-yet-completed
 * source naturally idempotent per record.
 */
export function importLegacyBoard(db: CoreDatabase, request: LegacyImportRequest): LegacyImportResult {
  const existing = db.get<{ status: string; projectId: string; recordsMigrated: number; recordsSkipped: number; recordsFailed: number }>(
    'SELECT status, projectId, recordsMigrated, recordsSkipped, recordsFailed FROM legacy_migration_sources WHERE sourcePathCanonical = ? AND contentDigest = ?',
    [request.sourcePathCanonical, request.contentDigest],
  );
  if (existing && existing.status === 'completed') {
    return {
      sourcePathCanonical: request.sourcePathCanonical,
      projectId: existing.projectId,
      recordsMigrated: existing.recordsMigrated,
      recordsSkipped: existing.recordsSkipped,
      recordsFailed: existing.recordsFailed,
      perRecord: [],
      alreadyCompleted: true,
    };
  }

  const project = request.projectHint ? resolveProjectReference(db, request.projectHint) : undefined;
  const resolvedProject = project ?? getOrCreateImportedDefaultProject(db);

  const perRecord: LegacyImportPerRecordResult[] = [];
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of request.records ?? []) {
    const legacyId = typeof record.id === 'string' ? record.id : null;
    try {
      if (!legacyId) {
        perRecord.push({ legacyId: null, outcome: 'failed', reason: 'record has no id' });
        failed += 1;
        continue;
      }
      if (typeof record.title !== 'string' || record.title.trim().length === 0) {
        perRecord.push({ legacyId, outcome: 'failed', reason: 'record has no title' });
        failed += 1;
        continue;
      }

      const alreadyMigrated = db.get('SELECT id FROM stories WHERE id = ?', [legacyId]);
      if (alreadyMigrated) {
        perRecord.push({ legacyId, outcome: 'skipped', reason: 'already migrated in a prior partial run' });
        skipped += 1;
        continue;
      }

      const createdAt = isIsoDateString(record.createdAt) ? record.createdAt : nowIso();
      const updatedAt = isIsoDateString(record.updatedAt) ? record.updatedAt : createdAt;
      const acceptanceCriteria = Array.isArray(record.acceptanceCriteria)
        ? record.acceptanceCriteria.filter((v): v is string => typeof v === 'string')
        : [];

      const created = createStory(db, {
        projectId: resolvedProject.id,
        title: record.title,
        description: typeof record.goal === 'string' ? record.goal : '',
        acceptanceCriteria,
        status: mapLegacyStatus(record.status),
        storyType: 'story',
        actor: 'migration:legacy-local-story-store',
        source: {
          migratedFrom: 'legacy-local-story-store',
          sourcePathCanonical: request.sourcePathCanonical,
          legacyId,
          legacySource: typeof record.source === 'string' ? record.source : null,
          legacySourceConversationId: typeof record.sourceConversationId === 'string' ? record.sourceConversationId : null,
          legacyBlockedReason: typeof record.blockedReason === 'string' ? record.blockedReason : null,
        },
        presetId: legacyId,
        createdAtOverride: createdAt,
        updatedAtOverride: updatedAt,
      });

      recordStoryEvent(db, {
        storyId: created.id,
        eventType: 'migration_imported',
        actor: 'migration:legacy-local-story-store',
        metadata: { sourcePathCanonical: request.sourcePathCanonical, legacyId },
        resultingRevision: created.revision,
      });

      perRecord.push({ legacyId, outcome: 'migrated' });
      migrated += 1;
    } catch (err) {
      perRecord.push({ legacyId, outcome: 'failed', reason: (err as Error).message });
      failed += 1;
    }
  }

  const now = nowIso();
  if (existing) {
    db.run(
      `UPDATE legacy_migration_sources SET importedAt = ?, projectId = ?, recordsMigrated = ?, recordsSkipped = ?, recordsFailed = ?, status = 'completed'
       WHERE sourcePathCanonical = ? AND contentDigest = ?`,
      [now, resolvedProject.id, migrated, skipped, failed, request.sourcePathCanonical, request.contentDigest],
    );
  } else {
    db.run(
      `INSERT INTO legacy_migration_sources (id, sourcePathCanonical, contentDigest, importedAt, projectId, recordsMigrated, recordsSkipped, recordsFailed, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [
        newId('legacysrc'),
        request.sourcePathCanonical,
        request.contentDigest,
        now,
        resolvedProject.id,
        migrated,
        skipped,
        failed,
      ],
    );
  }

  return {
    sourcePathCanonical: request.sourcePathCanonical,
    projectId: resolvedProject.id,
    recordsMigrated: migrated,
    recordsSkipped: skipped,
    recordsFailed: failed,
    perRecord,
    alreadyCompleted: false,
  };
}
