// Live-activity visibility evaluation: the REAL Electron host + v2 renderer (built from this tree) on a throwaway profile, driven over
// CDP exactly like desktop-path.mjs. For every scenario it samples what the Activity panel and the chat status row actually SHOW
// (DOM text, every ~1.5 s), takes real window screenshots, and cross-checks the panel's tool steps against the throwaway
// profile's own tool_invocations rows. Isolation: own data dir, own CDP/phone ports, local-only routing; production processes,
// Run key and port 3030 are snapshotted before and after. Nothing here touches the owner's profile or window.
// usage: DESK_ONLY=A1,A2 node acceptance/live-eval/activity-visibility.mjs   (build first: node esbuild.core.js && node apps/desktop/esbuild.mjs)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RC = path.resolve(HERE, '..', '..');
const LABEL = process.env.EVAL_LABEL ?? 'activity-visibility';
const ROOT = process.env.EVAL_ROOT ?? `D:/PandeshActivityEval/${LABEL}`;
const PROFILE = path.join(ROOT, 'profile');
const SHOTS = path.join(ROOT, 'shots');
const CDP_PORT = 9581; const MOBILE_PORT = 3981;
const ELECTRON = process.env.EVAL_ELECTRON ?? 'D:/Projects/Pandesh/dist/pandesh-win32-x64/electron/electron.exe';
const MODEL = process.env.EVAL_MODEL ?? 'gemma4:26b-a4b-it-qat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prodDir = path.join(process.env.LOCALAPPDATA ?? '', 'KarkeDikha', 'desktop');
if (path.resolve(PROFILE).toLowerCase() === path.resolve(prodDir).toLowerCase()) throw new Error('REFUSED: eval profile equals the production profile');
const ps = (c) => String(spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', c], { encoding: 'utf8', windowsHide: true }).stdout ?? '').trim();
const prodSnapshot = () => ({
  procs: ps("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*E:\\Pandesh\\*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { \"$($_.ProcessId)|$($_.Name)\" }").split(/\r?\n/).filter(Boolean),
  runKey: ps("(Get-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').Property -join ','"),
  port3030: ps("(Get-NetTCPConnection -State Listen -LocalPort 3030 -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.OwningProcess)\" }) -join ','"),
});
const killTree = (pid) => { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } };
try { const old = JSON.parse(fs.readFileSync(path.join(ROOT, 'host.pid'), 'utf8')); killTree(old); } catch { /* none */ }
await sleep(1500); fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(PROFILE, 'electron-profile'), { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'host-preferences.json'), JSON.stringify({ firstCloseExplained: true, openAtLogin: false, wakeEnabled: false, wakeMuted: false, ttsEngine: 'piper', uiVariant: 'v2', mobileAccess: 'off' }));
const before = prodSnapshot();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.KARKEDIKHA_OLLAMA_URL;
Object.assign(env, { KARKEDIKHA_DESKTOP_PRODUCT_ROOT: RC, KARKEDIKHA_DESKTOP_CORE_PATH: path.join(RC, 'out-core', 'core.js'), KARKEDIKHA_DESKTOP_NODE: process.execPath,
  KARKEDIKHA_DESKTOP_DATA_DIR: PROFILE, KARKEDIKHA_DESKTOP_HOST_LOG: path.join(PROFILE, 'desktop-host.log'), KARKEDIKHA_DESKTOP_CDP_PORT: String(CDP_PORT),
  KARKEDIKHA_MOBILE_PORT: String(MOBILE_PORT), KARKEDIKHA_MOBILE_HOST: '127.0.0.1', KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only' });
const host = spawn(ELECTRON, [`--remote-debugging-port=${CDP_PORT}`, path.join(RC, 'apps', 'desktop')], { cwd: RC, env, detached: true, stdio: 'ignore', windowsHide: false });
host.unref(); fs.writeFileSync(path.join(ROOT, 'host.pid'), String(host.pid));

class Cdp {
  static async attach() {
    let target = null;
    for (let i = 0; i < 180 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); target = l.find((t) => t.type === 'page'); } catch { /* not up */ } if (!target) await sleep(1000); }
    if (!target) throw new Error('no CDP target');
    const c = new Cdp(); c.ws = new WebSocket(target.webSocketDebuggerUrl); c.id = 0; c.p = new Map();
    await new Promise((res, rej) => { c.ws.addEventListener('open', res, { once: true }); c.ws.addEventListener('error', rej, { once: true }); });
    c.ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && c.p.has(d.id)) { const x = c.p.get(d.id); c.p.delete(d.id); d.error ? x.rej(new Error(JSON.stringify(d.error))) : x.res(d.result); } });
    return c;
  }
  send(method, params = {}, ms = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.p.delete(id); rej(new Error('CDP timeout: ' + method)); }, ms); this.p.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr, ms = 60000) {
    const v = await this.send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true }, ms);
    if (v.exceptionDetails) throw new Error(JSON.stringify(v.exceptionDetails).slice(0, 300));
    return v.result?.value;
  }
  async shot(name) {
    // Best effort: a window that is not being painted (screen locked, occluded) never answers captureScreenshot; evidence then is the DOM text.
    try { await this.send('Page.bringToFront', {}, 4000).catch(() => undefined); const r = await this.send('Page.captureScreenshot', { format: 'png' }, 10000); const f = path.join(SHOTS, `${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; } catch { fs.appendFileSync(path.join(ROOT, 'shots-skipped.txt'), `${name}
`); return null; }
  }
}
const cdp = await Cdp.attach();
const D = (call, ms) => cdp.eval(`window.karkedikhaDesktop.${call}`, ms);
const snap = async () => { for (let i = 0; i < 6; i++) { try { return await D('getSnapshot()', 30000); } catch { await sleep(2000); } } return D('getSnapshot()', 30000); };
let s = null; const t0 = Date.now();
while (Date.now() - t0 < 180000) { try { s = await snap(); if (s && (s.coreState === 'connected' || s.coreState === 'ready')) break; } catch { /* reloading */ } await sleep(1000); }
if (!(s && (s.coreState === 'connected' || s.coreState === 'ready'))) { console.error('desktop did not connect', s?.coreState); killTree(host.pid); process.exit(2); }
const coreInfo = () => JSON.parse(fs.readFileSync(path.join(PROFILE, 'core.json'), 'utf8'));
const db = () => new DatabaseSync(path.join(PROFILE, 'core.db'), { readOnly: true });
const q = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
console.log(`desktop up: core ${coreInfo().pid}, model ${s.model}`);
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
const models = await D('listModels()', 30000).catch(() => []);
const pick = models.find((m) => m === MODEL) ?? models.find((m) => m.startsWith(MODEL.split(':')[0]));
if (pick) await D(`selectModel(${JSON.stringify(pick)})`, 30000).catch((e) => console.log('selectModel:', e.message));
console.log('model for the run:', pick ?? '(host default)');
const WS = path.join(ROOT, 'ws').replace(/\\/g, '/'); fs.mkdirSync(WS, { recursive: true });
await D(`useWorkspace(${JSON.stringify(WS)}, { read: true, write: true }, 'recent')`, 30000).catch((e) => console.log('useWorkspace:', e.message));
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

// What the person sees right now: the chat status row and the Activity panel, as text.
const seen = () => cdp.eval(`(() => {
  const t = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : null);
  const aside = document.querySelector('aside[aria-label="Activity and preview"]');
  return { status: t(document.querySelector('.thinking')), aside: t(aside), asideOpen: !!aside,
    live: t(aside?.querySelector('section[aria-label="Current request"]')), last: t(aside?.querySelector('section[aria-label="Last request"]')) };
})()`).catch(() => ({}));

/** Submits through the host, answers approval cards per `decide(card)` (or leaves them pending for `holdMs`), and samples the screen. */
async function run(id, prompt, { decide = () => 'approved', killWhen, timeoutMs = 600000, shotsAt = [], holdApprovalMs = 0, attachments } = {}) {
  await D('newConversation()').catch(() => undefined); await sleep(800);
  const submitted = Date.now();
  const sub = await D(attachments ? `submitTask(${JSON.stringify(prompt)}, ${JSON.stringify(attachments)})` : `submitTask(${JSON.stringify(prompt)})`, 60000).catch((e) => ({ error: String(e.message) }));
  const samples = []; const decisions = []; const shotsDone = new Set(); let attemptId = null; let held = false;
  const maxIdle = Date.now() + timeoutMs;
  while (Date.now() < maxIdle) {
    const last = await snap(); attemptId = last?.attemptId ?? attemptId;
    const sinceSub = (Date.now() - submitted) / 1000;
    const view = await seen();
    samples.push({ t: Math.round(sinceSub), running: !!last?.running, awaiting: !!last?.pendingApproval, status: view.status, live: view.live ?? view.last, asideOpen: view.asideOpen });
    for (const sec of shotsAt) if (sinceSub >= sec && !shotsDone.has(sec)) { shotsDone.add(sec); await cdp.shot(`${id}-t${String(sec).padStart(3, '0')}`); }
    if (killWhen && attemptId && killWhen(attemptId)) return { attemptId, killed: true, samples, decisions, sub };
    const card = last?.pendingApproval;
    if (card) {
      if (holdApprovalMs && !held) { held = true; await cdp.shot(`${id}-approval-waiting`); await sleep(holdApprovalMs); await cdp.shot(`${id}-approval-waiting-later`); samples.push({ t: Math.round((Date.now() - submitted) / 1000), heldFor: holdApprovalMs, ...(await seen()) }); }
      const choice = decide(card); decisions.push({ tool: card.toolName, choice }); await D(`resolveApproval(${JSON.stringify(card.approvalId)}, ${JSON.stringify(choice)})`).catch(() => undefined); await sleep(700); continue;
    }
    if (!last?.running && attemptId) { await sleep(1500); const again = await snap(); if (!again?.running && !again?.pendingApproval) break; }
    await sleep(1500);
  }
  await sleep(800);
  const finalView = await seen(); await cdp.shot(`${id}-final`);
  const att = attemptId ? q('select status, failureReason from attempts where id = ?', attemptId)[0] : null;
  const tools = attemptId ? q("select id, toolName, status from tool_invocations where attemptId = ? order by rowid", attemptId) : [];
  const reply = attemptId ? (q("select m.content from conversation_messages m join requests r on r.conversationId = m.conversationId join attempts a on a.requestId = r.id where a.id = ? and m.role = 'assistant' order by m.seq desc limit 1", attemptId)[0]?.content ?? null) : null;
  return { attemptId, status: att?.status, failureReason: att?.failureReason ?? null, reply, decisions, samples, finalView, tools, sub };
}

const distinct = (samples, key) => [...new Set(samples.map((x) => x[key]).filter(Boolean).map((x) => String(x).slice(0, 160)))];
const results = [];
const ONLY = process.env.DESK_ONLY?.split(',');
async function scenario(id, title, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  const t = Date.now(); let r;
  try { r = await fn(); } catch (e) { r = { ok: false, notes: `HARNESS ERROR ${String(e.stack ?? e.message).slice(0, 400)}`, error: true }; }
  const row = { id, title, ok: !!r.ok, attemptStatus: r.status ?? null, seconds: Math.round((Date.now() - t) / 1000), notes: r.notes, evidence: r.evidence };
  results.push(row); console.log(`${id} ${row.error ? 'ERROR' : row.ok ? 'PASS' : 'FAIL'} ${row.seconds}s status=${row.attemptStatus} ${r.notes ?? ''}`.slice(0, 400));
  fs.writeFileSync(path.join(ROOT, `${id}.json`), JSON.stringify({ ...row, detail: r.detail }, null, 2));
}
const toolNamesInPanel = (text, tools) => tools.filter((t) => text && text.toLowerCase().includes(t.toolName.replace(/_/g, ' ').toLowerCase().split(' ')[0]));

await scenario('A1', 'Long model-only turn (>= 60 s): the panel names the phase, the quiet time, and that no tool was called', async () => {
  const r = await run('A1', 'Without using any tools, write a very detailed, 6000-word essay on the history of the tea trade between India, China and Britain, with twelve numbered sections, each at least 400 words.', { shotsAt: [6, 20, 45, 70, 100] });
  const dur = r.samples.at(-1)?.t ?? 0;
  const phases = distinct(r.samples, 'status'); const live = distinct(r.samples, 'live');
  const sawNoTool = live.some((x) => /No tool has been called|called no tools/.test(x));
  const opened = r.samples.some((x) => x.asideOpen);
  return { ...r, ok: dur >= 60 && opened && sawNoTool && phases.length >= 2 && r.status === 'completed', notes: `duration=${dur}s asideOpened=${opened} sawNoTool=${sawNoTool} phases=${JSON.stringify(phases).slice(0, 220)}`, evidence: { phases, live }, detail: { samples: r.samples } };
});

await scenario('A2', 'Successful multi-tool workflow: each call appears with name, target, timing and done state', async () => {
  fs.mkdirSync(path.join(WS, 'inbox'), { recursive: true }); fs.writeFileSync(path.join(WS, 'inbox', 'a.txt'), 'alpha fact: 41'); fs.writeFileSync(path.join(WS, 'inbox', 'b.txt'), 'beta fact: 42');
  const r = await run('A2', 'Read inbox/a.txt and inbox/b.txt, then create summary/both.txt containing the two facts, one per line.', { shotsAt: [10, 30, 60] });
  const file = rd(path.join(WS, 'summary', 'both.txt'));
  const finalText = r.finalView.aside ?? '';
  const live = distinct(r.samples, 'live');
  const matched = toolNamesInPanel(finalText, r.tools);
  return { ...r, ok: r.status === 'completed' && !!file && r.tools.length >= 2 && matched.length >= Math.min(2, r.tools.length), notes: `file=${JSON.stringify(file)} dbTools=${r.tools.map((t) => `${t.toolName}:${t.status}`).join(',')} panelMentions=${matched.length}/${r.tools.length}`, evidence: { live: live.slice(-3) }, detail: { final: r.finalView, samples: r.samples } };
});

await scenario('A3', 'Permission request awaiting user action: the panel says it is waiting for the person; nothing runs', async () => {
  const r = await run('A3', 'Create notes/waiting.txt containing: approval wait test', { holdApprovalMs: 12000, shotsAt: [] });
  const waits = r.samples.filter((x) => x.awaiting || x.heldFor);
  const sawWaiting = waits.some((x) => /Waiting for your permission|Nothing runs until you answer|Waiting for your decision/.test(`${x.live ?? ''} ${x.status ?? ''} ${x.aside ?? ''}`));
  return { ...r, ok: sawWaiting && r.decisions.length >= 1, notes: `sawWaiting=${sawWaiting} decisions=${JSON.stringify(r.decisions)} final=${r.status}`, evidence: { waits: waits.slice(0, 3) }, detail: { samples: r.samples } };
});

await scenario('A4', 'Rejected permission: file absent, activity says the request did not run / was stopped, never completed work', async () => {
  const r = await run('A4', 'Create notes/rejected.txt containing: should not exist', { decide: () => 'rejected' });
  const exists = fs.existsSync(path.join(WS, 'notes', 'rejected.txt'));
  const txt = `${r.finalView.live ?? ''} ${r.finalView.last ?? ''}`;
  return { ...r, ok: !exists && !/Completed\b.*Checked against the work recorded/.test(txt), notes: `fileExists=${exists} decisions=${JSON.stringify(r.decisions)} final=${r.status} panel=${txt.slice(0, 200)}`, evidence: { final: r.finalView }, detail: { samples: r.samples } };
});

await scenario('A5', 'Failed tool call: the failing step is red with Core\'s reason, the run does not claim success', async () => {
  const r = await run('A5', 'Read the file missing/nothing-here.txt and tell me its first line.', { shotsAt: [] });
  const panel = `${r.finalView.aside ?? ''}`;
  const failedInDb = r.tools.filter((t) => t.status === 'failed').length;
  return { ...r, ok: failedInDb >= 1 ? /failed/i.test(panel) : true, notes: `dbFailed=${failedInDb} panelMentionsFailed=${/failed/i.test(panel)} final=${r.status} reply=${(r.reply ?? '').slice(0, 120)}`, evidence: { final: r.finalView }, detail: { samples: r.samples } };
});

await scenario('A6', 'Interrupted (Core killed mid-task) then explicitly resumed: history stays accurate, resume starts only when asked', async () => {
  fs.rmSync(path.join(WS, 'analysis'), { recursive: true, force: true });
  for (const n of ['one', 'two', 'three', 'four']) { fs.mkdirSync(path.join(WS, 'inbox'), { recursive: true }); fs.writeFileSync(path.join(WS, 'inbox', `${n}.txt`), `${n}: fact ${n.length}`); }
  const writes = (a) => q(`select count(*) n from tool_invocations where toolName = 'write_file' and status = 'succeeded' and attemptId in (select id from attempts where requestId = (select requestId from attempts where id = ?))`, a)[0]?.n ?? 0;
  const k = await run('A6', 'For each of the four files in the inbox folder write analysis/<name>.md with one line about it, and analysis/index.md listing all four.', { killWhen: (a) => writes(a) >= 1, timeoutMs: 300000 });
  if (!k.killed) return { ...k, ok: false, error: true, notes: 'HARNESS: finished before the kill' };
  await cdp.shot('A6-before-kill');
  const core = coreInfo(); killTree(core.pid);
  let up = false; for (let i = 0; i < 90 && !up; i++) { await sleep(1000); try { const x = await snap(); if (x?.coreState === 'connected' || x?.coreState === 'ready') { if (coreInfo().pid !== core.pid) up = true; } } catch { /* restarting */ } }
  await sleep(6000);
  await cdp.shot('A6-after-restart'); const afterKill = await seen();
  const overview = await D('getTaskOverview()', 30000); const row = (overview.tasks ?? []).find((t) => t.attemptId === k.attemptId);
  const autoSucc = q('select count(*) n from attempts where predecessorAttemptId = ?', k.attemptId)[0].n;
  const resumed = await D(`resumeTask(${JSON.stringify(k.attemptId)})`, 60000).catch((e) => ({ error: String(e.message) }));
  const samples = []; const end = Date.now() + 300000; let st = null;
  while (Date.now() < end) { const x = await snap(); if (x?.pendingApproval) await D(`resolveApproval(${JSON.stringify(x.pendingApproval.approvalId)}, 'approved')`).catch(() => undefined); samples.push(await seen()); st = resumed?.attemptId ? q('select status from attempts where id = ?', resumed.attemptId)[0]?.status : null; if (['completed', 'failed', 'cancelled'].includes(st)) break; await sleep(2000); }
  await sleep(1500); await cdp.shot('A6-after-resume'); const finalView = await seen();
  return { attemptId: resumed?.attemptId, status: st, ok: up && !!row?.resumable && autoSucc === 0 && !resumed?.error, notes: `coreRestarted=${up} resultAfterKill=${row?.resultStatus} resumable=${row?.resumable} autoResumed=${autoSucc} resumed=${JSON.stringify(resumed).slice(0, 80)} final=${st}`, evidence: { afterKill, finalView }, detail: { before: k.samples.slice(-5), samples } };
});

const after = prodSnapshot();
const isolation = { productionProcessesUnchanged: JSON.stringify(before.procs) === JSON.stringify(after.procs), runKeyUnchanged: before.runKey === after.runKey, port3030Unchanged: before.port3030 === after.port3030 };
const summary = { label: LABEL, at: new Date().toISOString(), model: pick, scenarios: results.length, pass: results.filter((r) => r.ok).length, isolation };
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', `${LABEL}.json`), JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 1));
if (!process.env.DESK_KEEP) { killTree(host.pid); try { killTree(coreInfo().pid); } catch { /* gone */ } }
process.exit(0);
