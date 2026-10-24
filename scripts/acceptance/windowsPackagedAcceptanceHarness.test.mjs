import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { classifyWindowsPackagedAcceptance } from './windowsPackagedAcceptanceHarness.mjs';
import { warmModels } from './realModelWarmupHarness.mjs';

const requiredPasses = {
  activationExitCode: 0,
  m36AttachmentRestartExitCode: 0,
  m36DocumentAudioRestartExitCode: 0,
  m36GovernedResearchRestartExitCode: 0,
  m36CombinedWorkbenchExitCode: 0,
  m39MemoryKnowledgeRestartExitCode: 0,
  mandatoryScenariosExitCode: 0,
};

test('real-model warmup success records model, elapsed time, and exit code', async () => {
  let tick = 100;
  const evidence = await warmModels({
    url: 'http://ollama.test',
    timeoutMs: 50,
    now: () => (tick += 7),
    models: [{ model: 'qwen3-coder:30b', purpose: 'coding' }],
    fetchImpl: async () => ({ ok: true, json: async () => ({ done: true, model: 'qwen3-coder:30b' }) }),
  });
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.status, 'passed');
  assert.deepEqual(evidence.models[0], {
    model: 'qwen3-coder:30b', purpose: 'coding', status: 'passed', timeoutMs: 50,
    startedAt: evidence.models[0].startedAt, elapsedMs: 7, error: null,
  });
});

test('warmup timeout is recorded while mandatory packaged acceptance still passes', async () => {
  const evidence = await warmModels({
    url: 'http://ollama.test', timeoutMs: 5,
    models: [{ model: 'qwen3-coder:30b', purpose: 'coding' }],
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  assert.equal(evidence.exitCode, 1);
  assert.equal(evidence.models[0].status, 'timed_out');
  const result = classifyWindowsPackagedAcceptance({ ...requiredPasses, realModelWarmup: evidence });
  assert.equal(result.acceptancePassed, true);
  assert.equal(result.status, 'passed-with-diagnostics');
  assert.equal(result.diagnostics.realModelWarmup.models[0].status, 'timed_out');
});

test('warmup transport failure is recorded while mandatory packaged acceptance still passes', async () => {
  const evidence = await warmModels({
    url: 'http://ollama.test', timeoutMs: 50,
    models: [{ model: 'qwen3-coder:30b', purpose: 'coding' }],
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); },
  });
  assert.equal(evidence.exitCode, 1);
  assert.equal(evidence.models[0].status, 'failed');
  assert.match(evidence.models[0].error, /ECONNREFUSED/);
  const result = classifyWindowsPackagedAcceptance({ ...requiredPasses, realModelWarmup: evidence });
  assert.equal(result.acceptancePassed, true);
  assert.equal(result.status, 'passed-with-diagnostics');
});

test('a mandatory scenario failure remains a closed acceptance failure', () => {
  const result = classifyWindowsPackagedAcceptance({ ...requiredPasses, m36CombinedWorkbenchExitCode: 1 });
  assert.equal(result.acceptancePassed, false);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.acceptanceFailures, [{ name: 'm36CombinedWorkbenchExitCode', exitCode: 1 }]);
});

test('successful required activation and scenarios exit successfully despite advisory warmup and CDP failures', () => {
  const result = classifyWindowsPackagedAcceptance({
    ...requiredPasses,
    realModelWarmup: { exitCode: 1, models: [{ model: 'qwen3-coder:30b', status: 'timed_out', elapsedMs: 180000 }] },
    realModelDiagnostics: [{ name: 'restart', exitCode: 1, log: 'real-model-restart-diagnostic.log' }],
    advisoryCdpReadiness: { status: 'timed_out', log: 'real-model-restart-diagnostic.log' },
  });
  assert.equal(result.acceptancePassed, true);
  assert.equal(result.status, 'passed-with-diagnostics');
  assert.equal(result.diagnostics.cdpReadiness.acceptanceClassification, 'advisory');
  assert.equal(result.diagnostics.realModelDiagnostics[0].exitCode, 1);
});

test('the Windows wrapper isolates real-model work from required scenarios and delegates its exit decision to the classifier', () => {
  const wrapper = fs.readFileSync(new URL('../run-win32-packaged-acceptance.ps1', import.meta.url), 'utf8');
  assert.match(wrapper, /run-real-model-warmup\.mjs --evidence \$realModelWarmupEvidencePath/);
  assert.match(wrapper, /-and \$_ -ne 'restart'/);
  assert.match(wrapper, /--only=\$mandatoryScenarios/);
  assert.match(wrapper, /--only=restart/);
  assert.match(wrapper, /KARKEDIKHA_SKIP_REAL_MODEL_WARMUP = '1'/);
  assert.match(wrapper, /windowsPackagedAcceptanceHarness\.mjs --input \$classificationInputPath --output \$summaryPath/);
  assert.match(wrapper, /if \(-not \$summary\.acceptancePassed\)/);
  assert.doesNotMatch(wrapper, /\$realModelWarmupExit -ne 0/);
  assert.doesNotMatch(wrapper, /\$realModelRestartExit -ne 0/);
  assert.doesNotMatch(wrapper, /\$liveDiagnosticExit -ne 0/);
});

test('the classifier writes evidence that separates diagnostic failures from acceptance failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-win32-acceptance-classifier-'));
  try {
    const inputPath = path.join(root, 'input.json');
    const outputPath = path.join(root, 'summary.json');
    fs.writeFileSync(inputPath, JSON.stringify({
      ...requiredPasses,
      realModelWarmup: { exitCode: 1, models: [{ model: 'qwen3-coder:30b', status: 'timed_out', elapsedMs: 180000 }] },
      advisoryCdpReadiness: { status: 'timed_out', logPath: 'restart.log' },
    }));
    const result = spawnSync(process.execPath, [
      'scripts/acceptance/windowsPackagedAcceptanceHarness.mjs', '--input', inputPath, '--output', outputPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(summary.status, 'passed-with-diagnostics');
    assert.equal(summary.acceptancePassed, true);
    assert.equal(summary.diagnostics.realModelWarmup.models[0].status, 'timed_out');
    assert.equal(summary.diagnostics.cdpReadiness.acceptanceClassification, 'advisory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the M39 packaged memory gate is required: a failure fails Windows packaged acceptance', () => {
  const summary = classifyWindowsPackagedAcceptance({ ...requiredPasses, m39MemoryKnowledgeRestartExitCode: 1 });
  assert.equal(summary.acceptancePassed, false);
  assert.equal(summary.status, 'failed');
  assert.deepEqual(summary.acceptanceFailures, [{ name: 'm39MemoryKnowledgeRestartExitCode', exitCode: 1 }]);
});

test('the M39 packaged memory gate passing keeps Windows packaged acceptance green', () => {
  const summary = classifyWindowsPackagedAcceptance({ ...requiredPasses });
  assert.equal(summary.acceptancePassed, true);
  assert.equal(summary.required.m39MemoryKnowledgeRestartExitCode, 0);
});
