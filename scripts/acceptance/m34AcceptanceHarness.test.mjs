import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  M34_FIXTURE_MODEL,
  M34_RECOVERY_MARKER,
  M34_REPAIR_MARKER,
  M34_RETRY_MARKER,
  M34_STRONG_FIXTURE_MODEL,
  countTerminalTransitions,
  parseExecutionQualityEvents,
  realModelRoleSettings,
  startDeterministicM34Proxy,
  writeM34RealworkRepository,
  writeM34RepairRepository,
} from './m34AcceptanceHarness.mjs';

test('real-model acceptance configures capable chat and coding roles explicitly', () => {
  assert.deepEqual(realModelRoleSettings('chat-capable', 'coding-capable'), {
    'ollama-agent.model': 'chat-capable',
    'ollama-agent.chatModel': 'chat-capable',
    'ollama-agent.agentModel': 'coding-capable',
    'ollama-agent.codingModel': 'coding-capable',
    'ollama-agent.editModel': 'coding-capable',
    'ollama-agent.reviewerModel': 'coding-capable',
    'ollama-agent.codingFallbackModel': 'chat-capable',
  });
  assert.ok(!Object.values(realModelRoleSettings('chat-capable', 'coding-capable')).includes('autocomplete-only'));
});

async function chat(baseUrl, model, content) {
  const raw = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: true }),
  }).then((response) => response.text());
  return JSON.parse(raw.trim());
}

test('M34 disposable repositories contain real tests and explicit intended scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm34-acceptance-repos-'));
  try {
    const realworkRoot = path.join(root, 'realwork');
    const repairRoot = path.join(root, 'repair');
    const realwork = writeM34RealworkRepository(realworkRoot);
    const repair = writeM34RepairRepository(repairRoot);

    assert.deepEqual(realwork.intendedFiles, ['src/parsePort.js']);
    assert.equal(realwork.validationCommand, 'npm test');
    assert.match(fs.readFileSync(path.join(realworkRoot, 'test/parsePort.test.js'), 'utf8'), /mixed numeric input/);
    assert.match(fs.readFileSync(path.join(realworkRoot, 'src/parsePort.js'), 'utf8'), /parseInt/);

    assert.deepEqual(repair.intendedFiles, ['src/formatGreeting.js']);
    assert.match(repair.task, /\[M34_REPAIR\]/);
    assert.match(fs.readFileSync(path.join(repairRoot, 'test/formatGreeting.test.js'), 'utf8'), /Hello, Panda!/);
    assert.match(fs.readFileSync(path.join(repairRoot, 'src/formatGreeting.js'), 'utf8'), /trim/);
    const standaloneEnv = { ...process.env };
    delete standaloneEnv.NODE_TEST_CONTEXT;
    const realworkBaseline = spawnSync(process.execPath, ['--test', 'test/parsePort.test.js'], {
      cwd: realworkRoot, encoding: 'utf8', env: standaloneEnv,
    });
    const repairBaseline = spawnSync(process.execPath, ['--test', 'test/formatGreeting.test.js'], {
      cwd: repairRoot, encoding: 'utf8', env: standaloneEnv,
    });
    assert.equal(realworkBaseline.status, 1, 'the realwork repository must begin with one genuine failing test');
    assert.match(`${realworkBaseline.stdout}\n${realworkBaseline.stderr}`, /mixed numeric input/);
    assert.equal(repairBaseline.status, 0, 'the repair repository must begin green before the model introduces a regression');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the recovery fixture emits one correctable path, two equivalent unsafe paths, then a strategy change', async () => {
  const fixture = await startDeterministicM34Proxy();
  try {
    const tags = await fetch(`${fixture.baseUrl}/api/tags`).then((response) => response.json());
    assert.deepEqual(tags.models.map((entry) => entry.name), [M34_FIXTURE_MODEL, M34_STRONG_FIXTURE_MODEL]);

    const first = await chat(fixture.baseUrl, M34_FIXTURE_MODEL, M34_RECOVERY_MARKER);
    const second = await chat(fixture.baseUrl, M34_FIXTURE_MODEL, M34_RECOVERY_MARKER);
    const third = await chat(fixture.baseUrl, M34_FIXTURE_MODEL, M34_RECOVERY_MARKER);
    const fourth = await chat(fixture.baseUrl, M34_FIXTURE_MODEL, M34_RECOVERY_MARKER);

    assert.equal(first.message.tool_calls[0].function.arguments.path, 'C:\\invented\\old-workspace\\src\\recovery-target.ts');
    assert.equal(second.message.tool_calls[0].function.arguments.path, '../outside/missing.ts');
    assert.equal(third.message.tool_calls[0].function.arguments.path, '..\\outside\\missing.ts');
    assert.match(fourth.message.content, /changed strategy/i);
    assert.deepEqual(fixture.snapshot().scenarioCalls, { [M34_RECOVERY_MARKER]: 4 });
  } finally {
    await fixture.close();
  }
  assert.ok(fixture.snapshot().closedAt);
});

