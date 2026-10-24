// Deterministic tests for the model qualification runner. No live model calls.
// Run: node --test scripts/model-bench/lib.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SUITES, benchmarkSelectionFields, buildReport, buildResultRecord, qualifyForBenchmark, classifyModel, classifyResult, latestRunDir, parseOllamaList, parseOllamaShow,
  pendingPairs, resultsToCsv, selectModels, selectScenarios, summarizeByModel,
  VERDICTS, FINGERPRINTS, asciiText, buildCohortSummary, deriveEvidenceFingerprints, looksLikeVsix, pendingTuples, runsToCsv, splitForResume,
  summarizeCohort, summaryToCsv, writeCohortArtifacts,
} from './lib.mjs';
import { inspectVsix, readGoldenOutcome } from './evidence.mjs';

const NL = String.fromCharCode(10);
const LIST = [
  'NAME                                       ID              SIZE      MODIFIED     ',
  'gpt-oss:20b                                17052f91a42e    13 GB     10 days ago     ',
  'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M  17a859d840cd    2.5 GB    2 months ago    ',
  'functiongemma:270m                         7c19b650567a    300 MB    4 weeks ago     ',
].join(NL);

const SHOW_GPT = [
  '  Model', '    architecture        gptoss    ', '    parameters          20.9B     ', '    context length      131072    ', '    quantization        MXFP4     ', '',
  '  Capabilities', '    completion     ', '    tools          ', '    thinking       ', '        levels     low, medium, high    ', '',
  '  Parameters', '    temperature    1    ',
].join(NL);

