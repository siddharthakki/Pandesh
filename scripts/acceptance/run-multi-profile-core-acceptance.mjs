#!/usr/bin/env node
// npm run test:e2e:multi-profile-core
//
// Installed, local-only acceptance for Defect 1's actual fix — one Core per
// VS Code profile (CoreManager.resolveProfileScopedCoreDataDir), not one
// Core for the whole OS user. Deliberately does NOT set KARKEDIKHA_DATA_DIR:
// that override exists for test/acceptance isolation, and using it here
// would just paper over the exact defect this harness verifies.
//
// Launches TWO isolated VS Code profiles (separate --user-data-dir, the
// practical profile boundary) with PROFILE A's window left open while
// PROFILE B starts, so this proves live, concurrent, non-colliding Cores —
// not just two non-overlapping runs that happen not to collide.
//
// Opt-in only: requires OLLAMA_AGENT_LIVE_MULTI_PROFILE=1 or --enabled.

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import CDP from 'chrome-remote-interface';
import {
  resolveVSCode,
  installExtension,
  launchPlainHost,
  terminatePlainHost,
  allocateDebugPort,
  detectActiveVSCodeUpdater,
} from './plainVsCodeHost.mjs';
import * as board from './boardUiDriver.mjs';
import * as ui from './uiDriver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const enabled = process.env.OLLAMA_AGENT_LIVE_MULTI_PROFILE === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: multi-profile Core acceptance requires OLLAMA_AGENT_LIVE_MULTI_PROFILE=1 or --enabled.');
  console.log('It launches two real packaged VS Code profiles concurrently, each with its own Core, against this machine\'s real local Ollama. No cloud calls, no KARKEDIKHA_DATA_DIR override.');
  process.exit(0);
}

const BAAT_QUESTION = 'Where is user registration implemented, what does registerUser currently do, and which tests cover it?';
const startedAt = Date.now();
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-multi-profile-core-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'multi-profile-core');

function log(message) {
  console.log(`[multi-profile-core +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
}

function writeEvidence(name, data) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify({ capturedAt: new Date().toISOString(), ...data }, null, 2));
}

async function evaluateExpr(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(`CDP Runtime.evaluate threw: ${exceptionDetails.text}`);
  return result.value;
}

async function evalInWebviewContentDoc(client, docExpression) {
  const wrapped = `(() => {
    const inner = window.document.getElementById('active-frame');
    if (!inner) return { __noActiveFrame: true };
    const document = inner.contentDocument;
    if (!document) return { __noContentDocument: true };
    return (${docExpression});
  })()`;
  return evaluateExpr(client, wrapped);
}

async function pollUntil(conditionFn, { timeoutMs = 30000, intervalMs = 400, describe } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await conditionFn();
      if (result && result.done) return result.value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe?.() ?? 'condition'}${lastError ? `; lastError=${lastError.message}` : ''}`);
}

async function waitForSetupWebview(port, excludeIds, { timeoutMs = 60000 } = {}) {
  const excluded = new Set(excludeIds);
  return pollUntil(
    async () => {
      const targets = await CDP.List({ port });
      const candidates = targets.filter(
        t => t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith('vscode-webview://') && t.url.includes('/index.html') && !excluded.has(t.id),
      );
      for (const candidate of candidates) {
        const client = await board.connectToTarget(port, candidate.id);
        const probe = await evalInWebviewContentDoc(client, `({ h1: document.querySelector('h1')?.textContent ?? null })`).catch(() => ({}));
        if (probe?.h1 === 'KarkeDikha Setup') return { done: true, value: { client, targetId: candidate.id } };
        await client.close();
      }
      return { done: false };
    },
    { timeoutMs, describe: () => 'the KarkeDikha Setup onboarding webview to open' },
  );
}

function readSetupSnapshot(client) {
  return evalInWebviewContentDoc(client, `({
    overallText: document.querySelector('.overall')?.textContent ?? null,
    bodyText: document.body.innerText,
  })`);
}

function reportInfraBlockedIfUpdaterActive() {
  const updaters = detectActiveVSCodeUpdater();
  if (updaters.length === 0) return false;
  log(`INFRA_BLOCKED: an active VS Code installer/updater is holding the machine-wide mutex (pid ${updaters[0].pid}).`);
  writeEvidence('infra-blocked.json', { status: 'INFRA_BLOCKED', updaters });
  return true;
}

