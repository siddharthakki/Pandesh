/**
 * JUGAAD bridge services. Registered like every other service (task id, state, cancel, deadline, receipt, capability registry),
 * but marked `internal`: only Core itself or the Pandesh app can start them. A paired browser cannot, and nothing in the
 * deterministic intent router can name them. They take a household id and an inbox file NAME, never a path, and resolve both
 * inside that household's own folder.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BridgeService, ServiceOutput } from '../kandev/bridgeServices';
import { upsertCompanionRecord } from '../../domain/companionSync';
import { ingestDocument, reprocessDocument } from './documentIntake';
import { HOUSEHOLD_ID, householdDirs, jugaadRoot } from './households';

/** The phone-visible status of an intake task (household-scoped record id). */
function publishStatus(db: import('../../db/connection').CoreDatabase, householdId: string, taskId: string | undefined, state: 'completed' | 'failed', extra: Record<string, unknown>): void {
  if (!taskId) return;
  upsertCompanionRecord(db, { recordId: `${householdId}:task:${taskId}`, kind: 'task_status', payload: { taskId, workflow: 'document-intake', state, at: new Date().toISOString(), ...extra } });
}

export function jugaadServices(defaultDataDir: string): BridgeService[] {
  const root = jugaadRoot(defaultDataDir);
  return [{
    id: 'jugaad.ingest', label: 'JUGAAD document intake (local: detect, text, receipt fields, index)', readOnly: false, internal: true,
    taskClasses: ['document.ingest'], roots: [root],
    async run({ args, signal, db, taskId, dataDir: runDataDir }): Promise<ServiceOutput> {
      if (!db) throw new Error('document intake needs the Core database');
      const dataDir = runDataDir ?? defaultDataDir;
      const hid = String(args.householdId ?? '');
      if (!HOUSEHOLD_ID.test(hid)) throw new Error('args.householdId is required');
      const name = String(args.file ?? '');
      if (!name || name !== path.basename(name)) throw new Error('args.file must be a file name inside the household inbox');
      const file = path.join(householdDirs(dataDir, hid).inbox, name);
      if (!fs.existsSync(file)) throw new Error('the document is not in the household inbox');
      try {
        const r = await ingestDocument(db, dataDir, hid, file, { signal, source: 'phone', displayName: name.replace(/^[0-9a-f]{8}-/, '') });
        publishStatus(db, hid, taskId, 'completed', { documentId: r.document.id, duplicate: !r.created });
        const f = r.receipt && r.receipt.matchedBy.length ? r.receipt : null;
        return {
          summary: r.created
            ? `Indexed ${r.document.typeLabel}${f?.merchant ? ` from ${f.merchant}` : ''}${f?.totalCents !== undefined ? `, ${(f.totalCents / 100).toFixed(2)} ${f.currency ?? ''}`.trimEnd() : ''}`
            : 'Already in the household index (same content)',
          evidence: { kind: 'document-intake', documentId: r.document.id, created: r.created, type: r.document.typeLabel, textSource: r.document.textSource, textChars: r.document.textChars, fields: f, steps: r.steps },
          verification: r.verification,
        };
      } catch (err) {
        publishStatus(db, hid, taskId, 'failed', { message: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        throw err;
      }
    },
  }, {
    id: 'jugaad.reprocess', label: 'JUGAAD document reprocess (owner-authorised: re-run extraction and parsing on the preserved original)', readOnly: false, internal: true,
    taskClasses: ['document.reprocess'], roots: [root],
    async run({ args, signal, db, taskId, dataDir: runDataDir }): Promise<ServiceOutput> {
      if (!db) throw new Error('document reprocess needs the Core database');
      const dataDir = runDataDir ?? defaultDataDir;
      const hid = String(args.householdId ?? '');
      if (!HOUSEHOLD_ID.test(hid)) throw new Error('args.householdId is required');
      const documentId = String(args.documentId ?? '');
      if (!/^doc_[\w-]{8,64}$/.test(documentId)) throw new Error('args.documentId is required');
      try {
        const r = await reprocessDocument(db, dataDir, hid, documentId, { by: String(args.by ?? 'host'), reason: typeof args.reason === 'string' ? args.reason : null, signal });
        publishStatus(db, hid, taskId, 'completed', { documentId, workflow: 'document-reprocess', outcome: r.outcome });
        return {
          summary: r.outcome === 'updated' ? `Reprocessed: ${r.changes.length} field(s) changed` : r.outcome === 'unchanged' ? 'Reprocessed: nothing changed' : 'Reprocessed: the new run found no text, so the previous result was kept',
          evidence: { kind: 'document-reprocess', documentId, outcome: r.outcome, changes: r.changes, runId: r.runId, pipelineVersion: r.pipelineVersion, steps: r.steps },
          verification: r.verification,
        };
      } catch (err) {
        publishStatus(db, hid, taskId, 'failed', { documentId, workflow: 'document-reprocess', message: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        throw err;
      }
    },
  }];
}
