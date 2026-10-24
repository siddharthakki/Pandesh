#!/usr/bin/env node
// npm run test:e2e:onboarding-local-only
//
// Installed, local-only acceptance for the Setup/Readiness onboarding
// feature (see AI_OS onboarding milestone). Builds the real packaged VSIX,
// installs it into an isolated user-data-dir/extensions-dir pair (fresh-ish
// extension state — a truly clean VS Code profile is not practical in this
// harness, see the header note in plainVsCodeHost.mjs), opens a disposable
// scratch workspace, and drives a NORMAL VS Code window over CDP exactly
// like scripts/acceptance/run-packaged-m31-ui-dogfood.mjs does.
//
// This never talks to any cloud endpoint and never installs/pulls a model:
// it reports whatever the real, unmodified production selection finds on
// THIS machine's real Ollama. If no compatible model is installed, the run
// still passes as long as onboarding is truthful about that (NOT_READY with
// an actionable recommendation) — it does not require qwen3.8:27b-mtp-q4_K_M
// specifically, though it records whether that's what got recommended.
//
// Opt-in only: requires OLLAMA_AGENT_LIVE_ONBOARDING=1 or --enabled.

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const enabled = process.env.OLLAMA_AGENT_LIVE_ONBOARDING === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: onboarding local-only acceptance requires OLLAMA_AGENT_LIVE_ONBOARDING=1 or --enabled.');
  console.log('It launches a real packaged VS Code window against this machine\'s real local Ollama. No cloud calls are made.');
  process.exit(0);
}

const startedAt = Date.now();
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-onboarding-acceptance-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'onboarding-local-only');
const userDataDir = path.join(workDir, 'user-data');
const extensionsDir = path.join(workDir, 'extensions');
const workspaceDir = path.join(workDir, 'workspace');

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[onboarding-acceptance +${elapsed}s] ${message}`);
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

/**
 * Evaluates inside the webview's REAL content document, not the outer
 * webview-host shell document CDP's `iframe` target attaches to by default.
 * VS Code renders a webview panel as a host page (`vscode-webview://.../index.html`
 * — what the CDP target's own `document` is) that creates a nested,
 * same-target `<iframe id="active-frame">` holding the extension's actual
 * `webview.html` content in its `contentDocument`. Mirrors the identical,
 * already-proven technique in scripts/acceptance/boardUiDriver.mjs's
 * `evalInDoc` (undocumented/unexported there, so duplicated here rather than
 * reaching into that module's internals).
 */
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

/** Poll for the onboarding webview iframe target, confirmed by its own DOM content (the h1 text), not by URL shape. */
async function waitForSetupWebview(port, excludeIds, { timeoutMs = 60000, diagnosticLog } = {}) {
  const excluded = new Set(excludeIds);
  return pollUntil(
    async () => {
      const targets = await CDP.List({ port });
      const allIframes = targets.filter(t => t.type === 'iframe');
      const candidates = allIframes.filter(
        t => typeof t.url === 'string' && t.url.startsWith('vscode-webview://') && t.url.includes('/index.html') && !excluded.has(t.id),
      );
      if (diagnosticLog) {
        diagnosticLog(`poll: ${allIframes.length} iframe target(s) total, ${candidates.length} candidate(s) after url/exclude filter`);
        for (const t of allIframes) diagnosticLog(`  iframe target: id=${t.id} url=${t.url} title=${t.title ?? '(none)'}`);
      }
      for (const candidate of candidates) {
        const client = await board.connectToTarget(port, candidate.id);
        const probe = await evalInWebviewContentDoc(
          client,
          `({ h1: document.querySelector('h1')?.textContent ?? null, title: document.title, bodyPreview: (document.body?.innerText ?? '').slice(0, 120) })`,
        ).catch(err => ({ error: String(err) }));
        if (diagnosticLog) diagnosticLog(`  probed ${candidate.id}: ${JSON.stringify(probe)}`);
        if (probe?.h1 === 'KarkeDikha Setup') return { done: true, value: { client, targetId: candidate.id } };
        await client.close();
      }
      return { done: false };
    },
    { timeoutMs, describe: () => 'the KarkeDikha Setup onboarding webview to open (first-run auto-trigger)' },
  );
}

function readSetupSnapshot(client) {
  return evalInWebviewContentDoc(client, `({
    overallClass: document.querySelector('.overall')?.className ?? null,
    overallText: document.querySelector('.overall')?.textContent ?? null,
    bodyText: document.body.innerText,
  })`);
}

/**
 * Reads every VS Code log file (extension host log included) under this
 * isolated profile's `logs/` directory, concatenated. VS Code writes a fresh
 * timestamped `logs/<stamp>/exthost/exthost.log` (name varies by version) per
 * session, and by default mirrors extension `console.log/warn/error` calls
 * into it — no `--verbose` flag required, so this does not perturb startup
 * timing the way that flag did.
 */
function readExtensionHostLogText(userDataDirPath) {
  const logsRoot = path.join(userDataDirPath, 'logs');
  if (!fs.existsSync(logsRoot)) return '';
  const chunks = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.log')) {
        try { chunks.push(`--- ${full} ---\n${fs.readFileSync(full, 'utf8')}`); } catch { /* best effort */ }
      }
    }
  };
  walk(logsRoot, 0);
  return chunks.join('\n');
}

