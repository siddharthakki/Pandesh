// Pure helpers for the Daily Golden model qualification runner.
// No live model calls and no process spawning live here, so everything is unit-testable.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const SUITES = {
  qualifier: ['d1-small-bug', 'd4-natural-report', 'd6-follow-up'],
  // TODO(model-bench): extension hook. Add further short, already-reusable Golden scenarios here
  // once they have external oracles. Until then the full suite equals the qualifier.
  daily: ['d1-small-bug', 'd4-natural-report', 'd6-follow-up'],
};

/**
 * Top-level verdicts. UNCLASSIFIED is the honest residual for evidence that matches nothing known; it is not a
 * licence to invent a cause, and it should stay rare. SKIPPED is for models never run.
 */
export const VERDICTS = [
  'PASS', 'MODEL_QUALITY_FAIL', 'PRODUCT_DEAD_END', 'HARD_INCOMPATIBLE', 'PROVIDER_FAIL', 'HARNESS_FAIL', 'TIMEOUT', 'CANCELLED',
  'SKIPPED', 'UNCLASSIFIED',
];
/** @deprecated name kept for callers; same list as VERDICTS. */
export const CLASSIFICATIONS = VERDICTS;

/**
 * Observational failure fingerprints. Reporting/evidence only: nothing reads these to change routing, prompts,
 * retry counts, model choice or execution policy.
 */
export const FINGERPRINTS = [
  'inline_parse_failure', 'invalid_tool_sequence', 'protocol_correction_failed', 'repeated_identical_protocol_failure',
  'no_action_after_correction', 'unnecessary_tool_use', 'suspicious_replacement_blocked', 'destructive_proposal',
  'mutation_validation_failed', 'validation_repair_exhausted', 'no_progress', 'product_dead_end', 'provider_failure',
  'harness_failure',
  // Primary-only fingerprints for verdicts that have no finer evidence category above.
  'consequence_oracle_failed', 'context_exhausted', 'model_output_truncated', 'kkd_runtime_check_failed', 'validation_unavailable',
  'recovery_failed', 'benchmark_override_ineffective', 'hard_incompatible', 'timeout', 'cancelled', 'unclassified',
];

const SIZE_UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** Parses the table printed by `ollama list`. Columns are separated by 2+ spaces. */
export function parseOllamaList(text) {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim());
  const body = /^NAME\s+ID\s+SIZE/i.test(lines[0]) ? lines.slice(1) : lines;
  const models = [];
  for (const line of body) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 3) continue;
    const [name, id, sizeText, ...modified] = cols;
    const match = /^([\d.]+)\s*([KMGT]?B)$/i.exec(sizeText);
    models.push({
      name, id, sizeText,
      sizeBytes: match ? Math.round(Number(match[1]) * (SIZE_UNITS[match[2].toUpperCase()] ?? 1)) : null,
      modified: modified.join(' ') || null,
    });
  }
  return models;
}

/** Parses the human-readable output of `ollama show <model>`. Unknown fields stay null. */
export function parseOllamaShow(text) {
  const info = { architecture: null, parameters: null, parameterCount: null, contextLength: null, quantization: null, capabilities: [] };
  const lines = String(text).split(/\r?\n/).filter(line => line.trim());
  const base = Math.min(...lines.map(line => line.length - line.trimStart().length));
  let section = null;
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === base) { section = line.toLowerCase(); continue; }
    if (section === 'capabilities') { if (indent === base + 2) info.capabilities.push(line.split(/\s{2,}/)[0].toLowerCase()); continue; }
    if (section !== 'model') continue;
    const [key, ...rest] = line.split(/\s{2,}/);
    const value = rest.join(' ').trim();
    if (/^architecture$/i.test(key)) info.architecture = value || null;
    else if (/^parameters$/i.test(key)) { info.parameters = value || null; info.parameterCount = parseParameterCount(value); }
    else if (/^context length$/i.test(key)) info.contextLength = Number(value) || null;
    else if (/^quantization$/i.test(key)) info.quantization = value || null;
  }
  return info;
}

export function parseParameterCount(text) {
  const match = /^([\d.]+)\s*([KMBT])$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2].toUpperCase()];
}

const TINY_PARAMS = 1.1e9;

/** Returns { category, reason }. `show` may be null (metadata unavailable). */
export function classifyModel(name, show) {
  const caps = show?.capabilities ?? [];
  if (/rerank/i.test(name)) return { category: 'RETRIEVAL', reason: 'reranker (name)' };
  if (/embed/i.test(name) || /bert/i.test(show?.architecture ?? '')) return { category: 'RETRIEVAL', reason: 'embedding model' };
  if (caps.includes('embedding') && !caps.includes('completion')) return { category: 'RETRIEVAL', reason: 'embedding-only capability' };
  if (caps.includes('decision') && !caps.includes('completion')) return { category: 'SPECIALIST', reason: 'decision/routing specialist (no completion capability)' };
  if (caps.length > 0 && !caps.includes('completion')) return { category: 'SKIPPED', reason: `no completion capability (${caps.join(', ')})` };
  if (/functiongemma/i.test(name)) return { category: 'SPECIALIST', reason: 'function-calling decision specialist' };
  if (show?.parameterCount && show.parameterCount < TINY_PARAMS) return { category: 'SPECIALIST', reason: `tiny model (${show.parameters}); use --include-specialists to force` };
  if (!show) return { category: 'CODING_CANDIDATE', reason: 'generative (metadata unavailable, assumed)' };
  return { category: 'CODING_CANDIDATE', reason: `generative${caps.length ? ` (${caps.join(', ')})` : ''}` };
}

