import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeFakeOllamaResponse,
  startFakeOllamaServer,
  GUARDIAN_SCRIPTED_MODEL,
  GUARDIAN_BAAT_KAR_ANSWER,
  GUARDIAN_SAATH_KAR_WRITE_PATH,
  GUARDIAN_SAATH_KAR_WRITE_CONTENT,
  GUARDIAN_SAATH_KAR_COMPLETION,
} from './fakeOllamaServer.mjs';

test('computeFakeOllamaResponse: Baat Kar (no tools offered) returns the fixed ordinary answer, no tool call', () => {
  const outcome = computeFakeOllamaResponse({
    model: GUARDIAN_SCRIPTED_MODEL,
    messages: [{ role: 'user', content: 'Explain what this repository contains.' }],
    tools: [],
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.toolCall, null);
  assert.equal(outcome.content, GUARDIAN_BAAT_KAR_ANSWER);
});

test('computeFakeOllamaResponse: Saath Kar first turn (tools offered, no tool result yet) requests write_file', () => {
  const outcome = computeFakeOllamaResponse({
    messages: [{ role: 'user', content: 'Create note-saath.txt containing Hello from Saath Kar' }],
    tools: [{ function: { name: 'write_file' } }, { function: { name: 'read_file' } }],
  });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.toolCall, {
    name: 'write_file',
    arguments: { path: GUARDIAN_SAATH_KAR_WRITE_PATH, content: GUARDIAN_SAATH_KAR_WRITE_CONTENT },
  });
});

test('computeFakeOllamaResponse: Saath Kar resubmission after rejection/restore is identical to the first turn', () => {
  // A rejected attempt (or a fresh attempt after reload) is, from the model's
  // point of view, indistinguishable from the very first call: a fresh
  // /api/chat request with zero prior tool-result messages.
  const first = computeFakeOllamaResponse({
    messages: [{ role: 'user', content: 'Create note-saath.txt containing Hello from Saath Kar' }],
    tools: [{ function: { name: 'write_file' } }],
  });
  const resubmission = computeFakeOllamaResponse({
    messages: [{ role: 'user', content: 'Create note-saath.txt containing Hello from Saath Kar' }],
    tools: [{ function: { name: 'write_file' } }],
  });
  assert.deepEqual(first, resubmission);
});

test('computeFakeOllamaResponse: Saath Kar completion turn (a write_file tool result is present) gives a final answer, no further tool call', () => {
  const outcome = computeFakeOllamaResponse({
    messages: [
      { role: 'user', content: 'Create note-saath.txt containing Hello from Saath Kar' },
      { role: 'assistant', content: 'Creating note-saath.txt now.' },
      { role: 'tool', content: JSON.stringify({ tool: 'write_file', ok: true }) },
    ],
    tools: [{ function: { name: 'write_file' } }],
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.toolCall, null);
  assert.equal(outcome.content, GUARDIAN_SAATH_KAR_COMPLETION);
});

test('computeFakeOllamaResponse: rejects request shapes outside the six scripted P0/P1 decisions instead of guessing', () => {
  const noUserMessage = computeFakeOllamaResponse({ messages: [], tools: [] });
  assert.ok(noUserMessage.error);

  const toolsWithoutWriteFile = computeFakeOllamaResponse({
    messages: [{ role: 'user', content: 'Create note-saath.txt containing Hello from Saath Kar' }],
    tools: [{ function: { name: 'read_file' } }],
  });
  assert.ok(toolsWithoutWriteFile.error);

  const unexpectedPrompt = computeFakeOllamaResponse({
    messages: [{ role: 'user', content: 'do something else entirely' }],
    tools: [{ function: { name: 'write_file' } }],
  });
  assert.ok(unexpectedPrompt.error);

  const tooManyToolResults = computeFakeOllamaResponse({
    messages: [
      { role: 'user', content: 'Create note-saath.txt containing Hello from Saath Kar' },
      { role: 'tool', content: 'write_file ok' },
      { role: 'tool', content: 'write_file ok again' },
    ],
    tools: [{ function: { name: 'write_file' } }],
  });
  assert.ok(tooManyToolResults.error);
});

test('the fake server: /api/tags, /api/show, /api/chat over real HTTP, and clean shutdown', async () => {
  const server = await startFakeOllamaServer();
  try {
    const tags = await fetch(`${server.baseUrl}/api/tags`).then((r) => r.json());
    assert.equal(tags.models[0].name, server.model);

    const show = await fetch(`${server.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: server.model }),
    }).then((r) => r.json());
    assert.equal(show.model_info['general.context_length'], 40960);

    const baatKar = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: server.model,
        stream: false,
        messages: [{ role: 'user', content: 'Explain what this repository contains.' }],
      }),
    });
    assert.equal(baatKar.status, 200);
    const baatKarFrame = JSON.parse((await baatKar.text()).trim());
    assert.equal(baatKarFrame.message.content, GUARDIAN_BAAT_KAR_ANSWER);
    assert.equal(baatKarFrame.message.tool_calls, undefined);

    const invalid = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: server.model, stream: false, messages: [{ role: 'user', content: 'nonsense' }], tools: [] }),
    });
    assert.equal(invalid.status, 409);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error, 'unexpected_request_shape');

    assert.equal(server.snapshot().chatRequests, 2);
    assert.equal(server.snapshot().violations, 1);
    assert.equal(server.violations().length, 1);
  } finally {
    await server.close();
  }
  assert.ok(server.snapshot().closedAt);
  await assert.rejects(() => fetch(`${server.baseUrl}/api/tags`));
});
