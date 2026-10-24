import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(
  path.resolve('src/ui-test/page-objects/KarkeDikhaView.mjs'),
  'utf8',
);

test('page object opens the real Activity Bar view and visible composer', () => {
  assert.match(source, /getViewControl\('KarkeDikha'\)/);
  assert.match(source, /By\.id\('user-input'\)/);
  assert.match(source, /By\.id\('send-btn'\)/);
  assert.match(source, /getClientRects\(\)\.length/);
});

test('page object selects every explicit mode through rendered controls', () => {
  assert.match(source, /\.mode-button\[data-mode=/);
  assert.match(source, /\.(everyday|compact)-mode-option\[data-mode=/);
  for (const mode of ['chat', 'agent', 'autonomous']) assert.match(source, new RegExp(`'${mode}'`));
  assert.match(source, /async submitInMode\(mode, text\)/);
});

test('page object uses visible production approval and restart controls', () => {
  for (const id of ['proposal-approve-btn', 'mutation-approve-btn', 'delivery-approve-btn']) {
    assert.match(source, new RegExp(id));
  }
  assert.match(source, /data-approval-response/);
  assert.match(source, /actionableToolApproval/);
  assert.match(source, /Developer: Reload Window/);
});

test('page object drives visible History, New chat, and exact conversation selection', () => {
  for (const id of ['history-toggle', 'history-drawer', 'new-conversation-toolbar-btn', 'new-conversation-btn']) {
    assert.match(source, new RegExp(id));
  }
  assert.match(source, /async openHistory\(\)/);
  assert.match(source, /async newChat\(\)/);
  assert.match(source, /async selectConversation\(conversationId\)/);
  assert.match(source, /data-conv-id/);
});

test('page object exposes exact visible approval and conversation identity', () => {
  assert.match(source, /async approvalIdentity\(kind\)/);
  assert.match(source, /card\.dataset\.taskId/);
  assert.match(source, /card\.dataset\.attemptId/);
  assert.match(source, /conversationId:/);
  assert.match(source, /approvalCards:/);
});

test('selectConversation() closes the History drawer through its real control and waits until it no longer intercepts clicks before returning', () => {
  const selectConversationBody = source.match(/async selectConversation\(conversationId\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(selectConversationBody, 'expected to find the selectConversation() method body');
  // The dismissal must happen after the conversation is confirmed current
  // and before the method returns/resolves its snapshot() — not merely
  // exist somewhere else in the file — so it must appear inside this exact
  // method body, after the "did not become current" wait.
  const becameCurrentIndex = selectConversationBody.indexOf('did not become current');
  const closeHistoryIndex = selectConversationBody.indexOf('this.closeHistory()');
  assert.ok(becameCurrentIndex >= 0, 'expected the conversation-became-current wait inside selectConversation()');
  assert.ok(closeHistoryIndex > becameCurrentIndex, 'selectConversation() must dismiss History only after the conversation becomes current');
  assert.match(selectConversationBody, /return this\.snapshot\(\);\s*\}$/, 'selectConversation() must return only after closeHistory() resolves');

  // closeHistory() must use the drawer's real visible close control (never
  // a raw JS-executed click that bypasses whatever is overlapping it), and
  // must wait for Selenium's own visibility check — not just the `hidden`
  // DOM attribute — so a caller can rely on the drawer being genuinely
  // non-intercepting, not merely mid-transition.
  const closeHistoryBody = source.match(/async closeHistory\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(closeHistoryBody, 'expected to find the closeHistory() method body');
  assert.match(closeHistoryBody, /By\.id\('history-close-btn'\)/);
  assert.match(closeHistoryBody, /closeButton\.click\(\)/);
  assert.doesNotMatch(closeHistoryBody, /executeScript/, 'must not bypass the overlay with a synthetic JS click');
  assert.match(closeHistoryBody, /this\.driver\.wait\(\s*async \(\) => !\(await visible\(drawer\)\)/);
});

test('page object contains no production runtime or synthetic host bypass', () => {
  assert.doesNotMatch(source, /startAutonomousTask\s*\(/);
  assert.doesNotMatch(source, /vscode\s*\.\s*postMessage/);
  assert.doesNotMatch(source, /executionProfile\s*:/);
});
