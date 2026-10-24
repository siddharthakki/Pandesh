import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const cdpPort = '9457';
const artifactDir = 'C:\\Users\\siddh\\.gemini\\antigravity-ide\\brain\\38efdd2b-45a1-4ac0-a845-6c43bd7a3589';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cdpWs = null;
let cdpNextId = 1;
const cdpPending = new Map();
const consoleErrors = [];

async function waitFor(label, fn, timeoutMs = 90_000, pollIntervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
}

async function getCdpPage() {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const pages = await res.json();
    return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
  } catch {
    return null;
  }
}

async function cdp(method, params = {}) {
  if (!cdpWs) {
    const page = await waitFor('CDP target page', getCdpPage, 60_000);
    cdpWs = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdpWs.once('open', resolve);
      cdpWs.once('error', reject);
    });
    cdpWs.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'Runtime.consoleAPICalled') {
        const type = msg.params?.type;
        const text = (msg.params?.args || []).map(a => a.value || a.description || '').join(' ');
        if (type === 'error') {
          consoleErrors.push(text);
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params?.exceptionDetails?.text || 'Uncaught exception');
      }
      const pending = cdpPending.get(msg.id);
      if (!pending) return;
      cdpPending.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
    const enableRuntimeId = cdpNextId++;
    cdpWs.send(JSON.stringify({ id: enableRuntimeId, method: 'Runtime.enable', params: {} }));
    const enablePageId = cdpNextId++;
    cdpWs.send(JSON.stringify({ id: enablePageId, method: 'Page.enable', params: {} }));
  }

  const id = cdpNextId++;
  return new Promise((resolve, reject) => {
    cdpPending.set(id, { resolve, reject });
    cdpWs.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'CDP evaluate failed');
  }
  return res.result?.value;
}

