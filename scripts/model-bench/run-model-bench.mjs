// Daily Golden model qualification runner.
// Orchestrates the existing packaged-VSIX Golden runner (scripts/golden/run-golden.mjs) once per
// model x scenario x repetition, sequentially, with no retries, checkpointing every result so --resume works.
//
//   node scripts/model-bench/run-model-bench.mjs [--suite qualifier|daily] [--scenario a,b] [--model name[,name]]
//        [--repetitions 3] [--cohort NAME] [--include-specialists] [--resume [dir]] [--timeout-min 25]
//        [--base-url url] [--vsix path] [--seed <int>] [--temperature <n>] [--dry-run]
//
// Default is stochastic qualification: no seed and no temperature are sent. --seed/--temperature (benchmark only)
// switch to a deterministic regression; they are recorded in the manifest, results, RUNS.csv and SUMMARY.md, and a
// --resume that asks for different values is refused.
//
// Every run dir is self-contained cohort evidence: manifest.json, results.json, RUNS.csv, SUMMARY.csv, SUMMARY.md
// (plus the legacy results.csv / REPORT.md). Historical runs are never mixed in automatically; use cohort.mjs to
// aggregate an explicit list of run dirs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { discoverModels } from './discover.mjs';
import { inspectVsix, readGoldenOutcome, readModelSelection, readRunSignals } from './evidence.mjs';
import {
  BENCHMARK_FORCED_MODEL_ENV, buildReport, buildResultRecord, latestRunDir, parseSampling, pendingTuples, resultsToCsv, safeName, samplingEnv, samplingLabel,
  samplingResumeConflict, selectModels, selectScenarios, splitForResume, uniqueStamp, writeCohortArtifacts,
} from './lib.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const benchRoot = path.join(root, '.model-bench');
const flag = name => process.argv.includes(name);
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback;
};
const dryRun = flag('--dry-run');
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// -- Run state (parameters come from the manifest on resume so a cohort never changes shape mid-way) ----------
let runDir;
let manifest;
let models;
let results;
let superseded = [];
if (flag('--resume')) {
  runDir = arg('--resume') ? path.resolve(arg('--resume')) : latestRunDir(benchRoot);
  if (!runDir) throw new Error('Nothing to resume: no .model-bench run found');
  manifest = readJson(path.join(runDir, 'manifest.json'));
  models = readJson(path.join(runDir, 'models.json'));
  const stored = fs.existsSync(path.join(runDir, 'results.json')) ? readJson(path.join(runDir, 'results.json')) : [];
  const previous = fs.existsSync(path.join(runDir, 'superseded.json')) ? readJson(path.join(runDir, 'superseded.json')) : [];
  ({ kept: results, superseded } = splitForResume(stored));
  superseded = [...previous, ...superseded];
  const requested = parseSampling({ seed: arg('--seed'), temperature: arg('--temperature') });
  const conflict = samplingResumeConflict(manifest.sampling, requested);
  if (conflict) throw new Error(conflict);
  manifest.sampling ??= { seed: null, temperature: null };
  console.log(`Resuming ${runDir}: ${results.length} result(s) kept${superseded.length ? `, ${superseded.length} harness failure(s) will be re-run` : ''}`);
} else {
  const runId = uniqueStamp();
  const sampling = parseSampling({ seed: arg('--seed'), temperature: arg('--temperature') });
  runDir = path.join(benchRoot, runId);
  models = discoverModels();
  let knownScenarios = null;
  try { knownScenarios = Object.keys((await import('../../src/ui-test/golden/scenarios.mjs')).SCENARIOS); } catch { /* validated by run-golden instead */ }
  const scenarios = selectScenarios({ suite: arg('--suite'), scenario: arg('--scenario') }, knownScenarios);
  const names = (arg('--model') ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const selected = names.length > 1
    ? names.flatMap(name => selectModels(models, { model: name, includeSpecialists: flag('--include-specialists') }))
    : selectModels(models, { model: names[0] ?? null, includeSpecialists: flag('--include-specialists') });
  if (selected.length === 0) throw new Error('No coding candidates to run');
  const repetitions = Math.max(1, Math.floor(Number(arg('--repetitions', '1')) || 1));
  const gitHead = git(['rev-parse', 'HEAD']);
  const vsixPath = path.resolve(arg('--vsix', path.join(root, '.golden-cache', 'vsix', gitHead, 'karkedikha-win32-x64.vsix')));
  manifest = {
    runId, cohort: arg('--cohort', null), sampling, suite: arg('--scenario') ? 'custom' : (arg('--suite') ?? 'qualifier'), scenarios, repetitions, retries: 0,
    baseUrl: arg('--base-url', process.env.GOLDEN_OLLAMA_URL ?? 'http://127.0.0.1:11434'), models: [...new Set(selected.map(item => item.name))],
    timeoutMs: Number(arg('--timeout-min', '25')) * 60_000, startedAt: new Date().toISOString(), gitHead, vsixOverride: Boolean(arg('--vsix')),
    vsix: { path: vsixPath, sha256: null, bytes: null },
  };
  results = [];
  if (!dryRun) {
    fs.mkdirSync(runDir, { recursive: true });
    write(path.join(runDir, 'manifest.json'), manifest);
    write(path.join(runDir, 'models.json'), models);
    write(path.join(runDir, 'results.json'), results);
  }
}
const baseUrl = manifest.baseUrl;
const timeoutMs = manifest.timeoutMs;
const repetitions = manifest.repetitions ?? 1;

// -- VSIX preflight: a missing or invalid package is a harness failure, never a model verdict ----------------
// On resume an explicit --vsix wins (e.g. the package was rebuilt in place); every record carries its own SHA.
const vsixCheck = inspectVsix(flag('--resume') && arg('--vsix') ? path.resolve(arg('--vsix'))
  : (manifest.vsix?.path ?? path.join(root, '.golden-cache', 'vsix', manifest.gitHead, 'karkedikha-win32-x64.vsix')));
manifest.vsix = { path: vsixCheck.path, sha256: vsixCheck.sha256, bytes: vsixCheck.bytes };
const provenance = { commitSha: manifest.gitHead ?? null, vsixSha256: vsixCheck.sha256 };
const sampling = manifest.sampling;

const pending = pendingTuples(manifest.models, manifest.scenarios, repetitions, results);
console.log(`Plan: ${manifest.models.length} model(s) x ${manifest.scenarios.length} scenario(s) x ${repetitions} repetition(s); ${pending.length} pending; retries 0; sampling: ${samplingLabel(sampling)}; run dir ${runDir}`);
console.log(`VSIX: ${vsixCheck.ok ? `${vsixCheck.path} sha256 ${vsixCheck.sha256}` : `UNUSABLE - ${vsixCheck.error}`}`);
if (dryRun) {
  for (const tuple of pending) console.log(`  would run ${tuple.model} :: ${tuple.scenario} :: rep ${tuple.repetition}`);
  process.exit(0);
}

const persist = () => {
  write(path.join(runDir, 'results.json'), results);
  if (superseded.length) write(path.join(runDir, 'superseded.json'), superseded);
  write(path.join(runDir, 'results.csv'), resultsToCsv(results));
  write(path.join(runDir, 'REPORT.md'), buildReport({ manifest, models, results }));
  writeCohortArtifacts(runDir, manifest, results);
};
const tupleDir = ({ model, scenario, repetition }) => path.join(runDir, safeName(model), scenario, ...(repetitions > 1 ? [`rep-${repetition}`] : []));
const store = (record, outDir) => {
  Object.assign(record, { runDir: outDir, cohort: manifest.cohort ?? null, finishedAt: record.finishedAt ?? new Date().toISOString() });
  results.push(record);
  write(path.join(outDir, 'result.json'), record);
  persist();
};

if (!vsixCheck.ok) {
  // Record every pending tuple as HARNESS_FAIL without spawning anything; --resume re-runs them once fixed.
  for (const tuple of pending) {
    const outDir = tupleDir(tuple);
    fs.mkdirSync(outDir, { recursive: true });
    store(buildResultRecord({ ...tuple, outcome: null, harnessError: vsixCheck.error, durationMs: null, provenance, sampling }), outDir);
  }
  console.log(`\nHARNESS_FAIL: ${vsixCheck.error}. Nothing was run. Fix the package, then --resume ${runDir}`);
  process.exit(2);
}

// -- Ollama helpers ------------------------------------------------------------
async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}
async function loadedModels() {
  try { return ((await (await fetch(`${baseUrl}/api/ps`)).json()).models ?? []).map(item => item.name); } catch { return []; }
}
/** Stop previous model, load + health-check the next. Not counted in scenario time. */
async function warm(model, previous) {
  if (previous && previous !== model) {
    try { execFileSync('ollama', ['stop', previous], { windowsHide: true, timeout: 60_000 }); } catch { /* not loaded */ }
  }
  const coldLoad = !(await loadedModels()).includes(model);
  const started = Date.now();
  await post('/api/generate', { model, prompt: 'Reply with OK.', stream: false, keep_alive: '30m', options: { num_predict: 8 } });
  return { loadMs: Date.now() - started, coldLoad };
}

