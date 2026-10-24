import * as fs from 'fs';
import type { QualificationEvidence } from '../../core/domain/empiricalRouting';

/** Evidence by exact lowercased model name. */
export type QualificationEvidenceMap = ReadonlyMap<string, QualificationEvidence>;

export const QUALIFICATION_EVIDENCE_ENV = 'KKD_QUALIFICATION_EVIDENCE';
export const QUALIFICATION_EVIDENCE_FILE = 'model-qualification-evidence.json';

const EMPTY: QualificationEvidenceMap = new Map();

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * Reads router-facing benchmark evidence written by `scripts/model-bench/export-qualification-evidence.mjs`.
 * Routing must work with no evidence at all, so a missing, unreadable, malformed or wrong-schema file yields an
 * empty map and never throws; individually invalid entries are skipped rather than trusted.
 */
export function parseQualificationEvidence(raw: unknown): QualificationEvidenceMap {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const body = raw as { schemaVersion?: unknown; models?: unknown };
  if (body.schemaVersion !== 1 || !body.models || typeof body.models !== 'object') return EMPTY;
  const result = new Map<string, QualificationEvidence>();
  for (const [name, entry] of Object.entries(body.models as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const passCount = count(record.passCount);
    const sampleCount = count(record.sampleCount);
    const scenarioCount = count(record.scenarioCount);
    if (passCount === undefined || sampleCount === undefined || scenarioCount === undefined || passCount > sampleCount) continue;
    const median = typeof record.medianDurationMs === 'number' && Number.isFinite(record.medianDurationMs) && record.medianDurationMs > 0
      ? record.medianDurationMs
      : undefined;
    result.set(name.trim().toLowerCase(), { passCount, sampleCount, scenarioCount, ...(median !== undefined ? { medianDurationMs: median } : {}) });
  }
  return result;
}

export function loadQualificationEvidence(filePath: string | undefined): QualificationEvidenceMap {
  const resolved = process.env[QUALIFICATION_EVIDENCE_ENV]?.trim() || filePath;
  if (!resolved) return EMPTY;
  try {
    return parseQualificationEvidence(JSON.parse(fs.readFileSync(resolved, 'utf8')));
  } catch {
    return EMPTY;
  }
}