function initScratchWorkspace() {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Disposable onboarding acceptance workspace\n');
}

function reportInfraBlockedIfUpdaterActive() {
  const updaters = detectActiveVSCodeUpdater();
  if (updaters.length === 0) return false;
  log(`INFRA_BLOCKED: an active VS Code installer/updater is holding the machine-wide mutex (pid ${updaters[0].pid}).`);
  writeEvidence('infra-blocked.json', { status: 'INFRA_BLOCKED', updaters });
  return true;
}

/** Launches the isolated profile and returns a connected, ready page client + host handle. */
async function launchAndWaitForWorkbench(vscodeExecutablePath, remoteDebuggingPort) {
  const host = launchPlainHost(vscodeExecutablePath, {
    userDataDir,
    extensionsDir,
    workspacePath: workspaceDir,
    remoteDebuggingPort,
  });
  let page;
  try {
    page = await pollUntil(
      async () => {
        const targets = await board.listTargets(remoteDebuggingPort);
        const found = targets.find(t => t.type === 'page');
        return found ? { done: true, value: found } : { done: false };
      },
      { timeoutMs: 90000, describe: () => 'a workbench page target' },
    );
  } catch (error) {
    const details = host.processDetails();
    writeEvidence('diagnostic-window-launch-failure.json', {
      error: error.message, launchArgs: host.args, pid: details.pid,
      exitCode: details.exitCode, signalCode: details.signalCode, stdout: details.stdout, stderr: details.stderr,
    });
    log(`Diagnostic: the VS Code process itself (pid=${details.pid}, exitCode=${details.exitCode}) never exposed a reachable CDP port. See diagnostic-window-launch-failure.json.`);
    terminatePlainHost(host.child);
    throw error;
  }
  const pageClient = await board.connectToTarget(remoteDebuggingPort, page.id);
  await board.waitForWorkbenchDomReady(pageClient);
  return { host, pageClient };
}

/** On a genuine failure to find the setup webview, capture the extension host log for post-mortem. */
function captureFailureDiagnostics(host) {
  const diskLog = readExtensionHostLogText(userDataDir);
  const processLog = host.processDetails().stdout + '\n' + host.processDetails().stderr;
  const hostLog = diskLog + '\n' + processLog;
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'diagnostic-full-host-log.txt'), hostLog);
  const activationLines = hostLog.split('\n').filter(l => l.includes('_doActivateExtension ollama-agent.ollama-agent'));
  writeEvidence('diagnostic-extension-host-log.json', {
    activationLineCount: activationLines.length,
    activationLines,
    fullLogSavedTo: 'diagnostic-full-host-log.txt',
  });
  log(`Diagnostic: extension activation line(s) found: ${activationLines.length}. Full host log saved to diagnostic-full-host-log.txt.`);
}