test('parses ollama list', () => {
  const models = parseOllamaList(LIST);
  assert.deepEqual(models.map(item => item.name), ['gpt-oss:20b', 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M', 'functiongemma:270m']);
  assert.equal(models[0].sizeBytes, 13e9);
  assert.equal(models[2].sizeBytes, 300e6);
  assert.equal(models[0].modified, '10 days ago');
  assert.deepEqual(parseOllamaList(''), []);
});

test('parses ollama show including nested capability levels', () => {
  const show = parseOllamaShow(SHOW_GPT);
  assert.equal(show.parameters, '20.9B');
  assert.equal(show.contextLength, 131072);
  assert.equal(show.quantization, 'MXFP4');
  assert.deepEqual(show.capabilities, ['completion', 'tools', 'thinking']);
});

test('classifies models', () => {
  assert.equal(classifyModel('gpt-oss:20b', parseOllamaShow(SHOW_GPT)).category, 'CODING_CANDIDATE');
  assert.equal(classifyModel('nomic-embed-text:latest', { capabilities: ['embedding'] }).category, 'RETRIEVAL');
  assert.equal(classifyModel('hf.co/x/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0', { capabilities: ['completion'] }).category, 'RETRIEVAL');
  assert.equal(classifyModel('some-embedder:1b', { capabilities: ['embedding'] }).category, 'RETRIEVAL');
  assert.equal(classifyModel('functiongemma:270m', { capabilities: ['completion', 'tools'], parameterCount: 2.7e8, parameters: '270M' }).category, 'SPECIALIST');
  assert.equal(classifyModel('tiny:500m', { capabilities: ['completion'], parameterCount: 5e8, parameters: '500M' }).category, 'SPECIALIST');
  assert.equal(classifyModel('clef-flash:latest', { capabilities: ['decision'] }).category, 'SPECIALIST');
  assert.equal(classifyModel('vision-only:1', { capabilities: ['vision'] }).category, 'SKIPPED');
  assert.equal(classifyModel('mystery:1', null).category, 'CODING_CANDIDATE');
  for (const name of ['a', 'nomic-embed-text', 'x-rerank']) assert.ok(classifyModel(name, null).reason);
});

const INVENTORY = [
  { name: 'gpt-oss:20b', category: 'CODING_CANDIDATE' },
  { name: 'qwen3-coder:swift-27b', category: 'CODING_CANDIDATE' },
  { name: 'functiongemma:270m', category: 'SPECIALIST' },
  { name: 'nomic-embed-text:latest', category: 'RETRIEVAL' },
];

test('model filtering', () => {
  assert.deepEqual(selectModels(INVENTORY).map(item => item.name), ['gpt-oss:20b', 'qwen3-coder:swift-27b']);
  assert.deepEqual(selectModels(INVENTORY, { includeSpecialists: true }).map(item => item.name), ['gpt-oss:20b', 'qwen3-coder:swift-27b', 'functiongemma:270m']);
  assert.deepEqual(selectModels(INVENTORY, { model: 'gpt-oss:20b' }).map(item => item.name), ['gpt-oss:20b']);
  assert.deepEqual(selectModels(INVENTORY, { model: 'swift' }).map(item => item.name), ['qwen3-coder:swift-27b']);
  assert.equal(selectModels(INVENTORY, { model: 'functiongemma:270m' })[0].forced, true);
  assert.throws(() => selectModels(INVENTORY, { model: 'nope' }), /not found/);
  assert.throws(() => selectModels(INVENTORY, { model: 'qwen3-coder:swift-27b'.slice(0, 0) + 'o' }), /ambiguous/);
});

test('scenario selection', () => {
  assert.deepEqual(selectScenarios({}), SUITES.qualifier);
  assert.deepEqual(selectScenarios({ suite: 'qualifier' }), ['d1-small-bug', 'd4-natural-report', 'd6-follow-up']);
  assert.deepEqual(selectScenarios({ suite: 'daily' }), SUITES.daily);
  assert.deepEqual(selectScenarios({ suite: 'qualifier', scenario: 'd1-small-bug' }), ['d1-small-bug']);
  assert.deepEqual(selectScenarios({ scenario: 'd1-small-bug, d6-follow-up' }), ['d1-small-bug', 'd6-follow-up']);
  assert.throws(() => selectScenarios({ suite: 'bogus' }), /Unknown suite/);
  assert.throws(() => selectScenarios({ scenario: 'zzz' }, ['d1-small-bug']), /Unknown scenario/);
});

test('resume skips completed model x scenario pairs', () => {
  const done = [{ model: 'a', scenario: 's1' }, { model: 'a', scenario: 's2' }, { model: 'b', scenario: 's1' }];
  assert.deepEqual(pendingPairs(['a', 'b'], ['s1', 's2'], done), [{ model: 'b', scenario: 's2' }]);
  assert.equal(pendingPairs(['a'], ['s1'], done).length, 0);
  assert.equal(pendingPairs(['a', 'b'], ['s1', 's2'], []).length, 4);
});

test('latestRunDir picks newest run that has a manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-'));
  assert.equal(latestRunDir(path.join(root, 'missing')), null);
  for (const name of ['2026-01-01', '2026-02-01', '2026-03-01']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, '2026-01-01', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(root, '2026-02-01', 'manifest.json'), '{}');
  assert.equal(path.basename(latestRunDir(root)), '2026-02-01');
});

