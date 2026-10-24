import * as fs from 'fs/promises';
import * as path from 'path';

export interface IntegrationCandidate {
  taskId: string;
  sourceRef: string;
  dependencies: string[];
  changedFiles: string[];
  interfaceClaims?: string[];
  validationPassed: boolean;
  sourceAgent?: string;
}

export interface IntegrationRequest {
  integrationId: string;
  baseRef: string;
  candidates: IntegrationCandidate[];
  approved: boolean;
}

export interface IntegrationConflict {
  kind: 'file-overlap' | 'interface-overlap' | 'backend-conflict' | 'invalid-candidate';
  candidates: string[];
  detail: string;
  files?: string[];
}

export interface IntegrationValidationResult {
  passed: boolean;
  commandsRun: string[];
  output?: string;
}

export interface IntegrationSession {
  integrationId: string;
  resultRef: string;
  workspacePath: string;
}

export interface IntegrationBackend {
  prepare(integrationId: string, baseRef: string): Promise<IntegrationSession>;
  apply(session: IntegrationSession, candidate: Readonly<IntegrationCandidate>): Promise<void>;
  conflicts(session: IntegrationSession): Promise<string[]>;
  discard(session: IntegrationSession): Promise<void>;
}

export interface IntegrationResult {
  schemaVersion: 1;
  integrationId: string;
  status: 'completed' | 'blocked' | 'failed' | 'cancelled';
  resultRef?: string;
  workspacePath?: string;
  order: string[];
  conflicts: IntegrationConflict[];
  validation?: IntegrationValidationResult;
  appliedCandidates: string[];
  startedAt: string;
  completedAt: string;
  error?: string;
}

export interface IntegrationResultStorage {
  save(result: IntegrationResult): Promise<void>;
}

export interface IntegrationCoordinatorOptions {
  storage?: IntegrationResultStorage;
  retainFailedSession?: boolean;
}

export type IntegrationValidator = (
  session: Readonly<IntegrationSession>,
  signal: AbortSignal,
) => Promise<IntegrationValidationResult>;

function nowIso(): string {
  return new Date().toISOString();
}

