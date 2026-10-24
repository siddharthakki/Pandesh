import { describe, expect, it } from 'vitest';
import {
  IntegrationBackend,
  IntegrationCandidate,
  IntegrationCoordinator,
  IntegrationSession,
  detectIntegrationConflicts,
  orderIntegrationCandidates,
} from '../../orchestration/IntegrationCoordinator';

function candidate(id: string, dependencies: string[] = [], changedFiles: string[] = [`src/${id}.ts`]): IntegrationCandidate {
  return {
    taskId: id,
    sourceRef: `ref-${id}`,
    dependencies,
    changedFiles,
    validationPassed: true,
  };
}

class FakeBackend implements IntegrationBackend {
  readonly applied: string[] = [];
  discarded = false;

  async prepare(integrationId: string): Promise<IntegrationSession> {
    return {
      integrationId,
      resultRef: `result-${integrationId}`,
      workspacePath: `/tmp/${integrationId}`,
    };
  }

  async apply(_session: IntegrationSession, value: Readonly<IntegrationCandidate>): Promise<void> {
    this.applied.push(value.taskId);
  }

  async conflicts(): Promise<string[]> {
    return [];
  }

  async discard(): Promise<void> {
    this.discarded = true;
  }
}

describe('Phase 17 integration coordinator', () => {
  it('orders candidate dependencies deterministically', () => {
    expect(orderIntegrationCandidates([
      candidate('review', ['implement']),
      candidate('inspect'),
      candidate('implement', ['inspect']),
    ])).toEqual(['inspect', 'implement', 'review']);
  });

  it('blocks overlapping files before preparing a backend session', async () => {
    const backend = new FakeBackend();
    const coordinator = new IntegrationCoordinator(backend);
    const result = await coordinator.integrate({
      integrationId: 'overlap',
      baseRef: 'base',
      approved: true,
      candidates: [
        candidate('one', [], ['src/shared.ts']),
        candidate('two', [], ['src/shared.ts']),
      ],
    }, async () => ({ passed: true, commandsRun: [] }));

    expect(result.status).toBe('blocked');
    expect(result.conflicts[0].kind).toBe('file-overlap');
    expect(backend.applied).toEqual([]);
  });

  it('applies validated candidates then runs integrated validation', async () => {
    const backend = new FakeBackend();
    const coordinator = new IntegrationCoordinator(backend);
    const result = await coordinator.integrate({
      integrationId: 'clean',
      baseRef: 'base',
      approved: true,
      candidates: [candidate('b', ['a']), candidate('a')],
    }, async session => ({
      passed: session.resultRef === 'result-clean',
      commandsRun: ['validate'],
    }));

    expect(result.status).toBe('completed');
    expect(backend.applied).toEqual(['a', 'b']);
    expect(result.validation?.passed).toBe(true);
  });

  it('detects interface ownership conflicts', () => {
    const one = { ...candidate('one'), interfaceClaims: ['api:agent'] };
    const two = { ...candidate('two'), interfaceClaims: ['api:agent'] };
    expect(detectIntegrationConflicts([one, two])[0].kind).toBe('interface-overlap');
  });
});
