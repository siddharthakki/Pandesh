'use strict';

// Test-only companion extension. Loaded ONLY inside the isolated, NORMAL VS
// Code window launched by scripts/acceptance/plainVsCodeHost.mjs — never via
// @vscode/test-electron's runTests()/--extensionTestsPath (that host refuses
// to render any modal dialog at all, which is the Checkpoint C root cause),
// and never packaged into the production VSIX (.vscodeignore excludes
// scripts/, and packageContentAssertion.mjs fails the run if this file leaks
// in).
//
// It does NOT monkey-patch any vscode.window.* API. It only:
//   - invokes real ollama-agent commands (e.g. startAutonomousTask) with
//     deterministic goal input, driven by a harness-owned control file whose
//     path is passed through the companion-only environment variable
//     OLLAMA_AGENT_ACCEPTANCE_CONTROL_FILE (never read by production code);
//   - writes bounded progress events to the control file's declared
//     statusFile so the *external* orchestrator (plain Node, outside the
//     Extension Host) can poll it.
//
// Actual Approve/Reject/QuickPick-selection clicks on the real production
// UI must be performed by an external UI driver operating the rendered VS
// Code window over CDP (see scripts/acceptance/uiDriver.mjs), not by this
// file.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { readJsonWithEvidence, writeJsonAtomic } = require('./jsonEvidence.cjs');

const EXTENSION_ID = 'ollama-agent.ollama-agent';
const CONTROL_FILE_ENV_VAR = 'OLLAMA_AGENT_ACCEPTANCE_CONTROL_FILE';

function readControlFile() {
  const controlFilePath = process.env[CONTROL_FILE_ENV_VAR];
  if (!controlFilePath) return undefined;
  const result = readJsonWithEvidence(controlFilePath);
  if (!result.ok) throw new Error(`Unable to read companion control JSON: ${JSON.stringify(result.evidence)}`);
  return result.value;
}

function statusFileFor(control) {
  return control?.statusFile;
}

function writeStatus(control, patch) {
  const statusFile = statusFileFor(control);
  if (!statusFile) return;
  const read = readJsonWithEvidence(statusFile);
  const existing = read.ok && read.value && typeof read.value === 'object' ? read.value : { events: [] };
  const now = new Date();
  const startedAt = existing.startedAt || now.toISOString();
  const elapsedMs = Math.max(0, now.getTime() - new Date(startedAt).getTime());
  const events = [...(Array.isArray(existing.events) ? existing.events : []), { at: now.toISOString(), ...patch }].slice(-50);
  writeJsonAtomic(statusFile, {
    ...existing,
    ...patch,
    schemaVersion: 1,
    startedAt,
    elapsedMs,
    lifecycleStage: patch.phase || existing.lifecycleStage,
    events,
  });
}

/**
 * Diagnostic-only probe for Checkpoint C: calls a real, unpatched
 * vscode.window.showWarningMessage({modal:true}) and records exactly when it
 * was invoked and when/how it resolved, so an external orchestrator can
 * confirm the modal stays pending with zero input and later resolves when
 * (and only when) CDP deliberately clicks a button.
 */
async function probeModal(control) {
  const invokedAtMonotonicMs = Number(process.hrtime.bigint() / 1000000n);
  writeStatus(control, { phase: 'modal_invoked', invokedAtMonotonicMs });

  const startNs = process.hrtime.bigint();
  const selection = await vscode.window.showWarningMessage(
    'Acceptance modal probe',
    { modal: true, detail: 'Diagnostic only' },
    'Approve',
    'Reject',
  );
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;

  const result = selection === 'Approve' || selection === 'Reject' ? selection : 'undefined';
  writeStatus(control, { phase: 'modal_resolved', result, elapsedMs });
  return { result, elapsedMs };
}

async function runScenario(control) {
  const scenario = control.scenario;

  if (control.forceCompanionFailure) {
    writeStatus(control, {
      phase: 'failed',
      stage: 'forced_companion_failure',
      message: 'Forced by the packaged-acceptance harness to verify terminal lifecycle evidence.',
      process: { pid: process.pid, executable: process.execPath },
    });
    return;
  }

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  writeStatus(control, {
    phase: 'production_extension_checked',
    productionExtensionPresent: Boolean(extension),
  });
  if (!extension) {
    writeStatus(control, { phase: 'failed', error: `production extension "${EXTENSION_ID}" not found` });
    return;
  }
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  const commandRegistered = commands.includes('ollama-agent.startAutonomousTask');
  writeStatus(control, { phase: 'command_registration_checked', commandRegistered });
  if (!commandRegistered) {
    writeStatus(control, { phase: 'failed', error: 'ollama-agent.startAutonomousTask is not registered' });
    return;
  }

  if (scenario === 'activation_registration') {
    writeStatus(control, { phase: 'passed' });
    return;
  }

  if (scenario === 'modal_probe') {
    writeStatus(control, { phase: 'scenario_dispatched' });
    const result = await probeModal(control);
    writeStatus(control, { phase: 'scenario_complete', probeResult: result });
    return;
  }

  if (scenario === 'rejection' || scenario === 'success') {
    writeStatus(control, { phase: 'scenario_dispatched' });
    // Fire-and-forget: this only enqueues the real task through the real
    // registered command. The external orchestrator watches the durable
    // task/lease files on disk and drives the real QuickPick/modal over CDP;
    // it does not wait on this promise (task completion depends on external
    // UI input this process never provides).
    vscode.commands
      .executeCommand('ollama-agent.startAutonomousTask', control.goal)
      .then(
        () => writeStatus(control, { phase: 'command-settled' }),
        error => writeStatus(control, { phase: 'command-settled', error: String(error) }),
      );
    writeStatus(control, { phase: 'command_invoked' });
    return;
  }

  writeStatus(control, { phase: 'failed', error: `unknown scenario "${scenario}"` });
}

function activate(context) {
  let control;
  try {
    control = readControlFile();
  } catch (error) {
    // There is no trustworthy status path if the control file itself cannot
    // be decoded; surface the detailed error in the Extension Host log.
    console.error('[acceptance-companion] control read failed', error);
    throw error;
  }
  writeStatus(control, {
    phase: 'extension_host_observed',
    extensionHostProcess: { pid: process.pid, executable: process.execPath, argv: process.argv },
  });
  writeStatus(control, { phase: 'companion_activated', runId: control?.runId });

  if (control) {
    runScenario(control).catch(error => {
      writeStatus(control, {
        phase: 'failed',
        stage: 'companion_scenario',
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
        process: { pid: process.pid, executable: process.execPath },
      });
    });
  }

  context.subscriptions.push({ dispose: () => undefined });
}

function deactivate() {}

module.exports = { activate, deactivate };
