import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildDeliveryManifest,
  findUnsafeDeliveryPaths,
  manifestDigest,
  toManifestPath,
} from './missionDeliveryManifest';

export interface DiffReviewResult {
  verdict: 'pass' | 'reject';
  summary: string;
  changedPaths: string[];
  /** Binds this review to the exact paths and contents the reviewer saw. */
  reviewDigest?: string;
}

/**
 * Reviews exactly the authorized changed-file manifest.
 *
 * Anything outside the manifest is not reviewed and therefore never
 * deliverable. Unsafe Core artifacts are rejected by path, both in the
 * manifest and in whatever is already staged.
 */
export function reviewWorkspaceDiff(workspaceRoot: string, authorizedPaths?: readonly string[] | string): DiffReviewResult {
  const requested = typeof authorizedPaths === 'string'
    ? [authorizedPaths]
    : [...(authorizedPaths ?? [])];
  const manifest = buildDeliveryManifest(requested);
  if (manifest.length === 0) {
    return { verdict: 'reject', summary: 'diff review rejected: no authorized changed-file manifest', changedPaths: [] };
  }

  const unsafe = findUnsafeDeliveryPaths(manifest);
  if (unsafe.length > 0) {
    return {
      verdict: 'reject',
      summary: `diff review rejected: ${describeUnsafe(unsafe)}`,
      changedPaths: manifest,
    };
  }

  const stagedUnsafe = findUnsafeDeliveryPaths(listStagedPaths(workspaceRoot));
  if (stagedUnsafe.length > 0) {
    return {
      verdict: 'reject',
      summary: `diff review rejected: staged ${describeUnsafe(stagedUnsafe)}`,
      changedPaths: manifest,
    };
  }

  const missing = manifest.filter((item) => !fs.existsSync(path.join(path.resolve(workspaceRoot), item)));
  if (missing.length > 0) {
    return {
      verdict: 'reject',
      summary: `diff review rejected: manifest path missing from the workspace: ${missing.join(', ')}`,
      changedPaths: manifest,
    };
  }

  const diff = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', ...manifest], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (diff.error) {
    return { verdict: 'reject', summary: `diff review unavailable: ${diff.error.message}`, changedPaths: manifest };
  }

  return {
    verdict: 'pass',
    summary: `diff review passed for ${manifest.join(', ')}`,
    changedPaths: manifest,
    reviewDigest: reviewDigestFor(workspaceRoot, manifest),
  };
}

/**
 * Digest over the manifest paths and their reviewed contents. A path added or
 * removed changes the digest; so does an edit to an already reviewed file.
 */
export function reviewDigestFor(workspaceRoot: string, manifest: readonly string[]): string {
  const root = path.resolve(workspaceRoot);
  const ordered = buildDeliveryManifest(manifest);
  const hash = crypto.createHash('sha256');
  hash.update(manifestDigest(ordered), 'utf8');
  for (const item of ordered) {
    hash.update('\0', 'utf8');
    hash.update(item, 'utf8');
    hash.update('\0', 'utf8');
    try {
      hash.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, item))).digest('hex'), 'utf8');
    } catch {
      hash.update('missing', 'utf8');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

export function listStagedPaths(workspaceRoot: string): string[] {
  const staged = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return (staged.stdout || '')
    .split(/\r?\n/)
    .map((line) => toManifestPath(line.trim()))
    .filter(Boolean);
}

function describeUnsafe(unsafe: Array<{ path: string; reason: string }>): string {
  const shown = unsafe.slice(0, 5).map((item) => `${item.path} (${item.reason})`);
  const extra = unsafe.length > shown.length ? ` and ${unsafe.length - shown.length} more` : '';
  return `unsafe artifact in delivery: ${shown.join(', ')}${extra}`;
}
