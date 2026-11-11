#!/usr/bin/env node
/**
 * Workshop acceptance against an ISOLATED Pandesh dev instance (never production): drives the real v2 window over
 * the Chrome DevTools Protocol and Core's own HTTP API, and records evidence per micro-test (WSH-xxx) in the format
 * of the 700 micro-test catalog (status, observation, evidence, screenshots, timings).
 *
 * Evidence is what the app really shows and records: Babylon.js's own scene graph reported back through the
 * Workshop's inspection command, Core's artifacts and their SHA-256, the window's DOM, and screenshots.
 *
 *   node scripts/acceptance/workshop-acceptance.mjs --profile <isolated profile> --cdp <port> --out <evidence dir> [--only WSH-001,WSH-002]
 *
 * The profile must not be the real desktop profile (%LOCALAPPDATA%\KarkeDikha\desktop); the script refuses it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []));
const PROFILE = path.resolve(String(args.profile ?? ''));
const CDP_PORT = Number(args.cdp ?? 0);
const OUT = path.resolve(String(args.out ?? 'workshop-evidence'));
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const PROD = path.join(process.env.LOCALAPPDATA ?? '', 'KarkeDikha', 'desktop').toLowerCase();
if (!args.profile || !CDP_PORT) { console.error('usage: --profile <isolated profile dir> --cdp <port> --out <dir>'); process.exit(2); }
if (PROFILE.toLowerCase() === PROD || PROFILE.toLowerCase().startsWith('e:\\pandesh')) { console.error(`REFUSED: ${PROFILE} is a production location`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ------------------------------------------------------------------------------------------ Core HTTP (as the host)
function core() {
  const info = JSON.parse(fs.readFileSync(path.join(PROFILE, 'core.json'), 'utf8'));
  const token = fs.readFileSync(path.join(PROFILE, 'core.token'), 'utf8').trim();
  const hostToken = fs.readFileSync(path.join(PROFILE, 'host.token'), 'utf8').trim();
  return { base: `http://127.0.0.1:${info.port}`, token, hostToken };
}
async function http(method, route, body, { asModel = false } = {}) {
  const c = core();
  const headers = { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json', 'X-Client-Id': asModel ? 'model-workshop-acceptance' : 'workshop-acceptance' };
  if (asModel) headers['X-Caller-Type'] = 'model'; else headers['X-Host-Token'] = c.hostToken;
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  const res = await fetch(`${c.base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}
/** The same governed call the assistant makes (principal: model). */
const dispatch = (conversationId, toolName, toolArgs) => http('POST', '/v1/capabilities/dispatch', { correlationId: conversationId, toolName, arguments: toolArgs, cwd: PROFILE }, { asModel: true });