// -- Golden invocation ---------------------------------------------------------
function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already gone */ }
}
// A stochastic cohort must never inherit sampling controls from the operator's shell.
const { KKD_BENCHMARK_SEED: _seed, KKD_BENCHMARK_TEMPERATURE: _temperature, ...baseEnv } = process.env;
function runGolden(model, scenario, logPath) {
  return new Promise(resolve => {
    const log = fs.createWriteStream(logPath);
    let output = '';
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'golden', 'run-golden.mjs'), '--model', model, '--scenarios', scenario, '--retries', '0', '--base-url', baseUrl, '--vsix', vsixCheck.path], {
      cwd: root, env: { ...baseEnv, GOLDEN_MODEL: model, [BENCHMARK_FORCED_MODEL_ENV]: model, ...samplingEnv(sampling) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const onData = chunk => { output += chunk; log.write(chunk); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', error => { clearTimeout(timer); log.end(); resolve({ timedOut, output, exitCode: null, spawnError: String(error) }); });
    child.once('exit', code => { clearTimeout(timer); log.end(); resolve({ timedOut, output, exitCode: code }); });
  });
}

/** Local-only: raw replies, parsed tool-call arguments and parser failures Core wrote under Golden (never in normal runs). */
function copyRawModelEvidence(evidenceRoot, scenario, outDir) {
  try {
    const attempts = path.join(evidenceRoot, scenario);
    for (const attempt of fs.readdirSync(attempts).sort()) {
      const file = path.join(attempts, attempt, 'core-data', 'golden-model-evidence.jsonl');
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(outDir, `golden-model-evidence-${attempt}.jsonl`));
    }
  } catch { /* evidence is best-effort */ }
}

