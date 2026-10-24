import * as crypto from 'crypto';
import { Config } from '../config/Config';
import type { ProviderType } from '../providers/ProviderTypes';
import type { GovernedModelRequest } from '../agent/GovernedModelExecutionTypes';

export const M19_AGENT_WORKFORCE_CONTRACT_VERSION = 1 as const;

export const M19_WORKFORCE_STAGES = [
  'repository-analyst',
  'planner',
  'implementer',
  'reviewer',
  'validator',
] as const;

export type M19WorkforceStage = typeof M19_WORKFORCE_STAGES[number];

export interface M19AgentDefinition {
  agentId: string;
  role: M19WorkforceStage;
  primaryModel: string;
  fallbackModel: string;
  providerType?: ProviderType;
}

export type M19AgentRoster = Record<M19WorkforceStage, M19AgentDefinition>;

export interface M19AgentAssignment {
  contractVersion: typeof M19_AGENT_WORKFORCE_CONTRACT_VERSION;
  stage: M19WorkforceStage;
  agentId: string;
  role: M19WorkforceStage;
  model: string;
  providerType?: ProviderType;
  routingReason: 'role_primary' | 'configured_fallback' | 'request_fallback';
  fallbackFrom?: string;
}

export interface M19HandoffEvidence {
  fromStage: M19WorkforceStage;
  fromAgentId: string;
  toStage: M19WorkforceStage;
  toAgentId: string;
  payloadSha256: string;
  payloadBytes: number;
}

export interface M19WorkforceAuditEvidence {
  contractVersion: typeof M19_AGENT_WORKFORCE_CONTRACT_VERSION;
  assignment: M19AgentAssignment;
  handoff?: M19HandoffEvidence;
}

interface CompletedStageEvidence {
  stage: M19WorkforceStage;
  agentId: string;
  outputSha256: string;
  outputBytes: number;
}

/**
 * Routes the existing fixed five-stage graph onto named, role-specific workers.
 * It does not add retries, tools, mutation authority or parallel execution. The
 * existing graph remains the sole owner of ordering and bounded stage count.
 *
 * The router mutates only trusted request routing metadata (`model`, optional
 * `providerType`, and bounded audit metadata) before the provider dependency
 * executes. Issue text and model output never influence agent assignment.
 */
export class M19AgentWorkforceRouter {
  private previous?: CompletedStageEvidence;

  constructor(private readonly roster: M19AgentRoster) {
    validateRoster(roster);
  }

  prepare(request: GovernedModelRequest): M19AgentAssignment | undefined {
    const stage = stageFromRequestId(request.requestId);
    if (!stage) return undefined;

    const definition = this.roster[stage];
    const assignment = resolveAssignment(definition, request.model, request.providerType);
    request.model = assignment.model;
    if (assignment.providerType) request.providerType = assignment.providerType;

    const handoff = this.previous
      ? {
          fromStage: this.previous.stage,
          fromAgentId: this.previous.agentId,
          toStage: stage,
          toAgentId: assignment.agentId,
          payloadSha256: this.previous.outputSha256,
          payloadBytes: this.previous.outputBytes,
        }
      : undefined;

    if (request.audit) {
      request.audit = {
        ...request.audit,
        metadata: {
          ...(request.audit.metadata ?? {}),
          m19Workforce: {
            contractVersion: M19_AGENT_WORKFORCE_CONTRACT_VERSION,
            assignment,
            handoff,
          } satisfies M19WorkforceAuditEvidence,
        },
      };
    }

    return assignment;
  }

  complete(assignment: M19AgentAssignment | undefined, completion: string): void {
    if (!assignment) return;
    this.previous = {
      stage: assignment.stage,
      agentId: assignment.agentId,
      outputSha256: sha256(completion),
      outputBytes: Buffer.byteLength(completion, 'utf8'),
    };
  }

  reset(): void {
    this.previous = undefined;
  }
}

