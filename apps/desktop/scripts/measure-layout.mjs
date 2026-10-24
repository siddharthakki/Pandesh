/**
 * Measure the real app's layout at several window widths.
 *
 * Reports the horizontal overflow of every major container and the geometry of
 * the welcome area, the reading column and the composer, so a layout defect
 * (content pushed off-screen, a centred block that is not centred) is shown as
 * a number instead of a guess.
 *
 *   node apps/desktop/scripts/measure-layout.mjs
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const isolationRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'panda-layout-'));
const dataDir = path.join(isolationRoot, 'data');
const workspace = path.join(isolationRoot, 'workspace');
const fakeHome = path.join(isolationRoot, 'home');
for (const dir of [dataDir, workspace, fakeHome]) fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'electron-profile'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'last-workspace.json'),
  JSON.stringify({ folder: workspace, updatedAt: new Date().toISOString() }));

const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const cdpPort = await findFreePort();
const child = spawn(electronBin, [
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${path.join(dataDir, 'electron-profile')}`,
  desktopRoot,
], {
  cwd: repoRoot,
  stdio: 'ignore',
  detached: false,
  env: {
    ...process.env,
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
    KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath,
    KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
    KARKEDIKHA_DESKTOP_HOST_LOG: path.join(isolationRoot, 'desktop-host.log'),
    KARKEDIKHA_DESKTOP_CDP_PORT: String(cdpPort),
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
  },
});
child.on('error', (err) => console.error('electron failed to start:', err.message));

const cleanup = () => {
  try { child.kill(); } catch { /* already gone */ }
  try { fs.rmSync(isolationRoot, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);

async function connectCdp(port) {
  const deadline = Date.now() + 60000;
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
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left), right: Math.round(r.right),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      width: Math.round(r.width), height: Math.round(r.height),
      centerX: Math.round(r.left + r.width / 2),
      scrollW: el.scrollWidth, clientW: el.clientWidth,
      overflowX: el.scrollWidth - el.clientWidth,
    };
  };
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screenWidth: window.screen.width,
    doc: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth },
    body: { scrollW: document.body.scrollWidth, clientW: document.body.clientWidth },
    app: box('.app'),
    topbar: box('.topbar'),
    rail: box('.workspace-rail'),
    viewport: box('.panda-constellation-viewport'),
    layout: box('.assistant-layout'),
    main: box('#assistant-main'),
    empty: box('#assistant-empty'),
    greeting: box('.assistant-greeting'),
    hero: box('.assistant-hero-slot'),
    suggestions: box('.assistant-suggestions'),
    result: box('#result'),
    cards: box('#conversation-cards'),
    composer: box('.composer-capsule-wrap'),
    cluster: box('.apex-bottom-cluster'),
    readingWidth: getComputedStyle(document.querySelector('.app')).getPropertyValue('--ws-reading-width'),
  };
})()`;

try {
  const { cdp, ws } = await connectCdp(cdpPort);
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const deadline = Date.now() + 60000;
  for (;;) {
    const state = await cdp('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    if (state.exceptionDetails) {
      console.error('evaluate failed:', JSON.stringify(state.exceptionDetails).slice(0, 400));
      break;
    }
    if (state.result?.value?.app) break;
    if (Date.now() > deadline) { console.error('the app never rendered'); break; }
    await sleep(500);
  }
  for (const [w, h] of [[1440, 900], [1680, 1050], [1920, 1080], [2560, 1400], [1100, 900]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const res = await cdp('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const m = res.result.value;
    console.log(`\n=== emulated ${w}x${h} (dpr ${m.devicePixelRatio}) ===`);
    report(m);
  }
  // The real window, exactly as the person sees it.
  await cdp('Emulation.clearDeviceMetricsOverride');
  const target = await cdp('Target.getTargets');
  const page = target.targetInfos.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url));
  if (page) {
    try {
      const win = await cdp('Browser.getWindowForTarget', { targetId: page.targetId });
      await cdp('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'maximized' } });
      await sleep(1200);
    } catch (err) {
      console.log('could not maximize:', err.message);
    }
  }
  const real = await cdp('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
  console.log(`\n=== real window (inner ${real.result.value.innerWidth}x${real.result.value.innerHeight}, outer ${real.result.value.outerWidth}x${real.result.value.outerHeight}, dpr ${real.result.value.devicePixelRatio}, screen ${real.result.value.screenWidth}) ===`);
  report(real.result.value);
  ws.close();
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  cleanup();
  process.exit(process.exitCode ?? 0);
}

function report(m) {
  console.log('doc overflowX', m.doc.scrollW - m.doc.clientW, '| body overflowX', m.body.scrollW - m.body.clientW,
    '| --ws-reading-width', m.readingWidth);
  for (const key of ['app', 'topbar', 'rail', 'viewport', 'layout', 'main', 'empty', 'greeting', 'hero', 'suggestions', 'result', 'cards', 'composer', 'cluster']) {
    const b = m[key];
    if (!b) { console.log(`  ${key.padEnd(12)} —`); continue; }
    console.log(`  ${key.padEnd(12)} x=${String(b.left).padStart(5)}..${String(b.right).padStart(5)} w=${String(b.width).padStart(5)} centerX=${String(b.centerX).padStart(5)} y=${String(b.top).padStart(5)}..${String(b.bottom).padStart(5)} overflowX=${b.overflowX}`);
  }
}
