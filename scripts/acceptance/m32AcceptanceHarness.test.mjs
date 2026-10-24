import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SAATH_CANCEL_COMMAND,
  SAATH_CANCEL_FIXTURE_MODEL,
  SCENARIO_REGISTRY,
  captureConversationBaselineSnapshot,
  normalizeRecallText,
  recallTextContainsPhrase,
  resolveFollowUpBaseline,
  selectScenarios,
  startDeterministicSaathCancelProxy,
} from './m32AcceptanceHarness.mjs';

test('the shared unfiltered registry preserves every accepted scenario in order', () => {
  assert.deepEqual(
    SCENARIO_REGISTRY.map((scenario) => scenario.name),
    [
      'baatkar',
      'saathkar',
      'saathcancel',
      'karke',
      'restart',
      'followup',
      'everyday',
      'm34-realwork',
      'm34-recovery',
      'm34-repair-retry',
      'm35-inline-approval',
      'm35-trivial-steering',
      'm35-inline-stop',
      'm35-package-provenance-gate',
      'm35-package-provenance-live-diagnostic',
      'm36-attachment-restart',
      'm36-document-audio-restart',
      'm36-governed-research-restart',
      'm36-combined-workbench',
      'm39-memory-knowledge-restart',
    ],
  );
  assert.deepEqual(selectScenarios().map((scenario) => scenario.name), SCENARIO_REGISTRY.map((scenario) => scenario.name));
  assert.deepEqual(selectScenarios('saathkar,saathcancel').map((scenario) => scenario.name), ['saathkar', 'saathcancel']);
  assert.deepEqual(
    selectScenarios('m34-repair-retry,m34-realwork').map((scenario) => scenario.name),
    ['m34-realwork', 'm34-repair-retry'],
  );
  assert.throws(() => selectScenarios('missing'), /unknown scenario name/);
});

test('the packaged runner has exactly one fail-closed dispatch for every registered scenario', () => {
  const runner = fs.readFileSync(new URL('./run-m32-packaged-dogfood.mjs', import.meta.url), 'utf8');
  for (const scenario of SCENARIO_REGISTRY) {
    const marker = `runRegisteredScenario('${scenario.name}'`;
    assert.equal(runner.split(marker).length - 1, 1, `${scenario.name} must have exactly one runner dispatch`);
  }
  assert.match(runner, /assertAllSelectedScenariosExecuted\(\)/);
});

test('m36-attachment-restart has a dedicated evidence directory that is never a subdirectory of the shared m32-packaged-dogfood evidence directory, and only that scenario clears it', () => {
  const runner = fs.readFileSync(new URL('./run-m32-packaged-dogfood.mjs', import.meta.url), 'utf8');

  // m36EvidenceDir must be a sibling of evidenceDir (both directly under
  // '.acceptance-evidence'), never nested inside it — that's what makes it
  // immune to evidenceDir's own top-of-run rmSync.
  assert.match(runner, /const m36EvidenceDir = path\.join\(repoRoot, '\.acceptance-evidence', 'm36-attachment-restart'\);/);
  assert.doesNotMatch(runner, /path\.join\(evidenceDir, 'm36-attachment-restart'\)/);

  // The unconditional top-of-main clear must target only the shared
  // evidenceDir. Any rmSync of m36EvidenceDir must appear strictly after
  // that unconditional clear and be guarded by a check that this
  // invocation actually selected m36-attachment-restart.
  const unconditionalClearIndex = runner.indexOf("fs.rmSync(evidenceDir, { recursive: true, force: true });");
  assert.notEqual(unconditionalClearIndex, -1, 'expected the unconditional shared-evidence-dir clear to still exist');
  const m36ClearIndex = runner.indexOf('fs.rmSync(m36EvidenceDir');
  assert.notEqual(m36ClearIndex, -1, 'expected exactly one guarded m36EvidenceDir clear');
  assert.ok(m36ClearIndex > unconditionalClearIndex, 'm36EvidenceDir clear must come after the unconditional shared clear');
  const guardWindow = runner.slice(Math.max(0, m36ClearIndex - 200), m36ClearIndex);
  assert.match(guardWindow, /wantScenario\('m36-attachment-restart'\)/, 'm36EvidenceDir clear must be guarded by wantScenario(\'m36-attachment-restart\')');

  // Exactly one scenario body assigns its scenarioEvidenceDir from
  // m36EvidenceDir — the m36-attachment-restart scenario itself. No other
  // scenario block may write into it.
  const assignmentMatches = runner.match(/scenarioEvidenceDir = m36EvidenceDir/g) ?? [];
  assert.equal(assignmentMatches.length, 1, 'exactly one scenario may set scenarioEvidenceDir = m36EvidenceDir');
});

