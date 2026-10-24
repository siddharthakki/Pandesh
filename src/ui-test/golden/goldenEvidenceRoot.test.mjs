// Run: node --test src/ui-test/golden/goldenEvidenceRoot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GOLDEN_EVIDENCE_ENV, detectLegacyGoldenEvidence, legacyGoldenEvidenceWarning, resolveGoldenEvidenceRoot,
} from './goldenEvidenceRoot.mjs';
import { goldenRunRoot, prepareAttempt } from './fixtures.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const isInside = (child, parent) => !path.relative(parent, child).startsWith('..') && !path.isAbsolute(path.relative(parent, child));

test('default root is the per-user KarkeDikha data dir, outside the repository', () => {
  const win = resolveGoldenEvidenceRoot({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\u' });
  assert.equal(win, 'C:\\Users\\u\\AppData\\Local\\KarkeDikha\\golden-evidence');
  const winNoVar = resolveGoldenEvidenceRoot({ env: {}, platform: 'win32', homedir: 'C:\\Users\\u' });
  assert.equal(winNoVar, 'C:\\Users\\u\\AppData\\Local\\KarkeDikha\\golden-evidence');
  assert.equal(resolveGoldenEvidenceRoot({ env: { XDG_DATA_HOME: '/data' }, platform: 'linux', homedir: '/home/u' }), '/data/karkedikha/golden-evidence');
  assert.equal(resolveGoldenEvidenceRoot({ env: {}, platform: 'linux', homedir: '/home/u' }), '/home/u/.local/share/karkedikha/golden-evidence');
  assert.equal(resolveGoldenEvidenceRoot({ env: {}, platform: 'darwin', homedir: '/Users/u' }), '/Users/u/.local/share/karkedikha/golden-evidence');
  // The real, un-injected default (no override) must also be outside this repository.
  const real = resolveGoldenEvidenceRoot({ env: { ...process.env, [GOLDEN_EVIDENCE_ENV]: '' } });
  assert.ok(!isInside(real, repoRoot), `${real} must not be inside ${repoRoot}`);
});

test('KKD_GOLDEN_EVIDENCE_ROOT overrides everything and is used exactly', () => {
  const target = path.join(os.tmpdir(), 'kkd-override-root');
  assert.equal(resolveGoldenEvidenceRoot({ env: { [GOLDEN_EVIDENCE_ENV]: target, LOCALAPPDATA: 'C:\\x' }, platform: 'win32' }), target);
  assert.equal(resolveGoldenEvidenceRoot({ env: { [GOLDEN_EVIDENCE_ENV]: '   ', LOCALAPPDATA: 'C:\\x' }, platform: 'win32' }), 'C:\\x\\KarkeDikha\\golden-evidence');
  assert.ok(path.isAbsolute(resolveGoldenEvidenceRoot({ env: { [GOLDEN_EVIDENCE_ENV]: 'relative/dir' } })));
});

test('writer: goldenRunRoot/prepareAttempt write under the authoritative root (env override), never the repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-golden-root-'));
  const previous = process.env[GOLDEN_EVIDENCE_ENV];
  process.env[GOLDEN_EVIDENCE_ENV] = tmp;
  try {
    const runRoot = goldenRunRoot();
    assert.equal(path.dirname(runRoot), tmp);
    const attempt = prepareAttempt({ runRoot, name: 's', attempt: 1, fixture: 'blank', settings: {} });
    assert.ok(isInside(attempt.evidence, tmp));
    assert.ok(!isInside(attempt.evidence, repoRoot));
    assert.ok(fs.existsSync(attempt.evidence));
  } finally {
    if (previous === undefined) delete process.env[GOLDEN_EVIDENCE_ENV]; else process.env[GOLDEN_EVIDENCE_ENV] = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reader: evidence is found at the explicit path the runner reports', async () => {
  const { readGoldenOutcome } = await import('../../../scripts/model-bench/evidence.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-golden-read-'));
  try {
    const out = readGoldenOutcome({ output: `report\nEvidence: ${tmp}\n`, scenario: 's' });
    assert.equal(out.evidenceRoot, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('legacy detection is a non-destructive single stat', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-legacy-'));
  try {
    assert.equal(detectLegacyGoldenEvidence(repo), null);
    assert.equal(legacyGoldenEvidenceWarning(repo, '/new'), null);
    const legacy = path.join(repo, '.golden-evidence');
    fs.mkdirSync(path.join(legacy, 'run-1'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'run-1', 'keep.txt'), 'valuable');
    const before = fs.readdirSync(legacy, { recursive: true }).sort();
    assert.equal(detectLegacyGoldenEvidence(repo), legacy);
    const warning = legacyGoldenEvidenceWarning(repo, '/new/active');
    assert.match(warning, /legacy/i);
    assert.ok(warning.includes(legacy) && warning.includes('/new/active') && warning.includes('NOT read, written, moved or deleted'));
    assert.deepEqual(fs.readdirSync(legacy, { recursive: true }).sort(), before);
    assert.equal(fs.readFileSync(path.join(legacy, 'run-1', 'keep.txt'), 'utf8'), 'valuable');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('no tooling reconstructs a repository-local .golden-evidence path', () => {
  const offenders = [];
  const allowed = new Set(['src/ui-test/golden/goldenEvidenceRoot.mjs', 'src/ui-test/golden/goldenEvidenceRoot.test.mjs', 'scripts/model-bench/repetitionIsolation.test.mjs', 'scripts/model-bench/evidenceLegacyPath.test.mjs']);
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js|ts)$/.test(entry.name)) {
        const rel = path.relative(repoRoot, full).split(path.sep).join('/');
        if (!allowed.has(rel) && fs.readFileSync(full, 'utf8').includes('.golden-evidence')) offenders.push(rel);
      }
    }
  };
  for (const dir of ['scripts', 'src/ui-test', 'core', 'src']) if (fs.existsSync(path.join(repoRoot, dir))) walk(path.join(repoRoot, dir));
  assert.deepEqual(offenders, []);
});

test('packaging config still excludes the legacy evidence tree and git ignores it', () => {
  for (const file of ['.gitignore', '.vscodeignore']) {
    assert.match(fs.readFileSync(path.join(repoRoot, file), 'utf8'), /^\.golden-evidence\/(\*\*)?$/m, file);
  }
});