test('failure classification from sample evidence', () => {
  const c = input => classifyResult(input).classification;
  assert.equal(c({ passed: true }), 'PASS');
  assert.equal(c({ timedOut: true }), 'TIMEOUT');
  assert.equal(c({ failure: 'Turn did not reach a terminal state within 1200000ms: "x"' }), 'TIMEOUT');
  assert.equal(c({ failure: 'no scenario result written (infrastructure/launch failure)' }), 'HARNESS_FAIL');
  assert.equal(c({ harnessError: 'spawn ENOENT' }), 'HARNESS_FAIL');
  assert.equal(c({ failure: 'fetch failed ECONNREFUSED 127.0.0.1:11434' }), 'PROVIDER_FAIL');
  assert.equal(c({ failure: 'registry.ollama.ai/x does not support tools' }), 'HARD_INCOMPATIBLE');
  assert.equal(c({ failure: 'Error: PRODUCT_DEAD_END on "x": No available configured model on provider "ollama" satisfies the task requirements.' }), 'HARNESS_FAIL');
  assert.equal(c({ failure: 'The explicit override model "x" is incompatible with the task requirements: Context window 1024 is below required 8192.' }), 'HARD_INCOMPATIBLE');
  assert.equal(c({ failure: 'The explicit override model "x" is incompatible with the task requirements: Model is not available.' }), 'PROVIDER_FAIL');
  assert.equal(c({ failure: 'The explicit override model "x" is not configured for provider "ollama".' }), 'PROVIDER_FAIL');
  assert.equal(c({ failure: 'Error: PRODUCT_DEAD_END on "x": ⚠ The model could not produce an actionable mutation proposal after one corrective turn.' }), 'MODEL_QUALITY_FAIL');
  assert.equal(c({ failure: 'Error: PRODUCT_DEAD_END on "x": ⚠ blocked after repeated non-progress for governed_research; choose a different target' }), 'MODEL_QUALITY_FAIL');
  assert.equal(c({ failure: 'context_window exceeded' }), 'PRODUCT_DEAD_END');
  assert.equal(c({ failure: 'validation_gap: no runner' }), 'PRODUCT_DEAD_END');
  assert.equal(c({ failure: 'recovery_exhausted' }), 'PRODUCT_DEAD_END');
  assert.equal(c({ failure: '1 check(s) failed', failedChecks: ['negative and zero amounts are rejected'] }), 'MODEL_QUALITY_FAIL');
  assert.equal(c({ failure: '1 check(s) failed', failedChecks: ['T2 stayed conversational (no Karke route)'] }), 'PRODUCT_DEAD_END');
  assert.equal(c({ failure: 'something odd' }), 'UNCLASSIFIED');
});

const OUTCOME_FAIL = { passed: false, lastFailure: '1 check(s) failed', failedChecks: ['project tests pass'], turns: [{ tools: [{ tool: 'read' }, { tool: 'edit' }], approvals: [{ kind: 'proposal' }], changedWorkspace: true, terminal: 'completed', route: { resolved: 'saath' } }] };
const OUTCOME_PASS = { passed: true, failedChecks: [], turns: [{ tools: [{ tool: 'read' }], approvals: [], changedWorkspace: true, terminal: 'completed', route: { resolved: 'saath' } }] };

test('result record serialization is complete, role-ready and invents no numbers', () => {
  const record = buildResultRecord({ model: 'gpt-oss:20b', scenario: 'd1-small-bug', outcome: OUTCOME_PASS, durationMs: 180000, loadMs: 9000, coldLoad: true, evidenceDir: 'x' });
  const round = JSON.parse(JSON.stringify(record));
  assert.equal(round.result, 'PASS');
  assert.equal(round.firstAttemptResult, 'PASS');
  assert.equal(round.attempts, 1);
  assert.deepEqual(Object.keys(round.roles).sort(), ['analyst', 'implementer', 'planner', 'reviewer', 'validator']);
  assert.ok(Object.values(round.roles).every(value => value === 'gpt-oss:20b'));
  assert.equal(round.metrics.toolCalls, 1);
  assert.equal(round.metrics.modelCalls, null);
  assert.equal(round.metrics.filesInspected, null);
  const failed = buildResultRecord({ model: 'm', scenario: 's', outcome: OUTCOME_FAIL, durationMs: 1000 });
  assert.equal(failed.result, 'MODEL_QUALITY_FAIL');
  assert.equal(failed.firstAttemptResult, 'MODEL_QUALITY_FAIL');
  assert.equal(failed.validationResult, false);
  assert.equal(buildResultRecord({ model: 'm', scenario: 's', outcome: null, timedOut: true }).result, 'TIMEOUT');
  // No Golden outcome at all is harness evidence, not an unknown.
  assert.equal(buildResultRecord({ model: 'm', scenario: 's', outcome: null }).result, 'HARNESS_FAIL');
});