test('the governed-research restart scenario targets the regenerated branch response and verifies its Core alternative group', () => {
  const runner = fs.readFileSync(new URL('./run-m32-packaged-dogfood.mjs', import.meta.url), 'utf8');
  assert.match(runner, /readResponseAlternativeEvidenceForAssistant\(assistantMessageId/);
  assert.match(runner, /branchResponseBeforeRegeneration/);
  assert.match(runner, /bubble\?\.dataset\.messageId/);
  assert.match(runner, /regenerate action missing for the branch response/);
  assert.match(runner, /Core response-alternative group for the regenerated branch response/);
  assert.match(runner, /group\.filter\(alternative => alternative\.active\)\.length === 1/);
  assert.match(runner, /fixtureBeforeRegeneration\.providerRequests/);
  assert.match(runner, /fixtureBeforeRegeneration\.sourceRequests/);
  assert.match(runner, /selected response alternative Core\/UI restoration/);
  assert.match(runner, /activeAlternativeDisabled/);
  assert.match(runner, /alternativeSelected\.state\.activeAlternativeDisabled/);
  assert.match(runner, /answer\.querySelector\('\.message-workbench-actions'\)\?\.remove\(\)/);
});

test('M36 evidence and package-provenance gate/diagnostic evidence have stable non-overlapping homes', () => {
  const runner = fs.readFileSync(new URL('./run-m32-packaged-dogfood.mjs', import.meta.url), 'utf8');
  assert.match(runner, /const m36Pass2EvidenceDir = path\.join\(repoRoot, '\.acceptance-evidence', 'm36-document-audio-restart'\);/);
  assert.match(runner, /const m35PackageProvenanceGateEvidenceDir = path\.join\(repoRoot, '\.acceptance-evidence', 'm35-package-provenance-gate'\);/);
  assert.match(runner, /const m35PackageProvenanceLiveEvidenceDir = path\.join\(repoRoot, '\.acceptance-evidence', 'm35-package-provenance-live-diagnostic'\);/);
  assert.match(runner, /scenarioEvidenceDir = m35PackageProvenanceGateEvidenceDir/);
  assert.match(runner, /scenarioEvidenceDir = m35PackageProvenanceLiveEvidenceDir/);
  assert.doesNotMatch(runner, /path\.join\(m36EvidenceDir, 'm35-package-provenance/);
  assert.doesNotMatch(runner, /path\.join\(m36Pass2EvidenceDir, 'm35-package-provenance/);
});

test('a subsequent shared-evidence-dir clear (as run by any other/later scenario invocation) does not touch a previously written m36-attachment-restart evidence directory', () => {
  // Behavioral counterpart to the static check above: reproduces the exact
  // directory-tree relationship and the exact clear operation main() performs
  // unconditionally at the top of every run, and proves the M36 evidence
  // survives it untouched — this is what protects m36-attachment-restart's
  // evidence when it runs in one process and an unrelated later invocation
  // of this same script (e.g. the legacy m35 bundle) runs immediately after
  // in the same CI job, as scripts/run-win32-packaged-acceptance.ps1 does.
  const acceptanceEvidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-m36-evidence-isolation-'));
  try {
    const sharedEvidenceDir = path.join(acceptanceEvidenceRoot, 'm32-packaged-dogfood');
    const m36EvidenceDir = path.join(acceptanceEvidenceRoot, 'm36-attachment-restart');

    fs.mkdirSync(sharedEvidenceDir, { recursive: true });
    fs.writeFileSync(path.join(sharedEvidenceDir, 'evidence.json'), JSON.stringify({ scenario: 'm35-inline-approval' }));

    fs.mkdirSync(m36EvidenceDir, { recursive: true });
    const m36Files = {
      'evidence.json': JSON.stringify({ ok: true, requestId: 'req_m36_test' }),
      'before-send.png': 'not-really-a-png',
      'after-restart.png': 'not-really-a-png-either',
      'dom-before-send.json': JSON.stringify({ bubblesBeforeSend: { user: 0, assistant: 0 } }),
      'dom-after-restart.json': JSON.stringify({ bubblesAfterRestart: { user: 1, assistant: 1 } }),
      'core-evidence.json': JSON.stringify({ requestId: 'req_m36_test' }),
      'multimodal-request-evidence.json': JSON.stringify({ requestCount: 1 }),
      'attachment-hashes.json': JSON.stringify({ fixtures: {} }),
      'cleanup-evidence.json': JSON.stringify({ vscodeStopped: true }),
      'package-provenance.json': JSON.stringify({ bytes: 123, entryCount: 4 }),
    };
    for (const [name, content] of Object.entries(m36Files)) {
      fs.writeFileSync(path.join(m36EvidenceDir, name), content);
    }
    const mtimesBefore = Object.fromEntries(
      Object.keys(m36Files).map((name) => [name, fs.statSync(path.join(m36EvidenceDir, name)).mtimeMs]),
    );

    // Exactly the operation main() performs unconditionally at the top of
    // every run of this script — clearing ONLY the shared evidenceDir.
    fs.rmSync(sharedEvidenceDir, { recursive: true, force: true });

    // The shared dir is gone (that part is expected/unchanged behavior)...
    assert.equal(fs.existsSync(sharedEvidenceDir), false);
    // ...but every M36 evidence file is completely untouched: still present,
    // same content, same mtime (never rewritten, let alone deleted).
    assert.equal(fs.existsSync(m36EvidenceDir), true);
    for (const [name, content] of Object.entries(m36Files)) {
      const filePath = path.join(m36EvidenceDir, name);
      assert.equal(fs.existsSync(filePath), true, `${name} must still exist`);
      assert.equal(fs.readFileSync(filePath, 'utf8'), content, `${name} content must be unchanged`);
      assert.equal(fs.statSync(filePath).mtimeMs, mtimesBefore[name], `${name} mtime must be unchanged (never rewritten)`);
    }
  } finally {
    fs.rmSync(acceptanceEvidenceRoot, { recursive: true, force: true });
  }
});

test('follow-up baseline resolves the Baat conversation even when a Saath conversation is newer', () => {
  const olderBaatMessages = [
    { id: 'msg_b1', seq: 1, role: 'user', content: 'earlier baat question', modelInvocationId: null },
    { id: 'msg_b2', seq: 2, role: 'assistant', content: 'earlier baat answer', modelInvocationId: 'mi_b1' },
  ];
  const snapshot = captureConversationBaselineSnapshot([
    { id: 'conv_baat_older', mode: 'baat_kar', messages: olderBaatMessages },
    // Deliberately newer (later updatedAt / row order): must never be chosen.
    {
      id: 'conv_saath_newer',
      mode: 'saath_kar',
      messages: [{ id: 'msg_s1', seq: 1, role: 'user', content: 'saath prompt', modelInvocationId: null }],
    },
  ]);

  const baseline = resolveFollowUpBaseline(snapshot, 'conv_baat_older');
  assert.equal(baseline.conversationId, 'conv_baat_older');
  assert.equal(baseline.existedBeforeTurnOne, true);
  assert.equal(baseline.mode, 'baat_kar');
  assert.equal(baseline.length, 2);
  assert.deepEqual(baseline.messageIds, ['msg_b1', 'msg_b2']);
  assert.deepEqual(baseline.messages, olderBaatMessages);
  assert.notEqual(baseline.conversationId, 'conv_saath_newer');
});

test('follow-up baseline keeps the prior messages of a pre-existing follow-up conversation', () => {
  const priorMessages = [
    { id: 'msg_1', seq: 1, role: 'user', content: 'hello', modelInvocationId: null },
    { id: 'msg_2', seq: 2, role: 'assistant', content: 'hi there', modelInvocationId: 'mi_1' },
    { id: 'msg_3', seq: 3, role: 'user', content: 'describe the workspace', modelInvocationId: null },
    { id: 'msg_4', seq: 4, role: 'assistant', content: 'it is a workspace', modelInvocationId: 'mi_2' },
  ];
  const snapshot = captureConversationBaselineSnapshot([
    { id: 'conv_followup', mode: 'baat_kar', messages: priorMessages },
  ]);

  const baseline = resolveFollowUpBaseline(snapshot, 'conv_followup');
  assert.equal(baseline.existedBeforeTurnOne, true);
  assert.equal(baseline.length, 4);
  assert.deepEqual(baseline.messageIds, ['msg_1', 'msg_2', 'msg_3', 'msg_4']);
  assert.deepEqual(baseline.messages, priorMessages);
});

test('follow-up baseline is empty for a conversation newly created by turn 1', () => {
  const snapshot = captureConversationBaselineSnapshot([
    {
      id: 'conv_saath_preexisting',
      mode: 'saath_kar',
      messages: [{ id: 'msg_s1', seq: 1, role: 'user', content: 'saath prompt', modelInvocationId: null }],
    },
  ]);

  const baseline = resolveFollowUpBaseline(snapshot, 'conv_brand_new');
  assert.equal(baseline.conversationId, 'conv_brand_new');
  assert.equal(baseline.existedBeforeTurnOne, false);
  assert.equal(baseline.length, 0);
  assert.deepEqual(baseline.messageIds, []);
  assert.deepEqual(baseline.messages, []);
});

test('follow-up baseline refuses to guess without a snapshot or an authoritative conversation id', () => {
  const snapshot = captureConversationBaselineSnapshot([]);
  assert.throws(() => resolveFollowUpBaseline(null, 'conv_x'), /pre-turn conversation snapshot is required/);
  assert.throws(() => resolveFollowUpBaseline(snapshot, null), /did not resolve an authoritative conversation id/);
  assert.throws(
    () => captureConversationBaselineSnapshot([
      { id: 'conv_dup', mode: 'baat_kar', messages: [] },
      { id: 'conv_dup', mode: 'baat_kar', messages: [] },
    ]),
    /duplicate conversation id/,
  );
});

test('recall normalization canonicalizes formatting without losing tokens', () => {
  assert.equal(normalizeRecallText('Blue_Mango_4729'), 'blue mango 4729');
  assert.equal(normalizeRecallText('  "Blue, Mango, 4729"  '), 'blue mango 4729');
  assert.equal(normalizeRecallText('Ｂｌｕｅ　Ｍａｎｇｏ　４７２９'), 'blue mango 4729'); // NFKC full-width fold
  assert.equal(normalizeRecallText(null), '');
  assert.equal(normalizeRecallText(undefined), '');
});

test('recall phrase check accepts every harmless formatting of the remembered phrase', () => {
  const expected = 'blue mango 4729';
  const mustPass = [
    'Blue Mango 4729',
    'Blue_Mango_4729',
    'Blue-Mango-4729',
    '"Blue, Mango, 4729"',
    'The exact phrase you asked me to remember is Blue_Mango_4729.',
    'You said: "Blue Mango 4729"!',
  ];
  for (const candidate of mustPass) {
    assert.equal(recallTextContainsPhrase(candidate, expected), true, `should pass: ${candidate}`);
  }
});

test('recall phrase check rejects missing, reordered, altered, or partial tokens', () => {
  const expected = 'blue mango 4729';
  const mustFail = [
    'Blue 4729',
    'Mango 4729',
    'Blue Mango 1234',
    '4729',
    'Mango Blue 4729', // tokens present but out of order
    'blue then some mango later 4729', // tokens in order but not the exact phrase
    'Blue Mango 47290', // partial numeric token must not match on a substring
    'I do not remember any phrase.',
    '',
    null,
  ];
  for (const candidate of mustFail) {
    assert.equal(recallTextContainsPhrase(candidate, expected), false, `should fail: ${candidate}`);
  }
  assert.throws(() => recallTextContainsPhrase('anything', '!!!'), /at least one alphanumeric token/);
});

test('the deterministic fixture emits exactly one long-running native tool call', async () => {
  const fixture = await startDeterministicSaathCancelProxy();
  try {
    const tags = await fetch(`${fixture.baseUrl}/api/tags`).then((response) => response.json());
    assert.equal(tags.models[0].name, SAATH_CANCEL_FIXTURE_MODEL);

    const requestBody = {
      model: SAATH_CANCEL_FIXTURE_MODEL,
      messages: [{ role: 'user', content: 'exercise cancellation' }],
      tools: [{ type: 'function', function: { name: 'run_command' } }],
      stream: true,
    };
    const first = await fetch(`${fixture.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }).then((response) => response.text());
    const firstFrame = JSON.parse(first.trim());
    assert.deepEqual(firstFrame.message.tool_calls, [{
      function: { name: 'run_command', arguments: { command: SAATH_CANCEL_COMMAND } },
    }]);

    const second = await fetch(`${fixture.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }).then((response) => response.text());
    const secondFrame = JSON.parse(second.trim());
    assert.equal(secondFrame.message.tool_calls, undefined);
    assert.deepEqual(fixture.snapshot(), { chatResponses: 2, toolCallResponses: 1, closedAt: null });
  } finally {
    await fixture.close();
  }
  assert.equal(fixture.snapshot().toolCallResponses, 1);
  assert.ok(fixture.snapshot().closedAt);
});
