import { createHash } from 'crypto';

export type RepositoryDependencyKind = 'build' | 'runtime' | 'api' | 'deployment' | 'test';

export interface RepositoryDependency {
  repositoryId: string;
  kind: RepositoryDependencyKind;
  packageName?: string;
  versionConstraint?: string;
  optional?: boolean;
}

export interface RepositoryDescriptor {
  id: string;
  root: string;
  revision: string;
  dependencies: RepositoryDependency[];
  owners: string[];
  labels: Record<string, string>;
  writable: boolean;
}

export interface RepositoryChangeIntent {
  repositoryId: string;
  files: string[];
  exportedContracts?: string[];
  requiredValidation: string[];
  description: string;
}

export interface RepositoryImpact {
  repositoryId: string;
  reason: string;
  distance: number;
  dependencyKinds: RepositoryDependencyKind[];
  requiredValidation: string[];
}

export interface CoordinatedRepositoryStep {
  repositoryId: string;
  order: number;
  dependsOn: string[];
  files: string[];
  validation: string[];
  owners: string[];
  writable: boolean;
}

export interface CoordinatedRepositoryPlan {
  schemaVersion: 1;
  planId: string;
  createdAt: string;
  sourceRevisionFingerprint: string;
  atomic: boolean;
  steps: CoordinatedRepositoryStep[];
  impacts: RepositoryImpact[];
  blockedReasons: string[];
}

export class MultiRepositoryPlanner {
  private readonly repositories = new Map<string, RepositoryDescriptor>();

  register(repository: RepositoryDescriptor): void {
    validateRepository(repository);
    if (this.repositories.has(repository.id)) throw new Error(`Repository already registered: ${repository.id}`);
    this.repositories.set(repository.id, clone(repository));
  }

  updateRevision(repositoryId: string, revision: string): RepositoryDescriptor {
    const repository = this.require(repositoryId);
    repository.revision = revision;
    return clone(repository);
  }

  analyze(intents: readonly RepositoryChangeIntent[]): RepositoryImpact[] {
    validateIntents(intents, this.repositories);
    const directlyChanged = new Set(intents.map(intent => intent.repositoryId));
    const impacts = new Map<string, RepositoryImpact>();
    const queue: Array<{ repositoryId: string; distance: number; source: string }> = [];
    for (const repositoryId of directlyChanged) {
      impacts.set(repositoryId, {
        repositoryId,
        reason: 'Direct change intent.',
        distance: 0,
        dependencyKinds: [],
        requiredValidation: findIntent(intents, repositoryId).requiredValidation,
      });
      queue.push({ repositoryId, distance: 0, source: repositoryId });
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const repository of this.repositories.values()) {
        const matching = repository.dependencies.filter(dependency => dependency.repositoryId === current.repositoryId);
        if (matching.length === 0) continue;
        const nextDistance = current.distance + 1;
        const existing = impacts.get(repository.id);
        const kinds = [...new Set(matching.map(dependency => dependency.kind))].sort();
        const validation = inferValidation(kinds);
        if (!existing || nextDistance < existing.distance) {
          impacts.set(repository.id, {
            repositoryId: repository.id,
            reason: `Depends on ${current.repositoryId}.`,
            distance: nextDistance,
            dependencyKinds: kinds,
            requiredValidation: validation,
          });
          queue.push({ repositoryId: repository.id, distance: nextDistance, source: current.source });
        } else {
          existing.dependencyKinds = [...new Set([...existing.dependencyKinds, ...kinds])].sort();
          existing.requiredValidation = [...new Set([...existing.requiredValidation, ...validation])].sort();
        }
      }
    }

