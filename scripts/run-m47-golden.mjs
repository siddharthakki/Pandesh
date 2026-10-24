// M47 Golden runner (derived from run-visible-golden.mjs): same real-UI CDP driving, new scenarios.
//   node scripts/run-m47-golden.mjs --golden A|B|N|FGHIJ [--model M] [--seed 47291] [--vsix path] [--label name]
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
const GOLDEN = arg('--golden', 'A');
const SEED = Number(arg('--seed', '47291'));
const WORKSPACE = 'C:\\Projects\\_tests\\kkd\\m47-golden';
const vsixPath = path.resolve(root, arg('--vsix', '.m47-golden/karkedikha-win32-x64-m47-dev.vsix'));
const model = arg('--model', 'qwen3.8:27b-mtp-q4_K_M');
const baseUrl = arg('--base-url', 'http://127.0.0.1:11434');
const codeExe = path.join(root, '.guardian-cache', 'extest', 'VSCode-win32-x64-archive', 'Code.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(os.tmpdir(), `kkd-m47-golden-${GOLDEN}-${stamp}`);
const evidenceDir = path.join(root, '.m47-golden', arg('--label', GOLDEN), stamp);
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
function resetWorkspace(fixture) {
  // Disposable by construction: only ever wipes a directory under C:\Projects\_tests\kkd\m47-*.
  if (!path.resolve(WORKSPACE).toLowerCase().startsWith('c:\\projects\\_tests\\kkd\\m47-')) throw new Error('refusing to reset unexpected workspace');
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  for (const [file, content] of Object.entries(fixture?.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(WORKSPACE, file)), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE, file), content);
  }
  if (fixture?.git) {
    git(WORKSPACE, ['init', '-q', '-b', 'golden-main']);
    git(WORKSPACE, ['config', 'user.email', 'golden@example.com']);
    git(WORKSPACE, ['config', 'user.name', 'M47 Golden']);
    git(WORKSPACE, ['add', '.']);
    git(WORKSPACE, ['commit', '-q', '-m', 'initial']);
  }
}

function treeHash() {
  const entries = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.ollama-agent', '.vscode', '.tmp'].includes(entry.name)) continue;
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
// A CDP evaluation that never returns would freeze the poll loop silently (observed once: Approve visible for 2h, runner idle).
const evalDoc = expression => Promise.race([
  ui.evalInWebviewDoc(chat, expression),
  new Promise((_, reject) => setTimeout(() => reject(new Error('evalDoc timed out after 20s')), 20_000)),
]);

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
  // Bounded: a screenshot of an occluded window can hang, and this runs right before an approval click.
  try {
    await Promise.race([
      board.captureScreenshot(pageClient, evidenceDir, label),
      new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timed out after 20s')), 20_000)),
    ]);
  } catch (error) { log('screenshot failed', label, String(error).slice(0, 120)); }
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
      // Tools run under the conversation's M38 capability-dispatch anchor attempt (correlationId = conversationId), not the turn attempt.
      ...(() => {
        const owner = db.prepare('SELECT r.conversationId AS conversationId FROM attempts a JOIN requests r ON r.id = a.requestId WHERE a.id = ?').get(attemptId);
        const rows = db.prepare(`SELECT t.toolName, t.status, t.argsSummary FROM tool_invocations t JOIN attempts a ON a.id = t.attemptId JOIN requests r ON r.id = a.requestId
          WHERE (t.attemptId = ? OR r.conversationId = ? OR r.correlationId = ?) AND t.startedAt >= ? ORDER BY t.startedAt`).all(attemptId, owner?.conversationId ?? '', owner?.conversationId ?? '', sinceIso);
        return { toolInvocationCount: rows.length, toolCalls: rows.map(row => `${row.toolName}:${row.status}:${String(row.argsSummary).slice(0, 80)}`) };
      })(),
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

/** Read-only turn invariants: nothing to approve, no mutating tool, workspace bytes unchanged. */
function noMutationSurface(step, t) {
  check(step, 'no mutation surface: no approval cards, no approvals clicked, no mutating tool, workspace unchanged',
    t.forbiddenCards.length === 0 && t.approvalsClicked.length === 0 && !t.treeChanged, { forbidden: t.forbiddenCards, clicked: t.approvalsClicked, treeChanged: t.treeChanged });
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
      const already = record.approvalsClicked.find(item => item.key === key);
      if (already) {
        // A click can land before the card's handler is bound (observed once: 110 ms after the card rendered, then a 16 min
        // stall). The button is still actionable => the click did not take; retry, bounded, and record it as evidence.
        if (Date.now() - Date.parse(already.at) > 15_000 && (already.retries ?? 0) < 2) {
          already.retries = (already.retries ?? 0) + 1; already.at = new Date().toISOString();
          log(`step ${step}: approval ${button.tool} still pending 15s after click, re-clicking (retry ${already.retries})`);
          await evalDoc(`(() => { const b = Array.from(document.querySelectorAll('[data-approval-response="approved"]')).find(x => x.dataset.approvalId === ${JSON.stringify(button.approvalId)}); b?.click(); return !!b; })()`).catch(() => undefined);
        }
        continue;
      }
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
    // The durable final assistant message is authoritative; the last UI bubble can be a governed-action card.
    assistantTail: (core?.request?.conversationId
      ? withDb(db => db.prepare("SELECT content FROM conversation_messages WHERE conversationId = ? AND role = 'assistant' AND createdAt >= ? ORDER BY seq DESC LIMIT 1").get(core.request.conversationId, sinceIso)?.content)
      : null)?.slice(0, 1200) ?? (lastSnap?.assistantTexts ?? []).at(-1)?.slice(0, 600) ?? '',
    policy: core?.attempt ? policyEvidence(core.attempt.id, sinceIso) : null,
  });
  await shot(`step${step}-end`);
  turns.push(record);
  fs.writeFileSync(path.join(evidenceDir, `turn-${step}.json`), JSON.stringify({ ...record, bodyTail: lastSnap?.bodyText?.slice(-1500) }, null, 2));
  if (Date.now() >= deadline) check(step, 'turn reached a terminal state before the timeout', false, { prompt, status: record.attemptStatus, taskState });
  return record;
}


