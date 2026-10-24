import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import jsonEvidence from './jsonEvidence.cjs';

const { writeJsonAtomic, readJsonWithEvidence } = jsonEvidence;
const requiredPasses = {
  activationExitCode: 0,
  m36AttachmentRestartExitCode: 0,
  m36DocumentAudioRestartExitCode: 0,
  m36GovernedResearchRestartExitCode: 0,
  m36CombinedWorkbenchExitCode: 0,
  mandatoryScenariosExitCode: 0,
};

function withTemporaryDirectory(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-json-evidence-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('atomic JSON evidence is UTF-8 without a BOM', () => withTemporaryDirectory((root) => {
  const filename = path.join(root, 'nested', 'status.json');
  writeJsonAtomic(filename, { phase: 'companion_started' });
  const bytes = fs.readFileSync(filename);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(readJsonWithEvidence(filename).value.phase, 'companion_started');
}));

test('BOM-prefixed JSON is classified as valid UTF-8 evidence', () => withTemporaryDirectory((root) => {
  const filename = path.join(root, 'bom.json');
  fs.writeFileSync(filename, '\ufeff{"phase":"passed","terminalStatus":"passed"}', 'utf8');
  const result = readJsonWithEvidence(filename);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.bomRemoved, true);
  assert.equal(result.value.phase, 'passed');
}));

test('truncated JSON preserves source text and records a parse classification', () => withTemporaryDirectory((root) => {
  const filename = path.join(root, 'partial.json');
  fs.writeFileSync(filename, '{"phase":"companion_activated"', 'utf8');
  const result = readJsonWithEvidence(filename);
  assert.equal(result.ok, false);
  assert.equal(result.evidence.classification, 'invalid_json');
  assert.equal(result.evidence.originalText, '{"phase":"companion_activated"');
  assert.match(result.evidence.parseError, /JSON/);
}));

test('missing JSON receives a distinct harness-evidence classification', () => withTemporaryDirectory((root) => {
  const filename = path.join(root, 'missing.json');
  const result = readJsonWithEvidence(filename);
  assert.equal(result.ok, false);
  assert.equal(result.evidence.classification, 'missing_json');
  assert.equal(result.evidence.sourcePreserved, true);
}));

test('valid terminal success and failure companion statuses remain readable', () => withTemporaryDirectory((root) => {
  for (const [name, status] of Object.entries({
    passed: { phase: 'passed', terminalStatus: 'passed', elapsedMs: 12 },
    failed: { phase: 'failed', terminalStatus: 'failed', stage: 'companion_activated', message: 'expected failure', elapsedMs: 13, process: { pid: 7 } },
  })) {
    const filename = path.join(root, `${name}.json`);
    writeJsonAtomic(filename, status);
    const result = readJsonWithEvidence(filename);
    assert.equal(result.ok, true);
    assert.equal(result.value.terminalStatus, name);
  }
}));

test('classifier accepts BOM JSON and distinguishes parse evidence from product failures', () => withTemporaryDirectory((root) => {
  const input = path.join(root, 'input.json');
  const output = path.join(root, 'output.json');
  fs.writeFileSync(input, `\ufeff${JSON.stringify(requiredPasses)}`, 'utf8');
  let result = spawnSync(process.execPath, ['scripts/acceptance/windowsPackagedAcceptanceHarness.mjs', '--input', input, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).acceptancePassed, true);

  fs.writeFileSync(input, '{"activationExitCode":', 'utf8');
  result = spawnSync(process.execPath, ['scripts/acceptance/windowsPackagedAcceptanceHarness.mjs', '--input', input, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const parseFailure = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(parseFailure.status, 'classification_error');
  assert.equal(parseFailure.classification, 'harness_json_parse_failure_not_product_failure');
  assert.equal(parseFailure.acceptanceFailures.length, 0);
  assert.equal(parseFailure.inputEvidence.originalText, '{"activationExitCode":');
}));
