/**
 * M54-A Authoritative Local Autonomy Security Kernel Types.
 *
 * Defines the normalized contract through which all consequential autonomous
 * KKD actions must pass. Host-governed, fail-closed, and unforgeable.
 */

export type CapabilityRiskLevel = 'read_only' | 'consequential' | 'critical';

export type PrincipalRole =
  | 'host_operator'
  | 'desktop_host'
  | 'agent_client'
  | 'model_runtime'
  | 'tool_call'
  | 'connector'
  | 'browser_client'
  | 'unknown';

export interface AuthenticatedPrincipal {
  readonly role: PrincipalRole;
  readonly id: string;
  readonly isTrustedOperator: boolean;
  readonly isTrustedHost: boolean;
  readonly isModelOrTool: boolean;
  readonly source: 'host_transport' | 'internal_server' | 'untrusted_client';
}

export type AutonomousMode = 'baat_kar' | 'saath_kar' | 'karke_dikha';

export type SecurityDecisionOutcome = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY' | 'TERMINATE';

export interface FilesystemScope {
  /** Relative or absolute read paths authorized. */
  readonly read?: readonly string[];
  /** Relative or absolute write paths authorized. */
  readonly write?: readonly string[];
  /** True only if workspace boundary escape is explicitly approved. */
  readonly allowOutsideWorkspace?: boolean;
}

export interface NetworkScope {
  /** True only if network access is requested and authorized. */
  readonly allowNetwork: boolean;
  /** Explicit allowed destination hosts or IP ranges. */
  readonly destinations?: readonly string[];
}

export interface RequestOrigin {
  /** Provenance description, e.g. 'autonomous_agent', 'user_chat', 'system_validation'. */
  readonly provenance: string;
  /** Actor identifier (e.g. 'core:executor', 'user:operator', 'agent:mission'). */
  readonly actor: string;
  /** Client connection ID if applicable. */
  readonly clientId?: string;
  /** True when the action was generated directly by an LLM tool call. */
  readonly isModelGenerated?: boolean;
}

/**
 * Normalized capability request submitted to the SecurityKernel before any
 * consequential side effect may be performed.
 */
export interface CapabilityRequest {
  readonly requestId: string;
  readonly actionId: string;
  readonly attemptId: string;
  /** Objective or task identity (e.g. correlationId, taskId, storyId). */
  readonly objectiveId: string;
  readonly mode: AutonomousMode;
  /** Model and provider string (e.g. 'ollama/llama3', 'openrouter/qwen'). */
  readonly modelProvider: string;
  /** Executor component (e.g. 'core:tool_runner', 'core:mission_runner', 'ext:tool_executor'). */
  readonly executor: string;
  /** Capability identity (e.g. 'filesystem', 'command', 'process', 'git', 'browser', 'github', 'connector'). */
  readonly capability: string;
  readonly operation?: string;
  readonly callerRiskHint?: CapabilityRiskLevel;
  /** Canonical workspace or worktree root path. */
  readonly workspaceRoot: string;
  /** Target resource (path, URL, repository name, process handle). */
  readonly targetResource: string;
  /** Shell command or executable binary name where relevant. */
  readonly command?: string | null;
  /** Full normalized arguments dictionary. */
  readonly arguments: Record<string, unknown>;
  /** Requested filesystem access scope. */
  readonly filesystemScope: FilesystemScope;
  /** Requested network access scope. */
  readonly networkScope: NetworkScope;
  /** Origin and provenance details. */
  readonly origin: RequestOrigin;
  /** Risk classification. */
  readonly riskLevel: CapabilityRiskLevel;
  /** ISO-8601 request timestamp. */
  readonly timestamp: string;
}

/**
 * Authoritative, cryptographically bound execution grant issued by the
 * SecurityKernel upon ALLOW or approved REQUIRE_APPROVAL.
 */