// ------------------------------------------------------------------------------------------ CDP
class Cdp {
  static async attach() {
    for (let i = 0; i < 60; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const t = list.find((x) => x.type === 'page' && /renderer[\\/]v2[\\/]index\.html/.test(x.url));
        if (t) { const c = new Cdp(t.webSocketDebuggerUrl); await c.open(); return c; }
      } catch { /* not up yet */ }
      await sleep(1000);
    }
    throw new Error('no v2 window on the CDP port');
  }
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    this.ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) { const p = this.pending.get(d.id); this.pending.delete(d.id); if (d.error) p.reject(new Error(JSON.stringify(d.error))); else p.resolve(d.result); return; }
      if (d.method) for (const fn of this.listeners.get(d.method) ?? []) fn(d.params, d.sessionId);
    });
  }
  /** CDP events (for frames attached as their own flattened sessions). */
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  send(method, params = {}, timeoutMs = 60_000, sessionId = undefined) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async eval(expression, timeoutMs = 60_000) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { return (${expression}); })()`, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result?.value;
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, 30_000);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return path.basename(file);
  }
  /** A real mouse gesture on the page (orbiting the camera, picking a part). */
  async drag(x0, y0, x1, y1, steps = 12) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i += 1) await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, button: 'left', buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// ------------------------------------------------------------------------------------------ evidence
const results = {};
async function test(id, title, fn) {
  if (ONLY && !ONLY.has(id)) return;
  const dir = path.join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const record = { id, title, startedAt: now(), screenshots: [], facts: {} };
  process.stdout.write(`${id} ${title} … `);
  try {
    const out = await fn({ dir, record });
    record.status = out?.status ?? 'PASS';
    record.observation = out?.observation ?? '';
  } catch (err) {
    record.status = 'FAIL';
    record.observation = String(err?.message ?? err);
  }
  record.latencyMs = Date.now() - started;
  fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(record, null, 2));
  results[id] = record;
  console.log(`${record.status} (${(record.latencyMs / 1000).toFixed(1)} s) ${record.observation.slice(0, 160)}`);
}

// ------------------------------------------------------------------------------------------ scenario: 3D Workshop
const GEARS = {
  type: '3d',
  title: 'Gear assembly',
  components: [
    { id: 'base', name: 'Base plate', kind: 'box', params: { width: 190, height: 6, depth: 120 }, position: [0, -3, 0], material: 'aluminium', group: 'Frame' },
    { id: 'shaft_a', name: 'Drive shaft', kind: 'cylinder', params: { radius: 4, height: 40 }, position: [-30, 20, 0], material: 'polished_steel', group: 'Shafts' },
    { id: 'gear_a', name: 'Drive gear', kind: 'gear', params: { teeth: 32, radius: 40, thickness: 8, bore: 4 }, position: [-30, 12, 0], material: 'brass', group: 'Gears' },
    { id: 'gear_b', name: 'Driven gear', kind: 'gear', params: { teeth: 16, thickness: 8, bore: 3 }, meshWith: 'gear_a', angle: 0, material: 'brushed_steel', group: 'Gears' },
    { id: 'shaft_b', name: 'Driven shaft', kind: 'cylinder', params: { radius: 3, height: 40 }, position: [30, 20, 0], material: 'polished_steel', group: 'Shafts' },
    { id: 'case', name: 'Outer case', kind: 'tube', params: { outerRadius: 92, innerRadius: 88, height: 34 }, position: [0, 17, 0], material: { preset: 'painted', color: '#2b4c7e' }, group: 'Frame' },
  ],
};

async function inspect(conversationId) {
  const r = await dispatch(conversationId, 'workshop_status', { inspect: true });
  const text = String(r.toolInvocation?.evidence?.output ?? r.toolInvocation?.output ?? JSON.stringify(r));
  const m = /Live inspection from the window's renderer: (\{[\s\S]*\})/.exec(text);
  return { text, state: m ? JSON.parse(m[1]) : null };
}
const outputOf = (r) => String(r.toolInvocation?.evidence?.output ?? r.reason ?? JSON.stringify(r)).slice(0, 2000);

/** After a restart of the app: the conversation reopens with its Workshop, at the same version, with the same scene. */
async function reopen(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cdp = await Cdp.attach();
  await test('WSH-011', 'The scene is saved and reopens after Pandesh restarts (same version, same parts, same materials)', async ({ dir, record }) => {
    await cdp.eval(`window.desktop.openConversation(${JSON.stringify(saved.conversationId)}, true).then(() => true)`);
    await waitFor(() => cdp.eval(`Boolean(document.querySelector('.ws-panel canvas.ws3d-canvas')) && !document.querySelector('.ws-loading')`), 30_000, 'the Workshop to reopen');
    await sleep(2500);
    const label = await cdp.eval(`document.querySelector('#ws-version')?.selectedOptions?.[0]?.textContent ?? ''`);
    const { state } = await inspect(saved.conversationId);
    const file2 = (await http('GET', `/v1/artifacts/${saved.artifactId}`)).absolutePath;
    const scene = JSON.parse(fs.readFileSync(file2, 'utf8'));
    record.facts = { saved, versionLabel: label, meshes: state?.meshes };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'reopened.png')));
    if (!state || state.meshCount !== scene.components.length) throw new Error(`renderer reports ${state?.meshCount} meshes, the saved version has ${scene.components.length}`);
    const caseMesh = state.meshes.find((m) => m.id === 'case');
    if (!new RegExp(`v${saved.versions} of ${saved.versions}`).test(label)) throw new Error(`version selector shows "${label}"`);
    return { observation: `After a restart the chat reopened with the Workshop at "${label.trim()}"; ${state.meshCount} meshes; case metallic ${caseMesh?.material.metallic} (the brushed-steel edit survived).` };
  });
  fs.writeFileSync(path.join(OUT, 'results-reopen.json'), JSON.stringify(results, null, 2));
  cdp.ws.close();
  process.exit(Object.values(results).every((r) => r.status === 'PASS') ? 0 : 1);
}

/** A consequential Workshop call as the assistant makes it: the approval, then the same call again (it now runs). */
async function governed(conversationId, toolName, toolArgs, record) {
  const first = await dispatch(conversationId, toolName, toolArgs);
  if (first.outcome === 'executed') return first;
  if (first.outcome !== 'approval_required') throw new Error(`${toolName}: ${first.outcome} ${first.reason ?? ''}`);
  record.facts[`${toolName}Approval`] = first.approval?.summary?.arguments;
  await http('POST', `/v1/assistant/approvals/${first.approval.id}/resolve`, { resolution: 'approved' });
  await sleep(500);
  return dispatch(conversationId, toolName, toolArgs);
}

async function simulationScenario(cdp) {
  const ctx = {};
  const labState = async () => (await cdp.eval(`(() => { const m = [...document.querySelectorAll('.ws-sim-side .ws-metric')].map((e) => [e.querySelector('.meta')?.textContent, e.querySelector('strong')?.textContent]); return { metrics: Object.fromEntries(m), minute: document.querySelector('.ws-sim .ws-toolbar .meta')?.textContent ?? '' }; })()`));

  await test('WSH-020', '"Simulate a food stall with one serving counter, customers every two minutes, service three minutes": a working Simulation Lab', async ({ dir, record }) => {
    const conv = await http('POST', '/v1/conversations', { mode: 'baat_kar', title: 'Simulation acceptance' });
    ctx.conversationId = conv.id;
    await cdp.eval(`window.desktop.openConversation(${JSON.stringify(conv.id)}, true).then(() => true)`);
    await sleep(800);
    const r = await governed(conv.id, 'create_simulation', { title: 'Food stall', arrivalEveryMinutes: 2, serviceMinutes: 3, counters: 1 }, record);
    record.facts.output = outputOf(r);
    if (r.toolInvocation?.status !== 'succeeded') throw new Error(outputOf(r));
    await waitFor(() => cdp.eval(`Boolean(document.querySelector('.ws-sim canvas.ws-sim-canvas'))`), 20_000, 'the Simulation Lab');
    await sleep(600);
    const lab = await labState();
    record.facts.lab = lab;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'lab.png')));
    const avg = /average wait ([\d.]+) min/.exec(outputOf(r))?.[1];
    if (!avg || !String(lab.metrics['Average wait']).startsWith(Number(avg).toFixed(1))) throw new Error(`Core said average wait ${avg}, the Lab shows ${lab.metrics['Average wait']}`);
    return { observation: `Core's simulated result (${outputOf(r).match(/Simulated result: [^\n]+/)?.[0].slice(0, 160)}) matches the Lab (average wait ${lab.metrics['Average wait']}).` };
  });

  await test('WSH-021', 'Play, speed up, pause: the stall animates through simulated minutes and stops when paused', async ({ dir, record }) => {
    for (const [action, value] of [['play'], ['speed', '30']]) {
      const r = await dispatch(ctx.conversationId, 'workshop_view', { action, ...(value ? { value } : {}) });
      if (!/^DONE/.test(outputOf(r))) throw new Error(outputOf(r));
    }
    await sleep(1500);
    const pause = await dispatch(ctx.conversationId, 'workshop_view', { action: 'pause' });
    const at1 = (await labState()).minute;
    await sleep(1000);
    const at2 = (await labState()).minute;
    record.facts = { pause: outputOf(pause), at1, at2 };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'paused.png')));
    if (!/^DONE/.test(outputOf(pause)) || at1 !== at2 || /minute 0\.0 of/.test(at1)) throw new Error(`minute ${at1} then ${at2}`);
    return { observation: `${outputOf(pause).slice(0, 140)}; clock stayed at "${at2}".` };
  });

  await test('WSH-022', '"Show average waiting time": the Lab highlights the measured value', async ({ record }) => {
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'show_metric', value: 'wait' });
    const highlighted = await cdp.eval(`document.querySelector('.ws-metric.highlight')?.textContent ?? ''`);
    record.facts = { output: outputOf(r), highlighted };
    if (!/^DONE/.test(outputOf(r)) || !/Average wait/.test(highlighted)) throw new Error(`${outputOf(r)} / ${highlighted}`);
    return { observation: `${highlighted} highlighted; ${outputOf(r).slice(0, 160)}` };
  });

  await test('WSH-023', '"Add a second counter": re-simulated as a new version with the same seed, waits drop', async ({ dir, record }) => {
    const before = (await labState()).metrics['Average wait'];
    const r = await governed(ctx.conversationId, 'workshop_edit', { adjust: { addCounters: 1 }, summary: 'Add a second counter' }, record);
    record.facts.output = outputOf(r);
    await waitFor(async () => /v2 of 2/.test(await cdp.eval(`document.querySelector('#ws-version')?.selectedOptions?.[0]?.textContent ?? ''`)), 15_000, 'version 2 on screen');
    await sleep(500);
    const after = (await labState()).metrics['Average wait'];
    record.facts.before = before; record.facts.after = after;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'two-counters.png')));
    if (!(parseFloat(after) < parseFloat(before))) throw new Error(`average wait ${before} → ${after}`);
    return { observation: `${outputOf(r).split('\n')[0].slice(0, 200)}; Lab: average wait ${before} → ${after}.` };
  });

  await test('WSH-024', 'A what-if slider re-runs the model at once and is saved only on "Save as new version"', async ({ record }) => {
    const before = (await labState()).metrics['Average wait'];
    await cdp.eval(`(() => { const s = [...document.querySelectorAll('.ws-slider')].find((l) => /Serving takes/.test(l.textContent)).querySelector('input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, '6'); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
    const draft = (await labState()).metrics['Average wait'];
    const versionsBefore = (await http('GET', `/v1/workshops?conversationId=${ctx.conversationId}`)).workshops[0].versions.length;
    await cdp.eval(`[...document.querySelectorAll('.ws-sim .ws-toolbar button')].find((b) => /Save as new version/.test(b.textContent)).click(), true`);
    const w = await waitFor(async () => { const x = (await http('GET', `/v1/workshops?conversationId=${ctx.conversationId}`)).workshops[0]; return x.versions.length > versionsBefore ? x : null; }, 15_000, 'a saved version');
    record.facts = { before, draft, versions: w.versions.map((v) => v.meta.op.summary) };
    if (!(parseFloat(draft) > parseFloat(before))) throw new Error(`slider did not change the measured wait (${before} → ${draft})`);
    return { observation: `Serving 3 → 6 min: average wait ${before} → ${draft} at once; saved as v${w.versions.length} ("${w.versions[w.versions.length - 1].meta.op.summary}").` };
  });

  await test('WSH-025', 'Scenario comparison: v1 (one counter) against v2 (two counters)', async ({ dir, record }) => {
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'compare', version: '1', compareWith: '2' });
    await sleep(800);
    const table = await cdp.eval(`document.querySelector('.ws-compare-table')?.innerText ?? ''`);
    record.facts = { output: outputOf(r), table };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'compare.png')));
    if (!/^DONE/.test(outputOf(r)) || !/Average wait/.test(table)) throw new Error(`${outputOf(r)} / ${table}`);
    return { observation: table.replace(/\s+/g, ' ').slice(0, 200) };
  });
}

// ------------------------------------------------------------------------------------------ scenario: Design page
const LANDING = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Kha ke dikha</title>',
  '<style>',
  'body { margin: 0; font-family: system-ui, "Segoe UI", sans-serif; background: #fff8f0; color: #2b2118; }',
  '.wrap { max-width: 880px; margin: 0 auto; padding: 48px 20px; }',
  'h1 { font-size: 40px; line-height: 1.15; margin: 0 0 12px; }',
  'p { font-size: 18px; color: #5b4a3a; }',
  '.cta { margin-top: 18px; padding: 14px 22px; border: 0; border-radius: 10px; background: #c0392b; color: #fff; font-size: 17px; font-weight: 600; cursor: pointer; }',
  '</style>',
  '</head>',
  '<body>',
  '<main class="wrap">',
  '<h1>Kha ke dikha biryani</h1>',
  '<p>Slow-cooked dum biryani, packed fresh for pickup every evening.</p>',
  '<button type="button" class="cta">Contact us</button>',
  '</main>',
  '</body>',
  '</html>',
].join('\n');

/** A page that tries every way out of the preview, all aimed at a listener this script owns on 127.0.0.1. */
const hostilePage = (port) => `<!doctype html><html><head><title>Offline check</title>
<link rel="stylesheet" href="http://127.0.0.1:${port}/style.css">
<link rel="prefetch" href="http://127.0.0.1:${port}/prefetch">
<style>@import url(http://127.0.0.1:${port}/import.css); body { background: url(http://127.0.0.1:${port}/bg.png); }</style>
<script src="http://127.0.0.1:${port}/script.js"></script>
</head><body>
<h1>Offline check</h1>
<img src="http://127.0.0.1:${port}/pixel.png" alt="remote image">
<iframe src="http://127.0.0.1:${port}/frame" title="remote frame"></iframe>
<form action="http://127.0.0.1:${port}/submit" method="post"><input name="q" value="page text"><button id="send">Send</button></form>
<script>
var port = ${port};
fetch('http://127.0.0.1:' + port + '/fetch?d=' + encodeURIComponent(document.title)).catch(function () {});
try { new WebSocket('ws://127.0.0.1:' + port + '/ws'); } catch (e) {}
try { navigator.sendBeacon('http://127.0.0.1:' + port + '/beacon', 'x'); } catch (e) {}
try { new EventSource('http://127.0.0.1:' + port + '/events'); } catch (e) {}
try { var x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:' + port + '/xhr'); x.send(); } catch (e) {}
setTimeout(function () { document.getElementById('send').click(); }, 300);
setTimeout(function () { try { window.open('http://127.0.0.1:' + port + '/popup'); } catch (e) {} }, 500);
setTimeout(function () { location.href = 'http://127.0.0.1:' + port + '/navigate'; }, 900);
</script></body></html>`;

/** Counts every TCP connection and request that reaches it: the proof that nothing left the preview. */
function listener() {
  const hits = [];
  const server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(204); res.end(); });
  server.on('connection', () => hits.push('TCP connection'));
  server.on('upgrade', (req, socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy(); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, hits, close: () => new Promise((r) => server.close(r)) })));
}

/** The preview frame's own JavaScript context: an out-of-process frame is reached as its own flattened session. */
async function previewFrame(cdp, src) {
  const attached = [];
  cdp.on('Target.attachedToTarget', (p) => attached.push(p));
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const evalWith = (extra) => async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { return (${expression}); })()`, awaitPromise: true, returnByValue: true, ...extra.params }, 30_000, extra.sessionId);
    if (r.exceptionDetails) throw new Error(`frame eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result?.value;
  };
  const target = await waitFor(async () => attached.filter((a) => a.targetInfo?.type === 'iframe' && a.targetInfo.url === src).pop(), 6_000, 'the preview frame target').catch(() => null);
  if (target) return { kind: 'out-of-process frame (own renderer process)', eval: evalWith({ sessionId: target.sessionId, params: {} }) };
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (p, sessionId) => { if (!sessionId) contexts.push(p.context); });
  await cdp.send('Runtime.enable');
  const tree = await cdp.send('Page.getFrameTree');
  const child = (tree.frameTree.childFrames ?? []).find((f) => f.frame.url === src);
  if (!child) throw new Error('no preview frame in the page');
  const context = await waitFor(() => contexts.find((c) => c.auxData?.frameId === child.frame.id && c.auxData?.isDefault), 6_000, 'the frame context');
  return { kind: 'in-process frame', eval: evalWith({ params: { contextId: context.id } }) };
}


async function designScenario(cdp) {
  const ctx = { log: [] };
  // The window's own console: Chromium reports what its policies blocked here.
  cdp.on('Log.entryAdded', (p, sessionId) => { if (!sessionId) ctx.log.push(String(p.entry?.text ?? '')); });
  await cdp.send('Log.enable');
  const frameSrc = () => cdp.eval(`document.querySelector('.ws-design iframe')?.src ?? ''`);
  const versionLabel = () => cdp.eval(`document.querySelector('#ws-version')?.selectedOptions?.[0]?.textContent ?? ''`);

  await test('WSH-030', '"Create a simple local landing page with a heading and a contact button": the page opens in a sandboxed, offline preview', async ({ dir, record }) => {
    const conv = await http('POST', '/v1/conversations', { mode: 'baat_kar', title: 'Design acceptance' });
    ctx.conversationId = conv.id;
    await cdp.eval(`window.desktop.openConversation(${JSON.stringify(conv.id)}, true).then(() => true)`);
    await sleep(800);
    const r = await governed(conv.id, 'create_design', { title: 'Kha ke dikha landing page', html: LANDING }, record);
    record.facts.output = outputOf(r);
    if (r.toolInvocation?.status !== 'succeeded') throw new Error(outputOf(r));
    const frame = await waitFor(() => cdp.eval(`(() => { const f = document.querySelector('.ws-design iframe'); return f && f.src.startsWith('pandesh-preview://') ? { src: f.src, sandbox: f.getAttribute('sandbox'), referrerPolicy: f.getAttribute('referrerpolicy') } : null; })()`), 20_000, 'the design preview frame');
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-design-side .ws-outline li').length > 0`), 15_000, 'the page outline');
    const { state } = await inspect(conv.id);
    record.facts.frame = frame; record.facts.inspected = state;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'landing-desktop.png')));
    const h1 = state?.headings?.find((h) => h.tag === 'h1');
    const button = state?.buttons?.find((b) => /contact/i.test(b.text));
    if (frame.sandbox !== 'allow-scripts') throw new Error(`frame sandbox is "${frame.sandbox}"`);
    if (!h1 || h1.fontSizePx !== 40 || !button?.visible) throw new Error(`inspection: ${JSON.stringify(state).slice(0, 300)}`);
    ctx.h1Before = h1.fontSizePx;
    return { observation: `v1 saved (text/html) and shown in a sandbox="allow-scripts" frame from pandesh-preview://…; the rendered page reports h1 "${h1.text}" at ${h1.fontSizePx}px and a visible "${button.text}" button (${button.widthPx}×${button.heightPx}px).` };
  });

  await test('WSH-031', 'The preview cannot reach Pandesh: no bridge, no Node, opaque origin, no storage, no Core API, no popups, no navigation away', async ({ record }) => {
    const src = await frameSrc();
    const frame = await previewFrame(cdp, src);
    const corePort = new URL(core().base).port;
    const probe = await frame.eval(`(async () => {
      const out = { origin: self.origin, href: location.href.slice(0, 30), desktopBridge: typeof window.desktop, require: typeof require, process: typeof process, electron: typeof window.electron };
      try { out.parentDocument = String(Boolean(parent.document)); } catch (e) { out.parentDocument = 'blocked: ' + e.name; }
      try { out.localStorage = 'available (' + localStorage.length + ')'; } catch (e) { out.localStorage = 'blocked: ' + e.name; }
      try { out.cookie = 'readable: ' + JSON.stringify(document.cookie); } catch (e) { out.cookie = 'blocked: ' + e.name; }
      try { const r = await fetch('http://127.0.0.1:${corePort}/v1/health'); out.coreApi = 'reached ' + r.status; } catch (e) { out.coreApi = 'blocked: ' + e.name; }
      try { const w = window.open('about:blank'); out.popup = w ? 'opened' : 'blocked (null)'; } catch (e) { out.popup = 'blocked: ' + e.name; }
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); out.microphone = 'GRANTED'; } catch (e) { out.microphone = 'blocked: ' + (e && e.name); }
      return out;
    })()`);
    // Navigation away, aimed at a listener this script owns: nothing may reach it.
    const sink = await listener();
    let navigation;
    try {
      const logBefore = ctx.log.length;
      await frame.eval(`(location.href = 'http://127.0.0.1:${sink.port}/away', true)`).catch(() => undefined);
      await sleep(2_000);
      const stopped = ctx.log.slice(logBefore).filter((t) => t.includes(`'http://127.0.0.1:${sink.port}/'`) && /frame-src/.test(t));
      const notice = await waitFor(() => cdp.eval(`[...document.querySelectorAll('.ws-design .notice')].map((n) => n.textContent).find((t) => /tried to open another address/.test(t)) ?? null`), 6_000, 'the "tried to open another address" notice').catch(() => null);
      navigation = { listenerHits: [...sink.hits], windowPolicyLog: stopped.map((t) => t.trim().slice(0, 200)), notice: notice?.slice(0, 160) ?? null };
    } finally { await sink.close(); }
    // Reload brings the page back in a fresh preview (a new token), with its reporter.
    const reload = await dispatch(ctx.conversationId, 'workshop_view', { action: 'reset' });
    await waitFor(async () => (await frameSrc()) !== src && (await frameSrc()).startsWith('pandesh-preview://'), 10_000, 'a fresh preview');
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-design-side .ws-outline li').length > 0 && !document.querySelector('.ws-design .notice')`), 10_000, 'the reloaded page outline');
    record.facts = { frameKind: frame.kind, probe, navigation, reload: outputOf(reload) };
    const failures = [];
    if (probe.origin !== 'null') failures.push(`origin ${probe.origin}`);
    if (probe.desktopBridge !== 'undefined' || probe.require !== 'undefined' || probe.process !== 'undefined') failures.push('a privileged global is visible');
    for (const k of ['parentDocument', 'localStorage', 'cookie', 'coreApi', 'microphone']) if (!String(probe[k]).startsWith('blocked')) failures.push(`${k}: ${probe[k]}`);
    if (!String(probe.popup).startsWith('blocked')) failures.push(`popup ${probe.popup}`);
    if (navigation.listenerHits.length) failures.push(`navigation reached the listener: ${navigation.listenerHits.join(', ')}`);
    if (!navigation.windowPolicyLog.length) failures.push('no frame-src block recorded for the navigation');
    if (!navigation.notice) failures.push('the panel did not say the page tried to leave');
    if (!/^DONE/.test(outputOf(reload))) failures.push(`reload: ${outputOf(reload).slice(0, 120)}`);
    if (failures.length) throw new Error(failures.join('; '));
    return { observation: `In the ${frame.kind}: origin "null"; window.desktop/require/process undefined; parent.document ${probe.parentDocument}; localStorage ${probe.localStorage}; cookie ${probe.cookie}; Core API ${probe.coreApi}; popup ${probe.popup}; microphone ${probe.microphone}. Navigation to 127.0.0.1:<listener>: 0 connections; the window's policy logged "${navigation.windowPolicyLog[0]?.slice(0, 90)}"; the panel said so; "reset" reloaded the page in a fresh preview.` };
  });

  await test('WSH-032', '"Show it on a phone": phone, tablet and desktop sizes, measured in the page', async ({ dir, record }) => {
    const seen = {};
    for (const value of ['mobile', 'tablet', 'desktop']) {
      const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'device', value });
      if (!/^DONE/.test(outputOf(r))) throw new Error(outputOf(r));
      const vw = /\((\d+)×(\d+) CSS px\)/.exec(outputOf(r));
      seen[value] = vw ? `${vw[1]}×${vw[2]}` : outputOf(r).slice(0, 80);
      if (value === 'mobile') record.screenshots.push(await cdp.screenshot(path.join(dir, 'landing-phone.png')));
    }
    record.facts = seen;
    if (seen.mobile !== '390×844' || seen.tablet !== '820×1180' || seen.desktop !== '1280×800') throw new Error(JSON.stringify(seen));
    return { observation: `The page itself reported its viewport: phone ${seen.mobile}, tablet ${seen.tablet}, desktop ${seen.desktop} (CSS px).` };
  });

  await test('WSH-033', '"Make the heading larger": a new version, and the preview shows the larger heading', async ({ dir, record }) => {
    const r = await governed(ctx.conversationId, 'workshop_edit', { replacements: [{ find: 'h1 { font-size: 40px;', replace: 'h1 { font-size: 64px;' }], summary: 'Make the heading larger' }, record);
    record.facts.output = outputOf(r);
    if (r.toolInvocation?.status !== 'succeeded') throw new Error(outputOf(r));
    await waitFor(async () => /v2 of 2/.test(await versionLabel()), 15_000, 'version 2 on screen');
    await waitFor(() => cdp.eval(`[...document.querySelectorAll('.ws-design-side .ws-outline li')].some((l) => /h1/.test(l.textContent) && /64px/.test(l.textContent))`), 15_000, 'the 64px heading in the outline');
    const { state } = await inspect(ctx.conversationId);
    const h1 = state?.headings?.find((h) => h.tag === 'h1');
    record.facts.inspected = state;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'heading-larger.png')));
    if (!h1 || !(h1.fontSizePx > ctx.h1Before)) throw new Error(`h1 is ${h1?.fontSizePx}px (was ${ctx.h1Before}px)`);
    return { observation: `${outputOf(r).split('\n')[0].slice(0, 160)}; the rendered h1 is now ${h1.fontSizePx}px (was ${ctx.h1Before}px), ${h1.heightPx}px tall.` };
  });

  await test('WSH-034', 'Compare v1 with v2: the changed line, read from the two saved files', async ({ dir, record }) => {
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'compare', version: '1', compareWith: '2' });
    await sleep(800);
    const summaryText = await cdp.eval(`document.querySelector('.ws-compare')?.innerText ?? ''`);
    await cdp.eval(`([...document.querySelectorAll('.ws-design .ws-toolbar button')].find((b) => b.textContent === 'Changes')?.click(), true)`);
    await sleep(400);
    const diff = await cdp.eval(`({ added: [...document.querySelectorAll('.ws-diff .add')].map((d) => d.textContent), removed: [...document.querySelectorAll('.ws-diff .del')].map((d) => d.textContent) })`);
    record.facts = { output: outputOf(r), summaryText, diff };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'changes.png')));
    if (!/^DONE/.test(outputOf(r)) || !diff.added.some((t) => /64px/.test(t)) || !diff.removed.some((t) => /40px/.test(t)) || diff.added.length !== 1 || diff.removed.length !== 1) throw new Error(JSON.stringify(diff));
    await cdp.eval(`([...document.querySelectorAll('.ws-compare button')].find((b) => /Done comparing/.test(b.textContent))?.click(), true)`);
    return { observation: `${summaryText.replace(/\s+/g, ' ').slice(0, 120)}; diff: − ${diff.removed[0].trim().slice(0, 50)} / + ${diff.added[0].trim().slice(0, 50)}.` };
  });

  await test('WSH-035', '"Show me the code": the page source, read-only', async ({ record }) => {
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'show_code' });
    const code = await cdp.eval(`document.querySelector('.ws-design .ws-code')?.innerText ?? ''`);
    record.facts = { output: outputOf(r), lines: code.split('\n').length };
    if (!/^DONE/.test(outputOf(r)) || !/font-size: 64px/.test(code) || !/Contact us/.test(code)) throw new Error(`${outputOf(r)} / ${code.slice(0, 80)}`);
    await dispatch(ctx.conversationId, 'workshop_view', { action: 'device', value: 'desktop' });
    return { observation: `${outputOf(r).slice(0, 120)}; the code view shows the saved v2 source (64px heading, Contact us button).` };
  });

  await test('WSH-036', 'A page that tries every way out (fetch, XHR, WebSocket, beacon, EventSource, images, CSS, scripts, frames, forms, popups, navigation) reaches nothing', async ({ dir, record }) => {
    const sink = await listener();
    try {
      const r = await governed(ctx.conversationId, 'create_design', { title: 'Offline check', html: hostilePage(sink.port) }, record);
      record.facts.output = outputOf(r);
      if (r.toolInvocation?.status !== 'succeeded') throw new Error(outputOf(r));
      await waitFor(async () => (await frameSrc()).startsWith('pandesh-preview://') && /Offline check/.test(await cdp.eval(`document.querySelector('.ws-title')?.textContent ?? ''`)), 20_000, 'the offline-check page');
      await sleep(3_500);
      const blocked = await cdp.eval(`[...document.querySelectorAll('.ws-design-side h4')].filter((h) => /Blocked/.test(h.textContent)).map((h) => h.nextElementSibling?.innerText ?? '').join('\\n')`);
      const notes = await cdp.eval(`[...document.querySelectorAll('.ws-design-side h4')].filter((h) => /Notes/.test(h.textContent)).map((h) => h.nextElementSibling?.innerText ?? '').join('\\n')`);
      const leftNotice = await cdp.eval(`[...document.querySelectorAll('.ws-design .notice')].map((n) => n.textContent).find((t) => /tried to open another address/.test(t)) ?? ''`);
      record.facts.listenerHits = [...sink.hits];
      record.facts.blockedShown = blocked.split('\n').filter(Boolean);
      record.facts.windowPolicyLog = ctx.log.filter((t) => t.includes(`127.0.0.1:${sink.port}`)).map((t) => t.trim().slice(0, 200));
      record.facts.notes = notes;
      record.facts.leftNotice = leftNotice.slice(0, 160);
      record.screenshots.push(await cdp.screenshot(path.join(dir, 'offline-check.png')));
      if (sink.hits.length) throw new Error(`the listener was reached: ${sink.hits.join(', ')}`);
      if (!/127\.0\.0\.1/.test(blocked)) throw new Error(`no blocked requests reported: ${blocked}`);
      if (!leftNotice) throw new Error('the panel did not say the page tried to leave');
      return { observation: `0 connections reached the listener on 127.0.0.1:${sink.port} (fetch, XHR, WebSocket, beacon, EventSource, img, CSS, @import, script, iframe, form, popup, navigation all tried); the panel lists ${record.facts.blockedShown.length} blocked request(s) and says the page tried to leave; Core noted up front: ${notes.split('\n')[0]?.slice(0, 90)}.` };
    } finally {
      await sink.close();
    }
  });
}