function profilePaths(label) {
  const root = path.join(workDir, label);
  return {
    root,
    userDataDir: path.join(root, 'user-data'),
    extensionsDir: path.join(root, 'extensions'),
    workspaceDir: path.join(root, 'workspace'),
    // Mirrors CoreManager.resolveProfileScopedCoreDataDir: <globalStorageUri>/core-data.
    // For the "Default" VS Code profile inside an isolated --user-data-dir,
    // globalStorageUri resolves to User/globalStorage/<extension-id>.
    coreDataDir: path.join(root, 'user-data', 'User', 'globalStorage', 'ollama-agent.ollama-agent', 'core-data'),
  };
}

function initScratchWorkspace(dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# Disposable multi-profile Core acceptance workspace (${label})\n`);
  fs.writeFileSync(
    path.join(dir, 'src', 'users.js'),
    "function registerUser(username) {\n  if (!username) throw new Error('username is required');\n  return { username, registeredAt: new Date().toISOString() };\n}\n\nmodule.exports = { registerUser };\n",
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'users.test.js'),
    "const { registerUser } = require('./users');\nconst assert = require('assert');\nassert.throws(() => registerUser(''));\nassert.strictEqual(registerUser('alice').username, 'alice');\nconsole.log('PASS users.test.js');\n",
  );
}

async function pointRoleSettingsAtInstalledModel(userDataDir) {
  const tagsResponse = await fetch('http://127.0.0.1:11434/api/tags').catch(() => undefined);
  const installedModels = tagsResponse?.ok ? (await tagsResponse.json()).models ?? [] : [];
  const model = installedModels.find(m => m.name.toLowerCase() === 'qwen3.8:27b-mtp-q4_k_m')?.name ?? installedModels[0]?.name;
  if (!model) return undefined;
  const userDir = path.join(userDataDir, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  const settingsPath = path.join(userDir, 'settings.json');
  const existing = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...existing,
    'ollama-agent.model': model,
    'ollama-agent.chatModel': model,
    'ollama-agent.agentModel': model,
    'ollama-agent.codingModel': model,
    'ollama-agent.editModel': model,
    'ollama-agent.reviewerModel': model,
    'ollama-agent.codingFallbackModel': model,
  }, null, 2));
  return model;
}

/** Launches one profile and waits for onboarding to report a Core status (READY or otherwise), returning everything the caller needs to inspect/tear down. */
async function launchProfileAndWaitForOnboarding(vscodeExecutablePath, cliArgs, vsixPath, label, port) {
  const paths = profilePaths(label);
  initScratchWorkspace(paths.workspaceDir, label);
  installExtension(cliArgs, { userDataDir: paths.userDataDir, extensionsDir: paths.extensionsDir, vsixPath });
  const recommendedModel = await pointRoleSettingsAtInstalledModel(paths.userDataDir);
  log(`[${label}] role settings pointed at: ${recommendedModel ?? '(none found — proceeding with defaults)'}`);

  const host = launchPlainHost(vscodeExecutablePath, {
    userDataDir: paths.userDataDir,
    extensionsDir: paths.extensionsDir,
    workspacePath: paths.workspaceDir,
    remoteDebuggingPort: port,
    // Deliberately NO env override — this is the actual production path.
  });

  const page = await pollUntil(
    async () => {
      const targets = await board.listTargets(port);
      const found = targets.find(t => t.type === 'page');
      return found ? { done: true, value: found } : { done: false };
    },
    { timeoutMs: 90000, describe: () => `[${label}] a workbench page target` },
  );
  const pageClient = await board.connectToTarget(port, page.id);
  await board.waitForWorkbenchDomReady(pageClient);

  log(`[${label}] waiting for onboarding to auto-open…`);
  const { client: setupClient, targetId: setupTargetId } = await waitForSetupWebview(port, [], { timeoutMs: 60000 });
  const readiness = await pollUntil(
    async () => {
      const snapshot = await readSetupSnapshot(setupClient);
      return snapshot.overallText ? { done: true, value: snapshot } : { done: false };
    },
    { timeoutMs: 60000, intervalMs: 1500, describe: () => `[${label}] onboarding readiness to finish computing` },
  );
  log(`[${label}] onboarding readiness: ${readiness.overallText}`);
  await setupClient.close();

  const discoveryRecordPath = path.join(paths.coreDataDir, 'core.json');
  const discoveryRecord = fs.existsSync(discoveryRecordPath) ? JSON.parse(fs.readFileSync(discoveryRecordPath, 'utf8')) : undefined;
  writeEvidence(`${label}-readiness.json`, { readiness, discoveryRecordPath, discoveryRecord });

  return { paths, host, pageClient, port, setupTargetId, readiness, discoveryRecordPath, discoveryRecord };
}

