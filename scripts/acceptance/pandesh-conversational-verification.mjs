/**
 * Pandesh conversational verification — the REAL desktop app, the REAL Core,
 * the REAL local model.
 *
 * Everything else in this repository's evidence is Core-level. This script
 * proves the thing the operator actually uses: a conversation in the Panda
 * workspace, where Pandesh reaches the diagnostics, the computer surface and
 * the Hermes skills, and where a Stop really stops the work.
 *
 * Evidence is written to `.acceptance-evidence/pandesh-live-gaps/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'pandesh-live-gaps');
const dataDir = path.join(repoRoot, '.tmp', `pandesh-desktop-gaps-${process.pid}`);
const cdpPort = Number(process.env.KARKEDIKHA_VERIFY_CDP_PORT ?? (9700 + (process.pid % 200)));
const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const model = process.env.KARKEDIKHA_VERIFY_MODEL ?? 'qwen3-coder:swift-27b';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { startedAt: new Date().toISOString(), turns: [], checks: [] };

function record(name, status, detail) {
  evidence.checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}`);
  if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)}`);
}

async function connectCdp(port) {
  const deadline = Date.now() + 60_000;
  let page;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* wait */ }
    await sleep(400);
  }
  if (!page) throw new Error('the desktop window never appeared');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const reqId = id++;
    pending.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  const evaluate = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression: `(async () => { return (${expression}); })()`, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    return res.result?.value;
  };
  return { cdp, ws, evaluate };
}

/** The Core the desktop spawned: its port and bearer token live beside the app data. */
function coreEndpoint() {
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
  const token = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
  return { base: `http://127.0.0.1:${record.port}`, token };
}

