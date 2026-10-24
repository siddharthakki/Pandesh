import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// @ts-expect-error plain ESM helper module without type declarations
import { generateWsb, validateGuestReport, validateWsbText, validateWsbHostFolders, GUEST } from '../scripts/sandbox-smoke/sandbox-smoke-lib.mjs';
// @ts-expect-error plain ESM helper module without type declarations
import { MANDATORY_BUNDLE_FILES, buildReleaseManifest, verifyReleaseManifest } from '../scripts/lib/release-manifest.mjs';

const required: string[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'sandbox-smoke', 'expected-checks.json'), 'utf8')).requiredChecks;
const sha = 'A'.repeat(64);

function stageDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-test-'));
  const dirs = ['installer', 'test', 'results', 'logs'].map((name) => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; });
  fs.writeFileSync(path.join(dirs[0], GUEST.installerFile), 'x');
  return { root, installerDir: dirs[0], testDir: dirs[1], resultsDir: dirs[2], logsDir: dirs[3], installerSha256: sha };
}

function goodReport() {
  return {
    ok: true,
    environment: { powershellVersion: '5.1.26100.1' },
    evidence: { installerSha256: sha },
    checks: required.map((name) => ({ name, status: 'PASS', detail: 'ok' })),
  };
}

describe('Windows Sandbox launcher configuration', () => {
  it('maps existing directories (never the installer file) and validates cleanly', () => {
    const input = stageDirs();
    const xml = generateWsb(input);
    expect(validateWsbText(xml)).toEqual([]);
    expect(validateWsbHostFolders(xml)).toEqual([]);
    expect(xml).not.toContain('\\\\\\\\');
    expect(xml).not.toMatch(/<HostFolder>[^<]*\.exe<\/HostFolder>/);
    expect(xml).toContain('<AudioInput>Disable</AudioInput>');
    expect(xml).not.toContain('AudioInputRedirection');
  });

  it('escapes XML metacharacters in paths and rejects a file used as HostFolder', () => {
    const input = stageDirs();
    expect(generateWsb({ ...input, installerDir: path.join(input.root, 'a&b') })).toContain('a&amp;b');
    const asFile = generateWsb({ ...input, installerDir: path.join(input.installerDir, GUEST.installerFile) });
    expect(validateWsbText(asFile).join()).toMatch(/looks like a file/);
    expect(validateWsbHostFolders(asFile).join()).toMatch(/not a directory/);
  });

  it('requires the installer folder to hold only the installer', () => {
    const input = stageDirs();
    fs.writeFileSync(path.join(input.installerDir, 'extra.txt'), 'y');
    expect(validateWsbHostFolders(generateWsb(input)).join()).toMatch(/only Pandesh-Setup\.exe/);
  });
});

describe('guest report acceptance', () => {
  const ctx = { requiredChecks: required, installerSha256: sha };
  it('accepts a complete all-PASS report from Windows PowerShell 5.1', () => {
    expect(validateGuestReport(goodReport(), ctx).ok).toBe(true);
  });
  it.each([
    ['a SKIP', (r: any) => { r.checks[required.indexOf('MissingOllamaHandling')].status = 'SKIP'; }],
    ['a FAIL', (r: any) => { r.checks[3].status = 'FAIL'; }],
    ['a missing required check', (r: any) => { r.checks.splice(5, 1); }],
    ['an unexpected check', (r: any) => { r.checks.push({ name: 'Extra', status: 'PASS' }); }],
    ['PowerShell 7', (r: any) => { r.environment.powershellVersion = '7.4.1'; }],
    ['a different installer hash', (r: any) => { r.evidence.installerSha256 = 'B'.repeat(64); }],
    ['a guest that claims failure', (r: any) => { r.ok = false; }],
  ])('rejects %s', (_label, mutate) => {
    const report = goodReport();
    mutate(report);
    expect(validateGuestReport(report, ctx).ok).toBe(false);
  });
  it('rejects an empty report', () => {
    expect(validateGuestReport({ ok: true, checks: [] }, ctx).ok).toBe(false);
  });
});

describe('release manifest', () => {
  function packagedTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-'));
    for (const rel of Object.values(MANDATORY_BUNDLE_FILES) as string[]) {
      const file = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (rel === 'build-identity.json') {
        // The build identity is real JSON: the manifest carries it, so it has
        // to be parseable in a packaged tree.
        fs.writeFileSync(file, JSON.stringify({
          schema: 1, version: '0.1.1', buildNumber: 142, buildKind: 'release',
          releaseChannel: 'alpha', commit: 'abc1234', builtAt: '2026-10-24T00:00:00.000Z',
          installerVersion: '0.1.1', coreVersion: '0.1.1', sourceState: 'clean',
        }, null, 2));
        continue;
      }
      fs.writeFileSync(file, `content of ${rel}`);
    }
    return root;
  }
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  it('is derived from the packaged files and detects later drift', () => {
    const root = packagedTree();
    const manifest = buildReleaseManifest(root, repoRoot, { allowDirty: true });
    expect(Object.keys(manifest.files)).toEqual(Object.keys(MANDATORY_BUNDLE_FILES));
    expect(() => verifyReleaseManifest(root, manifest)).not.toThrow();
    fs.writeFileSync(path.join(root, 'runtime', 'core.js'), 'rebuilt after the manifest was written');
    expect(() => verifyReleaseManifest(root, manifest)).toThrow(/coreBundle/);
  });

  it('fails when a mandatory bundle file is missing', () => {
    const root = packagedTree();
    fs.rmSync(path.join(root, 'runtime', 'node_modules', '@earendil-works', 'pi-ai'), { recursive: true });
    expect(() => buildReleaseManifest(root, repoRoot, { allowDirty: true })).toThrow(/pi-ai/);
  });

  it('refuses a dirty working tree unless explicitly allowed, and records it when allowed', () => {
    const root = packagedTree();
    const dirty = (() => { try { return buildReleaseManifest(root, repoRoot, { allowDirty: false }).sourceState; } catch { return 'refused'; } })();
    const allowed = buildReleaseManifest(root, repoRoot, { allowDirty: true });
    expect(['clean', 'refused']).toContain(dirty);
    expect(allowed.sourceState === 'dirty' ? allowed.dirtyFiles.length > 0 : allowed.dirtyFiles.length === 0).toBe(true);
    if (dirty === 'refused') expect(allowed.sourceState).toBe('dirty');
  });
});
