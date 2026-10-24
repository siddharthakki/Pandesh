import { describe, expect, it } from 'vitest';
import { MultiRepositoryPlanner } from '../../multirepo/MultiRepositoryPlanner';

describe('multi-repository planner', () => {
  it('orders dependencies and exposes downstream impact before changes', () => {
    const planner = new MultiRepositoryPlanner();
    planner.register({
      id: 'library', root: '/repos/library', revision: 'a1', dependencies: [],
      owners: ['library-team'], labels: {}, writable: true,
    });
    planner.register({
      id: 'application', root: '/repos/application', revision: 'b1',
      dependencies: [{ repositoryId: 'library', kind: 'api' }],
      owners: ['application-team'], labels: {}, writable: true,
    });

    const plan = planner.plan([{
      repositoryId: 'library', files: ['src/api.ts'], exportedContracts: ['LibraryApi'],
      requiredValidation: ['unit-tests'], description: 'change public api',
    }]);

    expect(plan.steps.map(step => step.repositoryId)).toEqual(['library', 'application']);
    expect(plan.impacts.find(impact => impact.repositoryId === 'application')?.requiredValidation).toContain('contract-tests');
    expect(planner.verifyRevisions(plan)).toBe(true);
    planner.updateRevision('library', 'a2');
    expect(planner.verifyRevisions(plan)).toBe(false);
  });
});
