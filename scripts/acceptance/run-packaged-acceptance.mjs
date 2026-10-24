#!/usr/bin/env node
// npm run test:acceptance:packaged
//
// By default builds the real VSIX from the working tree. Pass an explicit
// package input with `--vsix "<absolute-path>"` or the
// KARKEDIKHA_ACCEPTANCE_VSIX env var to use an already-built VSIX exactly
// (e.g. the artifact a specific CI run produced) instead — the harness never
// rebuilds or substitutes another package when one is supplied, and records
// its real sha256/bytes into .acceptance-evidence/packaged-vsix/package-provenance.json.
//
// Either way, unpacks it (no manual "code --install-extension"),
// then for every scenario that needs a real modal or QuickPick, launches a
// NORMAL, isolated VS Code window (scripts/acceptance/plainVsCodeHost.mjs) —
// NOT an @vscode/test-electron Extension Development Host — because that
// host's DialogService refuses to render any modal dialog at all whenever
// --extensionTestsPath is present (Checkpoint C root cause). The one
// remaining runTests() scenario, lower_level_executor_smoke, never touches a
// modal and is not counted as packaged autonomous acceptance.
//
// Drives a real ollama-agent task end to end against a fake local model
// server (no manual Command Palette use, no manual approval clicks; the real
// QuickPick/modal is operated by an external CDP driver over
// --remote-debugging-port), verifies the mutation + a git diff
// programmatically (no manual Git inspection), writes an evidence report (no
// manual evidence copying), and deletes every temp directory it created (no
// manual cleanup).

import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runTests } from '@vscode/test-electron';
import { createFakeOllamaServer } from './fakeOllamaServer.js';
import { assertPackagedContent } from './packageContentAssertion.mjs';
import * as uiDriver from './uiDriver.mjs';
import jsonEvidence from './jsonEvidence.cjs';
import {
  resolveVSCode,
  installExtension,
  launchPlainHost,
  terminatePlainHost,
  allocateDebugPort,
  writeControlFile,
  writeUserSettingsForCustomDialogs,
  detectActiveVSCodeUpdater,
} from './plainVsCodeHost.mjs';

const { writeJsonAtomic, readJsonWithEvidence } = jsonEvidence;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-packaged-acceptance-${runStamp}`);
const extractDir = path.join(workDir, 'extracted-vsix');
const workspaceDir = path.join(workDir, 'workspace');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'packaged-vsix');
const retainedPaths = [];

function log(message) {
  console.log(`[packaged-acceptance] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, windowsHide: true, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function provisionLocalTypeScript(root) {
  // The packaged extension's execution-integrity gate verifies validation
  // runtime provenance (it rejects ad hoc stub binaries), so the disposable
  // workspace needs the real `typescript` package the repo already depends
  // on rather than a fake `tsc` shim.
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'node_modules', 'typescript'), path.join(root, 'node_modules', 'typescript'), {
    recursive: true,
  });
}

function initGit(root) {
  fs.writeFileSync(path.join(root, 'README.md'), '# Disposable acceptance workspace\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, noEmit: true }, include: ['src/**/*.ts'] }, null, 2),
  );
  run('git', ['init'], { cwd: root });
  run('git', ['config', 'user.email', 'acceptance@example.com'], { cwd: root });
  run('git', ['config', 'user.name', 'Packaged Acceptance Harness'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init disposable acceptance workspace'], { cwd: root });
}

function gitInspectMutation(root) {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout;
  const diffStat = spawnSync('git', ['diff', '--stat'], { cwd: root, encoding: 'utf8' }).stdout;
  return { status, diffStat };
}

function extractVsix(vsixPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  // VSIX files are standard zip archives. On Windows, prefer the bundled
  // bsdtar (System32\tar.exe) explicitly — Git Bash's GNU tar on PATH parses
  // a leading "C:\" as a remote-shell host spec and fails.
  const tarBinary = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tarBinary, ['-xf', vsixPath, '-C', destination], { stdio: 'inherit' });
}

function parseScenarioFlag(argv) {
  const idx = argv.indexOf('--scenario');
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value) throw new Error('--scenario requires a value, e.g. --scenario activation_registration');
  return value;
}

function parseForceCompanionFailure(argv) {
  return argv.includes('--force-companion-failure');
}

/**
 * Explicit package-input override so a caller can point the harness at a
 * specific, already-built VSIX (e.g. the exact artifact a CI run produced)
 * instead of the harness rebuilding one from the working tree. When set, the
 * harness never invokes `npm run compile` / `vsce package` and uses the
 * supplied file exactly, recording its real sha256/bytes as evidence.
 */
