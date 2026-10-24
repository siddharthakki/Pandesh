#!/usr/bin/env node
// M38 — packaged (real VSIX, real Electron, real webview) acceptance for the
// governed external-tool fabric (Saath Kar: repository inspection ->
// governed_research -> github_comment_on_issue, suspend/resume across a real
// Extension Host restart, approve/deny/cancel).
//
// Reuses, rather than reinvents: plainVsCodeHost.mjs (VS Code
// download/install/launch — the SAME real, unmodified VSIX install/launch
// path windowsPackagedAcceptanceHarness.mjs and m36/m32 packaged dogfood
// already use), boardUiDriver.mjs (command palette + CDP target plumbing),
// uiDriver.mjs (webview DOM helpers), and the M38 Core-only fixtures
// (m38ScriptedOllamaFixture.mjs, m38ResearchFixture.mjs, fakeGh/ghFake.mjs,
// m38FixtureConstants.mjs) already proven end-to-end by
// run-m38-core-only-smoke.mjs. Direct Core evidence is read the same way
// m31CoreEvidence.mjs/run-m32-packaged-dogfood.mjs already do: the isolated
// core.db SQLite file opened read-only with node:sqlite in the isolated
// KARKEDIKHA_DATA_DIR this harness itself owns — never the authenticated Core
// HTTP bearer token, which lives only in the Extension Host's SecretStorage
// and which this out-of-process harness has no legitimate access to.
//
// Restart mechanism (Scenarios C/D) mirrors run-webview-approval-dogfood.mjs:
// a graceful `window.close()` dispatched over CDP against the main workbench
// page target — never a process-tree kill. This is a hard architectural
// requirement, not merely a style choice: CoreLauncher spawns Core with
// `detached: true` + `child.unref()` specifically so Core survives a normal
// Extension Host exit; an experiment reproducing that exact spawn shape
// confirmed a graceful self-exit leaves the detached child alive, while a
// Windows `taskkill /T /F` process-tree kill on the parent also kills the
// detached child (Windows enumerates live descendants by ParentProcessId at
// kill time, irrespective of detached/unref status). So only the graceful
// path can satisfy "restart the Extension Host, keep Core running."
//
// Scenarios (selected via --only=b,c,d,e or KARKEDIKHA_M38_ONLY):
//   b  non-restart packaged smoke (three capabilities, one approval, exactly
//      one mutation, grounded final answer, continuation row deleted on
//      terminal)
//   c  approve-after-restart (kill Extension Host without clicking, keep
//      Core alive, relaunch, restore card, approve, exactly one mutation,
//      no duplicate approval/continuation row)
//   d  deny-after-restart (same restart mechanism, deny instead; zero
//      mutations ever, durable across a further restart)
//   e  cancellation while a governed capability adapter is genuinely
//      in-flight (fencing prevents a late fixture completion from registering)
//
// Exit codes: 0 pass, 1 fail, 3 infra-blocked (VS Code updater mutex held).

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveVSCode,
  installExtension,
  launchPlainHost,
  allocateDebugPort,
  writeUserSettingsForCustomDialogs,
  terminatePlainHost,
  detectActiveVSCodeUpdater,
} from './plainVsCodeHost.mjs';
import * as board from './boardUiDriver.mjs';
import * as ui from './uiDriver.mjs';
import { startScriptedOllamaFixture } from './fixtures/m38ScriptedOllamaFixture.mjs';
import { startResearchFixture } from './fixtures/m38ResearchFixture.mjs';
import {
  M38_FIXTURE_MODEL,
  M38_REPO_FIXTURE_FILE_NAME,
  M38_REPO_FIXTURE_FILE_CONTENT,
  M38_GITHUB_REPOSITORY,
  M38_GITHUB_COMMENT_MARKER,
  m38FinalAnswer,
  m38DeniedFinalAnswer,
} from './fixtures/m38FixtureConstants.mjs';
import * as coreEvidence from './m38CoreEvidence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-m38-packaged-${runStamp}`);
const evidenceRoot = path.join(repoRoot, '.acceptance-evidence', 'm38');
const ghFakeScript = path.join(__dirname, 'fixtures', 'fakeGh', 'ghFake.mjs');
const vsixPath = path.resolve(process.env.KARKEDIKHA_ACCEPTANCE_VSIX ?? path.join(repoRoot, 'karkedikha-win32-x64.vsix'));

const EXIT_INFRA_BLOCKED = 3;
const startedAt = Date.now();
const trackedChildren = [];

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[m38-packaged-acceptance +${elapsed}s] ${message}`);
}

async function pollUntil(conditionFn, { timeoutMs = 30000, intervalMs = 400, describe } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await conditionFn();
      if (last && last.done) return last.value;
    } catch (error) {
      // Transient errors (e.g. CDP port not yet listening, webview target not
      // yet navigated) are expected while polling — retry until the deadline
      // rather than failing on the first attempt.
      lastError = error;
      last = undefined;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe ? describe() : 'condition'}; last=${JSON.stringify(last?.value)}; lastError=${lastError?.message ?? 'none'}`);
}

function selectScenarios() {
  const idx = process.argv.indexOf('--only=');
  const raw = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)
    ?? process.env.KARKEDIKHA_M38_ONLY;
  const all = ['b', 'c', 'd', 'e'];
  if (!raw) return all;
  const requested = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const invalid = requested.filter((s) => !all.includes(s));
  if (invalid.length > 0) throw new Error(`unknown scenario(s): ${invalid.join(',')} (valid: ${all.join(',')})`);
  return requested;
}