test('csv and report generation', () => {
  const results = [
    buildResultRecord({ model: 'gpt-oss:20b', scenario: 'd1-small-bug', outcome: OUTCOME_PASS, durationMs: 120000 }),
    buildResultRecord({ model: 'gpt-oss:20b', scenario: 'd4-natural-report', outcome: OUTCOME_PASS, durationMs: 240000 }),
    buildResultRecord({ model: 'kat', scenario: 'd1-small-bug', outcome: OUTCOME_FAIL, durationMs: 60000 }),
  ];
  const csv = resultsToCsv(results);
  assert.equal(csv.trim().split(NL).length, 4);
  assert.match(csv, /^model,scenario,repetition,result,failureFingerprint/);
  const rows = summarizeByModel(results);
  assert.deepEqual(rows.map(row => [row.model, row.passed, row.total, row.modelQualityFails]), [['gpt-oss:20b', 2, 2, 0], ['kat', 0, 1, 1]]);
  assert.equal(rows[0].avgMs, 180000);
  const report = buildReport({ manifest: { runId: 'r1', suite: 'qualifier', scenarios: ['d1-small-bug'] }, models: INVENTORY, results });
  assert.match(report, /KKD Daily Golden - Model Qualification/);
  assert.match(report, /\| gpt-oss:20b \| 2\/2 \| 100% \| 3\.0m \| 0 \|/);
  assert.match(report, /Recommended for deeper qualification[\s\S]*gpt-oss:20b/);
  assert.match(report, /nomic-embed-text:latest - RETRIEVAL/);
  assert.ok(/^[\t\n\r\x20-\x7e]*$/.test(report), 'report is ASCII');
  assert.match(report, /Insufficient evidence for per-stage routing/);
  assert.match(buildReport({ results: [] }), /no results yet/);
});

test('benchmark qualification refuses only hard-incompatible models and records the forced flag', () => {
  const generative = { name: 'gpt-oss:20b', category: 'CODING_CANDIDATE' };
  assert.equal(qualifyForBenchmark(generative).runnable, true);
  assert.equal(qualifyForBenchmark({ name: 'nomic-embed-text:latest', category: 'RETRIEVAL', reason: 'embedding model' }).runnable, false);
  assert.throws(() => selectModels([{ name: 'x-reranker:1b', category: 'RETRIEVAL', reason: 'reranker (name)' }], { model: 'x-reranker' }), /cannot be benchmarked/);
  assert.equal(selectModels([generative], { model: 'gpt-oss:20b' })[0].forced, true);
  assert.deepEqual(benchmarkSelectionFields({ normalEligibility: 'below_preference_floor' }), { benchmarkForcedModel: true, normalEligibility: 'below_preference_floor', eligibilityReason: 'no model-selection evidence recorded' });
  assert.deepEqual(benchmarkSelectionFields({ normalEligibility: 'below_preference_floor', eligibilityReason: 'Reliability 0.60 is below required 0.80.' }), { benchmarkForcedModel: true, normalEligibility: 'below_preference_floor', eligibilityReason: 'Reliability 0.60 is below required 0.80.' });
  assert.deepEqual(benchmarkSelectionFields(null), { benchmarkForcedModel: true, normalEligibility: 'unknown', eligibilityReason: 'no model-selection evidence recorded' });
});

test('unavailable provider still classifies as PROVIDER_FAIL', () => {
  assert.equal(classifyResult({ failure: 'fetch failed ECONNREFUSED 127.0.0.1:11434' }).classification, 'PROVIDER_FAIL');
});

const DEAD_END = text => `Error: PRODUCT_DEAD_END on "In my expense app, adding an expense with a negative amount gets accepted.": ${text}`;