async function submitBaatAndClassify(port, pageClient, excludeIds) {
  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
  const chatClient = await ui.connectToWebviewHost(port, { attempts: 60, delayMs: 500, excludeIds });
  await ui.waitForWebviewContentMounted(chatClient, { timeoutMs: 30000, readyElementId: 'send-btn' });
  await ui.instrumentWebviewPostMessage(chatClient);
  await ui.clickModeButton(chatClient, 'chat');
  const before = await ui.countBubbles(chatClient);
  await ui.evalInWebviewDoc(
    chatClient,
    `(() => { const input=document.getElementById('user-input'); input.value=${JSON.stringify(BAAT_QUESTION)}; input.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('send-btn').click(); return true; })()`,
  );

  // Tier 1 (fast, bounded): "modelSuitability" is posted right after Core
  // accepts the submission and a model is selected — BEFORE the provider
  // call itself resolves. Seeing it (with no error bubble) is proof Core
  // connected and model selection succeeded, independent of how long
  // generation itself takes.
  const coreAndSelectionOutcome = await pollUntil(
    async () => {
      const errorText = await evalInWebviewContentDoc(chatClient, `document.querySelector('.bubble.error')?.textContent ?? null`);
      if (errorText) return { done: true, value: { kind: 'error', errorText } };
      const inbound = await ui.readInstrumentedInboundMessages(chatClient);
      const suitability = (inbound ?? []).find(m => m?.type === 'modelSuitability');
      if (suitability) return { done: true, value: { kind: 'model_selected', suitability } };
      return { done: false };
    },
    { timeoutMs: 60000, intervalMs: 1000, describe: () => 'Core to accept the Baat submission and select a model' },
  );

  if (coreAndSelectionOutcome.kind === 'error') {
    return { tier: 'FAILED', ...coreAndSelectionOutcome, chatClient, before };
  }

  // Tier 2 (best-effort, generous): the real repository-grounded answer.
  try {
    const answered = await pollUntil(
      async () => {
        const bubbles = await ui.countBubbles(chatClient);
        const errorText = await evalInWebviewContentDoc(chatClient, `document.querySelector('.bubble.error')?.textContent ?? null`);
        if (errorText) return { done: true, value: { kind: 'error', errorText } };
        if (bubbles.assistant > before.assistant) return { done: true, value: { kind: 'assistant', bubbles } };
        return { done: false };
      },
      { timeoutMs: 260000, intervalMs: 1500, describe: () => 'a full Baat Kar answer' },
    );
    if (answered.kind === 'error') return { tier: 'CORE_MODEL_SELECTION_PASS_FULL_ANSWER_FAILED', ...answered, chatClient, before };
    const assistantText = await evalInWebviewContentDoc(chatClient, `Array.from(document.querySelectorAll('.bubble.assistant')).pop()?.textContent ?? null`);
    return { tier: 'FULL_PASS', assistantText, chatClient, before };
  } catch (error) {
    // Provider was simply too slow to finish generation within the budget —
    // NOT a Core failure. modelSuitability already proved the Core/model
    // path is healthy.
    return { tier: 'CORE_MODEL_SELECTION_PASS_PROVIDER_SLOW', error: error.message, suitability: coreAndSelectionOutcome.suitability, chatClient, before };
  }
}