function reportInfraBlockedIfUpdaterActive() {
  const updaters = detectActiveVSCodeUpdater();
  if (updaters.length === 0) return false;
  log(`INFRA_BLOCKED: a VS Code installer/updater is holding the machine-wide mutex (pid ${updaters[0].pid}).`);
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, 'infra-blocked.json'), JSON.stringify({ status: 'INFRA_BLOCKED', updaters }, null, 2));
  return true;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ── Webview DOM helpers (M38-specific: capability approval cards) ──────────

async function setMode(client, mode) {
  await ui.clickModeButton(client, mode);
}

async function sendChatMessage(client, text) {
  await ui.evalInWebviewDoc(
    client,
    `(() => {
      const input = document.getElementById('user-input');
      const btn = document.getElementById('send-btn');
      if (!input || !btn) throw new Error('chat composer not found');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return true;
    })()`,
  );
}

/** Snapshot of every rendered capability-approval card (both the live
 * post-suspend render and the restart-restored render use the identical DOM
 * shape — see media/chat.js addRestoredCapabilityApprovalCard). */
async function readCapabilityApprovalCards(client) {
  return ui.evalInWebviewDoc(
    client,
    `Array.from(document.querySelectorAll('.capability-approval-card')).map((card) => ({
      approvalId: card.id.replace('capability-approval-', ''),
      resolved: card.classList.contains('resolved'),
      titleText: card.querySelector('strong')?.textContent ?? null,
      detailText: card.querySelector('p')?.textContent ?? null,
      approveDisabled: card.querySelector('button.btn-primary')?.disabled ?? null,
      denyDisabled: card.querySelector('button.btn-danger')?.disabled ?? null,
      approvalIdDataset: card.querySelector('button.btn-primary')?.dataset.approvalId ?? null,
      attemptIdDataset: card.querySelector('button.btn-primary')?.dataset.attemptId ?? null,
      toolNameDataset: card.querySelector('button.btn-primary')?.dataset.toolName ?? null,
      requestedActionDigestDataset: card.querySelector('button.btn-primary')?.dataset.requestedActionDigest ?? null,
    }))`,
  );
}

async function waitForActionableCapabilityApprovalCard(client, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  return pollUntil(
    async () => {
      const cards = await readCapabilityApprovalCards(client);
      const actionable = cards.find((c) => !c.resolved && c.approveDisabled === false);
      return actionable ? { done: true, value: actionable } : { done: false, value: cards };
    },
    { timeoutMs, intervalMs, describe: () => 'an actionable (non-resolved) capability-approval card' },
  );
}

async function clickCapabilityApprovalButton(client, approvalId, resolution) {
  const selector = resolution === 'approved' ? 'button.btn-primary' : 'button.btn-danger';
  await ui.evalInWebviewDoc(
    client,
    `(() => {
      const card = document.getElementById('capability-approval-${approvalId}');
      if (!card) throw new Error('capability-approval-${approvalId} card not found');
      const btn = card.querySelector('${selector}');
      if (!btn) throw new Error('approval action button not found on card ${approvalId}');
      if (btn.disabled) throw new Error('approval action button is disabled on card ${approvalId}');
      btn.click();
      return true;
    })()`,
  );
}

/**
 * A freshly-mounted webview can accept input before CoreManager's async
 * connect handshake to the just-spawned Core finishes, in which case the
 * send is silently rejected (a structured `{type:'error', ...}` posted into
 * the webview) with no request row ever created — see
 * run-m32-packaged-dogfood.mjs's `sendWithCoreConnectedRetry` for the same,
 * previously-diagnosed race. Retries the send until a request row appears in
 * Core's own DB (real acceptance), surfacing the freshest inbound diagnostic
 * messages on every attempt for evidence.
 */