/** `requested` forces a model of any category (explicit user intent). Otherwise coding candidates only. */
export function selectModels(models, { model = null, includeSpecialists = false } = {}) {
  if (model) {
    const exact = models.filter(item => item.name === model);
    const found = exact.length ? exact : models.filter(item => item.name.toLowerCase().includes(model.toLowerCase()));
    if (found.length === 0) throw new Error(`Model "${model}" not found in ollama list`);
    if (found.length > 1) throw new Error(`Model "${model}" is ambiguous: ${found.map(item => item.name).join(', ')}`);
    const qualified = qualifyForBenchmark(found[0]);
    if (!qualified.runnable) throw new Error(`Model "${found[0].name}" cannot be benchmarked (${qualified.classification}): ${qualified.reason}`);
    return [{ ...found[0], forced: true }];
  }
  return models.filter(item => item.category === 'CODING_CANDIDATE' || (includeSpecialists && item.category === 'SPECIALIST'));
}

export function selectScenarios({ suite = null, scenario = null } = {}, known = null) {
  let names;
  if (scenario) names = scenario.split(',').map(item => item.trim()).filter(Boolean);
  else names = SUITES[suite ?? 'qualifier'];
  if (!names) throw new Error(`Unknown suite "${suite}". Known: ${Object.keys(SUITES).join(', ')}`);
  if (known) for (const name of names) if (!known.includes(name)) throw new Error(`Unknown scenario "${name}". Known: ${known.join(', ')}`);
  return names;
}

export const pairKey = (model, scenario) => `${model}::${scenario}`;
export const tupleKey = (model, scenario, repetition = 1) => `${model}::${scenario}::${repetition}`;

/** Ordered model-major plan minus pairs that already have a stored result. */
export function pendingPairs(models, scenarios, results) {
  return pendingTuples(models, scenarios, 1, results).map(({ model, scenario }) => ({ model, scenario }));
}

/**
 * models x scenarios x repetitions, model-major then scenario then repetition, minus tuples that already have a
 * stored result. A record without `repetition` counts as repetition 1 (single-run layouts).
 */
export function pendingTuples(models, scenarios, repetitions, results) {
  const done = new Set(results.map(item => tupleKey(item.model, item.scenario, item.repetition ?? 1)));
  const tuples = [];
  for (const model of models) {
    for (const scenario of scenarios) {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        if (!done.has(tupleKey(model, scenario, repetition))) tuples.push({ model, scenario, repetition });
      }
    }
  }
  return tuples;
}

const RUNTIME_CHECK = /route|routed|conversation|same .*id|no new task|approval|silent|karke/i;
const result = (verdict, failureFingerprint, reason) => ({ verdict, classification: verdict, failureFingerprint, reason });

/**
 * Deterministic classification from Golden evidence.
 * input: { passed, timedOut, harnessError, failure, failedChecks, infraText, outcomeMissing }
 * Returns { verdict, classification (same as verdict), failureFingerprint, reason }.
 * Order matters: infrastructure first, then provider/selection, then product/model evidence, then check-based verdicts.
 */
