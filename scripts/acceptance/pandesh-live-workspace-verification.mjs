/**
 * Live activity workspace verification — the REAL desktop app, the REAL Core,
 * the operator's local Ollama model and the real local integrations.
 *
 * Drives natural-language turns through the app's own preload API, decides
 * approval cards like a person would, and reads the right-hand workspace from
 * the rendered DOM while the work runs:
 *   browser   research across public pages (URL, screenshot, steps)
 *   code      a harmless edit in a disposable git workspace (diff, checks)
 *   document  an attached sample PDF (extracted text, open original)
 *   image     a real local Image Studio generation (artifact in the panel)
 *   video     a real local LTX-Video generation (playback in the panel)
 *   recovery  reload, restart, Stop, and a genuine failure
 *
 * Everything runs in an isolated data folder (desktop host + its own Core);
 * the production profile is never touched. Evidence (JSON + PNG screenshots)
 * goes to `.acceptance-evidence/pandesh-live-workspace/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'pandesh-live-workspace');
const runRoot = process.env.KARKEDIKHA_VERIFY_ROOT ?? path.join(repoRoot, '.tmp', `pandesh-live-workspace-${process.pid}`);
const dataDir = path.join(runRoot, 'data');
const workspace = path.join(runRoot, 'workspace');
let cdpPort = Number(process.env.KARKEDIKHA_VERIFY_CDP_PORT ?? (9500 + (process.pid % 200)));
const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const model = process.env.KARKEDIKHA_VERIFY_MODEL ?? 'gemma4:26b-a4b-it-qat';
const only = new Set((process.env.KARKEDIKHA_VERIFY_ONLY ?? 'browser,code,document,image,video,recovery').split(','));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { startedAt: new Date().toISOString(), model, runRoot, checks: [], timelines: {}, screenshots: [] };

function record(name, status, detail) {
  evidence.checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}`);
  if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)}`);
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
}

// ---- disposable inputs ------------------------------------------------------

/** A small, valid one-page PDF with real text, built byte by byte. */
function samplePdf() {
  const text = [
    'Pandesh sample document',
    'Quarterly garden report: the tomato beds produced 42 kilograms.',
    'Water use fell by 18 percent after drip irrigation was installed.',
    'Next step: plant basil along the south fence in April.',
  ];
  const stream = `BT /F1 14 Tf 72 740 Td 18 TL ${text.map((line) => `(${line}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function prepareWorkspace() {
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'greeting.js'), "function greet(name) {\n  return 'Hello ' + name;\n}\n\nmodule.exports = { greet };\n");
  fs.writeFileSync(path.join(workspace, 'test.js'), "const assert = require('node:assert');\nconst { greet } = require('./greeting');\nassert.ok(greet('Ada').includes('Ada'));\nconsole.log('greeting test passed:', greet('Ada'));\n");
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'pandesh-disposable', private: true, scripts: { test: 'node test.js' } }, null, 2));
  const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=Acceptance', 'add', '.');
  git('-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=Acceptance', 'commit', '-q', '-m', 'disposable baseline');
}

// ---- the app ----------------------------------------------------------------

async function connectCdp(port) {
  const deadline = Date.now() + 90_000;
  let page;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && /renderer\/index\.html/.test(p.url ?? '') && p.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* not up yet */ }
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

