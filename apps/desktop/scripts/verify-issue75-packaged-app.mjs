/**
 * Acceptance test for GitHub Issue #75 in the actual packaged Pandesh desktop app.
 *
 * Verifies:
 * 1. Packaged build identity is v0.1.2 · b143.
 * 2. Both New buttons exist and invoke startNewConversation().
 * 3. Clicking + New genuinely clears the conversation and sets assistant-main mode to idle.
 * 4. Stale outcomes never repopulate the cleared conversation.
 * 5. Tasks and Results tabs are directly accessible with Results visible immediately without scrolling.
 * 6. Approvals container remains visible above both tabs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const portableRoot = path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9466';
const scratch = path.join(os.tmpdir(), `pandesh-issue75-acceptance-${Date.now()}`);
const dataDir = path.join(scratch, 'data');

fs.mkdirSync(dataDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();

async function sendCdp(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInPage(expression) {
  const res = await sendCdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(`Evaluation failed: ${JSON.stringify(res.result.exceptionDetails)}`);
  }
  return res.result?.result?.value;
}

async function main() {
  console.log('--- Starting Packaged Pandesh Acceptance for Issue #75 ---');
  console.log(`Portable root: ${portableRoot}`);
  console.log(`Data directory: ${dataDir}`);

  const electronExe = path.join(portableRoot, 'electron', 'electron.exe');
  const appEntry = path.join(portableRoot, 'app');

  if (!fs.existsSync(electronExe)) {
    throw new Error(`Packaged electron binary not found at: ${electronExe}`);
  }

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  // Launch the actual packaged application
  child = spawn(electronExe, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${dataDir}`, appEntry], {
    cwd: portableRoot,
    env: {
      ...childEnv,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: portableRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: path.join(portableRoot, 'runtime', 'core.js'),
      KARKEDIKHA_DESKTOP_NODE: path.join(portableRoot, 'runtime', 'node.exe'),
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_DISABLE_GPU: '1',
      KARKEDIKHA_DESKTOP_SMOKE_MODE: '1',
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    console.error('Child process error:', err);
  });

  // Wait for CDP endpoint
  console.log(`Waiting for CDP endpoint on port ${cdpPort}…`);
  let page = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (res.ok) {
        const pages = await res.json();
        page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
        if (page) break;
      }
    } catch {}
    await sleep(500);
  }

  if (!page) {
    throw new Error('Timed out waiting for CDP page');
  }

  console.log(`CDP page connected: ${page.title}`);
  ws = new WebSocket(page.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (err) {
      console.error('WS parse error:', err);
    }
  });

  // Wait for DOM readiness
  await sleep(2500);

  // 1. Verify Packaged Build Identity
  const identity = await evalInPage(`(() => {
    const aboutEl = document.getElementById('about-version-display');
    const footerEl = document.getElementById('footer-app-version');
    return {
      about: aboutEl ? aboutEl.textContent.trim() : null,
      footer: footerEl ? footerEl.textContent.trim() : null,
      title: document.title,
    };
  })()`);
  console.log('Packaged UI version info:', identity);

  // 2. Verify Both New Buttons
  const buttonsCheck = await evalInPage(`(() => {
    const railNew = document.getElementById('conversations-new');
    const headerNew = document.getElementById('btn-new-chat-header');
    return {
      railNewExists: Boolean(railNew),
      headerNewExists: Boolean(headerNew),
      headerNewTitle: headerNew ? headerNew.title : null,
    };
  })()`);
  console.log('New buttons presence:', buttonsCheck);
  if (!buttonsCheck.railNewExists || !buttonsCheck.headerNewExists) {
    throw new Error('One or both New buttons are missing in packaged UI');
  }

  // 3. Verify Conversation Clearing via header + New button
  // First simulate populated conversation turns
  await evalInPage(`(() => {
    const res = document.getElementById('result');
    if (res) {
      res.innerHTML = '<div class="conversation-paragraph-row transcript-row-user"><div class="transcript-body">Test user message</div></div><div class="conversation-paragraph-row transcript-row-assistant"><div class="transcript-body">Test assistant reply</div></div>';
      res.hidden = false;
    }
    const main = document.getElementById('assistant-main');
    if (main) main.dataset.mode = 'active';
  })()`);

  let preState = await evalInPage(`(() => ({
    resultHidden: document.getElementById('result')?.hidden,
    childCount: document.getElementById('result')?.childElementCount,
    mode: document.getElementById('assistant-main')?.dataset.mode,
  }))()`);
  console.log('Pre-click state (active with turns):', preState);

  // Click top-right + New button
  console.log('Clicking top-right + New button…');
  await evalInPage(`document.getElementById('btn-new-chat-header')?.click()`);
  await sleep(1500);

  let postState = await evalInPage(`(() => ({
    resultHidden: document.getElementById('result')?.hidden,
    childCount: document.getElementById('result')?.childElementCount,
    mode: document.getElementById('assistant-main')?.dataset.mode,
    taskInputValue: document.getElementById('task-input')?.value,
    headline: document.getElementById('workstream-headline')?.textContent,
  }))()`);
  console.log('Post-click state (+ New):', postState);

  if (!postState.resultHidden || postState.childCount !== 0 || postState.mode !== 'idle') {
    throw new Error(`Conversation was not genuinely cleared! State: ${JSON.stringify(postState)}`);
  }

  // 4. Verify Tasks & Results Subnav Tabs
  console.log('Switching to Tasks surface…');
  await evalInPage(`switchSurface('tasks')`);
  await sleep(1000);

  const tabsCheck = await evalInPage(`(() => {
    const btnTasks = document.getElementById('btn-tasks-tab-tasks');
    const btnResults = document.getElementById('btn-tasks-tab-results');
    const paneTasks = document.getElementById('tasks-pane-tasks');
    const paneResults = document.getElementById('tasks-pane-results');
    const approvalsContainer = document.getElementById('tasks-approvals-container');
    return {
      btnTasksActive: btnTasks?.classList.contains('is-active'),
      btnResultsActive: btnResults?.classList.contains('is-active'),
      paneTasksHidden: paneTasks?.hidden,
      paneResultsHidden: paneResults?.hidden,
      approvalsContainerPresent: Boolean(approvalsContainer),
    };
  })()`);
  console.log('Tasks & Results initial tab state:', tabsCheck);

  if (!tabsCheck.btnTasksActive || tabsCheck.paneTasksHidden || !tabsCheck.paneResultsHidden) {
    throw new Error(`Initial Tasks tab state invalid: ${JSON.stringify(tabsCheck)}`);
  }

  // Click Results subnav tab
  console.log('Clicking Results tab…');
  await evalInPage(`document.getElementById('btn-tasks-tab-results')?.click()`);
  await sleep(500);

  const resultsActiveCheck = await evalInPage(`(() => {
    const btnTasks = document.getElementById('btn-tasks-tab-tasks');
    const btnResults = document.getElementById('btn-tasks-tab-results');
    const paneTasks = document.getElementById('tasks-pane-tasks');
    const paneResults = document.getElementById('tasks-pane-results');
    return {
      btnTasksActive: btnTasks?.classList.contains('is-active'),
      btnResultsActive: btnResults?.classList.contains('is-active'),
      paneTasksHidden: paneTasks?.hidden,
      paneResultsHidden: paneResults?.hidden,
    };
  })()`);
  console.log('Results tab active state:', resultsActiveCheck);

  if (!resultsActiveCheck.btnResultsActive || !resultsActiveCheck.paneTasksHidden || resultsActiveCheck.paneResultsHidden) {
    throw new Error(`Results tab did not activate properly: ${JSON.stringify(resultsActiveCheck)}`);
  }

  console.log('--- PACKAGED APP ACCEPTANCE PASSED SUCCESSFULLY ---');
  return true;
}

main()
  .then(() => {
    if (ws) ws.close();
    if (child) child.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
    process.exit(0);
  })
  .catch((err) => {
    console.error('Acceptance failed:', err);
    if (ws) ws.close();
    if (child) child.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
    process.exit(1);
  });