export interface ExecutionGrant {
  /** Unique grant identifier. */
  readonly grantId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly attemptId: string;
  readonly executor: string;
  readonly capability: string;
  readonly workspaceRoot: string;
  readonly targetResource: string;
  readonly command: string | null;
  /** SHA-256 digest of canonical argument JSON. */
  readonly argumentsHash: string;
  /** SHA-256 digest of normalized filesystem scope. */
  readonly filesystemScopeHash: string;
  readonly filesystemScope?: FilesystemScope;
  /** SHA-256 digest of normalized network scope. */
  readonly networkScopeHash: string;
  readonly networkScope?: NetworkScope;
  readonly riskClass: CapabilityRiskLevel;
  /** ISO-8601 issuance timestamp. */
  readonly issuedAt: string;
  /** ISO-8601 expiration timestamp (short-lived, e.g. 60-120s). */
  readonly expiresAt: string;
  /** Cryptographic random nonce preventing collision/forgery. */
  readonly nonce: string;
  /** HMAC-SHA256 signature binding all above fields together. */
  readonly grantDigest: string;
  /** True for single-use execution grants (mandatory for consequential mutations). */
  readonly singleUse: boolean;
  /** ISO-8601 timestamp when the grant was consumed, or null if unused. */
  readonly consumedAt?: string | null;
  /** ISO-8601 timestamp if explicitly revoked early (e.g. via SAFE_MODE). */
  readonly revokedAt?: string | null;
  readonly epoch: string;
}

/**
 * Result returned by the LocalAutonomySecurityKernel.
 * The model NEVER decides this result.
 */
export interface SecurityDecision {
  readonly decision: SecurityDecisionOutcome;
  readonly reason: string;
  /** Valid grant issued if ALLOW, or if an approved action was authorized. */
  readonly grant?: ExecutionGrant;
  /** Approval ID required to be resolved by a human operator if REQUIRE_APPROVAL. */
  readonly approvalId?: string;
  /** Audit/summary metadata for the decision. */
  readonly metadata?: Record<string, unknown>;
  readonly requiresApprovalDetails?: { summary: Record<string, unknown>; };
}

export type SecurityEventType =
  | 'CAPABILITY_REQUESTED'
  | 'CAPABILITY_ALLOWED'
  | 'CAPABILITY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'GRANT_ISSUED'
  | 'GRANT_REJECTED'
  | 'GRANT_REPLAY_ATTEMPT'
  | 'TOCTOU_REJECTED'
  | 'CIRCUMVENTION_SUSPECTED'
  | 'SAFE_MODE_ENTERED'
  | 'SAFE_MODE_EXITED'
  | 'EXECUTION_TERMINATED';

export interface SecurityEventRecord {
  readonly id: string;
  readonly eventType: SecurityEventType;
  readonly requestId?: string | null;
  readonly actionId?: string | null;
  readonly attemptId?: string | null;
  readonly objectiveId?: string | null;
  readonly executor?: string | null;
  readonly capability?: string | null;
  readonly targetResource?: string | null;
  readonly riskLevel?: string | null;
  /** Redacted, structured event payload. Raw secrets are NEVER recorded. */
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface SafeModeStatus {
  readonly active: boolean;
  readonly reason?: string | null;
  readonly activatedAt?: string | null;
  readonly activatedBy?: string | null;
  readonly deactivatedAt?: string | null;
  readonly deactivatedBy?: string | null;
}

export interface SafeModeReport {
  readonly active: boolean;
  readonly reason: string;
  readonly actor: string;
  readonly terminatedProcessPids: readonly number[];
  readonly cancelledAttemptIds: readonly string[];
  readonly invalidatedGrantIds: readonly string[];
  readonly timestamp: string;
}

/**
 * M54-B Preparation Contracts:
 * These define the interfaces that M54-B OS/container sandbox profiles will
 * implement. In M54-A, they exist as authoritative contracts and baseline validation.
 */
export type ExecutionProfile = 'STRICT_SANDBOX' | 'HOST_GOVERNED';

export interface NetworkPolicy {
  readonly profile: ExecutionProfile;
  readonly allowOutbound: boolean;
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
}

export interface FilesystemPolicy {
  readonly profile: ExecutionProfile;
  readonly readOnlyPaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly deniedPaths: readonly string[];
}

export interface EgressPolicy {
  readonly profile: ExecutionProfile;
  readonly allowedProtocols: readonly ('http' | 'https' | 'ssh' | 'git')[];
  readonly blockPrivateSubnets: boolean;
}

