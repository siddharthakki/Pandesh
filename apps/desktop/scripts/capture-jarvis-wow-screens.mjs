/**
 * Capture packaged Desktop screenshots at 1280x800 and 1920x1080,
 * plus a short animation frame sequence and a static template reference render.
 *   node apps/desktop/scripts/capture-jarvis-wow-screens.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const portableRoot = path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const outDir = path.join(repoRoot, 'dist', 'jarvis-wow-screens');
const cdpPort = '9531';
const templateSrc = path.join(
  os.homedir(),
  '.codex',
  'attachments',
  'f8a1ca35-70fc-4831-9f38-a9461efad724',
  'pasted-text.txt',
);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function connectCdp(port, label) {
  const deadline = Date.now() + 60000;
  let page;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* wait */ }
    await sleep(400);
  }
  if (!page) throw new Error(`${label}: CDP page not ready`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.method === 'Page.screencastFrame') {
      const handler = pending.get('screencast');
      if (handler) handler(msg.params);
      return;
    }
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
  const onScreencast = (handler) => { pending.set('screencast', handler); };
  return { ws, cdp, onScreencast };
}

async function captureTemplateRefs() {
  if (!fs.existsSync(templateSrc)) {
    console.warn('template source missing; skipping template comparison shots');
    return;
  }
  let html = fs.readFileSync(templateSrc, 'utf8');
  // Localize branding for visual comparison: keep composition, drop invented version labels.
  html = html
    .replace(/MARK-VII PROTOCOL/g, '')
    .replace(/JARVIS Mark VII Tactical OS/g, 'Jarvis')
    .replace(/cdn\.tailwindcss\.com/g, 'invalid.local/tailwind')
    .replace(/unpkg\.com\/lucide@latest/g, 'invalid.local/lucide')
    .replace(/@import url\('https:\/\/fonts\.googleapis\.com[^']+'\);/g, '');
  const tmp = path.join(os.tmpdir(), `jarvis-template-ref-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const child = spawn(
    path.join(portableRoot, 'electron', 'electron.exe'),
    [`--remote-debugging-port=9532`, tmp],
    {
      cwd: portableRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    },
  );
  try {
    const { ws, cdp } = await connectCdp('9532', 'template');
    await cdp('Page.enable');
    for (const [name, width, height] of [['1280x800', 1280, 800], ['1920x1080', 1920, 1080]]) {
      await cdp('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      await sleep(400);
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, `template-ref-${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('wrote', file);
    }
    ws.close();
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const dataDir = path.join(os.tmpdir(), `jarvis-wow-screens-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(
    path.join(portableRoot, 'electron', 'electron.exe'),
    [`--remote-debugging-port=${cdpPort}`, path.join(portableRoot, 'app')],
    {
      cwd: portableRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KARKEDIKHA_DESKTOP_PRODUCT_ROOT: portableRoot,
        KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
        KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
      },
    },
  );
  const { ws, cdp, onScreencast } = await connectCdp(cdpPort, 'desktop');
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  for (const [name, width, height] of [['1280x800', 1280, 800], ['1920x1080', 1920, 1080]]) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(500);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, `jarvis-wow-${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('wrote', file);
  }

  // Short animation recording via CDP screencast frames
  const animDir = path.join(outDir, 'animation-frames');
  fs.mkdirSync(animDir, { recursive: true });
  let frame = 0;
  const maxFrames = 24;
  await new Promise(async (resolve) => {
    onScreencast(async (params) => {
      if (frame >= maxFrames) return;
      const idx = String(frame).padStart(3, '0');
      fs.writeFileSync(path.join(animDir, `frame-${idx}.png`), Buffer.from(params.data, 'base64'));
      frame += 1;
      await cdp('Page.screencastFrameAck', { sessionId: params.sessionId });
      if (frame >= maxFrames) resolve();
    });
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await cdp('Page.startScreencast', { format: 'png', everyNthFrame: 2, quality: 70 });
    await cdp('Runtime.evaluate', {
      expression: `(() => {
        const app = document.querySelector('.app');
        const states = ['idle','listening','processing','speaking','idle'];
        let i = 0;
        const timer = setInterval(() => {
          const s = states[i % states.length];
          app?.setAttribute('data-jarvis-state', s);
          const n = document.getElementById('neural-ready');
          if (n) n.textContent = s;
          i += 1;
          if (i > 8) clearInterval(timer);
        }, 180);
        true;
      })()`,
    });
    setTimeout(resolve, 5000);
  });
  try { await cdp('Page.stopScreencast'); } catch { /* ignore */ }
  console.log('wrote', animDir, `(${frame} frames)`);

  for (const state of ['idle', 'listening', 'processing', 'speaking']) {
    await cdp('Runtime.evaluate', {
      expression: `document.querySelector('.app')?.setAttribute('data-jarvis-state','${state}'); const n=document.getElementById('neural-ready'); if(n) n.textContent='${state}';`,
    });
    await sleep(200);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `jarvis-wow-state-${state}.png`), Buffer.from(shot.data, 'base64'));
  }

  // Prove version badge uses metadata only (no invented Mark VII label)
  const brandCheck = await cdp('Runtime.evaluate', {
    expression: `(() => ({
      brand: document.querySelector('.brand')?.textContent || '',
      version: document.getElementById('app-version-badge')?.textContent || '',
      versionHidden: Boolean(document.getElementById('app-version-badge')?.hidden),
      bodyHasMarkVii: /Mark\\s*VII|MARK-VII PROTOCOL/i.test(document.body.innerText || ''),
    }))()`,
    returnByValue: true,
  });
  fs.writeFileSync(path.join(outDir, 'brand-check.json'), JSON.stringify(brandCheck.result?.result?.value || brandCheck, null, 2));

  ws.close();
  try { child.kill(); } catch { /* ignore */ }

  await captureTemplateRefs();
  console.log(JSON.stringify({ ok: true, outDir, templateCompared: fs.existsSync(templateSrc) }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
