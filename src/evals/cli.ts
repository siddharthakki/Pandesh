import * as fs from 'fs/promises';
import * as path from 'path';
import { BASELINE_MODEL, getStableEvalScenarios } from './EvalCatalog';
import { EvalRunner, compareEvalRuns } from './EvalRunner';
import { EvalStore } from './EvalStore';
import { EvalObservationInput, ReplayEvalAdapter } from './ReplayEvalAdapter';
import { EvalRunResult } from './EvalTypes';

interface CliArgs {
  workspace: string;
  observations?: string;
  init?: string;
  baseline?: string;
  model: string;
  provider: string;
  version: string;
  commit?: string;
  failOnRegression: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) { continue; }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) { flags.add(name); }
    else { values.set(name, next); index += 1; }
  }
  return {
    workspace: path.resolve(values.get('workspace') ?? process.cwd()),
    observations: values.get('observations'),
    init: values.get('init'),
    baseline: values.get('baseline'),
    model: values.get('model') ?? BASELINE_MODEL,
    provider: values.get('provider') ?? 'ollama',
    version: values.get('version') ?? '0.0.0-dev',
    commit: values.get('commit') ?? process.env['GITHUB_SHA'],
    failOnRegression: flags.has('fail-on-regression'),
  };
}

function observationTemplate(): Record<string, EvalObservationInput> {
  return Object.fromEntries(getStableEvalScenarios().map(scenario => [scenario.id, {
    success: false,
    buildPassed: undefined,
    testsPassed: undefined,
    invalidToolCalls: 0,
    totalToolCalls: 0,
    loopDetected: false,
    repairAttempts: 0,
    approvalsRequested: 0,
    elapsedMs: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    changedFiles: [],
    incorrectFilesChanged: [],
    rollbackAttempted: false,
    rollbackSucceeded: undefined,
    providerResponseEquivalent: undefined,
    contextFiles: [],
    contextRelevantFiles: scenario.expectedFiles ?? [],
    error: 'Replace this template observation with measured evidence.',
    evidence: {
      acceptance: scenario.acceptance,
      fixture: scenario.fixture,
    },
  }]));
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function resolveBaseline(store: EvalStore, value: string): Promise<EvalRunResult | null> {
  if (value.endsWith('.json') || value.includes('/') || value.includes('\\')) {
    try { return await readJson<EvalRunResult>(path.resolve(value)); } catch { return null; }
  }
  return store.read(value);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.init) {
    const destination = path.resolve(args.init);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, JSON.stringify(observationTemplate(), null, 2), 'utf8');
    console.log(`Created evaluation observation template: ${destination}`);
    return;
  }

  if (!args.observations) {
    throw new Error(
      'Missing --observations <file>. Use --init <file> to create a stable suite observation template.',
    );
  }

  const observations = await readJson<Record<string, EvalObservationInput> | EvalObservationInput[]>(
    path.resolve(args.observations),
  );
  const store = new EvalStore(args.workspace);
  const runner = new EvalRunner(new ReplayEvalAdapter(observations), store);
  const result = await runner.run({
    model: args.model,
    providerType: args.provider,
    extensionVersion: args.version,
    commit: args.commit,
  });

  console.log(JSON.stringify({
    runId: result.runId,
    suite: `${result.suiteId}@${result.suiteVersion}`,
    model: result.model,
    provider: result.providerType,
    metrics: result.metrics,
    failedScenarios: result.results
      .filter(item => !item.observation.success)
      .map(item => item.scenario.id),
  }, null, 2));

  if (args.baseline) {
    const baseline = await resolveBaseline(store, args.baseline);
    if (!baseline) { throw new Error(`Baseline not found: ${args.baseline}`); }
    const comparison = compareEvalRuns(baseline, result);
    const comparisonPath = path.join(
      args.workspace,
      '.ollama-agent',
      'evals',
      `${result.runId}.comparison.json`,
    );
    await fs.writeFile(comparisonPath, JSON.stringify(comparison, null, 2), 'utf8');
    console.log(JSON.stringify(comparison, null, 2));
    if (args.failOnRegression && comparison.regressions.some(item => item.severity === 'failure')) {
      process.exitCode = 2;
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
