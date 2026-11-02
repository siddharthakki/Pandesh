/**
 * Live workspace scenarios — watched the way a person would watch them.
 *
 * Runs natural-language requests through the REAL Pandesh desktop app (the
 * packaged portable build when KARKEDIKHA_VERIFY_APP points at it, otherwise
 * the dev build), its own Core, the local Ollama model and the real host
 * browser on the real internet. Approval cards are decided like a person
 * would; the right-hand workspace is read from the rendered DOM, and the
 * whole window is captured whenever what it shows changes.
 *
 *   form     httpbin form: fill, show, reject (nothing sent), then approve and verify
 *   google   Google search, open results, summarize with sources (blockers reported)
 *   wiki     Wikipedia search, follow links, back navigation
 *   restart  restart the app; history and pictures still shown
 *
 * Everything runs in an isolated data folder; the installed app and its
 * profile are never touched. Evidence (JSON + PNG) goes to
 * `.acceptance-evidence/pandesh-live-workspace-scenarios/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const packaged = process.env.KARKEDIKHA_VERIFY_APP ? path.resolve(process.env.KARKEDIKHA_VERIFY_APP) : null;
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'pandesh-live-workspace-scenarios');
const dataDir = process.env.KARKEDIKHA_VERIFY_ROOT ?? path.join(repoRoot, '.tmp', `pandesh-scenarios-${process.pid}`);
let cdpPort = Number(process.env.KARKEDIKHA_VERIFY_CDP_PORT ?? (9300 + (process.pid % 200)));
const model = process.env.KARKEDIKHA_VERIFY_MODEL ?? 'gemma4:26b-a4b-it-qat';
const only = (process.env.KARKEDIKHA_VERIFY_ONLY ?? 'form,google,wiki,restart').split(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { startedAt: new Date().toISOString(), model, app: packaged ?? 'dev build', dataDir, checks: [], turns: [], screenshots: [] };

function save() {
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
}

function record(name, status, detail) {
  evidence.checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}`);
  if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)}`);
  save();
}

async function connectCdp(port) {
  const deadline = Date.now() + 90_000;
  let page;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl && !p.url.startsWith('devtools'));
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
    if (res.exceptionDetails) throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
    return res.result?.value;
  };
  return { cdp, ws, evaluate };
}

function coreEndpoint() {
  const rec = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
  const token = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
  return { base: `http://127.0.0.1:${rec.port}`, token };
}

async function coreApi(route) {
  const { base, token } = coreEndpoint();
  const res = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function recordedToolCalls(attemptId) {
  if (!attemptId) return [];
  const invocations = await coreApi(`/v1/attempts/${attemptId}/tool-invocations`);
  return (invocations?.toolInvocations ?? []).map((inv) => ({
    toolName: inv.toolName,
    status: inv.status,
    arguments: inv.evidence?.normalizedArguments ?? inv.argsSummary ?? null,
    output: String(inv.evidence?.output ?? ''),
    sourceUrls: inv.evidence?.sourceUrls ?? [],
  }));
}

let shotCount = 0;
async function screenshot(conn, name) {
  const shot = await conn.cdp('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (!shot?.data) return null;
  shotCount += 1;
  const file = path.join(evidenceDir, `${String(shotCount).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  evidence.screenshots.push(path.basename(file));
  console.log(`[shot] ${path.basename(file)}`);
  return file;
}

/** What the window shows: the workspace panel and the task card, as a person reads them. */
function readWorkspace(evaluate) {
  return evaluate(`(() => {
    const ws = document.getElementById('workspace-context');
    const layout = ws?.parentElement;
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? '';
    const img = document.querySelector('#context-activity .browser-viewport img');
    return {
      open: Boolean(ws && !ws.hidden),
      widthShare: ws && layout && !ws.hidden ? Math.round(ws.getBoundingClientRect().width / layout.getBoundingClientRect().width * 100) : 0,
      overlaysChat: ws && !ws.hidden ? getComputedStyle(ws).position === 'absolute' : false,
      now: text('#context-now'),
      browserTitle: text('#context-activity .browser-address-title'),
      browserUrl: text('#context-activity .browser-address-url'),
      pictureShown: Boolean(img && !img.hidden && img.src.startsWith('data:image/')),
      pictureId: img?.dataset?.artifactId ?? '',
      stale: document.querySelector('#context-activity .browser-viewport')?.dataset?.stale ?? '',
      caption: text('#context-activity .browser-caption'),
      strip: Array.from(document.querySelectorAll('#context-activity .browser-strip button')).map((b) => b.title),
      steps: Array.from(document.querySelectorAll('#context-history .history-title')).map((n) => n.textContent),
      taskSteps: Array.from(document.querySelectorAll('#task-card-steps > li:not(.task-step-details)')).map((n) => n.textContent.trim()),
      liveLine: text('#live-telemetry'),
      approvalShown: Boolean(document.getElementById('approval-panel') && !document.getElementById('approval-panel').hidden),
      approvalDetail: text('#approval-detail'),
      composerEnabled: !document.querySelector('#prompt, #composer-input, textarea')?.disabled,
    };
  })()`);
}

