// Result records written before the evidence root moved still carry the absolute `<repo>/.golden-evidence/...`
// evidenceDir. `cohort.mjs --reclassify` dereferences it; when it is gone it must resolve to the same relative path
// under the active Golden root. Run: node --test scripts/model-bench/evidenceLegacyPath.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reclassifyRecord, resolveRecordedEvidenceDir } from './evidence.mjs';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-legacy-evidence-'));
const LEGACY = 'C:\\Projects\\ollama-agent\\.golden-evidence\\2026-10-01T00-00-00-000Z-abc';

test('a missing legacy path resolves to the same relative path under the active root', () => {
  const root = tempRoot();
  const moved = path.join(root, '2026-10-01T00-00-00-000Z-abc');
  fs.mkdirSync(moved, { recursive: true });
  assert.equal(resolveRecordedEvidenceDir(LEGACY, root), moved);
  assert.equal(resolveRecordedEvidenceDir(LEGACY.replaceAll('\\', '/'), root), moved);
});

test('an existing recorded path wins, and unresolvable paths stay null', () => {
  const root = tempRoot();
  assert.equal(resolveRecordedEvidenceDir(root, path.join(root, 'elsewhere')), root);
  assert.equal(resolveRecordedEvidenceDir(LEGACY, root), null);
  assert.equal(resolveRecordedEvidenceDir('D:\\other\\evidence\\run', root), null);
  assert.equal(resolveRecordedEvidenceDir(null, root), null);
});

test('a legacy path cannot escape the active root', () => {
  const root = tempRoot();
  assert.equal(resolveRecordedEvidenceDir('Z:\\nope\\.golden-evidence\\..\\..\\escape', root), null);
});

test('reclassifyRecord leaves a record unchanged when no evidence resolves, and never rewrites evidenceDir', () => {
  const root = tempRoot();
  const record = { model: 'm', scenario: 'd1-small-bug', evidenceDir: LEGACY, result: 'pass' };
  assert.equal(reclassifyRecord(record, { activeRoot: root }), record);
  fs.mkdirSync(path.join(root, '2026-10-01T00-00-00-000Z-abc'), { recursive: true });
  assert.equal(reclassifyRecord({ ...record }, { activeRoot: root }).evidenceDir, LEGACY);
});