export function classifyResult({ passed = false, timedOut = false, harnessError = null, failure = null, failedChecks = [], infraText = '', outcomeMissing = false } = {}) {
  if (passed) return result('PASS', null, null);
  if (timedOut) return result('TIMEOUT', 'timeout', 'scenario exceeded the runner time limit');
  const text = `${harnessError ?? ''}\n${failure ?? ''}\n${infraText ?? ''}`;
  const VSIX_FAULT = '(?:not found|missing|invalid|corrupt|ENOENT|not a zip|end of central directory)';
  if (new RegExp(`vsix\\b[^\\n]*\\b${VSIX_FAULT}|\\b${VSIX_FAULT}[^\\n]*\\.?vsix\\b`, 'i').test(text)) {
    return result('HARNESS_FAIL', 'harness_failure', (/[^\n]*vsix[^\n]*/i.exec(text)?.[0] ?? 'packaged VSIX missing or invalid').trim().slice(0, 200));
  }
  // Model-selection refusals. The runner always forces the model, so the soft gates (reliability floor, registry
  // score, coder bonus, unknown-model heuristic) cannot legitimately refuse it: "no available configured model"
  // therefore means the benchmark's forced override did not take effect.
  if (/explicit override model .* (is not available|not configured)|Model is not available/i.test(text)) return result('PROVIDER_FAIL', 'provider_failure', 'forced model unavailable or not configured on the provider');
  if (/explicit override model .* is incompatible with the task requirements|does not support (tools|chat|generate)|not support(ed)? .*tool/i.test(text)) return result('HARD_INCOMPATIBLE', 'hard_incompatible', (/incompatible with the task requirements: (.*)/i.exec(text)?.[1] ?? 'model lacks a required capability').slice(0, 200));
  if (/No available configured model .* satisfies/i.test(text)) return result('HARNESS_FAIL', 'benchmark_override_ineffective', 'selection refused the forced benchmark model on soft eligibility; the override did not take effect');
  if (/\battempt (?:was )?cancell?ed\b|\bcancell?ed by the user\b|cancel_requested/i.test(text)) return result('CANCELLED', 'cancelled', 'the attempt was cancelled');
  // Selection succeeded and the model ran; KKD stopped it at a recorded, model-attributable bound.
  if (/could not produce an actionable mutation proposal/i.test(text)) return result('MODEL_QUALITY_FAIL', 'no_action_after_correction', 'model could not produce an actionable mutation proposal after one corrective turn');
  if (/blocked after repeated non-progress/i.test(text)) return result('MODEL_QUALITY_FAIL', 'no_progress', 'model made no progress on repeated governed steps and KKD stopped it');
  if (/bounded validation repair was exhausted/i.test(text)) return result('MODEL_QUALITY_FAIL', 'validation_repair_exhausted', 'a change was written but post-mutation validation kept failing through the bounded repair cycles');
  if (/model_output_truncated/i.test(text)) return result('MODEL_QUALITY_FAIL', 'model_output_truncated', 'model output hit its token/context limit before a proposal');
  if (harnessError || outcomeMissing || /infrastructure|no scenario result written|ExTester|chromedriver/i.test(text)) return result('HARNESS_FAIL', 'harness_failure', (harnessError ?? failure ?? 'the Golden runner produced no scenario result').trim().slice(0, 200));
  if (/Turn did not reach a terminal state/i.test(text)) return result('TIMEOUT', 'timeout', 'turn did not reach a terminal state');
  if (/ECONNREFUSED|fetch failed|provider[_ ]?(failure|unavailable)|model .*not found|ollama .*(unavailable|error)/i.test(text)) return result('PROVIDER_FAIL', 'provider_failure', 'provider/model call failed');
  // KKD owns the context budget, so running out of it is a product dead end, not a model-quality verdict.
  if (/context_budget_exhausted|context[_ ]?(window|overflow|exceeded|truncat)|num_ctx|token limit/i.test(text)) return result('PRODUCT_DEAD_END', 'context_exhausted', 'context limit evidence');
  if (/validation[_ ]?(gap|unavailable|unsupported)/i.test(text)) return result('PRODUCT_DEAD_END', 'validation_unavailable', 'validation could not be performed');
  if (/recovery[_ ]?(failed|exhausted)|breaker/i.test(text)) return result('PRODUCT_DEAD_END', 'recovery_failed', 'recovery evidence');
  if (failedChecks.length > 0) {
    if (failedChecks.some(name => RUNTIME_CHECK.test(name))) return result('PRODUCT_DEAD_END', 'kkd_runtime_check_failed', `check(s): ${failedChecks.filter(name => RUNTIME_CHECK.test(name)).join('; ')}`.slice(0, 200));
    return result('MODEL_QUALITY_FAIL', 'consequence_oracle_failed', `consequence check(s) failed: ${failedChecks.join('; ')}`.slice(0, 200));
  }
  // The product ended the turn in a dead end and the evidence gives no finer known cause: say exactly that.
  if (/PRODUCT_DEAD_END/.test(text)) return result('PRODUCT_DEAD_END', 'product_dead_end', (/PRODUCT_DEAD_END on "[^"]*"?:?\s*(.*)/.exec(text)?.[1] || failure || 'product dead end').trim().slice(0, 200));
  return result('UNCLASSIFIED', 'unclassified', (failure ?? 'no evidence').slice(0, 200));
}

const WORKSPACE_TOOLS = new Set(['read_file', 'run_command', 'propose_file_change', 'propose_text_edit']);
const MAX_KEPT_FRACTION = 0.3;
const MIN_BASELINE_BYTES = 200;

/**
 * Observational fingerprints from recorded run signals (see evidence.mjs readRunSignals). Pure. Every fingerprint
 * names something the run recorded; none is inferred from hidden reasoning, and none feeds back into execution.
 * `unnecessary_tool_use` = a non-workspace tool was requested; meaningful for workspace-only scenarios.
 */
export function deriveEvidenceFingerprints(signals, { verdict = null } = {}) {
  const out = new Set();
  const events = signals?.events ?? [];
  const has = type => events.includes(type);
  const failures = signals?.parserFailures ?? [];
  if (failures.some(item => !/^(?:invalid_arguments|unknown_tool|too_many_tool_calls)\b/.test(item.reason))) out.add('inline_parse_failure');
  if (failures.some(item => /^(?:invalid_arguments|unknown_tool|too_many_tool_calls|multiple_tool_calls)\b/.test(item.reason)) || has('native_tool_calls_rejected')) out.add('invalid_tool_sequence');
  const correctionIndex = events.indexOf('inline_tool_call_correction_started');
  if (correctionIndex >= 0 && failures.length >= 2) out.add('protocol_correction_failed');
  for (let index = 1; index < failures.length; index++) {
    if (failures[index].reason === failures[index - 1].reason && failures[index].rawReply === failures[index - 1].rawReply) { out.add('repeated_identical_protocol_failure'); break; }
  }
  if (has('mutation_proposal_correction_exhausted')) out.add('no_action_after_correction');
  if ((signals?.toolCalls ?? []).some(call => !WORKSPACE_TOOLS.has(call.name))) out.add('unnecessary_tool_use');
  if (has('suspicious_whole_file_replacement_blocked')) out.add('suspicious_replacement_blocked');
  // A write that kept <=30% of the last known size of the same non-trivial file (same bound as the runtime guard).
  // Baseline = the first successful read of the path (reads and writes are recorded separately, so interleaving is
  // not reconstructed; a later write is compared with the previous write).
  const lastSize = new Map();
  for (const item of signals?.reads ?? []) if (!lastSize.has(item.path)) lastSize.set(item.path, item.bytes);
  for (const item of signals?.writes ?? []) {
    const before = lastSize.get(item.path);
    if (typeof before === 'number' && before >= MIN_BASELINE_BYTES && item.bytes <= before * MAX_KEPT_FRACTION) out.add('destructive_proposal');
    lastSize.set(item.path, item.bytes);
  }
  if (has('validation_failed')) out.add('mutation_validation_failed');
  if (has('validation_repair_exhausted')) out.add('validation_repair_exhausted');
  if ((signals?.failureReasons ?? []).some(reason => /repeated non-progress/i.test(reason))) out.add('no_progress');
  if (verdict === 'PRODUCT_DEAD_END') out.add('product_dead_end');
  if (verdict === 'PROVIDER_FAIL') out.add('provider_failure');
  if (verdict === 'HARNESS_FAIL') out.add('harness_failure');
  return FINGERPRINTS.filter(name => out.has(name));
}

/** Metrics that are authoritative in Golden turn records; everything else is null (never invented). */
export function extractMetrics(turns = []) {
  const has = turns.length > 0;
  const sum = fn => turns.reduce((total, turn) => total + fn(turn), 0);
  return {
    modelCalls: null,
    toolCalls: has ? sum(turn => (turn.tools ?? []).length) : null,
    filesInspected: null,
    sourceExcerpts: null,
    proposalRepairs: null,
    validationRepairs: null,
    modelSwitches: null,
    approvals: has ? sum(turn => (turn.approvals ?? []).length) : null,
    changedWorkspace: has ? turns.some(turn => turn.changedWorkspace) : null,
    terminalStates: turns.map(turn => turn.terminal ?? null),
    routes: turns.map(turn => turn.route ?? null),
  };
}

/** One role->model map so a later routed profile can be compared with single-model runs. */
export const singleModelRoles = model => ({ analyst: model, planner: model, implementer: model, reviewer: model, validator: model });

export const BENCHMARK_FORCED_MODEL_ENV = 'KKD_BENCHMARK_FORCED_MODEL';
export const BENCHMARK_SEED_ENV = 'KKD_BENCHMARK_SEED';
export const BENCHMARK_TEMPERATURE_ENV = 'KKD_BENCHMARK_TEMPERATURE';

/**
 * Benchmark-only reproducibility controls. Neither is set by default (stochastic qualification); `null` means the
 * field is not sent and the model's own defaults apply. Throws on a malformed value so a typo cannot silently
 * turn a deterministic regression into a stochastic one.
 */
export function parseSampling({ seed = null, temperature = null } = {}) {
  const out = { seed: null, temperature: null };
  if (seed !== null && seed !== undefined) {
    if (!/^-?\d+$/.test(String(seed).trim())) throw new Error(`--seed must be an integer, got "${seed}"`);
    out.seed = Number(seed);
  }
  if (temperature !== null && temperature !== undefined) {
    const text = String(temperature).trim();
    if (text === '' || !Number.isFinite(Number(text)) || Number(text) < 0) throw new Error(`--temperature must be a number >= 0, got "${temperature}"`);
    out.temperature = Number(text);
  }
  return out;
}

/** Environment for the Golden child: only the controls that were explicitly requested. */
export function samplingEnv(sampling) {
  return {
    ...(sampling?.seed != null ? { [BENCHMARK_SEED_ENV]: String(sampling.seed) } : {}),
    ...(sampling?.temperature != null ? { [BENCHMARK_TEMPERATURE_ENV]: String(sampling.temperature) } : {}),
  };
}

export const samplingMode = sampling => (sampling?.seed != null || sampling?.temperature != null ? 'deterministic-regression' : 'stochastic-qualification');
export const samplingLabel = sampling => (samplingMode(sampling) === 'stochastic-qualification'
  ? 'stochastic (no seed, no temperature override)'
  : `seed ${sampling.seed ?? 'unset'}, temperature ${sampling.temperature ?? 'unset'}`);

/**
 * Resume identity: the sampling a cohort started with is part of its configuration. Returns an error message when
 * the CLI explicitly asks for a different seed/temperature, otherwise null. (Omitted flags inherit the manifest.)
 */
export function samplingResumeConflict(manifestSampling, requested) {
  const stored = manifestSampling ?? { seed: null, temperature: null };
  for (const key of ['seed', 'temperature']) {
    if (requested[key] !== null && requested[key] !== stored[key]) {
      return `--${key} ${requested[key]} conflicts with the cohort's recorded ${key} (${stored[key] ?? 'unset'}); incompatible runs cannot be mixed`;
    }
  }
  return null;
}

/** Collision-proof run id: millisecond timestamp plus random suffix (ordering by name still follows time). */
export function uniqueStamp(now = new Date(), suffix = randomBytes(4).toString('hex')) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${suffix}`;
}

export const NORMAL_ELIGIBILITY = ['eligible', 'below_preference_floor', 'unknown', 'hard_incompatible'];

/**
 * Benchmark qualification is hard-incompatibility only. Soft heuristics (reliability floor, registry score,
 * coder tag, preference rank) are what the benchmark measures, so they never keep a model out. Returns
 * { runnable, reason } where reason is set only for a hard refusal.
 */
export function qualifyForBenchmark(item) {
  if (item.category === 'RETRIEVAL') return { runnable: false, classification: 'SKIPPED', reason: item.reason ?? 'embedding/reranker model' };
  if (item.category === 'SKIPPED') return { runnable: false, classification: 'SKIPPED', reason: item.reason ?? 'no text completion capability' };
  return { runnable: true, classification: null, reason: null };
}

/** Reads the frozen model-selection evidence; the forced flag is true whenever this runner ran the model. */
export function benchmarkSelectionFields(modelSelection) {
  const eligibility = NORMAL_ELIGIBILITY.includes(modelSelection?.normalEligibility) ? modelSelection.normalEligibility : 'unknown';
  return {
    benchmarkForcedModel: true,
    normalEligibility: eligibility,
    eligibilityReason: typeof modelSelection?.eligibilityReason === 'string' ? modelSelection.eligibilityReason : 'no model-selection evidence recorded',
  };
}

export function buildResultRecord({
  model, scenario, outcome, timedOut = false, harnessError = null, durationMs, loadMs = null, coldLoad = null, evidenceDir = null, infraText = '',
  modelInfo = null, modelSelection = null, repetition = 1, signals = null, provenance = null, sampling = null,
}) {
  const passed = Boolean(outcome?.passed) && !timedOut && !harnessError;
  const { verdict, classification, failureFingerprint, reason } = classifyResult({
    passed, timedOut, harnessError, failure: outcome?.lastFailure ?? outcome?.firstFailure ?? null, failedChecks: outcome?.failedChecks ?? [], infraText,
    outcomeMissing: !outcome && !timedOut,
  });
  return {
    model, scenario, repetition, result: verdict, verdict, classification, failureFingerprint, reason,
    evidenceFingerprints: signals ? deriveEvidenceFingerprints(signals, { verdict }) : [],
    toolSurface: signals?.toolSurface ?? null,
    commitSha: provenance?.commitSha ?? null, vsixSha256: provenance?.vsixSha256 ?? null,
    firstAttemptResult: passed ? 'PASS' : verdict, eventualResult: passed ? 'PASS' : verdict, attempts: 1,
    durationMs: durationMs ?? null, loadMs, coldLoad,
    seed: sampling?.seed ?? null, temperature: sampling?.temperature ?? null, samplingMode: samplingMode(sampling),
    provider: 'ollama', roles: singleModelRoles(model), ...benchmarkSelectionFields(modelSelection),
    validationResult: outcome ? (outcome.failedChecks ?? []).filter(name => /tests pass/i.test(name)).length === 0 : null,
    consequenceOracle: outcome ? { passed: Boolean(outcome.passed), failedChecks: outcome.failedChecks ?? [] } : null,
    deliveryState: (outcome?.turns ?? []).map(turn => turn.terminal ?? null).at(-1) ?? null,
    metrics: extractMetrics(outcome?.turns ?? []),
    modelInfo, evidenceDir, finishedAt: new Date().toISOString(),
  };
}

/**
 * Generated artifacts are ASCII so they read identically in any viewer. UTF-8 punctuation such as an em dash or a
 * middle dot showed up as mojibake (e.g. "a-circumflex euro" sequences) when Windows PowerShell 5.1 read the files as cp1252.
 */
export function asciiText(value) {
  return String(value ?? '')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u00b7/g, '|').replace(/\u00d7/g, 'x').replace(/\u2026/g, '...')
    .replace(/\u26a0\ufe0f?/g, '!').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2713\u2714]/g, 'v').replace(/[\u2716\u2717]/g, 'x')
    .replace(/[^\t\n\r\x20-\x7e]/g, '?');
}

const CSV_COLUMNS = ['model', 'scenario', 'repetition', 'result', 'failureFingerprint', 'reason', 'durationMs', 'loadMs', 'coldLoad', 'seed', 'temperature', 'attempts', 'toolCalls', 'approvals', 'deliveryState', 'evidenceDir'];
const csvCell = value => {
  const text = asciiText(value === null || value === undefined ? '' : (Array.isArray(value) ? value.join(';') : String(value)));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const toCsv = (columns, rows) => `${[columns.join(','), ...rows.map(row => columns.map(col => csvCell(row[col])).join(','))].join('\n')}\n`;
export function resultsToCsv(results) {
  return toCsv(CSV_COLUMNS, results.map(item => ({ ...item, repetition: item.repetition ?? 1, toolCalls: item.metrics?.toolCalls ?? null, approvals: item.metrics?.approvals ?? null })));
}

// -- Cohort artifacts (models x repetitions x scenarios) ---------------------
const RUNS_COLUMNS = [
  'cohort', 'model', 'scenario', 'repetition', 'verdict', 'failureFingerprint', 'evidenceFingerprints', 'durationMs', 'loadMs', 'coldLoad', 'seed', 'temperature', 'firstRunResult',
  'reason', 'toolSurface', 'runDir', 'evidenceDir', 'commitSha', 'vsixSha256', 'finishedAt',
];
/** RUNS.csv: one row per model x scenario x repetition, ordered as planned. */
export function runsToCsv(results, { cohort = null } = {}) {
  const rows = [...results].sort(compareTuples).map(item => ({
    ...item, cohort: item.cohort ?? cohort, repetition: item.repetition ?? 1, verdict: item.verdict ?? item.result,
    firstRunResult: item.firstAttemptResult ?? item.result,
  }));
  return toCsv(RUNS_COLUMNS, rows);
}
function compareTuples(a, b) {
  return String(a.model).localeCompare(String(b.model)) || String(a.scenario).localeCompare(String(b.scenario)) || (a.repetition ?? 1) - (b.repetition ?? 1);
}
const countBy = (items, key) => items.reduce((map, item) => map.set(key(item), (map.get(key(item)) ?? 0) + 1), new Map());

/** One row per model x scenario, in first-seen order (the planned order when results are appended as they run). */
export function summarizeCohort(results) {
  const groups = new Map();
  for (const item of results) {
    const key = pairKey(item.model, item.scenario);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map(items => {
    const timed = items.filter(item => typeof item.durationMs === 'number');
    const fingerprints = countBy(items.filter(item => (item.verdict ?? item.result) !== 'PASS'), item => item.failureFingerprint ?? 'none');
    return {
      model: items[0].model, scenario: items[0].scenario, runs: items.length,
      pass: items.filter(item => (item.verdict ?? item.result) === 'PASS').length,
      verdicts: Object.fromEntries(countBy(items, item => item.verdict ?? item.result)),
      fingerprints: Object.fromEntries(fingerprints),
      avgDurationMs: timed.length ? Math.round(timed.reduce((sum, item) => sum + item.durationMs, 0) / timed.length) : null,
    };
  });
}

/** SUMMARY.csv: model x scenario with every verdict as a column. */
export function summaryToCsv(rows) {
  const columns = ['model', 'scenario', 'runs', 'pass', 'passRate', ...VERDICTS.filter(item => item !== 'SKIPPED'), 'failureFingerprints', 'avgDurationMs'];
  return toCsv(columns, rows.map(row => ({
    ...row, passRate: row.runs ? (row.pass / row.runs).toFixed(3) : '',
    ...Object.fromEntries(VERDICTS.map(verdict => [verdict, row.verdicts[verdict] ?? 0])),
    failureFingerprints: Object.entries(row.fingerprints).map(([name, n]) => `${name}=${n}`).join(';'),
  })));
}

/** SUMMARY.md for a cohort: provenance, parameters, per model x scenario rates, verdict and fingerprint counts, all runs. */
export function buildCohortSummary({ manifest = {}, results = [] }) {
  const rows = summarizeCohort(results);
  const lines = [`# KKD model cohort - ${manifest.cohort ?? manifest.runId ?? 'n/a'}`, ''];
  lines.push(`- Commit: ${manifest.gitHead ?? 'n/a'}`);
  lines.push(`- VSIX SHA-256: ${manifest.vsix?.sha256 ?? 'n/a'}${manifest.vsix?.path ? ` (${manifest.vsix.path})` : ''}`);
  lines.push(`- Scenarios: ${(manifest.scenarios ?? []).join(', ') || 'n/a'} | repetitions: ${manifest.repetitions ?? 1} | retries: ${manifest.retries ?? 0} | timeout: ${manifest.timeoutMs ? `${Math.round(manifest.timeoutMs / 60_000)}m` : 'n/a'}`);
  lines.push(`- Models: ${(manifest.models ?? []).join(', ') || 'n/a'}`);
  lines.push(`- Sampling: ${manifest.sampling ? `${samplingMode(manifest.sampling)} - ${samplingLabel(manifest.sampling)}` : 'n/a (recorded before sampling controls existed; stochastic)'}`);
  lines.push(`- Started: ${manifest.startedAt ?? 'n/a'} | finished: ${manifest.finishedAt ?? 'in progress'}`);
  if (manifest.source) lines.push(`- Source: ${manifest.source}`);
  const total = results.length;
  const passed = results.filter(item => (item.verdict ?? item.result) === 'PASS').length;
  lines.push('', `Overall: ${passed}/${total} PASS${total ? ` (${((passed / total) * 100).toFixed(1)}%)` : ''}`, '');
  lines.push('| Model | Scenario | Pass | Verdicts | Failure fingerprints | Avg time |', '|---|---|---|---|---|---|');
  for (const row of rows) {
    const verdicts = Object.entries(row.verdicts).map(([name, n]) => `${name}=${n}`).join('; ');
    const fingerprints = Object.entries(row.fingerprints).map(([name, n]) => `${name}=${n}`).join('; ') || '-';
    lines.push(`| ${row.model} | ${row.scenario} | ${row.pass}/${row.runs} | ${verdicts} | ${fingerprints} | ${minutes(row.avgDurationMs)} |`);
  }
  if (rows.length === 0) lines.push('| _no results yet_ | | | | | |');
  const fingerprintTotals = countBy(results.flatMap(item => item.evidenceFingerprints ?? []), name => name);
  if (fingerprintTotals.size) {
    lines.push('', '## Observed evidence fingerprints (runs with each)', '');
    for (const name of FINGERPRINTS) if (fingerprintTotals.has(name)) lines.push(`- ${name}: ${fingerprintTotals.get(name)}`);
  }
  lines.push('', '## Runs', '', '| Model | Scenario | Rep | Verdict | Fingerprint | Evidence fingerprints | Reason | Time | Run dir |', '|---|---|---|---|---|---|---|---|---|');
  for (const item of [...results].sort(compareTuples)) {
    lines.push(`| ${item.model} | ${item.scenario} | ${item.repetition ?? 1} | ${item.verdict ?? item.result} | ${item.failureFingerprint ?? '-'} | ${(item.evidenceFingerprints ?? []).join(', ') || '-'} | ${asciiText(item.reason ?? '-').replace(/\|/g, '/').replace(/\s+/g, ' ')} | ${minutes(item.durationMs)} | ${item.runDir ?? item.evidenceDir ?? '-'} |`);
  }
  lines.push('', '> Fingerprints are observational evidence only; they do not change routing, prompts, retries or model choice.', '');
  return asciiText(lines.join('\n'));
}

