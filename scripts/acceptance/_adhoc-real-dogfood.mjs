#!/usr/bin/env node
// DISPOSABLE, untracked ad-hoc driver — not part of the acceptance suite.
// Real, live Hands-off Karke Dikha dogfood run against the ACTUAL
// C:\Projects\ollama-agent repository, using a local llama.cpp server
// (Qwen3.8-Flash-Next) as the coding model instead of Ollama.
//
// Reuses the same production-proven primitives as
// run-task-scoped-autonomy-acceptance.mjs (Journey 2: HANDS-OFF) and
// adhoc-karke-dikha-acceptance-live.mjs — real packaged VSIX, real isolated
// VS Code window over CDP, zero approval clicks, on-disk
// task.json/events.jsonl as ground truth. The one difference: workspacePath
// is the REAL repo (not a disposable fixture), so the model
// plans/mutates/validates/delivers against real production code inside its
// own isolated M15 worktree/branch — the primary checkout is never touched
// (enforced product invariant, verified again at the end of this script).
//
// No product code is modified by this script. Delete this file when done.

import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import {
  resolveVSCode,
  installExtension,
  launchPlainHost,
  terminatePlainHost,
  allocateDebugPort,
  writeUserSettingsForCustomDialogs,
  detectActiveVSCodeUpdater,
} from './plainVsCodeHost.mjs';
import * as ui from './uiDriver.mjs';
import * as board from './boardUiDriver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
// This disposable driver can run under CodexSandboxOffline while the
// repository is owned by the normal Windows user. Scope Git's ownership
// exception to this driver and the known task-worktree root only; production
// processes do not inherit these environment variables.
process.env.GIT_CONFIG_COUNT = '2';
process.env.GIT_CONFIG_KEY_0 = 'safe.directory';
process.env.GIT_CONFIG_VALUE_0 = repoRoot;
process.env.GIT_CONFIG_KEY_1 = 'safe.directory';
process.env.GIT_CONFIG_VALUE_1 = path.join(os.tmpdir(), 'ollama-agent-worktrees', '*');
// KD_EVIDENCE_SUBDIR: distinguishes evidence directories across a sequential
// multi-model comparison run — each model's evidence must survive, never
// overwrite a sibling model's.
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', process.env.KD_EVIDENCE_SUBDIR || 'real-dogfood-llamacpp');
// Dedicated, PERSISTENT profile — deliberately NOT a fresh runStamp-based
// directory. A cloud fallback API key entered once via the interactive
// 'KarkeDikha: Set Cloud Fallback API Key' command lives in this profile's
// own VS Code SecretStorage; reusing the same userDataDir/extensionsDir
// across every future invocation of this script is what lets that key
// survive between runs without ever being read, printed, or re-entered by
// automation. Deliberately NOT the user's real default VS Code profile
// (touching that is out of scope for this disposable harness) and NOT a
// workspace .env (secrets never belong in the repo).
// Keep profiles separate across Windows identities: SecretStorage encryption
// from one account may not be readable by another. Never copy credentials.
const workDir = process.env.KD_PROFILE_DIR
  ? path.resolve(process.env.KD_PROFILE_DIR)
  : path.join(os.tmpdir(), 'oa-karkedikha-persistent-dogfood');
const userDataDir = path.join(workDir, 'user-data');
const extensionsDir = path.join(workDir, 'extensions');
const coreDataDir = path.join(workDir, 'core-data');
const vsixPath = path.join(repoRoot, 'karkedikha.vsix');
// KD_TARGET_WORKSPACE: opens the launched VS Code window on a DIFFERENT
// repository than the one the extension is packaged from — the extension
// itself is still built from `repoRoot` (ollama-agent's own source), but the
// isolated M15 worktree it creates forks from whatever repo the window has
// open. Used for an isolated fixture repo so a real run never creates a
// worktree off ollama-agent's own HEAD and never touches this repository's
// own state.
const targetWorkspace = process.env.KD_TARGET_WORKSPACE
  ? path.resolve(process.env.KD_TARGET_WORKSPACE)
  : repoRoot;

const API_BASE = process.env.KD_API_BASE ?? 'http://127.0.0.1:8080';
const MODEL = process.env.KD_MODEL
  ?? 'D:\\AI\\FlashNext\\UD-IQ3_XXS\\Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf';