test('top-level verdicts with fingerprints; PRODUCT_DEAD_END never becomes UNCLASSIFIED', () => {
  const r = input => { const out = classifyResult(input); return `${out.verdict}/${out.failureFingerprint}`; };
  assert.equal(r({ failure: DEAD_END('⚠ bounded validation repair was exhausted') }), 'MODEL_QUALITY_FAIL/validation_repair_exhausted');
  assert.equal(r({ failure: DEAD_END('⚠ The model could not produce an actionable mutation proposal after one corrective turn.') }), 'MODEL_QUALITY_FAIL/no_action_after_correction');
  assert.equal(r({ failure: DEAD_END('⚠ blocked after repeated non-progress for read_file') }), 'MODEL_QUALITY_FAIL/no_progress');
  assert.equal(r({ failure: DEAD_END('something the classifier has never seen') }), 'PRODUCT_DEAD_END/product_dead_end');
  assert.equal(classifyResult({ failure: DEAD_END('novel dead end text') }).reason, 'novel dead end text');
  assert.equal(r({ failure: 'Error: attempt cancelled by the user' }), 'CANCELLED/cancelled');
  assert.equal(r({ failure: 'model_output_truncated at 4096 tokens' }), 'MODEL_QUALITY_FAIL/model_output_truncated');
  assert.equal(r({ failure: 'something odd' }), 'UNCLASSIFIED/unclassified');
  assert.equal(r({ passed: true }), 'PASS/null');
  for (const name of ['PASS', 'MODEL_QUALITY_FAIL', 'PRODUCT_DEAD_END', 'HARD_INCOMPATIBLE', 'PROVIDER_FAIL', 'HARNESS_FAIL', 'TIMEOUT', 'CANCELLED']) assert.ok(VERDICTS.includes(name), name);
});

test('missing or invalid VSIX classifies HARNESS_FAIL', () => {
  const r = input => classifyResult(input);
  assert.equal(r({ failure: 'Error: Packaged VSIX not found at C:/x/karkedikha-win32-x64.vsix (build with npm run package)' }).verdict, 'HARNESS_FAIL');
  assert.equal(r({ harnessError: 'packaged VSIX invalid (not a zip archive) at C:/x.vsix' }).failureFingerprint, 'harness_failure');
  assert.equal(r({ infraText: 'end of central directory record signature not found in vsix' }).verdict, 'HARNESS_FAIL');
  // The runner preflight: missing, empty and non-zip files are unusable; a zip header is accepted.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-vsix-'));
  assert.equal(inspectVsix(path.join(dir, 'missing.vsix')).ok, false);
  fs.writeFileSync(path.join(dir, 'empty.vsix'), '');
  assert.match(inspectVsix(path.join(dir, 'empty.vsix')).error, /invalid/);
  fs.writeFileSync(path.join(dir, 'html.vsix'), '<html>404 not found</html>'.repeat(4));
  assert.equal(inspectVsix(path.join(dir, 'html.vsix')).ok, false);
  const zip = Buffer.alloc(64); zip.set([0x50, 0x4b, 0x03, 0x04]);
  fs.writeFileSync(path.join(dir, 'ok.vsix'), zip);
  const ok = inspectVsix(path.join(dir, 'ok.vsix'));
  assert.equal(ok.ok, true);
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  assert.equal(looksLikeVsix(null), false);
  // Without a golden-report.json the outcome is null (harness evidence), and the record says HARNESS_FAIL.
  assert.equal(readGoldenOutcome({ evidenceRoot: dir, scenario: 's' }).outcome, null);
  const record = buildResultRecord({ model: 'm', scenario: 's', outcome: null, harnessError: ok.ok ? null : 'x', provenance: { commitSha: 'abc', vsixSha256: ok.sha256 } });
  assert.equal(record.verdict, 'HARNESS_FAIL');
  assert.equal(record.vsixSha256, ok.sha256);
  assert.equal(record.commitSha, 'abc');
});