let previous = null;
let warmInfo = null;
let warmedModel = null;
for (const tuple of pending) {
  const { model, scenario, repetition } = tuple;
  const modelInfo = models.find(item => item.name === model);
  const info = modelInfo ? { category: modelInfo.category, parameters: modelInfo.show?.parameters ?? null, contextLength: modelInfo.show?.contextLength ?? null, quantization: modelInfo.show?.quantization ?? null } : null;
  const outDir = tupleDir(tuple);
  fs.mkdirSync(outDir, { recursive: true });
  // Every repetition measures its own residency/load: a model that is still resident from the previous repetition is
  // reported warm with a near-zero loadMs. Nothing is unloaded to make a run look cold (only a different previous model is stopped).
  console.log(`\n--- ${warmedModel === model ? 'checking' : 'loading'} ${model} rep ${repetition} (previous: ${previous ?? 'none'}) ---`);
  try { warmInfo = await warm(model, previous); warmedModel = model; console.log(`ready in ${warmInfo.loadMs}ms (${warmInfo.coldLoad ? 'cold' : 'warm'})`); } catch (error) {
    warmInfo = null; warmedModel = null;
    console.log(`${model}: warm-up/health check failed: ${error.message}`);
    const record = buildResultRecord({ model, scenario, repetition, outcome: null, durationMs: null, modelInfo: info, provenance, sampling });
    Object.assign(record, {
      result: 'PROVIDER_FAIL', verdict: 'PROVIDER_FAIL', classification: 'PROVIDER_FAIL', failureFingerprint: 'provider_failure', evidenceFingerprints: ['provider_failure'],
      reason: `warm-up failed: ${error.message}`.slice(0, 200), firstAttemptResult: 'PROVIDER_FAIL', eventualResult: 'PROVIDER_FAIL',
    });
    store(record, outDir);
    previous = model;
    continue;
  }
  previous = model;
  console.log(`\n=== ${model} :: ${scenario} :: rep ${repetition}/${repetitions} ===`);
  const started = Date.now();
  const run = await runGolden(model, scenario, path.join(outDir, 'golden-run.log'));
  const durationMs = Date.now() - started;
  const { evidenceRoot, outcome, infraText } = readGoldenOutcome({ output: run.output, scenario });
  // A runner that died before writing a report leaves its error on stdout/stderr; keep the tail as harness evidence.
  const runnerText = outcome ? '' : run.output.slice(-2000);
  const record = buildResultRecord({
    model, scenario, repetition, outcome, timedOut: run.timedOut, harnessError: run.spawnError ?? null, durationMs,
    loadMs: warmInfo?.loadMs ?? null, coldLoad: warmInfo?.coldLoad ?? null, evidenceDir: evidenceRoot, infraText: `${infraText}\n${runnerText}`.trim(), modelInfo: info,
    modelSelection: evidenceRoot ? readModelSelection(evidenceRoot, scenario) : null,
    signals: evidenceRoot ? readRunSignals(evidenceRoot, scenario) : null, provenance, sampling,
  });
  if (evidenceRoot && fs.existsSync(path.join(evidenceRoot, 'golden-report.md'))) fs.copyFileSync(path.join(evidenceRoot, 'golden-report.md'), path.join(outDir, 'golden-report.md'));
  if (evidenceRoot) copyRawModelEvidence(evidenceRoot, scenario, outDir);
  store(record, outDir);
  console.log(`${model} :: ${scenario} :: rep ${repetition} -> ${record.verdict}${record.failureFingerprint ? ` [${record.failureFingerprint}]` : ''} (${Math.round(durationMs / 1000)}s)${record.reason ? ` - ${record.reason}` : ''}`);
}

if (previous) { try { execFileSync('ollama', ['stop', previous], { windowsHide: true, timeout: 60_000 }); } catch { /* ignore */ } }
manifest.finishedAt = new Date().toISOString();
persist();
console.log(`\nCohort summary: ${path.join(runDir, 'SUMMARY.md')}`);
