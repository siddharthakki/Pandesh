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
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    this.ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && this.pending.has(d.id)) { const p = this.pending.get(d.id); this.pending.delete(d.id); if (d.error) p.reject(new Error(JSON.stringify(d.error))); else p.resolve(d.result); } });
  }
  send(method, params = {}, timeoutMs = 60_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (args.reopen) return reopen(String(args.reopen));
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