function validateId(label: string, value: string): void {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function normalizeFile(file: string): string {
  const normalized = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Integration file must be workspace-relative: ${file}`);
  }
  return normalized;
}

export function orderIntegrationCandidates(candidates: readonly IntegrationCandidate[]): string[] {
  const byId = new Map(candidates.map(candidate => [candidate.taskId, candidate]));
  const indegree = new Map<string, number>();
  const dependants = new Map<string, string[]>();

  for (const candidate of candidates) {
    indegree.set(candidate.taskId, candidate.dependencies.length);
    for (const dependency of candidate.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`Integration candidate ${candidate.taskId} depends on missing candidate ${dependency}.`);
      }
      const children = dependants.get(dependency) ?? [];
      children.push(candidate.taskId);
      dependants.set(dependency, children);
    }
  }

  const ready = candidates
    .filter(candidate => candidate.dependencies.length === 0)
    .map(candidate => candidate.taskId)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    for (const child of [...(dependants.get(current) ?? [])].sort()) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  if (order.length !== candidates.length) {
    throw new Error('Integration candidate dependencies contain a cycle.');
  }
  return order;
}

export function detectIntegrationConflicts(candidates: readonly IntegrationCandidate[]): IntegrationConflict[] {
  const conflicts: IntegrationConflict[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      const leftFiles = new Set(left.changedFiles.map(normalizeFile));
      const files = right.changedFiles.map(normalizeFile).filter(file => leftFiles.has(file));
      if (files.length > 0) {
        conflicts.push({
          kind: 'file-overlap',
          candidates: [left.taskId, right.taskId],
          files: [...new Set(files)].sort(),
          detail: 'Candidates modify the same file and require explicit reconciliation.',
        });
      }
      const leftClaims = new Set(left.interfaceClaims ?? []);
      const claims = (right.interfaceClaims ?? []).filter(claim => leftClaims.has(claim));
      if (claims.length > 0) {
        conflicts.push({
          kind: 'interface-overlap',
          candidates: [left.taskId, right.taskId],
          detail: `Candidates claim the same interfaces: ${[...new Set(claims)].sort().join(', ')}`,
        });
      }
    }
  }
  return conflicts;
}

export class FileIntegrationResultStorage implements IntegrationResultStorage {
  constructor(private readonly directory: string) {}

  async save(result: IntegrationResult): Promise<void> {
    validateId('integration id', result.integrationId);
    await fs.mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, `${result.integrationId}.json`);
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filename);
  }
}

export class IntegrationCoordinator {
  private readonly storage?: IntegrationResultStorage;
  private readonly retainFailedSession: boolean;
  private controller: AbortController | null = null;

  constructor(
    private readonly backend: IntegrationBackend,
    options: IntegrationCoordinatorOptions = {},
  ) {
    this.storage = options.storage;
    this.retainFailedSession = options.retainFailedSession ?? false;
  }

  async integrate(request: IntegrationRequest, validator: IntegrationValidator): Promise<IntegrationResult> {
    if (this.controller) {
      throw new Error('An integration operation is already running.');
    }
    validateId('integration id', request.integrationId);
    if (!request.approved) {
      throw new Error('Integration requires explicit approval.');
    }
    if (request.candidates.length === 0) {
      throw new Error('Integration requires at least one candidate.');
    }

    const ids = new Set<string>();
    for (const candidate of request.candidates) {
      validateId('candidate id', candidate.taskId);
      if (ids.has(candidate.taskId)) {
        throw new Error(`Duplicate integration candidate: ${candidate.taskId}`);
      }
      ids.add(candidate.taskId);
      if (!candidate.validationPassed) {
        throw new Error(`Candidate ${candidate.taskId} has not passed independent validation.`);
      }
      if (!candidate.sourceRef.trim()) {
        throw new Error(`Candidate ${candidate.taskId} has no source reference.`);
      }
      candidate.changedFiles.forEach(normalizeFile);
    }

    const order = orderIntegrationCandidates(request.candidates);
    const preflight = detectIntegrationConflicts(request.candidates);
    const startedAt = nowIso();
    if (preflight.length > 0) {
      const result: IntegrationResult = {
        schemaVersion: 1,
        integrationId: request.integrationId,
        status: 'blocked',
        order,
        conflicts: preflight,
        appliedCandidates: [],
        startedAt,
        completedAt: nowIso(),
        error: 'Integration preflight found conflicts that require human reconciliation.',
      };
      await this.storage?.save(result);
      return result;
    }

    this.controller = new AbortController();
    const signal = this.controller.signal;
    let session: IntegrationSession | undefined;
    const appliedCandidates: string[] = [];
    try {
      session = await this.backend.prepare(request.integrationId, request.baseRef);
      for (const candidateId of order) {
        if (signal.aborted) {
          const error = new Error('Integration cancelled.');
          error.name = 'AbortError';
          throw error;
        }
        const candidate = request.candidates.find(value => value.taskId === candidateId)!;
        try {
          await this.backend.apply(session, candidate);
          appliedCandidates.push(candidateId);
        } catch (error) {
          const files = await this.backend.conflicts(session).catch(() => []);
          const result: IntegrationResult = {
            schemaVersion: 1,
            integrationId: request.integrationId,
            status: 'blocked',
            resultRef: session.resultRef,
            workspacePath: session.workspacePath,
            order,
            conflicts: [{
              kind: 'backend-conflict',
              candidates: [candidateId],
              files,
              detail: error instanceof Error ? error.message : String(error),
            }],
            appliedCandidates,
            startedAt,
            completedAt: nowIso(),
            error: 'Integration backend reported a conflict.',
          };
          await this.storage?.save(result);
          if (!this.retainFailedSession) {
            await this.backend.discard(session).catch(() => undefined);
          }
          return result;
        }
      }

      const validation = await validator(session, signal);
      if (!validation.passed) {
        const result: IntegrationResult = {
          schemaVersion: 1,
          integrationId: request.integrationId,
          status: 'failed',
          resultRef: session.resultRef,
          workspacePath: session.workspacePath,
          order,
          conflicts: [],
          validation,
          appliedCandidates,
          startedAt,
          completedAt: nowIso(),
          error: 'Integrated validation failed.',
        };
        await this.storage?.save(result);
        if (!this.retainFailedSession) {
          await this.backend.discard(session).catch(() => undefined);
        }
        return result;
      }

      const result: IntegrationResult = {
        schemaVersion: 1,
        integrationId: request.integrationId,
        status: 'completed',
        resultRef: session.resultRef,
        workspacePath: session.workspacePath,
        order,
        conflicts: [],
        validation,
        appliedCandidates,
        startedAt,
        completedAt: nowIso(),
      };
      await this.storage?.save(result);
      return result;
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      if (session && !this.retainFailedSession) {
        await this.backend.discard(session).catch(() => undefined);
      }
      const result: IntegrationResult = {
        schemaVersion: 1,
        integrationId: request.integrationId,
        status: cancelled ? 'cancelled' : 'failed',
        order,
        conflicts: [],
        appliedCandidates,
        startedAt,
        completedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      };
      await this.storage?.save(result);
      return result;
    } finally {
      this.controller = null;
    }
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) {
      return false;
    }
    this.controller.abort();
    return true;
  }
}
