#!/usr/bin/env node
/**
 * Workshop acceptance in plain language, through the real chat of an ISOLATED Pandesh dev instance: messages are
 * typed into the v2 composer, approval cards are answered by clicking them, and every claim is checked against
 * Core's records and the Babylon.js scene graph the Workshop reports back (never against the model's reply alone).
 *
 *   node scripts/acceptance/workshop-nl-acceptance.mjs --profile <isolated profile> --cdp <port> --out <dir> [--model gemma4:12b]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []));
const PROFILE = path.resolve(String(args.profile ?? ''));
const CDP_PORT = Number(args.cdp ?? 0);
const OUT = path.resolve(String(args.out ?? 'workshop-nl-evidence'));
const PROD = path.join(process.env.LOCALAPPDATA ?? '', 'KarkeDikha', 'desktop').toLowerCase();
if (!args.profile || !CDP_PORT || PROFILE.toLowerCase() === PROD) { console.error('REFUSED/usage: --profile <isolated dir> --cdp <port> --out <dir>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function core() {
  const info = JSON.parse(fs.readFileSync(path.join(PROFILE, 'core.json'), 'utf8'));
  return { base: `http://127.0.0.1:${info.port}`, token: fs.readFileSync(path.join(PROFILE, 'core.token'), 'utf8').trim(), hostToken: fs.readFileSync(path.join(PROFILE, 'host.token'), 'utf8').trim() };
}
async function http(method, route, body, asModel = false) {
  const c = core();
  const headers = { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json', 'X-Client-Id': asModel ? 'model-workshop-acceptance' : 'workshop-acceptance', ...(asModel ? { 'X-Caller-Type': 'model' } : { 'X-Host-Token': c.hostToken }), ...(method !== 'GET' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) };
  const res = await fetch(`${c.base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

class Cdp {
  static async attach() {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const t = list.find((x) => x.type === 'page' && /renderer[\\/]v2[\\/]index\.html/.test(x.url));
    if (!t) throw new Error('no v2 window');
    const c = new Cdp(t.webSocketDebuggerUrl); await c.open(); return c;
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
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result?.value;
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, 20_000);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return path.basename(file);
  }
}

/** Types a message into the real composer and sends it; answers approval cards by clicking them; waits for the turn. */
async function say(cdp, text, { approve = true, timeoutMs = 240_000 } = {}) {
  const started = Date.now();
  // A model call may have moved the window to another view (navigate_to): the person would go back to the chat.
  await cdp.eval(`(() => { if (!document.getElementById('v2-ask')) document.querySelector('nav[aria-label="Main"] .rail-btn')?.click(); return true; })()`);
  await sleep(400);
  await cdp.eval(`(() => { const ta = document.getElementById('v2-ask'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(150);
  await cdp.eval(`document.querySelector('button[aria-label="Send"]').click(), true`);
  const approvals = [];
  let sawRunning = false;
  while (Date.now() - started < timeoutMs) {
    await sleep(700);
    const s = await cdp.eval(`window.desktop.getSnapshot().then((s) => ({ running: s.running, awaiting: s.awaitingApproval, card: s.pendingApproval ? { toolName: s.pendingApproval.toolName, scope: s.pendingApproval.scope, detail: s.pendingApproval.detail } : null }))`);
    if (s.running) sawRunning = true;
    if (s.card) {
      // The card lives in the chat; a model call may have moved the window elsewhere (navigate_to).
      await cdp.eval(`(() => { if (!document.querySelector('section.approval')) document.querySelector('nav[aria-label="Main"] .rail-btn')?.click(); return true; })()`);
      await sleep(300);
      const button = await cdp.eval(`(() => { const b = document.querySelector('section.approval .actions .btn.primary'); return b ? b.textContent : null; })()`);
      if (button) {
        approvals.push({ ...s.card, button, decided: approve ? 'approved' : 'declined' });
        await cdp.eval(`document.querySelector(${JSON.stringify(approve ? 'section.approval .actions .btn.primary' : 'section.approval .actions .btn:not(.primary)')}).click(), true`);
        await sleep(500);
        continue;
      }
    }
    if (sawRunning && !s.running && !s.awaiting) break;
    if (!sawRunning && Date.now() - started > 8_000 && !s.running) break;
  }
  await sleep(1200);
  const conversationId = await cdp.eval(`window.desktop.getSnapshot().then((s) => s.selectedConversationId)`);
  const opened = await cdp.eval(`window.desktop.openConversation(${JSON.stringify(conversationId)}, false).then((o) => o.messages.filter((m) => m.role === 'assistant').map((m) => m.content))`);
  return { conversationId, reply: (opened ?? []).slice(-1)[0] ?? '', approvals, ms: Date.now() - started };
}

async function toolsSince(conversationId, sinceIso) {
  // The real tool calls Core recorded for this conversation (its workshop anchor and the chat attempts).
  const events = (await http('GET', '/v1/runtime-events?after=0&limit=200')).events ?? [];
  void conversationId;
  return events.filter((e) => e.domain === 'tool_invocation' && e.createdAt >= sinceIso && e.eventType === 'tool_invocation_started').map((e) => e.metadata?.toolName).filter(Boolean);
}

async function inspect(conversationId) {
  const r = await http('POST', '/v1/capabilities/dispatch', { correlationId: conversationId, toolName: 'workshop_status', arguments: { inspect: true }, cwd: PROFILE }, true);
  const text = String(r.toolInvocation?.evidence?.output ?? '');
  const m = /Live inspection from the window's renderer: (\{[\s\S]*\})/.exec(text);
  return m ? JSON.parse(m[1]) : null;
}

const results = {};
async function step(id, title, fn) {
  const dir = path.join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });
  const record = { id, title, startedAt: new Date().toISOString(), screenshots: [], facts: {} };
  process.stdout.write(`${id} ${title} … `);
  const t0 = Date.now();
  try { const out = await fn({ dir, record }); record.status = out.status ?? 'PASS'; record.observation = out.observation; }
  catch (err) { record.status = 'FAIL'; record.observation = String(err?.message ?? err); }
  record.latencyMs = Date.now() - t0;
  fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(record, null, 2));
  results[id] = record;
  console.log(`${record.status} (${(record.latencyMs / 1000).toFixed(1)} s) ${String(record.observation).slice(0, 220)}`);
}

/** Simulation, Design and Video in plain language, each in a fresh chat, with the real local model choosing the tools. */
async function moreScenarios(cdp) {
  const fresh = async () => { await cdp.eval(`window.desktop.newConversation().then(() => true)`); await sleep(800); };
  const workshopsOf = async (conversationId) => (await http('GET', `/v1/workshops?conversationId=${conversationId}`)).workshops;
  const fileOf = async (id) => (await http('GET', `/v1/artifacts/${id}`)).absolutePath;
  const ctx = {};

  await fresh();
  await step('WSH-110', '"Simulate a food stall with one serving counter, customers arriving every two minutes, service taking three minutes."', async ({ dir, record }) => {
    const since = new Date().toISOString();
    const r = await say(cdp, 'Simulate a food stall with one serving counter, customers arriving every two minutes, service taking three minutes.');
    ctx.sim = r.conversationId;
    const ws = (await workshopsOf(r.conversationId)).filter((w) => w.type === 'simulation');
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, tools: await toolsSince(r.conversationId, since), workshops: ws.map((w) => ({ title: w.title, versions: w.versions.length })) };
    await sleep(1500);
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    if (!ws.length) return { status: 'FAIL', observation: `No simulation was created. Reply: ${r.reply.slice(0, 300)}` };
    const spec = JSON.parse(fs.readFileSync(await fileOf(ws[0].latestArtifactId), 'utf8'));
    record.facts.params = spec.params;
    const lab = await cdp.eval(`Boolean(document.querySelector('.ws-sim canvas.ws-sim-canvas'))`);
    const right = spec.params.counters === 1 && spec.params.arrivalEveryMinutes === 2 && spec.params.serviceMinutes === 3;
    return right && lab
      ? { observation: `${r.approvals.length} card(s); the model set counters 1, a customer every 2 min, 3 min service; the Lab is open. Reply: ${r.reply.slice(0, 160)}` }
      : { status: 'FAIL', observation: `params ${JSON.stringify(spec.params)}; Lab open: ${lab}; reply: ${r.reply.slice(0, 160)}` };
  });

  await step('WSH-111', '"Add a second counter."', async ({ dir, record }) => {
    const before = (await workshopsOf(ctx.sim)).find((w) => w.type === 'simulation');
    const r = await say(cdp, 'Add a second counter.');
    const after = (await workshopsOf(ctx.sim)).find((w) => w.type === 'simulation');
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, versions: [before?.versions.length, after?.versions.length] };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    if (!after || after.versions.length !== (before?.versions.length ?? 0) + 1) return { status: 'FAIL', observation: `versions ${before?.versions.length} → ${after?.versions.length}; reply: ${r.reply.slice(0, 200)}` };
    const spec = JSON.parse(fs.readFileSync(await fileOf(after.latestArtifactId), 'utf8'));
    const check = after.versions[after.versions.length - 1].meta.verification?.checks?.[0] ?? '';
    return spec.params.counters === 2
      ? { observation: `v${after.versions.length}: counters 2, same seed; Core: "${check}"; reply: ${r.reply.slice(0, 140)}` }
      : { status: 'FAIL', observation: `counters ${spec.params.counters}; reply: ${r.reply.slice(0, 200)}` };
  });

  await fresh();
  await step('WSH-112', '"Create a simple local landing page with a heading and a contact button."', async ({ dir, record }) => {
    const since = new Date().toISOString();
    const r = await say(cdp, 'Create a simple local landing page with a heading and a contact button.', { timeoutMs: 360_000 });
    ctx.design = r.conversationId;
    const ws = (await workshopsOf(r.conversationId)).filter((w) => w.type === 'design');
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, tools: await toolsSince(r.conversationId, since), workshops: ws.map((w) => ({ title: w.title, versions: w.versions.length, engine: w.versions[0]?.meta.engine })) };
    if (!ws.length) { record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png'))); return { status: 'FAIL', observation: `No page was created. Reply: ${r.reply.slice(0, 300)}` }; }
    await sleep(2500);
    const state = await inspect(r.conversationId);
    record.facts.inspection = state;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    const h1 = state?.headings?.find((h) => h.tag === 'h1') ?? state?.headings?.[0];
    const contact = state?.buttons?.find((b) => /contact|call|email|message|reach/i.test(b.text));
    ctx.h1 = h1?.fontSizePx;
    return h1 && contact
      ? { observation: `Written by ${ws[0].versions[0].meta.engine.model} on this PC; the sandboxed preview reports ${h1.tag} "${h1.text}" at ${h1.fontSizePx}px and "${contact.text}" (${contact.tag}). ${(r.ms / 1000).toFixed(0)} s.` }
      : { status: 'FAIL', observation: `page made, but the preview reports heading ${JSON.stringify(h1)} and contact ${JSON.stringify(contact)}` };
  });

  await step('WSH-113', '"Make the heading larger."', async ({ dir, record }) => {
    const before = (await workshopsOf(ctx.design)).find((w) => w.type === 'design');
    const r = await say(cdp, 'Make the heading larger.', { timeoutMs: 360_000 });
    const after = (await workshopsOf(ctx.design)).find((w) => w.type === 'design');
    await sleep(2500);
    const state = await inspect(ctx.design);
    const h1 = state?.headings?.find((h) => h.tag === 'h1') ?? state?.headings?.[0];
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, versions: [before?.versions.length, after?.versions.length], op: after?.versions[after.versions.length - 1]?.meta.op, inspection: state };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    if (!after || after.versions.length !== (before?.versions.length ?? 0) + 1) return { status: 'FAIL', observation: `versions ${before?.versions.length} → ${after?.versions.length}; reply: ${r.reply.slice(0, 200)}` };
    return h1 && ctx.h1 && h1.fontSizePx > ctx.h1
      ? { observation: `v${after.versions.length}: "${after.versions[after.versions.length - 1].meta.op.summary.slice(0, 120)}"; rendered heading ${ctx.h1}px → ${h1.fontSizePx}px.` }
      : { status: 'FAIL', observation: `heading ${ctx.h1}px → ${h1?.fontSizePx}px; reply: ${r.reply.slice(0, 200)}` };
  });

  await fresh();
  const pictures = ['stall-1.png', 'stall-2.png', 'stall-3.png'].map((f) => path.join(PROFILE, '..', 'test-images', f));
  await step('WSH-114', '"Create a five-second promotional slideshow from these three test images: …"', async ({ dir, record }) => {
    const since = new Date().toISOString();
    const r = await say(cdp, `Create a five-second promotional slideshow from these three test images: ${pictures.join(', ')}`);
    ctx.video = r.conversationId;
    const ws = (await workshopsOf(r.conversationId)).filter((w) => w.type === 'video');
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, tools: await toolsSince(r.conversationId, since) };
    await sleep(1500);
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    if (!ws.length) return { status: 'FAIL', observation: `No video was made. Reply: ${r.reply.slice(0, 300)}` };
    const probe = ffprobe(await fileOf(ws[0].latestArtifactId));
    record.facts.ffprobe = probe;
    return Math.abs(probe.duration - 5) <= 0.15
      ? { observation: `FFprobe on the saved file: ${probe.width}×${probe.height} ${probe.codec}, ${probe.duration} s; ${r.approvals.length} card(s). Reply: ${r.reply.slice(0, 140)}` }
      : { status: 'FAIL', observation: `FFprobe: ${JSON.stringify(probe)}; reply: ${r.reply.slice(0, 160)}` };
  });

  await step('WSH-115', '"Make it vertical."', async ({ dir, record }) => {
    const r = await say(cdp, 'Make it vertical.');
    const w = (await workshopsOf(ctx.video)).find((x) => x.type === 'video');
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, versions: w?.versions.length };
    await sleep(1500);
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    if (!w || w.versions.length < 2) return { status: 'FAIL', observation: `versions ${w?.versions.length}; reply: ${r.reply.slice(0, 200)}` };
    const probe = ffprobe(await fileOf(w.latestArtifactId));
    record.facts.ffprobe = probe;
    return probe.width === 1080 && probe.height === 1920 && Math.abs(probe.duration - 5) <= 0.15
      ? { observation: `v${w.versions.length}: FFprobe ${probe.width}×${probe.height}, ${probe.duration} s. Reply: ${r.reply.slice(0, 140)}` }
      : { status: 'FAIL', observation: `FFprobe: ${JSON.stringify(probe)}; reply: ${r.reply.slice(0, 160)}` };
  });
}

function ffprobe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  return { width: j.streams[0].width, height: j.streams[0].height, codec: j.streams[0].codec_name, duration: Math.round(Number(j.format.duration) * 100) / 100 };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cdp = await Cdp.attach();
  if (args.model) await cdp.eval(`window.desktop.selectModel(${JSON.stringify(String(args.model))}).then(() => true)`);
  if (args.scenario === 'more') {
    await moreScenarios(cdp);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    cdp.ws.close();
    const passed = Object.values(results).filter((r) => r.status === 'PASS').length;
    console.log(`\n${passed}/${Object.keys(results).length} passed`);
    return;
  }
  await cdp.eval(`window.desktop.newConversation().then(() => true)`);
  await sleep(800);
  const ctx = {};

  await step('WSH-101', '"Build a simple mechanical gear assembly." (plain language, real model, real approval card)', async ({ dir, record }) => {
    const since = new Date().toISOString();
    const r = await say(cdp, 'Build a simple mechanical gear assembly.');
    ctx.conversationId = r.conversationId;
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, tools: await toolsSince(r.conversationId, since) };
    const ws = (await http('GET', `/v1/workshops?conversationId=${r.conversationId}`)).workshops;
    record.facts.workshops = ws.map((w) => ({ id: w.workshopId, type: w.type, title: w.title, versions: w.versions.length }));
    await sleep(2500);
    const state = await inspect(r.conversationId);
    record.facts.inspection = state;
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    if (!ws.length) return { status: 'FAIL', observation: `No workshop was created. Reply: ${r.reply.slice(0, 300)}` };
    if (!state?.meshCount) return { status: 'FAIL', observation: 'A workshop exists but the window did not report a rendered scene.' };
    ctx.workshop = ws[0];
    return { observation: `${r.approvals.length} approval card(s) clicked (${r.approvals.map((a) => a.toolName).join(', ')}); Core holds "${ws[0].title}" v${ws[0].versions.length}; Babylon.js renders ${state.meshCount} meshes (${state.meshes.map((m) => m.name).join(', ')}). ${(r.ms / 1000).toFixed(0)} s.` };
  });

  const view = (id, text, check) => step(id, `"${text}"`, async ({ dir, record }) => {
    const since = new Date().toISOString();
    const r = await say(cdp, text);
    await sleep(1500);
    const state = await inspect(ctx.conversationId);
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, tools: await toolsSince(ctx.conversationId, since), inspection: state };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    return check(state, r, record);
  });

  await view('WSH-102', 'Rotate it.', (s, r) => (s?.autoRotate ? { observation: `turntable on (renderer autoRotate=true); tools ${JSON.stringify(r.approvals.length)} cards` } : { status: 'FAIL', observation: `renderer autoRotate=${s?.autoRotate}; reply: ${r.reply.slice(0, 200)}` }));
  await view('WSH-103', 'Pull it apart.', (s, r) => (s?.exploded === 1 ? { observation: 'exploded=1 reported by the renderer' } : { status: 'FAIL', observation: `exploded=${s?.exploded}; reply: ${r.reply.slice(0, 200)}` }));
  await view('WSH-104', 'Label the components.', (s, r) => (s?.labels ? { observation: 'labels on in the renderer' } : { status: 'FAIL', observation: `labels=${s?.labels}; reply: ${r.reply.slice(0, 200)}` }));

  await step('WSH-105', 'Change one named component in plain language', async ({ dir, record }) => {
    const before = await inspect(ctx.conversationId);
    const target = before.meshes.find((m) => !/gear/i.test(m.name)) ?? before.meshes[0];
    const text = `Make the ${target.name} brushed steel.`;
    const since = new Date().toISOString();
    const r = await say(cdp, text);
    await sleep(2000);
    const after = await inspect(ctx.conversationId);
    const changed = after.meshes.filter((m) => { const b = before.meshes.find((x) => x.id === m.id); return JSON.stringify(b?.material) !== JSON.stringify(m.material); });
    record.facts = { text, reply: r.reply, approvals: r.approvals, ms: r.ms, tools: await toolsSince(ctx.conversationId, since), changed, before: before.meshes.map((m) => ({ id: m.id, material: m.material })) };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    if (changed.length === 1 && changed[0].id === target.id && changed[0].material.metallic === 1) return { observation: `"${text}" → only ${target.id} changed (metallic 1, roughness ${changed[0].material.roughness}); ${r.approvals.length} card(s).` };
    return { status: 'FAIL', observation: `changed: ${changed.map((c) => c.id).join(', ') || 'nothing'}; reply: ${r.reply.slice(0, 200)}` };
  });

  await view('WSH-106', 'Put it back together.', (s, r) => (s?.exploded === 0 ? { observation: 'exploded=0: every part back at its stored position' } : { status: 'FAIL', observation: `exploded=${s?.exploded}; reply: ${r.reply.slice(0, 200)}` }));

  await step('WSH-107', '"Export the model."', async ({ dir, record }) => {
    const since = new Date().toISOString();
    const r = await say(cdp, 'Export the model.');
    const w = (await http('GET', `/v1/workshops?conversationId=${ctx.conversationId}`)).workshops[0];
    record.facts = { reply: r.reply, approvals: r.approvals, ms: r.ms, tools: await toolsSince(ctx.conversationId, since), exports: w.exports.map((x) => ({ id: x.artifactId, bytes: x.byteSize, checks: x.meta.verification?.checks })) };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    return w.exports.length && w.exports[w.exports.length - 1].meta.verification?.ok
      ? { observation: `GLB ${Math.round(w.exports[w.exports.length - 1].byteSize / 1024)} KB verified by Core; reply: ${r.reply.slice(0, 160)}` }
      : { status: 'FAIL', observation: `no verified export; reply: ${r.reply.slice(0, 200)}` };
  });

  await step('WSH-108', '"Undo that." restores the previous version (a new version; history kept)', async ({ dir, record }) => {
    const before = (await http('GET', `/v1/workshops?conversationId=${ctx.conversationId}`)).workshops[0];
    const r = await say(cdp, 'Undo that last material change.');
    const after = (await http('GET', `/v1/workshops?conversationId=${ctx.conversationId}`)).workshops[0];
    record.facts = { reply: r.reply, approvals: r.approvals, versionsBefore: before.versions.length, versionsAfter: after.versions.length, last: after.versions[after.versions.length - 1].meta.op };
    record.screenshots.push(await cdp.screenshot(path.join(dir, 'after.png')));
    return after.versions.length === before.versions.length + 1 && after.versions[after.versions.length - 1].meta.op.kind === 'restore'
      ? { observation: `v${after.versions.length} restores v${after.versions.length - 2}; ${r.approvals.length} card(s).` }
      : { status: 'FAIL', observation: `versions ${before.versions.length} → ${after.versions.length}; reply: ${r.reply.slice(0, 200)}` };
  });

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  cdp.ws.close();
  const passed = Object.values(results).filter((r) => r.status === 'PASS').length;
  console.log(`\n${passed}/${Object.keys(results).length} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
