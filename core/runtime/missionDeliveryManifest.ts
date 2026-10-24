/**
 * The authorized changed-file manifest for mission delivery.
 *
 * Delivery stages exactly the paths Core approved, never a broad workspace
 * sweep. Review and commit are bound to the same manifest digest so a file
 * introduced or changed after review cannot reach the commit.
 *
 * Core-generated browser profiles, caches, cookies, login journals, and
 * credential-adjacent artifacts are rejected by path alone. Their contents
 * are never opened, printed, or retained.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';

/** Repository-relative path in POSIX form. */
export type ManifestPath = string;

export interface UnsafeDeliveryPath {
  path: ManifestPath;
  reason: string;
}

/** Core's own browser-verification output root inside a workspace. */
const CORE_BROWSER_DIR_SEGMENTS = ['.tmp', 'karkedikha-browser'];

const CREDENTIAL_ADJACENT_NAMES = new Set([
  'cookies',
  'cookies-journal',
  'login data',
  'login data-journal',
  'login data for account',
  'login data for account-journal',
  'web data',
  'web data-journal',
  'trust tokens',
  'trust tokens-journal',
  'credentials',
  'id_rsa',
  '.npmrc',
  '.netrc',
  'credentials.env',
]);

const CREDENTIAL_ADJACENT_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)[^/]*\.pem$/i,
  /(^|\/)[^/]*\.pfx$/i,
  /(^|\/)[^/]*\.p12$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
];

/** Browser-profile shaped subtrees, wherever a Core profile was written. */
const BROWSER_PROFILE_MARKERS = [
  'crashpad',
  'dawngraphitecache',
  'dawnwebgpucache',
  'gpucache',
  'code cache',
  'service worker',
  'local storage',
  'session storage',
  'shared dictionary',
  'extension rules',
  'extension scripts',
  'extension state',
  'local extension settings',
  'persistentorigintrials',
  'site characteristics database',
  'safe browsing',
  'network',
];

export function toManifestPath(relative: string): ManifestPath {
  return relative.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** True when `relative` sits under Core's own browser output directory. */
function isCoreBrowserArtifact(segments: string[]): boolean {
  for (let i = 0; i + CORE_BROWSER_DIR_SEGMENTS.length <= segments.length; i += 1) {
    const window = segments.slice(i, i + CORE_BROWSER_DIR_SEGMENTS.length);
    if (window.every((segment, index) => segment === CORE_BROWSER_DIR_SEGMENTS[index])) return true;
  }
  return false;
}

function looksLikeBrowserProfile(segments: string[]): boolean {
  const lower = segments.map((segment) => segment.toLowerCase());
  const hasProfileDir = lower.some((segment) => /^profile[-_.]?\d*$/.test(segment) || segment === 'default');
  if (!hasProfileDir) return false;
  return lower.some((segment) => BROWSER_PROFILE_MARKERS.includes(segment))
    || lower.some((segment) => CREDENTIAL_ADJACENT_NAMES.has(segment));
}

/**
 * Classifies one repository-relative path. Path-based only: the file is never
 * opened, so cookie and login-journal contents are never read or retained.
 */
export function classifyUnsafeDeliveryPath(relative: string): string | null {
  const normalized = toManifestPath(relative);
  if (!normalized) return 'empty path';
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return 'path escapes the repository';
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('..')) return 'path escapes the repository';
  if (segments.includes('.git')) return 'git metadata is not deliverable';

  if (isCoreBrowserArtifact(segments)) {
    return 'Core browser-verification artifact';
  }
  if (looksLikeBrowserProfile(segments)) {
    return 'browser profile artifact';
  }
  const name = segments[segments.length - 1]?.toLowerCase() ?? '';
  if (CREDENTIAL_ADJACENT_NAMES.has(name)) {
    return 'credential-adjacent artifact';
  }
  if (CREDENTIAL_ADJACENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'credential-adjacent artifact';
  }
  return null;
}

export function findUnsafeDeliveryPaths(paths: readonly string[]): UnsafeDeliveryPath[] {
  const unsafe: UnsafeDeliveryPath[] = [];
  for (const candidate of paths) {
    const reason = classifyUnsafeDeliveryPath(candidate);
    if (reason) unsafe.push({ path: toManifestPath(candidate), reason });
  }
  return unsafe;
}

/** Sorted, de-duplicated, normalized manifest. Order is stable for digesting. */
export function buildDeliveryManifest(approvedPaths: readonly string[]): ManifestPath[] {
  const unique = new Set<ManifestPath>();
  for (const candidate of approvedPaths) {
    const normalized = toManifestPath(candidate);
    if (normalized) unique.add(normalized);
  }
  return [...unique].sort();
}

export function manifestDigest(paths: readonly string[]): string {
  const canonical = buildDeliveryManifest(paths).join('\n');
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** True when two path sets are identical as manifests. */
export function manifestsMatch(left: readonly string[], right: readonly string[]): boolean {
  return manifestDigest(left) === manifestDigest(right);
}