/** True when a buffer looks like a non-empty zip (VSIX) archive. */
export function looksLikeVsix(buffer) {
  return Boolean(buffer && buffer.length > 22 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04);
}

const minutes = ms => (ms === null || ms === undefined || Number.isNaN(ms) ? 'n/a' : `${(ms / 60_000).toFixed(1)}m`);

export function summarizeByModel(results) {
  const byModel = new Map();
  for (const item of results) {
    if (!byModel.has(item.model)) byModel.set(item.model, []);
    byModel.get(item.model).push(item);
  }
  return [...byModel.entries()].map(([model, items]) => {
    const passed = items.filter(item => item.result === 'PASS').length;
    const timed = items.filter(item => typeof item.durationMs === 'number');
    return {
      model, total: items.length, passed,
      firstRunRate: items.length ? Math.round((items.filter(item => item.firstAttemptResult === 'PASS').length / items.length) * 100) : 0,
      avgMs: timed.length ? timed.reduce((sum, item) => sum + item.durationMs, 0) / timed.length : null,
      modelQualityFails: items.filter(item => item.result === 'MODEL_QUALITY_FAIL').length,
      otherFails: items.filter(item => item.result !== 'PASS' && item.result !== 'MODEL_QUALITY_FAIL').length,
    };
  });
}

