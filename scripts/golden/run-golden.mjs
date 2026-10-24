// KKD real-user golden acceptance runner.
// Installs the EXACT packaged .vsix into a fresh disposable VS Code profile,
// opens a fresh disposable Git workspace, and drives the real webview with a
// real local Ollama model. One fresh environment per scenario; independent
// scenarios keep running after a failure; one controlled retry per failure.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { ExTester, ReleaseQuality, VSCODE_VERSION_MAX } from 'vscode-extension-tester';
import { goldenRunRoot, prepareAttempt } from '../../src/ui-test/golden/fixtures.mjs';
import { legacyGoldenEvidenceWarning } from '../../src/ui-test/golden/goldenEvidenceRoot.mjs';
import { SCENARIOS } from '../../src/ui-test/golden/scenarios.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const baseUrl = arg('--base-url', process.env.GOLDEN_OLLAMA_URL ?? 'http://127.0.0.1:11434');
const model = arg('--model', process.env.GOLDEN_MODEL ?? 'qwen3-coder:swift-27b');
const wanted = (arg('--scenarios', Object.keys(SCENARIOS).filter(name => !name.startsWith('uat-') && !/^d\d/.test(name)).join(',')) ?? '').split(',').map(item => item.trim()).filter(Boolean);
const retries = Number(arg('--retries', '1'));
// Diagnostic only (bisecting webview JS without repackaging). Never used for acceptance evidence.
const mediaOverlay = arg('--media-overlay', null);
// --system-one shadow : enable the optional local System-One SHADOW provider (loopback) for the run; default off.
// --laya is a deprecated alias for --system-one, kept for existing callers.
const systemOneMode = arg('--system-one', arg('--laya', 'off'));
const systemOneEndpoint = arg('--system-one-endpoint', arg('--laya-endpoint', 'http://127.0.0.1:8771'));
for (const name of wanted) if (!SCENARIOS[name]) throw new Error(`Unknown scenario ${name}. Known: ${Object.keys(SCENARIOS).join(', ')}`);

const sourceHead = git(root, ['rev-parse', 'HEAD']);
const vsixPath = path.resolve(arg('--vsix', path.join(root, '.golden-cache', 'vsix', arg('--vsix-head', sourceHead), 'karkedikha-win32-x64.vsix')));
if (!fs.existsSync(vsixPath)) throw new Error(`Packaged VSIX not found at ${vsixPath} (build with npm run package:win32-x64 and place it there, or pass --vsix)`);
const vsixBytes = fs.readFileSync(vsixPath);
const vsix = {
  path: vsixPath,
  bytes: vsixBytes.length,
  sha256: crypto.createHash('sha256').update(vsixBytes).digest('hex'),
  builtAt: fs.statSync(vsixPath).mtime.toISOString(),
  gitHead: sourceHead,
};

const legacyWarning = legacyGoldenEvidenceWarning(root);
if (legacyWarning) console.warn(legacyWarning);
const runRoot = goldenRunRoot();
const cachedCode = path.join(root, '.guardian-cache', 'extest');
fs.mkdirSync(runRoot, { recursive: true });

