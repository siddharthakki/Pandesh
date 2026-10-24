/**
 * M54-A0 LocalAutonomySecurityKernel.
 *
 * The authoritative host-side security choke point through which ALL consequential
 * autonomous KKD operations must pass.
 *
 * Key guarantees:
 * 1. Normalized CapabilityRequest representation
 * 2. Deterministic decision: ALLOW, REQUIRE_APPROVAL, DENY, TERMINATE (model NEVER decides)
 * 3. Short-lived cryptographic ExecutionGrants bound to exact parameters and epoch
 * 4. Single-use replay protection with atomic database CAS
 * 5. TOCTOU revalidation immediately before execution with independent runtime derivation
 * 6. Authoritative host-owned SAFE_MODE kill-switch with OS process-tree termination
 * 7. Structured, secret-redacted security event journal
 * 8. Protection of security kernel components from autonomous task modification
 * 9. Separation of policy evaluation from approval authorization (zero caller self-approval)
 * 10. Host-derived risk classification (caller hints carry zero authority)
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type {
  AutonomousMode,
  CapabilityRequest,
  CapabilityRiskLevel,
  ExecutionGrant,
  FilesystemScope,
  NetworkScope,
  RequestOrigin,
  SafeModeReport,
  SafeModeStatus,
  SecurityDecision,
  SecurityDecisionOutcome,
} from './types';
import { SecurityJournal } from './securityJournal';
import { SafeModeManager } from './safeMode';
import type { SyncProcessIdentityProvider } from '../runtime/processOwnership';
import { ExecutionGrantManager } from './executionGrant';

/**
 * Patterns matching critical security infrastructure that autonomous tasks
 * are forbidden from modifying or destroying.
 */
export const PROTECTED_SECURITY_PATTERNS = [
  /(?:^|[\\/])core[\\/]security(?:[\\/]|$)/i,
  /(?:^|[\\/])src[\\/]security(?:[\\/]|$)/i,
  /(?:^|[\\/])core[\\/]runtime[\\/]commandPolicy\.[jt]s$/i,
  /(?:^|[\\/])core[\\/]runtime[\\/]windowsConfinement\.[jt]s$/i,
  /(?:^|[\\/])core[\\/]domain[\\/]approvals\.[jt]s$/i,
  /(?:^|[\\/])core[\\/]domain[\\/]capabilityDispatch\.[jt]s$/i,
  /(?:^|[\\/])core[\\/]domain[\\/]mutationPolicy\.[jt]s$/i,
  /(?:^|[\\/])core[\\/]db[\\/]migrations\.[jt]s$/i,
  /(?:^|[\\/])\.git[\\/]hooks(?:[\\/]|$)/i,
  /(?:^|[\\/])\.github[\\/]workflows(?:[\\/]|$)/i,
];