// ── M47 additions ────────────────────────────────────────────────────────────
import { JSDOM } from 'jsdom';
import { terminatePlainHost } from './acceptance/plainVsCodeHost.mjs';

let host; // { child, port }
const PROFILE_GLOB_ROOT = () => path.join(userDataDir, 'User', 'globalStorage');

function readAll(dir, exts) {
  const out = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['.git', '.ollama-agent', '.vscode', '.tmp', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!exts || exts.includes(path.extname(entry.name).toLowerCase())) out[path.relative(dir, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

async function launchHost(options) {
  try { await launchHostOnce(options); } catch (error) {
    // The debug port never opened: retry the launch once from a clean slate (evidence: harness restart flake, run 6).
    log('launchHost failed, retrying once:', String(error).slice(0, 160));
    try { await chat?.close(); } catch { /* ignore */ }
    try { await pageClient?.close(); } catch { /* ignore */ }
    terminatePlainHost(host?.child); killOwnedCode(); await sleep(4000);
    await launchHostOnce({ ...options, fresh: false });
  }
}

async function launchHostOnce({ fresh }) {
  if (fresh) {
    writeUserSettingsForCustomDialogs(userDataDir);
    fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
      'window.dialogStyle': 'custom', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none',
      'ollama-agent.providerType': 'ollama', 'ollama-agent.apiBase': baseUrl, 'ollama-agent.model': model, 'ollama-agent.chatModel': model,
      'ollama-agent.agentModel': model, 'ollama-agent.editModel': model, 'ollama-agent.codingModel': model, 'ollama-agent.codingFallbackModel': model,
      'ollama-agent.reviewerModel': model, 'ollama-agent.requestTimeout': 900000,
      ...(arg('--context') ? { 'ollama-agent.contextWindow': Number(arg('--context')) } : {}),
    }, null, 2));
    installExtension(resolveCliArgsFromVSCodeExecutablePath(codeExe), { userDataDir, extensionsDir, vsixPath });
  }
  const port = allocateDebugPort();
  const launched = launchPlainHost(codeExe, {
    userDataDir, extensionsDir, workspacePath: WORKSPACE, remoteDebuggingPort: port,
    env: { KARKEDIKHA_DATA_DIR: coreDataDir, KARKEDIKHA_OLLAMA_URL: baseUrl },
  });
  launched.child.stdout?.on('data', () => undefined);
  launched.child.stderr?.on('data', () => undefined);
  host = { child: launched.child, port };
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
}