// KD_TASK_SEAM='classify-runtime-error-named': a diagnostic-only seam for the
// Case A/B context comparison. Appends one factual pointer sentence — naming
// the function that produces the generic classification, and asking to
// inspect its own definition plus any tests referencing it — through the
// EXISTING production grounding-term extraction (extractReferencedSymbols),
// the same mechanism that already grounds "approveDelivery" in the baseline
// text below. It states no diagnosis, no fix, and no defect location; it is
// the same category of pointer the baseline sentence already contains.
const BASE_TASK_TEXT = 'Investigate why an autonomous delivery failure such as workspace_delivery_conflict '
  + 'is later reported as the generic runtime_error. We observed that approveDelivery appears to '
  + 'record the specific classification and then an outer catch reclassifies it. Determine whether '
  + 'that diagnosis is correct. If it is a real defect, fix the smallest root cause and update the '
  + 'relevant tests. Preserve the existing delivery safety behavior and do not weaken any '
  + 'workspace-dirty, stale-baseline, trusted-dirty, or delivery checks. Run the relevant validation '
  + 'and finish the task.';
// KD_TASK_TEXT: full override, used for fixtures unrelated to the
// classify-runtime-error investigation (e.g. the missing-helper investigation
// acceptance run) — takes priority over the seam logic below.
const TASK_TEXT = process.env.KD_TASK_TEXT
  ? process.env.KD_TASK_TEXT
  : process.env.KD_TASK_SEAM === 'classify-runtime-error-named'
    ? `${BASE_TASK_TEXT} The generic classification is produced by a function named classifyRuntimeError. `
      + 'Inspect its own definition and any existing tests that reference it as part of your investigation.'
    : BASE_TASK_TEXT;

// KD_OVERALL_TIMEOUT_MS: bounds the wait for a model known to be unstable on
// this hardware (CPU spill/stalls) so a stuck run cannot monopolize a
// multi-model comparison sequence — an existing control (this poll timeout),
// not a product change.
const OVERALL_TIMEOUT_MS = process.env.KD_OVERALL_TIMEOUT_MS
  ? Number(process.env.KD_OVERALL_TIMEOUT_MS)
  : 45 * 60 * 1000; // large local quant model, cold start possible