export function buildReport({ manifest = {}, models = [], results = [] }) {
  const rows = summarizeByModel(results);
  const lines = ['# KKD Daily Golden - Model Qualification', ''];
  lines.push(`Run: ${manifest.runId ?? 'n/a'} | suite: ${manifest.suite ?? 'n/a'} | scenarios: ${(manifest.scenarios ?? []).join(', ') || 'n/a'} | retries: 0`);
  if (manifest.gitHead) lines.push(`KKD HEAD: ${manifest.gitHead}`);
  lines.push('', '| Model | Passed | First-run % | Avg time | Model-quality failures | Other failures |', '|---|---|---|---|---|---|');
  for (const row of rows) lines.push(`| ${row.model} | ${row.passed}/${row.total} | ${row.firstRunRate}% | ${minutes(row.avgMs)} | ${row.modelQualityFails} | ${row.otherFails} |`);
  if (rows.length === 0) lines.push('| _no results yet_ | | | | | |');
  const failures = results.filter(item => item.result !== 'PASS');
  if (failures.length) {
    lines.push('', '## Failures', '', '| Model | Scenario | Result | Reason |', '|---|---|---|---|');
    for (const item of failures) lines.push(`| ${item.model} | ${item.scenario} | ${item.result} | ${String(item.reason ?? '').replace(/\|/g, '/')} |`);
  }
  const recommended = rows.filter(row => row.total > 0 && row.passed / row.total >= 2 / 3);
  lines.push('', '## Recommended for deeper qualification', '');
  if (recommended.length) for (const row of recommended) lines.push(`- ${row.model} (${row.passed}/${row.total}, avg ${minutes(row.avgMs)})`);
  else lines.push('- None met the 2/3 pass bar on this run.');
  const skipped = models.filter(item => item.category !== 'CODING_CANDIDATE');
  if (skipped.length) {
    lines.push('', '## Not run as coding candidates', '');
    for (const item of skipped) lines.push(`- ${item.name} - ${item.category}: ${item.reason}`);
  }
  lines.push('', '> Insufficient evidence for per-stage routing; run the full suite first.', '');
  return asciiText(lines.join('\n'));
}