test('resume plans models x scenarios x repetitions and re-runs only harness failures', () => {
  const done = [{ model: 'a', scenario: 's', repetition: 1, verdict: 'PASS' }, { model: 'a', scenario: 's', repetition: 2, verdict: 'HARNESS_FAIL' }, { model: 'b', scenario: 's' }];
  const { kept, superseded } = splitForResume(done);
  assert.equal(superseded.length, 1);
  assert.deepEqual(pendingTuples(['a', 'b'], ['s'], 2, kept), [{ model: 'a', scenario: 's', repetition: 2 }, { model: 'b', scenario: 's', repetition: 2 }]);
  assert.equal(pendingTuples(['a'], ['s1', 's2'], 3, []).length, 6);
  assert.deepEqual(pendingTuples(['a'], ['s1', 's2'], 2, []).map(t => `${t.scenario}#${t.repetition}`), ['s1#1', 's1#2', 's2#1', 's2#2']);
  // Legacy single-run records count as repetition 1.
  assert.equal(pendingTuples(['b'], ['s'], 1, kept).length, 0);
});

test('observational fingerprints come only from recorded signals', () => {
  assert.deepEqual(deriveEvidenceFingerprints({}), []);
  const signals = {
    events: ['inline_tool_call_correction_started', 'mutation_proposal_correction_exhausted', 'suspicious_whole_file_replacement_blocked', 'validation_failed', 'validation_repair_exhausted'],
    parserFailures: [{ reason: 'no_tool_call', rawReply: 'x' }, { reason: 'no_tool_call', rawReply: 'x' }, { reason: 'unknown_tool: gmail_send', rawReply: 'y' }],
    toolCalls: [{ name: 'read_file' }, { name: 'weather_lookup' }],
    reads: [{ path: 'a.js', bytes: 539 }], writes: [{ path: 'a.js', bytes: 60 }],
    failureReasons: ['blocked after repeated non-progress for read_file'],
  };
  assert.deepEqual(deriveEvidenceFingerprints(signals, { verdict: 'PRODUCT_DEAD_END' }), [
    'inline_parse_failure', 'invalid_tool_sequence', 'protocol_correction_failed', 'repeated_identical_protocol_failure', 'no_action_after_correction',
    'unnecessary_tool_use', 'suspicious_replacement_blocked', 'destructive_proposal', 'mutation_validation_failed', 'validation_repair_exhausted', 'no_progress',
    'product_dead_end',
  ]);
  // A small file shrinking, or a write that keeps most of the file, is not destructive.
  assert.deepEqual(deriveEvidenceFingerprints({ reads: [{ path: 'a', bytes: 100 }], writes: [{ path: 'a', bytes: 10 }] }), []);
  assert.deepEqual(deriveEvidenceFingerprints({ reads: [{ path: 'a', bytes: 539 }], writes: [{ path: 'a', bytes: 545 }] }), []);
  for (const name of deriveEvidenceFingerprints(signals, { verdict: 'HARNESS_FAIL' })) assert.ok(FINGERPRINTS.includes(name));
});

