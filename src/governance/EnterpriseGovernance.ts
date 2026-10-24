import { randomUUID } from 'crypto';

export type GovernanceAction =
  | 'task.read'
  | 'task.execute'
  | 'task.mutate'
  | 'task.approve'
  | 'memory.read'
  | 'memory.write'
  | 'audit.export'
  | 'policy.manage'
  | 'release.publish';

export interface GovernanceRole {
  id: string;
  permissions: GovernanceAction[];
}

export interface GovernanceSubject {
  id: string;
  roles: string[];
  groups: string[];
  region?: string;
}

export interface OrganizationPolicy {
  organizationId: string;
  allowedRegions: string[];
  retentionDays: number;
  requireApprovalFor: GovernanceAction[];
  deniedActions: GovernanceAction[];
  allowedProviders: string[];
  allowedNetworkHosts: string[];
  maximumSensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
}

export interface RepositoryPolicyOverlay {
  repositoryId: string;
  requireApprovalFor?: GovernanceAction[];
  deniedActions?: GovernanceAction[];
  allowedProviders?: string[];
  allowedNetworkHosts?: string[];
  retentionDays?: number;
}

export interface GovernanceRequest {
  subject: GovernanceSubject;
  action: GovernanceAction;
  repositoryId?: string;
  provider?: string;
  networkHost?: string;
  dataRegion?: string;
  sensitivity?: OrganizationPolicy['maximumSensitivity'];
}

export interface GovernanceDecision {
  allowed: boolean;
  approvalRequired: boolean;
  reasons: string[];
  effectivePolicy: EffectiveGovernancePolicy;
}

export interface EffectiveGovernancePolicy extends OrganizationPolicy {
  repositoryId?: string;
}

export interface GovernanceAuditEvent {
  id: string;
  timestamp: string;
  subjectId: string;
  action: GovernanceAction;
  repositoryId?: string;
  allowed: boolean;
  approvalRequired: boolean;
  reasons: string[];
}

export class EnterpriseGovernance {
  private readonly roles = new Map<string, GovernanceRole>();
  private readonly overlays = new Map<string, RepositoryPolicyOverlay>();
  private readonly audit: GovernanceAuditEvent[] = [];

  constructor(private readonly organizationPolicy: OrganizationPolicy) {
    validateOrganizationPolicy(organizationPolicy);
  }

