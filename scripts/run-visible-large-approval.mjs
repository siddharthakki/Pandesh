// Visible acceptance for M45's approval split: a Saath Kar proposal carrying ~20 KB
// of file content, in the packaged VSIX, on a DISPOSABLE fixture repository (never
// a real workspace). Proves large canonical arguments -> digest-bound persisted
// arguments -> bounded human summary -> approval -> reauthorization against the
// canonical arguments -> execution, by reading Core's durable evidence and the
// bytes actually written. Type/click only through the real webview via CDP.
//
//   node scripts/run-visible-large-approval.mjs --vsix <vsix> [--context-window 32768] [--max-output-tokens 16384]
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
const TARGET = 'docs/large-fixture.txt';
const LINES = 400;
const lineText = n => 'line ' + String(n).padStart(3, '0') + ': the quick brown fox jumps over the lazy dog';
// Every byte is specified: LF newlines, one LF after every line including the last,
// no trailing period, no other text. 400 lines x (54 chars + LF) = 21,600 bytes.
const expectedContent = Array.from({ length: LINES }, (_, i) => lineText(i + 1) + '\n').join('');
const EXPECTED_BYTES = Buffer.byteLength(expectedContent, 'utf8');
const PROMPT = 'Create a new file ' + TARGET + ' in this repository containing exactly ' + LINES + ' lines, numbered 001 to ' + LINES + '. '
  + 'Line N must be exactly the text `line NNN: the quick brown fox jumps over the lazy dog`, where NNN is N zero-padded to three digits '
  + '(for example `line 001: the quick brown fox jumps over the lazy dog` and `line ' + LINES + ': the quick brown fox jumps over the lazy dog`). '
  + 'Each line is 54 characters with no trailing period and no trailing spaces. Use LF (\\n) line endings, and end every line with a newline, including line ' + LINES + ', '
  + 'so the file ends with exactly one trailing newline and no blank line after it. The file must be exactly ' + EXPECTED_BYTES + ' bytes. '
  + 'Propose the complete file in a single proposal. Do not modify any other file.';
const SUMMARY_ERROR = /approval summary exceeds|exceeds.*bytes|invalid_request/i;
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
const maxOutputTokens = Number(arg('--max-output-tokens', '16384'));
// Disposable fixture repository (a tiny git repo); the real workspaces are never touched.
const WORKSPACE = path.join(runDir, 'fixture-repo');
fs.mkdirSync(path.join(WORKSPACE, 'src'), { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, 'README.md'), '# fixture\n\nA tiny disposable repository for the M45 large-approval acceptance.\n');
fs.writeFileSync(path.join(WORKSPACE, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'src/index.js' }, null, 2) + '\n');
fs.writeFileSync(path.join(WORKSPACE, 'src', 'index.js'), "console.log('fixture');\n");
execFileSync('git', ['init', '-q'], { cwd: WORKSPACE });
execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'add', '-A'], { cwd: WORKSPACE });
execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: WORKSPACE });

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

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const canonicalJson = value => Array.isArray(value) ? '[' + value.map(canonicalJson).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
  : (JSON.stringify(value) ?? 'null');

