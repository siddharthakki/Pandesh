// The single authority for where Golden / model-bench run evidence lives.
//
// Evidence is large (every run keeps a full VS Code profile) so it must never live inside the repository:
// vsce and other tree walkers would traverse it on every package. Nothing else may build a `.golden-evidence`
// path; ask this module.
//
//   1. KKD_GOLDEN_EVIDENCE_ROOT, when set and non-blank, is used exactly (resolved to an absolute path).
//   2. Otherwise the per-user KarkeDikha data directory, same convention as core/env/dataDir.ts:
//        win32  : %LOCALAPPDATA%\KarkeDikha\golden-evidence
//        others : $XDG_DATA_HOME/karkedikha/golden-evidence, else ~/.local/share/karkedikha/golden-evidence
//
// There is deliberately no repository-local fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GOLDEN_EVIDENCE_ENV = 'KKD_GOLDEN_EVIDENCE_ROOT';
export const LEGACY_EVIDENCE_DIRNAME = '.golden-evidence';

const present = value => typeof value === 'string' && value.trim().length > 0;

/** `env`, `platform` and `homedir` are injectable so tests never touch the real per-user location. */
export function resolveGoldenEvidenceRoot({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (present(env[GOLDEN_EVIDENCE_ENV])) return path.resolve(env[GOLDEN_EVIDENCE_ENV]);
  if (platform === 'win32') {
    const localAppData = present(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(localAppData, 'KarkeDikha', 'golden-evidence');
  }
  const dataHome = present(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.posix.join(homedir, '.local', 'share');
  return path.posix.join(dataHome, 'karkedikha', 'golden-evidence');
}

/** The old in-repo location. Detection is a single stat: it never lists, reads, moves or deletes anything. */
export function detectLegacyGoldenEvidence(repoRoot) {
  const legacyPath = path.join(repoRoot, LEGACY_EVIDENCE_DIRNAME);
  try {
    return fs.statSync(legacyPath).isDirectory() ? legacyPath : null;
  } catch {
    return null;
  }
}

/** Human-readable, non-destructive notice, or null when there is no legacy directory. */
export function legacyGoldenEvidenceWarning(repoRoot, activeRoot = resolveGoldenEvidenceRoot()) {
  const legacyPath = detectLegacyGoldenEvidence(repoRoot);
  if (!legacyPath) return null;
  return [
    `NOTE: legacy repository-local Golden evidence exists at ${legacyPath}.`,
    `It is NOT read, written, moved or deleted. New evidence goes to ${activeRoot}.`,
    'Large trees inside the repository slow packaging; to migrate, move it manually when no run is active',
    `(see docs/GOLDEN_EVIDENCE_ROOT.md), e.g. robocopy "${legacyPath}" "${activeRoot}" /E /MOVE.`,
  ].join('\n');
}

/** One Golden runner invocation's evidence root (one per model-bench repetition). The random suffix makes it
 * unique even when two invocations start in the same millisecond; names still sort by start time. */
export function goldenRunRootUnder(evidenceRoot, now, unique) {
  return path.join(evidenceRoot, `${now.toISOString().replace(/[:.]/g, '-')}-${unique}`);
}