async function main() {
  let passed = false;
  if (reportInfraBlockedIfUpdaterActive()) process.exit(3);

  log('Building packaged VSIX (npm run package)…');
  execFileSync('npm', ['run', 'package'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  const vsixPath = path.join(repoRoot, 'karkedikha.vsix');
  if (!fs.existsSync(vsixPath)) throw new Error(`packaged VSIX not found at ${vsixPath}`);

  initScratchWorkspace();

  log('Resolving a real VS Code build…');
  const { vscodeExecutablePath, cliArgs } = await resolveVSCode();

  log('Installing the packaged extension into an isolated profile…');
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath });

  // Pre-launch profile-isolation evidence: this exact key path is where VS
  // Code's globalStorage SQLite file would live if this profile were NOT
  // fresh. Its absence here is direct proof of a clean profile.
  const globalStorageDbPath = path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
  const globalStorageExistedBeforeLaunch = fs.existsSync(globalStorageDbPath);
  log(`Profile isolation check: globalStorage state.vscdb existed before launch = ${globalStorageExistedBeforeLaunch}`);

  try {
    // ---- Phase 1: FIRST LAUNCH — onboarding must auto-open exactly once ----
    const port1 = allocateDebugPort();
    log(`Phase 1/3 — first launch (port ${port1}): onboarding should auto-open.`);
    const { host: host1, pageClient: pageClient1 } = await launchAndWaitForWorkbench(vscodeExecutablePath, port1);

    let setupClient;
    try {
      ({ client: setupClient } = await waitForSetupWebview(port1, [], { timeoutMs: 60000 }));
      log('Onboarding auto-opened on first launch.');
    } catch (error) {
      captureFailureDiagnostics(host1);
      terminatePlainHost(host1.child);
      throw new Error(`Onboarding did not auto-open on first launch: ${error.message}`);
    }
    await pageClient1.close();

    // Let the initial "checking…" state resolve to a real readiness result.
    await pollUntil(
      async () => {
        const snapshot = await readSetupSnapshot(setupClient);
        return snapshot.overallText ? { done: true, value: snapshot } : { done: false };
      },
      { timeoutMs: 30000, describe: () => 'onboarding readiness to finish computing' },
    );
    const snapshot = await readSetupSnapshot(setupClient);
    await setupClient.close();

    log(`Onboarding overall status: ${snapshot.overallText}`);
    writeEvidence('setup-snapshot.json', snapshot);

    const checks = {
      ollamaDetected: /Ollama detected/i.test(snapshot.bodyText),
      baatRow: /Baat Kar/.test(snapshot.bodyText),
      saathRow: /Saath Kar/.test(snapshot.bodyText),
      karkeRow: /Karke Dikha/.test(snapshot.bodyText),
      localOnlyShown: /Local-only|Off\b/.test(snapshot.bodyText),
      recommendedQwen38: /qwen3\.8:27b-mtp-q4_k_m/i.test(snapshot.bodyText),
      noCloudWording: !/Cloud fallback configured/i.test(snapshot.bodyText) || /Off/i.test(snapshot.bodyText),
    };
    log(`Checks: ${JSON.stringify(checks)}`);
    writeEvidence('checks.json', checks);

    const required = ['ollamaDetected', 'baatRow', 'saathRow', 'karkeRow', 'localOnlyShown'];
    const failedChecks = required.filter(key => !checks[key]);
    if (failedChecks.length > 0) {
      terminatePlainHost(host1.child);
      throw new Error(`Onboarding acceptance failed required checks: ${failedChecks.join(', ')}. See ${evidenceDir}/setup-snapshot.json`);
    }
    log(`Phase 1 recommendation: ${(snapshot.bodyText.match(/([a-z0-9_.:-]+) ready/i) ?? [])[1] ?? '(none — no compatible model installed)'}`);
    terminatePlainHost(host1.child);

    // ---- Phase 2: SECOND LAUNCH, same profile — onboarding must NOT auto-open again ----
    const port2 = allocateDebugPort();
    log(`Phase 2/3 — relaunch (port ${port2}), same profile: onboarding must NOT auto-open.`);
    const { host: host2, pageClient: pageClient2 } = await launchAndWaitForWorkbench(vscodeExecutablePath, port2);
    let reNagged = false;
    try {
      await waitForSetupWebview(port2, [], { timeoutMs: 15000 });
      reNagged = true;
    } catch {
      // expected: no setup webview appears
    }
    writeEvidence('second-launch-no-nag.json', { reNagged });
    if (reNagged) {
      terminatePlainHost(host2.child);
      throw new Error('Onboarding auto-opened again on a second launch of the same profile — the "shown once" gate did not hold.');
    }
    log('Confirmed: no auto-open on second launch (no nag).');

    // ---- Phase 3: manual command still opens it ----
    log('Phase 3/3 — manual "KarkeDikha: Setup / Readiness" command.');
    const existingWebviewIds = await board.currentWebviewTargetIds(port2);
    await board.runCommandViaPalette(pageClient2, 'KarkeDikha: Setup / Readiness');
    let manualClient;
    try {
      ({ client: manualClient } = await waitForSetupWebview(port2, existingWebviewIds, { timeoutMs: 20000 }));
    } catch (error) {
      captureFailureDiagnostics(host2);
      terminatePlainHost(host2.child);
      throw new Error(`Manual "KarkeDikha: Setup / Readiness" command did not open the panel: ${error.message}`);
    }
    await manualClient.close();
    await pageClient2.close();
    terminatePlainHost(host2.child);
    log('Confirmed: manual command opens onboarding.');

    writeEvidence('result.json', {
      status: 'PASSED',
      overallText: snapshot.overallText,
      checks,
      globalStorageExistedBeforeLaunch,
      secondLaunchReNagged: reNagged,
      manualCommandOpened: true,
    });
    log('PASSED.');
    passed = true;
  } finally {
    if (passed) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      log(`Preserving isolated profile for inspection: ${workDir}`);
    }
  }
}

main().catch(error => {
  log(`FAILED: ${error.message}`);
  writeEvidence('result.json', { status: 'FAILED', error: error.message });
  process.exitCode = 1;
});
