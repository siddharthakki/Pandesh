import type { ForgeCallableDescriptor } from '../agent/ForgeCallableSurface';
import { RiskLevel, ToolDefinition } from './ToolTypes';
import {
  GrantedPermissionSet,
  PermissionProfileId,
  ToolPermissionCapability,
  capabilitiesForGrantedPermissions,
} from './PermissionProfiles';

export type GovernedToolId = string;
export type GovernedToolSurface = 'agent-tool' | 'forge-callable';
export type GovernedToolSideEffect = 'none' | 'metadata-only' | 'workspace-mutation' | 'process-execution' | 'task-lifecycle' | 'model-execution';

export interface GovernedToolDefinition {
  id: GovernedToolId;
  name: string;
  description: string;
  surface: GovernedToolSurface;
  inputContract: Readonly<Record<string, unknown>>;
  outputContract: Readonly<Record<string, unknown>>;
  sideEffect: GovernedToolSideEffect;
  permissionProfile: PermissionProfileId;
  requiredCapabilities: readonly ToolPermissionCapability[];
  runtime: Readonly<{
    transport: 'local' | 'in-process';
    identity: string;
    version: string;
  }>;
  approvalRequired: boolean;
  elevationRequired: boolean;
  riskLevel?: RiskLevel;
  readOnly: boolean;
}

export type ToolAuthorizationDecision =
  | { ok: true; code: 'allowed'; toolId: GovernedToolId; requiredCapabilities: readonly ToolPermissionCapability[] }
  | { ok: false; code: 'unknown_tool'; toolId: GovernedToolId }
  | { ok: false; code: 'missing_permission'; toolId: GovernedToolId; missingCapabilities: readonly ToolPermissionCapability[] }
  | { ok: false; code: 'approval_required'; toolId: GovernedToolId; requiredCapabilities: readonly ToolPermissionCapability[] }
  | { ok: false; code: 'elevation_required'; toolId: GovernedToolId; requiredCapabilities: readonly ToolPermissionCapability[] }
  | { ok: false; code: 'invalid_metadata'; toolId: GovernedToolId; reason: string };

export class GovernedToolRegistry {
  private readonly tools = new Map<GovernedToolId, GovernedToolDefinition>();

  register(definition: GovernedToolDefinition): void {
    const metadataIssue = validateDefinition(definition);
    if (metadataIssue) {
      throw new Error(metadataIssue);
    }
    if (this.tools.has(definition.id)) {
      throw new Error(`Governed tool already registered: ${definition.id}`);
    }
    this.tools.set(definition.id, cloneDefinition(definition));
  }

  resolve(id: GovernedToolId): GovernedToolDefinition | undefined {
    const found = this.tools.get(id);
    return found ? cloneDefinition(found) : undefined;
  }

  list(): readonly GovernedToolDefinition[] {
    return [...this.tools.values()]
      .map(tool => cloneDefinition(tool))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  authorize(toolId: GovernedToolId, grants: GrantedPermissionSet): ToolAuthorizationDecision {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return { ok: false, code: 'unknown_tool', toolId };
    }
    const metadataIssue = validateDefinition(tool);
    if (metadataIssue) {
      return { ok: false, code: 'invalid_metadata', toolId, reason: metadataIssue };
    }
    const granted = capabilitiesForGrantedPermissions(grants);
    const missing = tool.requiredCapabilities.filter(capability => !granted.has(capability));
    if (missing.length > 0) {
      return { ok: false, code: 'missing_permission', toolId, missingCapabilities: Object.freeze([...missing]) };
    }
    if (tool.elevationRequired && !grants.elevationGranted) {
      return { ok: false, code: 'elevation_required', toolId, requiredCapabilities: Object.freeze([...tool.requiredCapabilities]) };
    }
    if (tool.approvalRequired && !grants.approvalGranted) {
      return { ok: false, code: 'approval_required', toolId, requiredCapabilities: Object.freeze([...tool.requiredCapabilities]) };
    }
    return { ok: true, code: 'allowed', toolId, requiredCapabilities: Object.freeze([...tool.requiredCapabilities]) };
  }
}