/**
 * Runs one chat turn. `decide(card)` returns 'approved' or 'rejected'. The
 * window is captured whenever the workspace's current step or the approval
 * card changes.
 */
async function runTurn(conn, label, prompt, { decide = () => 'approved', timeoutMs = 600_000, conversationId = null, onTick } = {}) {
  const { evaluate } = conn;
  const started = Date.now();
  if (conversationId) await evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(conversationId)})`);
  await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt)}, 'local-core')`);
  const cards = [];
  const seen = new Set();
  const views = [];
  let attemptId = null;
  let lastView = '';
  while (Date.now() - started < timeoutMs) {
    const snapshot = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    if (!attemptId && snapshot?.attemptId) attemptId = snapshot.attemptId;
    const view = await readWorkspace(evaluate).catch(() => null);
    const key = view ? JSON.stringify([view.now, view.pictureId, view.approvalShown, view.steps.length]) : '';
    if (view && key !== lastView) {
      lastView = key;
      views.push({ at: Date.now() - started, ...view });
      if (view.open && (view.pictureShown || view.approvalShown || /fail|could not|not sent/i.test(view.now))) {
        await screenshot(conn, `${label}-${views.length}`);
      }
    }
    const card = snapshot?.pendingApproval ?? snapshot?.cockpit?.pendingApproval ?? null;
    if (card?.approvalId && !seen.has(card.approvalId)) {
      seen.add(card.approvalId);
      await sleep(1200);
      await screenshot(conn, `${label}-approval-${card.toolName}`);
      // A person reads a submission card before answering; longer than Core's 30 s orphan sweep.
      if (card.toolName === 'browser_submit') {
        await sleep(Number(process.env.KARKEDIKHA_VERIFY_READ_MS ?? 40_000));
        const still = await evaluate('window.karkedikhaDesktop.getSnapshot()');
        const pending = still?.pendingApproval ?? still?.cockpit?.pendingApproval;
        record(`${label}: approval card still actionable after 40 s`, pending?.approvalId === card.approvalId ? 'PASS' : 'FAIL', pending?.approvalId ?? 'gone');
      }
      const resolution = decide(card);
      cards.push({ toolName: card.toolName, detail: card.detail, resolution });
      console.log(`[verify] ${resolution} ${card.toolName}: ${String(card.detail).slice(0, 240).replace(/\n/g, ' | ')}`);
      await evaluate(`window.karkedikhaDesktop.resolveApproval(${JSON.stringify(card.approvalId)}, ${JSON.stringify(resolution)})`);
    }
    if (onTick && snapshot?.running) await onTick({ snapshot, elapsed: Date.now() - started });
    const status = attemptId ? String((await coreApi(`/v1/attempts/${attemptId}`).catch(() => ({})))?.status ?? '') : '';
    if (/^(completed|failed|cancelled|interrupted|succeeded)/.test(status) && !snapshot?.running && Date.now() - started > 1500) {
      await sleep(1500);
      const conv = snapshot.activeConversationId;
      const opened = await evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(conv)})`);
      const messages = opened?.messages ?? [];
      const last = messages[messages.length - 1];
      await sleep(1200);
      const finalView = await readWorkspace(evaluate).catch(() => null);
      await screenshot(conn, `${label}-final`);
      const turn = {
        label, prompt, conversationId: conv, attemptId, status, durationMs: Date.now() - started, cards,
        reply: String(last?.content ?? ''), tools: await recordedToolCalls(attemptId), views, finalView,
      };
      evidence.turns.push(turn);
      save();
      console.log(`[verify] ${label}: ${status} in ${(turn.durationMs / 1000).toFixed(0)}s, ${turn.tools.length} tool calls`);
      for (const inv of turn.tools) console.log(`        - ${inv.toolName} ${inv.status} ${JSON.stringify(inv.arguments ?? {}).slice(0, 160)}`);
      console.log(`        reply: ${turn.reply.slice(0, 1200).replace(/\n/g, ' ')}`);
      return turn;
    }
    await sleep(600);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function launchDesktop() {
  // An editor-hosted shell may export this, which turns Electron into plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const electronBin = packaged ? path.join(packaged, 'electron', 'electron.exe') : path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const appDir = packaged ? path.join(packaged, 'app') : desktopRoot;
  const child = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, appDir], {
    cwd: packaged ?? repoRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: packaged ?? repoRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: packaged ? path.join(packaged, 'runtime', 'core.js') : path.join(repoRoot, 'out-core', 'core.js'),
      KARKEDIKHA_DESKTOP_NODE: packaged ? path.join(packaged, 'runtime', 'node.exe') : process.execPath,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_HOST_LOG: path.join(dataDir, 'desktop.log'),
      KARKEDIKHA_DESKTOP_CDP_PORT: String(cdpPort),
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
    windowsHide: false,
  });
  child.stderr?.on('data', (d) => { const s = String(d).trim(); if (/error/i.test(s)) process.stderr.write(`[desktop:err] ${s.slice(0, 300)}\n`); });
  return child;
}

async function quit(child) {
  // Core runs detached and outlives the window; stop this run's Core so the next run can own its database.
  const corePid = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8')).pid; } catch { return null; } })();
  child.kill();
  if (corePid) try { execFileSync('taskkill', ['/PID', String(corePid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  await sleep(4000);
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  for (let i = 0; i < 30; i += 1) {
    const open = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(() => true, () => false);
    if (!open) break;
    await sleep(1000);
  }
  await sleep(2000);
}

async function start() {
  cdpPort += 1;
  const child = launchDesktop();
  const conn = await connectCdp(cdpPort);
  await conn.cdp('Runtime.enable');
  await conn.cdp('Page.enable');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ok = await conn.evaluate('window.karkedikhaDesktop.listConversations().then(() => true, () => false)').catch(() => false);
    if (ok) break;
    await sleep(1000);
  }
  await conn.evaluate(`window.karkedikhaDesktop.selectModel(${JSON.stringify(model)})`);
  // A laptop-sized window, as a person would have it.
  const { windowId } = await conn.cdp('Browser.getWindowForTarget').catch(() => ({}));
  if (windowId) await conn.cdp('Browser.setWindowBounds', { windowId, bounds: { width: 1440, height: 900, windowState: 'normal' } }).catch(() => undefined);
  await sleep(1500);
  return { child, ...conn };
}

async function newConversation(app) {
  await app.evaluate('window.karkedikhaDesktop.newConversation()');
  await app.evaluate("document.getElementById('btn-new-chat-header')?.click()");
  await sleep(800);
}

const visited = (turn) => turn.tools
  .filter((i) => i.status === 'succeeded' && i.toolName.startsWith('browser_'))
  .map((i) => /^URL: (\S+)/m.exec(i.output)?.[1])
  .filter(Boolean);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Where a turn's time went: Ollama's own model-call timings (Core `model_call` events) against the wall clock. */
async function turnTiming(turn, afterSequence) {
  const calls = [];
  for (let after = afterSequence; ;) {
    const { events = [] } = await coreApi(`/v1/runtime-events?after=${after}&limit=500`);
    if (!events.length) break;
    after = events[events.length - 1].sequence;
    for (const e of events) {
      if (e.eventType === 'model_call' && e.entityId === turn.attemptId) calls.push(typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata ?? {});
    }
  }
  const modelMs = calls.reduce((n, c) => n + (c.totalMs ?? 0), 0);
  const timing = {
    totalS: +(turn.durationMs / 1000).toFixed(1),
    modelS: +(modelMs / 1000).toFixed(1),
    modelCalls: calls.length,
    promptTokens: calls.map((c) => c.promptTokens),
    outputTokens: calls.reduce((n, c) => n + (c.outputTokens ?? 0), 0),
    firstTokenMs: calls.map((c) => c.firstTokenMs),
    toolCalls: turn.tools.length,
    numCtx: [...new Set(calls.map((c) => c.numCtx))],
    approvalWaitS: turn.cards.length ? 'person decides' : 0,
  };
  timing.otherS = +(timing.totalS - timing.modelS).toFixed(1);
  turn.timing = timing;
  record(`${turn.label}: timing`, 'INFO', timing);
  return timing;
}

const lastSequence = async () => {
  let after = 0;
  for (;;) {
    const { events = [] } = await coreApi(`/v1/runtime-events?after=${after}&limit=500`);
    if (!events.length) return after;
    after = events[events.length - 1].sequence;
  }
};

/** A minimal one-page text PDF, so the invoice fixture is a real PDF the assistant has to read. */
function writePdf(file, lines, mtime) {
  const text = lines.map((l, i) => `BT /F1 12 Tf 60 ${760 - i * 20} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, pdf, 'latin1');
  fs.utimesSync(file, mtime, mtime);
}