async function largeApprovalTurn(step) {
  await selectMode('agent');
  const known = knownRequestIds();
  const sinceIso = new Date().toISOString();
  const gitBefore = gitStatus();
  const before = await waitComposerReady();
  await typeAndSend(PROMPT);
  log('step ' + step + ': sent in agent mode');
  const record = { step, sentAt: sinceIso, approved: [], forbidden: [], cardTexts: [] };
  const deadline = Date.now() + 20 * 60_000;
  let core = null;
  let snap = before;
  while (Date.now() < deadline) {
    try { snap = await snapshot(); } catch { await sleep(1000); continue; }
    core = findNewCoreTurn(known);
    for (const button of snap.toolApprovalButtons) {
      if (record.approved.some(item => item.approvalId === button.approvalId)) continue;
      const find = 'Array.from(document.querySelectorAll(\'[data-approval-response="approved"]\')).find(x => x.dataset.approvalId === ' + JSON.stringify(button.approvalId) + ')';
      const cardText = await evalDoc('(() => { const b = ' + find + '; return (b?.closest(\'[data-approval-id]\') || b?.parentElement?.parentElement)?.innerText || null; })()').catch(() => null);
      const isTarget = button.tool === 'propose_file_change';
      if (MUTATING_TOOL.test(button.tool ?? '') && !isTarget) { record.forbidden.push({ ...button, cardText: (cardText ?? '').slice(0, 300) }); continue; }
      if (WRITE_COMMAND.test(cardText ?? '') && !isTarget) { record.forbidden.push({ ...button, cardText: (cardText ?? '').slice(0, 300) }); continue; }
      record.cardTexts.push({ approvalId: button.approvalId, tool: button.tool, chars: (cardText ?? '').length, text: (cardText ?? '').slice(0, 1500) });
      if (isTarget) await shot('step' + step + '-large-approval-card');
      await evalDoc('(() => { const b = ' + find + '; b?.click(); return !!b; })()').catch(() => undefined);
      record.approved.push({ ...button, at: new Date().toISOString() });
      log('step ' + step + ': approved ' + (button.tool ?? '?') + ' (card ' + (cardText ?? '').length + ' chars)');
      await sleep(500);
    }
    if (record.forbidden.length) break;
    if (SUMMARY_ERROR.test(snap.bodyText) && snap.primaryAction === 'Send') break;
    if (core?.attempt && ['completed', 'failed', 'cancelled'].includes(core.attempt.status) && snap.primaryAction === 'Send') break;
    await sleep(1000);
  }
  await sleep(1500);
  snap = await snapshot().catch(() => snap);
  core = findNewCoreTurn(known) ?? core;
  const attemptId = core?.attempt?.id ?? null;
  const targetPath = path.join(WORKSPACE, ...TARGET.split('/'));
  const written = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;
  const evidence = withDb(db => {
    // Governed capability actions run on separate, parentless "anchor" attempts whose
    // request message names the conversation (M38 dispatch anchor), so approvals and
    // tool invocations follow the conversation to those attempts, not the visible one.
    const conversationId = core?.request?.conversationId ?? null;
    const anchorAttemptIds = conversationId
      ? db.prepare("SELECT a.id FROM attempts a JOIN requests r ON r.id = a.requestId WHERE r.currentMessage LIKE 'M38 governed capability dispatch anchor for ' || ? || '%'").all(conversationId).map(row => row.id)
      : [];
    const ids = [...new Set([attemptId, ...anchorAttemptIds].filter(Boolean))];
    const inIds = ids.map(() => '?').join(',') || "''";
    const scope = `(attemptId IN (${inIds}) OR attemptId IN (SELECT id FROM attempts WHERE parentAttemptId IN (${inIds})))`;
    const approvals = db.prepare(`SELECT id, attemptId, status, requestedAt, resolvedAt, summary, actionArgumentsJson, requestedActionDigest, length(summary) AS summaryBytes, length(CAST(actionArgumentsJson AS BLOB)) AS argsBytes FROM approvals WHERE ${scope} ORDER BY requestedAt`).all(...ids, ...ids);
    const tools = db.prepare(`SELECT id, attemptId, toolName, status, startedAt, endedAt, length(argsSummary) AS argsSummaryBytes, argsSummary, approvalId FROM tool_invocations WHERE ${scope} ORDER BY startedAt`).all(...ids, ...ids);
    const events = db.prepare("SELECT sequence, eventType, createdAt, length(metadata) AS metaBytes FROM runtime_events WHERE createdAt >= ? ORDER BY sequence").all(sinceIso).map(e => e.sequence + ':' + e.eventType + ':' + e.metaBytes + 'B');
    return { approvals, tools, events, attemptIds: ids, attemptStatus: db.prepare('SELECT status, failureReason FROM attempts WHERE id = ?').get(attemptId) };
  });
  const target = evidence?.approvals.find(a => JSON.parse(a.summary ?? '{}').toolName === 'propose_file_change') ?? null;
  const summary = target ? JSON.parse(target.summary) : null;
  const fullArgs = target?.actionArgumentsJson ? JSON.parse(target.actionArgumentsJson) : null;
  const analysis = target && {
    approvalId: target.id, status: target.status,
    summaryBytes: target.summaryBytes, fullArgumentBytes: target.argsBytes,
    fullContentBytes: fullArgs ? Buffer.byteLength(String(fullArgs.content ?? ''), 'utf8') : null,
    argumentsDigestInSummary: summary?.argumentsDigest ?? null,
    argumentsDigestRecomputed: fullArgs ? sha256(canonicalJson(fullArgs)) : null,
    summaryContentProjection: summary?.arguments?.content ?? null,
    contentSha256Recomputed: fullArgs ? sha256(String(fullArgs.content ?? '')) : null,
    requestedActionDigest: target.requestedActionDigest,
    summaryHoldsRawContent: JSON.stringify(summary).includes('the quick brown fox'),
    resolvedAfterRequested: Boolean(target.resolvedAt) && target.resolvedAt >= target.requestedAt,
  };
  Object.assign(record, {
    attemptId, attemptStatus: evidence?.attemptStatus?.status ?? null, failureReason: evidence?.attemptStatus?.failureReason ?? null,
    summaryErrorVisible: SUMMARY_ERROR.test(snap.bodyText),
    answer: (snap.assistantTexts.at(-1) ?? '').slice(0, 1500),
    gitStatusAfter: gitStatus(), gitStatusBefore: gitBefore,
    writtenBytes: written?.length ?? null, writtenSha256: written ? sha256(written) : null, expectedBytes: EXPECTED_BYTES,
    // Informational only: the integrity gate compares against the approved canonical content, never this.
    approvedContentMatchesPromptSpec: fullArgs ? fullArgs.content === expectedContent : null,
    lookupAttemptIds: evidence?.attemptIds ?? [],
    analysis, tools: evidence?.tools.map(t => ({ toolName: t.toolName, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, argsSummaryBytes: t.argsSummaryBytes })), eventOrder: evidence?.events,
    finishedAt: new Date().toISOString(),
  });
  await shot('step' + step + '-end');
  turns.push(record);
  fs.writeFileSync(path.join(evidenceDir, 'turn-' + step + '-large-approval.json'), JSON.stringify({ ...record, bodyTail: snap.bodyText.slice(-2500) }, null, 2));

  check(step, 'no forbidden (non-target) mutation surfaced', record.forbidden.length === 0, record.forbidden);
  check(step, 'no approval-size error surfaced (UI or Core)', !record.summaryErrorVisible && !SUMMARY_ERROR.test(record.failureReason ?? ''), record.failureReason);
  check(step, 'Saath proposed the file: an approval for propose_file_change exists', Boolean(analysis), evidence?.approvals);
  check(step, 'proposal content is large (>= 16 KB)', (analysis?.fullContentBytes ?? 0) >= 16_000, analysis?.fullContentBytes);
  check(step, 'human summary is bounded and holds a projection, not the raw content', analysis.summaryBytes < 8 * 1024 && !analysis.summaryHoldsRawContent && analysis.summaryContentProjection?.$bytes === analysis.fullContentBytes, analysis);
  check(step, 'canonical arguments are persisted apart and their digest matches the summary digest', analysis.fullArgumentBytes >= analysis.fullContentBytes && analysis.argumentsDigestInSummary === analysis.argumentsDigestRecomputed, analysis);
  check(step, 'summary content projection hash equals the persisted content hash', analysis.summaryContentProjection?.$sha256 === analysis.contentSha256Recomputed, analysis);
  check(step, 'approval was approved through the UI', record.approved.some(a => a.tool === 'propose_file_change') && analysis.status === 'approved' && analysis.resolvedAfterRequested, [record.approved, analysis.status]);
  check(step, 'attempt completed', record.attemptStatus === 'completed', [record.attemptStatus, record.failureReason]);
  const applied = (record.tools ?? []).filter(t => t.status === 'succeeded');
  check(step, 'a tool invocation executed after the approval', applied.some(t => /propose_file_change|write_file|apply/.test(t.toolName)), record.tools);
  check(step, 'written file bytes equal the approved canonical content exactly', record.writtenSha256 === analysis.contentSha256Recomputed && record.writtenBytes === analysis.fullContentBytes, [record.writtenBytes, analysis.fullContentBytes]);
  check(step, 'only the target file changed', record.gitStatusAfter.split('\n').filter(Boolean).every(line => line.includes(TARGET)) && record.gitStatusAfter.includes(TARGET), record.gitStatusAfter);
  log('step ' + step + ': summary=' + analysis.summaryBytes + 'B fullArgs=' + analysis.fullArgumentBytes + 'B content=' + analysis.fullContentBytes + 'B digest=' + analysis.argumentsDigestInSummary?.slice(0, 16) + ' written=' + record.writtenBytes + 'B expectedIfExact=' + record.expectedBytes + 'B');
  return record;
}

async function main() {
  if (!fs.existsSync(vsixPath)) throw new Error(`VSIX not found: ${vsixPath}`);
  if (!fs.existsSync(codeExe)) throw new Error(`Code.exe not found: ${codeExe}`);
  const vsixSha = crypto.createHash('sha256').update(fs.readFileSync(vsixPath)).digest('hex');
  const initialTree = 'fixture';
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
    'ollama-agent.maxOutputTokens': maxOutputTokens,
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
  await largeApprovalTurn(1);

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
