import { createHash } from 'crypto';

export type ArtifactSource = 'bundled' | 'organization' | 'user' | 'repository' | 'remote';

export interface ArtifactDescriptor {
  id: string;
  source: ArtifactSource;
  version: string;
  checksum: string;
  publisher?: string;
  signature?: string;
  permissions: string[];
  networkHosts: string[];
}

export interface ArtifactTrustPolicy {
  allowedSources: ArtifactSource[];
  requireChecksum: boolean;
  requireSignatureForRemote: boolean;
  allowedPublishers?: string[];
  allowedPermissions: string[];
  allowedNetworkHosts: string[];
}

export interface ArtifactTrustDecision {
  allowed: boolean;
  reasons: string[];
  artifactId: string;
  policyFingerprint: string;
}

export class ArtifactPolicy {
  constructor(private readonly policy: ArtifactTrustPolicy) {}

  evaluate(artifact: ArtifactDescriptor): ArtifactTrustDecision {
    const reasons: string[] = [];
    if (!this.policy.allowedSources.includes(artifact.source)) {
      reasons.push(`Source ${artifact.source} is not allowed.`);
    }
    if (this.policy.requireChecksum && !/^[a-f0-9]{64}$/i.test(artifact.checksum)) {
      reasons.push('A valid SHA-256 checksum is required.');
    }
    if (artifact.source === 'remote' && this.policy.requireSignatureForRemote && !artifact.signature) {
      reasons.push('Remote artifacts require a signature.');
    }
    if (this.policy.allowedPublishers?.length &&
      (!artifact.publisher || !this.policy.allowedPublishers.includes(artifact.publisher))) {
      reasons.push('Artifact publisher is not allowed.');
    }
    const deniedPermissions = artifact.permissions.filter(
      permission => !this.policy.allowedPermissions.includes(permission),
    );
    if (deniedPermissions.length > 0) {
      reasons.push(`Permissions are not allowed: ${deniedPermissions.join(', ')}`);
    }
    const deniedHosts = artifact.networkHosts.filter(
      host => !hostAllowed(host, this.policy.allowedNetworkHosts),
    );
    if (deniedHosts.length > 0) {
      reasons.push(`Network hosts are not allowed: ${deniedHosts.join(', ')}`);
    }
    return {
      allowed: reasons.length === 0,
      reasons,
      artifactId: artifact.id,
      policyFingerprint: createHash('sha256')
        .update(stableStringify(this.policy))
        .digest('hex'),
    };
  }

  verifyContent(content: Buffer | string, expectedChecksum: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(expectedChecksum)) return false;
    return createHash('sha256').update(content).digest('hex').toLowerCase() === expectedChecksum.toLowerCase();
  }

  validateDestination(url: string, method: string, payloadBytes: number): { allowed: boolean; reason?: string } {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: 'Invalid network destination.' };
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return { allowed: false, reason: 'Network protocol is not allowed.' };
    }
    if (!hostAllowed(parsed.hostname, this.policy.allowedNetworkHosts)) {
      return { allowed: false, reason: `Network host is not allowed: ${parsed.hostname}` };
    }
    if (!['GET', 'HEAD', 'POST'].includes(method.toUpperCase())) {
      return { allowed: false, reason: `HTTP method is not allowed: ${method}` };
    }
    if (!Number.isFinite(payloadBytes) || payloadBytes < 0 || payloadBytes > 5 * 1024 * 1024) {
      return { allowed: false, reason: 'Network payload exceeds the configured limit.' };
    }
    return { allowed: true };
  }
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const normalized = host.toLowerCase();
  return allowed.some(candidate =>
    normalized === candidate.toLowerCase() ||
    normalized.endsWith(`.${candidate.toLowerCase()}`),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      key => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