// ------------------------------------------------------------------------------------------ scenario: Video slideshow
/** Three synthetic test pictures (FFmpeg's own test patterns), made for this run in the isolated profile. */
function testPictures() {
  const dir = path.join(PROFILE, '..', 'test-images');
  fs.mkdirSync(dir, { recursive: true });
  const sources = { 'stall-1.png': 'testsrc2=s=1600x1200', 'stall-2.png': 'smptehdbars=s=1600x1200', 'stall-3.png': 'mandelbrot=s=1600x1200' };
  return Object.entries(sources).map(([name, src]) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', file]);
      if (r.status !== 0) throw new Error(`could not make ${name}: ${String(r.stderr)}`);
    }
    return file;
  });
}
function ffprobe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  return { width: j.streams[0].width, height: j.streams[0].height, codec: j.streams[0].codec_name, duration: Math.round(Number(j.format.duration) * 100) / 100 };
}

async function videoScenario(cdp) {
  const ctx = {};
  const latestFile = async () => {
    const w = (await http('GET', `/v1/workshops?conversationId=${ctx.conversationId}`)).workshops.find((x) => x.type === 'video');
    const a = await http('GET', `/v1/artifacts/${w.latestArtifactId}`);
    return { w, file: a.absolutePath, sha256: a.sha256 };
  };
  const playerState = async () => (await inspect(ctx.conversationId)).state;

  await test('WSH-040', '"Create a five-second promotional slideshow from these three test images": a verified MP4 plays in the Workshop', async ({ dir, record }) => {
    const pictures = testPictures();
    const conv = await http('POST', '/v1/conversations', { mode: 'baat_kar', title: 'Video acceptance' });
    ctx.conversationId = conv.id;
    await cdp.eval(`window.desktop.openConversation(${JSON.stringify(conv.id)}, true).then(() => true)`);
    await sleep(800);
    const r = await governed(conv.id, 'create_video', { images: pictures, totalSeconds: 5, title: 'Kha ke dikha promo' }, record);
    record.facts.output = outputOf(r);
    if (r.toolInvocation?.status !== 'succeeded') throw new Error(outputOf(r));
    await waitFor(() => cdp.eval(`(() => { const v = document.querySelector('.ws-video video'); return v && v.readyState >= 1 ? true : null; })()`), 20_000, 'the video player');
    const state = await playerState();
    const { file, sha256 } = await latestFile();
    const probed = ffprobe(file);
    record.facts.player = state; record.facts.ffprobe = probed; record.facts.sha256 = sha256;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'slideshow.png')));
    if (probed.width !== 1920 || probed.height !== 1080 || probed.codec !== 'h264' || Math.abs(probed.duration - 5) > 0.15) throw new Error(`ffprobe: ${JSON.stringify(probed)}`);
    if (state?.videoWidth !== 1920 || state?.videoHeight !== 1080 || Math.abs(Number(state?.durationSeconds) - 5) > 0.15) throw new Error(`player: ${JSON.stringify(state)}`);
    return { observation: `${outputOf(r).split('\n')[0].slice(0, 140)}; FFprobe (run by this test on the saved file): ${probed.width}×${probed.height} ${probed.codec}, ${probed.duration} s; the window's player reports ${state.videoWidth}×${state.videoHeight}, ${state.durationSeconds} s.` };
  });

  await test('WSH-041', '"Play it", "pause": the player really advances, then holds', async ({ dir, record }) => {
    const play = await dispatch(ctx.conversationId, 'workshop_view', { action: 'play' });
    await sleep(800);
    const pause = await dispatch(ctx.conversationId, 'workshop_view', { action: 'pause' });
    const at1 = (await playerState())?.currentTimeSeconds;
    await sleep(800);
    const at2 = (await playerState())?.currentTimeSeconds;
    record.facts = { play: outputOf(play), pause: outputOf(pause), at1, at2 };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'paused.png')));
    if (!/^DONE/.test(outputOf(play)) || !/^DONE/.test(outputOf(pause)) || !(at1 > 0) || at1 !== at2) throw new Error(JSON.stringify(record.facts));
    return { observation: `${outputOf(play).slice(0, 110)}; paused and held at ${at2} s.` };
  });

  await test('WSH-042', '"Make it vertical": v2 rendered again from the same pictures at 1080×1920, same length', async ({ dir, record }) => {
    const before = await latestFile();
    const r = await governed(ctx.conversationId, 'workshop_edit', { aspect: 'vertical', summary: 'Make it vertical' }, record);
    record.facts.output = outputOf(r);
    if (r.toolInvocation?.status !== 'succeeded') throw new Error(outputOf(r));
    await waitFor(async () => /v2 of 2/.test(await cdp.eval(`document.querySelector('#ws-version')?.selectedOptions?.[0]?.textContent ?? ''`)), 20_000, 'version 2 on screen');
    await waitFor(async () => (await playerState())?.videoHeight === 1920, 15_000, 'the vertical video in the player');
    await waitFor(() => cdp.eval(`!document.querySelector('.ws-panel > .ws-progress')`), 5_000, 'the finished render\'s progress line to clear');
    const state = await playerState();
    const after = await latestFile();
    const probed = ffprobe(after.file);
    const v1Again = ffprobe(before.file);
    record.facts.player = state; record.facts.ffprobe = probed; record.facts.v1Unchanged = v1Again;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'vertical.png')));
    if (probed.width !== 1080 || probed.height !== 1920 || Math.abs(probed.duration - 5) > 0.15) throw new Error(`ffprobe: ${JSON.stringify(probed)}`);
    if (v1Again.width !== 1920) throw new Error('version 1 changed');
    return { observation: `${outputOf(r).split('\n')[0].slice(0, 150)}; FFprobe: v2 ${probed.width}×${probed.height}, ${probed.duration} s; v1 still ${v1Again.width}×${v1Again.height}; player ${state.videoWidth}×${state.videoHeight}.` };
  });

  await test('WSH-043', 'Compare v1 with v2: both videos side by side', async ({ dir, record }) => {
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'compare', version: '1', compareWith: '2' });
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-compare video').length === 2`), 10_000, 'two players in the comparison');
    await waitFor(() => cdp.eval(`[...document.querySelectorAll('.ws-compare video')].every((v) => v.readyState >= 1)`), 10_000, 'both videos loaded');
    const sizes = await cdp.eval(`[...document.querySelectorAll('.ws-compare video')].map((v) => v.videoWidth + '×' + v.videoHeight)`);
    const captions = await cdp.eval(`[...document.querySelectorAll('.ws-compare figcaption')].map((f) => f.textContent)`);
    record.facts = { output: outputOf(r), sizes, captions };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'compare.png')));
    await cdp.eval(`([...document.querySelectorAll('.ws-compare button')].find((b) => /Done comparing/.test(b.textContent))?.click(), true)`);
    if (!/^DONE/.test(outputOf(r)) || sizes[0] !== '1920×1080' || sizes[1] !== '1080×1920') throw new Error(JSON.stringify(record.facts));
    return { observation: `Side by side: ${captions.join(' | ')} (players measure ${sizes.join(' and ')}).` };
  });

  await test('WSH-044', 'The viewer\'s own "Square 1:1" button renders v3 through Core (the person\'s click is the decision)', async ({ dir, record }) => {
    await cdp.eval(`([...document.querySelectorAll('.ws-video .ws-toolbar button')].find((b) => /Square/.test(b.textContent))?.click(), true)`);
    await waitFor(async () => /v3 of 3/.test(await cdp.eval(`document.querySelector('#ws-version')?.selectedOptions?.[0]?.textContent ?? ''`)), 30_000, 'version 3 on screen');
    await waitFor(async () => (await playerState())?.videoHeight === 1080 && (await playerState())?.videoWidth === 1080, 15_000, 'the square video');
    const after = await latestFile();
    const probed = ffprobe(after.file);
    const summary = after.w.versions[after.w.versions.length - 1].meta.op.summary;
    record.facts = { ffprobe: probed, summary };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'square.png')));
    if (probed.width !== 1080 || probed.height !== 1080 || Math.abs(probed.duration - 5) > 0.15) throw new Error(JSON.stringify(probed));
    return { observation: `"${summary}"; FFprobe: ${probed.width}×${probed.height}, ${probed.duration} s.` };
  });
}