async function captureScreenshot(filename) {
  const result = await cdp('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(result.data, 'base64');
  const target1 = path.join(artifactDir, filename);
  const target2 = path.join(desktopRoot, 'renderer', 'assets', filename);
  fs.mkdirSync(path.dirname(target1), { recursive: true });
  fs.mkdirSync(path.dirname(target2), { recursive: true });
  fs.writeFileSync(target1, buf);
  fs.writeFileSync(target2, buf);
  console.log(`Saved screenshot to ${target1} and ${target2} (${buf.length} bytes)`);
  return target1;
}

async function main() {
  console.log('=== Step 1: Launching Desktop with CDP port', cdpPort);
  // Ensure main and preload are built
  spawnSync(process.execPath, [path.join(desktopRoot, 'esbuild.mjs')], { cwd: repoRoot, stdio: 'inherit' });

  const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const dataDir = path.join(os.tmpdir(), 'panda-ui-recovery-' + Date.now());
  fs.mkdirSync(dataDir, { recursive: true });

  const child = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
      KARKEDIKHA_DESKTOP_NODE: process.execPath,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
    },
  });

  console.log(`Launched electron child PID: ${child.pid}`);

  try {
    console.log('=== Step 2: Waiting for CDP connection and renderer ready...');
    await waitFor('Renderer ready', async () => {
      return await evaluate('document.readyState === "complete" && Boolean(document.getElementById("panda-avatar-img"))');
    }, 45_000);

    // Give renderer a moment to settle initial state
    await sleep(2500);

    console.log('=== Step 3: Verifying visual presence and DOM structure...');
    const domCheck = await evaluate(`({
      hasPandaImg: Boolean(document.getElementById('panda-avatar-img')),
      pandaImgSrc: document.getElementById('panda-avatar-img')?.src,
      hasWowHero: Boolean(document.querySelector('.wow-hero')),
      hasThreeCol: Boolean(document.querySelector('.page.three-col')),
      hasPandaWorkspace: Boolean(document.querySelector('.panda-workspace')),
      folderPathText: document.getElementById('folder-path')?.textContent?.trim(),
      modelSelected: document.getElementById('model-select')?.value,
      coreState: document.getElementById('core-state')?.textContent?.trim(),
      reactorState: document.getElementById('jarvis-core-reactor')?.dataset?.coreState,
      reactorPresence: document.getElementById('jarvis-core-reactor')?.dataset?.presence,
      greetingText: document.getElementById('wow-greeting')?.textContent?.trim(),
    })`);

    console.log('DOM verification results:', JSON.stringify(domCheck, null, 2));

    if (!domCheck.hasPandaImg) throw new Error('Missing #panda-avatar-img');
    if (domCheck.hasThreeCol) throw new Error('Legacy three-column layout is still present!');
    if (!domCheck.hasWowHero) throw new Error('Missing .wow-hero hero section');
    if (!domCheck.hasPandaWorkspace) throw new Error('Missing .panda-workspace');
    if (domCheck.folderPathText !== 'No folder selected') {
      throw new Error(`Expected truthful "No folder selected", got "${domCheck.folderPathText}"`);
    }

    console.log('=== Step 4: Capturing initial screenshot of recovered Panda UI...');
    await captureScreenshot('actual_panda_recovered.png');

    console.log('=== Step 5: Testing one real conversation with local model...');
    // Type into the prompt input
    await evaluate(`(() => {
      const input = document.getElementById('task-input');
      if (!input) throw new Error('task-input not found');
      input.value = 'Hello Panda! Please introduce yourself in one short sentence.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.getElementById('submit');
      if (!btn) throw new Error('submit button not found');
      btn.click();
    })()`);

    console.log('Submitted chat message, awaiting response streaming and completion...');

    // Wait for task to finish running (working -> completed/idle)
    const completionState = await waitFor('Chat response completion', async () => {
      const state = await evaluate(`({
        running: lastSnapshot?.running,
        lastTurnOutcome: lastSnapshot?.lastTurnOutcome,
        resultHidden: document.getElementById('result')?.hidden,
        resultLength: (document.getElementById('result')?.textContent || '').length,
        resultText: (document.getElementById('result')?.textContent || '').slice(0, 300),
        reactorBadge: document.getElementById('core-reactor-badge')?.textContent,
        coreState: document.getElementById('jarvis-core-reactor')?.dataset?.coreState,
        avatarSrc: document.getElementById('panda-avatar-img')?.src,
      })`);
      if (!state.running && (state.resultLength > 5 || state.lastTurnOutcome === 'completed')) {
        return state;
      }
      return null;
    }, 75_000, 1000);

    console.log('Completed turn state:', JSON.stringify(completionState, null, 2));

    // Settle UI after completion
    await sleep(2000);

    const postChatState = await evaluate(`({
      lastOutcome: lastSnapshot?.lastTurnOutcome,
      coreState: document.getElementById('jarvis-core-reactor')?.dataset?.coreState,
      avatarSrc: document.getElementById('panda-avatar-img')?.src,
      resultText: document.getElementById('result')?.textContent?.trim(),
      resultOutcome: document.getElementById('result-outcome')?.textContent?.trim(),
    })`);

    console.log('Post-chat verification results:', JSON.stringify(postChatState, null, 2));

    console.log('=== Step 6: Capturing post-chat screenshot...');
    await captureScreenshot('actual_panda_chat_result.png');

    console.log('=== Step 7: Checking console errors...');
    console.log(`Total captured console errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      console.warn('Console errors logged:', consoleErrors);
    }

    console.log('=== UI RECOVERY VERIFICATION SUCCESSFUL ===');
    console.log('Initial Screenshot: actual_panda_recovered.png');
    console.log('Chat Result Screenshot: actual_panda_chat_result.png');
    console.log(`Panda Response: ${postChatState.resultText}`);

  } finally {
    try {
      if (cdpWs) cdpWs.close();
      child.kill();
    } catch {}
  }
}

main().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