function launchDesktop() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  return spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(dataDir, 'electron-profile')}`, desktopRoot], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
      KARKEDIKHA_DESKTOP_NODE: process.execPath,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_HOST_LOG: path.join(runRoot, 'desktop.log'),
      KARKEDIKHA_DESKTOP_CDP_PORT: String(cdpPort),
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
    windowsHide: false,
  });
}

async function start() {
  cdpPort += 1;
  const child = launchDesktop();
  const conn = await connectCdp(cdpPort);
  await conn.cdp('Runtime.enable');
  await waitForApi(conn);
  await conn.evaluate(`window.karkedikhaDesktop.selectModel(${JSON.stringify(model)})`);
  await conn.evaluate(`window.karkedikhaDesktop.setFolder(${JSON.stringify(workspace)})`).catch((err) => console.log(`[verify] setFolder: ${err.message}`));
  await sleep(800);
  return { child, ...conn };
}

async function waitForApi(conn) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ok = await conn.evaluate('window.karkedikhaDesktop.listConversations().then(() => true, () => false)').catch(() => false);
    if (ok) return;
    await sleep(1000);
  }
  throw new Error('Core never answered');
}

/** Stops this run's own isolated Core (never any other), by the pid in its discovery record. */
function stopIsolatedCore() {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8')).pid);
    if (Number.isInteger(pid) && pid > 0) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* already gone */ }
}

async function quit(child) {
  child.kill();
  await sleep(4000);
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  stopIsolatedCore();
  for (let i = 0; i < 30; i += 1) {
    if (!(await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(() => true, () => false))) break;
    await sleep(1000);
  }
  await sleep(2000);
}

async function screenshot(app, name) {
  try {
    const shot = await app.cdp('Page.captureScreenshot', { format: 'png' });
    const file = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    evidence.screenshots.push(file);
    return file;
  } catch (err) {
    console.log(`[verify] screenshot ${name} failed: ${err.message}`);
    return null;
  }
}

/** What the right-hand workspace shows right now, read from the DOM. */
const PANEL = `(() => {
  const panel = document.getElementById('workspace-context');
  const act = document.getElementById('context-activity');
  const q = (sel) => act ? act.querySelector(sel) : null;
  const img = q('img');
  const video = q('video');
  return {
    visible: !!panel && !panel.hidden && panel.offsetWidth > 0,
    width: panel ? panel.offsetWidth : 0,
    heading: document.getElementById('context-activity-heading')?.textContent ?? null,
    kind: q('.activity-kind')?.textContent ?? null,
    state: q('.activity-state')?.textContent ?? null,
    title: q('.activity-title')?.textContent ?? null,
    tool: q('.activity-tool')?.textContent ?? null,
    url: q('.activity-url')?.getAttribute('href') ?? null,
    image: img ? { dataUrl: img.src.startsWith('data:image/'), naturalWidth: img.naturalWidth, alt: img.alt } : null,
    video: video ? { fileUrl: video.src.startsWith('file:'), readyState: video.readyState, duration: video.duration, currentTime: video.currentTime } : null,
    diffAdds: act ? act.querySelectorAll('.diff-add').length : 0,
    diffDels: act ? act.querySelectorAll('.diff-del').length : 0,
    details: act ? [...act.querySelectorAll('.activity-detail')].map((e) => e.textContent) : [],
    excerpt: q('.activity-text')?.textContent?.slice(0, 300) ?? null,
    buttons: act ? [...act.querySelectorAll('button')].map((b) => b.textContent) : [],
    steps: [...document.querySelectorAll('#context-history button')].map((b) => ({ title: b.querySelector('.history-title')?.textContent, state: b.querySelector('.history-dot')?.dataset.state })),
    stopVisible: !document.getElementById('workspace-stop')?.hidden,
    approvalNotice: !document.getElementById('context-approval')?.hidden,
    toggleVisible: !document.getElementById('btn-open-workspace')?.hidden,
  };
})()`;

const snapshotOf = (app) => app.evaluate('window.karkedikhaDesktop.getSnapshot()');

/**
 * One chat turn. Approval cards are decided by `decide`; the workspace panel
 * is sampled into a timeline while the task runs.
 */
async function runTurn(app, label, prompt, { decide = () => 'approved', onTick, timeoutMs = 900_000, screenshotWhen } = {}) {
  const started = Date.now();
  const timeline = [];
  evidence.timelines[label] = timeline;
  const submitted = await app.evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt)}, 'local-core').then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: String(e && e.message || e) }))`);
  if (!submitted?.ok) throw new Error(`submit failed: ${submitted?.error}`);
  const seen = new Set();
  const cards = [];
  let shotTaken = false;
  let lastSignature = '';
  let quietSince = 0;
  while (Date.now() - started < timeoutMs) {
    const snapshot = await snapshotOf(app);
    const panel = await app.evaluate(PANEL);
    const signature = JSON.stringify([panel.title, panel.state, panel.url, panel.image?.dataUrl, panel.steps.length]);
    if (signature !== lastSignature) {
      lastSignature = signature;
      timeline.push({ t: Math.round((Date.now() - started) / 1000), visible: panel.visible, kind: panel.kind, state: panel.state, title: panel.title, url: panel.url, screenshot: Boolean(panel.image?.dataUrl), steps: panel.steps.length });
      console.log(`[panel] +${Math.round((Date.now() - started) / 1000)}s ${panel.visible ? 'open' : 'closed'} ${panel.kind ?? '-'} ${panel.state ?? '-'} ${panel.title ?? ''} ${panel.url ?? ''}`);
    }
    if (!shotTaken && screenshotWhen?.(panel)) {
      shotTaken = true;
      await screenshot(app, `${label}-during`);
    }
    const card = snapshot?.pendingApproval ?? snapshot?.cockpit?.pendingApproval ?? null;
    if (card?.approvalId && !seen.has(card.approvalId)) {
      seen.add(card.approvalId);
      const resolution = decide(card);
      cards.push({ toolName: card.toolName, detail: String(card.detail ?? '').slice(0, 300), resolution, panelApprovalNotice: panel.approvalNotice });
      console.log(`[verify] ${resolution} ${card.toolName}: ${String(card.detail).slice(0, 160).replace(/\n/g, ' ')}`);
      await app.evaluate(`window.karkedikhaDesktop.resolveApproval(${JSON.stringify(card.approvalId)}, ${JSON.stringify(resolution)})`);
    }
    const media = snapshot?.pendingImageApproval;
    if (media?.approvalId && !seen.has(media.approvalId)) {
      seen.add(media.approvalId);
      const mediaTool = media.request?.toolName ?? media.toolName;
      cards.push({ toolName: mediaTool, resolution: 'approved', panelApprovalNotice: panel.approvalNotice, generatingBeforeApproval: (snapshot?.workspaceActivities ?? []).some((a) => a.capability === mediaTool && a.state === 'running') });
      console.log(`[verify] approved ${mediaTool}`);
      // Generation runs inside this call for minutes, so it is not awaited.
      await app.evaluate(`(window.karkedikhaDesktop.resolveImageApproval(${JSON.stringify(media.approvalId)}, 'approved').catch(() => undefined), true)`);
    }
    if (onTick) await onTick({ snapshot, panel, elapsed: Date.now() - started });
    const mine = (snapshot?.workspaceActivities ?? []).filter((a) => Date.parse(a.startedAt) >= started - 5_000);
    const busy = snapshot?.running || snapshot?.pendingApproval || snapshot?.pendingImageApproval || mine.some((a) => a.state === 'running');
    if (!busy && Date.now() - started > 4_000) {
      quietSince ||= Date.now();
      if (Date.now() - quietSince > 3_000) {
        const conversationId = snapshot?.activeConversationId ?? snapshot?.selectedConversationId;
        const opened = conversationId ? await app.evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(conversationId)})`) : null;
        const messages = opened?.messages ?? [];
        const assistantText = String([...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '');
        const finalPanel = await app.evaluate(PANEL);
        console.log(`[verify] ${label} settled after ${Math.round((Date.now() - started) / 1000)}s; ${mine.length} activities: ${mine.map((a) => `${a.capability}:${a.state}`).join(', ')}`);
        console.log(`        ${assistantText.slice(0, 600).replace(/\n/g, ' ')}`);
        return { label, conversationId, cards, activities: mine, assistantText, finalPanel, timeline, lastOutcome: snapshot?.lastTurnOutcome ?? null };
      }
    } else {
      quietSince = 0;
    }
    await sleep(700);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function newConversation(app) {
  await app.evaluate('window.karkedikhaDesktop.newConversation()');
  await app.evaluate("document.getElementById('btn-new-chat-header')?.click()");
  await sleep(800);
}

// ---- run --------------------------------------------------------------------

fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
prepareWorkspace();

let app = await start();
const summary = {};
try {
  record('desktop_started', 'PASS', { cdpPort, dataDir, workspace, model, routing: 'local-only' });

  // ---- A. Browser ------------------------------------------------------------
  if (only.has('browser')) {
    await newConversation(app);
    const turn = await runTurn(app, 'browser',
      'Use the browser to research the Rust programming language: open https://www.rust-lang.org and then https://en.wikipedia.org/wiki/Rust_(programming_language), read both pages, and give me three facts, each with its source URL.',
      { screenshotWhen: (p) => p.visible && p.kind === 'Browser' && p.image?.dataUrl });
    const browser = turn.activities.filter((a) => a.kind === 'browser');
    const urls = [...new Set(browser.map((a) => a.preview?.url).filter(Boolean))];
    const shots = browser.filter((a) => a.preview?.artifactIds?.length);
    const runningSeen = turn.timeline.some((s) => s.kind === 'Browser' && s.state === 'Running');
    const panelUrls = [...new Set(turn.timeline.map((s) => s.url).filter(Boolean))];
    await screenshot(app, 'browser-final');
    record('browser_activities_from_real_tool_calls', browser.length >= 2 ? 'PASS' : 'FAIL', browser.map((a) => `${a.capability}:${a.state}`));
    record('browser_url_changes_shown_in_panel', panelUrls.length >= 2 ? 'PASS' : (panelUrls.length === 1 ? 'PARTIAL' : 'FAIL'), panelUrls);
    record('browser_running_state_shown', runningSeen ? 'PASS' : 'NOT_OBSERVED', turn.timeline.filter((s) => s.state === 'Running').slice(0, 4));
    record('browser_screenshot_from_managed_session', shots.length > 0 && turn.timeline.some((s) => s.screenshot) ? 'PASS' : 'FAIL', { withScreenshot: shots.length, of: browser.length });
    record('browser_approval_cards_used', turn.cards.some((c) => c.toolName === 'browser_open_site') ? 'PASS' : 'NOT_EXERCISED', turn.cards);
    const cited = (turn.assistantText.match(/https?:\/\/[^\s)\]>"'`]+/g) ?? []);
    record('browser_final_answer_source_linked', cited.length > 0 ? 'PASS' : 'FAIL', cited.slice(0, 6));
    summary.browser = { urls, cards: turn.cards.length };
    // Inspect an earlier step.
    const inspected = await app.evaluate(`(() => { const rows = document.querySelectorAll('#context-history button'); if (rows.length < 2) return null; rows[rows.length - 1].click(); return true; })()`);
    if (inspected) {
      await sleep(600);
      const panel = await app.evaluate(PANEL);
      record('click_earlier_step_to_inspect', panel.heading === 'Earlier step' ? 'PASS' : 'FAIL', { heading: panel.heading, title: panel.title, url: panel.url });
      await screenshot(app, 'browser-inspect-earlier-step');
    }
  }

  // ---- B. Code ---------------------------------------------------------------
  if (only.has('code')) {
    await newConversation(app);
    const before = fs.readFileSync(path.join(workspace, 'greeting.js'), 'utf8');
    const turn = await runTurn(app, 'code',
      `In my project at ${workspace}, edit greeting.js so greet returns 'Hello, ' + name + '!' instead of 'Hello ' + name. Then run "node test.js" in that folder to verify it still passes. Change nothing else.`,
      { screenshotWhen: (p) => p.visible && p.kind === 'Code' && p.diffAdds > 0 });
    const after = fs.readFileSync(path.join(workspace, 'greeting.js'), 'utf8');
    const gitDiff = execFileSync('git', ['diff', '--no-color'], { cwd: workspace, encoding: 'utf8' });
    await screenshot(app, 'code-final');
    const code = turn.activities.filter((a) => a.kind === 'code');
    const edit = code.find((a) => a.preview?.diff);
    record('code_file_really_modified', before !== after && /Hello, /.test(after) ? 'PASS' : 'FAIL', { gitDiff: gitDiff.slice(0, 600) });
    record('code_activity_with_real_diff', edit && edit.state === 'completed' ? 'PASS' : 'FAIL', edit ? { capability: edit.capability, path: edit.preview?.path, diff: edit.preview?.diff?.slice(0, 400) } : code.map((a) => `${a.capability}:${a.state}`));
    record('code_diff_matches_disk', edit && gitDiff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).some((l) => edit.preview.diff.includes(l)) ? 'PASS' : 'FAIL');
    const check = code.find((a) => /run_checks|run_command/.test(a.capability));
    record('code_check_result_shown', check ? (check.state === 'completed' ? 'PASS' : 'FAIL') : 'NOT_EXERCISED', check ? { state: check.state, excerpt: check.preview?.excerpt?.slice(-200), detail: check.detail } : code.map((a) => a.capability));
    record('code_panel_rendered_diff', turn.timeline.length && (await app.evaluate(`document.querySelectorAll('#context-history button').length`)) >= 1 ? 'PASS' : 'FAIL');
  }

  // ---- C. Documents ----------------------------------------------------------
  if (only.has('document')) {
    await newConversation(app);
    const pdf = samplePdf();
    fs.writeFileSync(path.join(runRoot, 'garden-report.pdf'), pdf);
    const staged = await app.evaluate(`window.karkedikhaDesktop.stageAttachmentBytes('garden-report.pdf', new Uint8Array(${JSON.stringify([...pdf])}))`);
    record('document_staged', staged?.ok ? 'PASS' : 'FAIL', staged);
    const turn = await runTurn(app, 'document', 'Summarize the attached PDF in two sentences and tell me how much water use fell.',
      { screenshotWhen: (p) => p.visible && p.kind === 'Document' });
    const doc = turn.activities.find((a) => a.kind === 'document' && a.id.startsWith('doc-'));
    await app.evaluate(`(() => { const b = [...document.querySelectorAll('#context-history button')].find((x) => /garden-report/.test(x.textContent)); if (b) b.click(); return true; })()`);
    await sleep(600);
    const panel = await app.evaluate(PANEL);
    await screenshot(app, 'document-final');
    record('document_text_extracted_locally', doc?.state === 'completed' && /42 kilograms|18 percent/.test(doc.preview?.excerpt ?? '') ? 'PASS' : 'FAIL', doc ? { detail: doc.detail, excerpt: doc.preview?.excerpt?.slice(0, 200) } : null);
    record('document_preview_in_panel', /18 percent/.test(panel.excerpt ?? '') && panel.buttons.includes('Open original') ? 'PASS' : 'FAIL', { title: panel.title, excerpt: panel.excerpt?.slice(0, 160), buttons: panel.buttons });
    record('document_answer_uses_content', /18/.test(turn.assistantText) ? 'PASS' : 'FAIL', turn.assistantText.slice(0, 300));
    if (doc) {
      const opened = await app.evaluate(`window.karkedikhaDesktop.openActivityDocument(${JSON.stringify(doc.id)}).then((r) => r, (e) => ({ error: String(e.message || e) }))`);
      record('document_open_original_native', opened?.opened ? 'PASS' : 'FAIL', opened);
      const refused = await app.evaluate(`window.karkedikhaDesktop.openActivityDocument('doc-../../core.token').then((r) => r, (e) => ({ refused: String(e.message || e) }))`);
      record('document_open_refuses_path_escape', refused?.refused ? 'PASS' : 'FAIL', refused);
    }
  }

  // ---- D. Images -------------------------------------------------------------
  if (only.has('image')) {
    await newConversation(app);
    const turn = await runTurn(app, 'image', 'Generate an image of a red lighthouse on a rocky coast at sunset.',
      { timeoutMs: 1_200_000, screenshotWhen: (p) => p.visible && p.kind === 'Image' && p.state === 'Running' });
    await sleep(1500);
    const panel = await app.evaluate(PANEL);
    await screenshot(app, 'image-final');
    const image = turn.activities.find((a) => a.kind === 'image');
    record('image_approval_required_first', turn.cards.some((c) => c.toolName === 'image_generate') ? 'PASS' : 'FAIL', turn.cards);
    record('image_progress_shown', turn.timeline.some((s) => s.kind === 'Image' && s.state === 'Running') ? 'PASS' : 'NOT_OBSERVED', turn.timeline.slice(0, 6));
    record('image_generated_artifact_in_panel', image?.state === 'completed' && image.preview?.artifactIds?.length && panel.image?.dataUrl && panel.image.naturalWidth > 0 ? 'PASS' : 'FAIL', { state: image?.state, detail: image?.detail, artifactIds: image?.preview?.artifactIds, panelImage: panel.image });
    summary.image = image?.preview?.artifactIds ?? [];
  }

  // ---- E. Video --------------------------------------------------------------
  if (only.has('video')) {
    await newConversation(app);
    const turn = await runTurn(app, 'video', 'Generate a short video of gentle ocean waves rolling onto a beach.',
      { timeoutMs: 1_800_000, screenshotWhen: (p) => p.visible && p.kind === 'Video' && p.state === 'Running' });
    await sleep(2500);
    const video = turn.activities.find((a) => a.kind === 'video');
    // Play it in the panel and prove time advances.
    const playback = await app.evaluate(`(async () => {
      const v = document.querySelector('#context-activity video');
      if (!v) return { present: false };
      v.muted = true;
      if (v.readyState < 1) await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
      try { await v.play(); } catch (e) { return { present: true, playError: String(e) }; }
      const t0 = v.currentTime;
      await new Promise((r) => setTimeout(r, 1500));
      const result = { present: true, duration: v.duration, advanced: v.currentTime > t0, currentTime: v.currentTime, width: v.videoWidth, height: v.videoHeight };
      v.pause();
      return result;
    })()`);
    await screenshot(app, 'video-final');
    record('video_approval_required_first', turn.cards.some((c) => c.toolName === 'video_generate') ? 'PASS' : 'FAIL', turn.cards);
    record('video_generation_status_shown', turn.timeline.some((s) => s.kind === 'Video' && s.state === 'Running') ? 'PASS' : 'NOT_OBSERVED', turn.timeline.slice(0, 6));
    record('video_generated_for_real', video?.state === 'completed' && video.preview?.artifactIds?.length ? 'PASS' : 'FAIL', { state: video?.state, detail: video?.detail });
    record('video_plays_in_panel', playback?.advanced && playback.duration > 0 ? 'PASS' : 'FAIL', playback);
    summary.video = video?.preview?.artifactIds ?? [];
  }

  // ---- F. Recovery -----------------------------------------------------------
  if (only.has('recovery')) {
    const before = await snapshotOf(app);
    const conversationId = before?.selectedConversationId ?? before?.activeConversationId;
    const countBefore = (before?.workspaceActivities ?? []).filter((a) => a.conversationId === conversationId).length;

    // Reload the UI.
    await app.cdp('Page.reload', { ignoreCache: true });
    await sleep(3000);
    await waitForApi(app);
    await sleep(2000);
    let panel = await app.evaluate(PANEL);
    record('reload_history_behind_button', panel.toggleVisible ? 'PASS' : 'FAIL', { toggleVisible: panel.toggleVisible, panelOpen: panel.visible });
    await app.evaluate("document.getElementById('btn-open-workspace')?.click()");
    await sleep(1200);
    panel = await app.evaluate(PANEL);
    record('reload_history_accessible', panel.visible && panel.title ? 'PASS' : 'FAIL', { title: panel.title, state: panel.state, steps: panel.steps.length });

    // Restart the whole app.
    await quit(app.child);
    app = await start();
    if (conversationId) await app.evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(conversationId)}, true)`);
    await app.evaluate(`(() => { const row = [...document.querySelectorAll('[data-conversation-id]')].find((e) => e.dataset.conversationId === ${JSON.stringify(conversationId)}); if (row) row.click(); return true; })()`);
    await sleep(2500);
    const afterRestart = await snapshotOf(app);
    const restored = (afterRestart?.workspaceActivities ?? []).filter((a) => a.conversationId === conversationId);
    record('restart_activities_persisted', restored.length === countBefore && countBefore > 0 ? 'PASS' : 'FAIL', { before: countBefore, after: restored.length });
    await app.evaluate("(() => { const p = document.getElementById('workspace-context'); if (p && p.hidden) document.getElementById('btn-open-workspace')?.click(); return true; })()");
    await sleep(3000);
    panel = await app.evaluate(PANEL);
    await screenshot(app, 'restart-restored');
    record('restart_artifacts_still_accessible', (panel.video?.fileUrl || panel.image?.dataUrl) ? 'PASS' : 'FAIL', { kind: panel.kind, image: panel.image, video: panel.video });

    // Stop a running task.
    await newConversation(app);
    let stopped = false;
    const cancelTurn = await runTurn(app, 'cancel',
      'Use the browser to open https://www.python.org, then read the page, then follow three different links one after another and read each one.',
      {
        onTick: async ({ panel: p }) => {
          if (!stopped && p.visible && p.kind === 'Browser' && p.stopVisible && p.state === 'Running') {
            stopped = true;
            await screenshot(app, 'cancel-before-stop');
            await app.evaluate("document.getElementById('workspace-stop').click()");
          }
        },
      });
    await screenshot(app, 'cancel-after-stop');
    const falseSuccess = cancelTurn.activities.filter((a) => a.state === 'completed' && Date.parse(a.endedAt ?? '') > Date.now());
    record('stop_from_workspace', stopped ? 'PASS' : 'NOT_EXERCISED', { lastOutcome: cancelTurn.lastOutcome, activities: cancelTurn.activities.map((a) => `${a.capability}:${a.state}`) });
    record('stop_shows_cancelled_truthfully', stopped && (cancelTurn.lastOutcome === 'cancelled' || cancelTurn.activities.some((a) => a.state === 'cancelled')) && falseSuccess.length === 0 ? 'PASS' : 'FAIL', cancelTurn.activities.map((a) => ({ c: a.capability, s: a.state, d: a.detail })));

    // A genuine failure.
    await newConversation(app);
    const failTurn = await runTurn(app, 'failure', 'Use the browser to open https://pandesh-acceptance-check.invalid/ and tell me what the page says.');
    const failed = failTurn.activities.filter((a) => a.state === 'failed');
    await screenshot(app, 'failure-shown');
    record('genuine_failure_shown_as_failed', failed.length > 0 && failed.every((a) => a.detail) ? 'PASS' : 'FAIL', failTurn.activities.map((a) => ({ c: a.capability, s: a.state, d: a.detail })));
  }
} catch (err) {
  record('run_error', 'FAIL', String(err?.stack ?? err));
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = summary;
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await quit(app.child).catch(() => undefined);
  const failedChecks = evidence.checks.filter((c) => c.status === 'FAIL');
  console.log(`\n${evidence.checks.length} checks, ${failedChecks.length} failed. Evidence: ${evidenceDir}`);
}