const startedAt = Date.now();

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[real-dogfood +${elapsed}s] ${message}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntil(conditionFn, { timeoutMs, intervalMs = 2000, describe } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await conditionFn();
      if (result && result.done) return result.value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe?.() ?? 'condition'}${lastError ? `; lastError=${lastError.message}` : ''}`);
}

async function screenshot(pageClient, label) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  try {
    const { data } = await pageClient.Page.captureScreenshot({ format: 'png' });
    fs.writeFileSync(path.join(evidenceDir, `${label}.png`), Buffer.from(data, 'base64'));
    log(`screenshot: ${label}.png`);
  } catch (error) {
    log(`screenshot FAILED for ${label}: ${error.message}`);
  }
}

function taskDir(taskId) { return path.join(targetWorkspace, '.ollama-agent', 'autonomous-tasks', taskId); }
function readPersistedTask(taskId) {
  return JSON.parse(fs.readFileSync(path.join(taskDir(taskId), 'task.json'), 'utf8'));
}
function readPersistedEvents(taskId) {
  const file = path.join(taskDir(taskId), 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function setAutonomyMode(client, mode) {
  await ui.evalInWebviewDoc(client, `(() => {
    const select = document.getElementById('autonomy-mode-select');
    if (!select) throw new Error('autonomy-mode-select not found');
    select.value = ${JSON.stringify(mode)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
}

/**
 * `modelOverride`, when given, selects that option in the REAL composer's
 * own #model-select dropdown before submitting — the same explicit per-turn
 * model pick a human would use (AgentPanel.startAutonomousTask's
 * modelOverride parameter, wired through selectTaskModel's userOverride
 * path). Never types/reads credentials; only sets a <select> value already
 * populated by the real provider's own listModels() results. Throws if the
 * exact option string isn't present, rather than silently falling through
 * to automatic selection.
 */
async function submitAutonomousTask(client, text, modelOverride) {
  if (modelOverride) {
    const result = await ui.evalInWebviewDoc(client, `(() => {
      const select = document.getElementById('model-select');
      if (!select) return { found: false, options: [] };
      const options = Array.from(select.options).map(o => o.value);
      const exists = options.includes(${JSON.stringify(modelOverride)});
      if (exists) {
        select.value = ${JSON.stringify(modelOverride)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { found: exists, currentValue: select.value, optionCount: options.length };
    })()`);
    if (!result.found) {
      throw new Error(`model-select has no option "${modelOverride}" (${result.optionCount} options available); cannot select it via the composer.`);
    }
    log(`Selected explicit composer model override: ${result.currentValue}`);
  }
  await ui.evalInWebviewDoc(client, `(() => {
    const textarea = document.getElementById('autonomous-input');
    const btn = document.getElementById('autonomous-start-btn');
    if (!textarea || !btn) throw new Error('autonomous composer not found');
    textarea.value = ${JSON.stringify(text)};
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    if (btn.disabled) throw new Error('autonomous-start-btn is disabled');
    btn.click();
    return true;
  })()`);
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function reportInfraBlockedIfUpdaterActive() {
  const updaters = detectActiveVSCodeUpdater();
  if (updaters.length === 0) return false;
  log(`INFRA_BLOCKED: an active VS Code installer/updater is holding the machine-wide mutex (pid ${updaters[0].pid}).`);
  return true;
}

async function packageAndLaunch() {
  log(`Repo: ${repoRoot}`);
  log(`Persistent profile: ${userDataDir}`);
  // KD_SKIP_PACKAGE=1: reuse an already-built karkedikha.vsix instead of
  // rebuilding — used for a same-build multi-model comparison run, where the
  // packaged build must be byte-identical across every model in the
  // sequence. Identity is reported (sha256 + mtime), never assumed silently.
  if (process.env.KD_SKIP_PACKAGE === '1') {
    if (!fs.existsSync(vsixPath)) throw new Error(`KD_SKIP_PACKAGE=1 but no packaged VSIX found at ${vsixPath}`);
    const buf = fs.readFileSync(vsixPath);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const stat = fs.statSync(vsixPath);
    log(`Reusing existing packaged VSIX (KD_SKIP_PACKAGE=1): ${vsixPath}`);
    log(`  sha256=${sha256}`);
    log(`  mtime=${stat.mtime.toISOString()} size=${stat.size}`);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'vsix-identity.json'), JSON.stringify({ vsixPath, sha256, mtime: stat.mtime.toISOString(), size: stat.size }, null, 2));
  } else {
    log('Building packaged VSIX (npm run package)…');
    execFileSync('npm', ['run', 'package'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    if (!fs.existsSync(vsixPath)) throw new Error(`packaged VSIX not found at ${vsixPath}`);
  }

  // Bounded recovery workaround (disposable script only, not the shared
  // harness): if a real, already-extracted archive build is cached from a
  // prior run, use it directly via resolveCliArgsFromVSCodeExecutablePath
  // and skip resolveVSCode()/downloadAndUnzipVSCode() entirely — an archive
  // build never touches the system installer's mutex, so this also skips the
  // updater-mutex pre-check meant to guard the download/extract path, not an
  // unrelated real VS Code installation's own auto-update (confirmed via
  // process lineage: verified NOT ours before adding this).
  let vscodeExecutablePath;
  let cliArgs;
  const cachedArchiveExe = path.join(repoRoot, '.vscode-test', 'vscode-win32-x64-archive-1.137.0', 'Code.exe');
  if (fs.existsSync(cachedArchiveExe)) {
    log(`Using cached archive VS Code build directly (bypassing resolveVSCode): ${cachedArchiveExe}`);
    vscodeExecutablePath = cachedArchiveExe;
    cliArgs = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  } else {
    if (reportInfraBlockedIfUpdaterActive()) process.exit(3);
    log('Resolving a real VS Code build…');
    ({ vscodeExecutablePath, cliArgs } = await resolveVSCode());
  }

  log('Installing/updating the packaged VSIX into the persistent profile…');
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath });
  writeUserSettingsForCustomDialogs(userDataDir);
  if (process.env.KD_LOCAL_ONLY === '1') {
    const settingsPath = path.join(userDataDir, 'User', 'settings.json');
    const existing = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    existing['ollama-agent.modelRoutingPolicy'] = 'local-only';
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    log('Isolated profile routing policy set to local-only (KD_LOCAL_ONLY=1). Cloud fallback will not be used.');
  }

  // A prior run's force-killed window (taskkill /F, used throughout this
  // script and by terminatePlainHost) skips Electron's normal shutdown, so
  // its SingletonLock-style code.lock can survive in a persistent profile
  // and make the NEXT launch immediately hand off to a now-dead process and
  // exit(0) without ever opening a window. Safe to remove unconditionally:
  // it is a PID lock, not user data, and a genuinely still-running instance
  // recreates it immediately.
  for (const lockName of ['code.lock', 'CodeSingleton.lock', 'DevToolsActivePort']) {
    const lockPath = path.join(userDataDir, lockName);
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { force: true });
      log(`Removed stale lock file from a prior force-killed window: ${lockPath}`);
    }
  }

  const remoteDebuggingPort = await allocateDebugPort();
  log(`Launching VS Code on the REAL repo, persistent profile (debug port ${remoteDebuggingPort})…`);
  const host = launchPlainHost(vscodeExecutablePath, {
    userDataDir,
    extensionsDir,
    workspacePath: targetWorkspace,
    remoteDebuggingPort,
    env: {
      ...process.env,
      KARKEDIKHA_DATA_DIR: coreDataDir,
      ...(process.env.KD_LOCAL_ONLY === '1' ? { KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only' } : {}),
    },
    // The portable archive renderer exits with Electron code 49 on this
    // machine when it attempts GPU initialization. Dogfood is about the real
    // extension workflow, so keep this workaround scoped to the disposable
    // acceptance host; it does not alter product runtime behavior.
    extraArgs: ['--disable-gpu', '--no-sandbox'],
  });
  const page = await pollUntil(async () => {
    if (typeof host?.child?.exitCode === 'number') {
      throw new Error(`the launched VS Code process exited immediately (code ${host.child.exitCode})`);
    }
    const targets = await board.listTargets(remoteDebuggingPort);
    const found = targets.find(t => t.type === 'page');
    return found ? { done: true, value: found } : { done: false };
  }, { timeoutMs: 120000, describe: () => `a workbench page target on port ${remoteDebuggingPort}` });
  const pageClient = await board.connectToTarget(remoteDebuggingPort, page.id);
  await board.waitForWorkbenchDomReady(pageClient);
  log('Workbench DOM ready.');
  return { host, remoteDebuggingPort, pageClient };
}

/**
 * Opens the real native 'Set Cloud Fallback API Key' input box and then
 * STOPS — it never types into it. The box is native VS Code UI belonging to
 * the live Code.exe process, which keeps running (and the box stays open and
 * focused) after this script exits, because the window is never terminated
 * here. A human types the real key directly into the visible window; this
 * automation never reads, prints, copies, or logs it.
 */
async function runSetupCloudKeyMode() {
  const { pageClient } = await packageAndLaunch();
  log('Opening "KarkeDikha: Set Cloud Fallback API Key" via the command palette…');
  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Set Cloud Fallback API Key');
  await board.waitForQuickInputBox(pageClient, 'cloud fallback', { timeoutMs: 15000 });
  await screenshot(pageClient, 'cloud-key-prompt-open');
  log('The native API key prompt is open and focused in the VS Code window on screen.');
  log('This script will NOT type into it and is exiting now — the window stays open.');
  log('Type the real OrcaRouter API key into that box and press Enter (or Escape to cancel).');
  log(`The key is stored only in this profile's own VS Code SecretStorage: ${userDataDir}`);
  // Deliberately no terminatePlainHost() call: the window must survive this
  // process exiting so the still-open, still-focused prompt remains usable.
}

/**
 * Same pattern as runSetupCloudKeyMode, for the NEW 'Set Primary Provider API
 * Key' command (ollama-agent.setApiKey) — opens the real native input box and
 * STOPS. Never types into it; a human types the real key directly into the
 * visible window.
 */
async function runSetupPrimaryKeyMode() {
  const { pageClient } = await packageAndLaunch();
  log('Opening "KarkeDikha: Set Primary Provider API Key" via the command palette…');
  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Set Primary Provider API Key');
  await board.waitForQuickInputBox(pageClient, 'primary provider', { timeoutMs: 15000 });
  await screenshot(pageClient, 'primary-key-prompt-open');
  log('The native API key prompt is open and focused in the VS Code window on screen.');
  log('This script will NOT type into it and is exiting now — the window stays open.');
  log('Type the real OrcaRouter API key into that box and press Enter (or Escape to cancel).');
  log(`The key is stored only in this profile's own VS Code SecretStorage: ${userDataDir}`);
}

/**
 * Reads ONLY the non-secret cloud-fallback readiness summary already
 * rendered by the existing, unmodified onboarding UI — src/onboarding/
 * OnboardingPanel.ts's Privacy section, itself sourced from
 * OnboardingService.assess() -> ProviderGateway.resolveCloudFallback().
 * CloudFallbackReadiness.summary is documented at its declaration as "safe
 * to render directly (never includes the key)" — this reads exactly that
 * rendered text and nothing else. No new product code, no credential value.
 */
async function checkFallbackReadiness(pageClient, remoteDebuggingPort, excludeIds = []) {
  log('Checking fallback readiness via the existing onboarding UI (ProviderGateway.resolveCloudFallback path)…');
  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Setup / Readiness');
  const setupTarget = await pollUntil(async () => {
    const targets = await board.listTargets(remoteDebuggingPort);
    const candidate = targets.find(t => t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith('vscode-webview://') && t.url.includes('/index.html') && !excludeIds.includes(t.id));
    if (!candidate) return { done: false };
    const client = await board.connectToTarget(remoteDebuggingPort, candidate.id);
    const probe = await ui.evalInWebviewDoc(client, `({ h1: document.querySelector('h1')?.textContent ?? null })`).catch(() => ({}));
    if (probe?.h1 === 'KarkeDikha Setup') return { done: true, value: { client, targetId: candidate.id } };
    await client.close();
    return { done: false };
  }, { timeoutMs: 30000, describe: () => 'the KarkeDikha Setup readiness webview to open' });

  await pollUntil(async () => {
    const overallText = await ui.evalInWebviewDoc(setupTarget.client, `document.querySelector('.overall')?.textContent ?? null`);
    return overallText ? { done: true, value: overallText } : { done: false };
  }, { timeoutMs: 30000, intervalMs: 500, describe: () => 'onboarding readiness to finish computing' });

  // Privacy section text only — h2 "Privacy" followed by the cloud-fallback
  // row's plain rendered text (never the key; see the function doc comment).
  const readiness = await ui.evalInWebviewDoc(setupTarget.client, `(() => {
    const headers = Array.from(document.querySelectorAll('h2'));
    const privacyHeader = headers.find(h => h.textContent.trim() === 'Privacy');
    const privacyText = privacyHeader && privacyHeader.nextElementSibling ? privacyHeader.nextElementSibling.textContent.trim() : null;
    return {
      overallText: document.querySelector('.overall')?.textContent ?? null,
      privacyText,
      hasSetUpCloudFallbackButton: Boolean(document.getElementById('setUpCloudFallback')),
    };
  })()`);
  await setupTarget.client.close();
  log(`Onboarding overall: ${readiness.overallText}`);
  log(`Cloud fallback readiness (Privacy section, non-secret): ${readiness.privacyText}`);
  const configured = typeof readiness.privacyText === 'string' && /Cloud fallback configured/i.test(readiness.privacyText);
  return { ...readiness, configured };
}

async function runCheckReadinessOnlyMode() {
  const { host, remoteDebuggingPort, pageClient } = await packageAndLaunch();
  try {
    const readiness = await checkFallbackReadiness(pageClient, remoteDebuggingPort);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'fallback-readiness.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...readiness }, null, 2));
  } finally {
    terminatePlainHost(host.child);
  }
}

async function main() {
  const { host, remoteDebuggingPort, pageClient } = await packageAndLaunch();

  let taskId;
  try {
    // On a genuinely fresh profile onboarding auto-opens; on this persistent,
    // already-onboarded profile it does not (nothing to nag about once
    // ready), so open it explicitly via the command palette instead of
    // passively waiting for it to appear unprompted.
    log('Opening KarkeDikha Setup / Readiness explicitly (persistent profile, may already be configured)…');
    await board.runCommandViaPalette(pageClient, 'KarkeDikha: Setup / Readiness');
    const setupTarget = await pollUntil(async () => {
      const targets = await board.listTargets(remoteDebuggingPort);
      const candidate = targets.find(t => t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith('vscode-webview://') && t.url.includes('/index.html'));
      if (!candidate) return { done: false };
      const client = await board.connectToTarget(remoteDebuggingPort, candidate.id);
      const probe = await ui.evalInWebviewDoc(client, `({ h1: document.querySelector('h1')?.textContent ?? null })`).catch(() => ({}));
      if (probe?.h1 === 'KarkeDikha Setup') return { done: true, value: { client, targetId: candidate.id } };
      await client.close();
      return { done: false };
    }, { timeoutMs: 30000, describe: () => 'the KarkeDikha Setup onboarding webview to open' });
    await screenshot(pageClient, '00-onboarding');

    let lastReadinessLogAt = 0;
    let lastReadinessSnapshot;
    const readiness = await pollUntil(async () => {
      const snapshot = await ui.evalInWebviewDoc(setupTarget.client, `({
        overallText: document.querySelector('.overall')?.textContent ?? null,
        bodyText: document.body?.innerText?.slice(0, 4000) ?? null,
      })`);
      lastReadinessSnapshot = snapshot;
      if (Date.now() - lastReadinessLogAt > 10000) {
        lastReadinessLogAt = Date.now();
        log(`onboarding overall="${snapshot.overallText}"`);
      }
      // Direct-cloud-primary baseline: an unrecognized cloud model name is
      // correctly, understood-ly held to PARTIALLY READY by Karke Dikha's
      // AUTOMATIC-selection-only reliability floor (TaskModelSelection.ts's
      // advisory reliabilityScore heuristic cannot fairly score a name that
      // doesn't match its local-model-oriented patterns) — a real, separate,
      // deliberately NOT-fixed gap (see HANDOFF.md). The submission below
      // uses an EXPLICIT per-turn model override (the same composer
      // mechanism a human model pick uses), which only checks hard
      // requirements, so PARTIALLY READY here is the correct, expected,
      // accepted terminal state for this run — not a real blocker.
      // KD_ACCEPT_NOT_READY=1: some locally installed models (e.g. an
      // installed-but-unrecognized-by-name coding model) can be scored
      // NOT READY by the same advisory heuristic, not just PARTIALLY READY.
      // Proceeding past that badge, with an explicit KD_MODEL_OVERRIDE still
      // required, tests the real question: does the composer's own hard
      // requirement check (independent of this advisory badge) actually
      // refuse the submission, or does it go through? Never used to bypass a
      // genuine hard block — submitAutonomousTask below still throws if the
      // real start button stays disabled.
      const accept = process.env.KD_MODEL_OVERRIDE
        ? (process.env.KD_ACCEPT_NOT_READY === '1' ? ['READY', 'PARTIALLY READY', 'NOT READY'] : ['READY', 'PARTIALLY READY'])
        : ['READY'];
      return accept.includes(snapshot.overallText) ? { done: true, value: snapshot } : { done: false, value: snapshot };
    }, { timeoutMs: 180000, intervalMs: 2000, describe: () => 'onboarding to report overall READY (checking local model connectivity at ' + API_BASE + ')' }).catch(error => {
      log(`onboarding readiness FAILED. Last snapshot: ${JSON.stringify(lastReadinessSnapshot)}`);
      throw error;
    });
    log(`Onboarding readiness: ${readiness.overallText}`);
    await setupTarget.client.close();

    await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
    const webviewClient = await ui.connectToWebviewHost(remoteDebuggingPort, { attempts: 90, delayMs: 500, excludeIds: [setupTarget.targetId] });
    await ui.waitForWebviewContentMounted(webviewClient, { timeoutMs: 45000, readyElementId: 'send-btn' });
    log('KarkeDikha chat webview mounted.');
    await screenshot(pageClient, '01-mounted');

    await pollUntil(async () => {
      const state = await ui.evalInWebviewDoc(webviewClient, `({ sendBtnText: document.getElementById('send-btn')?.textContent ?? null, sendBtnDisabled: document.getElementById('send-btn')?.disabled ?? null })`);
      return state.sendBtnText === 'Send' && state.sendBtnDisabled === false ? { done: true, value: state } : { done: false };
    }, { timeoutMs: 120000, intervalMs: 1500, describe: () => 'the composer to return to a ready Send state' });
    log('Composer ready (local model reachable).');

    // Before submitting anything: check fallback readiness through the real,
    // existing ProviderGateway.resolveCloudFallback() path (via the
    // unmodified onboarding UI), never by inferring it from anywhere else.
    // Reports only the non-secret summary/configured flag — never the key.
    const fallbackReadiness = await checkFallbackReadiness(pageClient, remoteDebuggingPort);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'fallback-readiness.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...fallbackReadiness }, null, 2));
    if (!fallbackReadiness.configured) {
      log(`WARNING: cloud fallback is NOT configured (${fallbackReadiness.privacyText}). Proceeding — this run will only exercise the local failure path.`);
    }

    await ui.clickAutonomousModeButton(webviewClient);
    await sleep(500);

    await setAutonomyMode(webviewClient, 'hands_off');
    log('Autonomy mode set to hands_off.');

    // Correlate this specific submission with its acknowledgement rather than
    // trusting the first task id that becomes visible anywhere in the DOM.
    // reconnectAutonomousTask() (src/ui/AgentPanel.ts) can independently
    // restore an older blocked/terminal task's identity around the same time
    // a fresh submission is in flight (the defect this harness exists to
    // catch) — the ONLY message that authoritatively acknowledges THIS
    // submission is 'autonomousTaskStarted' carrying back the exact
    // submissionId the webview generated for THIS click.
    await ui.instrumentWebviewPostMessage(webviewClient);
    const submissionRequestedAt = new Date().toISOString();
    await submitAutonomousTask(webviewClient, TASK_TEXT, process.env.KD_MODEL_OVERRIDE || undefined);
    log(`Task submitted: "${TASK_TEXT}" (requestedAt=${submissionRequestedAt})`);
    await screenshot(pageClient, '02-submitted');

    const submissionId = await pollUntil(async () => {
      const posted = await ui.readInstrumentedPostedMessages(webviewClient);
      const outbound = (posted ?? []).find(m => m && m.type === 'startAutonomousTask');
      return outbound?.submissionId ? { done: true, value: String(outbound.submissionId) } : { done: false };
    }, { timeoutMs: 15000, intervalMs: 500, describe: () => 'the webview to generate a submissionId for the startAutonomousTask postMessage' });
    log(`submissionId=${submissionId}`);

    const acknowledgement = await pollUntil(async () => {
      const inbound = await ui.readInstrumentedInboundMessages(webviewClient);
      const match = (inbound ?? []).find(m => m && m.type === 'autonomousTaskStarted' && String(m.submissionId ?? '') === submissionId);
      return match ? { done: true, value: match } : { done: false };
    }, {
      timeoutMs: 60000,
      intervalMs: 1000,
      describe: () => `an 'autonomousTaskStarted' acknowledgement carrying submissionId=${submissionId} (never accepting an unrelated task id, e.g. from a stale reconnectAutonomousTask restoration)`,
    });
    taskId = String(acknowledgement.taskId ?? '');
    const attemptId = String(acknowledgement.attemptId ?? '');
    if (!taskId) throw new Error(`autonomousTaskStarted acknowledgement for submissionId=${submissionId} carried no taskId: ${JSON.stringify(acknowledgement)}`);
    log(`taskId=${taskId} attemptId=${attemptId} (correlated to submissionId=${submissionId})`);

    // Lineage check: the durable record this taskId names must actually
    // belong to THIS submission, not merely have a matching id by coincidence
    // of the correlation logic having a bug of its own. A record created
    // before the request was ever sent is definitionally not this run's task.
    const lineageTask = readPersistedTask(taskId);
    if (lineageTask.createdAt < submissionRequestedAt) {
      throw new Error(
        `Lineage check failed: task ${taskId} has createdAt=${lineageTask.createdAt}, `
        + `which is BEFORE this run's submissionRequestedAt=${submissionRequestedAt}. `
        + 'The acknowledged task id does not belong to this submission.',
      );
    }
    log(`Lineage verified: task ${taskId} createdAt=${lineageTask.createdAt} >= submissionRequestedAt=${submissionRequestedAt}.`);

    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'submission-correlation.json'), JSON.stringify({
      submissionRequestedAt,
      submissionId,
      taskId,
      attemptId,
      acknowledgement,
      lineageCreatedAt: lineageTask.createdAt,
      allPostedMessages: await ui.readInstrumentedPostedMessages(webviewClient),
      allInboundMessages: await ui.readInstrumentedInboundMessages(webviewClient),
    }, null, 2));

    if (process.env.KD_KILL_OLLAMA_AFTER_SUBMIT === '1') {
      log('Task is running against local Ollama — killing Ollama now to force the recoverable-failure cloud-fallback path…');
      const killed = spawnSync('taskkill', ['/IM', 'ollama.exe', '/F'], { encoding: 'utf8' });
      const killedApp = spawnSync('taskkill', ['/IM', 'ollama app.exe', '/F'], { encoding: 'utf8' });
      log(`taskkill ollama.exe: ${(killed.stdout || killed.stderr || '').trim()}`);
      log(`taskkill "ollama app.exe": ${(killedApp.stdout || killedApp.stderr || '').trim()}`);
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, 'ollama-killed-at.txt'), new Date().toISOString());
    }

    let lastEventCount = 0;
    let lastShotAt = 0;
    let finalTask;
    try {
      finalTask = await pollUntil(async () => {
        let persisted;
        try {
          persisted = readPersistedTask(taskId);
        } catch {
          return { done: false };
        }
        const events = readPersistedEvents(taskId);
        if (events.length > lastEventCount) {
          for (const e of events.slice(lastEventCount)) {
            if (e.type === 'progress') log(`progress: ${e.payload?.progress ?? ''}`);
            else if (e.type === 'state_transition') log(`state_transition -> ${e.payload?.state ?? persisted.state}`);
            else log(`event: ${e.type}`);
          }
          lastEventCount = events.length;
        }
        if (Date.now() - lastShotAt > 60000) {
          lastShotAt = Date.now();
          await screenshot(pageClient, `progress-${persisted.state}-${Date.now()}`);
        }
        if (TERMINAL_STATES.has(persisted.state) || persisted.state === 'blocked') {
          return { done: true, value: persisted };
        }
        return { done: false };
      }, { timeoutMs: OVERALL_TIMEOUT_MS, intervalMs: 3000, describe: () => `task ${taskId} to reach a terminal/blocked state` });
    } catch (pollError) {
      // KD_CANCEL_ON_TIMEOUT=1: a model already known to stall on this
      // hardware gets a bounded window, then is stopped through the product's
      // OWN cancel control (the same 'cancelTask' postMessage a user's Cancel
      // click sends) rather than left to run unattended or killed at the
      // process level. Evidence is captured either way.
      if (process.env.KD_CANCEL_ON_TIMEOUT === '1') {
        log(`Overall timeout (${OVERALL_TIMEOUT_MS}ms) reached without a terminal/blocked state — sending cancelTask via the real composer's own control…`);
        try {
          await ui.evalInWebviewDoc(webviewClient, `(() => {
            const api = window.__ollamaAgentVsCodeApi;
            if (!api) throw new Error('__ollamaAgentVsCodeApi not present (chat-vscode-api.js not loaded?)');
            api.postMessage({ type: 'cancelTask', taskId: ${JSON.stringify(taskId)} });
            return true;
          })()`);
          const cancelled = await pollUntil(async () => {
            let persisted;
            try { persisted = readPersistedTask(taskId); } catch { return { done: false }; }
            return (persisted.state === 'cancelled' || persisted.state === 'failed') ? { done: true, value: persisted } : { done: false };
          }, { timeoutMs: 60000, intervalMs: 2000, describe: () => `task ${taskId} to reach cancelled/failed after cancelTask` }).catch(() => undefined);
          fs.mkdirSync(evidenceDir, { recursive: true });
          fs.writeFileSync(path.join(evidenceDir, 'stall-cancelled.json'), JSON.stringify({
            reason: 'overall_timeout_exceeded',
            overallTimeoutMs: OVERALL_TIMEOUT_MS,
            taskId,
            cancelledState: cancelled?.state ?? null,
            lastKnownState: (() => { try { return readPersistedTask(taskId).state; } catch { return null; } })(),
          }, null, 2));
          log(`Cancel-on-timeout result: ${cancelled ? `state=${cancelled.state}` : 'no terminal state observed within cancel-wait window'}`);
        } catch (cancelError) {
          log(`cancelTask attempt itself failed: ${cancelError.message}`);
        }
      }
      throw pollError;
    }

    await screenshot(pageClient, '03-final');
    const finalEvents = readPersistedEvents(taskId);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'task.json'), JSON.stringify(finalTask, null, 2));
    fs.writeFileSync(path.join(evidenceDir, 'events.jsonl'), finalEvents.map(e => JSON.stringify(e)).join('\n'));

    log(`FINAL STATE: ${finalTask.state}`);
    log(`qualityGate: ${JSON.stringify(finalTask.qualityGate ?? null)}`);
    log(`validationFailure: ${JSON.stringify(finalTask.validationFailure ?? null)}`);
    log(`failure: ${JSON.stringify(finalTask.failure ?? null)}`);
    log(`githubDelivery: ${JSON.stringify(finalTask.githubDelivery ?? null)}`);
    log(`terminalResult: ${JSON.stringify(finalTask.terminalResult ?? null)}`);
  } finally {
    log('Terminating isolated VS Code window…');
    terminatePlainHost(host.child);
  }

  log('Checking primary repository checkout is untouched…');
  const status = spawnSync('git', ['status', '-sb'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const worktrees = spawnSync('git', ['worktree', 'list'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const taskBranches = spawnSync('git', ['branch', '--list', 'ollama-agent/*'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  log(`primary branch: ${branch}`);
  log(`primary status: ${status || '(clean)'}`);
  log(`worktrees:\n${worktrees}`);
  log(`task branches:\n${taskBranches || '(none)'}`);
  if (targetWorkspace !== repoRoot) {
    const fixtureWorktrees = spawnSync('git', ['worktree', 'list'], { cwd: targetWorkspace, encoding: 'utf8' }).stdout.trim();
    const fixtureBranches = spawnSync('git', ['branch', '--list', 'forge/*'], { cwd: targetWorkspace, encoding: 'utf8' }).stdout.trim();
    log(`fixture repo (${targetWorkspace}) worktrees:\n${fixtureWorktrees}`);
    log(`fixture repo task branches:\n${fixtureBranches || '(none)'}`);
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'post-run-git-state.txt'),
    `branch: ${branch}\nstatus:\n${status}\nworktrees:\n${worktrees}\ntaskBranches:\n${taskBranches}\n`);

  if (process.env.KD_KILL_OLLAMA_AFTER_SUBMIT === '1' && process.env.KD_RESTART_OLLAMA_PATH) {
    log(`Restarting Ollama (best-effort): ${process.env.KD_RESTART_OLLAMA_PATH}`);
    try {
      const child = spawn(process.env.KD_RESTART_OLLAMA_PATH, [], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (error) {
      log(`Ollama restart FAILED: ${error.message}`);
    }
  }

  log(`Done. taskId=${taskId}. Evidence in ${evidenceDir}`);
}

const mode = process.env.KD_SETUP_CLOUD_KEY === '1'
  ? runSetupCloudKeyMode
  : process.env.KD_SETUP_PRIMARY_KEY === '1'
    ? runSetupPrimaryKeyMode
    : process.env.KD_CHECK_FALLBACK_READINESS_ONLY === '1'
      ? runCheckReadinessOnlyMode
      : main;

mode().catch(error => {
  console.error(`FATAL: ${error.stack || error.message}`);
  process.exit(1);
});
