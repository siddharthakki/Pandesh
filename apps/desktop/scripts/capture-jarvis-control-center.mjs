/**
 * Captures Jarvis control-center screenshots at 1280×800 and 1920×1080
 * with real host telemetry (no fabricated values).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const portableRoot = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9466';
const outDir = process.env.KARKEDIKHA_JARVIS_SHOTS
  ?? path.join(repoRoot, '.tmp', 'jarvis-control-center-shots');
const scratch = path.join(os.tmpdir(), `karkedikha-jarvis-shots-${Date.now()}`);
const dataDir = path.join(scratch, 'desktop-data');
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function cdp(method, params = {}) {
  const page = await waitFor('cdp list', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const pages = await res.json();
      return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
    } catch {
      return null;
    }
  }, 90_000);

  if (!cdp.ws) {
    cdp.ws = new WebSocket(page.webSocketDebuggerUrl);
    cdp.nextId = 1;
    cdp.pending = new Map();
    await new Promise((resolve, reject) => {
      cdp.ws.once('open', resolve);
      cdp.ws.once('error', reject);
    });
    cdp.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const pending = cdp.pending.get(msg.id);
      if (!pending) return;
      cdp.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
    await cdp('Page.enable');
    await cdp('Runtime.enable');
  }

  const id = cdp.nextId++;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function shot(name) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

function prepareFixture() {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = path.join(scratch, 'repo');
  fs.mkdirSync(fixture, { recursive: true });
  spawnSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
  fs.writeFileSync(path.join(fixture, 'package.json'), `${JSON.stringify({
    name: 'jarvis-control-center-fixture',
    version: '0.0.1',
    private: true,
  }, null, 2)}\n`);
  spawnSync('git', ['add', 'package.json'], { cwd: fixture, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-m', 'init'], {
    cwd: fixture,
    stdio: 'ignore',
  });
  return fixture;
}

function launch(fixture, viewport) {
  const electronExe = path.join(portableRoot, 'electron', 'electron.exe');
  const appDir = path.join(portableRoot, 'app');
  const nodeExe = path.join(portableRoot, 'runtime', 'node.exe');
  const coreJs = path.join(portableRoot, 'runtime', 'core.js');
  for (const required of [electronExe, appDir, nodeExe, coreJs]) {
    if (!fs.existsSync(required)) throw new Error(`portable artifact missing: ${required}`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(electronExe, [
    `--remote-debugging-port=${cdpPort}`,
    `--window-size=${viewport.width},${viewport.height}`,
    appDir,
  ], {
    cwd: portableRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: portableRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: coreJs,
      KARKEDIKHA_DESKTOP_NODE: nodeExe,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_REPO: fixture,
      KARKEDIKHA_DESKTOP_HOST_LOG: path.join(scratch, 'desktop-host.log'),
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
      KARKEDIKHA_DESKTOP_MODEL: process.env.KARKEDIKHA_DESKTOP_MODEL || 'qwen2.5-coder:1.5b',
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

async function captureViewport(viewport, fixture, files) {
  if (cdp.ws) {
    try { cdp.ws.close(); } catch { /* ignore */ }
    cdp.ws = null;
  }
  const pid = launch(fixture, viewport);
  try {
    await waitFor('api', async () => evaluate('Boolean(window.karkedikhaDesktop)'));
    await waitFor('core', async () => {
      const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      return snap?.coreState === 'connected' ? snap : null;
    }, 120_000);
    await waitFor('host telemetry', async () => {
      const telem = await evaluate('window.karkedikhaDesktop.getHostTelemetry()');
      return telem?.clock?.localTime && telem?.memory?.available ? telem : null;
    }, 60_000);

    await cdp('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const realValues = await evaluate(`({
      clock: document.getElementById('host-clock')?.textContent,
      tz: document.getElementById('host-timezone')?.textContent,
      memory: document.getElementById('telem-memory')?.textContent,
      gpu: document.getElementById('telem-gpu')?.textContent,
      threeCol: Boolean(document.querySelector('.three-col')),
      reactor: Boolean(document.getElementById('mic-button')?.classList.contains('reactor-core')),
      waveform: Boolean(document.getElementById('waveform-canvas')),
      stepper: Boolean(document.getElementById('mission-timeline')),
      tabs: [...document.querySelectorAll('.tab-btn')].map((n) => n.textContent.trim()),
      weather: document.querySelector('.weather-panel .not-connected')?.textContent,
      ui: document.querySelector('.app')?.dataset.ui,
      hero: document.querySelector('.jarvis-hero h1')?.textContent,
      leftOverflow: getComputedStyle(document.querySelector('.col-left')).overflowY,
      centerOverflow: getComputedStyle(document.querySelector('.col-center')).overflowY,
      workstreamOverflow: getComputedStyle(document.querySelector('.workstream-body')).overflowY,
    })`);
    if (!realValues?.threeCol) throw new Error('expected template three-column layout');
    if (!realValues.reactor || !realValues.waveform || !realValues.stepper) {
      throw new Error(`template chrome missing: ${JSON.stringify(realValues)}`);
    }
    if (!realValues.clock || realValues.clock === '--:--:--') throw new Error(`expected real clock, got ${realValues.clock}`);
    if (!/Not connected/i.test(realValues.weather || '')) throw new Error('weather must stay Not connected');
    if (realValues.ui !== 'quiet-spatial' || realValues.hero !== 'Talk to Jarvis') {
      throw new Error(`quiet spatial canvas missing: ${JSON.stringify(realValues)}`);
    }
    if (viewport.width > 1100 && [realValues.leftOverflow, realValues.centerOverflow, realValues.workstreamOverflow].some((value) => value !== 'auto')) {
      throw new Error(`expected independent desktop scroll regions: ${JSON.stringify(realValues)}`);
    }

    const idleCheck = await evaluate(`({
      micLabel: document.getElementById('mic-toggle-label')?.textContent,
      workstream: document.getElementById('workstream-headline')?.textContent,
      conversationsFirst: document.querySelector('.col-left')?.querySelector('.panel')?.id === 'conversations-rail',
    })`);
    if (idleCheck?.micLabel !== 'Start listening') {
      throw new Error(`expected Start listening, got ${idleCheck?.micLabel}`);
    }
    if (idleCheck?.workstream !== 'No active workstream') {
      throw new Error(`expected No active workstream, got ${idleCheck?.workstream}`);
    }
    if (!idleCheck?.conversationsFirst) throw new Error('Conversations must remain the primary left-rail surface');

    await evaluate(`document.querySelector('.app').dataset.jarvisState = 'idle'`);
    files[`${viewport.name}-idle`] = await shot(`${viewport.name}-01-idle`);

    await evaluate(`document.getElementById('mic-toggle-btn').click()`);
    await sleep(400);
    const listeningUi = await evaluate(`({
      state: document.querySelector('.app')?.dataset.jarvisState,
      status: document.getElementById('mic-toggle-status')?.textContent,
      statusHidden: document.getElementById('mic-toggle-status')?.hidden,
      label: document.getElementById('mic-toggle-label')?.textContent,
      neural: document.getElementById('neural-ready')?.textContent,
    })`);
    if (!['listening', 'capturing'].includes(listeningUi?.state)) throw new Error(`expected listening/capturing, got ${listeningUi?.state}`);
    if (listeningUi?.status !== 'Listening' || listeningUi?.statusHidden) {
      throw new Error(`expected Listening status visible, got ${JSON.stringify(listeningUi)}`);
    }
    if (listeningUi?.label !== 'Stop listening') {
      throw new Error(`expected Stop listening, got ${listeningUi?.label}`);
    }
    files[`${viewport.name}-listening`] = await shot(`${viewport.name}-02-listening`);

    await evaluate(`document.getElementById('cancel').click()`);
    await evaluate(`(() => {
      const app = document.querySelector('.app');
      app.dataset.jarvisState = 'working';
      document.getElementById('jarvis-state-label').dataset.state = 'working';
      document.getElementById('jarvis-state-label').textContent = 'Working';
      document.getElementById('neural-ready').textContent = 'Mission active';
      document.getElementById('activity-summary').textContent = 'Thinking about your request…';
      const headline = document.getElementById('workstream-headline');
      headline.textContent = 'Thinking about your request… · investigation';
      headline.classList.remove('is-empty');
      document.getElementById('mission-phase-brief').textContent = 'investigation';
      document.getElementById('result-state').textContent = 'Working';
      document.getElementById('timeline-thinking').classList.add('is-active');
      const activity = document.getElementById('activity');
      activity.replaceChildren();
      const row = document.createElement('li');
      row.textContent = 'Mission started';
      activity.appendChild(row);
    })()`);
    files[`${viewport.name}-mission`] = await shot(`${viewport.name}-03-mission`);

    await evaluate(`document.getElementById('btn-gmail')?.click()`);
    await sleep(150);
    const gmailUi = await evaluate(`({
      active: document.getElementById('btn-gmail')?.classList.contains('active'),
      status: document.getElementById('gmail-status')?.textContent,
      accountBar: Boolean(document.querySelector('.gmail-account-bar')),
      mailbox: Boolean(document.querySelector('.gmail-list-pane')),
      reader: Boolean(document.querySelector('.gmail-reader-pane')),
      compose: Boolean(document.querySelector('.gmail-compose')),
      surface: document.querySelector('.workstream')?.dataset.surface,
    })`);
    if (!gmailUi?.active || gmailUi.surface !== 'gmail' || !gmailUi.accountBar || !gmailUi.mailbox || !gmailUi.reader || !gmailUi.compose) {
      throw new Error(`Gmail workspace missing: ${JSON.stringify(gmailUi)}`);
    }
    files[`${viewport.name}-gmail`] = await shot(`${viewport.name}-04-gmail`);
    files[`${viewport.name}-gmailUi`] = gmailUi;

    await evaluate(`document.getElementById('btn-tools')?.click()`);
    await sleep(150);
    const toolsUi = await evaluate(`({
      active: document.getElementById('btn-tools')?.classList.contains('active'),
      surface: document.querySelector('.workstream')?.dataset.surface,
      research: Boolean(document.getElementById('research-query')),
      notes: Boolean(document.getElementById('notes-list')),
      reminders: Boolean(document.getElementById('reminders-list')),
      health: document.getElementById('tools-health-cpu')?.textContent,
    })`);
    if (!toolsUi?.active || toolsUi.surface !== 'tools' || !toolsUi.research || !toolsUi.notes || !toolsUi.reminders) {
      throw new Error(`Essential Tools workspace missing: ${JSON.stringify(toolsUi)}`);
    }
    files[`${viewport.name}-tools`] = await shot(`${viewport.name}-05-tools`);
    files[`${viewport.name}-toolsUi`] = toolsUi;
    await evaluate(`document.getElementById('btn-terminal')?.click()`);

    await evaluate(`document.getElementById('btn-terminal').click()`);
    files[`${viewport.name}-realValues`] = { ...realValues, idleCheck, listeningUi };
  } finally {
    try { if (cdp.ws) cdp.ws.close(); } catch { /* ignore */ }
    cdp.ws = null;
    if (pid) {
      try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    await sleep(800);
  }
}

async function main() {
  if (!fs.existsSync(path.join(portableRoot, 'Launch-Pandesh.cmd'))) {
    throw new Error(`Rebuild portable first: node apps/desktop/scripts/package-portable.mjs`);
  }
  const fixture = prepareFixture();
  const files = {};
  for (const viewport of VIEWPORTS) {
    await captureViewport(viewport, fixture, files);
  }
  console.log(JSON.stringify({ ok: true, viewports: VIEWPORTS, outDir, files }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