    return [...impacts.values()].sort(
      (left, right) => left.distance - right.distance || left.repositoryId.localeCompare(right.repositoryId),
    );
  }

  plan(intents: readonly RepositoryChangeIntent[], atomic = true): CoordinatedRepositoryPlan {
    validateIntents(intents, this.repositories);
    const impacts = this.analyze(intents);
    const impactedIds = new Set(impacts.map(impact => impact.repositoryId));
    const blockedReasons: string[] = [];
    for (const intent of intents) {
      const repository = this.require(intent.repositoryId);
      if (!repository.writable) blockedReasons.push(`Repository ${repository.id} is read-only.`);
    }

    const order = topologicalOrder(
      [...this.repositories.values()].filter(repository => impactedIds.has(repository.id)),
      impactedIds,
    );
    const steps = order.map((repositoryId, index) => {
      const repository = this.require(repositoryId);
      const intent = intents.find(candidate => candidate.repositoryId === repositoryId);
      const impact = impacts.find(candidate => candidate.repositoryId === repositoryId)!;
      return {
        repositoryId,
        order: index + 1,
        dependsOn: repository.dependencies
          .filter(dependency => impactedIds.has(dependency.repositoryId))
          .map(dependency => dependency.repositoryId)
          .sort(),
        files: [...new Set(intent?.files ?? [])].sort(),
        validation: [...new Set([...(intent?.requiredValidation ?? []), ...impact.requiredValidation])].sort(),
        owners: [...repository.owners].sort(),
        writable: repository.writable,
      };
    });

    const fingerprintMaterial = [...this.repositories.values()]
      .filter(repository => impactedIds.has(repository.id))
      .map(repository => `${repository.id}:${repository.revision}`)
      .sort()
      .join('\n');
    const fingerprint = createHash('sha256').update(fingerprintMaterial).digest('hex');
    const intentFingerprint = createHash('sha256').update(JSON.stringify(intents)).digest('hex').slice(0, 16);
    return {
      schemaVersion: 1,
      planId: `multi-repo-${intentFingerprint}`,
      createdAt: new Date().toISOString(),
      sourceRevisionFingerprint: fingerprint,
      atomic,
      steps,
      impacts,
      blockedReasons,
    };
  }

  verifyRevisions(plan: CoordinatedRepositoryPlan): boolean {
    const material = plan.steps
      .map(step => `${step.repositoryId}:${this.require(step.repositoryId).revision}`)
      .sort()
      .join('\n');
    return createHash('sha256').update(material).digest('hex') === plan.sourceRevisionFingerprint;
  }

  list(): RepositoryDescriptor[] {
    return [...this.repositories.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id));
  }

  private require(id: string): RepositoryDescriptor {
    const repository = this.repositories.get(id);
    if (!repository) throw new Error(`Unknown repository: ${id}`);
    return repository;
  }
}

function topologicalOrder(repositories: RepositoryDescriptor[], included: Set<string>): string[] {
  const byId = new Map(repositories.map(repository => [repository.id, repository]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const output: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cross-repository dependency cycle at ${id}.`);
    visiting.add(id);
    const repository = byId.get(id);
    for (const dependency of repository?.dependencies ?? []) {
      if (included.has(dependency.repositoryId)) visit(dependency.repositoryId);
    }
    visiting.delete(id);
    visited.add(id);
    output.push(id);
  };
  [...byId.keys()].sort().forEach(visit);
  return output;
}

function inferValidation(kinds: RepositoryDependencyKind[]): string[] {
  const output = new Set<string>();
  for (const kind of kinds) {
    if (kind === 'api') output.add('contract-tests');
    if (kind === 'build') output.add('build');
    if (kind === 'runtime') output.add('integration-tests');
    if (kind === 'deployment') output.add('deployment-validation');
    if (kind === 'test') output.add('dependent-tests');
  }
  return [...output].sort();
}

function validateRepository(repository: RepositoryDescriptor): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(repository.id)) throw new Error(`Invalid repository id: ${repository.id}`);
  if (!repository.root.trim() || !repository.revision.trim()) throw new Error(`Repository descriptor is incomplete: ${repository.id}`);
  for (const dependency of repository.dependencies) {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(dependency.repositoryId)) throw new Error(`Invalid repository dependency in ${repository.id}.`);
  }
}

function validateIntents(
  intents: readonly RepositoryChangeIntent[],
  repositories: Map<string, RepositoryDescriptor>,
): void {
  if (intents.length === 0) throw new Error('At least one repository change intent is required.');
  const seen = new Set<string>();
  for (const intent of intents) {
    if (!repositories.has(intent.repositoryId)) throw new Error(`Unknown repository intent: ${intent.repositoryId}`);
    if (seen.has(intent.repositoryId)) throw new Error(`Duplicate repository intent: ${intent.repositoryId}`);
    seen.add(intent.repositoryId);
    intent.files.forEach(validatePath);
  }
}

function validatePath(value: string): void {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Invalid repository path: ${value}`);
  }
}

function findIntent(intents: readonly RepositoryChangeIntent[], repositoryId: string): RepositoryChangeIntent {
  const intent = intents.find(candidate => candidate.repositoryId === repositoryId);
  if (!intent) throw new Error(`Missing repository intent: ${repositoryId}`);
  return intent;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
