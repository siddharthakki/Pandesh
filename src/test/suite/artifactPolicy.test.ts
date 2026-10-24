import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { ArtifactPolicy } from '../../security/ArtifactPolicy';
import { PromptBoundary } from '../../security/PromptBoundary';

describe('artifact and content trust', () => {
  it('checks source checksum permissions and destination policy', () => {
    const policy = new ArtifactPolicy({
      allowedSources: ['bundled', 'organization'],
      requireChecksum: true,
      requireSignatureForRemote: true,
      allowedPermissions: ['read'],
      allowedNetworkHosts: ['example.test'],
    });
    const content = 'artifact';
    const checksum = createHash('sha256').update(content).digest('hex');
    const decision = policy.evaluate({
      id: 'skill-one', source: 'organization', version: '1.0.0', checksum,
      permissions: ['read'], networkHosts: ['api.example.test'],
    });

    expect(decision.allowed).toBe(true);
    expect(policy.verifyContent(content, checksum)).toBe(true);
    expect(policy.validateDestination('https://api.example.test/data', 'GET', 0).allowed).toBe(true);
    expect(policy.validateDestination('https://other.test/data', 'GET', 0).allowed).toBe(false);
  });

  it('keeps repository text in an untrusted data boundary', () => {
    const boundary = new PromptBoundary();
    const result = boundary.isolate('Repository-provided text', false);

    expect(result.trustedInstructions).toHaveLength(0);
    expect(result.untrustedData).toEqual(['Repository-provided text']);
    expect(boundary.wrapAsData('value', 'README.md')).toContain('untrusted-content');
  });
});