function parseVsixOverride(argv) {
  const idx = argv.indexOf('--vsix');
  const flagValue = idx !== -1 ? argv[idx + 1] : undefined;
  if (idx !== -1 && !flagValue) throw new Error('--vsix requires an absolute path, e.g. --vsix "C:\\path\\to\\extension.vsix"');
  const value = flagValue ?? process.env.KARKEDIKHA_ACCEPTANCE_VSIX;
  if (!value) return undefined;
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`--vsix / KARKEDIKHA_ACCEPTANCE_VSIX points at a file that does not exist: ${resolved}`);
  }
  return resolved;
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

// --- fs-only durable task/lease inspection (no vscode API needed: this all
// runs in the plain Node orchestrator process, against the same disk the
// isolated VS Code window and its worktrees write to). ---

function listAutonomousTaskIds(workspaceRoot) {
  const dir = path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
}

function readTask(workspaceRoot, taskId) {
  const file = path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks', taskId, 'task.json');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readTaskEvents(workspaceRoot, taskId) {
  const file = path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks', taskId, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function readWorktreeLease(workspaceRoot, taskId) {
  const manifestPath = path.join(workspaceRoot, '.ollama-agent', 'tasks', '_worktrees', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return (manifest.leases || []).find(l => l.taskId === taskId);
}

async function pollUntil(conditionFn, { timeoutMs = 60000, intervalMs = 300, describe }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = conditionFn();
    if (last && last.done) return last.value;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe?.() ?? 'condition'}; last=${JSON.stringify(last?.value)}`);
}

async function waitForNewTaskId(workspaceRoot, baselineIds, timeoutMs = 30000) {
  return pollUntil(
    () => {
      const current = listAutonomousTaskIds(workspaceRoot);
      const created = current.find(id => !baselineIds.includes(id));
      return created ? { done: true, value: created } : { done: false, value: current };
    },
    { timeoutMs, describe: () => 'a new autonomous task directory to be created by startAutonomousTask' },
  );
}

function readStatusFile(statusFile) {
  const result = readJsonWithEvidence(statusFile);
  if (result.ok) return result.value;
  if (result.evidence.classification !== 'missing_json') {
    writeJsonAtomic(path.join(path.dirname(statusFile), 'companion-status-read-error.json'), {
      status: 'status_json_unreadable',
      ...result.evidence,
      recordedAt: new Date().toISOString(),
    });
  }
  return undefined;
}

// Companion activation can race straight through several phases (activated
// -> checked -> registered -> passed/dispatched) before the orchestrator's
// first poll, so look for the phase anywhere in the accumulated event
// history rather than only in the current (possibly already-superseded) top
// -level "phase" field.
async function waitForCompanionPhase(statusFile, phase, timeoutMs = 30000) {
  return pollUntil(
    () => {
      const status = readStatusFile(statusFile);
      if (status?.phase === 'failed') {
        throw new Error(`companion driver reported terminal failure before phase "${phase}": ${JSON.stringify(status)}`);
      }
      const match = status?.events?.find(e => e.phase === phase);
      return match ? { done: true, value: match } : { done: false, value: status?.phase };
    },
    { timeoutMs, describe: () => `companion driver status file to reach phase "${phase}"` },
  );
}

/**
 * Package the test-only companion driver as its own temporary VSIX. It has
 * its own extension ID/version and no production dependency; it is packaged
 * under the harness-owned temp workDir, never the repository root, and is
 * never included in the production VSIX (enforced separately by
 * packageContentAssertion.mjs against the production package's own
 * contents).
 */
function packageCompanionVsix(vsceBin) {
  const companionDir = path.join(__dirname, 'companion-driver');
  const outPath = path.join(workDir, 'companion-driver.vsix');
  run(vsceBin, ['package', '--out', outPath, '--allow-missing-repository', '--no-dependencies'], {
    cwd: companionDir,
    shell: process.platform === 'win32',
  });
  if (!fs.existsSync(outPath)) {
    throw new Error(`vsce did not produce the companion-driver VSIX at ${outPath}`);
  }
  return outPath;
}

/**
 * Run one scenario in a fresh, normal, isolated VS Code window: install both
 * VSIX files, write the harness-owned control file (consumed only by the
 * companion extension, never by production code), launch Code.exe directly
 * (no --extensionTestsPath), wait for companion activation + production
 * command registration, run the caller's driver, then terminate the window
 * and clean up the isolated user-data/extensions dirs.
 */
async function runInPlainHost({
  scenarioName,
  vscodeExecutablePath,
  cliArgs,
  productionVsixPath,
  companionVsixPath,
  workspacePath,
  goal,
  driver,
  forceCompanionFailure = false,
}) {
  const isolatedRoot = path.join(workDir, `plain-host-${scenarioName}`);
  const userDataDir = path.join(isolatedRoot, 'user-data');
  const extensionsDir = path.join(isolatedRoot, 'extensions');
  const scenarioEvidenceDir = path.join(evidenceDir, scenarioName);
  fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
  const statusFile = path.join(scenarioEvidenceDir, 'companion-status.json');
  const controlFilePath = path.join(isolatedRoot, 'control.json');

  const startedAt = new Date();
  const updateLifecycleStatus = (patch) => {
    const result = readJsonWithEvidence(statusFile);
    const existing = result.ok && result.value && typeof result.value === 'object' ? result.value : { events: [] };
    const now = new Date();
    const events = [...(Array.isArray(existing.events) ? existing.events : []), { at: now.toISOString(), ...patch }].slice(-50);
    writeJsonAtomic(statusFile, {
      ...existing,
      ...patch,
      schemaVersion: 1,
      startedAt: existing.startedAt || startedAt.toISOString(),
      elapsedMs: now.getTime() - startedAt.getTime(),
      lifecycleStage: patch.phase || existing.lifecycleStage,
      events,
    });
  };
  updateLifecycleStatus({
    phase: 'companion_started',
    scenarioName,
    process: { pid: process.pid, executable: process.execPath, argv: process.argv },
  });
  writeUserSettingsForCustomDialogs(userDataDir);
  log(`[${scenarioName}] installing production VSIX into isolated extensions dir...`);
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath: productionVsixPath });
  log(`[${scenarioName}] installing companion-driver VSIX into isolated extensions dir...`);
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath: companionVsixPath });

  writeControlFile(controlFilePath, {
    runId: `${runStamp}-${scenarioName}`,
    scenario: scenarioName === 'modal_probe' ? 'modal_probe' : scenarioName,
    goal,
    statusFile,
    evidenceDirectory: scenarioEvidenceDir,
    forceCompanionFailure,
  });

  const remoteDebuggingPort = allocateDebugPort();
  const activeUpdaters = detectActiveVSCodeUpdater();
  if (activeUpdaters.length > 0) {
    updateLifecycleStatus({
      phase: 'failed',
      stage: 'vscode_launch_preflight',
      message: 'A global VS Code updater mutex is active; the isolated VS Code process would refuse to launch.',
      updaterProcesses: activeUpdaters,
      terminalStatus: 'failed',
    });
    throw new Error(`VS Code updater is active; packaged activation was not attempted. updaterProcesses=${JSON.stringify(activeUpdaters)}`);
  }
  const { child, args, processDetails } = launchPlainHost(vscodeExecutablePath, {
    userDataDir,
    extensionsDir,
    workspacePath,
    remoteDebuggingPort,
    env: { OLLAMA_AGENT_ACCEPTANCE_CONTROL_FILE: controlFilePath },
  });
  let currentStage = 'vscode_launched';
  let terminating = false;
  updateLifecycleStatus({
    phase: 'vscode_launched',
    process: processDetails(),
    vscode: { executable: vscodeExecutablePath, arguments: args, userDataDir, extensionsDir },
  });
  child.once('exit', (exitCode, signal) => {
    if (!terminating) {
      updateLifecycleStatus({
        phase: 'failed',
        stage: currentStage,
        message: 'VS Code exited before packaged acceptance completed.',
        process: { ...processDetails(), exitCode, signalCode: signal },
        terminalStatus: 'failed',
      });
    }
  });

  let failed = false;
  try {
    await waitForCompanionPhase(statusFile, 'companion_activated', 30000);
    currentStage = 'companion_activated';
    log(`[${scenarioName}] companion driver activated in the normal isolated VS Code window.`);
    const commandChecked = await waitForCompanionPhase(statusFile, 'command_registration_checked', 30000);
    currentStage = 'command_registration_checked';
    if (!commandChecked.commandRegistered) {
      throw new Error(`ollama-agent.startAutonomousTask was not registered: ${JSON.stringify(commandChecked)}`);
    }
    log(`[${scenarioName}] production extension present and ollama-agent.startAutonomousTask registered.`);

    await driver({ remoteDebuggingPort, statusFile, scenarioEvidenceDir, workspacePath });
    currentStage = 'passed';
    updateLifecycleStatus({ phase: 'passed', terminalStatus: 'passed', process: processDetails() });
  } catch (error) {
    failed = true;
    const terminalCompanionStatus = readStatusFile(statusFile);
    const companionFailure = terminalCompanionStatus?.phase === 'failed'
      ? {
        stage: terminalCompanionStatus.stage,
        message: terminalCompanionStatus.message,
        elapsedMs: terminalCompanionStatus.elapsedMs,
        lifecycleStage: terminalCompanionStatus.lifecycleStage,
        process: terminalCompanionStatus.process,
      }
      : undefined;
    currentStage = terminalCompanionStatus?.phase === 'failed'
      ? terminalCompanionStatus.stage || terminalCompanionStatus.lifecycleStage || currentStage
      : terminalCompanionStatus?.lifecycleStage || currentStage;
    updateLifecycleStatus({
      phase: 'failed',
      stage: currentStage,
      message: terminalCompanionStatus?.message || (error instanceof Error ? error.message : String(error)),
      companionFailure,
      process: processDetails(),
      terminalStatus: 'failed',
    });
    try {
      const client = await uiDriver.connect(remoteDebuggingPort, { attempts: 3, delayMs: 300 });
      await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'plain-host-failure');
      await client.close();
    } catch {
      // best effort diagnostics only
    }
    throw error;
  } finally {
    terminating = true;
    terminatePlainHost(child);
    updateLifecycleStatus({
      phase: failed ? 'failed' : 'passed',
      stage: currentStage,
      elapsedMs: Date.now() - startedAt.getTime(),
      process: processDetails(),
      terminalStatus: failed ? 'failed' : 'passed',
    });
    if (failed) {
      retainedPaths.push(isolatedRoot);
      log(`[${scenarioName}] FAILED — retaining isolated user-data/extensions dirs at ${isolatedRoot}`);
    } else {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  // If this harness itself runs inside an Electron-hosted Node (e.g. a VS
  // Code extension host), this leaks into every spawned child and makes
  // Electron binaries run as plain Node instead of launching the app.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const scenarioFilter = parseScenarioFlag(process.argv.slice(2));
  const forceCompanionFailure = parseForceCompanionFailure(process.argv.slice(2));
  const shouldRun = name => !scenarioFilter || scenarioFilter === name;
  const suppliedVsixPath = parseVsixOverride(process.argv.slice(2));

  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  let fakeServer;
  let exitCode = 1;

  try {
    const vsceBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
    let productionVsixPath;
    let packageProvenance;
    if (suppliedVsixPath) {
      log(`Using explicitly supplied VSIX (never rebuilding): ${suppliedVsixPath}`);
      productionVsixPath = suppliedVsixPath;
      const bytes = fs.statSync(productionVsixPath).size;
      const sha256 = hashFile(productionVsixPath);
      packageProvenance = { source: 'supplied', path: productionVsixPath, bytes, sha256 };
      log(`Supplied VSIX provenance: bytes=${bytes} sha256=${sha256}`);
    } else {
      log('Compiling extension...');
      run('npm', ['run', 'compile'], { cwd: repoRoot, shell: process.platform === 'win32' });

      log('Packaging production VSIX...');
      productionVsixPath = path.join(workDir, 'acceptance.vsix');
      run(vsceBin, ['package', '--out', productionVsixPath], {
        cwd: repoRoot,
        shell: process.platform === 'win32',
      });
      if (!fs.existsSync(productionVsixPath)) {
        throw new Error(`vsce did not produce a VSIX at ${productionVsixPath}`);
      }
      const bytes = fs.statSync(productionVsixPath).size;
      const sha256 = hashFile(productionVsixPath);
      packageProvenance = { source: 'built', path: productionVsixPath, bytes, sha256 };
      log(`Built VSIX provenance: bytes=${bytes} sha256=${sha256}`);
    }

    log('Extracting packaged VSIX (no manual VSIX installation)...');
    extractVsix(productionVsixPath, extractDir);
    const extensionDevelopmentPath = path.join(extractDir, 'extension');
    if (!fs.existsSync(path.join(extensionDevelopmentPath, 'package.json'))) {
      throw new Error(`extracted VSIX did not contain extension/package.json under ${extractDir}`);
    }
    const { ok: packageContentOk, report: packageContentReport } = assertPackagedContent(extensionDevelopmentPath);
    log(`Packaged file count: ${packageContentReport.packagedFileCount}`);
    log(`Packaged top-level dirs: ${packageContentReport.topLevelDirs.join(', ')}`);
    log(`Prohibited-path matches: ${packageContentReport.prohibitedPathMatches.length}`);
    log(`Prohibited-string matches: ${packageContentReport.prohibitedStringMatches.length}`);
    log(`Required-file checks: ${JSON.stringify(packageContentReport.requiredFileResults)}`);
    log(`Command contribution check: ${JSON.stringify(packageContentReport.commandContributionResult)}`);
    fs.mkdirSync(evidenceDir, { recursive: true });
    writeJsonAtomic(path.join(evidenceDir, 'package-content-report.json'), packageContentReport);
    writeJsonAtomic(path.join(evidenceDir, 'package-provenance.json'), packageProvenance);
    if (!packageContentOk) {
      throw new Error(`package-content assertion FAILED:\n${JSON.stringify(packageContentReport, null, 2)}`);
    }
    log('Package-content assertion PASSED: production VSIX is clean and contains required assets.');

    log('Packaging temporary companion-driver VSIX (test-only, never shipped)...');
    const companionVsixPath = packageCompanionVsix(vsceBin);
    log(`Companion-driver VSIX packaged at ${companionVsixPath}`);

    log('Provisioning disposable git workspace...');
    provisionLocalTypeScript(workspaceDir);
    initGit(workspaceDir);

    log('Starting fake Ollama server...');
    fakeServer = createFakeOllamaServer('acceptance-model');
    const apiBase = await fakeServer.start();
    log(`Fake Ollama server listening at ${apiBase}`);

    const writeOllamaSettings = root => {
      fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.vscode', 'settings.json'),
        JSON.stringify(
          {
            'ollama-agent.providerType': 'ollama',
            'ollama-agent.apiBase': apiBase,
            'ollama-agent.chatModel': 'acceptance-model',
            'ollama-agent.codingModel': 'acceptance-model',
          },
          null,
          2,
        ),
      );
      run('git', ['add', '.vscode/settings.json'], { cwd: root });
      run('git', ['commit', '-m', 'add disposable acceptance workspace settings'], { cwd: root });
    };
    writeOllamaSettings(workspaceDir);

    log('Resolving VS Code (downloaded, cached after the first run)...');
    const { vscodeExecutablePath, cliArgs } = await resolveVSCode();
    log(`VS Code executable: ${vscodeExecutablePath}`);

    if (shouldRun('activation_registration')) {
      log('Scenario: activation_registration (normal isolated host, no --extensionTestsPath)');
      const activationWorkspaceDir = path.join(workDir, 'activation-workspace');
      fs.mkdirSync(activationWorkspaceDir, { recursive: true });
      provisionLocalTypeScript(activationWorkspaceDir);
      initGit(activationWorkspaceDir);
      writeOllamaSettings(activationWorkspaceDir);

      const beforeStatus = gitInspectMutation(activationWorkspaceDir);
      if (beforeStatus.status.trim() !== '') {
        throw new Error(`expected clean disposable workspace before activation_registration, got:\n${beforeStatus.status}`);
      }

      await runInPlainHost({
        scenarioName: 'activation_registration',
        vscodeExecutablePath,
        cliArgs,
        productionVsixPath,
        companionVsixPath,
        workspacePath: activationWorkspaceDir,
        goal: undefined,
        forceCompanionFailure,
        driver: async ({ statusFile }) => {
          const finalStatus = await waitForCompanionPhase(statusFile, 'passed', 15000);
          log(`activation_registration companion status: ${JSON.stringify(finalStatus)}`);
        },
      });

      const afterStatus = gitInspectMutation(activationWorkspaceDir);
      if (afterStatus.status.trim() !== '') {
        throw new Error(`activation_registration mutated the disposable workspace, got:\n${afterStatus.status}`);
      }
      log('activation_registration scenario passed (packaged extension + companion driver both loaded and active in a normal window; no mutation).');
    }

    if (shouldRun('modal_probe')) {
      log('Scenario: modal_probe (authoritative Checkpoint C proof — normal host, real modal, no --extensionTestsPath)');
      const modalWorkspaceDir = path.join(workDir, 'modal-probe-workspace');
      fs.mkdirSync(modalWorkspaceDir, { recursive: true });
      provisionLocalTypeScript(modalWorkspaceDir);
      initGit(modalWorkspaceDir);
      writeOllamaSettings(modalWorkspaceDir);

      await runInPlainHost({
        scenarioName: 'modal_probe',
        vscodeExecutablePath,
        cliArgs,
        productionVsixPath,
        companionVsixPath,
        workspacePath: modalWorkspaceDir,
        goal: undefined,
        driver: async ({ remoteDebuggingPort, statusFile, scenarioEvidenceDir }) => {
          // Companion dispatches probeModal() automatically on activation
          // (control.scenario === 'modal_probe'), so modal_invoked should
          // appear without any external command trigger.
          const invoked = await waitForCompanionPhase(statusFile, 'modal_invoked', 20000);
          log(`modal_probe: modal_invoked recorded: ${JSON.stringify(invoked)}`);

          const client = await uiDriver.connect(remoteDebuggingPort);
          try {
            await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'modal-t0');

            // Absolutely no input for >= 2s; only observe.
            const holdStart = Date.now();
            const holdMs = 2000;
            let resolvedDuringHold;
            while (Date.now() - holdStart < holdMs) {
              const status = readStatusFile(statusFile);
              if (status?.phase === 'modal_resolved' && !resolvedDuringHold) {
                resolvedDuringHold = { ...status, observedAfterMs: Date.now() - holdStart };
              }
              await new Promise(r => setTimeout(r, 150));
            }
            if (resolvedDuringHold) {
              throw new Error(`modal resolved with zero input during the ${holdMs}ms hold window: ${JSON.stringify(resolvedDuringHold)}`);
            }
            const afterHold = readStatusFile(statusFile);
            if (afterHold?.phase === 'modal_resolved') {
              throw new Error(`modal already resolved right after the hold window with no CDP input: ${JSON.stringify(afterHold)}`);
            }
            log(`modal_probe: modal still pending after ${holdMs}ms with zero input (as required).`);
            await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'modal-after-hold');

            const dialogText = await uiDriver.waitForModalDialog(client, 'Acceptance modal probe', { timeoutMs: 15000 });
            log(`modal_probe: modal visible in the real DOM: ${JSON.stringify(dialogText)}`);

            const buttonsVisible = await client.Runtime.evaluate({
              expression: `Array.from(document.querySelectorAll('.monaco-dialog-box .dialog-buttons a.monaco-button, .monaco-dialog-box .dialog-buttons button')).map(b => (b.textContent || '').trim())`,
              returnByValue: true,
            });
            const labels = buttonsVisible.result.value || [];
            log(`modal_probe: visible buttons: ${JSON.stringify(labels)}`);
            if (!labels.includes('Approve') || !labels.includes('Reject')) {
              throw new Error(`expected Approve and Reject buttons visible, got: ${JSON.stringify(labels)}`);
            }

            const clickedAt = Date.now();
            await uiDriver.clickModalButton(client, 'Approve');
            log('modal_probe: clicked Approve via real mouse input over CDP.');

            const resolved = await waitForCompanionPhase(statusFile, 'modal_resolved', 15000);
            if (resolved.result !== 'Approve') {
              throw new Error(`expected modal result "Approve", got: ${JSON.stringify(resolved)}`);
            }
            if (!(resolved.elapsedMs > holdMs)) {
              throw new Error(`expected modal elapsed time (${resolved.elapsedMs}ms) to exceed the no-input hold period (${holdMs}ms)`);
            }
            log(`modal_probe: PASSED — result=${resolved.result} elapsedMs=${resolved.elapsedMs} (click issued ${Date.now() - clickedAt}ms after resolution wait started)`);
          } finally {
            await client.close();
          }
        },
      });
    }

    if (shouldRun('rejection')) {
      log('Scenario: rejection (real command -> durable queue -> external CDP driver Escape)');
      const rejectionWorkspaceDir = path.join(workDir, 'rejection-workspace');
      fs.mkdirSync(rejectionWorkspaceDir, { recursive: true });
      provisionLocalTypeScript(rejectionWorkspaceDir);
      initGit(rejectionWorkspaceDir);
      writeOllamaSettings(rejectionWorkspaceDir);

      const goal = 'packaged acceptance rejection scenario: create a file that must never land';

      await runInPlainHost({
        scenarioName: 'rejection',
        vscodeExecutablePath,
        cliArgs,
        productionVsixPath,
        companionVsixPath,
        workspacePath: rejectionWorkspaceDir,
        goal,
        driver: async ({ remoteDebuggingPort, scenarioEvidenceDir }) => {
          const client = await uiDriver.connect(remoteDebuggingPort);
          let taskId;
          try {
            // The companion driver fires startAutonomousTask on activation
            // (before this driver callback starts), so a new task directory
            // can already exist by the time we get here — poll for it
            // directly (the workspace was freshly created for this scenario,
            // so there is no pre-existing baseline to disambiguate against)
            // rather than diffing against a "before" snapshot taken too late.
            taskId = await waitForNewTaskId(rejectionWorkspaceDir, []);
            log(`rejection: task created: ${taskId}`);
            await uiDriver.waitForQuickPick(client, 'Review Autonomous Proposal', { timeoutMs: 60000 });
            log('rejection: located the real production proposal-review QuickPick over CDP.');
            await uiDriver.pressEscapeToRejectQuickPick(client);
            log('rejection: dismissed the QuickPick with Escape (reject path) via real keyboard input over CDP.');
          } catch (error) {
            await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'ui-driver-failure');
            throw error;
          } finally {
            await client.close();
          }

          // Both the durable task record and the worktree lease/manifest are
          // written by independent code paths after the QuickPick dismissal,
          // so they can transition at different times. Poll each for up to
          // 30s and record every distinct value observed (with elapsed time)
          // as evidence, instead of accepting a single snapshot — a lease
          // still reading "active" on the first poll is not proof of a leak,
          // just a race between polling and the (already in-flight) release.
          const pollStart = Date.now();
          const taskTransitions = [];
          const leaseTransitions = [];
          let lastTaskState;
          let lastLeaseStatus;

          const finalTask = await pollUntil(
            () => {
              const task = readTask(rejectionWorkspaceDir, taskId);
              if (task && task.state !== lastTaskState) {
                lastTaskState = task.state;
                taskTransitions.push({ state: task.state, elapsedMs: Date.now() - pollStart });
              }
              const lease = readWorktreeLease(rejectionWorkspaceDir, taskId);
              const leaseStatus = lease ? lease.status : 'no-lease';
              if (leaseStatus !== lastLeaseStatus) {
                lastLeaseStatus = leaseStatus;
                leaseTransitions.push({ status: leaseStatus, elapsedMs: Date.now() - pollStart });
              }
              const taskDone = task?.state === 'cancelled';
              const leaseDone = leaseStatus !== 'active';
              return taskDone && leaseDone ? { done: true, value: task } : { done: false, value: { taskState: task?.state, leaseStatus } };
            },
            {
              timeoutMs: 30000,
              describe: () => {
                const events = readTaskEvents(rejectionWorkspaceDir, taskId);
                return `task ${taskId} to reach state "cancelled" with a non-active lease; taskTransitions=${JSON.stringify(taskTransitions)}; leaseTransitions=${JSON.stringify(leaseTransitions)}; lastEvents=${JSON.stringify(events.slice(-5))}`;
              },
            },
          );

          if (finalTask.state !== 'cancelled') {
            throw new Error(`expected task to be cancelled after external UI rejection, got "${finalTask.state}"; failure=${JSON.stringify(finalTask.failure)}; taskTransitions=${JSON.stringify(taskTransitions)}`);
          }

          const lease = readWorktreeLease(rejectionWorkspaceDir, taskId);
          if (lease && lease.status === 'active') {
            throw new Error(`expected worktree lease to be non-active after rejection, got "${lease.status}"; leaseTransitions=${JSON.stringify(leaseTransitions)}`);
          }

          log(`rejection: observed task transitions: ${JSON.stringify(taskTransitions)}`);
          log(`rejection: observed lease transitions: ${JSON.stringify(leaseTransitions)}`);

          const afterStatus = gitInspectMutation(rejectionWorkspaceDir).status;
          const sourceMutations = afterStatus.split('\n').filter(Boolean).filter(line => !line.slice(3).startsWith('.ollama-agent/'));
          if (sourceMutations.length > 0) {
            throw new Error(`expected original repository source tree to remain mutation-free after rejection, got:\n${sourceMutations.join('\n')}`);
          }

          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'evidence.json'),
            JSON.stringify({ status: 'passed', taskId, finalTaskState: finalTask.state, leaseStatus: lease ? lease.status : 'no-lease-created', taskTransitions, leaseTransitions }, null, 2),
          );
          log(`rejection scenario passed (taskId=${taskId}, finalState=${finalTask.state}, leaseStatus=${lease ? lease.status : 'no-lease-created'}).`);
        },
      });
    }

    if (shouldRun('success')) {
      log('Scenario: success (real command -> durable queue -> external CDP driver Approve twice: proposal + execution)');
      const successWorkspaceDir = path.join(workDir, 'success-workspace');
      fs.mkdirSync(successWorkspaceDir, { recursive: true });
      provisionLocalTypeScript(successWorkspaceDir);
      initGit(successWorkspaceDir);
      writeOllamaSettings(successWorkspaceDir);

      const goal = 'packaged acceptance success scenario: create the packaged acceptance file';

      await runInPlainHost({
        scenarioName: 'success',
        vscodeExecutablePath,
        cliArgs,
        productionVsixPath,
        companionVsixPath,
        workspacePath: successWorkspaceDir,
        goal,
        driver: async ({ remoteDebuggingPort, scenarioEvidenceDir }) => {
          const client = await uiDriver.connect(remoteDebuggingPort);
          let taskId;
          try {
            // See the rejection scenario for why this polls directly rather
            // than diffing against a "before" snapshot: the companion driver
            // fires startAutonomousTask on activation, before this callback
            // starts, in a freshly created workspace with no baseline tasks.
            taskId = await waitForNewTaskId(successWorkspaceDir, []);
            log(`success: task created: ${taskId}`);
            await uiDriver.waitForQuickPick(client, 'Review Autonomous Proposal', { timeoutMs: 60000 });
            log('success: located the real production proposal-review QuickPick over CDP.');
            await uiDriver.acceptQuickPickFirstItem(client);
            log('success: approved the proposal by accepting the QuickPick via real keyboard input over CDP.');
            await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'after-quickpick-accept');

            await uiDriver.waitForModalDialog(client, 'Apply autonomous task', { timeoutMs: 30000 });
            log('success: located the real production execution-approval modal over CDP.');
            await uiDriver.clickModalButton(client, 'Approve Execution');
            log('success: clicked "Approve Execution" via real mouse input over CDP.');
          } catch (error) {
            await uiDriver.captureFailureDiagnostics(client, scenarioEvidenceDir, 'ui-driver-failure');
            throw error;
          } finally {
            await client.close();
          }

          // The isolated worktree the M15 runtime creates via `git worktree
          // add` only contains committed files; provision it with the real,
          // already-packaged typescript copy (kept for ExecutionIntegrity
          // provenance validation) once the worktree location is known.
          const worktreeLocation = await pollUntil(
            () => {
              const task = readTask(successWorkspaceDir, taskId);
              return task?.worktreeLocation ? { done: true, value: task.worktreeLocation } : { done: false, value: task?.state };
            },
            { timeoutMs: 30000, describe: () => `task ${taskId} to bind an isolated worktree` },
          );
          fs.mkdirSync(path.join(worktreeLocation, 'node_modules'), { recursive: true });
          fs.cpSync(
            path.join(extensionDevelopmentPath, 'node_modules', 'typescript'),
            path.join(worktreeLocation, 'node_modules', 'typescript'),
            { recursive: true },
          );
          log(`success: provisioned worktree typescript at ${worktreeLocation}`);

          const TERMINAL_STATES = new Set(['waiting_for_delivery_approval', 'cancelled', 'blocked', 'completed', 'failed']);
          const finalTask = await pollUntil(
            () => {
              const task = readTask(successWorkspaceDir, taskId);
              return task && TERMINAL_STATES.has(task.state) ? { done: true, value: task } : { done: false, value: task?.state };
            },
            {
              timeoutMs: 120000,
              describe: () => {
                const events = readTaskEvents(successWorkspaceDir, taskId);
                const lease = readWorktreeLease(successWorkspaceDir, taskId);
                return `task ${taskId} to reach waiting_for_delivery_approval; lastEvents=${JSON.stringify(events.slice(-5))}; lease=${JSON.stringify(lease)}`;
              },
            },
          );

          if (finalTask.state !== 'waiting_for_delivery_approval') {
            throw new Error(`expected task to reach waiting_for_delivery_approval after external UI approval, got "${finalTask.state}"; failure=${JSON.stringify(finalTask.failure)}`);
          }
          if (!finalTask.qualityGate || finalTask.qualityGate.status !== 'passed') {
            throw new Error(`expected M16 quality gate to pass, got ${JSON.stringify(finalTask.qualityGate)}`);
          }

          const lease = readWorktreeLease(successWorkspaceDir, taskId);
          if (!lease) throw new Error('expected a worktree lease to have been created for a mutating task');
          if (lease.status === 'active') {
            throw new Error(`expected worktree lease to be non-active (retained for delivery review) after success, got "${lease.status}"`);
          }

          const worktreeStatus = gitInspectMutation(finalTask.worktreeLocation).status;
          if (!worktreeStatus.includes('packagedAcceptance.ts') && !worktreeStatus.includes('src/generated')) {
            throw new Error(`expected the mutation to be present in the isolated worktree, got:\n${worktreeStatus}`);
          }

          const originalStatus = gitInspectMutation(successWorkspaceDir).status;
          const originalSourceMutations = originalStatus.split('\n').filter(Boolean).filter(line => !line.slice(3).startsWith('.ollama-agent/'));
          if (originalSourceMutations.length > 0) {
            throw new Error(`expected original repository source tree to remain mutation-free (mutation must stay in the worktree), got:\n${originalSourceMutations.join('\n')}`);
          }

          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'evidence.json'),
            JSON.stringify(
              {
                status: 'passed',
                taskId,
                finalTaskState: finalTask.state,
                leaseStatus: lease.status,
                qualityGate: finalTask.qualityGate,
                worktreeLocation: finalTask.worktreeLocation,
              },
              null,
              2,
            ),
          );
          log(`success scenario passed (taskId=${taskId}, finalState=${finalTask.state}, leaseStatus=${lease.status}, qualityGate=${JSON.stringify(finalTask.qualityGate)}).`);
        },
      });
    }

    if (shouldRun('lower_level_executor_smoke')) {
      log('Scenario: lower_level_executor_smoke (NOT autonomous acceptance — direct GovernedCodingExecutor call via runTests(); never invokes a modal API)');
      const companionDriverPath = path.join(__dirname, 'companion-driver');
      await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: [extensionDevelopmentPath, companionDriverPath],
        extensionTestsPath: path.join(__dirname, 'runInHost.js'),
        launchArgs: [
          workspaceDir,
          '--disable-workspace-trust',
          '--user-data-dir',
          path.join(workDir, 'user-data-smoke'),
          '--extensions-dir',
          path.join(workDir, 'extensions-smoke'),
        ],
        extensionTestsEnv: {
          ...process.env,
          OLLAMA_AGENT_ACCEPTANCE_EVIDENCE_DIR: evidenceDir,
        },
      });

      log('Inspecting git working tree for the mutation the packaged extension produced...');
      const inspection = gitInspectMutation(workspaceDir);
      if (!inspection.status.includes('packagedAcceptance.ts')) {
        throw new Error(`expected git status to show the new mutation file, got:\n${inspection.status}`);
      }
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, 'git-status.txt'), inspection.status);
      fs.writeFileSync(path.join(evidenceDir, 'git-diff-stat.txt'), inspection.diffStat);
    }

    log(`PASSED. Evidence written to ${evidenceDir}`);
    exitCode = 0;
  } catch (error) {
    console.error('[packaged-acceptance] FAILED');
    console.error(error);
    if (retainedPaths.length > 0) {
      log(`Retained diagnostic paths (not cleaned up due to failure): ${retainedPaths.join(', ')}`);
    }
    log(`Work directory retained for inspection: ${workDir}`);
    exitCode = 1;
  } finally {
    if (fakeServer) {
      await fakeServer.stop();
    }
    if (exitCode === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      log('Cleaned up all temporary directories.');
    }
  }

  process.exit(exitCode);
}

main().catch(error => {
  console.error('[packaged-acceptance] FAILED');
  console.error(error);
  process.exit(1);
});