test('the repair fixture changes its proposal only after real failure evidence is returned', async () => {
  const fixture = await startDeterministicM34Proxy();
  try {
    const initial = await chat(fixture.baseUrl, M34_FIXTURE_MODEL, M34_REPAIR_MARKER);
    const repaired = await chat(
      fixture.baseUrl,
      M34_FIXTURE_MODEL,
      `${M34_REPAIR_MARKER}\nvalidation failed: npm test returned ERR_ASSERTION: expected Hello, Panda!`,
    );
    const initialProposal = JSON.parse(initial.message.content);
    const repairedProposal = JSON.parse(repaired.message.content);

    assert.equal(initialProposal.validationCommands[0].kind, 'npm-test');
    assert.match(initialProposal.operations[0].content, /return `Hello /);
    assert.doesNotMatch(initialProposal.operations[0].content, /Hello,/);
    assert.match(repairedProposal.operations[0].content, /Hello, \$\{normalized\}!/);
    assert.notEqual(initialProposal.operations[0].content, repairedProposal.operations[0].content);
  } finally {
    await fixture.close();
  }
});

test('the retry fixture blocks the base model output and proposes only for the configured stronger model', async () => {
  const fixture = await startDeterministicM34Proxy();
  try {
    const blocked = await chat(fixture.baseUrl, M34_FIXTURE_MODEL, M34_RETRY_MARKER);
    const retry = await chat(fixture.baseUrl, M34_STRONG_FIXTURE_MODEL, M34_RETRY_MARKER);

    assert.match(blocked.message.content, /cannot safely propose/);
    assert.equal(JSON.parse(blocked.message.content).operations, undefined);
    const retryProposal = JSON.parse(retry.message.content);
    assert.equal(retryProposal.status, 'proposed');
    assert.deepEqual(retryProposal.operations.map((operation) => operation.path), ['src/formatGreeting.js']);
    assert.deepEqual(fixture.snapshot().scenarioCalls, { [M34_RETRY_MARKER]: 2 });
  } finally {
    await fixture.close();
  }
});

test('M34 evidence helpers read only Core runtime rows and count one terminal transition', () => {
  const rows = [
    { domain: 'execution_quality', eventType: 'repository_path_corrected', sequence: 2, metadata: '{"automatic":true}' },
    { domain: 'execution_quality', eventType: 'strategy_changed', sequence: 3, metadata: { reason: 'loop' } },
    { domain: 'attempt', eventType: 'attempt_transitioned', metadata: '{"to":"running"}' },
    { domain: 'attempt', eventType: 'attempt_transitioned', metadata: '{"to":"completed"}' },
  ];
  assert.deepEqual(parseExecutionQualityEvents(rows), [
    { eventType: 'repository_path_corrected', metadata: { automatic: true }, sequence: 2 },
    { eventType: 'strategy_changed', metadata: { reason: 'loop' }, sequence: 3 },
  ]);
  assert.equal(countTerminalTransitions(rows), 1);
});
