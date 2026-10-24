import * as fs from 'fs/promises';
import * as path from 'path';

export interface ReleaseScenarioContext {
  signal: AbortSignal;
  evidence: Record<string, unknown>;
}

export interface ReleaseScenario {
  id: string;
  description: string;
  required: boolean;
  timeoutMs: number;
  dependencies?: string[];
  run(context: ReleaseScenarioContext): Promise<Record<string, unknown> | void>;
  cleanup?(context: ReleaseScenarioContext): Promise<void>;
}

export interface ReleaseScenarioResult {
  id: string;
  status: 'passed' | 'failed' | 'skipped' | 'cancelled';
  required: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  evidence: Record<string, unknown>;
  error?: string;
}

export interface ReleaseValidationReport {
  schemaVersion: 1;
  generatedAt: string;
  passed: boolean;
  results: ReleaseScenarioResult[];
}

export interface ReleaseReportStorage {
  save(report: ReleaseValidationReport): Promise<void>;
}

export class FileReleaseReportStorage implements ReleaseReportStorage {
  constructor(private readonly filename: string) {}

  async save(report: ReleaseValidationReport): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filename);
  }
}

export class ReleaseScenarioRunner {
  private controller: AbortController | null = null;

  constructor(private readonly storage?: ReleaseReportStorage) {}

  async run(scenarios: readonly ReleaseScenario[]): Promise<ReleaseValidationReport> {
    if (this.controller) { throw new Error('Release validation is already running.'); }
    const ordered = orderScenarios(scenarios);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const results: ReleaseScenarioResult[] = [];
    const statuses = new Map<string, ReleaseScenarioResult['status']>();

    try {
      for (const scenario of ordered) {
        const blockedDependency = (scenario.dependencies ?? []).find(id => statuses.get(id) !== 'passed');
        if (blockedDependency) {
          const timestamp = new Date().toISOString();
          const skipped: ReleaseScenarioResult = {
            id: scenario.id,
            status: 'skipped',
            required: scenario.required,
            startedAt: timestamp,
            completedAt: timestamp,
            durationMs: 0,
            evidence: { blockedBy: blockedDependency },
            error: `Dependency ${blockedDependency} did not pass.`,
          };
          results.push(skipped);
          statuses.set(scenario.id, skipped.status);
          continue;
        }

        const scenarioResult = await this.runOne(scenario, signal);
        results.push(scenarioResult);
        statuses.set(scenario.id, scenarioResult.status);
      }
    } finally {
      this.controller = null;
    }

    const report: ReleaseValidationReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      passed: results.every(item => !item.required || item.status === 'passed'),
      results,
    };
    await this.storage?.save(report);
    return report;
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) { return false; }
    this.controller.abort();
    return true;
  }

  private async runOne(scenario: ReleaseScenario, parentSignal: AbortSignal): Promise<ReleaseScenarioResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const evidence: Record<string, unknown> = {};
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    parentSignal.addEventListener('abort', onAbort, { once: true });
    const context: ReleaseScenarioContext = { signal: controller.signal, evidence };
    let timeout: NodeJS.Timeout | undefined;
    let status: ReleaseScenarioResult['status'] = 'passed';
    let errorMessage: string | undefined;

    try {
      if (parentSignal.aborted) { throw abortError('Release validation cancelled.'); }
      const timed = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(abortError(`Scenario ${scenario.id} timed out after ${scenario.timeoutMs}ms.`));
        }, scenario.timeoutMs);
      });
      const output = await Promise.race([scenario.run(context), timed]);
      if (output) { Object.assign(evidence, output); }
      if (controller.signal.aborted) { throw abortError('Release validation cancelled.'); }
    } catch (error) {
      status = parentSignal.aborted || controller.signal.aborted ? 'cancelled' : 'failed';
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (timeout) clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onAbort);
      if (scenario.cleanup) {
        try {
          await scenario.cleanup(context);
        } catch (cleanupError) {
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          evidence['cleanupError'] = cleanupMessage;
          if (status === 'passed') {
            status = 'failed';
            errorMessage = `Scenario cleanup failed: ${cleanupMessage}`;
          }
        }
      }
    }

    return buildResult(scenario, status, startedAt, started, evidence, errorMessage);
  }
}

export function orderScenarios(scenarios: readonly ReleaseScenario[]): ReleaseScenario[] {
  const byId = new Map<string, ReleaseScenario>();
  for (const scenario of scenarios) {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(scenario.id)) throw new Error(`Invalid release scenario id: ${scenario.id}`);
    if (byId.has(scenario.id)) throw new Error(`Duplicate release scenario: ${scenario.id}`);
    if (!Number.isInteger(scenario.timeoutMs) || scenario.timeoutMs < 100) throw new Error(`Invalid timeout for ${scenario.id}.`);
    byId.set(scenario.id, scenario);
  }
  const ordered: ReleaseScenario[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (scenario: ReleaseScenario) => {
    if (visited.has(scenario.id)) return;
    if (visiting.has(scenario.id)) throw new Error(`Release scenario cycle detected at ${scenario.id}.`);
    visiting.add(scenario.id);
    for (const dependency of scenario.dependencies ?? []) {
      const found = byId.get(dependency);
      if (!found) throw new Error(`Scenario ${scenario.id} depends on missing scenario ${dependency}.`);
      visit(found);
    }
    visiting.delete(scenario.id);
    visited.add(scenario.id);
    ordered.push(scenario);
  };
  [...scenarios].sort((left, right) => left.id.localeCompare(right.id)).forEach(visit);
  return ordered;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function buildResult(
  scenario: ReleaseScenario,
  status: ReleaseScenarioResult['status'],
  startedAt: string,
  started: number,
  evidence: Record<string, unknown>,
  error?: string,
): ReleaseScenarioResult {
  return {
    id: scenario.id,
    status,
    required: scenario.required,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - started),
    evidence: { ...evidence },
    error,
  };
}
