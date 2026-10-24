/**
 * Capture the real, running app window (no emulation) so what a person sees is
 * what is verified.
 *
 *   node apps/desktop/scripts/capture-live-window.mjs [outDir] [cdpPort]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist', 'panda-workspace-refined'));
const cdpPort = Number(process.argv[3] || process.env.KARKEDIKHA_DESKTOP_CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectCdp(port) {
  const deadline = Date.now() + 30000;
  let page;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && /renderer\/index\.html/.test(p.url ?? ''));
      if (page) break;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  if (!page) throw new Error('the renderer never appeared');
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
  return { cdp, ws };
}

const MEASURE = `(() => {
  const b = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
    app: b('.app'), greeting: b('.assistant-greeting'), composer: b('.composer-capsule-wrap'),
    result: b('#result'), main: b('#assistant-main'), cards: b('#conversation-cards'),
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    error: (document.getElementById('operation-error')?.textContent || '').trim() };
})()`;

try {
  const { cdp, ws } = await connectCdp(cdpPort);
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await sleep(1200);
  fs.mkdirSync(outDir, { recursive: true });
  const evaluate = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  };
  const shot = async (name) => {
    const res = await cdp('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    console.log('saved', file);
  };

  console.log('home:', JSON.stringify(await evaluate(MEASURE)));
  // The conversation surface, with the history rail closed.
  await evaluate(`(() => { document.getElementById('nav-assistant-btn')?.click(); return true; })()`);
  await sleep(1200);
  await evaluate(`(() => { const t = document.getElementById('btn-toggle-history');
    const layout = document.getElementById('assistant-layout');
    if (layout?.dataset.history === 'open') t?.click(); return true; })()`);
  await sleep(900);
  console.log('home (rail closed):', JSON.stringify(await evaluate(MEASURE)));
  await shot('live-01-home.png');

  // The Tasks screen, from the top.
  await evaluate(`(() => { document.getElementById('nav-tasks-btn')?.click(); return true; })()`);
  await sleep(2500);
  await evaluate(`(() => { const c = document.querySelector('.tasks-container'); if (c) c.scrollTop = 0; return true; })()`);
  await sleep(600);
  const tasks = await evaluate(`(() => ({
    title: document.getElementById('active-tasks-title')?.textContent ?? '',
    note: document.getElementById('active-tasks-note')?.textContent ?? '',
    rows: [...document.querySelectorAll('#active-tasks-list .dev-story')].map((li) => ({
      live: li.dataset.live, status: li.dataset.status, phase: li.dataset.phase,
      head: li.querySelector('.dev-story-head')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    })),
  }))()`);
  console.log('tasks:', JSON.stringify(tasks, null, 2));
  await shot('live-02-tasks.png');

  // Back to the conversation.
  await evaluate(`(() => { document.getElementById('nav-assistant-btn')?.click(); return true; })()`);
  await sleep(1500);
  await shot('live-03-conversation.png');
  ws.close();
  process.exit(0);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}
