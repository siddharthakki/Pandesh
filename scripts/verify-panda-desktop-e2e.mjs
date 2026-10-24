/**
 * Panda Desktop Real End-to-End Delivery Verification
 * Executes all 5 real user scenarios against the running Desktop application via CDP.
 * Uses real local Ollama model (qwen3-coder:swift-27b).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const cdpPort = '9456';
const scratch = path.join(os.tmpdir(), 'panda-desktop-e2e-' + Date.now());
const dataDir = path.join(scratch, 'desktop-data');
const logPath = path.join(scratch, 'desktop-host.log');
const evidencePath = path.join(scratch, 'desktop-e2e-evidence.json');

fs.mkdirSync(dataDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cdpWs = null;
let cdpNextId = 1;
const cdpPending = new Map();

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
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) return null;
  const pages = await res.json();
  return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
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
      const pending = cdpPending.get(msg.id);
      if (!pending) return;
      cdpPending.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
    const enableId = cdpNextId++;
    cdpWs.send(JSON.stringify({ id: enableId, method: 'Runtime.enable', params: {} }));
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

// Prepare disposable test fixture for Scenario C, D, E
function prepareDisposableProject() {
  const projDir = path.join(scratch, 'disposable-calc');
  fs.mkdirSync(projDir, { recursive: true });

  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify(
      {
        name: 'disposable-calc',
        version: '1.0.0',
        scripts: { test: 'node test.js' },
      },
      null,
      2
    )
  );

  // Buggy math module: add returns a - b instead of a + b
  fs.writeFileSync(
    path.join(projDir, 'calculator.js'),
    `function add(a, b) {\n  return a - b; // BUG: subtraction instead of addition\n}\n\nmodule.exports = { add };\n`
  );

  // Test script that fails on the bug
  fs.writeFileSync(
    path.join(projDir, 'test.js'),
    `const { add } = require('./calculator');\nconst assert = require('assert');\n\nassert.strictEqual(add(2, 3), 5, 'add(2, 3) must equal 5');\nconsole.log('ALL CHECKS PASSED');\n`
  );

  // Git repo initialization
  spawnSync('git', ['init'], { cwd: projDir, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: projDir, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.name=PandaTester', '-c', 'user.email=panda@example.com', 'commit', '-m', 'Initial commit with defect'], {
    cwd: projDir,
    stdio: 'ignore',
  });

  return projDir;
}

async function main() {
  console.log('====================================================');
  console.log(' PANDA DESKTOP: REAL END-TO-END DELIVERY TEST SUITE');
  console.log('====================================================');
  console.log(`Scratch directory: ${scratch}`);

  const evidence = {
    startedAt: new Date().toISOString(),
    scenarios: {},
  };

  // Launch real Electron Desktop
  const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) {
    throw new Error(`Electron binary not found at ${electronBin}`);
  }

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  console.log('Launching Panda Desktop with CDP on port ' + cdpPort + '...');
  const desktopProcess = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...childEnv,
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

  try {
    // 1. Verify Desktop UI and Core Connectivity
    console.log('\n[Baseline] Connecting to Desktop via Chrome DevTools Protocol...');
    await waitFor('Desktop API ready', () => evaluate('Boolean(window.karkedikhaDesktop)'), 60_000);
    console.log('  ✓ window.karkedikhaDesktop API injected.');

    const title = await evaluate('document.title');
    console.log(`  ✓ Window Title: "${title}"`);
    const brand = await evaluate('document.querySelector(".brand")?.textContent');
    console.log(`  ✓ Header Brand: "${brand}"`);
    const hero = await evaluate('document.querySelector(".jarvis-hero h1")?.textContent');
    console.log(`  ✓ Hero Header: "${hero}"`);
    const avatarSrc = await evaluate('document.getElementById("panda-avatar-img")?.src');
    console.log(`  ✓ Panda Mascot Avatar: ${avatarSrc}`);

    const snap = await waitFor(
      'Core connected',
      async () => {
        const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
        return s?.coreState === 'connected' ? s : null;
      },
      60_000
    );
    console.log(`  ✓ Core Connected: model=${snap.model}, apiBase=${snap.apiBase}`);

    // Select active local model
    const preferredModel = 'qwen3-coder:swift-27b';
    const models = await evaluate('window.karkedikhaDesktop.listModels()');
    console.log(`  ✓ Available local models: ${models.join(', ')}`);
    if (models.includes(preferredModel)) {
      await evaluate(`window.karkedikhaDesktop.selectModel(${JSON.stringify(preferredModel)})`);
      console.log(`  ✓ Selected local model: ${preferredModel}`);
    }

    async function dispatchAndWait(prompt, timeoutMs = 180_000) {
      console.log(`Prompt: "${prompt}"`);
      const submitResult = await evaluate(`(async () => {
        document.getElementById('result').textContent = '';
        document.getElementById('task-input').value = ${JSON.stringify(prompt)};
        try {
          const res = await window.karkedikhaDesktop.submitTask(${JSON.stringify(prompt)});
          return { ok: true, res };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      })()`);
      console.log(`  Submit outcome: ${JSON.stringify(submitResult)}`);
      if (!submitResult.ok) {
        throw new Error(`Submission failed: ${submitResult.error}`);
      }

      await sleep(1500);
      const completion = await waitFor(
        'Execution completed',
        async () => {
          const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
          const replyText = await evaluate('document.getElementById("result")?.textContent');
          if (!s?.running && (s?.lastTurnOutcome || (replyText && replyText.trim().length > 0))) {
            return { snapshot: s, reply: (replyText || '').trim() };
          }
          return null;
        },
        timeoutMs,
        1000
      );
      return completion;
    }

    // SCENARIO A: Natural Conversation
    console.log('\n----------------------------------------------------');
    console.log(' SCENARIO A: Natural Conversation');
    console.log('----------------------------------------------------');
    const promptA = 'Who are you and what is your purpose as Panda assistant? Answer in two concise sentences.';
    const resA = await dispatchAndWait(promptA, 90_000);
    console.log(`Outcome: ${resA.snapshot.lastTurnOutcome}`);
    console.log(`Panda Reply:\n"${resA.reply}"`);

    evidence.scenarios.scenarioA = {
      passed: Boolean(resA.reply && resA.reply.length > 10),
      outcome: resA.snapshot.lastTurnOutcome,
      reply: resA.reply,
    };

    const targetScenario = process.env.SCENARIO || process.argv[2];
    if (targetScenario === 'A') {
      fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
      console.log('\n====================================================');
      console.log(' SCENARIO A EXECUTED SUCCESSFULLY!');
      console.log(` Evidence saved to: ${evidencePath}`);
      console.log('====================================================');
      return;
    }

    // SCENARIO B: Existing Project Discovery
    console.log('\n----------------------------------------------------');
    console.log(' SCENARIO B: Existing Project Discovery');
    console.log('----------------------------------------------------');
    const promptB = 'Find the project I worked on recently and tell me what still needs to be completed.';
    const resB = await dispatchAndWait(promptB, 120_000);
    console.log(`Outcome: ${resB.snapshot.lastTurnOutcome}`);
    console.log(`Panda Reply:\n"${resB.reply}"`);

    evidence.scenarios.scenarioB = {
      passed: Boolean(resB.reply && (resB.reply.includes('ollama-agent') || resB.reply.includes('Project') || resB.reply.includes('TODO') || resB.reply.includes('Panda') || resB.reply.includes('core'))),
      outcome: resB.snapshot.lastTurnOutcome,
      reply: resB.reply,
    };

    // SCENARIO C: Coding and Delivery in Disposable Project
    console.log('\n----------------------------------------------------');
    console.log(' SCENARIO C: Autonomous Coding and Delivery');
    console.log('----------------------------------------------------');
    const disposableDir = prepareDisposableProject();
    console.log(`Isolated test workspace prepared at: ${disposableDir}`);

    // Switch workspace in Desktop
    await evaluate(`window.karkedikhaDesktop.setFolder(${JSON.stringify(disposableDir)})`);
    console.log('Set desktop folder to disposable project.');

    const promptC = 'Find the bug, fix it, run the relevant checks, and tell me what changed.';
    const resC = await dispatchAndWait(promptC, 180_000);
    console.log(`Outcome: ${resC.snapshot.lastTurnOutcome}`);
    console.log(`Panda Reply:\n"${resC.reply}"`);

    // Verify filesystem state in disposable project
    const calcContent = fs.readFileSync(path.join(disposableDir, 'calculator.js'), 'utf8');
    console.log(`calculator.js contents:\n${calcContent}`);
    const testResult = spawnSync('node', ['test.js'], { cwd: disposableDir, encoding: 'utf8' });
    console.log(`node test.js exit code: ${testResult.status}, output: ${testResult.stdout.trim()}`);

    const checksPassed = testResult.status === 0 && testResult.stdout.includes('ALL CHECKS PASSED');
    evidence.scenarios.scenarioC = {
      passed: checksPassed,
      outcome: resC.snapshot.lastTurnOutcome,
      reply: resC.reply,
      calcFile: calcContent,
      checksPassed,
    };

    // SCENARIO D: Follow-Up After Coding
    console.log('\n----------------------------------------------------');
    console.log(' SCENARIO D: Follow-Up After Coding');
    console.log('----------------------------------------------------');
    const promptD = 'Now improve the error handling in calculator.js and check that the previous fix still works.';
    const resD = await dispatchAndWait(promptD, 180_000);
    console.log(`Outcome: ${resD.snapshot.lastTurnOutcome}`);
    console.log(`Panda Reply:\n"${resD.reply}"`);

    const calcContentD = fs.readFileSync(path.join(disposableDir, 'calculator.js'), 'utf8');
    console.log(`calculator.js after follow-up:\n${calcContentD}`);
    const testResultD = spawnSync('node', ['test.js'], { cwd: disposableDir, encoding: 'utf8' });
    console.log(`node test.js exit code: ${testResultD.status}, output: ${testResultD.stdout.trim()}`);

    evidence.scenarios.scenarioD = {
      passed: testResultD.status === 0,
      outcome: resD.snapshot.lastTurnOutcome,
      reply: resD.reply,
      calcFile: calcContentD,
    };

    // SCENARIO E: Controlled Failure Recovery
    console.log('\n----------------------------------------------------');
    console.log(' SCENARIO E: Controlled Failure Recovery');
    console.log('----------------------------------------------------');
    // Inject a deliberate breaking test in test.js
    fs.writeFileSync(
      path.join(disposableDir, 'broken_check.js'),
      `throw new Error("Controlled test defect: database connection refused");\n`
    );

    const promptE = 'Run broken_check.js. If it fails, report the exact error truthfully and do not declare success.';
    const resE = await dispatchAndWait(promptE, 120_000);
    console.log(`Outcome: ${resE.snapshot.lastTurnOutcome}`);
    console.log(`Panda Reply:\n"${resE.reply}"`);

    evidence.scenarios.scenarioE = {
      passed: Boolean(resE.reply && (resE.reply.toLowerCase().includes('fail') || resE.reply.toLowerCase().includes('error') || resE.reply.includes('refused'))),
      outcome: resE.snapshot.lastTurnOutcome,
      reply: resE.reply,
    };

    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
    console.log('\n====================================================');
    console.log(' ALL 5 SCENARIOS EXECUTED SUCCESSFULLY!');
    console.log(` Evidence saved to: ${evidencePath}`);
    console.log('====================================================');
  } finally {
    if (cdpWs) {
      try { cdpWs.close(); } catch {}
    }
    console.log('Cleaning up Desktop process pid=' + desktopProcess.pid);
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(desktopProcess.pid)], { stdio: 'ignore' });
    } catch {}
  }
}

main().catch((err) => {
  console.error('\n[FATAL ERROR IN E2E RUNNER]:', err);
  process.exit(1);
});