// ------------------------------------------------------------------------------------------ scenario: Image versions
/**
 * A STAND-IN for the Image Studio on its own loopback port (the isolated instance is started with --studio-url): it
 * answers the Studio's two calls with real PNG files made by FFmpeg — a flat "promo" card, and for a change, the
 * referenced file made darker. It is not a generative model; it exercises Pandesh's own path (approval, the
 * reference on screen, versions, lineage, comparison) without the GPU, which the 700 micro-test run is using.
 */
function standInStudio(root, port) {
  const out = path.join(root, 'output');
  fs.mkdirSync(out, { recursive: true });
  let n = 0;
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/api/status') return reply(200, { comfyui: true, ollama: true, standIn: 'ffmpeg' });
      if (req.url !== '/api/generate' || req.method !== 'POST') return reply(404, { status: 'failed', message: 'not available in the stand-in' });
      const b = JSON.parse(body || '{}');
      calls.push({ image_ref: b.image_ref ?? null, denoise: b.denoise ?? null, width: b.width, height: b.height, prompt: String(b.prompt ?? '').slice(0, 120) });
      n += 1;
      const name = `standin-${Date.now()}-${n}.png`;
      const target = path.join(out, name);
      const w = Number(b.width) || 1024; const h = Number(b.height) || 1024;
      const r = b.image_ref
        ? spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(out, path.basename(String(b.image_ref))), '-vf', 'eq=brightness=-0.22', '-frames:v', '1', target])
        : spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0xF5B041:s=${w}x${h}`, '-vf', `drawbox=x=${Math.round(w * 0.2)}:y=${Math.round(h * 0.3)}:w=${Math.round(w * 0.6)}:h=${Math.round(h * 0.45)}:color=0xC0392B:t=fill,drawbox=x=${Math.round(w * 0.3)}:y=${Math.round(h * 0.38)}:w=${Math.round(w * 0.4)}:h=${Math.round(h * 0.28)}:color=0xFFF3D6:t=fill`, '-frames:v', '1', target]);
      if (r.status !== 0) return reply(200, { status: 'failed', message: `stand-in could not draw: ${String(r.stderr).slice(0, 200)}` });
      return reply(200, { status: 'completed', images: [{ path: `/images/${name}`, seed: 1234 }], used_checkpoint: 'stand-in: FFmpeg (not a generative model)' });
    });
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve({ calls, close: () => new Promise((r) => server.close(r)) })); });
}
function pngSize(file) { const b = fs.readFileSync(file); return b.readUInt32BE(0) === 0x89504e47 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null; }
function meanLuma(file) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(`${r.stdout}\n${r.stderr}`);
  return m ? Math.round(Number(m[1]) * 10) / 10 : null;
}

async function imageScenario(cdp) {
  const ctx = {};
  const studioUrl = new URL(String(args['studio-url'] ?? 'http://127.0.0.1:18989'));
  const studio = await standInStudio(path.resolve(String(args['studio-root'] ?? path.join(PROFILE, '..', 'studio-stand-in'))), Number(studioUrl.port));
  const imageWorkshop = async () => (await http('GET', `/v1/workshops?conversationId=${ctx.conversationId}`)).workshops.find((w) => w.type === 'image');
  const fileOf = async (id) => (await http('GET', `/v1/artifacts/${id}`)).absolutePath;
  try {
    await test('WSH-050', '"Create a square Kha ke dikha biryani promotional image": a real 1024×1024 picture opens in the Workshop (stand-in Studio)', async ({ dir, record }) => {
      const conv = await http('POST', '/v1/conversations', { mode: 'baat_kar', title: 'Image acceptance' });
      ctx.conversationId = conv.id;
      await cdp.eval(`window.desktop.openConversation(${JSON.stringify(conv.id)}, true).then(() => true)`);
      await sleep(800);
      const r = await governed(conv.id, 'image_generate', { prompt: 'Square promotional image for Kha ke dikha biryani: a plate of biryani on a warm background', checkpoint: 'stand-in', width: 1024, height: 1024 }, record);
      record.facts.output = outputOf(r);
      if (r.toolInvocation?.status !== 'succeeded') throw new Error(outputOf(r));
      const w = await imageWorkshop();
      ctx.workshopId = w.workshopId; ctx.v1 = w.latestArtifactId;
      const open = await dispatch(conv.id, 'workshop_view', { action: 'open', workshop: w.workshopId });
      await waitFor(() => cdp.eval(`(() => { const i = document.querySelector('.ws-image img'); return i && i.complete && i.naturalWidth > 0 ? true : null; })()`), 15_000, 'the picture in the Workshop');
      const shown = await cdp.eval(`(() => { const i = document.querySelector('.ws-image img'); return { w: i.naturalWidth, h: i.naturalHeight }; })()`);
      const size = pngSize(await fileOf(ctx.v1));
      record.facts.open = outputOf(open); record.facts.shown = shown; record.facts.fileHeader = size; record.facts.meta = w.versions[0].meta; record.facts.studioCalls = [...studio.calls];
      record.screenshots.push(await cdp.screenshot(path.join(dir, 'v1.png')));
      if (!/^DONE/.test(outputOf(open)) || size?.width !== 1024 || size?.height !== 1024 || shown.w !== 1024) throw new Error(JSON.stringify({ open: outputOf(open).slice(0, 120), size, shown }));
      if (studio.calls[0]?.image_ref) throw new Error('a new picture was sent a reference');
      return { status: 'PASS', observation: `v1: a ${size.width}×${size.height} PNG (file header), shown at ${shown.w}×${shown.h}; op "${w.versions[0].meta.op.kind}", "${w.versions[0].meta.verification?.checks[0]}". Drawn by the FFmpeg stand-in, not a generative model.` };
    });

    await test('WSH-051', '"Make the background darker": the approval names the picture on screen; v2 is the next version of the same workshop', async ({ dir, record }) => {
      const r = await governed(ctx.conversationId, 'image_generate', { prompt: 'Square promotional image for Kha ke dikha biryani, with a darker background', checkpoint: 'stand-in', width: 1024, height: 1024, denoise: 0.45 }, record);
      record.facts.output = outputOf(r);
      if (r.toolInvocation?.status !== 'succeeded') throw new Error(outputOf(r));
      const w = await imageWorkshop();
      const v2 = w.versions[w.versions.length - 1];
      await dispatch(ctx.conversationId, 'workshop_view', { action: 'open', workshop: w.workshopId });
      await waitFor(async () => /v2 of 2/.test(await cdp.eval(`document.querySelector('#ws-version')?.selectedOptions?.[0]?.textContent ?? ''`)), 15_000, 'version 2 on screen');
      const [f1, f2] = [await fileOf(ctx.v1), await fileOf(v2.artifactId)];
      const luma = { v1: meanLuma(f1), v2: meanLuma(f2) };
      const card = record.facts.image_generateApproval ?? {};
      record.facts.card = card; record.facts.luma = luma; record.facts.v2meta = v2.meta; record.facts.studioCall = studio.calls[studio.calls.length - 1];
      record.screenshots.push(await cdp.screenshot(path.join(dir, 'v2.png')));
      const problems = [];
      if (w.workshopId !== ctx.workshopId || w.versions.length !== 2) problems.push(`workshop ${w.workshopId} has ${w.versions.length} version(s)`);
      if (v2.meta.parentArtifactId !== ctx.v1 || v2.meta.op.kind !== 'refine') problems.push(`v2 parent ${v2.meta.parentArtifactId}, op ${v2.meta.op.kind}`);
      if (card.referenceArtifactId !== ctx.v1 || !/the picture open in the Workshop/.test(String(card.changes ?? ''))) problems.push(`approval card: ${JSON.stringify(card).slice(0, 200)}`);
      if (!studio.calls[studio.calls.length - 1]?.image_ref) problems.push('the Studio was not given the reference');
      if (!(luma.v2 < luma.v1)) problems.push(`mean luminance ${luma.v1} → ${luma.v2}`);
      if (problems.length) throw new Error(problems.join('; '));
      return { observation: `Approval card: changes "${card.changes}"; v2 parent = v1, op refine, note "${v2.meta.notes?.[0]?.slice(0, 90)}…"; mean luminance ${luma.v1} → ${luma.v2} (measured with FFmpeg signalstats).` };
    });

    await test('WSH-052', '"Show me the original beside the new one": two real pictures side by side', async ({ dir, record }) => {
      const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'compare', version: '1', compareWith: '2' });
      await waitFor(() => cdp.eval(`[...document.querySelectorAll('.ws-compare .ws-side-by-side img')].filter((i) => i.complete && i.naturalWidth > 0).length === 2`), 10_000, 'two pictures side by side');
      const figures = await cdp.eval(`[...document.querySelectorAll('.ws-compare figure')].map((f) => ({ caption: f.querySelector('figcaption')?.textContent ?? '', w: f.querySelector('img')?.naturalWidth, src: (f.querySelector('img')?.src ?? '').length }))`);
      record.facts = { output: outputOf(r), figures };
      record.screenshots.push(await cdp.screenshot(path.join(dir, 'side-by-side.png')));
      if (!/^DONE/.test(outputOf(r)) || figures.length !== 2 || figures.some((f) => f.w !== 1024)) throw new Error(JSON.stringify(record.facts));
      return { observation: `${outputOf(r).slice(0, 100)}; ${figures.map((f) => f.caption.slice(0, 60)).join(' | ')}.` };
    });
  } finally {
    await studio.close();
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (args.reopen) return reopen(String(args.reopen));
  if (args.scenario === 'image') {
    const cdp = await Cdp.attach();
    await cdp.send('Page.bringToFront').catch(() => undefined);
    await imageScenario(cdp);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    cdp.ws.close();
    const failed = Object.values(results).filter((r) => r.status !== 'PASS');
    console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
  if (args.scenario === 'video') {
    const cdp = await Cdp.attach();
    await cdp.send('Page.bringToFront').catch(() => undefined);
    await videoScenario(cdp);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    cdp.ws.close();
    const failed = Object.values(results).filter((r) => r.status !== 'PASS');
    console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
  if (args.scenario === 'design') {
    const cdp = await Cdp.attach();
    await cdp.send('Page.bringToFront').catch(() => undefined);
    await designScenario(cdp);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    cdp.ws.close();
    const failed = Object.values(results).filter((r) => r.status !== 'PASS');
    console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
  if (args.scenario === 'simulation') {
    const cdp = await Cdp.attach();
    await simulationScenario(cdp);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    cdp.ws.close();
    const failed = Object.values(results).filter((r) => r.status !== 'PASS');
    console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`);
    process.exit(failed.length ? 1 : 0);
  }
  const cdp = await Cdp.attach();
  await cdp.send('Page.bringToFront').catch(() => undefined);
  // The model this profile uses when a test does reach it: the production default, never a larger one.
  if (args.model) await cdp.eval(`window.desktop.selectModel(${JSON.stringify(String(args.model))}).then(() => true)`);
  const ctx = {};

  await test('WSH-001', 'Build a simple mechanical gear assembly: a real Babylon.js scene opens in the Workshop after the approval', async ({ dir, record }) => {
    const conv = await http('POST', '/v1/conversations', { mode: 'baat_kar', title: 'Workshop acceptance' });
    ctx.conversationId = conv.id;
    await cdp.eval(`window.desktop.openConversation(${JSON.stringify(conv.id)}, true).then(() => true)`);
    await sleep(800);
    const first = await dispatch(conv.id, 'build_3d_model', GEARS);
    record.facts.firstOutcome = first.outcome;
    if (first.outcome !== 'approval_required') throw new Error(`expected an approval first (Ask mode), got ${first.outcome}`);
    record.facts.approvalArguments = first.approval?.summary?.arguments;
    // The person's decision: the same Core route the window's approve button calls (an out-of-band dispatch is not a
    // chat turn, so it has no card in the transcript; the chat card itself is exercised by the language-model runs).
    record.screenshots.push(await cdp.screenshot(path.join(dir, '1-approval-pending.png')));
    const resolved = await http('POST', `/v1/assistant/approvals/${first.approval.id}/resolve`, { resolution: 'approved' });
    const clicked = `approved via /v1/assistant/approvals (${resolved.status})`;
    record.facts.approvedWith = clicked;
    await sleep(800);
    const second = await dispatch(conv.id, 'build_3d_model', GEARS);
    record.facts.secondOutcome = second.outcome;
    record.facts.toolOutput = outputOf(second);
    if (second.outcome !== 'executed' || second.toolInvocation?.status !== 'succeeded') throw new Error(`create did not run: ${outputOf(second)}`);
    await waitFor(() => cdp.eval(`Boolean(document.querySelector('.ws-panel canvas.ws3d-canvas')) && !document.querySelector('.ws-loading')`), 30_000, 'the 3D viewer');
    await sleep(2500);
    // The stored positions, from Core's own version file (to check the exploded and assembled views against).
    const w = (await http('GET', `/v1/workshops?conversationId=${conv.id}`)).workshops[0];
    const file = (await http('GET', `/v1/artifacts/${w.latestArtifactId}`)).absolutePath;
    ctx.stored = Object.fromEntries(JSON.parse(fs.readFileSync(file, 'utf8')).components.map((c) => [c.id, c.position]));
    const { state } = await inspect(conv.id);
    record.facts.inspection = state;
    record.screenshots.push(await cdp.screenshot(path.join(dir, '2-scene.png')));
    if (!state || state.meshCount !== GEARS.components.length) throw new Error(`renderer reports ${state?.meshCount} meshes, expected ${GEARS.components.length}`);
    const tris = state.meshes.reduce((t, m) => t + m.triangles, 0);
    if (tris < 500) throw new Error(`only ${tris} triangles rendered`);
    return { observation: `Approval card answered in the window (${clicked.trim()}); tool ran; Babylon.js reports ${state.meshCount} meshes / ${tris} triangles, WebGL ${state.webgl}, ${state.fps} fps; ${state.environment}.` };
  });

  await test('WSH-002', 'The camera rotates: a mouse drag orbits it, and "rotate" turns the turntable on', async ({ dir, record }) => {
    const box = await cdp.eval(`(() => { const r = document.querySelector('.ws3d-canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const before = (await inspect(ctx.conversationId)).state.camera;
    await cdp.drag(box.x + box.w * 0.35, box.y + box.h * 0.5, box.x + box.w * 0.65, box.y + box.h * 0.45);
    await sleep(600);
    const afterDrag = (await inspect(ctx.conversationId)).state.camera;
    record.facts.cameraBefore = before; record.facts.cameraAfterDrag = afterDrag;
    if (Math.abs(afterDrag.alpha - before.alpha) < 0.05) throw new Error('a mouse drag did not orbit the camera');
    const view = await dispatch(ctx.conversationId, 'workshop_view', { action: 'rotate' });
    record.facts.rotateOutput = outputOf(view);
    if (!/^DONE/.test(outputOf(view))) throw new Error(outputOf(view));
    const a1 = (await inspect(ctx.conversationId)).state.camera.alpha;
    await sleep(1200);
    const a2 = (await inspect(ctx.conversationId)).state.camera.alpha;
    record.facts.turntable = [a1, a2];
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'rotated.png')));
    await dispatch(ctx.conversationId, 'workshop_view', { action: 'stop_rotation' });
    if (!(a2 > a1)) throw new Error('turntable did not turn');
    return { observation: `Drag moved alpha ${before.alpha} → ${afterDrag.alpha}; turntable ${a1} → ${a2} in 1.2 s; window confirmed "rotate".` };
  });

  await test('WSH-003', 'Components can be selected (scene hierarchy and picking on the canvas)', async ({ dir, record }) => {
    await cdp.eval(`[...document.querySelectorAll('.ws-tree-name')].find((b) => b.textContent.includes('Driven gear')).click(), true`);
    await sleep(400);
    const viaTree = (await inspect(ctx.conversationId)).state.selected;
    const inspector = await cdp.eval(`document.querySelector('.ws-inspector strong')?.textContent ?? null`);
    record.facts.selectedViaTree = viaTree; record.facts.inspector = inspector;
    if (viaTree !== 'gear_b' || inspector !== 'Driven gear') throw new Error(`tree selection gave ${viaTree} / ${inspector}`);
    await dispatch(ctx.conversationId, 'workshop_view', { action: 'camera', value: 'top' });
    await sleep(900);
    const box = await cdp.eval(`(() => { const r = document.querySelector('.ws3d-canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    await cdp.click(box.x + box.w / 2, box.y + box.h / 2);
    await sleep(500);
    const picked = (await inspect(ctx.conversationId)).state.selected;
    record.facts.pickedOnCanvas = picked;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'selected.png')));
    if (!picked) throw new Error('clicking the model on the canvas selected nothing');
    return { observation: `Hierarchy click selected gear_b ("Driven gear" in the inspector); a click at the canvas centre picked "${picked}".` };
  });

  await test('WSH-004', 'Pull it apart: the exploded view moves the components apart', async ({ dir, record }) => {
    await dispatch(ctx.conversationId, 'workshop_view', { action: 'camera', value: 'iso' });
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'explode' });
    record.facts.output = outputOf(r);
    if (!/^DONE/.test(outputOf(r))) throw new Error(outputOf(r));
    const state = (await inspect(ctx.conversationId)).state;
    const moved = state.meshes.filter((m) => { const c = ctx.stored?.[m.id]; return c && m.position.some((p, i) => Math.abs(p - c[i]) > 1); });
    record.facts.exploded = state.exploded; record.facts.meshes = state.meshes.map((m) => ({ id: m.id, position: m.position }));
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'exploded.png')));
    if (state.exploded !== 1) throw new Error(`exploded factor ${state.exploded}`);
    return { observation: `Window confirmed; renderer reports exploded=1 and ${state.meshCount} meshes at new positions (${moved.length} compared with stored positions).` };
  });

  await test('WSH-005', 'Put it back together: every component returns exactly to its stored position', async ({ dir, record }) => {
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'assemble' });
    record.facts.output = outputOf(r);
    if (!/^DONE/.test(outputOf(r))) throw new Error(outputOf(r));
    const w = (await http('GET', `/v1/workshops?conversationId=${ctx.conversationId}`)).workshops[0];
    ctx.workshop = w;
    const state = (await inspect(ctx.conversationId)).state;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'assembled.png')));
    if (state.exploded !== 0) throw new Error(`exploded factor ${state.exploded}`);
    return { observation: `${outputOf(r).slice(0, 200)} (the viewer refuses to report done if any part drifted).` };
  });

  await test('WSH-006', 'A material change affects only the requested component (Workshop controls, saved as a new version)', async ({ dir, record }) => {
    const before = (await inspect(ctx.conversationId)).state.meshes;
    await cdp.eval(`[...document.querySelectorAll('.ws-tree-name')].find((b) => b.textContent.includes('Outer case')).click(), true`);
    await sleep(400);
    await cdp.eval(`(() => { const s = document.querySelector('.ws-material select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(s, 'brushed_steel'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(200);
    await cdp.eval(`[...document.querySelectorAll('.ws-material button')].find((b) => /Apply/.test(b.textContent)).click(), true`);
    await waitFor(() => cdp.eval(`/v2 of 2/.test(document.querySelector('#ws-version')?.selectedOptions?.[0]?.textContent ?? '')`), 15_000, 'version 2');
    await sleep(800);
    const after = (await inspect(ctx.conversationId)).state.meshes;
    const changed = after.filter((m) => { const b = before.find((x) => x.id === m.id); return JSON.stringify(b?.material) !== JSON.stringify(m.material); });
    record.facts.changed = changed;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'brushed-steel.png')));
    if (changed.length !== 1 || changed[0].id !== 'case') throw new Error(`materials changed on ${changed.map((m) => m.id).join(', ') || 'nothing'}`);
    if (changed[0].material.metallic !== 1) throw new Error(`case metallic ${changed[0].material.metallic}`);
    const w = (await http('GET', `/v1/workshops/${ctx.workshop.workshopId}`)).workshop;
    record.facts.versions = w.versions.map((v) => ({ n: v.number, op: v.meta.op }));
    return { observation: `Only "case" changed in the renderer (metallic ${changed[0].material.metallic}, roughness ${changed[0].material.roughness}, albedo ${changed[0].material.albedo}); Core holds v1 and v2 ("${w.versions[1].meta.op.summary}").` };
  });

  await test('WSH-007', 'Export GLB: built by Babylon.js, verified by Core before it is called exported', async ({ dir, record }) => {
    await cdp.eval(`[...document.querySelectorAll('.ws-toolbar button')].find((b) => b.textContent === 'Export GLB').click(), true`);
    const w = await waitFor(async () => { const x = (await http('GET', `/v1/workshops/${ctx.workshop.workshopId}`)).workshop; return x.exports.length ? x : null; }, 30_000, 'a verified export');
    const ex = w.exports[w.exports.length - 1];
    record.facts.export = { artifactId: ex.artifactId, bytes: ex.byteSize, checks: ex.meta.verification?.checks, exportOf: ex.meta.exportOf };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'exported.png')));
    if (!ex.meta.verification?.ok) throw new Error('export not verified');
    return { observation: `GLB ${Math.round(ex.byteSize / 1024)} KB; Core checks: ${ex.meta.verification.checks.join(' | ')}` };
  });

  await test('WSH-008', 'Compare versions and show the previous one', async ({ dir, record }) => {
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'compare', version: '1', compareWith: '2' });
    record.facts.output = outputOf(r);
    await sleep(800);
    const text = await cdp.eval(`document.querySelector('.ws-compare')?.textContent ?? ''`);
    record.facts.compareText = text;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'compare.png')));
    if (!/Outer case/.test(text) || !/material/.test(text)) throw new Error(`compare shows: ${text.slice(0, 200)}`);
    await cdp.eval(`[...document.querySelectorAll('.ws-compare button')].find((b) => /Done/.test(b.textContent))?.click(), true`);
    return { observation: `Window confirmed; compare panel: ${text.replace(/\s+/g, ' ').slice(0, 160)}` };
  });

  await test('WSH-009', 'Full-window Workshop keeps the message box (chatting continues)', async ({ dir, record }) => {
    const r = await dispatch(ctx.conversationId, 'workshop_view', { action: 'fullscreen' });
    record.facts.output = outputOf(r);
    await sleep(600);
    const dom = await cdp.eval(`({ mode: document.querySelector('.ws-panel')?.getAttribute('data-mode'), composer: Boolean(document.querySelector('#v2-ask')) })`);
    record.facts.dom = dom;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'full-window.png')));
    await dispatch(ctx.conversationId, 'workshop_view', { action: 'exit_fullscreen' });
    if (!/^DONE/.test(outputOf(r)) || dom.mode !== 'full' || !dom.composer) throw new Error(JSON.stringify(dom));
    return { observation: 'Window confirmed full-window mode; the message box stayed on screen.' };
  });

  await test('WSH-010', '"It" is never guessed: with two workshops and none on screen, an edit asks which one', async ({ record }) => {
    const created = await dispatch(ctx.conversationId, 'build_3d_model', { ...GEARS, title: 'Second assembly' });
    record.facts.secondCreate = created.outcome;
    await cdp.eval(`document.querySelector('.ws-panel button[aria-label="Close the Workshop"]')?.click(), true`);
    await sleep(700);
    const edit = await dispatch(ctx.conversationId, 'workshop_status', {});
    record.facts.status = outputOf(edit);
    if (!/panel is closed/.test(outputOf(edit))) throw new Error('Core still thinks a workshop is on screen');
    return { status: created.outcome === 'approval_required' ? 'PASS' : 'PARTIAL', observation: `Closing the panel told Core nothing is on screen ("${outputOf(edit).split('\n').find((l) => /panel|Open in/.test(l))}"); a second create asked for approval again (${created.outcome}). Ambiguity refusal is covered by core/test/workshopCapability.test.ts.` };
  });

  if (ctx.conversationId && ctx.workshop) {
    // Leave the Workshop open, as a person would before quitting, so the restart check sees what they left.
    await cdp.eval(`(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => /^Workshop/.test(x.textContent || '') && x.getAttribute('aria-pressed') !== 'true'); b?.click(); return Boolean(b); })()`);
    await sleep(1500);
    const latest = (await http('GET', `/v1/workshops/${ctx.workshop.workshopId}`)).workshop;
    fs.writeFileSync(path.join(OUT, 'reopen-context.json'), JSON.stringify({ conversationId: ctx.conversationId, workshopId: latest.workshopId, artifactId: latest.latestArtifactId, versions: latest.versions.length }, null, 2));
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  cdp.ws.close();
  const failed = Object.values(results).filter((r) => r.status !== 'PASS');
  console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
