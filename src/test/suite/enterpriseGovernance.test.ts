import { describe, expect, it } from 'vitest';
import { EnterpriseGovernance } from '../../governance/EnterpriseGovernance';

describe('enterprise governance', () => {
  it('allows repository overlays to tighten but not weaken organization policy', () => {
    const governance = new EnterpriseGovernance({
      organizationId: 'org-one',
      allowedRegions: ['eu'],
      retentionDays: 30,
      requireApprovalFor: ['task.mutate'],
      deniedActions: ['policy.manage'],
      allowedProviders: ['local', 'approved-cloud'],
      allowedNetworkHosts: ['example.test'],
      maximumSensitivity: 'confidential',
    });
    governance.registerRole({ id: 'developer', permissions: ['task.read', 'task.execute', 'task.mutate'] });
    governance.setRepositoryOverlay({
      repositoryId: 'repo-one',
      allowedProviders: ['local'],
      retentionDays: 14,
    });

    const allowed = governance.evaluate({
      subject: { id: 'user-one', roles: ['developer'], groups: [], region: 'eu' },
      action: 'task.mutate', repositoryId: 'repo-one', provider: 'local', dataRegion: 'eu',
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.approvalRequired).toBe(true);
    expect(allowed.effectivePolicy.retentionDays).toBe(14);

    expect(() => governance.setRepositoryOverlay({
      repositoryId: 'repo-two', allowedProviders: ['unapproved-provider'],
    })).toThrow(/cannot add/i);
  });
});