/** Latest run directory (lexicographic timestamp names) under .model-bench that has a manifest. */
export function latestRunDir(benchRoot) {
  if (!fs.existsSync(benchRoot)) return null;
  const dirs = fs.readdirSync(benchRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(benchRoot, entry.name, 'manifest.json')))
    .map(entry => entry.name).sort();
  return dirs.length ? path.join(benchRoot, dirs.at(-1)) : null;
}

export const safeName = value => String(value).replace(/[^\w.-]+/g, '_');

/**
 * Resume policy: a stored HARNESS_FAIL says nothing about the model (missing VSIX, launcher crash), so its tuple is
 * re-run and the old record is kept aside as `superseded`. Every other stored verdict is final for its tuple.
 */
export function splitForResume(results) {
  const kept = [];
  const superseded = [];
  for (const item of results) ((item.verdict ?? item.result) === 'HARNESS_FAIL' ? superseded : kept).push(item);
  return { kept, superseded };
}

/** Writes the durable cohort artifacts (manifest.json, RUNS.csv, SUMMARY.csv, SUMMARY.md) into `dir`. */
export function writeCohortArtifacts(dir, manifest, results) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'RUNS.csv'), runsToCsv(results, { cohort: manifest.cohort ?? null }));
  fs.writeFileSync(path.join(dir, 'SUMMARY.csv'), summaryToCsv(summarizeCohort(results)));
  fs.writeFileSync(path.join(dir, 'SUMMARY.md'), buildCohortSummary({ manifest, results }));
}