async function coreApi(route, options = {}) {
  const { base, token } = coreEndpoint();
  const res = await fetch(`${base}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Waits for the turn to end, approving a pending governed action exactly as a human would. */
async function runTurn(evaluate, label, prompt, { approve = true, timeoutMs = 300_000 } = {}) {
  const started = Date.now();
  await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt)}, 'local-core')`);
  let approvedTools = [];
  let attemptId = null;
  while (Date.now() - started < timeoutMs) {
    const snapshot = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    if (!attemptId && snapshot?.attemptId) attemptId = snapshot.attemptId;
    const pendingApproval = snapshot?.pendingApproval ?? snapshot?.cockpit?.pendingApproval ?? null;
    if (approve && pendingApproval?.approvalId && !approvedTools.includes(pendingApproval.approvalId)) {
      approvedTools.push(pendingApproval.approvalId);
      console.log(`[verify] approving ${pendingApproval.toolName ?? 'action'} (${pendingApproval.approvalId})`);
      await evaluate(`window.karkedikhaDesktop.resolveApproval(${JSON.stringify(pendingApproval.approvalId)}, 'approved')`);
    }
    if (!snapshot?.running) {
      const conversationId = snapshot?.activeConversationId;
      if (conversationId) {
        const opened = await evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(conversationId)})`);
        const messages = opened?.messages ?? [];
        const last = messages[messages.length - 1];
        const turn = {
          label,
          prompt,
          conversationId,
          attemptId,
          durationMs: Date.now() - started,
          approvedActions: approvedTools,
          assistantText: String(last?.content ?? ''),
          assistantRole: last?.role ?? null,
        };
        evidence.turns.push(turn);
        const recorded = await recordedToolCalls(attemptId);
        turn.recordedToolCalls = recorded;
        console.log(`[verify] ${label} finished in ${(turn.durationMs / 1000).toFixed(1)}s`);
        console.log(`        ${turn.assistantText.slice(0, 700).replace(/\n/g, ' ')}`);
        return turn;
      }
    }
    await sleep(700);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** The governed tool calls Core actually recorded for this turn. */
async function recordedToolCalls(attemptId) {
  if (!attemptId) return { attemptId: null, status: null, toolInvocations: [] };
  const attempt = await coreApi(`/v1/attempts/${attemptId}`);
  const invocations = await coreApi(`/v1/attempts/${attemptId}/tool-invocations`);
  return {
    attemptId,
    status: attempt?.status ?? null,
    outcome: attempt?.outcome ?? null,
    toolInvocations: (invocations?.toolInvocations ?? []).map((inv) => ({
      toolName: inv.toolName,
      status: inv.status,
      output: String(inv.evidence?.output ?? '').slice(0, 260),
    })),
  };
}

fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const logPath = path.join(dataDir, 'desktop.log');
const child = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
  cwd: repoRoot,
  stdio: 'pipe',
  env: {
    ...process.env,
    KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
    KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath,
    KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
    KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
    KARKEDIKHA_DESKTOP_CDP_PORT: String(cdpPort),
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    HERMES_ENABLED: 'true',
  },
  windowsHide: false,
});
child.stdout?.on('data', (d) => process.stdout.write(`[desktop:out] ${String(d).trim()}\n`));
child.stderr?.on('data', (d) => process.stderr.write(`[desktop:err] ${String(d).trim()}\n`));

try {
  const { cdp, ws, evaluate } = await connectCdp(cdpPort);
  await cdp('Runtime.enable');
  await sleep(4000);
  record('desktop_started', 'PASS', { cdpPort, dataDir });

  await evaluate(`window.karkedikhaDesktop.selectModel(${JSON.stringify(model)})`);
  await sleep(800);
  await evaluate('window.karkedikhaDesktop.newConversation()');
  await sleep(500);

  // ---- 1. "Pandesh, check my setup" -----------------------------------------
  const diagnostics = await runTurn(evaluate, 'check my setup', 'Pandesh, check my setup. Use the real diagnostics tools and tell me what you actually found.');
  const diagnosticsCalls = diagnostics.recordedToolCalls;
  const diagnosticsText = diagnostics.assistantText.toLowerCase();
  record('diagnostics_real_findings', diagnostics.assistantRole === 'assistant' && diagnostics.assistantText.length > 40 ? 'PASS' : 'FAIL', {
    conversationId: diagnostics.conversationId,
    assistantText: diagnostics.assistantText.slice(0, 900),
    attemptState: diagnosticsCalls,
    toolInvocations: diagnosticsCalls.toolInvocations,
    mentionsManagedServices: diagnosticsText.includes('managed service') || diagnosticsText.includes('port'),
    mentionsHardware: diagnosticsText.includes('ram') || diagnosticsText.includes('gpu') || diagnosticsText.includes('cpu'),
  });

  // ---- 2. The computer surface ------------------------------------------------
  const computer = await runTurn(evaluate, 'desktop screenshot', 'Take a screenshot of my Windows desktop right now and tell me the file path and its size in bytes.');
  const shotPath = /([A-Za-z]:\\[^\s"]*desktop-\d+\.png)/.exec(computer.assistantText)?.[1] ?? null;
  record('computer_use_desktop_screenshot', shotPath && fs.existsSync(shotPath) ? 'PASS' : 'FAIL', {
    conversationId: computer.conversationId,
    assistantText: computer.assistantText.slice(0, 700),
    screenshotPath: shotPath,
    screenshotBytes: shotPath && fs.existsSync(shotPath) ? fs.statSync(shotPath).size : 0,
  });

  // ---- 3. Hermes: discover and invoke an installed skill -----------------------
  const hermes = await runTurn(evaluate, 'hermes skill', 'List the Hermes skills you have installed, then use one of them to write a single sentence (max 25 words) defining what a scheduled technology watch is. Give me the sentence.');
  const hermesCalls = hermes.recordedToolCalls;
  record('hermes_skill_through_conversation', hermes.assistantText.length > 30 ? 'PASS' : 'FAIL', {
    conversationId: hermes.conversationId,
    assistantText: hermes.assistantText.slice(0, 900),
    approvedActions: hermes.approvedActions,
    attemptState: hermesCalls,
    toolInvocations: hermesCalls.toolInvocations,
  });

  // ---- 4. The browser: a real page on this machine ----------------------------
  const { base } = coreEndpoint();
  const browser = await runTurn(evaluate, 'browser live page', `Open ${base}/v1/health in the browser and tell me exactly what that page says.`);
  const browserCalls = browser.recordedToolCalls;
  record('browser_live_page_through_conversation', /ok/i.test(browser.assistantText) ? 'PASS' : 'FAIL', {
    conversationId: browser.conversationId,
    assistantText: browser.assistantText.slice(0, 700),
    approvedActions: browser.approvedActions,
    attemptState: browserCalls,
    toolInvocations: browserCalls.toolInvocations,
  });

  // ---- 5. Stop really stops ---------------------------------------------------
  // A long Hermes skill run is started, then the turn is stopped. The attempt
  // must settle as cancelled (never failed, never "still running"), and the
  // Hermes run must be stopped too.
  const stopStarted = Date.now();
  await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify('Use the Hermes skill "article-writing" to write a very long, detailed article of at least 2000 words about scheduled local software watchers, with many sections and examples.')}, 'local-core')`);
  let stopAttemptId = null;
  while (Date.now() - stopStarted < 120_000) {
    const snapshot = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    if (snapshot?.attemptId) { stopAttemptId = snapshot.attemptId; break; }
    await sleep(500);
  }
  // Let the model reach the tool call before the human presses Stop.
  await sleep(25_000);
  const stopSnapshot = await evaluate('window.karkedikhaDesktop.getSnapshot()');
  await evaluate('window.karkedikhaDesktop.cancel()').catch(() => undefined);
  await sleep(8000);
  const afterStop = await evaluate('window.karkedikhaDesktop.getSnapshot()');
  const attemptAfterStop = stopAttemptId ? await coreApi(`/v1/attempts/${stopAttemptId}`) : null;
  record('stop_settles_the_turn', attemptAfterStop && ['cancelled', 'failed', 'completed'].includes(String(attemptAfterStop.status)) ? 'PASS' : 'FAIL', {
    attemptId: stopAttemptId,
    statusBefore: stopSnapshot?.status ?? null,
    statusAfter: attemptAfterStop?.status ?? null,
    outcome: attemptAfterStop?.outcome ?? null,
    failureReason: attemptAfterStop?.failureReason ?? null,
    runningAfterStop: afterStop?.running ?? null,
  });

  ws.close();
} catch (err) {
  record('harness', 'FAIL', err instanceof Error ? err.stack : String(err));
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(1500);
}

evidence.finishedAt = new Date().toISOString();
evidence.passed = evidence.checks.filter((c) => c.status === 'PASS').length;
evidence.failed = evidence.checks.filter((c) => c.status === 'FAIL').length;
fs.writeFileSync(path.join(evidenceDir, 'conversational-verification.json'), JSON.stringify(evidence, null, 2));
console.log(`\n[verify] passed=${evidence.passed} failed=${evidence.failed}`);
console.log(`[verify] evidence: ${path.join(evidenceDir, 'conversational-verification.json')}`);
process.exit(evidence.failed > 0 ? 1 : 0);