test('cohort artifacts: RUNS.csv, SUMMARY.csv, SUMMARY.md, manifest.json, ASCII only', () => {
  const rec = (model, repetition, outcome) => ({
    ...buildResultRecord({ model, scenario: 'd1-small-bug', repetition, outcome, durationMs: 60_000, provenance: { commitSha: 'c0ffee', vsixSha256: 'ab'.repeat(32) } }),
    runDir: `r/${model}/${repetition}`, finishedAt: '2026-10-05T00:00:00Z',
  });
  const results = [
    rec('m3b', 2, { passed: false, lastFailure: DEAD_END('⚠ bounded validation repair was exhausted'), failedChecks: [] }),
    rec('m3b', 1, OUTCOME_PASS),
    rec('m1b', 1, { passed: false, lastFailure: DEAD_END('⚠ unknown — thing · here'), failedChecks: [] }),
  ];
  const rows = summarizeCohort(results);
  assert.deepEqual(rows.map(row => [row.model, row.pass, row.runs]), [['m3b', 1, 2], ['m1b', 0, 1]]);
  assert.deepEqual(rows[0].fingerprints, { validation_repair_exhausted: 1 });
  const runs = runsToCsv(results, { cohort: 'C1' }).trim().split(NL);
  assert.equal(runs.length, 4);
  assert.match(runs[0], /^cohort,model,scenario,repetition,verdict,failureFingerprint,evidenceFingerprints,durationMs,loadMs,coldLoad,seed,temperature,firstRunResult/);
  assert.match(runs[1], /^C1,m1b,d1-small-bug,1,PRODUCT_DEAD_END,product_dead_end,/);
  assert.match(runs[2], /^C1,m3b,d1-small-bug,1,PASS,/);
  assert.match(runs[3], /c0ffee/);
  assert.match(summaryToCsv(rows).split(NL)[1], /^m3b,d1-small-bug,2,1,0\.500,1,1,/);
  const md = buildCohortSummary({ manifest: { cohort: 'C1', gitHead: 'c0ffee', vsix: { sha256: 'ab'.repeat(32) }, scenarios: ['d1-small-bug'], repetitions: 2, models: ['m3b', 'm1b'] }, results });
  assert.match(md, /Overall: 1\/3 PASS \(33\.3%\)/);
  assert.match(md, /\| m3b \| d1-small-bug \| 1\/2 \|/);
  // Reasons are shown, ASCII-folded, with table pipes neutralised.
  assert.match(md, /unknown - thing \/ here/);
  assert.ok(/^[\t\n\r\x20-\x7e]*$/.test(md), 'SUMMARY.md is ASCII');
  assert.equal(asciiText('a — b · c × d …'), 'a - b | c x d ...');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cohort-'));
  writeCohortArtifacts(dir, { cohort: 'C1' }, results);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['RUNS.csv', 'SUMMARY.csv', 'SUMMARY.md', 'manifest.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).cohort, 'C1');
});


test('M50 qualification evidence counts only real model-quality outcomes, per exact model', async () => {
  const { aggregateQualificationEvidence } = await import('./lib.mjs');
  const row = (model, scenario, result, durationMs) => ({ model, scenario, result, durationMs });
  const evidence = aggregateQualificationEvidence([
    row('Model-A:20b', 'd1', 'PASS', 30000),
    row('model-a:20b', 'd1', 'PASS', 10000),
    row('model-a:20b', 'd4', 'MODEL_QUALITY_FAIL', 20000),
    row('model-a:20b', 'd6', 'HARNESS_FAIL', 1),
    row('model-a:20b', 'd6', 'PROVIDER_FAIL', 1),
    row('model-a:20b', 'd6', 'HARD_INCOMPATIBLE', 1),
    row('model-a:20b', 'd6', 'TIMEOUT', 1),
    row('model-b:7b', 'd1', 'HARNESS_FAIL', 5),
    { model: 'model-c', result: 'PASS' },
  ]);
  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(evidence.models['model-a:20b'], { passCount: 2, sampleCount: 3, scenarioCount: 2, medianDurationMs: 20000 });
  assert.equal(evidence.models['model-b:7b'], undefined, 'infrastructure-only rows must not create evidence');
  assert.equal(evidence.models['model-c'], undefined, 'rows without a scenario are not evidence');
});

test('M50 repetitions of one scenario stay one scenario', async () => {
  const { aggregateQualificationEvidence } = await import('./lib.mjs');
  const rows = Array.from({ length: 6 }, () => ({ model: 'm', scenario: 'd1-small-bug', result: 'PASS', durationMs: 1000 }));
  assert.deepEqual(aggregateQualificationEvidence(rows).models.m, { passCount: 6, sampleCount: 6, scenarioCount: 1, medianDurationMs: 1000 });
});
