// Visible Golden run: packaged VSIX in a disposable, FOREGROUND VS Code window on
// C:\Projects\_tests\kkd\golden-visible, driven through the real webview via CDP
// (type/click only - no extension internals). Core DB is read-only supporting
// evidence. Stops on the FIRST failed check and leaves the window open.
//
//   node scripts/run-visible-golden.mjs [--vsix karkedikha-win32-x64.vsix] [--model qwen3-coder:swift-27b]
//
// No automatic retries: a failed step is a failed run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import CDP from 'chrome-remote-interface';
import { resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { installExtension, launchPlainHost, allocateDebugPort, writeUserSettingsForCustomDialogs } from './acceptance/plainVsCodeHost.mjs';
import * as board from './acceptance/boardUiDriver.mjs';
import * as ui from './acceptance/uiDriver.mjs';
import { taskEvidence } from '../src/ui-test/support/runtimeEvidence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const WORKSPACE = 'C:\\Projects\\_tests\\kkd\\golden-visible';
const vsixPath = path.resolve(root, arg('--vsix', 'karkedikha-win32-x64.vsix'));
const model = arg('--model', 'qwen3-coder:swift-27b');
const baseUrl = arg('--base-url', 'http://127.0.0.1:11434');
const codeExe = path.join(root, '.guardian-cache', 'extest', 'VSCode-win32-x64-archive', 'Code.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(os.tmpdir(), `kkd-visible-golden-${stamp}`);
const evidenceDir = path.join('E:/kkd-eval-lab/artifacts/golden_visible', stamp);
const userDataDir = path.join(runDir, 'user-data');
const extensionsDir = path.join(runDir, 'extensions');
const coreDataDir = path.join(runDir, 'core-data');
fs.mkdirSync(evidenceDir, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sha16 = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const UNRELATED = 'Build me a calculator app.';
const INSPECT ='Inspect this workspace and explain what this project does, its main components, and how it is run. Do not modify any files.';
const MUTATING_TOOL = /propose|write|delete|rename|apply|commit|patch/i;

const log = (...parts) => console.log(`[visible-golden ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const results = [];
const turns = [];
let pageClient;
let chat;

// ── workspace ────────────────────────────────────────────────────────────────
function resetWorkspace() {
  // Disposable by construction: only ever wipes the one directory the user named.
  if (path.resolve(WORKSPACE).toLowerCase() !== 'c:\\projects\\_tests\\kkd\\golden-visible') throw new Error('refusing to reset unexpected workspace');
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'index.html'), '<html><body><h1>Hello</h1></body></html>\n');
  fs.writeFileSync(path.join(WORKSPACE, 'README.md'), '# golden-visible\n');
  git(WORKSPACE, ['init', '-q', '-b', 'golden-main']);
  git(WORKSPACE, ['config', 'user.email', 'golden@example.com']);
  git(WORKSPACE, ['config', 'user.name', 'Golden Visible']);
  git(WORKSPACE, ['add', '.']);
  git(WORKSPACE, ['commit', '-q', '-m', 'initial']);
}

function treeHash() {
  const entries = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.ollama-agent', '.vscode'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(`${path.relative(WORKSPACE, full)}:${sha16(fs.readFileSync(full))}`);
    }
  };
  walk(WORKSPACE);
  return sha16(entries.sort().join('\n'));
}
const readWs = file => (fs.existsSync(path.join(WORKSPACE, file)) ? fs.readFileSync(path.join(WORKSPACE, file), 'utf8') : null);

// ── webview access (CDP; DOM read/click/type only) ───────────────────────────
const evalDoc = expression => ui.evalInWebviewDoc(chat, expression);

async function snapshot() {
  return evalDoc(`(() => {
    const isRendered = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const primary = document.getElementById('send-btn');
    const id = v => String(v).replace(/^[^:]+:\\s*/, '').trim();
    const AMBIG = /Should I treat it as a new task\\?/;
    const inTranscript = e => !!e.closest('#messages');
    const ambiguity = Array.from(document.querySelectorAll('body *')).filter(e => e.children.length === 0 && AMBIG.test(e.textContent || ''))
      .map(e => ({ tag: e.tagName, id: e.id || null, cls: String(e.className || '').slice(0, 60), transcript: inTranscript(e), rendered: isRendered(e) }));
    return {
      bodyText: document.body.innerText,
      primaryAction: primary?.textContent?.trim() || null,
      composerDisabled: !!document.getElementById('user-input')?.disabled,
      userTexts: Array.from(document.querySelectorAll('#messages .bubble.user')).filter(isRendered).map(e => e.textContent || ''),
      assistantTexts: Array.from(document.querySelectorAll('#messages .bubble.assistant')).filter(isRendered).map(e => e.textContent || ''),
      taskId: id(document.getElementById('autonomous-task-id')?.textContent || ''),
      conversationId: document.querySelector('.conversation-item.active')?.dataset?.convId || null,
      cards: ['proposal', 'mutation', 'delivery'].map(kind => {
        const card = document.getElementById(kind + '-approval-card');
        const approve = document.getElementById(kind + '-approve-btn');
        return { kind, visible: isRendered(card), actionable: isRendered(approve) && !approve.disabled, text: isRendered(card) ? card.innerText.slice(0, 300) : null };
      }),
      toolApprovals: Array.from(document.querySelectorAll('[data-approval-id]')).filter(isRendered).map(card => {
        const button = card.querySelector('[data-approval-response="approved"]') || card.querySelector('[data-approval-id][data-approval-response="approved"]');
        return { approvalId: card.dataset.approvalId, tool: (button || card).dataset.toolName || card.dataset.toolName || null, actionable: !!button && !button.disabled && isRendered(button) };
      }),
      toolApprovalButtons: Array.from(document.querySelectorAll('[data-approval-response="approved"]')).filter(b => !b.disabled && isRendered(b))
        .map(b => ({ approvalId: b.dataset.approvalId || null, tool: b.dataset.toolName || null })),
      ambiguity,
    };
  })()`);
}

async function shot(label) {
  try { await board.captureScreenshot(pageClient, evidenceDir, label); } catch (error) { log('screenshot failed', label, String(error).slice(0, 120)); }
}

async function waitComposerReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await snapshot().catch(() => null);
    if (snap && !snap.composerDisabled && snap.primaryAction === 'Send') return snap;
    await sleep(500);
  }
  throw new Error('composer did not become ready (Send) in time');
}

async function typeAndSend(text) {
  await waitComposerReady();
  await evalDoc(`(() => { const t = document.getElementById('user-input'); t.focus(); t.value = ''; return true; })()`);
  await chat.Input.insertText({ text });
  let typed = await evalDoc(`document.getElementById('user-input').value`);
  if (typed !== text) {
    // Real typing did not reach the focused composer; fall back to setting the value + input event.
    await evalDoc(`(() => { const t = document.getElementById('user-input'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    typed = await evalDoc(`document.getElementById('user-input').value`);
  }
  if (typed !== text) throw new Error(`composer text mismatch: ${JSON.stringify(typed).slice(0, 120)}`);
  await sleep(600); // let the user watch the text land before it is sent
  await evalDoc(`document.getElementById('send-btn').click()`);
}

// ── core evidence (read-only, supporting) ────────────────────────────────────
function withDb(fn) {
  const file = path.join(coreDataDir, 'core.db');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const knownRequestIds = () => new Set(withDb(db => db.prepare('SELECT id FROM requests').all().map(row => row.id)) ?? []);

function findNewCoreTurn(prompt, known) {
  return withDb(db => {
    const request = db.prepare('SELECT * FROM requests WHERE currentMessage = ? ORDER BY createdAt DESC').all(prompt).find(row => !known.has(row.id));
    if (!request) return null;
    const attempt = db.prepare('SELECT * FROM attempts WHERE requestId = ? ORDER BY createdAt DESC LIMIT 1').get(request.id) ?? null;
    return { request, attempt };
  });
}

function policyEvidence(attemptId, sinceIso) {
  return withDb(db => {
    const events = type => db.prepare('SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = ? ORDER BY sequence').all(attemptId, type).map(row => JSON.parse(row.metadata));
    const mutationApprovals = db.prepare(`SELECT id, json_extract(summary, '$.toolName') AS tool, status, requestedAt FROM approvals WHERE requestedAt >= ? AND json_extract(summary, '$.toolName') IN ('propose_file_change','propose_text_edit')`).all(sinceIso);
    const selection = db.prepare('SELECT modelSelection FROM attempt_contexts WHERE attemptId = ?').get(attemptId);
    return {
      policy: events('mutation_policy_decided'),
      corrections: events('mutation_proposal_correction_started'),
      denied: events('mutation_denied_by_policy'),
      mutationApprovals,
      toolInvocationCount: db.prepare('SELECT COUNT(*) AS n FROM tool_invocations WHERE attemptId = ?').get(attemptId).n,
      fileModificationRequired: selection?.modelSelection ? JSON.parse(selection.modelSelection).requiredCapabilities?.fileModification ?? null : null,
    };
  });
}

// ── checks / failure handling ────────────────────────────────────────────────
class RunFailure extends Error {}
function check(step, name, condition, detail) {
  const pass = Boolean(condition);
  results.push({ step, name, pass, detail: detail ?? null });
  log(pass ? 'PASS' : 'FAIL', `step ${step}:`, name, pass ? '' : JSON.stringify(detail)?.slice(0, 400));
  if (!pass) throw new RunFailure(`step ${step}: ${name}`);
}

// ── one turn ─────────────────────────────────────────────────────────────────
/** kind: 'readonly' (never approve proposal/mutation/delivery; fail if one appears) | 'coding' (approve everything visible). */
async function turn(step, prompt, { kind, timeoutMs = 12 * 60_000, untilAssistant = null }) {
  const known = knownRequestIds();
  const sinceIso = new Date().toISOString();
  const treeBefore = treeHash();
  const before = await waitComposerReady();
  const priorAmbiguity = before.ambiguity.filter(item => item.transcript).length;
  const priorAssistantCount = before.assistantTexts.length;
  await typeAndSend(prompt);
  log(`step ${step}: sent (${kind}): ${prompt.slice(0, 80)}`);
  const record = { step, prompt, kind, sentAt: sinceIso, approvalsClicked: [], forbiddenCards: [], ambiguityRenderedOutsideTranscript: [], maxTranscriptAmbiguity: priorAmbiguity };
  const deadline = Date.now() + timeoutMs;
  let core = null;
  let lastSnap = null;
  let taskState = null;
  while (Date.now() < deadline) {
    let snap;
    try { snap = await snapshot(); } catch { await sleep(1000); continue; }
    lastSnap = snap;
    core = findNewCoreTurn(prompt, known);
    record.maxTranscriptAmbiguity = Math.max(record.maxTranscriptAmbiguity, snap.ambiguity.filter(item => item.transcript).length);
    for (const item of snap.ambiguity.filter(entry => !entry.transcript && entry.rendered)) record.ambiguityRenderedOutsideTranscript.push(item);

    if (!core && snap.ambiguity.filter(item => item.transcript).length > priorAmbiguity && snap.primaryAction === 'Send') {
      record.ambiguityShown = true; // the extension asked "Should I treat it as a new task?" instead of running the turn
      break;
    }
    if (untilAssistant && !core && snap.assistantTexts.length > priorAssistantCount && untilAssistant.test(snap.assistantTexts.at(-1)) && snap.primaryAction === 'Send') break;
    for (const button of snap.toolApprovalButtons) {
      const key = `tool:${button.approvalId}`;
      if (record.approvalsClicked.some(item => item.key === key)) continue;
      if (kind === 'readonly' && MUTATING_TOOL.test(button.tool ?? '')) { record.forbiddenCards.push({ kind: 'tool', ...button }); continue; }
      record.approvalsClicked.push({ key, kind: 'tool', tool: button.tool, at: new Date().toISOString() });
      await shot(`step${step}-approval-${button.tool ?? 'tool'}`);
      await evalDoc(`(() => { const b = Array.from(document.querySelectorAll('[data-approval-response="approved"]')).find(x => x.dataset.approvalId === ${JSON.stringify(button.approvalId)}); b?.click(); return !!b; })()`).catch(() => undefined);
      await sleep(500);
    }
    for (const card of snap.cards.filter(item => item.visible)) {
      if (kind === 'readonly') { record.forbiddenCards.push(card); continue; }
      if (!card.actionable) continue;
      const key = `${card.kind}:${Math.floor(Date.now() / 8000)}`;
      if (record.approvalsClicked.some(item => item.key === key)) continue;
      record.approvalsClicked.push({ key, kind: card.kind, text: card.text, at: new Date().toISOString() });
      await shot(`step${step}-${card.kind}-card`);
      await evalDoc(`document.getElementById(${JSON.stringify(`${card.kind}-approve-btn`)})?.click()`).catch(() => undefined);
      await sleep(800);
    }
    if (kind === 'readonly' && record.forbiddenCards.length) break; // fail fast: a mutation surface appeared in a read-only turn
    if (core?.attempt) {
      if (core.request.resolvedMode === 'karke_dikha' && snap.taskId && snap.taskId !== '—') {
        try { taskState = taskEvidence(WORKSPACE, snap.taskId).task.state; } catch { taskState = null; }
        if (['completed', 'failed', 'blocked', 'cancelled'].includes(taskState) && snap.primaryAction === 'Send') break;
      } else if (['completed', 'failed', 'cancelled'].includes(core.attempt.status) && snap.primaryAction === 'Send') {
        break;
      }
    }
    await sleep(1000);
  }
  await sleep(1500);
  lastSnap = await snapshot().catch(() => lastSnap);
  core = findNewCoreTurn(prompt, known) ?? core;
  Object.assign(record, {
    attemptId: core?.attempt?.id ?? null,
    attemptStatus: core?.attempt?.status ?? null,
    resolvedMode: core?.request?.resolvedMode ?? null,
    coreConversationId: core?.request?.conversationId ?? null,
    taskState,
    finishedAt: new Date().toISOString(),
    treeChanged: treeHash() !== treeBefore,
    assistantTail: (lastSnap?.assistantTexts ?? []).at(-1)?.slice(0, 600) ?? '',
    policy: core?.attempt ? policyEvidence(core.attempt.id, sinceIso) : null,
  });
  await shot(`step${step}-end`);
  turns.push(record);
  fs.writeFileSync(path.join(evidenceDir, `turn-${step}.json`), JSON.stringify({ ...record, bodyTail: lastSnap?.bodyText?.slice(-1500) }, null, 2));
  if (Date.now() >= deadline) check(step, 'turn reached a terminal state before the timeout', false, { prompt, status: record.attemptStatus, taskState });
  return record;
}

// ── steps ────────────────────────────────────────────────────────────────────
function noMutationSurface(step, record) {
  check(step, 'zero mutation proposals/approvals surfaced (UI)', record.forbiddenCards.length === 0 && !record.approvalsClicked.some(item => MUTATING_TOOL.test(item.tool ?? '')), record.forbiddenCards);
  check(step, 'zero mutation proposals in Core DB', (record.policy?.mutationApprovals ?? []).length === 0, record.policy?.mutationApprovals);
  check(step, 'workspace bytes unchanged', !record.treeChanged, record.treeChanged);
}

async function main() {
  if (!fs.existsSync(vsixPath)) throw new Error(`VSIX not found: ${vsixPath}`);
  if (!fs.existsSync(codeExe)) throw new Error(`Code.exe not found: ${codeExe}`);
  const vsixSha = crypto.createHash('sha256').update(fs.readFileSync(vsixPath)).digest('hex');
  log('VSIX', vsixPath, vsixSha.slice(0, 16), 'model', model);
  resetWorkspace();
  fs.writeFileSync(path.join(evidenceDir, 'run-identity.json'), JSON.stringify({
    vsix: vsixPath, vsixSha256: vsixSha, vsixBuiltAt: fs.statSync(vsixPath).mtime.toISOString(), gitHead: git(root, ['rev-parse', 'HEAD']),
    model, baseUrl, workspace: WORKSPACE, runDir, userDataDir, extensionsDir, coreDataDir, startedAt: new Date().toISOString(),
  }, null, 2));

  writeUserSettingsForCustomDialogs(userDataDir);
  fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
    'window.dialogStyle': 'custom',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'ollama-agent.providerType': 'ollama',
    'ollama-agent.apiBase': baseUrl,
    'ollama-agent.model': model,
    'ollama-agent.chatModel': model,
    'ollama-agent.agentModel': model,
    'ollama-agent.editModel': model,
    'ollama-agent.codingModel': model,
    'ollama-agent.codingFallbackModel': model,
    'ollama-agent.reviewerModel': model,
  }, null, 2));

  installExtension(resolveCliArgsFromVSCodeExecutablePath(codeExe), { userDataDir, extensionsDir, vsixPath });
  const port = allocateDebugPort();
  const launched = launchPlainHost(codeExe, {
    userDataDir, extensionsDir, workspacePath: WORKSPACE, remoteDebuggingPort: port,
    env: { KARKEDIKHA_DATA_DIR: coreDataDir, KARKEDIKHA_OLLAMA_URL: baseUrl },
  });
  // The window must outlive this script (left open on failure, and on success for inspection).
  launched.child.unref();
  launched.child.stdout?.destroy();
  launched.child.stderr?.destroy();
  log(`VS Code launched (pid ${launched.child.pid}, CDP port ${port})`);

  let pageTarget;
  for (let i = 0; i < 120 && !pageTarget; i += 1) {
    pageTarget = (await CDP.List({ port }).catch(() => [])).find(t => t.type === 'page');
    if (!pageTarget) await sleep(500);
  }
  if (!pageTarget) throw new Error('workbench page target not found');
  pageClient = await board.connectToTarget(port, pageTarget.id);
  await pageClient.Page.bringToFront();
  await sleep(4000);
  const initial = await CDP.List({ port });
  const excludeIds = initial.filter(t => t.type === 'iframe' && t.url.includes('/index.html')).map(t => t.id);
  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
  chat = await ui.connectToWebviewHost(port, { attempts: 80, delayMs: 500, excludeIds });
  await ui.waitForWebviewContentMounted(chat, { timeoutMs: 60_000, readyElementId: 'send-btn' });
  await pageClient.Page.bringToFront();
  await waitComposerReady();
  await shot('00-ready');
  log('KKD panel ready; starting the visible sequence');

  // 1. read-only workspace question
  let t = await turn(1, 'What does this workspace contain?', { kind: 'readonly' });
  check(1, 'no ambiguity prompt', !t.ambiguityShown);
  check(1, 'turn completed', t.attemptStatus === 'completed' || t.taskState === 'completed', [t.attemptStatus, t.taskState]);
  noMutationSurface(1, t);
  check(1, 'visible answer mentions the workspace files', /index\.html/i.test(t.assistantTail), t.assistantTail);
  const conversation = t.coreConversationId;

  // 2. normal continuation
  t = await turn(2, 'Which file would I open first and why?', { kind: 'readonly' });
  check(2, 'no ambiguity prompt', !t.ambiguityShown);
  check(2, 'turn completed', t.attemptStatus === 'completed' || t.taskState === 'completed', [t.attemptStatus, t.taskState]);
  check(2, 'same conversation as step 1', t.coreConversationId === conversation, [conversation, t.coreConversationId]);
  noMutationSurface(2, t);
  check(2, 'non-empty visible answer', t.assistantTail.trim().length > 20, t.assistantTail);

  // 3. deterministic tiny mutation
  t = await turn(3, 'Change the text in index.html from Hello to Hello KKD.', { kind: 'coding' });
  check(3, 'no ambiguity prompt', !t.ambiguityShown);
  check(3, 'a proposal/approval was visibly presented and approved', t.approvalsClicked.length > 0, t.approvalsClicked);
  check(3, 'turn completed', t.attemptStatus === 'completed' || t.taskState === 'completed', [t.attemptStatus, t.taskState]);
  const indexHtml = readWs('index.html') ?? '';
  check(3, 'index.html now says Hello KKD (and nothing else changed in it)', /<h1>\s*Hello KKD\s*<\/h1>/.test(indexHtml) && !/<h1>\s*Hello\s*<\/h1>/.test(indexHtml), indexHtml);
  check(3, 'workspace changed', t.treeChanged);
  check(3, 'same conversation', t.coreConversationId === conversation, [conversation, t.coreConversationId]);
  const treeAfterStep3 = treeHash();

  // 4. genuinely unrelated objective -> exactly one ambiguity prompt. (The inspection prompt itself
  // continues a workspace conversation by design - it shares the subject "workspace" - so the trigger
  // here is a substantive unrelated request; the inspection objective is sent in step 6.)
  t = await turn(4, UNRELATED, { kind: 'readonly', timeoutMs: 3 * 60_000 });
  check(4, 'ambiguity prompt "Should I treat it as a new task?" shown', t.ambiguityShown, t.assistantTail);
  check(4, 'nothing executed for the ambiguous turn', !t.attemptId, t.attemptId);
  check(4, 'workspace unchanged', treeHash() === treeAfterStep3);

  // 5. confirm new task
  t = await turn(5, 'Yes new task', { kind: 'readonly', timeoutMs: 3 * 60_000, untilAssistant: /Got it/i });
  const gotIt = await snapshot();
  check(5, `visible reply "Got it! What's the new task?"`, /Got it[!—-]* ?What's the new task\?/i.test(gotIt.assistantTexts.join('\n')) || /Got it/i.test(t.assistantTail), gotIt.assistantTexts.slice(-2));

  // 6. the inspection objective again: must execute immediately, read-only
  const ambiguityBubblesBefore6 = (await snapshot()).ambiguity.filter(item => item.transcript).length;
  t = await turn(6, INSPECT, { kind: 'readonly' });
  check(6, 'no second ambiguity prompt', !t.ambiguityShown && t.maxTranscriptAmbiguity <= ambiguityBubblesBefore6, [t.ambiguityShown, t.maxTranscriptAmbiguity, ambiguityBubblesBefore6]);
  check(6, 'old ambiguity prompt is not rendered as a live element after B started', t.ambiguityRenderedOutsideTranscript.length === 0, t.ambiguityRenderedOutsideTranscript);
  check(6, 'executed (Core has an attempt) and completed', t.attemptStatus === 'completed' || t.taskState === 'completed', [t.attemptStatus, t.taskState]);
  check(6, 'mutationPolicy=denied recorded for this attempt', t.policy?.policy?.length === 1 && t.policy.policy[0].mutationPolicy === 'denied', t.policy?.policy);
  check(6, 'no mutation-correction nudge', (t.policy?.corrections ?? []).length === 0, t.policy?.corrections);
  noMutationSurface(6, t);
  check(6, 'visible inspection answer', t.assistantTail.trim().length > 40, t.assistantTail);

  // 7. coding follow-up continuity
  // A coding objective after the inspection objective is a real topic change: one ambiguity prompt,
  // "Yes new task", then the objective is re-sent and must run immediately (same handshake as steps 4-6).
  const CODING = 'Create a new file about.html containing a single heading that says About KKD.';
  t = await turn('7a', CODING, { kind: 'readonly', timeoutMs: 3 * 60_000 });
  check('7a', 'ambiguity prompt shown for the topic change', t.ambiguityShown, t.assistantTail);
  check('7a', 'nothing executed for the ambiguous turn', !t.attemptId && !t.treeChanged, [t.attemptId, t.treeChanged]);
  t = await turn('7a-confirm', 'Yes new task', { kind: 'readonly', timeoutMs: 3 * 60_000, untilAssistant: /Got it/i });
  check('7a-confirm', `visible reply "Got it! What's the new task?"`, /Got it/i.test(t.assistantTail), t.assistantTail);
  const ambiguityBubblesBefore7 = (await snapshot()).ambiguity.filter(item => item.transcript).length;
  t = await turn(7, CODING, { kind: 'coding' });
  check(7, 'no second ambiguity prompt', !t.ambiguityShown && t.maxTranscriptAmbiguity <= ambiguityBubblesBefore7, [t.ambiguityShown, t.maxTranscriptAmbiguity, ambiguityBubblesBefore7]);
  check(7, 'turn completed', t.attemptStatus === 'completed' || t.taskState === 'completed', [t.attemptStatus, t.taskState]);
  const aboutV1 = readWs('about.html') ?? '';
  check(7, 'about.html has the About KKD heading', /About KKD/.test(aboutV1), aboutV1);
  t = await turn('7b', 'Now add a short subtitle below it.', { kind: 'coding' });
  check('7b', 'follow-up continued the objective (no ambiguity prompt)', !t.ambiguityShown);
  check('7b', 'turn completed', t.attemptStatus === 'completed' || t.taskState === 'completed', [t.attemptStatus, t.taskState]);
  const aboutV2 = readWs('about.html') ?? '';
  check('7b', 'heading kept and a subtitle added below it in about.html', /About KKD/.test(aboutV2) && aboutV2 !== aboutV1 && aboutV2.indexOf('About KKD') < aboutV2.search(/<(p|h2|h3|small)[\s>]/i), aboutV2);
  check('7b', 'index.html (unrelated file) untouched', /Hello KKD/.test(readWs('index.html') ?? ''));

  // 8. final read-only summary
  t = await turn(8, 'Summarize the final workspace. Do not modify any files.', { kind: 'readonly' });
  check(8, 'no ambiguity prompt', !t.ambiguityShown);
  check(8, 'turn completed', t.attemptStatus === 'completed' || t.taskState === 'completed', [t.attemptStatus, t.taskState]);
  // The policy event exists only for Saath Kar's agent loop. A Baat Kar (chat) turn has no tool loop at all,
  // so its invariant is stronger: zero tool invocations.
  if (t.resolvedMode === 'saath_kar') {
    check(8, 'mutationPolicy=denied recorded (Saath Kar)', t.policy?.policy?.length === 1 && t.policy.policy[0].mutationPolicy === 'denied', t.policy?.policy);
  } else {
    check(8, `no tool loop: ${t.resolvedMode} turn with zero tool invocations`, t.resolvedMode === 'baat_kar' && t.policy?.toolInvocationCount === 0, [t.resolvedMode, t.policy?.toolInvocationCount]);
  }
  noMutationSurface(8, t);
  check(8, 'visible summary', t.assistantTail.trim().length > 40, t.assistantTail);
}

let exitCode = 0;
try {
  await main();
  log('ALL STEPS PASSED');
} catch (error) {
  exitCode = 1;
  log(error instanceof RunFailure ? 'STOPPED ON FIRST FAILURE:' : 'HARNESS ERROR:', error.message);
  if (!(error instanceof RunFailure)) console.error(error);
  await shot('failure').catch(() => undefined);
} finally {
  fs.writeFileSync(path.join(evidenceDir, 'visible-golden-result.json'), JSON.stringify({
    verdict: exitCode === 0 ? 'PASS' : 'FAIL', finishedAt: new Date().toISOString(), coreDataDir, workspace: WORKSPACE, results, turns,
  }, null, 2));
  log('evidence:', evidenceDir, '| VS Code window intentionally left open');
  try { await chat?.close(); await pageClient?.close(); } catch { /* window stays */ }
  process.exit(exitCode);
}
