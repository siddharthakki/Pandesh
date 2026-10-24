// Visible acceptance for the repository-context budgeting blocker: the packaged
// VSIX in a disposable, FOREGROUND VS Code profile, opened on the real
// C:\Projects\apps\khakedikha repository, sent the exact inspection prompt that
// failed in the normal profile with "repository context prompt must be
// non-empty and at most 100000 characters". Driven through the real webview via
// CDP (type/click only). The workspace is never reset or modified: every turn
// must leave its bytes and `git status` exactly as they were.
//
//   node scripts/run-visible-khakedikha-inspection.mjs [--vsix karkedikha-win32-x64.vsix]
//        [--modes chat,agent,auto] [--context-window 32768]
//
// Settings mirror the normal profile (models, contextWindow 32768 unless
// --context-window is given,
// maxOutputTokens 8192, local-only routing). The repository index lives in an
// isolated directory so a concurrently open normal window cannot contend on it.
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

const root = path.resolve(import.meta.dirname, '..');
const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const WORKSPACE = 'C:\\Projects\\apps\\khakedikha';
const PROMPT = 'Inspect this repository and explain its architecture, major components, and current state. Do not modify anything.';
const OVERSIZE_ERROR = /repository context prompt must be non-empty/i;
const vsixPath = path.resolve(root, arg('--vsix', 'karkedikha-win32-x64.vsix'));
const baseUrl = arg('--base-url', 'http://127.0.0.1:11434');
// Written to `ollama-agent.contextWindow` in the disposable profile, so a small
// window (e.g. 8192) can exercise context compaction against the real model.
const contextWindow = Number(arg('--context-window', '32768'));
if (!Number.isInteger(contextWindow) || contextWindow < 2048) {
  throw new Error(`--context-window must be an integer of at least 2048, got '${arg('--context-window', '')}'`);
}
const codeExe = path.join(root, '.guardian-cache', 'extest', 'VSCode-win32-x64-archive', 'Code.exe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(os.tmpdir(), `kkd-khakedikha-inspection-${stamp}`);
const evidenceDir = path.join('E:/kkd-eval-lab/artifacts/khakedikha_inspection', stamp);
const userDataDir = path.join(runDir, 'user-data');
const extensionsDir = path.join(runDir, 'extensions');
const coreDataDir = path.join(runDir, 'core-data');
const indexRoot = path.join(runDir, 'repository-index');
fs.mkdirSync(evidenceDir, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sha16 = content => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
const MUTATING_TOOL = /propose|write|delete|rename|apply|commit|patch/i;
// A shell request that could change the workspace is never approved.
const WRITE_COMMAND = /(^|[\s"';&|(])(del|erase|rm|rmdir|rd|move|mv|copy|cp|xcopy|robocopy|mkdir|md|ren|rename|touch|set-content|out-file|new-item|remove-item)\b|>|\bgit\s+(add|commit|checkout|reset|restore|stash|push|pull|merge|rebase|clean|rm|mv|apply)\b|\b(pip|npm|pnpm|yarn)\s+(install|uninstall|add|remove)\b|manage\.py\s+(migrate|makemigrations|collectstatic|flush|loaddata|createsuperuser|shell|runserver)\b/i;
// Directories the extension itself owns (task store) or that are VCS/IDE
// state; `*.log` files belong to a possibly running dev server, not to us.
const HASH_SKIP_DIRS = new Set(['.git', '.ollama-agent', '.vscode', '.idea']);

const log = (...parts) => console.log(`[khakedikha-inspection ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const results = [];
const turns = [];
let pageClient;
let chat;

function treeHash() {
  const entries = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (HASH_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith('.log')) entries.push(`${path.relative(WORKSPACE, full)}:${sha16(fs.readFileSync(full))}`);
    }
  };
  walk(WORKSPACE);
  return sha16(entries.sort().join('\n'));
}
const gitStatus = () => git(WORKSPACE, ['status', '--porcelain=v1', '--untracked-files=all'])
  .split(/\r?\n/).filter(line => line && !/\.log$/.test(line) && !/(^|\s)\.ollama-agent\//.test(line)).join('\n');

// ── webview access (CDP; DOM read/click/type only) ───────────────────────────
const evalDoc = expression => ui.evalInWebviewDoc(chat, expression);

async function snapshot() {
  return evalDoc(`(() => {
    const isRendered = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const primary = document.getElementById('send-btn');
    return {
      bodyText: document.body.innerText,
      primaryAction: primary?.textContent?.trim() || null,
      composerDisabled: !!document.getElementById('user-input')?.disabled,
      // Answer bubbles only: governed-action / approval / confirmation cards share
      // \`.bubble.assistant\` but carry a card class, and an in-flight bubble is kd-dhadkan.
      assistantTexts: Array.from(document.querySelectorAll('#messages .bubble.assistant:not(.approval-card):not(.capability-approval-card):not(.research-approval-card):not(.mutation-confirmation-card):not(.story-draft-card):not(.workspace-required-card):not(.kd-dhadkan)')).filter(isRendered).map(e => e.textContent || '').filter(text => text.trim().length > 0),
      errorTexts: Array.from(document.querySelectorAll('#messages .bubble.error, #messages .error, .error-banner')).filter(isRendered).map(e => e.textContent || ''),
      activeMode: document.querySelector('#mode-buttons .mode-button.active')?.dataset?.mode || null,
      cards: ['proposal', 'mutation', 'delivery'].map(kind => {
        const card = document.getElementById(kind + '-approval-card');
        return { kind, visible: isRendered(card), text: isRendered(card) ? card.innerText.slice(0, 300) : null };
      }),
      toolApprovalButtons: Array.from(document.querySelectorAll('[data-approval-response="approved"]')).filter(b => !b.disabled && isRendered(b))
        .map(b => ({ approvalId: b.dataset.approvalId || null, tool: b.dataset.toolName || null })),
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

async function selectMode(mode) {
  await waitComposerReady();
  await evalDoc(`document.querySelector('#mode-buttons [data-mode=${JSON.stringify(mode)}]')?.click()`);
  await sleep(600);
  const active = (await snapshot()).activeMode;
  if (active !== mode) throw new Error(`mode ${mode} did not become active (active=${active})`);
}

async function typeAndSend(text) {
  await waitComposerReady();
  await evalDoc(`(() => { const t = document.getElementById('user-input'); t.focus(); t.value = ''; return true; })()`);
  await chat.Input.insertText({ text });
  let typed = await evalDoc(`document.getElementById('user-input').value`);
  if (typed !== text) {
    await evalDoc(`(() => { const t = document.getElementById('user-input'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    typed = await evalDoc(`document.getElementById('user-input').value`);
  }
  if (typed !== text) throw new Error(`composer text mismatch: ${JSON.stringify(typed).slice(0, 120)}`);
  await sleep(600); // let the viewer watch the text land before it is sent
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

function findNewCoreTurn(known) {
  return withDb(db => {
    const request = db.prepare('SELECT * FROM requests WHERE currentMessage = ? ORDER BY createdAt DESC').all(PROMPT).find(row => !known.has(row.id));
    if (!request) return null;
    const attempt = db.prepare('SELECT * FROM attempts WHERE requestId = ? ORDER BY createdAt DESC LIMIT 1').get(request.id) ?? null;
    return { request, attempt };
  });
}

function attemptEvidence(attemptId, sinceIso) {
  return withDb(db => {
    const context = db.prepare('SELECT selectedModel, repositoryContext FROM attempt_contexts WHERE attemptId = ?').get(attemptId);
    const repository = context?.repositoryContext ? JSON.parse(context.repositoryContext) : null;
    return {
      selectedModel: context?.selectedModel ?? null,
      repositoryPromptChars: repository?.prompt?.length ?? 0,
      repositoryEstimatedTokens: repository?.estimatedTokens ?? null,
      repositorySelectedFiles: repository?.selectedFiles?.map(file => file.path) ?? [],
      repositoryHasOverview: /### Repository overview/.test(repository?.prompt ?? ''),
      mutationApprovals: db.prepare(`SELECT id, json_extract(summary, '$.toolName') AS tool, status FROM approvals WHERE requestedAt >= ? AND json_extract(summary, '$.toolName') IN ('propose_file_change','propose_text_edit')`).all(sinceIso),
      toolInvocations: db.prepare('SELECT toolName, status FROM tool_invocations WHERE attemptId = ?').all(attemptId),
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

async function inspectionTurn(step, mode, timeoutMs = 15 * 60_000) {
  if (mode !== 'auto') await selectMode(mode);
  const known = knownRequestIds();
  const sinceIso = new Date().toISOString();
  const treeBefore = treeHash();
  const gitBefore = gitStatus();
  const before = await waitComposerReady();
  const priorAssistant = before.assistantTexts.length;
  await typeAndSend(PROMPT);
  log(`step ${step}: sent in ${mode} mode`);
  const record = { step, mode, sentAt: sinceIso, forbidden: [] };
  const deadline = Date.now() + timeoutMs;
  let core = null;
  let snap = before;
  while (Date.now() < deadline) {
    try { snap = await snapshot(); } catch { await sleep(1000); continue; }
    core = findNewCoreTurn(known);
    // Like the Golden run, a non-mutating tool request (a read or a listing)
    // is approved as the user would; every approval is recorded, and the
    // byte/git checks below still prove nothing changed. A mutating tool is
    // never approved and fails the step.
    record.approved ??= [];
    for (const button of snap.toolApprovalButtons) {
      if (MUTATING_TOOL.test(button.tool ?? '')) { record.forbidden.push(button); continue; }
      if (record.approved.some(item => item.approvalId === button.approvalId)) continue;
      const find = `Array.from(document.querySelectorAll('[data-approval-response="approved"]')).find(x => x.dataset.approvalId === ${JSON.stringify(button.approvalId)})`;
      const request = await evalDoc(`(() => { const b = ${find}; return (b?.closest('[data-approval-id]') || b?.parentElement?.parentElement)?.innerText?.slice(0, 400) || null; })()`).catch(() => null);
      if (WRITE_COMMAND.test(request ?? '')) { record.forbidden.push({ ...button, request }); continue; }
      await evalDoc(`(() => { const b = ${find}; b?.click(); return !!b; })()`).catch(() => undefined);
      record.approved.push({ ...button, request, at: new Date().toISOString() });
      log(`step ${step}: approved non-mutating tool ${button.tool ?? '?'}: ${String(request ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
      await shot(`step${step}-approved-${record.approved.length}`);
      await sleep(500);
    }
    for (const card of snap.cards.filter(item => item.visible)) record.forbidden.push(card);
    if (record.forbidden.length) break;
    if (OVERSIZE_ERROR.test(snap.bodyText) && snap.primaryAction === 'Send') break;
    if (core?.attempt && ['completed', 'failed', 'cancelled'].includes(core.attempt.status) && snap.primaryAction === 'Send') break;
    await sleep(1000);
  }
  await sleep(1500);
  snap = await snapshot().catch(() => snap);
  core = findNewCoreTurn(known) ?? core;
  Object.assign(record, {
    timedOut: Date.now() >= deadline,
    attemptId: core?.attempt?.id ?? null,
    attemptStatus: core?.attempt?.status ?? null,
    failureReason: core?.attempt?.failureReason ?? null,
    resolvedMode: core?.request?.resolvedMode ?? null,
    oversizeErrorVisible: OVERSIZE_ERROR.test(snap.bodyText),
    newAssistantReplies: snap.assistantTexts.length - priorAssistant,
    answer: (snap.assistantTexts.at(-1) ?? '').slice(0, 4000),
    treeChanged: treeHash() !== treeBefore,
    gitStatusChanged: gitStatus() !== gitBefore,
    evidence: core?.attempt ? attemptEvidence(core.attempt.id, sinceIso) : null,
    finishedAt: new Date().toISOString(),
  });
  await shot(`step${step}-${mode}-end`);
  turns.push(record);
  fs.writeFileSync(path.join(evidenceDir, `turn-${step}-${mode}.json`), JSON.stringify({ ...record, bodyTail: snap.bodyText.slice(-3000) }, null, 2));

  check(step, 'turn reached a terminal state before the timeout', !record.timedOut, record.attemptStatus);
  check(step, 'no "repository context prompt must be non-empty" failure', !record.oversizeErrorVisible && !OVERSIZE_ERROR.test(record.failureReason ?? ''), record.failureReason);
  check(step, 'Core accepted and executed the attempt to completion', record.attemptStatus === 'completed', [record.attemptStatus, record.failureReason]);
  check(step, 'repository context was attached, bounded and led by the overview',
    record.evidence && record.evidence.repositoryPromptChars > 0 && record.evidence.repositoryPromptChars < 100_000 && record.evidence.repositoryHasOverview,
    record.evidence && { chars: record.evidence.repositoryPromptChars, overview: record.evidence.repositoryHasOverview });
  check(step, 'zero mutation surfaces (UI) and zero mutation approvals (Core)', record.forbidden.length === 0 && (record.evidence?.mutationApprovals ?? []).length === 0, [record.forbidden, record.evidence?.mutationApprovals]);
  check(step, 'no mutating tool invoked', !(record.evidence?.toolInvocations ?? []).some(item => MUTATING_TOOL.test(item.toolName ?? '')), record.evidence?.toolInvocations);
  check(step, 'workspace bytes unchanged', !record.treeChanged);
  check(step, 'git status unchanged', !record.gitStatusChanged);
  check(step, 'visible, substantive answer', record.newAssistantReplies > 0 && record.answer.trim().length > 200, record.answer.slice(0, 200));
  log(`step ${step}: ${record.resolvedMode} model=${record.evidence?.selectedModel} repoChars=${record.evidence?.repositoryPromptChars} files=${record.evidence?.repositorySelectedFiles.length}`);
  return record;
}

async function main() {
  if (!fs.existsSync(vsixPath)) throw new Error(`VSIX not found: ${vsixPath}`);
  if (!fs.existsSync(codeExe)) throw new Error(`Code.exe not found: ${codeExe}`);
  if (!fs.existsSync(path.join(WORKSPACE, 'manage.py'))) throw new Error(`workspace not found: ${WORKSPACE}`);
  const vsixSha = crypto.createHash('sha256').update(fs.readFileSync(vsixPath)).digest('hex');
  const initialTree = treeHash();
  const initialGit = gitStatus();
  log('VSIX', vsixPath, vsixSha.slice(0, 16), '| workspace tree', initialTree);
  fs.writeFileSync(path.join(evidenceDir, 'run-identity.json'), JSON.stringify({
    vsix: vsixPath, vsixSha256: vsixSha, vsixBuiltAt: fs.statSync(vsixPath).mtime.toISOString(), gitHead: git(root, ['rev-parse', 'HEAD']),
    workspace: WORKSPACE, workspaceHead: git(WORKSPACE, ['rev-parse', 'HEAD']), initialTree, initialGitStatus: initialGit,
    prompt: PROMPT, baseUrl, contextWindow, runDir, userDataDir, extensionsDir, coreDataDir, indexRoot, startedAt: new Date().toISOString(),
  }, null, 2));

  writeUserSettingsForCustomDialogs(userDataDir);
  fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
    'window.dialogStyle': 'custom',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    // Mirrors the normal profile that reproduced the failure.
    'ollama-agent.providerType': 'ollama',
    'ollama-agent.apiBase': baseUrl,
    'ollama-agent.model': 'qwen3.8:27b-mtp-q4_K_M',
    'ollama-agent.chatModel': 'qwen3.8:27b-mtp-q4_K_M',
    'ollama-agent.agentModel': 'qwen3-coder:swift-27b',
    'ollama-agent.editModel': 'qwen3-coder:swift-27b',
    'ollama-agent.codingModel': 'qwen3-coder:swift-27b',
    'ollama-agent.codingFallbackModel': 'qwen3.8:27b-mtp-q4_K_M',
    'ollama-agent.reviewerModel': 'qwen3.8:27b-mtp-q4_K_M',
    'ollama-agent.contextWindow': contextWindow,
    'ollama-agent.maxOutputTokens': 8192,
    'ollama-agent.temperature': 0.1,
    'ollama-agent.modelRoutingPolicy': 'local-only',
  }, null, 2));

  installExtension(resolveCliArgsFromVSCodeExecutablePath(codeExe), { userDataDir, extensionsDir, vsixPath });
  const port = allocateDebugPort();
  const launched = launchPlainHost(codeExe, {
    userDataDir, extensionsDir, workspacePath: WORKSPACE, remoteDebuggingPort: port,
    env: { KARKEDIKHA_DATA_DIR: coreDataDir, KARKEDIKHA_OLLAMA_URL: baseUrl, OLLAMA_AGENT_REPOSITORY_INDEX_ROOT: indexRoot },
  });
  // The window must outlive this script (left open for inspection either way).
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
  log('KKD panel ready on', WORKSPACE);

  // Default order: the exact normal-profile reproduction (Auto, which routes
  // this prompt to Saath Kar), then both Core execution paths explicitly.
  const modes = arg('--modes', 'auto,agent,chat').split(',').map(mode => mode.trim()).filter(Boolean);
  for (const [index, mode] of modes.entries()) await inspectionTurn(index + 1, mode);

  check('final', 'workspace bytes identical to the start of the run', treeHash() === initialTree);
  check('final', 'git status identical to the start of the run', gitStatus() === initialGit);
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
  fs.writeFileSync(path.join(evidenceDir, 'khakedikha-inspection-result.json'), JSON.stringify({
    verdict: exitCode === 0 ? 'PASS' : 'FAIL', finishedAt: new Date().toISOString(), coreDataDir, workspace: WORKSPACE, results, turns,
  }, null, 2));
  log('evidence:', evidenceDir, '| VS Code window intentionally left open');
  try { await chat?.close(); await pageClient?.close(); } catch { /* window stays */ }
  process.exit(exitCode);
}