/** Every Code.exe whose command line mentions this run's disposable profile (the main process, renderers, extension host). */
function ownedCodeProcesses() {
  if (process.platform !== 'win32') return [];
  const needle = runDir.replaceAll("'", "''");
  const script = `$n='${needle}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like ('*' + $n + '*') } | Select-Object -ExpandProperty ProcessId`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
    return out ? out.split(/\s+/).map(Number).filter(Number.isInteger) : [];
  } catch { return []; }
}
function killOwnedCode() {
  const ids = ownedCodeProcesses();
  if (!ids.length) return 0;
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Force -Id ${ids.join(',')} -ErrorAction SilentlyContinue`], { windowsHide: true }); } catch { /* already gone */ }
  return ids.length;
}

async function stopHost() {
  try { await chat?.close(); } catch { /* ignore */ }
  try { await pageClient?.close(); } catch { /* ignore */ }
  chat = undefined; pageClient = undefined;
  terminatePlainHost(host?.child);
  await sleep(2000);
  const leftover = killOwnedCode(); // a surviving old instance would swallow the relaunch (single-instance handoff)
  if (leftover) log(`stopHost: terminated ${leftover} leftover VS Code process(es) of this run`);
  await sleep(3000);
}

/** Journal + task facts for a karke_dikha task, plus a copy of the journal into the evidence folder. */
function taskFacts(taskId, label) {
  if (!taskId || taskId === '—') return null;
  try {
    const { dir, task } = taskEvidence(WORKSPACE, taskId);
    const journalFile = path.join(dir, 'recovery', 'journal.jsonl');
    const facts = { taskId, state: task.state, failure: task.failure ? JSON.stringify(task.failure).slice(0, 300) : null };
    if (fs.existsSync(journalFile)) {
      const lines = fs.readFileSync(journalFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const counts = {};
      for (const record of lines) counts[record.t] = (counts[record.t] ?? 0) + 1;
      facts.journalRecords = counts;
      facts.contractModes = lines.filter(r => r.t === 'contract_mode').map(r => `${r.change} ${r.from}->${r.to} [${r.trigger?.kind}]`);
      facts.outcomes = lines.filter(r => r.t === 'outcome' || r.outcome).map(r => (r.outcome ?? r)).map(o => (o.ok ? 'ok' : `${o.cause}/${o.subcode ?? '-'}`)).slice(0, 20);
      facts.validationEnvelope = lines.filter(r => /validation_envelope|validation/.test(String(r.t))).length;
      fs.copyFileSync(journalFile, path.join(evidenceDir, `journal-${label}-${taskId}.jsonl`));
    }
    return facts;
  } catch (error) {
    return { taskId, error: String(error).slice(0, 200) };
  }
}

/** Seeded user-intent generator: describes what the user wants, never files, frameworks or steps. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SCENARIOS = [
  ['expense-tracker', 'expense tracker', 'add expenses with an amount and a category, and see my running total'],
  ['pomodoro-timer', 'pomodoro timer', 'start a 25 minute focus timer, take a short break, and see how many sessions I completed today'],
  ['habit-tracker', 'habit tracker', 'add habits, mark them complete for today, and see which ones are still pending'],
  ['recipe-manager', 'recipe manager', 'save recipes with ingredients and steps, and search them by name'],
  ['kanban-board', 'kanban board', 'add cards to To Do, Doing and Done columns and move them between columns'],
  ['quiz-app', 'quiz app', 'answer a few multiple-choice questions and see my score at the end'],
  ['bookmark-manager', 'bookmark manager', 'save links with a title and a tag, and filter them by tag'],
  ['inventory-app', 'simple inventory app', 'track items and quantities, and see which ones are running low'],
  ['meal-planner', 'meal planner', 'plan a meal for each day of the week and see the whole week at a glance'],
  ['personal-dashboard', 'personal dashboard', 'see today\'s date, a to-do list and a quick notes box in one place'],
  ['landing-page', 'landing page', 'present a small product with a hero section, three features and a contact form'],
  ['notes-app', 'notes app', 'write notes, edit them and delete them, with the newest at the top'],
];
const OPENERS = ['Build me a small', 'I want a simple', 'Can you make me a little', 'Please create a small'];
const CLOSERS = ['Keep it simple, attractive and easy to run locally.', 'It should look nice and be easy to open on my own machine.', 'Nothing fancy, but it should look good and work offline.'];
// The follow-up "add a filter" request in words that make sense for each app (a sensible equivalent, never file/framework detail).
const FILTER_ASKS = {
  'expense-tracker': "Add a filter so I can show only today's expenses.",
  'pomodoro-timer': 'Add a filter so I can show only the sessions I completed today.',
  'habit-tracker': 'Add a filter so I can show only the habits that are still pending today.',
  'recipe-manager': 'Add a filter so I can show only my favourite recipes.',
  'kanban-board': 'Add a filter so I can hide the cards that are already done.',
  'quiz-app': 'Add a filter so I can review only the questions I got wrong.',
  'bookmark-manager': 'Add a filter so I can show only the bookmarks with a tag I pick.',
  'inventory-app': 'Add a filter so I can show only the items that are running low.',
  'meal-planner': 'Add a filter so I can show only the days that have no meal planned.',
  'personal-dashboard': 'Add a filter so I can show only the to-dos that are not done yet.',
  'landing-page': 'Add a small filter on the features section so I can show only the feature I pick.',
  'notes-app': 'Add a filter so I can show only the notes containing the text I type.',
};
function generateIntent(seed) {
  const rand = mulberry32(seed);
  const scenario = SCENARIOS[Math.floor(rand() * SCENARIOS.length)];
  const opener = OPENERS[Math.floor(rand() * OPENERS.length)];
  const closer = CLOSERS[Math.floor(rand() * CLOSERS.length)];
  return { seed, scenario: scenario[0], filterAsk: FILTER_ASKS[scenario[0]], prompt: `${opener} ${scenario[1]} web app. I want to ${scenario[2]}. ${closer}` };
}

/** Independent smoke check of a static web app: entry page loads in jsdom, scripts run without uncaught errors. */
async function loadApp({ exercise = false } = {}) {
  const files = readAll(WORKSPACE, ['.html', '.js', '.css', '.json', '.mjs']);
  const entry = Object.keys(files).find(f => /(^|\/)index\.html$/i.test(f)) ?? Object.keys(files).find(f => f.endsWith('.html'));
  if (!entry) return { ok: false, reason: 'no html entry', files: Object.keys(files) };
  const errors = [];
  const entryDir = path.posix.dirname(entry);
  const local = ref => files[path.posix.normalize(path.posix.join(entryDir, ref.split('?')[0]))];
  // Inline local scripts/styles and serve from an http origin so localStorage etc. behave like a browser page.
  const html = files[entry]
    .replace(/<script([^>]*?)\ssrc=["']([^"':]+)["']([^>]*)>\s*<\/script>/gi, (m, a1, src, a2) => (local(src) != null ? `<script${a1}${a2}>${local(src)}</script>` : m))
    .replace(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"':]+)["'][^>]*>/gi, (m, href) => (local(href) != null ? `<style>${local(href)}</style>` : m));
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.addEventListener('error', event => errors.push(String(event.message)));
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    },
  });
  await sleep(800);
  const doc = dom.window.document;
  const summary = {
    ok: errors.length === 0 && (doc.body?.textContent ?? '').trim().length > 0,
    entry, errors: errors.slice(0, 5), title: doc.title, bodyChars: (doc.body?.textContent ?? '').trim().length,
    inputs: doc.querySelectorAll('input,textarea,select').length, buttons: doc.querySelectorAll('button,[role=button],input[type=submit]').length,
  };
  if (exercise) {
    // Best-effort, scenario-agnostic behaviour probe: fill every text/number/select field, press the first button or submit
    // the form, and expect the page to reflect the entry (the probe text, or the number 5 newly appearing).
    const probe = 'GoldenProbe42';
    const numbersIn = text => new Set((text.match(/\d+(?:[.,]\d+)?/g) ?? []).map(n => Number(n.replace(',', '.'))));
    try {
      // Visible text only: <script>/<style> source contains digits and words that would mask a real change.
      const visible = () => { const clone = doc.body.cloneNode(true); clone.querySelectorAll('script,style,noscript').forEach(node => node.remove()); return clone.textContent ?? ''; };
      const before = visible();
      const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
      // Numeric intent is read from type, inputmode or a name/id/placeholder hint (amount, price, qty, minutes...), not just type=number.
      const numericHint = /\b(?:amount|price|cost|total|qty|quantity|count|number|minutes?|score|value|sum|budget|balance)\b/i;
      for (const input of doc.querySelectorAll('input[type=text],input:not([type]),input[type=search],input[inputmode],textarea')) {
        const numeric = /^(?:decimal|numeric)$/i.test(input.getAttribute('inputmode') ?? '') || numericHint.test([input.id, input.name, input.placeholder, input.getAttribute('aria-label')].join(' '));
        input.value = numeric ? '5' : probe; fire(input, 'input');
      }
      for (const input of doc.querySelectorAll('input[type=date]')) { input.value = new Date().toISOString().slice(0, 10); fire(input, 'input'); }
      for (const input of doc.querySelectorAll('input[type=time]')) { input.value = '12:00'; fire(input, 'input'); }
      for (const input of doc.querySelectorAll('input[type=number]')) { input.value = '5'; fire(input, 'input'); }
      for (const select of doc.querySelectorAll('select')) { const option = [...select.options].find(o => o.value); if (option) { select.value = option.value; fire(select, 'change'); } }
      const form = doc.querySelector('form');
      const button = doc.querySelector('form button[type=submit], form button:not([type]), button[type=submit], input[type=submit]') ?? doc.querySelector('button');
      if (form?.requestSubmit) { try { form.requestSubmit(button ?? undefined); } catch { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); } }
      else { button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); }
      await sleep(300);
      const after = visible();
      const newNumbers = [...numbersIn(after)].filter(n => !numbersIn(before).has(n));
      summary.exercised = after.includes(probe) || newNumbers.includes(5);
      summary.exerciseDetail = { probeRendered: after.includes(probe), newNumbers: newNumbers.slice(0, 6), textChanged: after !== before };
    } catch (error) { summary.exercised = false; summary.exerciseError = String(error).slice(0, 150); }
    summary.errorsAfterExercise = errors.slice(0, 5);
  }
  dom.window.close();
  return summary;
}
// Markup-level view for feature-presence probes: HTML (with any script-built templates), without <style> blocks or CSS files.
let summaryAdded = [];
const idClassTokens = () => new Set([...markupText().matchAll(/(?:id|class)=["']([^"']+)["']/gi)].flatMap(match => match[1].split(/\s+/)).filter(Boolean));
const markupText = () => Object.values(readAll(WORKSPACE, ['.html'])).join(String.fromCharCode(10)).replace(/<style[\s\S]*?<\/style>/gi, '');
const allText = () => Object.entries(readAll(WORKSPACE, ['.html', '.js', '.css', '.mjs'])).map(([f, c]) => `/* ${f} */\n${c}`).join('\n');
const totalBytes = () => Object.values(readAll(WORKSPACE)).reduce((n, c) => n + c.length, 0);

// ── fixtures ─────────────────────────────────────────────────────────────────
const FIXTURE_ORDERS = { git: true, files: {
  'package.json': JSON.stringify({ name: 'order-sync', version: '1.0.0', main: 'src/index.js', scripts: { start: 'node src/index.js', test: 'node --test test/' } }, null, 2) + '\n',
  'README.md': '# order-sync\n\nPulls pending orders from a remote API, normalises them and writes a daily summary file.\n\nRun with `npm start`.\n',
  'src/index.js': "const { syncOrders } = require('./sync');\n\nsyncOrders(process.env.ORDERS_URL || 'http://localhost:3000/orders')\n  .then(summary => console.log('synced', summary.count, 'orders'))\n  .catch(error => { console.error('sync failed:', error.message); process.exitCode = 1; });\n",
  'src/sync.js': "const { httpGetJson } = require('./http');\nconst { normalise } = require('./normalise');\nconst fs = require('fs');\n\nasync function syncOrders(url) {\n  const raw = await httpGetJson(url);\n  const orders = raw.map(normalise);\n  fs.writeFileSync('daily-summary.json', JSON.stringify({ count: orders.length, orders }, null, 2));\n  return { count: orders.length };\n}\n\nmodule.exports = { syncOrders };\n",
  'src/http.js': "// Minimal HTTP helper. One attempt, no retry: any network error is thrown to the caller.\nasync function httpGetJson(url) {\n  const response = await fetch(url);\n  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);\n  return response.json();\n}\n\nmodule.exports = { httpGetJson };\n",
  'src/normalise.js': "function normalise(order) {\n  return { id: String(order.id), total: Number(order.total) || 0, status: (order.status || 'pending').toLowerCase() };\n}\n\nmodule.exports = { normalise };\n",
  'test/normalise.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { normalise } = require('../src/normalise');\n\ntest('normalise lowercases status', () => {\n  assert.strictEqual(normalise({ id: 1, total: '5', status: 'PAID' }).status, 'paid');\n});\n",
} };
const FIXTURE_CART = { git: true, files: {
  'package.json': JSON.stringify({ name: 'shop', version: '1.0.0', scripts: { test: 'node --test test/' } }, null, 2) + '\n',
  'src/cart.js': "const { percentOff } = require('./money');\n\n// Cart totals. `percent` is a percentage, e.g. 10 means ten percent." + "\nfunction applyDiscount(total, percent) {\n  return percentOff(total, percent);\n}\n\nfunction cartTotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n\nmodule.exports = { applyDiscount, cartTotal };\n",
  'src/money.js': "// Money helpers shared by pricing code.\n// percentOff(amount, percent): the amount after taking `percent` percent off it.\nfunction percentOff(amount, percent) {\n  return amount - percent;\n}\n\nfunction toCents(amount) {\n  return Math.round(amount * 100);\n}\n\nmodule.exports = { percentOff, toCents };\n",
  'src/checkout.js': "const { applyDiscount, cartTotal } = require('./cart');\n\nfunction checkout(items, couponPercent) {\n  return applyDiscount(cartTotal(items), couponPercent);\n}\n\nmodule.exports = { checkout };\n",
  'test/cart.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { applyDiscount } = require('../src/cart');\n\ntest('a 10 percent coupon takes ten percent off', () => {\n  assert.strictEqual(applyDiscount(200, 10), 180);\n});\n",
} };

function pathsMentioned(text) {
  // Only tokens that are unmistakably file references: contain a directory separator, or sit in backticks and are
  // not a method call / well-known name ("Node.js", "res.json()" are prose, not paths).
  const slash = text.match(/[\w.-]+(?:\/[\w.-]+)+\.(?:js|json|md|html|css|mjs)\b/g) ?? [];
  const ticked = [...text.matchAll(/`([\w./-]+\.(?:js|json|md|html|css|mjs))`/g)].map(m => m[1]).filter(name => !/^(?:node|res|response|req|request)\./i.test(name));
  return [...new Set([...slash, ...ticked].map(p => p.replace(/^\.\//, '')))];
}
function existsAnywhere(name) {
  const files = Object.keys(readAll(WORKSPACE));
  return files.some(f => f === name || f.endsWith(`/${name}`) || path.basename(f) === path.basename(name));
}

const record = { golden: GOLDEN, seed: SEED, model, provider: 'ollama', baseUrl, contextSize: arg('--context', 'default'), workspace: WORKSPACE, checks: [] };

// ── Goldens ──────────────────────────────────────────────────────────────────
async function goldenA() {
  resetWorkspace(FIXTURE_ORDERS);
  record.startState = `git ${git(WORKSPACE, ['rev-parse', '--short', 'HEAD'])}`;
  await launchHost({ fresh: true });
  const t1 = await turn('A1', 'What does this project do and where does the main execution start?', { kind: 'readonly' });
  check('A1', 'no ambiguity prompt', !t1.ambiguityShown);
  check('A1', 'completed', t1.attemptStatus === 'completed', [t1.attemptStatus, t1.resolvedMode]);
  check('A1', 'answer is grounded in the repository: names real files/symbols and does not claim to have no code',
    /syncOrders|sync\.js|http\.js|normalise|order-sync|daily summary/i.test(t1.assistantTail) && /index\.js/i.test(t1.assistantTail) && !/(don't|do not) have (any )?(project|code|repository|access)|share (at least|the|your)|paste the relevant/i.test(t1.assistantTail), t1.assistantTail);
  noMutationSurface('A1', t1);
  const conversation = t1.coreConversationId;
  const t2 = await turn('A2', 'Which part would you change if I wanted retries?', { kind: 'readonly' });
  check('A2', 'continues the same conversation, no ambiguity prompt', !t2.ambiguityShown && t2.coreConversationId === conversation, [conversation, t2.coreConversationId]);
  check('A2', 'points at the HTTP helper (repository evidence)', /http\.js|httpGetJson|src\/http/i.test(t2.assistantTail), t2.assistantTail);
  noMutationSurface('A2', t2);
  const t3 = await turn('A3', 'Why that one?', { kind: 'readonly' });
  check('A3', 'continuity: same conversation and no ambiguity', !t3.ambiguityShown && t3.coreConversationId === conversation);
  check('A3', 'answer is about the previous choice (retry/network/http), not a fresh topic', /retry|retries|network|fetch|http|request|fail/i.test(t3.assistantTail), t3.assistantTail);
  noMutationSurface('A3', t3);
  const t4 = await turn('A4', 'Show me the relevant files.', { kind: 'readonly' });
  check('A4', 'continuity kept', !t4.ambiguityShown && t4.coreConversationId === conversation);
  check('A4', 'shows the http helper content or path', /http\.js|httpGetJson/i.test(t4.assistantTail), t4.assistantTail);
  noMutationSurface('A4', t4);
  const mentioned = [t1, t2, t3, t4].flatMap(t => pathsMentioned(t.assistantTail));
  const invented = mentioned.filter(p => !existsAnywhere(p) && !/^(package|README|daily-summary)/i.test(p));
  check('A', 'no hallucinated file paths in any answer', invented.length === 0, invented);
  record.turns = [t1, t2, t3, t4].map(t => ({ step: t.step, mode: t.resolvedMode, status: t.attemptStatus }));
}

async function goldenB() {
  resetWorkspace(FIXTURE_CART);
  record.startState = `git ${git(WORKSPACE, ['rev-parse', '--short', 'HEAD'])}`;
  await launchHost({ fresh: true });
  const t1 = await turn('B1', 'A 10% coupon on a $200 cart gives $190 instead of $180. Can you inspect why this is happening and tell me what you think is wrong? Do not change anything yet.', { kind: 'readonly' });
  check('B1', 'completed, no ambiguity', t1.attemptStatus === 'completed' && !t1.ambiguityShown, [t1.attemptStatus, t1.ambiguityShown]);
  check('B1', 'tools were used (repository was actually inspected)', (t1.policy?.toolInvocationCount ?? 0) > 0, t1.policy?.toolInvocationCount);
  check('B1', 'root cause identified in the helper: percentOff (src/money.js) subtracts the percent value instead of taking a percentage', /percentOff|money\.js/i.test(t1.assistantTail) && /(amount\s*-\s*percent|subtract|percent.*(not|instead)|treats? .*percent)/i.test(t1.assistantTail), t1.assistantTail);
  noMutationSurface('B1', t1);
  const t2 = await turn('B2', 'Which existing test covers this?', { kind: 'readonly' });
  check('B2', 'conversation continues after tool use', !t2.ambiguityShown && t2.coreConversationId === t1.coreConversationId);
  check('B2', 'names the cart test', /cart\.test\.js|test\/cart/i.test(t2.assistantTail), t2.assistantTail);
  noMutationSurface('B2', t2);
  const t3 = await turn('B3', 'Show me the exact line responsible.', { kind: 'readonly' });
  check('B3', 'quotes the offending line', /amount\s*-\s*percent/.test(t3.assistantTail), t3.assistantTail);
  noMutationSurface('B3', t3);
  check('B', 'repository byte-identical to the committed state', git(WORKSPACE, ['status', '--porcelain']).replace(/\.ollama-agent\/?/g, '').trim() === '' || git(WORKSPACE, ['diff', '--stat']).trim() === '', git(WORKSPACE, ['status', '--porcelain']));
  record.turns = [t1, t2, t3].map(t => ({ step: t.step, mode: t.resolvedMode, status: t.attemptStatus, tools: t.policy?.toolInvocationCount }));
}

// Feature-presence probes look for markup-level evidence (ids/classes/labels), not bare words: CSS `filter: brightness()` and
// Array.prototype.filter are not a filter feature, and a leftover `.summary` rule is not a summary card.
const KEEP = {
  dark: /dark/i, persist: /localStorage/, mobile: /@media/i, name: /<h[12][^>]*>[^<]*Momentum/i, // visible heading, not just <title>
  filter: /<[a-z][^>]*\b(?:id|class|name|aria-label|data-[\w-]+)=["'][^"']*filter|\b(?:id|className)\s*=\s*["'][^"']*filter|<[a-z][^>]*>[^<>]*\b(?:Show|Filter)\b[^<>]*<\//i,
  summary: /<[a-z][^>]*\b(?:id|class|aria-label)=["'][^"']*summary|<[a-z][^>]*>[^<>]*\bSummary\b[^<>]*<\//i,
};

async function coding(step, prompt, opts = {}) {
  const t = await turn(step, prompt, { kind: 'coding', timeoutMs: 25 * 60_000, ...opts });
  const facts = taskFacts(await snapshot().then(s => s.taskId).catch(() => null), step);
  t.facts = facts;
  const app = await loadApp({ exercise: true }).catch(error => ({ ok: false, reason: String(error).slice(0, 200) }));
  t.app = app;
  fs.writeFileSync(path.join(evidenceDir, `app-${step}.json`), JSON.stringify(app, null, 2));
  return t;
}

// Cumulative requirement ledger: EVALUATION evidence only, never shown to the model.
const ledger = {};
const ledgerHistory = [];
function ledgerAdd(id, text, probe) { ledger[id] = { text, probe, status: 'ACTIVE' }; }
async function ledgerCheck(step) {
  const text = allText();
  const live = await loadApp({ exercise: true }).catch(error => ({ ok: false, exercised: false, reason: String(error).slice(0, 150) }));
  if (ledger.core) ledger.core.probe = () => live.ok && live.exercised === true;
  const rows = Object.entries(ledger).map(([id, r]) => ({ id, text: r.text, status: r.status, ok: r.status === 'REMOVED' ? !r.probe(text) : r.probe(text) }));
  ledgerHistory.push({ step, rows });
  fs.writeFileSync(path.join(evidenceDir, 'requirement-ledger.json'), JSON.stringify(ledgerHistory, null, 2));
  const broken = rows.filter(r => !r.ok);
  check(step, `requirement ledger holds (${rows.length - broken.length}/${rows.length})`, broken.length === 0, broken);
}

async function goldenFGHIJ() {
  const intent = generateIntent(SEED);
  record.scenario = intent.scenario; record.prompt = intent.prompt;
  fs.writeFileSync(path.join(evidenceDir, 'intent.json'), JSON.stringify({ ...intent, model, gitHead: git(root, ['rev-parse', 'HEAD']) }, null, 2));
  log('F intent:', JSON.stringify(intent));
  resetWorkspace({ git: false, files: { 'README.md': '# Workspace\n\nEmpty project folder.\n' } });
  record.startState = 'empty workspace (README.md only), no git';
  await launchHost({ fresh: true });

  // F — create from scratch
  const f = await coding('F', intent.prompt);
  check('F', 'task completed', f.attemptStatus === 'completed' || f.taskState === 'completed', [f.attemptStatus, f.taskState, f.facts]);
  check('F', 'files were created', f.treeChanged);
  check('F', 'app loads without script errors and has interactive controls', f.app.ok && f.app.inputs + f.app.buttons > 0, f.app);
  const bytesF = totalBytes();
  check('F', 'no architecture explosion (<=25 files, <=400KB)', Object.keys(readAll(WORKSPACE)).length <= 25 && bytesF < 400_000, [Object.keys(readAll(WORKSPACE)).length, bytesF]);
  const filesAfterF = Object.keys(readAll(WORKSPACE));
  ledgerAdd('core', `primary behaviour from the intent works (probe input renders): ${intent.scenario}`, () => true);
  ledger.core.appProbe = true;
  check('F', 'primary requested behaviour works (probe entry renders in the running page)', f.app.exercised === true, f.app);

  // G1, G2
  const g1 = await coding('G1', 'Looks good. Add dark mode.');
  check('G1', 'completed', g1.attemptStatus === 'completed' || g1.taskState === 'completed', [g1.attemptStatus, g1.taskState]);
  check('G1', 'dark mode present, app still loads, original files kept', KEEP.dark.test(allText()) && g1.app.ok && filesAfterF.every(file => fs.existsSync(path.join(WORKSPACE, file))), [g1.app, filesAfterF]);
  ledgerAdd('dark', 'dark mode', t => /dark/i.test(t));
  await ledgerCheck('G1');
  const bytesG1 = totalBytes();
  check('G1', 'not regenerated from scratch (size within 0.6x-2.5x)', bytesG1 > bytesF * 0.6 && bytesG1 < bytesF * 2.5, [bytesF, bytesG1]);
  const g2 = await coding('G2', 'Make it remember the selected mode when I reopen the app.');
  check('G2', 'completed', g2.attemptStatus === 'completed' || g2.taskState === 'completed', [g2.attemptStatus, g2.taskState]);
  check('G2', 'persistence added and dark mode kept', KEEP.persist.test(allText()) && KEEP.dark.test(allText()) && g2.app.ok, g2.app);

  // H — restart between G2 and G3
  const treeBeforeRestart = treeHash();
  const conversationBefore = (await snapshot()).conversationId;
  const approvalsBefore = withDb(db => db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n);
  log('H: restarting VS Code');
  await stopHost();
  await launchHost({ fresh: false });
  await shot('H-after-restart');
  const afterRestart = await snapshot();
  const approvalsAfter = withDb(db => db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n);
  check('H', 'no mutation happened while restarting (workspace bytes identical)', treeHash() === treeBeforeRestart);
  check('H', 'no approval replayed or fabricated by the restart', approvalsAfter === approvalsBefore && afterRestart.cards.every(card => !card.actionable), [approvalsBefore, approvalsAfter, afterRestart.cards]);
  check('H', 'no fabricated user turn in the transcript', afterRestart.userTexts.every(text => [intent.prompt, 'Looks good. Add dark mode.', 'Make it remember the selected mode when I reopen the app.'].some(sent => text.includes(sent.slice(0, 30)))), afterRestart.userTexts);
  check('H', 'panel is usable (Send ready)', afterRestart.primaryAction === 'Send' && !afterRestart.composerDisabled);
  record.restart = { conversationBefore, conversationAfter: afterRestart.conversationId, userTextsAfter: afterRestart.userTexts.length };

  ledgerAdd('persist', 'selected theme persists', t => /localStorage/.test(t));
  await ledgerCheck('G2');
  const g3 = await coding('G3', intent.filterAsk);
  check('G3', 'continues after restart without treating it as a new project', !g3.ambiguityShown && (g3.attemptStatus === 'completed' || g3.taskState === 'completed'), [g3.ambiguityShown, g3.attemptStatus, g3.taskState]);
  check('H', 'no lost requirements after restart: filter added, dark mode and persistence kept', KEEP.filter.test(markupText()) && KEEP.dark.test(allText()) && KEEP.persist.test(allText()) && g3.app.ok, g3.app);
  ledgerAdd('filter', 'filter control', () => KEEP.filter.test(markupText()));
  await ledgerCheck('G3');
  const g4 = await coding('G4', 'The mobile view feels cramped. Improve it without changing the desktop layout too much.');
  check('G4', 'completed, responsive rules present, earlier features kept', (g4.attemptStatus === 'completed' || g4.taskState === 'completed') && KEEP.mobile.test(allText()) && KEEP.filter.test(markupText()) && KEEP.dark.test(allText()) && g4.app.ok, [g4.attemptStatus, g4.taskState, g4.app]);
  ledgerAdd('mobile', 'mobile layout rules', t => /@media/i.test(t));
  await ledgerCheck('G4');
  const tokensBeforeG5 = idClassTokens();
  const g5 = await coding('G5', 'Rename the app to Momentum and add a small summary card.');
  // The summary card is whatever NEW id/class hooks G5 introduced for it; a pre-existing "category-summary" is a different feature.
  summaryAdded = [...idClassTokens()].filter(token => !tokensBeforeG5.has(token) && /summary|stat|kpi|overview|total/i.test(token));
  check('G5', 'completed, renamed, summary added, earlier features kept', (g5.attemptStatus === 'completed' || g5.taskState === 'completed') && KEEP.name.test(markupText()) && summaryAdded.length > 0 && KEEP.dark.test(allText()) && KEEP.persist.test(allText()) && KEEP.filter.test(markupText()) && g5.app.ok, [g5.attemptStatus, g5.taskState, g5.app]);
  ledgerAdd('name', 'renamed to Momentum (visible heading)', () => KEEP.name.test(markupText()));
  ledgerAdd('summary', 'summary card (the elements G5 added)', () => summaryAdded.some(token => idClassTokens().has(token)));
  await ledgerCheck('G5');
  // I - vague polish (the summary card must survive it)
  const bytesBeforeI = totalBytes();
  const ti = await coding('I', "Make it feel more polished and easier to use, but don't turn it into a big application.");
  check('I', 'completed', ti.attemptStatus === 'completed' || ti.taskState === 'completed', [ti.attemptStatus, ti.taskState]);
  check('I', 'inspected the app before changing it', (ti.policy?.toolInvocationCount ?? 0) > 0 || Object.keys(ti.facts?.journalRecords ?? {}).length > 0, [ti.policy?.toolInvocationCount, ti.facts?.journalRecords]);
  check('I', 'modest, demonstrable change (not a rewrite)', ti.treeChanged && totalBytes() < bytesBeforeI * 1.8, [bytesBeforeI, totalBytes()]);
  await ledgerCheck('I');
  check('I', 'explains what changed', ti.assistantTail.trim().length > 40, ti.assistantTail);

  // J - selective reversal: remove only the summary card (a G5 decision)
  const summaryBefore = (allText().match(/summary/gi) ?? []).length;
  ledger.summary.status = 'REMOVED';
  const tj = await coding('J', "I don't like the summary card. Remove only that. Keep the dark mode, the filter, the mobile improvements and everything else.");
  check('J', 'completed', tj.attemptStatus === 'completed' || tj.taskState === 'completed', [tj.attemptStatus, tj.taskState]);
  check('J', 'summary card actually removed (none of the elements G5 added remain)', !summaryAdded.some(token => idClassTokens().has(token)), { summaryAdded, remaining: summaryAdded.filter(token => idClassTokens().has(token)) });
  await ledgerCheck('J');
  record.turns = [f, g1, g2, g3, g4, g5, ti, tj].map(t => ({ step: t.step, mode: t.resolvedMode, status: t.attemptStatus, task: t.taskState, facts: t.facts, filesChangedTree: t.treeChanged }));
}

// N (M47.1) - empty workspace, single-file creation, truthful validation state, then a short continuation that must MODIFY the
// existing artifact rather than regenerate it. Deliberately small: the long large-artifact path is already proven.
async function goldenN() {
  resetWorkspace({ git: false, files: {} });
  record.startState = 'empty workspace (no files), no git';
  await launchHost({ fresh: true });

  const n1 = await coding('N1', 'Create a single-file index.html: a small habit tracker dashboard with a heading that says Habit Pulse, an input to add a habit, a list of habits and a completion count. Keep everything inside index.html.');
  check('N1', 'task completed', n1.attemptStatus === 'completed' || n1.taskState === 'completed', [n1.attemptStatus, n1.taskState, n1.facts]);
  const indexPath = path.join(WORKSPACE, 'index.html');
  check('N1', 'index.html was created and is non-empty (governed write landed)', fs.existsSync(indexPath) && fs.statSync(indexPath).size > 200, fs.existsSync(indexPath) ? fs.statSync(indexPath).size : 'missing');
  check('N1', 'the page loads without script errors and has interactive controls', n1.app.ok && n1.app.inputs + n1.app.buttons > 0, n1.app);
  check('N1', 'single file: exactly one project file', Object.keys(readAll(WORKSPACE)).filter(file => !file.startsWith('.ollama-agent')).length === 1, Object.keys(readAll(WORKSPACE)));
  // Truthful validation: an empty workspace has no test or build gate. The reply must not claim tests passed.
  const validationClaim = /\b(all )?tests? (passed|pass|passing)\b|\bvalidation (passed|succeeded)\b|\bbuild (passed|succeeded)\b/i;
  check('N1', 'does not claim a test/build pass that could not have run', !validationClaim.test(n1.assistantTail), n1.assistantTail.slice(-600));
  const firstBytes = fs.readFileSync(indexPath, 'utf8');
  const firstBytesCount = Buffer.byteLength(firstBytes);
  record.n1 = { bytes: firstBytesCount, assistantTail: n1.assistantTail.slice(-600) };

  const n2 = await coding('N2', 'Add dark mode.');
  check('N2', 'task completed', n2.attemptStatus === 'completed' || n2.taskState === 'completed', [n2.attemptStatus, n2.taskState]);
  const secondBytes = fs.readFileSync(indexPath, 'utf8');
  check('N2', 'the existing artifact was modified (bytes changed)', secondBytes !== firstBytes);
  // A page generated dark by default gets a light/dark TOGGLE for "dark mode", so accept any theme-switching evidence, not only the word.
  check('N2', 'dark mode / theme switching is present', /dark|prefers-color-scheme|color-scheme|body\.light|data-theme|theme/i.test(secondBytes));
  check('N2', 'the original content survived (Habit Pulse heading and the add-habit input), i.e. modified not regenerated blindly', /Habit Pulse/i.test(secondBytes) && /<input/i.test(secondBytes), secondBytes.slice(0, 300));
  check('N2', 'not regenerated from scratch (size within 0.6x-2.5x of the first version)', Buffer.byteLength(secondBytes) > firstBytesCount * 0.6 && Buffer.byteLength(secondBytes) < firstBytesCount * 2.5, [firstBytesCount, Buffer.byteLength(secondBytes)]);
  check('N2', 'still one file and the page still loads', Object.keys(readAll(WORKSPACE)).filter(file => !file.startsWith('.ollama-agent')).length === 1 && n2.app.ok, n2.app);
  record.n2 = { bytes: Buffer.byteLength(secondBytes), assistantTail: n2.assistantTail.slice(-600) };
  record.turns = [n1, n2].map(t => ({ step: t.step, mode: t.resolvedMode, status: t.attemptStatus, task: t.taskState, facts: t.facts }));
}

async function main() {
  if (!fs.existsSync(vsixPath)) throw new Error(`VSIX not found: ${vsixPath}`);
  const vsixSha = crypto.createHash('sha256').update(fs.readFileSync(vsixPath)).digest('hex');
  record.vsix = { path: vsixPath, sha256: vsixSha, gitHead: git(root, ['rev-parse', 'HEAD']) };
  fs.writeFileSync(path.join(evidenceDir, 'run-identity.json'), JSON.stringify({ ...record, runDir, userDataDir, extensionsDir, coreDataDir, startedAt: new Date().toISOString() }, null, 2));
  log('VSIX', vsixPath, vsixSha.slice(0, 16), 'golden', GOLDEN, 'model', model);
  if (GOLDEN === 'A') await goldenA();
  else if (GOLDEN === 'B') await goldenB();
  else if (GOLDEN === 'FGHIJ') await goldenFGHIJ();
  else if (GOLDEN === 'N') await goldenN();
  else throw new Error(`unknown golden ${GOLDEN}`);
}

let exitCode = 0;
const startedAt = Date.now();

// Outer watchdog: a qualification harness must itself always terminate, and say why. Layers: per-operation timeouts
// (evalDoc/screenshot 20s), per-turn timeouts (turn()), and this whole-Golden cap (A/B 10 min, F->J trajectory 75 min).
const WATCHDOG_MINUTES = Number(arg('--max-minutes', GOLDEN === 'FGHIJ' ? '75' : GOLDEN === 'N' ? '40' : '10'));
const watchdog = setTimeout(async () => {
  log(`HARNESS_TIMEOUT: golden ${GOLDEN} exceeded ${WATCHDOG_MINUTES} min; capturing state and terminating`);
  const evidence = { golden: GOLDEN, limitMinutes: WATCHDOG_MINUTES, at: new Date().toISOString(), lastTurn: turns.at(-1)?.step ?? null };
  try { await shot('watchdog'); } catch { /* best effort */ }
  try { evidence.uiSnapshot = (await snapshot()).bodyText.slice(-2500); } catch (error) { evidence.uiSnapshot = `unavailable: ${String(error).slice(0, 120)}`; }
  try { evidence.coreLogTail = fs.readFileSync(path.join(coreDataDir, 'logs', 'core.log'), 'utf8').split(String.fromCharCode(10)).slice(-15).join(String.fromCharCode(10)); } catch { /* no core log yet */ }
  try {
    fs.writeFileSync(path.join(evidenceDir, 'm47-golden-result.json'), JSON.stringify({
      verdict: 'HARNESS_TIMEOUT', classification: 'test harness / environment (not attributed to the product)', durationMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(), coreDataDir, ...record, results, turnsDetail: turns, watchdog: evidence,
    }, null, 2));
  } catch { /* best effort */ }
  try { killOwnedCode(); } catch { /* best effort */ }
  process.exit(3);
}, WATCHDOG_MINUTES * 60_000);
try {
  await main();
  log('ALL STEPS PASSED');
} catch (error) {
  exitCode = 1;
  log(error instanceof RunFailure ? 'STOPPED ON FIRST FAILURE:' : 'HARNESS ERROR:', error.message);
  if (!(error instanceof RunFailure)) console.error(error);
  await shot('failure').catch(() => undefined);
} finally {
  try {
    // The capability profile KKD wrote for this runtime, as evidence of what it learned.
    const profiles = [];
    const walk = dir => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'runtime-profiles.json') profiles.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } };
    walk(PROFILE_GLOB_ROOT());
    record.runtimeProfiles = profiles.flatMap(store => Object.values(store.profiles ?? {}));
  } catch { /* evidence is best-effort */ }
  fs.writeFileSync(path.join(evidenceDir, 'm47-golden-result.json'), JSON.stringify({
    verdict: exitCode === 0 ? 'PASS' : 'FAIL', durationMs: Date.now() - startedAt, finishedAt: new Date().toISOString(), coreDataDir, ...record, results, turnsDetail: turns,
  }, null, 2));
  log('evidence:', evidenceDir);
  try { await stopHost(); } catch { /* window may already be closed */ }
  process.exit(exitCode);
}
