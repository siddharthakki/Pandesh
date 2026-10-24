// Read-only extraction of observable run signals from retained Golden evidence (core.db + golden-model-evidence.jsonl).
// Harness/reporting only: nothing here influences model behaviour. Every field is something the run recorded; a
// missing source yields empty lists, never invented values. Pure derivation lives in lib.mjs (deriveEvidenceFingerprints).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LEGACY_EVIDENCE_DIRNAME, resolveGoldenEvidenceRoot } from '../../src/ui-test/golden/goldenEvidenceRoot.mjs';
import { buildResultRecord, looksLikeVsix } from './lib.mjs';

const tryJson = text => { try { return JSON.parse(text); } catch { return null; } };

/** Latest attempt directory for a scenario under a Golden evidence root, or null. */
export function latestAttemptDir(evidenceRoot, scenario) {
  try {
    const attempts = path.join(evidenceRoot, scenario);
    const names = fs.readdirSync(attempts).filter(name => /^attempt-\d+$/.test(name)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    return names.length ? path.join(attempts, names.at(-1)) : null;
  } catch { return null; }
}

/**
 * Signals for deriveEvidenceFingerprints:
 *   events: runtime event types in order; parserFailures: [{ turn, reason, rawReply }];
 *   toolCalls: [{ name }] requested by the model; writes/reads: [{ path, bytes }];
 *   failureReasons: attempt failure reasons; toolSurface: recorded surface decision (or null).
 */
export function readRunSignals(evidenceRoot, scenario) {
  const signals = { events: [], parserFailures: [], toolCalls: [], writes: [], reads: [], failureReasons: [], toolSurface: null, available: false };
  const attemptDir = evidenceRoot ? latestAttemptDir(evidenceRoot, scenario) : null;
  if (!attemptDir) return signals;
  const evidenceFile = path.join(attemptDir, 'core-data', 'golden-model-evidence.jsonl');
  if (fs.existsSync(evidenceFile)) {
    for (const line of fs.readFileSync(evidenceFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const row = tryJson(line);
      if (!row) continue;
      for (const call of row.toolCalls ?? []) signals.toolCalls.push({ name: String(call.name) });
      if (row.parserFailure) signals.parserFailures.push({ turn: row.turn ?? null, reason: String(row.parserFailure), rawReply: String(row.rawReply ?? '') });
    }
  }
  const dbFile = path.join(attemptDir, 'core-data', 'core.db');
  if (!fs.existsSync(dbFile)) return signals;
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    signals.available = true;
    for (const row of db.prepare('SELECT eventType, metadata FROM runtime_events ORDER BY sequence').all()) {
      signals.events.push(row.eventType);
      if (row.eventType === 'mutation_policy_decided') {
        const meta = tryJson(row.metadata);
        if (meta?.toolSurface) signals.toolSurface = String(meta.toolSurface);
      }
    }
    for (const row of db.prepare('SELECT toolName, status, argsSummary, evidence FROM tool_invocations ORDER BY rowid').all()) {
      const evidence = tryJson(row.evidence) ?? {};
      const args = tryJson(row.argsSummary) ?? {};
      const normalizedPath = String(evidence.normalizedArguments?.path ?? args.path ?? '');
      if (row.toolName === 'read_file' && row.status === 'succeeded' && typeof evidence.output === 'string') {
        signals.reads.push({ path: normalizedPath, bytes: Buffer.byteLength(evidence.output, 'utf8') });
      }
      const wrote = /^Wrote (\d+) byte/.exec(String(evidence.output ?? ''));
      if ((row.toolName === 'propose_file_change' || row.toolName === 'propose_text_edit') && row.status === 'succeeded' && wrote) {
        signals.writes.push({ path: normalizedPath, bytes: Number(wrote[1]) });
      }
    }
    for (const row of db.prepare("SELECT failureReason FROM attempts WHERE failureReason IS NOT NULL AND failureReason <> ''").all()) {
      signals.failureReasons.push(String(row.failureReason));
    }
  } catch { /* evidence is best-effort; partial signals are still honest */ } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return signals;
}

/**
 * The Golden runner's outcome for one scenario: { evidenceRoot, outcome, infraText }. `evidenceRoot` comes from the
 * runner's "Evidence:" line (live) or is passed directly (re-reading retained evidence). outcome is null when no
 * golden-report.json was written - itself harness evidence.
 */
export function readGoldenOutcome({ output = '', evidenceRoot = null, scenario }) {
  const root = evidenceRoot ?? /Evidence:\s*(.+)\s*$/m.exec(output)?.[1]?.trim() ?? null;
  const reportPath = root ? path.join(root, 'golden-report.json') : null;
  if (!reportPath || !fs.existsSync(reportPath)) return { evidenceRoot: root, outcome: null, infraText: '', report: null };
  const report = tryJson(fs.readFileSync(reportPath, 'utf8'));
  const outcome = report?.outcomes?.find(item => item.scenario === scenario) ?? null;
  let infraText = '';
  const file = outcome?.evidence ? path.join(outcome.evidence, 'infrastructure-error.txt') : null;
  if (file && fs.existsSync(file)) infraText = fs.readFileSync(file, 'utf8').slice(0, 2000);
  return { evidenceRoot: root, outcome, infraText, report };
}

/**
 * Preflight of the packaged VSIX the Golden runner will install. Returns { ok, path, bytes, sha256, error }.
 * A missing, empty or non-zip file is a harness failure: no model is exercised against it.
 */
export function inspectVsix(vsixPath) {
  if (!vsixPath || !fs.existsSync(vsixPath)) return { ok: false, path: vsixPath, bytes: null, sha256: null, error: `packaged VSIX not found at ${vsixPath}` };
  const bytes = fs.readFileSync(vsixPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!looksLikeVsix(bytes)) return { ok: false, path: vsixPath, bytes: bytes.length, sha256, error: `packaged VSIX invalid (not a zip archive) at ${vsixPath}` };
  return { ok: true, path: vsixPath, bytes: bytes.length, sha256, error: null };
}

/** The frozen model-selection evidence of the scenario's latest attempt, or null when unavailable. */
export function readModelSelection(evidenceRoot, scenario) {
  const attemptDir = evidenceRoot ? latestAttemptDir(evidenceRoot, scenario) : null;
  const dbFile = attemptDir ? path.join(attemptDir, 'core-data', 'core.db') : null;
  if (!dbFile || !fs.existsSync(dbFile)) return null;
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare('SELECT modelSelection FROM attempt_contexts WHERE modelSelection IS NOT NULL ORDER BY rowid DESC LIMIT 1').get();
    return row?.modelSelection ? tryJson(row.modelSelection) : null;
  } catch { return null; } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Where a stored record's evidence can actually be read, or null. The recorded path wins when it exists. Otherwise a
 * path recorded under the legacy in-repo evidence directory (LEGACY_EVIDENCE_DIRNAME) is looked up at the same relative path under the active
 * Golden root. Read-only: the stored record is never rewritten and nothing is moved or linked.
 */
export function resolveRecordedEvidenceDir(recorded, activeRoot = resolveGoldenEvidenceRoot()) {
  if (!recorded) return null;
  if (fs.existsSync(recorded)) return recorded;
  const relative = new RegExp(`(?:^|[\\\\/])${LEGACY_EVIDENCE_DIRNAME.replace('.', '\\.')}[\\\\/](.+)$`, 'i').exec(String(recorded))?.[1];
  if (!relative) return null;
  const candidate = path.resolve(activeRoot, relative);
  const inside = path.relative(path.resolve(activeRoot), candidate);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Re-derives a stored record's verdict from its retained Golden evidence with the current classifier. Stored
 * `reason` strings are truncated, so the full failure text is re-read from golden-report.json. Timing, load and
 * identity fields are kept; nothing is re-run. Without retained evidence the record is returned unchanged.
 */
export function reclassifyRecord(record, { activeRoot = resolveGoldenEvidenceRoot() } = {}) {
  const evidenceDir = resolveRecordedEvidenceDir(record?.evidenceDir, activeRoot);
  if (!evidenceDir) return record;
  const { outcome, infraText, report } = readGoldenOutcome({ evidenceRoot: evidenceDir, scenario: record.scenario });
  const signals = readRunSignals(evidenceDir, record.scenario);
  const rebuilt = buildResultRecord({
    model: record.model, scenario: record.scenario, outcome, durationMs: record.durationMs, loadMs: record.loadMs ?? null, coldLoad: record.coldLoad ?? null,
    evidenceDir: record.evidenceDir, infraText, modelInfo: record.modelInfo ?? null, modelSelection: readModelSelection(evidenceDir, record.scenario),
    repetition: record.repetition ?? 1, signals,
    provenance: { commitSha: record.commitSha ?? report?.gitHead ?? null, vsixSha256: record.vsixSha256 ?? report?.vsix?.sha256 ?? null },
  });
  const previous = record.verdict ?? record.result;
  return {
    ...rebuilt, finishedAt: record.finishedAt ?? null, runDir: record.runDir ?? null, cohort: record.cohort ?? null,
    ...(previous !== rebuilt.verdict ? { reclassifiedFrom: previous } : {}),
  };
}