/**
 * Production composition entry point. The existing `sequentialRolesEnabled`
 * setting is the explicit compatibility and cost opt-in for M19. When it is
 * disabled, the provider dependency receives no workforce router and preserves
 * the legacy single-model behavior byte-for-byte.
 */
export function createConfiguredM19AgentWorkforceRouter(): M19AgentWorkforceRouter | undefined {
  if (!Config.getSequentialRolesEnabled()) return undefined;
  const providerType = Config.getProviderType();
  const fallbackModel = Config.getCodingFallbackModel();
  return new M19AgentWorkforceRouter({
    'repository-analyst': {
      agentId: 'm19.repository-analyst',
      role: 'repository-analyst',
      primaryModel: Config.getChatModel(),
      fallbackModel,
      providerType,
    },
    planner: {
      agentId: 'm19.planner',
      role: 'planner',
      primaryModel: Config.getChatModel(),
      fallbackModel,
      providerType,
    },
    implementer: {
      agentId: 'm19.implementer',
      role: 'implementer',
      primaryModel: Config.getCodingModel(),
      fallbackModel,
      providerType,
    },
    reviewer: {
      agentId: 'm19.reviewer',
      role: 'reviewer',
      primaryModel: Config.getReviewerModel(),
      fallbackModel,
      providerType,
    },
    validator: {
      agentId: 'm19.validator',
      role: 'validator',
      primaryModel: Config.getReviewerModel(),
      fallbackModel,
      providerType,
    },
  });
}

export function stageFromRequestId(requestId: string): M19WorkforceStage | undefined {
  if (requestId.endsWith(':validator-repair')) return 'validator';
  for (const stage of M19_WORKFORCE_STAGES) {
    if (requestId.endsWith(`:${stage}`)) return stage;
  }
  return undefined;
}

function resolveAssignment(
  definition: M19AgentDefinition,
  requestModel: string,
  requestProviderType?: ProviderType,
): M19AgentAssignment {
  const primary = normalizeModel(definition.primaryModel);
  const fallback = normalizeModel(definition.fallbackModel);
  const requestFallback = normalizeModel(requestModel);

  if (primary) {
    return {
      contractVersion: M19_AGENT_WORKFORCE_CONTRACT_VERSION,
      stage: definition.role,
      agentId: definition.agentId,
      role: definition.role,
      model: primary,
      providerType: definition.providerType ?? requestProviderType,
      routingReason: 'role_primary',
    };
  }
  if (fallback) {
    return {
      contractVersion: M19_AGENT_WORKFORCE_CONTRACT_VERSION,
      stage: definition.role,
      agentId: definition.agentId,
      role: definition.role,
      model: fallback,
      providerType: definition.providerType ?? requestProviderType,
      routingReason: 'configured_fallback',
      fallbackFrom: definition.primaryModel,
    };
  }
  if (requestFallback) {
    return {
      contractVersion: M19_AGENT_WORKFORCE_CONTRACT_VERSION,
      stage: definition.role,
      agentId: definition.agentId,
      role: definition.role,
      model: requestFallback,
      providerType: definition.providerType ?? requestProviderType,
      routingReason: 'request_fallback',
      fallbackFrom: definition.primaryModel,
    };
  }
  throw new Error(`M19 workforce has no valid model for ${definition.role}.`);
}

function validateRoster(roster: M19AgentRoster): void {
  for (const stage of M19_WORKFORCE_STAGES) {
    const definition = roster[stage];
    if (!definition || definition.role !== stage) {
      throw new Error(`M19 workforce roster is missing role ${stage}.`);
    }
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(definition.agentId)) {
      throw new Error(`Invalid M19 workforce agent id for ${stage}.`);
    }
    if (!normalizeModel(definition.primaryModel) && !normalizeModel(definition.fallbackModel)) {
      throw new Error(`M19 workforce role ${stage} has no configured model.`);
    }
  }
}

function normalizeModel(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Invalid M19 workforce model identifier.');
  }
  return normalized;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