async function submitAndAwaitRequestRow(scenario, client, prompt, { maxAttempts = 6, retryDelayMs = 4000, perAttemptTimeoutMs = 8000 } = {}) {
  let lastDiagnostics = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = ((await ui.readInstrumentedInboundMessages(client)) ?? []).length;
    await sendChatMessage(client, prompt);
    const deadline = Date.now() + perAttemptTimeoutMs;
    while (Date.now() < deadline) {
      const request = await coreEvidence.findRequestByMessage(scenario.globalDataDir, prompt).catch(() => null);
      if (request) return request;
      await new Promise((r) => setTimeout(r, 400));
    }
    const inbound = (await ui.readInstrumentedInboundMessages(client)) ?? [];
    lastDiagnostics = inbound.slice(before);
    log(`submit attempt ${attempt}/${maxAttempts} not yet accepted by Core; fresh inbound messages=${JSON.stringify(lastDiagnostics)}`);
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Core never accepted the submission "${prompt.slice(0, 60)}..." after ${maxAttempts} attempts; lastDiagnostics=${JSON.stringify(lastDiagnostics)}`);
}

async function readAssistantBubbles(client) {
  return ui.evalInWebviewDoc(client, `Array.from(document.querySelectorAll('.bubble.assistant')).map((b) => b.textContent)`);
}

// ── Window lifecycle ─────────────────────────────────────────────────────

async function waitForWorkbenchPageTarget(cdpPort, { timeoutMs = 45000 } = {}) {
  return pollUntil(
    async () => {
      const targets = await board.listTargets(cdpPort);
      const page = targets.find((t) => t.type === 'page');
      return page ? { done: true, value: page } : { done: false, value: targets.length };
    },
    { timeoutMs, describe: () => `the workbench page target on CDP port ${cdpPort}` },
  );
}

async function openChatPanel(cdpPort) {
  const pageTarget = await waitForWorkbenchPageTarget(cdpPort);
  const pageClient = await board.connectToTarget(cdpPort, pageTarget.id);
  await pageClient.Page.bringToFront();
  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
  const { client: webviewClient, targetId: webviewTargetId } = await ui.connectToWebviewHostTarget(cdpPort, { attempts: 60, delayMs: 500 });
  await ui.waitForWebviewContentMounted(webviewClient, { timeoutMs: 30000, readyElementId: 'send-btn' });
  await ui.instrumentWebviewPostMessage(webviewClient);
  await new Promise((r) => setTimeout(r, 5000)); // let CoreManager's async connect handshake settle (see run-m32-packaged-dogfood.mjs's identical rationale)
  return { pageClient, webviewClient, pageTargetId: pageTarget.id, webviewTargetId };
}

function fixtureEnv({ globalDataDir, ollamaBaseUrl, researchProviderUrl, fakeGhDataDir }) {
  return {
    KARKEDIKHA_DATA_DIR: globalDataDir,
    KARKEDIKHA_OLLAMA_URL: ollamaBaseUrl,
    KARKEDIKHA_DEFAULT_MODEL: M38_FIXTURE_MODEL,
    KARKEDIKHA_SEARXNG_URL: researchProviderUrl,
    KARKEDIKHA_GITHUB_REPOSITORY: M38_GITHUB_REPOSITORY,
    KARKEDIKHA_TEST_GH_EXECUTOR_SCRIPT: ghFakeScript,
    KARKEDIKHA_FAKE_GH_DATA_DIR: fakeGhDataDir,
  };
}

/** Explicit model-role settings so AgentPanel's real model-selection logic
 * resolves to the scripted fixture model for every role rather than relying
 * on automatic discovery/heuristics against an unfamiliar model name (mirrors
 * m34AcceptanceHarness.mjs's realModelRoleSettings convention). */
function fixtureModelSettings(ollamaBaseUrl, researchProviderUrl) {
  return {
    // AgentPanel's own client-side model-selection (`selectModelForTask` ->
    // `provider.listModels()`) queries Ollama at this setting's URL — a
    // SEPARATE code path from Core's KARKEDIKHA_OLLAMA_URL env var (which
    // only Core's own model-backend/researchRunner read). Without this, the
    // fixture model is correctly resolved as the requested model string but
    // `candidate.available` is false (real default Ollama at :11434 has
    // never heard of it), and selectTaskModel rejects every candidate with
    // "Model is not available." before Core is ever asked anything.
    'ollama-agent.apiBase': ollamaBaseUrl,
    'ollama-agent.searxngUrl': researchProviderUrl,
    'ollama-agent.model': M38_FIXTURE_MODEL,
    'ollama-agent.chatModel': M38_FIXTURE_MODEL,
    'ollama-agent.agentModel': M38_FIXTURE_MODEL,
    'ollama-agent.codingModel': M38_FIXTURE_MODEL,
    'ollama-agent.editModel': M38_FIXTURE_MODEL,
    'ollama-agent.reviewerModel': M38_FIXTURE_MODEL,
    'ollama-agent.codingFallbackModel': M38_FIXTURE_MODEL,
  };
}

async function readMutationCount(fakeGhDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(fakeGhDataDir, 'mutationCount.json'), 'utf8')).count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Builds one fresh isolated profile+workspace+fixtures set. Every scenario
 * gets its own (never shared), per the task's "fresh isolated profile" rule
 * for scenarios B/C/D.
 */
async function buildIsolatedScenario(name, { vscodeExecutablePath, cliArgs }) {
  const scenarioRoot = path.join(workDir, name);
  const userDataDir = path.join(scenarioRoot, 'user-data');
  const extensionsDir = path.join(scenarioRoot, 'extensions');
  const globalDataDir = path.join(scenarioRoot, 'global-data');
  const workspaceDir = path.join(scenarioRoot, 'workspace');
  const fakeGhDataDir = path.join(scenarioRoot, 'fake-gh-data');
  for (const dir of [userDataDir, extensionsDir, globalDataDir, workspaceDir, fakeGhDataDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, M38_REPO_FIXTURE_FILE_NAME), M38_REPO_FIXTURE_FILE_CONTENT, 'utf8');

  writeUserSettingsForCustomDialogs(userDataDir);
  const settingsPath = path.join(userDataDir, 'User', 'settings.json');
  const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const ollamaFixture = await startScriptedOllamaFixture({ logFilePath: path.join(scenarioRoot, 'ollama-fixture.log') });
  const researchFixture = await startResearchFixture();

  fs.writeFileSync(settingsPath, JSON.stringify({ ...existing, ...fixtureModelSettings(ollamaFixture.baseUrl, researchFixture.providerUrl) }, null, 2));

  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath });

  const env = fixtureEnv({
    globalDataDir,
    ollamaBaseUrl: ollamaFixture.baseUrl,
    researchProviderUrl: researchFixture.providerUrl,
    fakeGhDataDir,
  });

  return {
    name, scenarioRoot, userDataDir, extensionsDir, globalDataDir, workspaceDir, fakeGhDataDir,
    ollamaFixture, researchFixture, env,
    async launch(label) {
      const cdpPort = allocateDebugPort();
      const launched = launchPlainHost(vscodeExecutablePath, {
        userDataDir, extensionsDir, workspacePath: workspaceDir, remoteDebuggingPort: cdpPort, env,
      });
      trackedChildren.push({ pid: launched.child.pid, label: `${name}:${label}` });
      return { cdpPort, launcher: launched.child, launchArgs: launched.args };
    },
    async cleanup() {
      await ollamaFixture.close().catch(() => {});
      await researchFixture.close().catch(() => {});
      const record = coreEvidence.readDiscoveryRecord(globalDataDir);
      if (record?.pid && coreEvidence.isPidAlive(record.pid)) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(record.pid), '/F'], { stdio: 'ignore', windowsHide: true });
        else { try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
    },
  };
}

function writeScenarioEvidence(name, evidence) {
  const dir = path.join(evidenceRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), ...evidence }, null, 2));
  return dir;
}

async function captureEvidence(client, dir, label) {
  try { await ui.captureFailureDiagnostics(client, dir, label); } catch { /* best effort */ }
}

// ══════════════════════════════════════════════════════════════════════════
// Scenario B — packaged non-restart smoke
// ══════════════════════════════════════════════════════════════════════════

async function runScenarioB({ vscodeExecutablePath, cliArgs }) {
  const name = 'scenario-b-non-restart-smoke';
  log(`=== ${name} ===`);
  const scenario = await buildIsolatedScenario(name, { vscodeExecutablePath, cliArgs });
  const evidenceDir = writeScenarioEvidence(name, { status: 'started' });
  let pageClient;
  let webviewClient;
  const prompt = 'Inspect the repository problem, research the relevant documentation, and prepare the governed GitHub issue comment.';
  try {
    const { cdpPort } = await scenario.launch('main');
    ({ pageClient, webviewClient } = await openChatPanel(cdpPort));
    await setMode(webviewClient, 'agent');
    const request = await submitAndAwaitRequestRow(scenario, webviewClient, prompt);
    const attempts = await coreEvidence.findAttemptsForRequest(scenario.globalDataDir, request.id);
    const attempt = attempts[0];
    if (!attempt) throw new Error('no attempt row created for the request');
    log(`attempt ${attempt.id} created for request ${request.id}`);

    // Wait for the live post-suspend approval card (governed_research first).
    const researchCard = await waitForActionableCapabilityApprovalCard(webviewClient, { timeoutMs: 60000 });
    const dbAttemptAfterResearchSuspend = await coreEvidence.findAttemptById(scenario.globalDataDir, attempt.id);
    const continuationAfterResearchSuspend = await coreEvidence.findLoopContinuation(scenario.globalDataDir, attempt.id);
    const mutationsBeforeAnyApproval = await readMutationCount(scenario.fakeGhDataDir);

    const anchorApprovals = await coreEvidence.findAllApprovals(scenario.globalDataDir);
    const researchApproval = anchorApprovals.find((a) => a.id === researchCard.approvalId);
    if (!researchApproval) throw new Error(`no approval row found in DB for card approvalId ${researchCard.approvalId}`);

    const checks = [];
    const check = (ok, description, detail) => { checks.push({ ok: Boolean(ok), description, detail }); log(`${ok ? 'PASS' : 'FAIL'} — ${description}`); };

    check(dbAttemptAfterResearchSuspend.status === 'waiting_for_approval', 'attempt is waiting_for_approval for governed_research', { status: dbAttemptAfterResearchSuspend.status });
    check(Boolean(continuationAfterResearchSuspend), 'a continuation row exists for the real Saath Kar attempt', { continuation: continuationAfterResearchSuspend });
    check(researchApproval.attemptId !== attempt.id, "the approval's anchor attemptId differs from the real Saath Kar attemptId", { anchorAttemptId: researchApproval.attemptId, realAttemptId: attempt.id });
    check(continuationAfterResearchSuspend?.requestedActionDigest === researchCard.requestedActionDigestDataset, 'requestedActionDigest matches the pending action', { continuationDigest: continuationAfterResearchSuspend?.requestedActionDigest, cardDigest: researchCard.requestedActionDigestDataset });
    check(mutationsBeforeAnyApproval === 0, 'fake-gh mutation counter is 0 before any approval', { mutationsBeforeAnyApproval });
    check(researchCard.toolNameDataset === 'governed_research', 'the first actionable card is governed_research', { toolName: researchCard.toolNameDataset });

    await ui.evalInWebviewDoc(webviewClient, `document.getElementById('capability-approval-${researchCard.approvalId}')?.scrollIntoView()`).catch(() => {});
    await clickCapabilityApprovalButton(webviewClient, researchCard.approvalId, 'approved');
    log('clicked real Approve button for governed_research');

    const githubCard = await waitForActionableCapabilityApprovalCard(webviewClient, { timeoutMs: 60000 });
    check(githubCard.toolNameDataset === 'github_comment_on_issue', 'the second actionable card is github_comment_on_issue', { toolName: githubCard.toolNameDataset });
    const mutationsBeforeGithubApproval = await readMutationCount(scenario.fakeGhDataDir);
    check(mutationsBeforeGithubApproval === 0, 'mutation count is still 0 before the github approval', { mutationsBeforeGithubApproval });

    await clickCapabilityApprovalButton(webviewClient, githubCard.approvalId, 'approved');
    log('clicked real Approve button for github_comment_on_issue');

    const terminalAttempt = await pollUntil(
      async () => {
        const a = await coreEvidence.findAttemptById(scenario.globalDataDir, attempt.id);
        return ['completed', 'failed', 'cancelled'].includes(a?.status) ? { done: true, value: a } : { done: false, value: a?.status };
      },
      { timeoutMs: 60000, describe: () => `attempt ${attempt.id} to reach a terminal state` },
    );
    check(terminalAttempt.status === 'completed', 'the attempt reaches completed', { status: terminalAttempt.status, failureReason: terminalAttempt.failureReason });

    const mutationsAfter = await readMutationCount(scenario.fakeGhDataDir);
    check(mutationsAfter === 1, 'exactly one mutation occurred', { mutationsAfter });

    const finalContinuation = await coreEvidence.findLoopContinuation(scenario.globalDataDir, attempt.id);
    check(!finalContinuation, 'the continuation row for this attempt no longer exists (closeLoopContinuation on terminal)', { finalContinuation });

    const expectedAnswer = m38FinalAnswer();
    const conversationMessages = request.conversationId ? await coreEvidence.findConversationMessages(scenario.globalDataDir, request.conversationId) : [];
    const lastAssistantDbMessage = conversationMessages.filter((m) => m.role === 'assistant').pop();
    check(Boolean(lastAssistantDbMessage?.content?.includes(expectedAnswer)), 'final assistant message (DB) is grounded in all three tool results', { content: lastAssistantDbMessage?.content, expectedAnswer });

    const bubbles = await readAssistantBubbles(webviewClient);
    check(bubbles.some((b) => b.includes(m38DeniedFinalAnswer()) === false && b.includes(expectedAnswer)), 'a final grounded assistant bubble appears in the real webview', { bubbles });

    await captureEvidence(webviewClient, evidenceDir, 'final-state');
    const ok = checks.every((c) => c.ok);
    writeScenarioEvidence(name, { status: ok ? 'passed' : 'failed', checks, requestId: request.id, attemptId: attempt.id });
    if (!ok) throw new Error(`scenario B failed: ${JSON.stringify(checks.filter((c) => !c.ok))}`);
    log(`${name} PASSED`);
    return true;
  } finally {
    await pageClient?.close().catch(() => {});
    await webviewClient?.close().catch(() => {});
    await scenario.cleanup();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Scenarios C/D — restart recovery (approve / deny)
// ══════════════════════════════════════════════════════════════════════════

/** Gracefully closes the main workbench window over CDP (window.close() on
 * the renderer) WITHOUT clicking anything else first — never a process-tree
 * kill, which (per the header note / empirical experiment) would also kill
 * the detached Core process. Falls back to a plain-process kill only if the
 * graceful path does not exit in time, and even then targets only the
 * launched VS Code root pid (never Core's pid, read separately and never
 * touched here). */
async function gracefullyCloseExtensionHost(cdpPort, launcherChild, { timeoutMs = 15000 } = {}) {
  try {
    const targets = await board.listTargets(cdpPort);
    const page = targets.find((t) => t.type === 'page');
    if (page) {
      const client = await board.connectToTarget(cdpPort, page.id);
      await client.Runtime.evaluate({ expression: 'window.close()' });
      await client.close().catch(() => {});
    }
  } catch (error) {
    log(`graceful window.close() over CDP failed (${error.message}); will fall back to a process kill if it does not exit.`);
  }
  await new Promise((resolve) => {
    if (launcherChild.exitCode !== null || launcherChild.killed) return resolve();
    launcherChild.once('exit', resolve);
    setTimeout(resolve, timeoutMs);
  });
  if (launcherChild.exitCode === null && !launcherChild.killed) {
    log('graceful close did not exit within the timeout; falling back to terminating only the Extension Host root process (never Core).');
    terminatePlainHost(launcherChild);
  }
}

async function reachPendingGithubCard(scenario, cdpPort, prompt) {
  const { pageClient, webviewClient } = await openChatPanel(cdpPort);
  await setMode(webviewClient, 'agent');
  const request = await submitAndAwaitRequestRow(scenario, webviewClient, prompt);
  const attempts = await coreEvidence.findAttemptsForRequest(scenario.globalDataDir, request.id);
  const attempt = attempts[0];
  const researchCard = await waitForActionableCapabilityApprovalCard(webviewClient, { timeoutMs: 60000 });
  await clickCapabilityApprovalButton(webviewClient, researchCard.approvalId, 'approved');
  const githubCard = await waitForActionableCapabilityApprovalCard(webviewClient, { timeoutMs: 60000 });

  return { pageClient, webviewClient, request, attempt, githubCard };
}

/**
 * Shared restart-recovery flow for Scenarios C (approve) and D (deny).
 * Session 1 reaches the pending github_comment_on_issue card and is killed
 * gracefully (never clicking anything). Session 2 relaunches against the
 * SAME on-disk profile/workspace/globalDataDir, reopens the KarkeDikha view
 * WITHOUT resubmitting, confirms the same card restores automatically via
 * `restoreCapabilityApprovalCards`, then clicks the given resolution.
 */
async function runRestartRecoveryScenario({ vscodeExecutablePath, cliArgs, name, resolution }) {
  log(`=== ${name} (resolution=${resolution}) ===`);
  const scenario = await buildIsolatedScenario(name, { vscodeExecutablePath, cliArgs });
  const evidenceDir = writeScenarioEvidence(name, { status: 'started' });
  const prompt = `Inspect the repository problem, research the relevant documentation, and prepare the governed GitHub issue comment. (${name})`;
  const checks = [];
  const check = (ok, description, detail) => { checks.push({ ok: Boolean(ok), description, detail }); log(`${ok ? 'PASS' : 'FAIL'} — ${description}`); };
  let pc1;
  let wc1;
  let pc2;
  let wc2;
  let pc3;
  let wc3;
  try {
    // --- Session 1: reach the pending card, kill gracefully without clicking ---
    const session1 = await scenario.launch('session-1');
    const reached = await reachPendingGithubCard(scenario, session1.cdpPort, prompt);
    pc1 = reached.pageClient; wc1 = reached.webviewClient;
    const { request, attempt, githubCard } = reached;

    const preRestart = {
      conversationId: request.conversationId,
      realAttemptId: attempt.id,
      anchorAttemptId: githubCard.attemptIdDataset,
      approvalId: githubCard.approvalId,
      requestedActionDigest: githubCard.requestedActionDigestDataset,
    };
    const continuationBefore = await coreEvidence.findLoopContinuation(scenario.globalDataDir, attempt.id);
    const mutationsBefore = await readMutationCount(scenario.fakeGhDataDir);
    const approvalsBefore = await coreEvidence.findAllApprovals(scenario.globalDataDir);
    check(mutationsBefore === 0, 'zero mutations before restart', { mutationsBefore });
    check(Boolean(continuationBefore), 'continuation row exists before restart', { checksum: continuationBefore?.checksum });
    check(preRestart.anchorAttemptId !== preRestart.realAttemptId, 'anchor attemptId differs from real attemptId before restart', preRestart);

    await captureEvidence(wc1, evidenceDir, 'session-1-pending');

    const coreRecordBefore = coreEvidence.readDiscoveryRecord(scenario.globalDataDir);
    log(`Core discovery record before restart: pid=${coreRecordBefore?.pid}. Extension Host root pid=${session1.launcher.pid}.`);

    await wc1.close().catch(() => {});
    await gracefullyCloseExtensionHost(session1.cdpPort, session1.launcher);

    const coreRecordAfterKill = coreEvidence.readDiscoveryRecord(scenario.globalDataDir);
    const coreSurvived = Boolean(coreRecordAfterKill?.pid) && coreEvidence.isPidAlive(coreRecordAfterKill.pid) && coreRecordAfterKill.pid === coreRecordBefore?.pid;
    check(coreSurvived, 'Core process survived the graceful Extension Host restart (same pid, still alive)', { corePidBefore: coreRecordBefore?.pid, corePidAfter: coreRecordAfterKill?.pid, alive: coreRecordAfterKill?.pid ? coreEvidence.isPidAlive(coreRecordAfterKill.pid) : false });

    // --- Session 2: fresh Extension Host, same on-disk profile/workspace ---
    const session2 = await scenario.launch('session-2');
    const page2 = await waitForWorkbenchPageTarget(session2.cdpPort);
    pc2 = await board.connectToTarget(session2.cdpPort, page2.id);
    await pc2.Page.bringToFront();
    // restoreCapabilityApprovalCards() runs exactly once, synchronously at
    // webview-creation time (AgentPanel.resolveWebviewView), racing
    // CoreManager's own async start() with no retry-on-connect subscription
    // (verified by reading AgentPanel.ts: no onStatusChange listener re-runs
    // it). Since Core is already running (survived the restart) and the
    // Extension Host activates lazily on first view access, give the
    // Extension Host's own activation + CoreManager.start() handshake a
    // generous head start BEFORE opening the view, so this one-shot
    // restoration attempt is not racing a cold activation — the realistic
    // timing for a user who reopens VS Code and does not click into the
    // KarkeDikha view within the same instant.
    await new Promise((r) => setTimeout(r, 8000));
    await board.runCommandViaPalette(pc2, 'KarkeDikha: Open');
    const connected2 = await ui.connectToWebviewHostTarget(session2.cdpPort, { attempts: 60, delayMs: 500 });
    wc2 = connected2.client;
    await ui.waitForWebviewContentMounted(wc2, { timeoutMs: 30000, readyElementId: 'send-btn' });

    const restoredCard = await waitForActionableCapabilityApprovalCard(wc2, { timeoutMs: 30000 });
    check(restoredCard.approvalId === preRestart.approvalId, 'restored card has the exact same approvalId (without resubmitting)', { restoredApprovalId: restoredCard.approvalId, originalApprovalId: preRestart.approvalId });
    check(restoredCard.attemptIdDataset === preRestart.anchorAttemptId, 'restored card carries the same anchor attemptId', { restored: restoredCard.attemptIdDataset, original: preRestart.anchorAttemptId });
    check(restoredCard.requestedActionDigestDataset === preRestart.requestedActionDigest, 'restored card carries the same requestedActionDigest', { restored: restoredCard.requestedActionDigestDataset, original: preRestart.requestedActionDigest });
    await captureEvidence(wc2, evidenceDir, 'session-2-restored');

    await clickCapabilityApprovalButton(wc2, restoredCard.approvalId, resolution);
    log(`clicked real ${resolution} button on the restored card`);

    const terminalAttempt = await pollUntil(
      async () => {
        const a = await coreEvidence.findAttemptById(scenario.globalDataDir, attempt.id);
        return ['completed', 'failed', 'cancelled'].includes(a?.status) ? { done: true, value: a } : { done: false, value: a?.status };
      },
      { timeoutMs: 60000, describe: () => `attempt ${attempt.id} to reach a terminal state after restart` },
    );
    const mutationsAfter = await readMutationCount(scenario.fakeGhDataDir);
    const approvalsAfter = await coreEvidence.findAllApprovals(scenario.globalDataDir);
    const continuationAfter = await coreEvidence.findLoopContinuation(scenario.globalDataDir, attempt.id);

    if (resolution === 'approved') {
      check(mutationsAfter === 1, 'exactly one mutation after restart+approve', { mutationsAfter });
      check(terminalAttempt.status === 'completed', 'attempt completes after restart+approve', { status: terminalAttempt.status, failureReason: terminalAttempt.failureReason });
    } else {
      check(mutationsAfter === 0, 'zero mutations after restart+deny', { mutationsAfter });
    }
    check(approvalsAfter.length === approvalsBefore.length, 'no duplicate approval row was created by the restart/resolve', { before: approvalsBefore.length, after: approvalsAfter.length });
    check(!continuationAfter, 'the continuation row is gone once the attempt is terminal', { continuationAfter });

    const conversationMessages = request.conversationId ? await coreEvidence.findConversationMessages(scenario.globalDataDir, request.conversationId) : [];
    const lastAssistant = conversationMessages.filter((m) => m.role === 'assistant').pop();
    if (resolution === 'approved') {
      check(Boolean(lastAssistant?.content?.includes(m38FinalAnswer())), 'final answer (DB) reflects the approved, grounded outcome', { content: lastAssistant?.content });
    } else {
      log(`terminal attempt after deny: status=${terminalAttempt.status} failureReason=${terminalAttempt.failureReason} lastAssistant=${JSON.stringify(lastAssistant?.content)}`);
    }

    await wc2.close().catch(() => {});
    await pc2.close().catch(() => {});
    log('gracefully closing session-2 Extension Host so session-3 is a genuinely fresh restart...');
    await gracefullyCloseExtensionHost(session2.cdpPort, session2.launcher);

    // --- Session 3: restart again; card must restore as completed/non-actionable ---
    const session3 = await scenario.launch('session-3');
    const page3 = await waitForWorkbenchPageTarget(session3.cdpPort);
    pc3 = await board.connectToTarget(session3.cdpPort, page3.id);
    await pc3.Page.bringToFront();
    await new Promise((r) => setTimeout(r, 8000)); // same Core-connect head start as session 2 (see its comment)
    await board.runCommandViaPalette(pc3, 'KarkeDikha: Open');
    const connected3 = await ui.connectToWebviewHostTarget(session3.cdpPort, { attempts: 60, delayMs: 500 });
    wc3 = connected3.client;
    await ui.waitForWebviewContentMounted(wc3, { timeoutMs: 30000, readyElementId: 'send-btn' });
    await new Promise((r) => setTimeout(r, 3000));
    const cardsAfterSecondRestart = await readCapabilityApprovalCards(wc3);
    const finalCard = cardsAfterSecondRestart.find((c) => c.approvalId === preRestart.approvalId);
    check(Boolean(finalCard?.resolved), 'card restores as resolved/non-actionable after a further restart', { finalCard });
    await captureEvidence(wc3, evidenceDir, 'session-3-final');

    const ok = checks.every((c) => c.ok);
    writeScenarioEvidence(name, { status: ok ? 'passed' : 'failed', checks, preRestart, terminalStatus: terminalAttempt.status, terminalFailureReason: terminalAttempt.failureReason });
    if (!ok) throw new Error(`${name} failed: ${JSON.stringify(checks.filter((c) => !c.ok))}`);
    log(`${name} PASSED`);
    return true;
  } finally {
    await pc1?.close().catch(() => {});
    await wc1?.close().catch(() => {});
    await pc2?.close().catch(() => {});
    await wc2?.close().catch(() => {});
    await pc3?.close().catch(() => {});
    await wc3?.close().catch(() => {});
    await scenario.cleanup();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Scenario E — cancellation while a governed capability adapter is
// genuinely in flight
// ══════════════════════════════════════════════════════════════════════════

async function runScenarioE({ vscodeExecutablePath, cliArgs }) {
  const name = 'scenario-e-cancellation';
  log(`=== ${name} ===`);
  const scenario = await buildIsolatedScenario(name, { vscodeExecutablePath, cliArgs });
  const evidenceDir = writeScenarioEvidence(name, { status: 'started' });
  const prompt = `Inspect the repository problem, research the relevant documentation, and prepare the governed GitHub issue comment. (${name})`;
  const checks = [];
  const check = (ok, description, detail) => { checks.push({ ok: Boolean(ok), description, detail }); log(`${ok ? 'PASS' : 'FAIL'} — ${description}`); };
  let pageClient;
  let webviewClient;
  try {
    // Hold the research fixture's /search response so the governed_research
    // capability adapter is genuinely mid-flight (not merely queued) at the
    // moment cancellation is requested.
    scenario.researchFixture.holdSearchResponses?.(true);

    const { cdpPort } = await scenario.launch('main');
    ({ pageClient, webviewClient } = await openChatPanel(cdpPort));
    await setMode(webviewClient, 'agent');
    const request = await submitAndAwaitRequestRow(scenario, webviewClient, prompt);
    const attempts = await coreEvidence.findAttemptsForRequest(scenario.globalDataDir, request.id);
    const attempt = attempts[0];

    const researchCard = await waitForActionableCapabilityApprovalCard(webviewClient, { timeoutMs: 60000 });
    await clickCapabilityApprovalButton(webviewClient, researchCard.approvalId, 'approved');

    // The approval resolve resumes the attempt into 'running' and the
    // governed_research adapter genuinely calls the (held) fixture. Wait for
    // that in-flight state before cancelling.
    await pollUntil(
      async () => {
        const a = await coreEvidence.findAttemptById(scenario.globalDataDir, attempt.id);
        return a?.status === 'running' ? { done: true, value: a } : { done: false, value: a?.status };
      },
      { timeoutMs: 20000, describe: () => 'attempt to be running (governed_research genuinely in flight)' },
    );
    const attemptBeforeCancel = await coreEvidence.findAttemptById(scenario.globalDataDir, attempt.id);
    const fenceTokenBeforeCancel = attemptBeforeCancel.fenceToken;

    await ui.evalInWebviewDoc(webviewClient, `(() => { const btn = document.getElementById('stop-btn'); if (!btn) throw new Error('stop-btn not found'); btn.click(); return true; })()`);
    log('clicked real Stop button while governed_research is genuinely in flight');

    const cancelledAttempt = await pollUntil(
      async () => {
        const a = await coreEvidence.findAttemptById(scenario.globalDataDir, attempt.id);
        return a?.status === 'cancelled' ? { done: true, value: a } : { done: false, value: a?.status };
      },
      { timeoutMs: 30000, describe: () => `attempt ${attempt.id} to reach cancelled` },
    );
    check(cancelledAttempt.status === 'cancelled', 'attempt reaches cancelled via real AbortController propagation', { status: cancelledAttempt.status });
    // NOTE: fenceToken/fenceGeneration are per-executor-lease identifiers
    // (core/runtime/executor.ts's acquireFence) — they protect against a
    // SECOND executor process racing the same attempt (e.g. after a crash
    // + restart), not against a late async completion within the SAME
    // executor's own in-flight call. A same-process Stop/cancel is expected
    // to keep the same fenceToken; the actual "late completion cannot
    // finalize" protection for this scenario is the status-terminality
    // checks below (attempt stays 'cancelled', no tool invocation records a
    // late success). Recorded as evidence only, not a pass/fail gate.
    log(`fence identity across cancellation (informational only): before=${JSON.stringify({ fenceToken: fenceTokenBeforeCancel, fenceGeneration: attemptBeforeCancel.fenceGeneration })} after=${JSON.stringify({ fenceToken: cancelledAttempt.fenceToken, fenceGeneration: cancelledAttempt.fenceGeneration })}`);

    // Now let the held fixture response through — a late completion must not
    // be able to register as a successful invocation against the cancelled attempt.
    scenario.researchFixture.holdSearchResponses?.(false);
    await new Promise((r) => setTimeout(r, 3000));
    const attemptAfterLateCompletion = await coreEvidence.findAttemptById(scenario.globalDataDir, attempt.id);
    check(attemptAfterLateCompletion.status === 'cancelled', 'a late fixture completion after cancellation does not flip the attempt out of cancelled', { status: attemptAfterLateCompletion.status });

    const toolInvocations = await coreEvidence.findToolInvocations(scenario.globalDataDir, attempt.id);
    const lateSucceeded = toolInvocations.some((t) => t.toolName === 'governed_research' && t.status === 'succeeded');
    check(!lateSucceeded, 'no governed_research tool invocation is recorded as succeeded (late completion did not register)', { toolInvocations: toolInvocations.map((t) => ({ toolName: t.toolName, status: t.status })) });

    // The continuation (if any) cannot be resumed afterward: attempt an
    // approval resolve against the cancelled attempt's original approval.
    const approvals = await coreEvidence.findApprovalsForAttempt(scenario.globalDataDir, researchCard.attemptIdDataset);
    check(approvals.every((a) => a.status !== 'pending'), 'no pending approval remains resumable against the cancelled attempt', { approvals: approvals.map((a) => ({ id: a.id, status: a.status })) });

    await captureEvidence(webviewClient, evidenceDir, 'final-state');
    const ok = checks.every((c) => c.ok);
    writeScenarioEvidence(name, { status: ok ? 'passed' : 'failed', checks, requestId: request.id, attemptId: attempt.id });
    if (!ok) throw new Error(`${name} failed: ${JSON.stringify(checks.filter((c) => !c.ok))}`);
    log(`${name} PASSED`);
    return true;
  } finally {
    await pageClient?.close().catch(() => {});
    await webviewClient?.close().catch(() => {});
    await scenario.cleanup();
  }
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  if (reportInfraBlockedIfUpdaterActive()) process.exit(EXIT_INFRA_BLOCKED);

  const scenarios = selectScenarios();
  log(`Selected scenarios: ${scenarios.join(', ')}`);

  if (!fs.existsSync(vsixPath)) {
    console.error(`VSIX not found at ${vsixPath} — run "npm run package:win32-x64" first (Scenario A).`);
    process.exit(1);
  }
  log(`Using VSIX ${vsixPath} (sha256=${hashFile(vsixPath)}).`);

  fs.mkdirSync(workDir, { recursive: true });
  const { vscodeExecutablePath, cliArgs } = await resolveVSCode();

  const results = {};
  let exitCode = 0;
  const runners = {
    b: () => runScenarioB({ vscodeExecutablePath, cliArgs }),
    c: () => runRestartRecoveryScenario({ vscodeExecutablePath, cliArgs, name: 'scenario-c-approve-after-restart', resolution: 'approved' }),
    d: () => runRestartRecoveryScenario({ vscodeExecutablePath, cliArgs, name: 'scenario-d-deny-after-restart', resolution: 'rejected' }),
    e: () => runScenarioE({ vscodeExecutablePath, cliArgs }),
  };
  for (const key of scenarios) {
    try {
      results[key] = await runners[key]();
    } catch (error) {
      console.error(`[m38-packaged-acceptance] scenario ${key} failed: ${error.stack ?? error}`);
      results[key] = false;
      exitCode = 1;
    }
  }

  log(`Results: ${JSON.stringify(results)}`);
  if (Object.values(results).some((v) => v === false)) exitCode = 1;
  return exitCode;
}

main()
  .then((code) => {
    for (const { pid, label } of trackedChildren) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(pid, 'SIGKILL');
        log(`Terminated tracked process ${label} (pid ${pid}).`);
      } catch { /* already exited */ }
    }
    process.exit(code);
  })
  .catch((error) => {
    console.error('[m38-packaged-acceptance] FATAL');
    console.error(error);
    process.exit(1);
  });
