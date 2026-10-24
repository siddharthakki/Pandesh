import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const typescript = require('typescript');

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'karkedikha-everyday-smoke-'));
try {
  const { LocalStoryStore } = await loadLocalStoryStore(root);
  const store = new LocalStoryStore(root);
  const input = {
    draft: {
      title: 'Everyday assistant and local board smoke',
      goal: 'Prove chat routing can hand large work to durable local stories.',
      acceptanceCriteria: ['Large work becomes a draft story.', 'The board persists it locally.'],
      constraints: ['No automatic merge.'],
      validation: ['Headless smoke passes.'],
      dependencies: [],
      estimatedPoints: 5,
    },
    sourceConversationId: 'smoke-conversation',
    sourceText: 'Build a complete assistant platform.',
  };
  const first = await store.create(input);
  const retry = await store.create(input);
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal((await store.list()).length, 1);

  const controller = loadModeController();
  const chat = controller.classifyAutoMode('What is 2 + 2?');
  assert.equal(chat.kind, 'send');
  assert.equal(chat.mode, 'chat');
  const localModels = controller.classifyAutoMode('list my ollama models');
  assert.equal(localModels.kind, 'local_models');
  const mutation = controller.classifyAutoMode('Create primes.py that prints prime numbers.');
  assert.equal(mutation.kind, 'mutation');
  const large = controller.classifyAutoMode('Build an end-to-end local assistant platform with API, mobile UI, database, browser integration, multimodal support, tests, CI, and deployment automation.');
  assert.equal(large.kind, 'story');
  assert.ok(large.draft.acceptanceCriteria.length >= 2);

  verifyInlineApprovalContract();

  const evidence = {
    status: 'passed',
    generatedAt: new Date().toISOString(),
    checks: {
      ordinaryChatRouting: true,
      localOllamaModelRouting: true,
      boundedMutationRouting: true,
      largeRequestStoryDraft: true,
      durableLocalStory: true,
      idempotentStoryCreation: true,
      inlineApprovalTimelineContract: true,
      inlineApprovalScrollContract: true,
      resolvedApprovalHistoryContract: true,
      coreGateAuthorityPreserved: true,
    },
    storyId: first.story.id,
  };
  await fsp.writeFile('everyday-mvp-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('PASSED: everyday assistant routing, inline approvals, and local board persistence smoke.');
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

async function loadLocalStoryStore(tempRoot) {
  const sourcePath = path.join(process.cwd(), 'src', 'stories', 'LocalStoryStore.ts');
  const source = await fsp.readFile(sourcePath, 'utf8');
  const transpiled = typescript.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(diagnostic => diagnostic.category === typescript.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `LocalStoryStore transpilation failed: ${errors.map(error => error.messageText).join('; ')}`);
  const compiledPath = path.join(tempRoot, 'LocalStoryStore.cjs');
  await fsp.writeFile(compiledPath, transpiled.outputText, 'utf8');
  return require(compiledPath);
}

function verifyInlineApprovalContract() {
  // Approval-card DOM ownership (inline placement, resolved-history,
  // button state) lives solely in chat-autonomous.js.
  const autonomousSource = fs.readFileSync(path.join(process.cwd(), 'media', 'chat-autonomous.js'), 'utf8');
  assert.match(autonomousSource, /timeline\.appendChild\(card\)/);
  // M40 — a newly-pending approval reveals the whole single task-message
  // wrapper (`statusBox`, i.e. `#autonomous-status`), not just the approval
  // card, so the compact status line/details/other approvals in the same
  // message are visible too. See revealTaskMessageInView.
  assert.match(autonomousSource, /statusBox\.scrollIntoView\(\{/);
  assert.match(autonomousSource, /Waiting for your approval below/);
  assert.match(autonomousSource, /card\.dataset\.inlineApprovalState = 'resolved'/);

  const sidebarSource = fs.readFileSync(path.join(process.cwd(), 'media', 'chat-sidebar-ui.js'), 'utf8');
  assert.doesNotMatch(sidebarSource, /approvalTimeline/);
  assert.doesNotMatch(sidebarSource, /proposal-approval-card|mutation-approval-card|delivery-approval-card/);
  assert.doesNotMatch(sidebarSource, /postMessage\(\{ type: 'approve/);
  assert.match(sidebarSource, /Approval-card DOM[\s\S]*owned exclusively by chat-autonomous\.js/);
}

function loadModeController() {
  const elements = new Map();
  const toolbar = element('toolbar');
  const history = element('history-toggle');
  toolbar.children.push(history);
  elements.set('history-toggle', history);
  elements.set('top-bar-right', toolbar);
  for (const id of ['stop-btn', 'mode-select', 'model-select', 'context-model', 'model-badge', 'user-input']) elements.set(id, element(id));
  let state = {};
  const listeners = new Map();
  const vscode = {
    postMessage() {},
    getState() { return state; },
    setState(next) { state = next; },
  };
  const fakeWindow = {
    __ollamaAgentVsCodeApi: vscode,
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener({ data: event.data }); },
  };
  class MessageEvent {
    constructor(type, init) { this.type = type; this.data = init.data; }
  }
  const document = {
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return element(''); },
    addEventListener() {},
    querySelector(selector) { return selector === '.top-bar-right' ? toolbar : null; },
    querySelectorAll() { return []; },
  };
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'chat-runtime-fixes.js'), 'utf8');
  vm.runInNewContext(source, { window: fakeWindow, document, MessageEvent, console, Object, String, Array, Boolean, RegExp, Event: class Event {} });
  return fakeWindow.__karkeDikhaModeController;
}

function element(id) {
  return {
    id,
    value: '',
    textContent: '',
    title: '',
    className: '',
    hidden: false,
    disabled: false,
    children: [],
    options: [],
    firstChild: null,
    setAttribute() {},
    addEventListener() {},
    appendChild(child) { this.children.push(child); if (child.id) this.onInsert?.(child); return child; },
    insertBefore(child) { this.children.unshift(child); return child; },
    querySelector() { return null; },
  };
}
