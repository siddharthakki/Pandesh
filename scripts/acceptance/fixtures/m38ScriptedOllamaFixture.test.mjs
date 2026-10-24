import assert from 'node:assert/strict';
import test from 'node:test';
import { computeScriptedResponse, startScriptedOllamaFixture } from './m38ScriptedOllamaFixture.mjs';
import {
  M38_FIXTURE_MODEL,
  M38_REPO_FIXTURE_FILE_NAME,
  M38_REPO_FIXTURE_FILE_CONTENT,
  M38_RESEARCH_QUERY,
  M38_RESEARCH_EVIDENCE_MARKER,
  M38_GITHUB_ISSUE_NUMBER,
  M38_GITHUB_COMMENT_BODY,
  M38_GITHUB_COMMENT_MARKER,
} from './m38FixtureConstants.mjs';

test('computeScriptedResponse: first turn (no tool results) requests the repository-inspection read_file call', () => {
  const outcome = computeScriptedResponse({ model: M38_FIXTURE_MODEL, messages: [{ role: 'user', content: 'go' }] });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.toolCall, { name: 'read_file', arguments: { path: M38_REPO_FIXTURE_FILE_NAME } });
});

test('computeScriptedResponse: second turn requests governed_research once the read_file evidence is present', () => {
  const outcome = computeScriptedResponse({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'calling read_file' },
      { role: 'tool', content: `[read_file] exit=0\n${M38_REPO_FIXTURE_FILE_CONTENT}` },
    ],
  });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.toolCall, { name: 'governed_research', arguments: { query: M38_RESEARCH_QUERY } });
});

test('computeScriptedResponse: third turn requests github_comment_on_issue once the research evidence is present', () => {
  const outcome = computeScriptedResponse({
    messages: [
      { role: 'tool', content: `[read_file] exit=0\n${M38_REPO_FIXTURE_FILE_CONTENT}` },
      { role: 'tool', content: `[governed_research] exit=0\n[S1]\n${M38_RESEARCH_EVIDENCE_MARKER}` },
    ],
  });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.toolCall, { name: 'github_comment_on_issue', arguments: { number: M38_GITHUB_ISSUE_NUMBER, body: M38_GITHUB_COMMENT_BODY } });
});

test('computeScriptedResponse: fourth turn gives a final grounded answer with no further tool call', () => {
  const outcome = computeScriptedResponse({
    messages: [
      { role: 'tool', content: `[read_file] exit=0\n${M38_REPO_FIXTURE_FILE_CONTENT}` },
      { role: 'tool', content: `[governed_research] exit=0\n[S1]\n${M38_RESEARCH_EVIDENCE_MARKER}` },
      { role: 'tool', content: `[github_comment_on_issue] exit=0\nhttps://x/issues/1 ${M38_GITHUB_COMMENT_MARKER}` },
    ],
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.toolCall, null);
  assert.match(outcome.content, new RegExp(M38_REPO_FIXTURE_FILE_CONTENT.trim().slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(outcome.content, new RegExp(M38_RESEARCH_EVIDENCE_MARKER));
  assert.match(outcome.content, new RegExp(M38_GITHUB_COMMENT_MARKER));
});

test('computeScriptedResponse: rejects an out-of-order/invalid tool-call sequence instead of guessing', () => {
  const wrongFirstToolResult = computeScriptedResponse({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'tool', content: '[run_command] exit=0\nsomething else entirely' },
    ],
  });
  assert.ok(wrongFirstToolResult.error, 'expected a validation error for an unexpected first tool result');

  const tooManyToolResults = computeScriptedResponse({
    messages: [
      { role: 'tool', content: 'a' },
      { role: 'tool', content: 'b' },
      { role: 'tool', content: 'c' },
      { role: 'tool', content: 'd' },
    ],
  });
  assert.ok(tooManyToolResults.error, 'expected a validation error for more tool results than the scripted sequence has steps');
});

test('the fixture server: readiness, correct first HTTP response, rejection over HTTP, and clean shutdown', async () => {
  const fixture = await startScriptedOllamaFixture();
  try {
    const health = await fetch(`${fixture.baseUrl}/health`).then((r) => r.json());
    assert.equal(health.ready, true);

    const tags = await fetch(`${fixture.baseUrl}/api/tags`).then((r) => r.json());
    assert.equal(tags.models[0].name, fixture.model);

    const first = await fetch(`${fixture.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: fixture.model, messages: [{ role: 'user', content: 'go' }], stream: true }),
    });
    assert.equal(first.status, 200);
    const firstFrame = JSON.parse((await first.text()).trim());
    assert.deepEqual(firstFrame.message.tool_calls, [{ function: { name: 'read_file', arguments: { path: M38_REPO_FIXTURE_FILE_NAME } } }]);

    const invalid = await fetch(`${fixture.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: fixture.model, messages: [{ role: 'user', content: 'go' }, { role: 'tool', content: 'garbage, not the expected marker' }] }),
    });
    assert.equal(invalid.status, 409);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error, 'unexpected_tool_call_sequence');

    assert.equal(fixture.snapshot().chatRequests, 2);
    assert.equal(fixture.snapshot().violations, 1);
  } finally {
    await fixture.close();
  }
  assert.ok(fixture.snapshot().closedAt);
  await assert.rejects(() => fetch(`${fixture.baseUrl}/health`));
});