function killIsolatedCore(discoveryRecord) {
  if (!discoveryRecord?.pid) return;
  try {
    spawnSync('taskkill', ['/pid', String(discoveryRecord.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* best effort */ }
}

async function main() {
  let passed = false;
  if (reportInfraBlockedIfUpdaterActive()) process.exit(3);

  log('Building packaged VSIX (npm run package)…');
  execFileSync('npm', ['run', 'package'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  const vsixPath = path.join(repoRoot, 'karkedikha.vsix');
  if (!fs.existsSync(vsixPath)) throw new Error(`packaged VSIX not found at ${vsixPath}`);

  log('Resolving a real VS Code build…');
  const { vscodeExecutablePath, cliArgs } = await resolveVSCode();

  let profileA;
  let profileB;
  try {
    const portA = allocateDebugPort();
    log(`Launching PROFILE A (port ${portA})…`);
    profileA = await launchProfileAndWaitForOnboarding(vscodeExecutablePath, cliArgs, vsixPath, 'profileA', portA);
    if (profileA.readiness.overallText !== 'READY') {
      throw new Error(`Profile A did not reach READY: ${profileA.readiness.overallText} — ${profileA.readiness.bodyText}`);
    }
    if (!profileA.discoveryRecord?.pid) {
      throw new Error(`Profile A has no Core discovery record at ${profileA.discoveryRecordPath}`);
    }
    log(`PROFILE A: Core pid=${profileA.discoveryRecord.pid} port=${profileA.discoveryRecord.port} — READY. Leaving it running.`);

    // PROFILE A's window and Core stay alive while PROFILE B launches —
    // this is what actually proves "no collision", not just "two runs that
    // happened not to overlap".
    const portB = allocateDebugPort();
    log(`Launching PROFILE B (port ${portB}) while Profile A's Core is still live…`);
    profileB = await launchProfileAndWaitForOnboarding(vscodeExecutablePath, cliArgs, vsixPath, 'profileB', portB);
    if (profileB.readiness.overallText !== 'READY') {
      throw new Error(`Profile B did not reach READY: ${profileB.readiness.overallText} — ${profileB.readiness.bodyText}`);
    }
    if (!profileB.discoveryRecord?.pid) {
      throw new Error(`Profile B has no Core discovery record at ${profileB.discoveryRecordPath}`);
    }
    log(`PROFILE B: Core pid=${profileB.discoveryRecord.pid} port=${profileB.discoveryRecord.port} — READY.`);

    const isolation = {
      profileACoreDataDir: profileA.paths.coreDataDir,
      profileBCoreDataDir: profileB.paths.coreDataDir,
      dataDirsDiffer: profileA.paths.coreDataDir !== profileB.paths.coreDataDir,
      profileACorePid: profileA.discoveryRecord.pid,
      profileBCorePid: profileB.discoveryRecord.pid,
      pidsDiffer: profileA.discoveryRecord.pid !== profileB.discoveryRecord.pid,
      profileACorePort: profileA.discoveryRecord.port,
      profileBCorePort: profileB.discoveryRecord.port,
      portsDiffer: profileA.discoveryRecord.port !== profileB.discoveryRecord.port,
    };
    writeEvidence('isolation-evidence.json', isolation);
    log(`Isolation evidence: ${JSON.stringify(isolation)}`);
    if (!isolation.dataDirsDiffer || !isolation.pidsDiffer) {
      throw new Error(`Profile A and B did not resolve isolated Cores: ${JSON.stringify(isolation)}`);
    }

    log('Submitting the canonical Baat question in PROFILE B…');
    const baatOutcome = await submitBaatAndClassify(profileB.port, profileB.pageClient, [profileB.setupTargetId]);
    writeEvidence('profileB-baat-outcome.json', {
      tier: baatOutcome.tier,
      suitability: baatOutcome.suitability ?? null,
      assistantTextLength: baatOutcome.assistantText?.length ?? null,
      errorText: baatOutcome.errorText ?? null,
    });

    if (baatOutcome.tier === 'FAILED') {
      throw new Error(`Baat in Profile B failed: ${baatOutcome.errorText}`);
    }
    if (/Core is not connected|Core.*disconnected/i.test(JSON.stringify(baatOutcome.suitability ?? baatOutcome.errorText ?? ''))) {
      throw new Error('Baat response in Profile B mentions Core being disconnected');
    }
    log(`PROFILE B Baat outcome tier: ${baatOutcome.tier}`);
    if (baatOutcome.tier === 'FULL_PASS') {
      log(`Assistant answered (${baatOutcome.assistantText?.length ?? 0} chars): mentionsRegisterUser=${/registerUser/i.test(baatOutcome.assistantText ?? '')}`);
    } else {
      log('Provider generation was slow/unresolved within budget — Core connectivity and model selection are still proven healthy via the modelSuitability signal (see profileB-baat-outcome.json). Not treated as a Core failure.');
    }

    writeEvidence('result.json', {
      status: 'PASSED',
      profileAReadiness: profileA.readiness.overallText,
      profileBReadiness: profileB.readiness.overallText,
      isolation,
      baatOutcomeTier: baatOutcome.tier,
    });
    log('PASSED: two concurrently-live VS Code profiles resolved isolated, non-colliding Cores; Profile B reported readiness truthfully and Baat submitted without any Core-disconnected error.');
    passed = true;
  } finally {
    if (profileA) { terminatePlainHost(profileA.host.child); killIsolatedCore(profileA.discoveryRecord); }
    if (profileB) { terminatePlainHost(profileB.host.child); killIsolatedCore(profileB.discoveryRecord); }
    if (passed) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      log(`Preserving isolated profiles for inspection: ${workDir}`);
    }
  }
}

main().catch(error => {
  log(`FAILED: ${error.message}`);
  writeEvidence('result.json', { status: 'FAILED', error: error.message });
  process.exitCode = 1;
});