export function isProtectedSecurityPath(candidatePath: string): boolean {
  const normalized = candidatePath.replace(/\\/g, '/');
  return PROTECTED_SECURITY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Computes risk level host-side.
 * Model output or caller-supplied riskLevel carries ZERO authority.
 */
export function computeHostRisk(request: CapabilityRequest): CapabilityRiskLevel {
  const cap = request.capability;
  const op = request.operation ?? '';
  const cmd = request.command ?? '';
  const args = request.arguments ?? {};

  // 1. Process / command execution is always consequential
  if (cap === 'process' || cap === 'command' || op === 'run_command' || cmd.trim().length > 0) {
    return 'consequential';
  }

  // 2. Git mutations
  if (cap === 'git' || op.startsWith('git_') || ['commit', 'merge', 'rebase', 'push'].includes(op)) {
    return 'consequential';
  }

  // 3. Filesystem mutations
  if (cap === 'filesystem') {
    if (
      op === 'propose_file_change' ||
      op === 'propose_text_edit' ||
      op === 'write_file' ||
      op === 'delete_file' ||
      args['content'] !== undefined ||
      args['replacement'] !== undefined
    ) {
      return 'consequential';
    }
    if (request.filesystemScope && request.filesystemScope.write && request.filesystemScope.write.length > 0) {
      return 'consequential';
    }
  }

  // 4. Network or browser access
  if (cap === 'network' || cap === 'browser' || (request.networkScope && request.networkScope.allowNetwork)) {
    return 'consequential';
  }

  // 5. External connectors
  if (cap === 'connector' || cap === 'github') {
    return 'consequential';
  }

  // 6. Filesystem read operations: read_only only after canonical scope check
  if (cap === 'filesystem' && (op === 'read_file' || op === 'search' || op === 'list_dir' || !op)) {
    if (request.targetResource && isProtectedSecurityPath(request.targetResource)) {
      return 'consequential';
    }
    return 'read_only';
  }

  return 'consequential';
}

export class LocalAutonomySecurityKernel {
  private static instance: LocalAutonomySecurityKernel | null = null;

  public readonly epoch: string;
  public readonly journal: SecurityJournal;
  public readonly safeMode: SafeModeManager;
  public readonly grants: ExecutionGrantManager;
  private readonly secretKey: string;

  constructor(
    private readonly db?: CoreDatabase | null,
    secretKey?: string,
    epoch?: string,
    /**
     * Read-only process identity lookups for the SAFE_MODE kill switch. It is
     * injectable so the emergency termination path can be tested without
     * touching a real process.
     */
    identityProvider?: SyncProcessIdentityProvider,
  ) {
    this.epoch = epoch ?? `epoch_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    this.secretKey = secretKey ?? crypto.randomBytes(32).toString('hex');
    this.journal = new SecurityJournal(this.db, this.epoch);
    this.safeMode = new SafeModeManager(this.db, this.journal, this.epoch, identityProvider);
    this.grants = new ExecutionGrantManager(this.secretKey, this.db, this.journal, this.safeMode, this.epoch);
    this.safeMode.setGrantRevoker((revokedAt) => this.grants.revokeAllActiveGrants(revokedAt));
  }

  public hasDatabase(): boolean {
    return this.db !== null && this.db !== undefined;
  }

  public static initialize(db: CoreDatabase, secretKey?: string): LocalAutonomySecurityKernel {
    LocalAutonomySecurityKernel.instance = new LocalAutonomySecurityKernel(db, secretKey);
    return LocalAutonomySecurityKernel.instance;
  }

  public static getInstance(db?: CoreDatabase | null): LocalAutonomySecurityKernel {
    if (!LocalAutonomySecurityKernel.instance) {
      if (!db && process.env.NODE_ENV === 'production') {
        throw new Error('SecurityKernel initialization violation: production SecurityKernel requires an authoritative CoreDatabase.');
      }
      LocalAutonomySecurityKernel.instance = new LocalAutonomySecurityKernel(db);
    } else if (db && LocalAutonomySecurityKernel.instance.db !== db) {
      LocalAutonomySecurityKernel.instance = new LocalAutonomySecurityKernel(db);
    }
    return LocalAutonomySecurityKernel.instance;
  }

  public static setInstance(instance: LocalAutonomySecurityKernel | null): void {
    LocalAutonomySecurityKernel.instance = instance;
  }

  public isSafeModeActive(): boolean {
    return this.safeMode.isSafeModeActive();
  }

  public getJournal(): SecurityJournal {
    return this.journal;
  }

  public getSafeModeManager(): SafeModeManager {
    return this.safeMode;
  }

  public getGrantManager(): ExecutionGrantManager {
    return this.grants;
  }

  public verifyAndConsumeGrant(
    grant: ExecutionGrant,
    currentContext: {
      attemptId: string;
      executor: string;
      capability: string;
      workspaceRoot: string;
      targetResource?: string;
      command?: string | null;
      arguments?: Record<string, unknown>;
      filesystemScope?: FilesystemScope;
      networkScope?: NetworkScope;
    },
  ) {
    return this.grants.validateAndConsumeGrant({
      grant,
      ...currentContext,
    });
  }

  /**
   * Pure policy evaluation.
   * Derives risk host-side and determines whether the request is:
   * - ALLOW (for permitted read_only actions)
   * - REQUIRE_APPROVAL (for consequential actions)
   * - DENY / TERMINATE (for policy violations or SAFE_MODE)
   *
   * Callers CANNOT self-approve via evaluate.
   */
  public evaluate(request: CapabilityRequest): SecurityDecision {
    const computedRisk = computeHostRisk(request);

    this.journal.record({
      eventType: 'CAPABILITY_REQUESTED',
      requestId: request.requestId,
      actionId: request.actionId,
      attemptId: request.attemptId,
      objectiveId: request.objectiveId,
      executor: request.executor,
      capability: request.capability,
      targetResource: request.targetResource,
      riskLevel: computedRisk,
      payload: {
        mode: request.mode,
        command: request.command,
        computedRisk,
        callerHint: request.callerRiskHint ?? null,
      },
    });

    // 1. SAFE_MODE active check
    if (this.safeMode.isSafeModeActive()) {
      const decision: SecurityDecision = {
        decision: 'TERMINATE',
        reason: 'SAFE_MODE / EXECUTION_DISABLED is active: all autonomous execution is halted.',
      };
      this.journal.record({
        eventType: 'CAPABILITY_DENIED',
        requestId: request.requestId,
        actionId: request.actionId,
        attemptId: request.attemptId,
        executor: request.executor,
        capability: request.capability,
        targetResource: request.targetResource,
        payload: { reason: decision.reason, safeMode: true },
      });
      return decision;
    }

    // 2. Self-Protection Boundary Check:
    // Autonomous tasks may inspect security source where read allowed, but never mutate.
    if (
      request.targetResource &&
      isProtectedSecurityPath(request.targetResource) &&
      computedRisk !== 'read_only'
    ) {
      const decision: SecurityDecision = {
        decision: 'DENY',
        reason: `Target resource '${request.targetResource}' is an authoritative security kernel component. Autonomous modification is strictly forbidden.`,
      };
      this.journal.record({
        eventType: 'CIRCUMVENTION_SUSPECTED',
        requestId: request.requestId,
        actionId: request.actionId,
        attemptId: request.attemptId,
        executor: request.executor,
        capability: request.capability,
        targetResource: request.targetResource,
        payload: {
          violation: 'security_component_modification_attempt',
          target: request.targetResource,
          reason: decision.reason,
        },
      });
      this.journal.record({
        eventType: 'CAPABILITY_DENIED',
        requestId: request.requestId,
        actionId: request.actionId,
        attemptId: request.attemptId,
        executor: request.executor,
        capability: request.capability,
        targetResource: request.targetResource,
        payload: { reason: decision.reason, selfProtection: true },
      });
      return decision;
    }

    // 3. Mode Boundary Checks
    if (request.mode === 'baat_kar') {
      if (computedRisk !== 'read_only') {
        const decision: SecurityDecision = {
          decision: 'DENY',
          reason: 'Baat Kar mode is strictly conversational and read-only. Consequential actions are forbidden.',
        };
        this.journal.record({
          eventType: 'CAPABILITY_DENIED',
          requestId: request.requestId,
          actionId: request.actionId,
          attemptId: request.attemptId,
          executor: request.executor,
          capability: request.capability,
          payload: { reason: decision.reason, mode: request.mode },
        });
        return decision;
      }
    }

    // 4. Read-Only Capabilities are ALLOWed
    if (computedRisk === 'read_only') {
      const grant = this.grants.issueGrant({
        requestId: request.requestId,
        actionId: request.actionId,
        attemptId: request.attemptId,
        executor: request.executor,
        capability: request.capability,
        workspaceRoot: request.workspaceRoot,
        targetResource: request.targetResource,
        command: request.command,
        arguments: request.arguments,
        filesystemScope: request.filesystemScope,
        networkScope: request.networkScope,
        riskClass: 'read_only',
        singleUse: false,
      });

      this.journal.record({
        eventType: 'CAPABILITY_ALLOWED',
        requestId: request.requestId,
        actionId: request.actionId,
        attemptId: request.attemptId,
        executor: request.executor,
        capability: request.capability,
        targetResource: request.targetResource,
        payload: { grantId: grant.grantId, riskLevel: 'read_only' },
      });

      return {
        decision: 'ALLOW',
        reason: 'Read-only capability allowed.',
        grant,
      };
    }

    // 5. Consequential / Critical Capabilities REQUIRE APPROVAL
    this.journal.record({
      eventType: 'APPROVAL_REQUIRED',
      requestId: request.requestId,
      actionId: request.actionId,
      attemptId: request.attemptId,
      objectiveId: request.objectiveId,
      executor: request.executor,
      capability: request.capability,
      targetResource: request.targetResource,
      riskLevel: computedRisk,
      payload: {
        reason: 'Consequential action requires explicit human operator approval.',
        command: request.command,
      },
    });

    return {
      decision: 'REQUIRE_APPROVAL',
      reason: 'Consequential action requires explicit human operator approval.',
      requiresApprovalDetails: {
        summary: {
          requestId: request.requestId,
          actionId: request.actionId,
          capability: request.capability,
          command: request.command,
          targetResource: request.targetResource,
        },
      },
    };
  }

  /**
   * Authorizes an action that requires approval, validating approval evidence from the database.
   * Only returns an ExecutionGrant if a verified, resolved, unexpired approval exists.
   */
  public authorize(
    request: CapabilityRequest,
    approvalEvidence?: { approvalId?: string; ttlMs?: number },
  ): SecurityDecision {
    const evaluation = this.evaluate(request);

    if (evaluation.decision !== 'REQUIRE_APPROVAL') {
      return evaluation;
    }

    const computedRisk = computeHostRisk(request);

    // Trusted Internal Exemption: Host-directed workspace validation runner
    if (
      request.origin.provenance === 'trusted_internal_validation' &&
      !request.origin.isModelGenerated &&
      request.executor === 'core:workspace_validation'
    ) {
      const grant = this.grants.issueGrant({
        requestId: request.requestId,
        actionId: request.actionId,
        attemptId: request.attemptId,
        executor: request.executor,
        capability: request.capability,
        workspaceRoot: request.workspaceRoot,
        targetResource: request.targetResource,
        command: request.command,
        arguments: request.arguments,
        filesystemScope: request.filesystemScope,
        networkScope: request.networkScope,
        riskClass: computedRisk,
        singleUse: true,
      });

      this.journal.record({
        eventType: 'GRANT_ISSUED',
        requestId: request.requestId,
        actionId: request.actionId,
        attemptId: request.attemptId,
        executor: request.executor,
        capability: request.capability,
        targetResource: request.targetResource,
        payload: {
          grantId: grant.grantId,
          justification: 'trusted_internal_validation',
        },
      });

      return {
        decision: 'ALLOW',
        reason: 'Authorized via trusted internal validation execution.',
        grant,
      };
    }

    // Model and external calls MUST provide valid approval evidence
    if (!approvalEvidence || !approvalEvidence.approvalId) {
      return {
        decision: 'REQUIRE_APPROVAL',
        reason: 'Consequential action requires verified approval evidence.',
      };
    }

    // Query database for authoritative approval record
    if (this.db) {
      try {
        const row = this.db.get<{
          id: string;
          status: string;
          resolution: string | null;
          summary: string;
        }>(
          'SELECT id, status, resolution, summary FROM approvals WHERE id = ?',
          [approvalEvidence.approvalId],
        );

        if (!row) {
          this.journal.record({
            eventType: 'APPROVAL_DENIED',
            requestId: request.requestId,
            actionId: request.actionId,
            attemptId: request.attemptId,
            executor: request.executor,
            capability: request.capability,
            targetResource: request.targetResource,
            payload: { reason: 'APPROVAL_RECORD_NOT_FOUND', approvalId: approvalEvidence.approvalId },
          });
          return {
            decision: 'DENY',
            reason: `Approval record '${approvalEvidence.approvalId}' does not exist in authoritative storage.`,
          };
        }

        const isApproved = row.status === 'approved' || (row.status === 'resolved' && row.resolution === 'approved') || (row.resolution === 'approved' && row.status !== 'rejected');
        if (!isApproved) {
          this.journal.record({
            eventType: 'APPROVAL_DENIED',
            requestId: request.requestId,
            actionId: request.actionId,
            attemptId: request.attemptId,
            executor: request.executor,
            capability: request.capability,
            targetResource: request.targetResource,
            payload: {
              reason: 'APPROVAL_NOT_RESOLVED_APPROVED',
              status: row.status,
              resolution: row.resolution,
            },
          });
          return {
            decision: 'DENY',
            reason: `Approval record '${approvalEvidence.approvalId}' is not approved (status: ${row.status}, resolution: ${row.resolution}).`,
          };
        }

        // Validate summary details match the request
        try {
          const summary = JSON.parse(row.summary);
          if (summary.requestedCommand && request.command && summary.requestedCommand !== request.command) {
            return {
              decision: 'DENY',
              reason: 'Approval evidence mismatch: requested command does not match approval.',
            };
          }
        } catch {
          // ignore summary parse error
        }
      } catch (err) {
        return {
          decision: 'DENY',
          reason: `Database error verifying approval: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Approval is verified: issue single-use grant
    const grant = this.grants.issueGrant({
      requestId: request.requestId,
      actionId: request.actionId,
      attemptId: request.attemptId,
      executor: request.executor,
      capability: request.capability,
      workspaceRoot: request.workspaceRoot,
      targetResource: request.targetResource,
      command: request.command,
      arguments: request.arguments,
      filesystemScope: request.filesystemScope,
      networkScope: request.networkScope,
      riskClass: computedRisk,
      singleUse: true,
      ttlMs: approvalEvidence?.ttlMs,
    });

    this.journal.record({
      eventType: 'APPROVAL_GRANTED',
      requestId: request.requestId,
      actionId: request.actionId,
      attemptId: request.attemptId,
      executor: request.executor,
      capability: request.capability,
      targetResource: request.targetResource,
      payload: { grantId: grant.grantId, approvalId: approvalEvidence.approvalId },
    });

    this.journal.record({
      eventType: 'CAPABILITY_ALLOWED',
      requestId: request.requestId,
      actionId: request.actionId,
      attemptId: request.attemptId,
      executor: request.executor,
      capability: request.capability,
      targetResource: request.targetResource,
      payload: { grantId: grant.grantId, riskLevel: computedRisk },
    });

    return {
      decision: 'ALLOW',
      reason: 'Operation approved by verified host approval record.',
      grant,
      approvalId: approvalEvidence.approvalId,
    };
  }

  public normalizeRequest(params: {
    attemptId: string;
    executor: string;
    capability: string;
    workspaceRoot: string;
    targetResource?: string;
    command?: string | null;
    arguments?: Record<string, unknown>;
    mode?: AutonomousMode;
    origin?: Partial<RequestOrigin>;
    operation?: string;
    callerRiskHint?: CapabilityRiskLevel;
    riskLevel?: CapabilityRiskLevel; // legacy compatibility param
  }): CapabilityRequest {
    const requestId = `req_${crypto.randomUUID()}`;
    const actionId = `act_${crypto.randomUUID()}`;
    const workspaceRoot = path.resolve(params.workspaceRoot);
    const targetResource = params.targetResource ? path.resolve(params.workspaceRoot, params.targetResource) : workspaceRoot;

    const request: CapabilityRequest = {
      requestId,
      actionId,
      attemptId: params.attemptId,
      objectiveId: params.attemptId,
      mode: params.mode ?? 'karke_dikha',
      modelProvider: 'local/host',
      executor: params.executor,
      capability: params.capability,
      operation: params.operation,
      workspaceRoot,
      targetResource,
      command: params.command ?? null,
      arguments: params.arguments ?? {},
      filesystemScope: {
        read: [workspaceRoot],
        write: [workspaceRoot],
        allowOutsideWorkspace: false,
      },
      networkScope: {
        allowNetwork: false,
      },
      origin: {
        provenance: params.origin?.provenance ?? 'autonomous_runtime',
        actor: params.origin?.actor ?? 'agent:runtime',
        clientId: params.origin?.clientId,
        isModelGenerated: params.origin?.isModelGenerated ?? true,
      },
      callerRiskHint: params.callerRiskHint ?? params.riskLevel,
      riskLevel: 'consequential', // will be derived host-side by computeHostRisk
      timestamp: new Date().toISOString(),
    };

    return request;
  }
}
