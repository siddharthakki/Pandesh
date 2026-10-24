import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { ExTester, ReleaseQuality, VSCODE_VERSION_MAX } from 'vscode-extension-tester';
import { discoverJourneyFiles, loadJourney } from '../../src/ui-test/support/contract.mjs';
import { lifecyclePhases } from '../../src/ui-test/journeys/lifecycleDriver.mjs';
import { startFakeOllamaServer } from '../../src/ui-test/support/fakeOllamaServer.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

// Journeys that actually exercise a model call (Baat Kar's ordinary answer,
// Saath Kar's write_file tool call and completion). All other P0/P1 lifecycle
// journeys drive Karke Dikha's deterministic trivial route (asserted
// elsewhere as modelCalls === 0) and are deliberately left on whatever the
// product's default apiBase/model configuration is — routing them through
// the fake model would be unnecessary per the approved architecture.
const MODEL_BACKED_JOURNEYS = new Set([
  'p0-lifecycle-smoke',
  'baat-kar-complete-history',
  'saath-kar-rejected-restoration',
  'saath-kar-approved-restoration',
]);

// Real-model dogfood escape hatch: when both are set, a model-backed journey
// is pointed at a real local Ollama + real model instead of the deterministic
// fake server (no fake server is started; the fake-ollama-summary harness
// assertions are skipped since there is no scripted request log to check —
// this run is deliberately non-deterministic and human-observed via the
// normal evidence capture instead). Never used by default; existing
// deterministic P0/P1 runs are completely unaffected.
const liveModelBaseUrl = process.env.GUARDIAN_LIVE_MODEL_BASE_URL;
const liveModelName = process.env.GUARDIAN_LIVE_MODEL_NAME;
const useLiveModel = Boolean(liveModelBaseUrl && liveModelName);

// Guardian-owned settings written into the workspace's `.vscode/settings.json`
// so the *installed* extension's normal Ollama provider (ProviderGateway ->
// OllamaProvider) resolves to the localhost fake server. No product source
// changes: apiBase/model are ordinary contributed configuration
// (package.json's `ollama-agent.*` properties).
function guardianModelSettings(apiBase, model) {
  return {
    'ollama-agent.providerType': 'ollama',
    'ollama-agent.apiBase': apiBase,
    'ollama-agent.model': model,
    'ollama-agent.chatModel': model,
    'ollama-agent.agentModel': model,
    'ollama-agent.editModel': model,
    'ollama-agent.codingModel': model,
    'ollama-agent.codingFallbackModel': model,
    'ollama-agent.reviewerModel': model,
  };
}

// Reads the fake Ollama request log recorded for a model-backed journey and
// returns a violation message, or null if the product behaved exactly as
// scripted. This only checks what the *model* was asked and returned; it
// never substitutes for the existing Core/tool/approval/Git assertions
// elsewhere in lifecycleDriver.mjs and runJourney.mjs, which independently
// prove the resulting mutation was caused by real product state (approvals,
// tool_invocations rows, Git diff) rather than by this harness or the fake
// server itself.
function validateFakeOllamaSummary(journey, summary) {
  if (summary.violations.length) {
    return `fake Ollama server saw ${summary.violations.length} unexpected request shape(s): ${summary.violations.join('; ')}`;
  }
  const expectedMinimumRequests = journey === 'p0-lifecycle-smoke' ? 4 : journey === 'baat-kar-complete-history' ? 1 : 2;
  if (summary.chatRequests < expectedMinimumRequests) {
    return `expected at least ${expectedMinimumRequests} /api/chat request(s) to the fake Ollama server, saw ${summary.chatRequests}`;
  }
  if (journey !== 'baat-kar-complete-history') {
    const toolOfferingRequests = summary.requests.filter(entry => (entry.toolNamesOffered ?? []).includes('write_file'));
    if (!toolOfferingRequests.length) {
      return 'expected at least one /api/chat request to actually offer the write_file tool';
    }
    const sawWriteFileCall = summary.requests.some(entry => entry.outcomeToolCall?.name === 'write_file');
    if (!sawWriteFileCall) {
      return 'expected the model response to include a write_file tool call';
    }
  }
  return null;
}
const suite = process.argv[2] ?? 'smoke';
const valueAfter = flag => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const suiteAliases = new Map([
  ['smoke', 'p0'],
  ['p0', 'p0'],
  ['p1', 'p1'],
  ['lifecycle', 'lifecycle'],
  ['workspace', 'workspace'],
  ['windows', 'windows'],
  ['installation', 'installation'],
  ['recovery', 'recovery'],
  ['negative', 'negative'],
  ['full', 'full'],
]);
const selectedSuite = suiteAliases.get(suite);
if (!selectedSuite) throw new Error(`Unknown guardian suite "${suite}"`);
// --only <id[,id...]> narrows an otherwise-selected suite down to specific
// journey IDs, e.g. re-proving one journey after a targeted fix without
// paying for the whole suite. It never widens selection beyond --suite.
const onlyIds = new Set((valueAfter('--only') ?? '').split(',').map(id => id.trim()).filter(Boolean));
const journeys = discoverJourneyFiles()
  .map(file => loadJourney(path.basename(file, '.yaml')))
  .filter(journey => journey.suites.includes(selectedSuite))
  .filter(journey => onlyIds.size === 0 || onlyIds.has(journey.id))
  .sort((left, right) => (left.p1Index ?? Number.MAX_SAFE_INTEGER) - (right.p1Index ?? Number.MAX_SAFE_INTEGER)
    || left.contractRelativePath.localeCompare(right.contractRelativePath));