  registerRole(role: GovernanceRole): void {
    if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(role.id)) throw new Error(`Invalid governance role: ${role.id}`);
    if (this.roles.has(role.id)) throw new Error(`Governance role already exists: ${role.id}`);
    this.roles.set(role.id, { ...role, permissions: [...new Set(role.permissions)].sort() });
  }

  setRepositoryOverlay(overlay: RepositoryPolicyOverlay): EffectiveGovernancePolicy {
    validateOverlay(overlay, this.organizationPolicy);
    this.overlays.set(overlay.repositoryId, clone(overlay));
    return this.effectivePolicy(overlay.repositoryId);
  }

  effectivePolicy(repositoryId?: string): EffectiveGovernancePolicy {
    const overlay = repositoryId ? this.overlays.get(repositoryId) : undefined;
    return {
      ...clone(this.organizationPolicy),
      repositoryId,
      retentionDays: overlay?.retentionDays ?? this.organizationPolicy.retentionDays,
      requireApprovalFor: [...new Set([
        ...this.organizationPolicy.requireApprovalFor,
        ...(overlay?.requireApprovalFor ?? []),
      ])].sort(),
      deniedActions: [...new Set([
        ...this.organizationPolicy.deniedActions,
        ...(overlay?.deniedActions ?? []),
      ])].sort(),
      allowedProviders: overlay?.allowedProviders
        ? intersect(this.organizationPolicy.allowedProviders, overlay.allowedProviders)
        : [...this.organizationPolicy.allowedProviders],
      allowedNetworkHosts: overlay?.allowedNetworkHosts
        ? intersect(this.organizationPolicy.allowedNetworkHosts, overlay.allowedNetworkHosts)
        : [...this.organizationPolicy.allowedNetworkHosts],
    };
  }

  evaluate(request: GovernanceRequest): GovernanceDecision {
    const policy = this.effectivePolicy(request.repositoryId);
    const reasons: string[] = [];
    const permissions = new Set(
      request.subject.roles.flatMap(roleId => this.roles.get(roleId)?.permissions ?? []),
    );
    if (!permissions.has(request.action)) reasons.push(`Subject lacks permission ${request.action}.`);
    if (policy.deniedActions.includes(request.action)) reasons.push(`Action ${request.action} is denied by policy.`);
    if (request.dataRegion && !policy.allowedRegions.includes(request.dataRegion)) {
      reasons.push(`Data region ${request.dataRegion} is not allowed.`);
    }
    if (request.subject.region && !policy.allowedRegions.includes(request.subject.region)) {
      reasons.push(`Subject region ${request.subject.region} is not allowed.`);
    }
    if (request.provider && !policy.allowedProviders.includes(request.provider)) {
      reasons.push(`Provider ${request.provider} is not allowed.`);
    }
    if (request.networkHost && !hostAllowed(request.networkHost, policy.allowedNetworkHosts)) {
      reasons.push(`Network host ${request.networkHost} is not allowed.`);
    }
    if (request.sensitivity && sensitivityRank(request.sensitivity) > sensitivityRank(policy.maximumSensitivity)) {
      reasons.push(`Sensitivity ${request.sensitivity} exceeds policy maximum.`);
    }
    const allowed = reasons.length === 0;
    const approvalRequired = allowed && policy.requireApprovalFor.includes(request.action);
    const decision: GovernanceDecision = {
      allowed,
      approvalRequired,
      reasons,
      effectivePolicy: policy,
    };
    this.audit.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      subjectId: request.subject.id,
      action: request.action,
      repositoryId: request.repositoryId,
      allowed,
      approvalRequired,
      reasons: [...reasons],
    });
    return clone(decision);
  }

  exportAudit(filter: { since?: string; repositoryId?: string; subjectId?: string } = {}): GovernanceAuditEvent[] {
    const since = filter.since ? Date.parse(filter.since) : Number.NEGATIVE_INFINITY;
    return this.audit
      .filter(event => Date.parse(event.timestamp) >= since)
      .filter(event => !filter.repositoryId || event.repositoryId === filter.repositoryId)
      .filter(event => !filter.subjectId || event.subjectId === filter.subjectId)
      .map(clone)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  retentionCutoff(now = new Date()): string {
    return new Date(now.getTime() - this.organizationPolicy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  }
}

function validateOrganizationPolicy(policy: OrganizationPolicy): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(policy.organizationId)) throw new Error('Invalid organization id.');
  if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1) throw new Error('Retention must be at least one day.');
  if (policy.allowedRegions.length === 0) throw new Error('At least one data region is required.');
}

function validateOverlay(overlay: RepositoryPolicyOverlay, organization: OrganizationPolicy): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(overlay.repositoryId)) throw new Error('Invalid repository policy id.');
  if (overlay.retentionDays !== undefined && overlay.retentionDays > organization.retentionDays) {
    throw new Error('Repository retention cannot exceed organization retention.');
  }
  if (overlay.allowedProviders?.some(provider => !organization.allowedProviders.includes(provider))) {
    throw new Error('Repository policy cannot add organization-denied providers.');
  }
  if (overlay.allowedNetworkHosts?.some(host => !organization.allowedNetworkHosts.includes(host))) {
    throw new Error('Repository policy cannot add organization-denied network hosts.');
  }
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const normalized = host.toLowerCase();
  return allowed.some(candidate => normalized === candidate.toLowerCase() || normalized.endsWith(`.${candidate.toLowerCase()}`));
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter(value => rightSet.has(value)).sort();
}

function sensitivityRank(value: OrganizationPolicy['maximumSensitivity']): number {
  return value === 'public' ? 0 : value === 'internal' ? 1 : value === 'confidential' ? 2 : 3;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