async function modelIdentity() {
  const identity = { provider: 'ollama', model, endpoint: baseUrl, context: null, details: null };
  try {
    const response = await fetch(`${baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
    const body = await response.json();
    const info = body.model_info ?? {};
    const ctxKey = Object.keys(info).find(key => key.endsWith('.context_length'));
    identity.context = { trainedContextLength: ctxKey ? info[ctxKey] : null, parameters: body.parameters ?? null };
    identity.details = body.details ?? null;
  } catch (error) {
    identity.error = String(error);
  }
  return identity;
}

function ownedCodeProcesses(sessionStorage) {
  if (process.platform !== 'win32') return [];
  const needle = sessionStorage.replaceAll("'", "''");
  const script = `$n='${needle}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like ('*' + $n + '*') } | Select-Object -ExpandProperty ProcessId`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  return out ? out.split(/\r?\n/).map(Number).filter(Number.isInteger) : [];
}
function killAll(ids) {
  if (!ids.length) return;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Force -Id ${ids.join(',')} -ErrorAction SilentlyContinue`], { windowsHide: true });
}

function runPhase(env, logPath) {
  const log = fs.createWriteStream(logPath);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'guardian', 'run-guardian-phase.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log.write(chunk); });
    child.stderr.on('data', chunk => { log.write(chunk); });
    child.once('error', reject);
    child.once('exit', code => { log.end(); resolve(code ?? 1); });
  });
}

async function runAttempt(name, attempt) {
  const scenario = SCENARIOS[name];
  const settings = {
    'ollama-agent.providerType': 'ollama',
    'ollama-agent.apiBase': baseUrl,
    'ollama-agent.model': model,
    'ollama-agent.chatModel': model,
    'ollama-agent.agentModel': model,
    'ollama-agent.editModel': model,
    'ollama-agent.codingModel': model,
    'ollama-agent.codingFallbackModel': model,
    'ollama-agent.reviewerModel': model,
    ...(systemOneMode === 'shadow' ? { 'ollama-agent.systemOne.enabled': true, 'ollama-agent.systemOne.mode': 'shadow', 'ollama-agent.systemOne.endpoint': systemOneEndpoint } : {}),
  };
  const { evidence, extensions, coreData, sessionStorage, workspace } = prepareAttempt({ runRoot, name, attempt, fixture: scenario.fixture, settings });
  for (const entry of fs.readdirSync(cachedCode, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name.startsWith('VSCode-') || entry.name.startsWith('chromedriver-'))) {
      fs.symlinkSync(path.join(cachedCode, entry.name), path.join(sessionStorage, entry.name), 'junction');
    }
  }
  fs.writeFileSync(path.join(evidence, 'environment-identity.json'), `${JSON.stringify({
    scenario: name, attempt, vscodeVersion: VSCODE_VERSION_MAX, workspace, extensions, coreData, sessionStorage,
    workspaceHead: git(workspace, ['rev-parse', 'HEAD']), vsix,
    // Benchmark-only controls; null means the field is not sent (model defaults, stochastic).
    sampling: { seed: process.env.KKD_BENCHMARK_SEED ?? null, temperature: process.env.KKD_BENCHMARK_TEMPERATURE ?? null },
  }, null, 2)}\n`);

  const env = {
    ...process.env,
    GOLDEN_SCENARIO: name,
    GUARDIAN_WORKSPACE: workspace,
    GUARDIAN_JOURNEY_EVIDENCE: evidence,
    GUARDIAN_CORE_DATA: coreData,
    KARKEDIKHA_DATA_DIR: coreData,
    KKD_GOLDEN_RAW_MODEL_EVIDENCE: '1', // Core appends raw replies/parsed args/parser failures to core-data/golden-model-evidence.jsonl
    KARKEDIKHA_OLLAMA_URL: baseUrl,
    TEST_RESOURCES: sessionStorage,
    EXTENSIONS_FOLDER: extensions,
    GUARDIAN_JUNIT_PATH: path.join(evidence, 'junit.xml'),
    GUARDIAN_PHASE_STORAGE: sessionStorage,
    GUARDIAN_PHASE_EXTENSIONS: extensions,
    GUARDIAN_PHASE_TEST: path.join(root, 'src', 'ui-test', 'golden', 'golden.spec.mjs'),
    GUARDIAN_PHASE_VSCODE_VERSION: VSCODE_VERSION_MAX,
    GUARDIAN_PHASE_MOCHA_CONFIG: path.join(root, 'src', 'ui-test', 'support', 'mocha.guardian.js'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  let exitCode = 1;
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    const installer = new ExTester(sessionStorage, ReleaseQuality.Stable, extensions);
    await installer.installVsix({ vsixFile: vsixPath });
    if (mediaOverlay) {
      const installed = fs.readdirSync(extensions).map(name => path.join(extensions, name)).find(dir => fs.existsSync(path.join(dir, 'media')));
      fs.cpSync(mediaOverlay, installed, { recursive: true, force: true }); // overlay dir mirrors the extension root (media/…, out/…)
      fs.writeFileSync(path.join(evidence, 'MEDIA-OVERLAY-DIAGNOSTIC.txt'), `overlay ${mediaOverlay}: ${mediaOverlay}
`);
    }
    exitCode = await runPhase(env, path.join(evidence, 'runner.log'));
  } catch (error) {
    fs.writeFileSync(path.join(evidence, 'infrastructure-error.txt'), String(error.stack ?? error));
  } finally {
    if (previous !== undefined) process.env.ELECTRON_RUN_AS_NODE = previous;
    killAll(ownedCodeProcesses(sessionStorage));
  }
  // System-One shadow telemetry (if any) is evidence: keep it next to the run's other artifacts.
  const systemOneTelemetry = path.join(workspace, '.ollama-agent', 'telemetry', 'system-one-shadow.jsonl');
  const systemOneTelemetryPresent = fs.existsSync(systemOneTelemetry);
  if (systemOneTelemetryPresent) fs.copyFileSync(systemOneTelemetry, path.join(evidence, 'system-one-shadow.jsonl'));
  fs.writeFileSync(path.join(evidence, 'system-one-run-mode.json'), `${JSON.stringify({ systemOneMode, systemOneEndpoint: systemOneMode === 'shadow' ? systemOneEndpoint : null, systemOneTelemetryPresent }, null, 2)}
`);
  let result = null;
  const resultPath = path.join(evidence, `${name}-result.json`);
  if (fs.existsSync(resultPath)) result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const passed = exitCode === 0 && result?.status === 'passed';
  return {
    scenario: name, attempt, passed, exitCode, durationMs: Date.now() - started, evidence, workspace,
    failure: passed ? null : (result?.error ?? 'no scenario result written (infrastructure/launch failure)').split('\n')[0].slice(0, 400),
    turns: result?.turns ?? [], checks: result?.checks ?? [],
  };
}

const identity = await modelIdentity();
fs.writeFileSync(path.join(runRoot, 'run-identity.json'), `${JSON.stringify({ vsix, gitHead: sourceHead, vscodeVersion: VSCODE_VERSION_MAX, model: identity, scenarios: wanted, startedAt: new Date().toISOString() }, null, 2)}\n`);

const outcomes = [];
for (const name of wanted) {
  const attempts = [];
  let final;
  for (let attempt = 1; attempt <= 1 + retries; attempt += 1) {
    console.log(`\n=== ${name} (attempt ${attempt}) ===`);
    final = await runAttempt(name, attempt);
    attempts.push(final);
    console.log(`${name} attempt ${attempt}: ${final.passed ? 'PASS' : `FAIL — ${final.failure}`}`);
    if (final.passed) break;
    // Same failure twice in a row is a deterministic product failure; stop retrying.
    if (attempts.length >= 2 && attempts.at(-1).failure === attempts.at(-2).failure) break;
  }
  const passedOnRetry = final.passed && attempts.length > 1;
  const twiceSame = !final.passed && attempts.length > 1 && attempts.at(-1).failure === attempts.at(-2).failure;
  outcomes.push({
    scenario: name, title: SCENARIOS[name].title, passed: final.passed, attempts: attempts.length,
    classification: final.passed ? (passedOnRetry ? 'PASS (on controlled retry — stochastic model failure first)' : 'PASS')
      : twiceSame ? 'FAIL (same failure twice — treated as deterministic product failure)' : 'FAIL',
    firstFailure: attempts[0].passed ? null : attempts[0].failure,
    lastFailure: final.failure, durationMs: attempts.reduce((sum, item) => sum + item.durationMs, 0),
    evidence: final.evidence,
    conversationIds: [...new Set(final.turns.map(turn => turn.coreConversationId).filter(Boolean))],
    taskIds: final.turns.map(turn => turn.taskId).filter(Boolean),
    attemptIds: final.turns.map(turn => turn.attemptId).filter(Boolean),
    turns: final.turns.map(turn => ({ prompt: turn.prompt, route: turn.route, approvals: turn.approvals.map(item => item.kind), tools: turn.tools.map(item => item.tool), changedWorkspace: turn.changedWorkspace, durationMs: turn.durationMs, terminal: turn.taskState ?? turn.attemptStatus })),
    failedChecks: final.checks.filter(check => !check.pass).map(check => check.name),
  });
}

const report = { vsix, gitHead: sourceHead, vscodeVersion: VSCODE_VERSION_MAX, model: identity, finishedAt: new Date().toISOString(), outcomes };
fs.writeFileSync(path.join(runRoot, 'golden-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const md = [
  '# KKD golden acceptance report', '',
  `- Git HEAD: ${sourceHead}`, `- VSIX: ${path.basename(vsixPath)} sha256 ${vsix.sha256} (built ${vsix.builtAt})`,
  `- VS Code: ${VSCODE_VERSION_MAX}`, `- Model: ${identity.provider} / ${model} @ ${baseUrl} (context ${JSON.stringify(identity.context)})`, '',
  '| Scenario | Packaged VSIX | Real local model | Result | Notes |', '|---|---|---|---|---|',
  ...outcomes.map(o => `| ${o.title} | yes | yes | ${o.classification} | ${o.passed ? `${Math.round(o.durationMs / 1000)}s` : (o.lastFailure ?? '').replace(/\|/g, '/')} |`),
].join('\n');
fs.writeFileSync(path.join(runRoot, 'golden-report.md'), `${md}\n`);
console.log(`\n${md}\nEvidence: ${runRoot}`);
process.exitCode = outcomes.every(o => o.passed) ? 0 : 1;
