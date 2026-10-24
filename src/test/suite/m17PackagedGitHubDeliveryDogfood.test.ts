import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  assertAuthoritativePullRequest,
  assertRunOwnedCleanupTargets,
  createPackagedDogfoodIdentity,
  M17_DOGFOOD_BASE_BRANCH,
  M17_DOGFOOD_REPOSITORY,
  M17_PACKAGED_DOGFOOD_OPT_IN,
  runPackagedDogfoodCleanup,
  validatePackagedDogfoodInputs,
} from '../../acceptance/M17GitHubDeliveryDogfood';

const open = {
  number: 41, url: 'https://github.com/siddharthakki/ollama-agent/pull/41', state: 'OPEN', isDraft: true,
  baseRefName: M17_DOGFOOD_BASE_BRANCH, headRefName: 'dogfood/m17-packaged-run', headRefOid: 'a'.repeat(40), mergedAt: null,
};
const expected = { number: 41, url: open.url, baseBranch: M17_DOGFOOD_BASE_BRANCH, headBranch: open.headRefName, commitSha: open.headRefOid };

describe('M17 packaged GitHub delivery dogfood boundary', () => {
  it('refuses the disabled path before external work', () => {
    expect(() => validatePackagedDogfoodInputs(M17_DOGFOOD_REPOSITORY, M17_DOGFOOD_BASE_BRANCH, {})).toThrow(M17_PACKAGED_DOGFOOD_OPT_IN);
  });
  it('rejects repository and base branch mismatches', () => {
    const env = { [M17_PACKAGED_DOGFOOD_OPT_IN]: '1' };
    expect(() => validatePackagedDogfoodInputs('someone/else', M17_DOGFOOD_BASE_BRANCH, env)).toThrow('allowlist');
    expect(() => validatePackagedDogfoodInputs(M17_DOGFOOD_REPOSITORY, 'master', env)).toThrow('base branch');
  });
  it('generates unique bounded run-owned identities', () => {
    const a = createPackagedDogfoodIdentity(new Date(1), 'first');
    const b = createPackagedDogfoodIdentity(new Date(1), 'second');
    expect(a).not.toEqual(b);
    expect(a.branch.length).toBeLessThanOrEqual(100);
    expect(a.branch).toMatch(/^dogfood\/m17-packaged-/);
  });
  it.each([
    ['metadata identity', { ...open, number: 42 }],
    ['non-draft', { ...open, isDraft: false }],
    ['base', { ...open, baseRefName: 'master' }],
    ['head', { ...open, headRefName: 'other' }],
    ['sha', { ...open, headRefOid: 'b'.repeat(40) }],
    ['merged', { ...open, state: 'CLOSED', mergedAt: '2026-01-01T00:00:00Z' }],
  ])('fails authoritative %s mismatch', (_label, value) => {
    expect(() => assertAuthoritativePullRequest(value, expected)).toThrow();
  });
  it('accepts closed, draft, never-merged authoritative metadata', () => {
    expect(() => assertAuthoritativePullRequest({ ...open, state: 'CLOSED' }, { ...expected, closed: true })).not.toThrow();
  });
  it('continues bounded cleanup after a partial failure', async () => {
    const calls: string[] = [];
    const errors = await runPackagedDogfoodCleanup([
      { label: 'first', run: async () => { calls.push('first'); throw new Error('partial failure'); } },
      { label: 'second', run: async () => { calls.push('second'); } },
    ]);
    expect(calls).toEqual(['first', 'second']);
    expect(errors).toEqual(['first: partial failure']);
  });
  it('rejects cleanup targets that are not the exact run-owned resources', () => {
    const owned = { runId: '123-safe', branch: 'dogfood/m17-packaged-123-safe', worktree: 'C:\\temp\\123-safe' };
    expect(() => assertRunOwnedCleanupTargets(owned, owned)).not.toThrow();
    expect(() => assertRunOwnedCleanupTargets({ ...owned, branch: 'user/branch' }, owned)).toThrow('run-owned');
    expect(() => assertRunOwnedCleanupTargets({ ...owned, worktree: 'C:\\other' }, owned)).toThrow('run-owned');
  });
  it('is excluded from the normal verify command', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts.verify).not.toContain('packaged-github-delivery');
    expect(manifest.scripts.verify).not.toContain(M17_PACKAGED_DOGFOOD_OPT_IN);
  });
});