if (onlyIds.size > 0 && journeys.length !== onlyIds.size) {
  const found = new Set(journeys.map(journey => journey.id));
  const missing = [...onlyIds].filter(id => !found.has(id));
  throw new Error(`--only requested journey(s) not in suite "${selectedSuite}": ${missing.join(', ')}`);
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sourceHead = git(root, ['rev-parse', 'HEAD']);
const supplied = valueAfter('--vsix') || process.env.GUARDIAN_VSIX
  || path.join(root, '.guardian-cache', 'vsix', sourceHead, 'karkedikha-win32-x64.vsix');
const vsixPath = path.resolve(supplied);
if (!fs.existsSync(vsixPath)) {
  throw new Error(`Frozen VSIX not found at ${vsixPath}. Run npm run test:guardian:build-vsix or pass --vsix.`);
}
const vsixBytes = fs.readFileSync(vsixPath);
const frozenSourceCandidate = path.basename(path.dirname(vsixPath));
const vsix = {
  path: vsixPath,
  bytes: vsixBytes.length,
  sha256: crypto.createHash('sha256').update(vsixBytes).digest('hex'),
  sourceHead: /^[0-9a-f]{40}$/i.test(frozenSourceCandidate) ? frozenSourceCandidate : null,
  guardianSourceHead: sourceHead,
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = path.join(root, '.guardian-evidence', `${stamp}-${suite}`);
const storage = path.join(root, '.guardian-cache', 'extest');
fs.mkdirSync(runRoot, { recursive: true });
fs.mkdirSync(storage, { recursive: true });
fs.writeFileSync(path.join(runRoot, 'vsix-provenance.json'), `${JSON.stringify(vsix, null, 2)}\n`);

const cacheTester = new ExTester(storage, ReleaseQuality.Stable);
await cacheTester.downloadCode(VSCODE_VERSION_MAX);
await cacheTester.downloadChromeDriver(VSCODE_VERSION_MAX);

function initWorkspace(journey, modelSettings) {
  const workspace = path.join(runRoot, journey, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Installed-product guardian workspace\n', 'utf8');
  const filesToCommit = ['README.md'];
  if (modelSettings) {
    // Written and committed before the initial commit so it is never a
    // stray untracked/modified file — every lifecycle journey asserts
    // `git status --porcelain=v1` is empty at rest.
    const vscodeDir = path.join(workspace, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(path.join(vscodeDir, 'settings.json'), `${JSON.stringify(modelSettings, null, 2)}\n`, 'utf8');
    filesToCommit.push('.vscode/settings.json');
  }
  git(workspace, ['init', '-b', 'guardian-main']);
  git(workspace, ['config', 'user.name', 'KarkeDikha Guardian']);
  git(workspace, ['config', 'user.email', 'guardian@example.invalid']);
  git(workspace, ['add', ...filesToCommit]);
  git(workspace, ['commit', '-m', 'Initialize guardian workspace']);
  return workspace;
}

function copyRuntimeLogs(sessionStorage, destination) {
  const candidates = [path.join(sessionStorage, 'test.log'), path.join(sessionStorage, 'settings', 'logs')];
  for (const source of candidates) {
    if (!fs.existsSync(source)) continue;
    const stat = fs.statSync(source);
    if (stat.isFile()) {
      fs.copyFileSync(source, path.join(destination, 'webdriver-test.log'));
      continue;
    }
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (/\.log$/i.test(entry.name)) {
          const relative = path.relative(source, absolute).replaceAll(path.sep, '__');
          fs.copyFileSync(absolute, path.join(destination, `vscode__${relative}`));
        }
      }
    };
    walk(source);
  }
}

function testOwnedCodeProcesses(sessionStorage) {
  if (process.platform !== 'win32') return [];
  const needle = sessionStorage.replaceAll("'", "''");
  const script = [
    `$needle = '${needle}'; `,
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like ('*' + $needle + '*') }",
    ' | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine',
    ' | ConvertTo-Json -Compress',
  ].join('');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function confirmTestOwnedCodeExited(sessionStorage, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let remaining = testOwnedCodeProcesses(sessionStorage);
  while (remaining.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    remaining = testOwnedCodeProcesses(sessionStorage);
  }
  return remaining;
}

function runPhaseProcess({ generatedTest, sessionStorage, extensions, workspace, runnerLog }) {
  const phaseScript = path.join(root, 'scripts', 'guardian', 'run-guardian-phase.mjs');
  const environment = {
    ...process.env,
    GUARDIAN_PHASE_STORAGE: sessionStorage,
    GUARDIAN_PHASE_EXTENSIONS: extensions,
    GUARDIAN_PHASE_TEST: generatedTest,
    GUARDIAN_PHASE_VSCODE_VERSION: VSCODE_VERSION_MAX,
    GUARDIAN_PHASE_MOCHA_CONFIG: path.join(root, 'src', 'ui-test', 'support', 'mocha.guardian.js'),
    GUARDIAN_WORKSPACE: workspace,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [phaseScript], {
      cwd: root,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      runnerLog.write(chunk);
    });
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      runnerLog.write(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`GUARDIAN_INFRASTRUCTURE_FAILURE: phase process exited by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function terminateTestOwnedCodeProcesses(processes) {
  if (process.platform !== 'win32' || !processes.length) return [];
  const ids = processes.map(item => Number(item.ProcessId)).filter(Number.isInteger);
  if (!ids.length) return [];
  const script = `$ids = @(${ids.join(',')}); Get-Process -Id $ids -ErrorAction SilentlyContinue | Stop-Process -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return ids;
}

async function runJourney(journey) {
  const contract = loadJourney(journey);
  const journeyRoot = path.join(runRoot, journey);
  const evidence = path.join(journeyRoot, 'evidence');
  const extensions = path.join(journeyRoot, 'extensions');
  const coreData = path.join(journeyRoot, 'core-data');
  const sessionStorage = path.join(journeyRoot, 'extest');
  fs.mkdirSync(evidence, { recursive: true });

  // The fake Ollama server is started (and its baseUrl committed into the
  // workspace's .vscode/settings.json) before the workspace's initial commit
  // so both the primary and restore phases see it, and it outlives every
  // per-phase Code.exe child process spawned below. In live-model mode there
  // is no fake server at all — the workspace is pointed at the real
  // apiBase/model instead.
  let fakeOllama = null;
  const isModelBacked = MODEL_BACKED_JOURNEYS.has(journey);
  if (isModelBacked && !useLiveModel) {
    fakeOllama = await startFakeOllamaServer({ logFilePath: path.join(evidence, 'fake-ollama-requests.jsonl') });
  }
  const modelSettings = fakeOllama
    ? guardianModelSettings(fakeOllama.baseUrl, fakeOllama.model)
    : (isModelBacked && useLiveModel) ? guardianModelSettings(liveModelBaseUrl, liveModelName) : null;
  const workspace = initWorkspace(journey, modelSettings);
  fs.mkdirSync(extensions, { recursive: true });
  fs.mkdirSync(coreData, { recursive: true });
  fs.mkdirSync(sessionStorage, { recursive: true });
  for (const entry of fs.readdirSync(storage, { withFileTypes: true })) {
    if (!entry.isDirectory() || (!entry.name.startsWith('VSCode-') && !entry.name.startsWith('chromedriver-'))) continue;
    fs.symlinkSync(path.join(storage, entry.name), path.join(sessionStorage, entry.name), 'junction');
  }
  fs.writeFileSync(path.join(evidence, 'vsix-provenance.json'), `${JSON.stringify(vsix, null, 2)}\n`);
  fs.writeFileSync(path.join(evidence, 'environment-identity.json'), `${JSON.stringify({
    vscodeVersion: VSCODE_VERSION_MAX,
    userDataDirectory: sessionStorage,
    extensionsDirectory: extensions,
    coreDataDirectory: coreData,
    workspace,
    repositoryHead: git(workspace, ['rev-parse', 'HEAD']),
    repositoryBranch: git(workspace, ['branch', '--show-current']),
  }, null, 2)}\n`);
  if (journey === 'p0-lifecycle-smoke') {
    const extensionEntries = fs.readdirSync(extensions);
    if (extensionEntries.length) throw new Error(`P0 requires an empty extensions directory before install: ${extensions}`);
    fs.writeFileSync(path.join(evidence, 'installation-precondition.json'), `${JSON.stringify({
      extensionInstalledBeforeTest: false,
      extensionEntries,
      checkedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  }

  const runnerLogPath = path.join(evidence, 'test-runner.log');
  const runnerLog = fs.createWriteStream(runnerLogPath, { flags: 'w' });
  const originalLog = console.log;
  const originalError = console.error;
  const record = original => (...args) => {
    const line = args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
    runnerLog.write(`${line}\n`);
    original(...args);
  };
  console.log = record(originalLog);
  console.error = record(originalError);

  const previous = {};
  const environment = {
    GUARDIAN_WORKSPACE: workspace,
    GUARDIAN_JOURNEY_EVIDENCE: evidence,
    GUARDIAN_CORE_DATA: coreData,
    GUARDIAN_INITIAL_BRANCH: 'guardian-main',
    GUARDIAN_JUNIT_PATH: path.join(evidence, 'junit.xml'),
    KARKEDIKHA_DATA_DIR: coreData,
    TEST_RESOURCES: sessionStorage,
    EXTENSIONS_FOLDER: extensions,
    // Core (core/runtime/executor.ts) owns its own model calls via a
    // process-wide OllamaModelBackend (core/runtime/modelBackend.ts) that
    // reads KARKEDIKHA_OLLAMA_URL at Core process spawn time — it is not
    // reconfigurable per request and does not read VS Code workspace
    // settings. CoreLauncher (src/core-client/CoreLauncher.ts) spawns Core
    // with `...process.env`, so setting this here on the Extension Host's
    // ancestor process env (exactly like KARKEDIKHA_DATA_DIR above) is the
    // only way to point Core's model traffic at the fake server; the
    // workspace's `ollama-agent.apiBase`/model settings (written in
    // initWorkspace) only control the model *name* requested per attempt
    // (`context.selectedModel`) and any legacy direct-provider paths.
    ...(fakeOllama ? { KARKEDIKHA_OLLAMA_URL: fakeOllama.baseUrl }
      : (isModelBacked && useLiveModel) ? { KARKEDIKHA_OLLAMA_URL: liveModelBaseUrl } : {}),
  };
  for (const [key, value] of Object.entries(environment)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  // Codex/VS Code terminals commonly export this so Electron CLIs behave as
  // Node. A real desktop launch must not inherit it or Code.exe exits as a
  // Node process before ChromeDriver can create the UI session.
  previous.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;

  let exitCode = 1;
  let fakeOllamaSummary = null;
  try {
    const installer = new ExTester(sessionStorage, ReleaseQuality.Stable, extensions);
    await installer.installVsix({ vsixFile: vsixPath });
    const generatedTest = path.join(root, 'src', 'ui-test', 'generated', contract.generatedRelativePath);
    const phases = journey === 'p0-lifecycle-smoke' ? ['primary', 'restore'] : lifecyclePhases(journey);
    exitCode = 0;
    for (const phase of phases) {
      process.env.GUARDIAN_PHASE = phase;
      process.env.GUARDIAN_JUNIT_PATH = path.join(evidence, `junit-${phase}.xml`);
      const startedAt = new Date().toISOString();
      const processesBefore = testOwnedCodeProcesses(sessionStorage);
      const phaseExit = await runPhaseProcess({ generatedTest, sessionStorage, extensions, workspace, runnerLog });
      const endedAt = new Date().toISOString();
      const processesAfterGrace = await confirmTestOwnedCodeExited(sessionStorage);
      const forceTerminatedProcessIds = terminateTestOwnedCodeProcesses(processesAfterGrace);
      const processesAfter = await confirmTestOwnedCodeExited(sessionStorage, 5_000);
      fs.writeFileSync(path.join(evidence, `process-${phase}.json`), `${JSON.stringify({
        phase,
        startedAt,
        endedAt,
        exitCode: phaseExit,
        vscodeProcessReturned: true,
        processesBefore,
        processesAfterGrace,
        forceTerminatedProcessIds,
        processesAfter,
        allTestOwnedCodeProcessesTerminated: processesAfter.length === 0,
      }, null, 2)}\n`);
      if (phaseExit === 0 && processesAfter.length) {
        fs.writeFileSync(path.join(evidence, 'failure-summary.txt'),
          `GUARDIAN_INFRASTRUCTURE_FAILURE: test-owned VS Code processes remained after ${phase}\n`);
        exitCode = 1;
        break;
      }
      if (phaseExit !== 0) {
        exitCode = phaseExit;
        break;
      }
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    runnerLog.end();
    copyRuntimeLogs(sessionStorage, evidence);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = 0;
    if (fakeOllama) {
      fakeOllamaSummary = {
        chatRequests: fakeOllama.chatRequests().length,
        violations: fakeOllama.violations(),
        requests: fakeOllama.requestLog,
      };
      fs.writeFileSync(path.join(evidence, 'fake-ollama-summary.json'), `${JSON.stringify(fakeOllamaSummary, null, 2)}\n`);
      await fakeOllama.close();
    }
  }

  if (exitCode === 0 && fakeOllamaSummary) {
    const violation = validateFakeOllamaSummary(journey, fakeOllamaSummary);
    if (violation) {
      fs.writeFileSync(path.join(evidence, 'failure-summary.txt'), `GUARDIAN_PRODUCT_FAILURE: ${violation}\n`);
      const error = new Error(`Guardian journey ${journey} product-failure. Evidence: ${evidence}`);
      error.guardianResult = { journey, status: 'product-failure', evidence };
      throw error;
    }
  }

  if (suite === 'negative') {
    const summaryPath = path.join(evidence, 'failure-summary.txt');
    const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '';
    if (exitCode === 0) throw new Error('Negative control unexpectedly passed');
    if (!summary.includes('CROSS_WORKSPACE_LEAKAGE_DETECTED')) {
      throw new Error(`Negative control failed for the wrong reason. Evidence: ${summaryPath}`);
    }
    fs.writeFileSync(path.join(evidence, 'negative-control-result.json'), `${JSON.stringify({
      status: 'expected-negative-control-failure',
      marker: 'CROSS_WORKSPACE_LEAKAGE_DETECTED',
      guardianRejectedCrossWorkspaceProjection: true,
    }, null, 2)}\n`);
    return { journey, status: 'expected-failure-proved', evidence };
  }
  if (exitCode !== 0) {
    const summaryPath = path.join(evidence, 'failure-summary.txt');
    const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '';
    const status = summary.includes('GUARDIAN_DRIVER_MISSING') ? 'driver-missing'
      : summary.includes('GUARDIAN_PRODUCT_FAILURE') ? 'product-failure'
        : summary.includes('GUARDIAN_INFRASTRUCTURE_FAILURE') ? 'infrastructure-failure'
          : summary.includes('GUARDIAN_ASSERTION_FAILURE') ? 'assertion-failure'
            : 'assertion-failure';
    const error = new Error(`Guardian journey ${journey} ${status}. Evidence: ${evidence}`);
    error.guardianResult = { journey, status, evidence };
    throw error;
  }
  return { journey, status: 'passed', evidence };
}

const results = [];
let runError;
for (const journey of journeys) {
  try {
    results.push(await runJourney(journey.id));
  } catch (error) {
    results.push(error.guardianResult ?? {
      journey: journey.id,
      status: 'infrastructure-failure',
      evidence: path.join(runRoot, journey.id, 'evidence'),
      error: error.message,
    });
    runError = error;
    break;
  }
}
const runResult = {
  suite,
  selectedSuite,
  vscodeVersion: VSCODE_VERSION_MAX,
  sourceHead,
  vsix,
  results,
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(runRoot, 'run-result.json'), `${JSON.stringify(runResult, null, 2)}\n`);
if (runError) throw runError;
console.log(`Guardian ${suite} completed. Evidence: ${runRoot}`);