export function governedDefinitionFromToolSchema(input: {
  schema: ToolDefinition;
  riskLevel: RiskLevel;
  mutatesWorkspace: boolean;
  requiresWorkspace: boolean;
}): GovernedToolDefinition {
  const name = input.schema.function.name;
  const processTool = name === 'run_command';
  const permissionProfile = processTool ? 'process-validation' : input.mutatesWorkspace ? 'workspace-mutate' : 'workspace-read';
  const sideEffect: GovernedToolSideEffect = processTool ? 'process-execution' : input.mutatesWorkspace ? 'workspace-mutation' : 'none';
  return {
    id: `agent.${name}`,
    name,
    description: input.schema.function.description,
    surface: 'agent-tool',
    inputContract: input.schema.function.parameters,
    outputContract: { type: 'ToolResult' },
    sideEffect,
    permissionProfile,
    requiredCapabilities: requiredCapabilitiesForProfile(permissionProfile),
    runtime: { transport: 'in-process', identity: name, version: '1' },
    approvalRequired: input.riskLevel !== 'safe' || processTool || input.mutatesWorkspace,
    elevationRequired: input.riskLevel === 'critical',
    riskLevel: input.riskLevel,
    readOnly: !input.mutatesWorkspace && !processTool,
  };
}

export function governedDefinitionFromForgeDescriptor(descriptor: ForgeCallableDescriptor): GovernedToolDefinition {
  const sideEffect = forgeSideEffect(descriptor);
  const permissionProfile = forgePermissionProfile(sideEffect);
  return {
    id: `forge.${descriptor.id}`,
    name: descriptor.id,
    description: `Forge callable ${descriptor.id}`,
    surface: 'forge-callable',
    inputContract: { type: 'ForgeCallableRequest', method: descriptor.id },
    outputContract: { type: 'ForgeCallableResponse', method: descriptor.id },
    sideEffect,
    permissionProfile,
    requiredCapabilities: requiredCapabilitiesForProfile(permissionProfile),
    runtime: {
      transport: descriptor.transport,
      identity: descriptor.id,
      version: String(descriptor.version),
    },
    approvalRequired: sideEffect === 'model-execution' || sideEffect === 'task-lifecycle',
    elevationRequired: false,
    readOnly: descriptor.readOnly,
  };
}

function requiredCapabilitiesForProfile(profileId: PermissionProfileId): readonly ToolPermissionCapability[] {
  switch (profileId) {
    case 'workspace-read': return Object.freeze(['workspace.read']);
    case 'workspace-mutate': return Object.freeze(['workspace.read', 'workspace.write']);
    case 'process-validation': return Object.freeze(['workspace.read', 'process.execute']);
    case 'model-provider-access': return Object.freeze(['network.model']);
    case 'task-lifecycle-control': return Object.freeze(['task.lifecycle']);
    case 'metadata-state': return Object.freeze(['metadata.write']);
    case 'sensitive-elevated': return Object.freeze(['sensitive.elevated']);
  }
}

function forgePermissionProfile(sideEffect: GovernedToolSideEffect): PermissionProfileId {
  switch (sideEffect) {
    case 'none': return 'workspace-read';
    case 'metadata-only': return 'metadata-state';
    case 'model-execution': return 'model-provider-access';
    case 'task-lifecycle': return 'task-lifecycle-control';
    case 'workspace-mutation': return 'workspace-mutate';
    case 'process-execution': return 'process-validation';
  }
}

function forgeSideEffect(descriptor: ForgeCallableDescriptor): GovernedToolSideEffect {
  switch (descriptor.sideEffects) {
    case undefined:
    case 'none': return 'none';
    case 'metadata-only': return 'metadata-only';
    case 'task-lifecycle': return 'task-lifecycle';
    case 'model-execution': return 'model-execution';
  }
}

function validateDefinition(definition: GovernedToolDefinition): string | undefined {
  if (!definition.id.trim()) {
    return 'Governed tool id is required.';
  }
  if (definition.requiredCapabilities.length === 0) {
    return `Governed tool ${definition.id} has no required capabilities.`;
  }
  if (definition.sideEffect === 'workspace-mutation' && !definition.requiredCapabilities.includes('workspace.write')) {
    return `Governed tool ${definition.id} mutates workspace without workspace.write.`;
  }
  if (definition.sideEffect === 'model-execution' && !definition.requiredCapabilities.includes('network.model')) {
    return `Governed tool ${definition.id} executes a model without network.model.`;
  }
  return undefined;
}

function cloneDefinition(definition: GovernedToolDefinition): GovernedToolDefinition {
  return Object.freeze({
    ...definition,
    inputContract: Object.freeze({ ...definition.inputContract }),
    outputContract: Object.freeze({ ...definition.outputContract }),
    requiredCapabilities: Object.freeze([...definition.requiredCapabilities]),
    runtime: Object.freeze({ ...definition.runtime }),
  });
}