/**
 * M50: reduces benchmark rows to per-model qualification evidence for the router (see core/domain/empiricalRouting.ts).
 * Only real model-quality outcomes count: PASS and MODEL_QUALITY_FAIL. Infrastructure, harness, timeout, provider and
 * incompatibility results say nothing about how well the model codes, so they are neither a pass nor a fail here.
 * Keyed by exact lowercased model name; `scenarioCount` is distinct scenarios, so repetitions of one scenario stay one.
 */
export function aggregateQualificationEvidence(rows) {
  const byModel = new Map();
  for (const row of rows) {
    const verdict = row.verdict ?? row.result;
    if (verdict !== 'PASS' && verdict !== 'MODEL_QUALITY_FAIL') continue;
    if (!row.model || !row.scenario) continue;
    const key = String(row.model).trim().toLowerCase();
    const entry = byModel.get(key) ?? { passCount: 0, sampleCount: 0, scenarios: new Set(), durations: [] };
    entry.sampleCount += 1;
    if (verdict === 'PASS') entry.passCount += 1;
    entry.scenarios.add(row.scenario);
    if (Number.isFinite(row.durationMs) && row.durationMs > 0) entry.durations.push(row.durationMs);
    byModel.set(key, entry);
  }
  const models = {};
  for (const [key, entry] of [...byModel].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...entry.durations].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined;
    models[key] = {
      passCount: entry.passCount,
      sampleCount: entry.sampleCount,
      scenarioCount: entry.scenarios.size,
      ...(median !== undefined ? { medianDurationMs: median } : {}),
    };
  }
  return { schemaVersion: 1, models };
}
