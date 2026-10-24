import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outDir = path.join(repoRoot, 'dist', 'panda-apex-screens');
fs.mkdirSync(outDir, { recursive: true });

const cdpPort = '9777';
const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const logDir = path.join(repoRoot, '.tmp');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'desktop-host.log');
const dataDir = path.join(repoRoot, '.tmp', 'desktop-test-data');
fs.mkdirSync(path.join(dataDir, 'electron-profile'), { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

console.log('[capture] Launching Electron with CDP on port', cdpPort);
const child = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
  cwd: repoRoot,
  stdio: 'pipe',
  env: {
    ...process.env,
    KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
    KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath,
    KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
    KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
    KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
  },
  windowsHide: false,
});

child.stdout?.on('data', (d) => console.log('[electron:stdout]', String(d).trim()));
child.stderr?.on('data', (d) => console.log('[electron:stderr]', String(d).trim()));

async function connectCdp(port) {
  const deadline = Date.now() + 30000;
  let page;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* wait */ }
    await sleep(400);
  }
  if (!page) throw new Error('CDP page not ready');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 1;
  const pending = new Map();
  const consoleMessages = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.method === 'Runtime.consoleAPICalled') {
      const type = msg.params.type;
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      consoleMessages.push({ type, text });
      console.log(`[renderer:${type}]`, text);
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

  return { cdp, ws, consoleMessages };
}

try {
  const { cdp, ws, consoleMessages } = await connectCdp(cdpPort);
  console.log('[capture] Connected to CDP!');

  await cdp('Runtime.enable');
  await cdp('Page.enable');

  // Set window size to 1440x900 for high-res screenshot
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Wait for initial render and animations
  await sleep(2500);

  // Check DOM state
  const evalResult = await cdp('Runtime.evaluate', {
    expression: `({
      hasPanda: !!document.getElementById('panda-avatar-img'),
      hasShader: !!document.getElementById('apex-shader-canvas'),
      hasReasoningWeb: !!document.getElementById('reasoning-web-container'),
      hasStatusBar: !!document.getElementById('apex-status-container'),
      hasFloatingWb: !!document.getElementById('floating-workbench'),
      hasComposer: !!document.getElementById('task-input'),
      hasCenterIris: !!document.getElementById('center-iris-card'),
      hasNodeCard: !!document.getElementById('node-overview-card'),
      hasActivityDrawer: !!document.getElementById('drawer-activity'),
    })`,
    returnByValue: true,
  });
  console.log('[capture] Initial DOM Evaluation:', evalResult.result.value);

  // ── CAPTURE 1: EXPERIENCE A — NEURAL HOME ──
  console.log('[capture] Capturing Experience A: Neural Home...');
  await sleep(800);
  const homeShot = await cdp('Page.captureScreenshot', { format: 'png' });
  const homePath = path.join(outDir, 'actual_panda_apex_home.png');
  fs.writeFileSync(homePath, Buffer.from(homeShot.data, 'base64'));
  console.log('[capture] Saved home screenshot to:', homePath);

  // ── CAPTURE 2: EXPERIENCE E — CONTEXTUAL CAPABILITY CARD ──
  console.log('[capture] Capturing Experience E: Contextual Capability Card (Research)...');
  await cdp('Runtime.evaluate', {
    expression: `
      if (typeof openCapabilityCard === 'function') {
        openCapabilityCard({ id: 'research', label: 'Research', subtitle: 'Search · Symbol Discovery · Synthesis' });
      }
    `,
  });
  await sleep(700);
  const cardShot = await cdp('Page.captureScreenshot', { format: 'png' });
  const cardPath = path.join(outDir, 'actual_panda_apex_capability_card.png');
  fs.writeFileSync(cardPath, Buffer.from(cardShot.data, 'base64'));
  console.log('[capture] Saved capability card screenshot to:', cardPath);

  // Dismiss card
  await cdp('Runtime.evaluate', {
    expression: `if (typeof hideCapabilityCard === 'function') hideCapabilityCard();`,
  });
  await sleep(400);

  // ── CAPTURE 3: EXPERIENCE C — QUICK ANSWER / CENTER IRIS ──
  console.log('[capture] Capturing Experience C: Quick Answer Iris...');
  await cdp('Runtime.evaluate', {
    expression: `
      if (typeof showQuickAnswer === 'function') {
        showQuickAnswer('qwen3.8:27b-mtp-q4_K_M');
        const content = document.getElementById('iris-content');
        if (content) {
          content.innerHTML = '<p>Panda Neural Experience is operating normally with local inference on <strong>qwen3.8:27b-mtp-q4_K_M</strong>. Continuous SQLite conversation provenance is active and healthy.</p>';
        }
      }
    `,
  });
  await sleep(700);
  const irisShot = await cdp('Page.captureScreenshot', { format: 'png' });
  const irisPath = path.join(outDir, 'actual_panda_apex_quick_answer.png');
  fs.writeFileSync(irisPath, Buffer.from(irisShot.data, 'base64'));
  console.log('[capture] Saved quick answer screenshot to:', irisPath);

  // Dismiss quick answer
  await cdp('Runtime.evaluate', {
    expression: `if (typeof hideQuickAnswer === 'function') hideQuickAnswer();`,
  });
  await sleep(400);

  // ── CAPTURE 4: EXPERIENCE B — SPLIT WORKBENCH ──
  console.log('[capture] Capturing Experience B: Split Workbench...');
  await cdp('Runtime.evaluate', {
    expression: `
      if (typeof floatingWorkbenchController !== 'undefined' && floatingWorkbenchController) {
        floatingWorkbenchController.open('conv');
      }
    `,
  });
  await sleep(900);
  const wbShot = await cdp('Page.captureScreenshot', { format: 'png' });
  const wbPath = path.join(outDir, 'actual_panda_apex_workbench.png');
  fs.writeFileSync(wbPath, Buffer.from(wbShot.data, 'base64'));
  console.log('[capture] Saved workbench screenshot to:', wbPath);

  // Close workbench
  await cdp('Runtime.evaluate', {
    expression: `
      if (typeof floatingWorkbenchController !== 'undefined' && floatingWorkbenchController) {
        floatingWorkbenchController.close();
      }
    `,
  });
  await sleep(500);

  // ── CAPTURE 5: EXPERIENCE D — LIVE ACTIVITY DRAWER ──
  console.log('[capture] Capturing Experience D: Live Activity Drawer...');
  await cdp('Runtime.evaluate', {
    expression: `
      const btn = document.getElementById('btn-drawer-activity');
      if (btn) btn.click();
    `,
  });
  await sleep(800);
  const actShot = await cdp('Page.captureScreenshot', { format: 'png' });
  const actPath = path.join(outDir, 'actual_panda_apex_activity.png');
  fs.writeFileSync(actPath, Buffer.from(actShot.data, 'base64'));
  console.log('[capture] Saved activity drawer screenshot to:', actPath);

  // Check for any unhandled JS errors in renderer
  const errors = consoleMessages.filter((m) => m.type === 'error');
  console.log('[capture] Console errors count:', errors.length);
  if (errors.length > 0) {
    console.warn('[capture] Errors logged:', errors);
  }

  ws.close();
} catch (err) {
  console.error('[capture] Error during capture:', err);
} finally {
  console.log('[capture] Terminating Electron process...');
  child.kill();
}