function judgeWorkspace(label, turn) {
  const withPicture = turn.views.filter((v) => v.pictureShown);
  record(`${label}: workspace opened beside the chat`, turn.views.some((v) => v.open && !v.overlaysChat && v.widthShare >= 35) ? 'PASS' : 'FAIL',
    turn.views.filter((v) => v.open).map((v) => `${v.widthShare}%${v.overlaysChat ? ' overlay' : ''}`).slice(0, 4).join(', '));
  record(`${label}: browser pictures followed the steps`, new Set(withPicture.map((v) => v.pictureId)).size >= 2 ? 'PASS' : 'FAIL',
    withPicture.map((v) => `${v.now} | ${v.browserUrl}`).slice(0, 12));
  record(`${label}: plain-language steps in chat`, turn.views.some((v) => v.taskSteps.length && !v.taskSteps.some((s) => /browser_\w+/.test(s))) ? 'PASS' : 'FAIL',
    [...new Set(turn.views.flatMap((v) => v.taskSteps))].slice(0, 14));
}

fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
let app;
try {
  app = await start();
  record('desktop started', 'PASS', { app: evidence.app, model });

  if (only.includes('form')) {
    await newConversation(app);
    const prompt = "Open https://httpbin.org/forms/post, enter customer name 'Pandesh Stage B' and delivery instructions 'harmless test, no order'. Show me the completed form and ask before submitting.";
    const first = await runTurn(app, 'form-reject', prompt, { decide: (card) => (card.toolName === 'browser_submit' ? 'rejected' : 'approved') });
    judgeWorkspace('form', first);
    const fills = first.tools.filter((t) => t.toolName === 'browser_fill');
    record('form: fields filled without repeated failures', fills.some((f) => f.status === 'succeeded') && fills.filter((f) => f.status === 'failed').length <= 1 ? 'PASS' : 'FAIL',
      fills.map((f) => `${f.status} ${JSON.stringify(f.arguments?.locator ?? f.arguments)}`));
    record('form: stopped before submitting and asked', !first.tools.some((t) => t.toolName === 'browser_submit') ? 'PASS' : 'REVIEW', first.reply.slice(0, 300));
    const resultPage = (turn) => visited(turn).some((u) => u === 'https://httpbin.org/post');

    // A person says "submit" and then rejects the card: nothing may be sent.
    const second = await runTurn(app, 'form-reject-submit', 'Please submit the form.', {
      conversationId: first.conversationId,
      decide: (card) => (card.toolName === 'browser_submit' ? 'rejected' : 'approved'),
    });
    const submitCard = second.cards.find((c) => c.toolName === 'browser_submit');
    record('form: approval showed exact values and destination', submitCard && /Pandesh Stage B/.test(submitCard.detail) && /harmless test, no order/.test(submitCard.detail) && /httpbin\.org\/post/.test(submitCard.detail) ? 'PASS' : (submitCard ? 'FAIL' : 'NOT_REACHED'),
      submitCard?.detail ?? 'the model did not ask to submit');
    record('form: rejection sent nothing', submitCard && !resultPage(second) ? 'PASS' : 'FAIL', visited(second));
    record('form: rejection reported truthfully', /not (been )?(submitted|sent)|did not submit|was not submitted|declined|rejected|cancel/i.test(second.reply) && !/successfully submitted/i.test(second.reply) ? 'PASS' : 'REVIEW', second.reply.slice(0, 400));

    // Then approves: the real form is sent and the result page is read back.
    const third = await runTurn(app, 'form-approve', 'I changed my mind — submit it now, then tell me exactly what the result page shows for the customer name and the delivery instructions.', { conversationId: first.conversationId });
    const result = third.tools.find((t) => t.toolName === 'browser_submit' && t.status === 'succeeded');
    record('form: approved submission reached the result page', result && /"custname": "Pandesh Stage B"/.test(result.output) && /"comments": "harmless test, no order"/.test(result.output) ? 'PASS' : 'FAIL',
      result?.output.slice(0, 400) ?? third.tools.map((t) => `${t.toolName}:${t.status}`));
    record('form: answer states both submitted values', /Pandesh Stage B/.test(third.reply) && /harmless test, no order/.test(third.reply) ? 'PASS' : 'REVIEW', third.reply.slice(0, 500));
  }

  if (only.includes('google')) {
    await newConversation(app);
    const turn = await runTurn(app, 'google', 'Pandesh, open Google, search for the latest Qwen AI models, open three relevant results and summarize what you find with source links.');
    judgeWorkspace('google', turn);
    const urls = visited(turn);
    const blocked = turn.tools.some((t) => /unusual traffic|captcha|sorry\/index|consent\.google/i.test(t.output));
    record('google: search results page reached', urls.some((u) => /google\.[a-z.]+\/search/.test(u)) ? 'PASS' : (blocked ? 'BLOCKED' : 'FAIL'), urls);
    const results = [...new Set(urls.map(hostOf).filter((h) => h && !/google\./.test(h)))];
    record('google: opened results on other sites', results.length >= 3 ? 'PASS' : results.length ? 'PARTIAL' : 'FAIL', results);
    const cited = (turn.reply.match(/https?:\/\/[^\s)\]>"]+/g) ?? []).map(hostOf);
    record('google: answer cites only pages it opened', cited.length && cited.every((h) => results.includes(h) || /google\./.test(h)) ? 'PASS' : 'REVIEW', { cited, opened: results });
  }

  if (only.includes('wiki')) {
    await newConversation(app);
    const turn = await runTurn(app, 'wiki', 'Pandesh, open Wikipedia, search for Ollama, follow relevant links and explain what you discovered.');
    judgeWorkspace('wiki', turn);
    const urls = visited(turn);
    record('wiki: navigated several pages', new Set(urls).size >= 3 ? 'PASS' : 'PARTIAL', urls);
    record('wiki: answer given', turn.reply.length > 200 ? 'PASS' : 'REVIEW', turn.reply.slice(0, 400));
  }

  if (only.includes('website')) {
    await newConversation(app);
    const site = path.join(dataDir, 'kha-ke-dikha-site');
    fs.mkdirSync(site, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: site });
    await app.evaluate(`window.karkedikhaDesktop.setFolder(${JSON.stringify(site)})`).catch((err) => console.log(`[verify] setFolder: ${err.message}`));
    const turn = await runTurn(app, 'website', `Pandesh, create a simple responsive landing page for Kha ke dikha in this disposable workspace (${site}), run it locally and show me the website.`, { timeoutMs: 1_500_000 });
    const files = fs.readdirSync(site).filter((f) => !f.startsWith('.'));
    record('website: files really created', files.some((f) => /\.html?$/.test(f)) ? 'PASS' : 'FAIL', files);
    const code = turn.views.filter((v) => /Edit|Writ|OpenCode|creat/i.test(v.now));
    record('website: code step shown in the workspace', code.length ? 'PASS' : 'REVIEW', [...new Set(turn.views.map((v) => v.now))].slice(0, 12));
    const preview = turn.views.find((v) => v.pictureShown && /127\.0\.0\.1|localhost/.test(v.browserUrl));
    record('website: real preview of the running site', preview ? 'PASS' : 'FAIL', preview ?? turn.tools.map((t) => `${t.toolName}:${t.status}`));
    evidence.websiteConversation = turn.conversationId;
    if (preview) {
      const change = await runTurn(app, 'website-change', 'Change the main heading colour to deep orange and add a "Order now" button under it, then show me the updated website.', { conversationId: turn.conversationId, timeoutMs: 1_500_000 });
      const pictures = change.views.filter((v) => v.pictureShown && /127\.0\.0\.1|localhost/.test(v.browserUrl));
      record('website: preview refreshed after the change', pictures.length && pictures[pictures.length - 1].pictureId !== preview.pictureId ? 'PASS' : 'FAIL', pictures.map((v) => v.pictureId));
    }
  }

  // --- Daily-driver demonstrations: research, personal documents, memory + reminder. ---
  if (only.includes('research')) {
    await newConversation(app);
    const since = await lastSequence();
    const turn = await runTurn(app, 'research', 'Find recent information about Ollama and summarize three verified findings with source links.');
    await turnTiming(turn, since);
    const opened = [...new Set(turn.tools.filter((t) => t.status === 'succeeded').flatMap((t) => [/^URL: (\S+)/m.exec(t.output)?.[1], ...t.sourceUrls, ...(t.toolName === 'web_fetch' || t.toolName === 'fetch_url' ? [t.arguments?.url] : [])]).filter(Boolean))];
    record('research: real pages opened', opened.length >= 2 ? 'PASS' : opened.length ? 'PARTIAL' : 'FAIL', { opened, tools: turn.tools.map((t) => `${t.toolName}:${t.status}`) });
    const cited = [...new Set(turn.reply.match(/https?:\/\/[^\s)\]>"'`]+/g) ?? [])];
    const unopened = cited.filter((u) => !opened.some((o) => hostOf(o) === hostOf(u)));
    record('research: answer cites sources it opened', cited.length >= 2 && !unopened.length ? 'PASS' : 'FAIL', { cited, unopened });
    record('research: three findings given', (turn.reply.match(/^\s*(?:\d+[.)]|[-*•])\s+/gm) ?? []).length >= 3 ? 'PASS' : 'REVIEW', turn.reply.slice(0, 900));
  }

  if (only.includes('invoice')) {
    await newConversation(app);
    const folder = path.join(dataDir, 'sample-invoices');
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    const invoices = [
      ['invoice-brightline-0817.pdf', '2026-08-14', 'Brightline Plumbing', 'EUR 420.00', '13 September 2026'],
      ['invoice-northwind-1102.pdf', '2026-09-30', 'Northwind Garage', 'EUR 1,150.00', '30 October 2026'],
      ['invoice-kestrel-2291.pdf', '2026-10-28', 'Kestrel Web Hosting', 'EUR 2,384.75', '27 November 2026'],
    ];
    for (const [name, date, vendor, total, due] of invoices) {
      writePdf(path.join(folder, name), [`INVOICE - ${vendor}`, `Invoice date: ${date}`, 'Bill to: Sample Customer, Amsterdam', 'IBAN: NL00 TEST 0000 0000 00', `Amount due (total): ${total}`, `Due date: ${due}`], new Date(`${date}T10:00:00`));
    }
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'Shopping list: coffee, batteries.');
    await app.evaluate(`window.karkedikhaDesktop.setFolder(${JSON.stringify(folder)})`).catch((err) => console.log(`[verify] setFolder: ${err.message}`));
    const since = await lastSequence();
    const turn = await runTurn(app, 'invoice', 'Find the newest invoice, read it and tell me its total and due date.');
    await turnTiming(turn, since);
    const read = turn.tools.filter((t) => t.status === 'succeeded' && /kestrel-2291/.test(JSON.stringify(t.arguments ?? {})));
    record('invoice: newest invoice really opened', read.length ? 'PASS' : 'FAIL', turn.tools.map((t) => `${t.toolName}:${t.status} ${JSON.stringify(t.arguments ?? {}).slice(0, 120)}`));
    record('invoice: total and due date correct', /2,?384\.75/.test(turn.reply) && /27(?:th)?\s+Nov|Nov\w*\s+27|2026-11-27/i.test(turn.reply) ? 'PASS' : 'FAIL', turn.reply.slice(0, 500));
    record('invoice: stayed local (no web tools)', !turn.tools.some((t) => /^(browser_|web_)/.test(t.toolName)) ? 'PASS' : 'FAIL', turn.tools.map((t) => t.toolName));
    record('invoice: document shown in the workspace', turn.views.some((v) => v.open && /kestrel/i.test(JSON.stringify(v))) ? 'PASS' : 'REVIEW', [...new Set(turn.views.map((v) => v.now))].slice(0, 10));
    const sinceFollow = await lastSequence();
    const follow = await runTurn(app, 'invoice-followup', 'Summarize that one.', { conversationId: turn.conversationId });
    await turnTiming(follow, sinceFollow);
    record('invoice: follow-up resolved "that one" without asking', /kestrel/i.test(follow.reply) && !/which (invoice|file)|please (specify|provide)/i.test(follow.reply) ? 'PASS' : 'FAIL', follow.reply.slice(0, 500));
  }

  if (only.includes('remember')) {
    await newConversation(app);
    const since = await lastSequence();
    const turn = await runTurn(app, 'remember', 'Remember that I prefer brief technical explanations, and remind me tomorrow morning to review Pandesh.');
    await turnTiming(turn, since);
    const { DatabaseSync } = await import('node:sqlite');
    const dbFile = fs.readdirSync(dataDir).map((f) => path.join(dataDir, f)).find((f) => /\.(db|sqlite3?)$/.test(f));
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const facts = db.prepare("SELECT subject, predicate, displayValue, state FROM memory_facts WHERE state = 'active'").all();
    const reminders = db.prepare("SELECT title, dueAt, timezone, status FROM everyday_reminders WHERE status NOT IN ('cancelled','completed')").all();
    db.close();
    record('remember: memory persisted after approval', facts.some((f) => /brief|concise|short/i.test(`${f.predicate} ${f.displayValue}`)) ? 'PASS' : 'FAIL', { facts, cards: turn.cards.map((c) => c.toolName) });
    const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA');
    const due = reminders.find((r) => /pandesh/i.test(r.title));
    const dueLocal = due ? new Date(due.dueAt) : null;
    record('remember: reminder scheduled for tomorrow morning', due && dueLocal.toLocaleDateString('en-CA') === tomorrow && dueLocal.getHours() >= 6 && dueLocal.getHours() < 12 ? 'PASS' : 'FAIL', { reminders, tomorrow, dueLocal: dueLocal?.toString() });
    record('remember: answer claims only what happened', !/couldn't|could not|failed/i.test(turn.reply) === Boolean(due && facts.length) ? 'PASS' : 'REVIEW', turn.reply.slice(0, 400));
  }

  if (only.includes('restart')) {
    const before = evidence.turns[evidence.turns.length - 1];
    await quit(app.child);
    app = await start();
    if (before?.conversationId) {
      await app.evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(before.conversationId)})`);
      await app.evaluate('document.getElementById("btn-open-workspace")?.click()');
      await sleep(6000);
      const view = await readWorkspace(app.evaluate);
      await screenshot(app, 'after-restart');
      record('restart: history and pictures shown after restart', view.steps.length >= 2 && view.pictureShown ? 'PASS' : 'FAIL', view);
    }
  }
} catch (err) {
  record('verification aborted', 'FAIL', String(err?.stack ?? err).slice(0, 800));
} finally {
  if (app?.child) await quit(app.child);
  evidence.finishedAt = new Date().toISOString();
  save();
  const failed = evidence.checks.filter((c) => c.status === 'FAIL');
  console.log(`[verify] ${evidence.checks.length - failed.length}/${evidence.checks.length} checks not failing; evidence in ${evidenceDir}`);
}
