/**
 * PANDESH — RELIABILITY GATE 2: REAL-WORLD EXECUTION RUNNER
 *
 * Role: Principal Reliability Engineer, Independent QA Auditor and Release Gate Owner
 *
 * Runs 15 genuine real-world missions and 6 failure recovery tests against
 * the staged portable Electron package (dist/pandesh-win32-x64) in an isolated profile.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import CDP from 'chrome-remote-interface';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const portableRoot = path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const electronExe = path.join(portableRoot, 'electron', 'electron.exe');
const appDir = path.join(portableRoot, 'app');
const nodeExe = path.join(portableRoot, 'runtime', 'node.exe');
const coreJs = path.join(portableRoot, 'runtime', 'core.js');

const cdpPort = 9456;
const profileRoot = path.join(repoRoot, '.tmp', 'gate2-isolated-profile');
const desktopDir = path.join(profileRoot, 'desktop');
const dataDir = path.join(profileRoot, 'data');
const workspaceDir = path.join(profileRoot, 'workspace');
const logPath = path.join(profileRoot, 'desktop-host.log');

const gate2Dir = path.join(repoRoot, 'acceptance', 'reliability-gate2');
const evidenceDir = path.join(gate2Dir, 'evidence');

const MODEL_NAME = 'qwen3.8:27b-mtp-q4_K_M';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryDb(sql, params = []) {
  const dbPath = path.join(desktopDir, 'core.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(sql).all(...params);
    db.close();
    return rows;
  } catch (err) {
    console.error('queryDb error:', err.message);
    return [];
  }
}

async function evaluate(client, expression) {
  const res = await client.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'evaluate failed');
  }
  return res.result?.value;
}

async function captureScreenshot(client, filePath) {
  try {
    const { data } = await client.Page.captureScreenshot({ format: 'png' });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return true;
  } catch (err) {
    console.error(`Screenshot failed for ${filePath}:`, err.message);
    return false;
  }
}

async function submitPrompt(client, text) {
  console.log(`Submitting prompt: "${text}"`);
  return evaluate(client, `(() => {
    const input = document.getElementById('task-input');
    if (input) {
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const submit = document.getElementById('submit');
    if (submit) {
      submit.click();
    } else {
      window.karkedikhaDesktop.submitTask(${JSON.stringify(text)});
    }
  })()`);
}

async function waitForTurnCompletion(client, {
  scenarioName,
  timeoutMs = 180000,
  approvalAction = 'approved',
  onApproval = null,
  beforeAttemptId = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let attemptStarted = false;
  let currentAttemptId = null;
  const seenAttemptIds = new Set();
  let lastApprovalKey = '';

  // Give renderer 600ms to register task submission
  await sleep(600);

  while (Date.now() < deadline) {
    const snap = await evaluate(client, 'window.karkedikhaDesktop ? window.karkedikhaDesktop.getSnapshot() : null');
    const isRunning = Boolean(snap?.running);
    const isSpeaking = Boolean(snap?.speaking);
    const pendingApproval = snap?.pendingApproval;
    const pendingImage = snap?.pendingImageApproval;
    const hasPendingApproval = Boolean(pendingApproval || pendingImage);
    const isDifferentAttempt = snap?.attemptId && snap.attemptId !== beforeAttemptId;

    if (snap?.attemptId && snap.attemptId !== beforeAttemptId) {
      seenAttemptIds.add(snap.attemptId);
    }
    if (pendingApproval?.attemptId && pendingApproval.attemptId !== beforeAttemptId) {
      seenAttemptIds.add(pendingApproval.attemptId);
    }

    if (!attemptStarted) {
      // If beforeAttemptId is supplied, do NOT treat the old non-running attempt as started
      if (beforeAttemptId && snap?.attemptId === beforeAttemptId && !isRunning && !hasPendingApproval) {
        await sleep(300);
        continue;
      }

      if (isRunning || hasPendingApproval || isDifferentAttempt) {
        attemptStarted = true;
        currentAttemptId = snap?.attemptId ?? pendingApproval?.attemptId ?? null;
        console.log(`[${scenarioName}] Turn active detected (attemptId=${currentAttemptId}, running=${isRunning}, pendingApproval=${hasPendingApproval})`);
      }
    } else if (!currentAttemptId && (snap?.attemptId || pendingApproval?.attemptId)) {
      currentAttemptId = snap?.attemptId ?? pendingApproval?.attemptId ?? null;
    }

    // Handle pending approval (Core tools or Image Studio)
    if (pendingImage) {
      const approvalId = pendingImage.approvalId;
      const key = `image:${approvalId}`;
      if (key !== lastApprovalKey) {
        lastApprovalKey = key;
        console.log(`[${scenarioName}] Image approval card displayed for prompt: "${pendingImage.details?.prompt}" (approvalId=${approvalId})`);
        if (onApproval) await onApproval({ approvalId, toolName: 'image_generate', details: pendingImage.details });
        await sleep(600);
        try {
          await evaluate(client, `window.karkedikhaDesktop.resolveImageApproval(${JSON.stringify(approvalId)}, ${JSON.stringify(approvalAction)})`);
          console.log(`[${scenarioName}] Resolved image approval ${approvalId} with action=${approvalAction}`);
        } catch (err) {
          console.log(`[${scenarioName}] Note: resolveImageApproval ended: ${err?.message || err}`);
        }
        await sleep(1500);
        continue;
      }
    } else if (pendingApproval) {
      const approvalId = pendingApproval.approvalId;
      const tool = pendingApproval.toolName;
      const key = `${approvalId}:${tool}`;
      if (key !== lastApprovalKey) {
        lastApprovalKey = key;
        console.log(`[${scenarioName}] Approval card displayed for tool: ${tool} (approvalId=${approvalId})`);
        if (onApproval) await onApproval(pendingApproval);
        await sleep(600);
        try {
          await evaluate(client, `window.karkedikhaDesktop.resolveApproval(${JSON.stringify(approvalId)}, ${JSON.stringify(approvalAction)})`);
          console.log(`[${scenarioName}] Resolved approval ${approvalId} with action=${approvalAction}`);
        } catch (err) {
          console.log(`[${scenarioName}] Note: resolveApproval ended: ${err?.message || err}`);
        }
        await sleep(1500);
        continue;
      }
    }

    // Check if turn finished: must have started and now running is false with no pending approval
    let isDbTerminal = false;
    if (currentAttemptId) {
      const dbRow = queryDb('SELECT status FROM attempts WHERE id = ?', [currentAttemptId])[0];
      if (dbRow && ['completed', 'failed', 'cancelled'].includes(dbRow.status)) {
        isDbTerminal = true;
      }
    }

    if (attemptStarted && (!isRunning || isDbTerminal || Boolean(snap?.lastTurnOutcome)) && !hasPendingApproval) {
      if (isSpeaking) {
        try {
          await evaluate(client, 'window.karkedikhaDesktop?.stopSpeaking?.()');
        } catch {}
      }
      await sleep(1500);
      const finalSnap = await evaluate(client, 'window.karkedikhaDesktop ? window.karkedikhaDesktop.getSnapshot() : null');
      console.log(`[${scenarioName}] Turn finished: outcome=${finalSnap?.lastTurnOutcome || snap?.lastTurnOutcome || 'completed'}, attemptId=${currentAttemptId}`);
      return {
        ok: true,
        snap: finalSnap || snap,
        attemptId: currentAttemptId,
        attemptIds: Array.from(seenAttemptIds),
      };
    }

    await sleep(500);
  }

  throw new Error(`Scenario ${scenarioName} timed out after ${timeoutMs}ms`);
}

function launchElectronApp(port = cdpPort) {
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  console.log(`Launching packaged Electron on CDP port ${port}...`);
  const child = spawn(electronExe, [`--remote-debugging-port=${port}`, appDir], {
    cwd: portableRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...childEnv,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: portableRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: coreJs,
      KARKEDIKHA_DESKTOP_NODE: nodeExe,
      KARKEDIKHA_DESKTOP_DATA_DIR: desktopDir,
      KARKEDIKHA_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_REPO: workspaceDir,
      KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
      KARKEDIKHA_DESKTOP_CDP_PORT: String(port),
      KARKEDIKHA_DESKTOP_DISABLE_GPU: '1',
      KARKEDIKHA_DESKTOP_SMOKE_MODE: '1',
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
      KARKEDIKHA_DEFAULT_MODEL: MODEL_NAME,
      KARKEDIKHA_DESKTOP_MODEL: MODEL_NAME,
      KARKEDIKHA_MODEL: MODEL_NAME,
      KARKEDIKHA_OLLAMA_URL: 'http://127.0.0.1:11434',
    },
    windowsHide: false,
  });
  child.unref();
  return child;
}

async function connectCdpWithRetry(maxWaitMs = 60000, port = cdpPort) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const targets = await CDP.List({ port });
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (page) {
        const client = await CDP({ port, target: page });
        await client.Runtime.enable();
        await client.Page.enable();
        await client.DOM.enable();
        return client;
      }
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`Could not connect to CDP on port ${port} within ${maxWaitMs}ms`);
}

async function stopElectron() {
  try {
    spawnSync('taskkill.exe', ['/F', '/T', '/IM', 'electron.exe'], { stdio: 'ignore' });
  } catch {}
  try {
    spawnSync('taskkill.exe', ['/F', '/T', '/IM', 'pandesh.exe'], { stdio: 'ignore' });
  } catch {}
  await sleep(1000);
}

export {
  repoRoot,
  portableRoot,
  profileRoot,
  desktopDir,
  dataDir,
  workspaceDir,
  evidenceDir,
  gate2Dir,
  cdpPort,
  MODEL_NAME,
  sleep,
  queryDb,
  evaluate,
  captureScreenshot,
  submitPrompt,
  waitForTurnCompletion,
  launchElectronApp,
  connectCdpWithRetry,
  stopElectron,
};

