import {
  GrantedPermissionSet,
  PermissionProfileId,
  ToolPermissionCapability,
  capabilitiesForGrantedPermissions,
  listPermissionProfiles,
  resolvePermissionProfile,
} from './PermissionProfiles';
import { ToolAuthorizationDecision } from './GovernedToolRegistry';

export type PermissionContextProvenance = 'default' | 'webview-selection' | 'command-selection' | 'run-bound';

export interface SerializablePermissionContext {
  contextId: string;
  profileId: PermissionProfileId;
  capabilities: readonly ToolPermissionCapability[];
  approvalGranted: boolean;
  elevationGranted: boolean;
  provenance: PermissionContextProvenance;
  createdAt: string;
  runId?: string;
  toolId?: string;
}

export type PermissionContextValidation =
  | { ok: true; context: SerializablePermissionContext }
  | { ok: false; code: 'invalid_permission_context' | 'stale_permission_context'; message: string };

export type PermissionDenialCode =
  | 'unknown_tool'
  | 'missing_permission'
  | 'approval_required'
  | 'elevation_required'
  | 'invalid_permission_context'
  | 'stale_permission_context';

export interface PermissionDenial {
  code: PermissionDenialCode;
  message: string;
  toolId?: string;
  missingCapabilities?: readonly ToolPermissionCapability[];
  profileId?: PermissionProfileId;
}

export function createDefaultPermissionContext(): SerializablePermissionContext {
  return createPermissionContext('workspace-read', 'default');
}

export function createPermissionContext(
  profileId: PermissionProfileId,
  provenance: PermissionContextProvenance,
  options: { approvalGranted?: boolean; elevationGranted?: boolean; runId?: string; toolId?: string } = {},
): SerializablePermissionContext {
  const profile = resolvePermissionProfile(profileId);
  const grants: GrantedPermissionSet = {
    profiles: [profile.id],
    approvalGranted: options.approvalGranted === true,
    elevationGranted: options.elevationGranted === true,
  };
  return Object.freeze({
    contextId: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    profileId: profile.id,
    capabilities: Object.freeze([...capabilitiesForGrantedPermissions(grants)].sort()),
    approvalGranted: grants.approvalGranted === true,
    elevationGranted: grants.elevationGranted === true,
    provenance,
    createdAt: new Date().toISOString(),
    runId: options.runId,
    toolId: options.toolId,
  });
}

export function rebindPermissionContext(
  context: SerializablePermissionContext,
  runId: string,
): SerializablePermissionContext {
  return createPermissionContext(context.profileId, 'run-bound', {
    approvalGranted: context.approvalGranted,
    elevationGranted: context.elevationGranted,
    runId,
    toolId: context.toolId,
  });
}

export function serializeProfilesForWebview() {
  return listPermissionProfiles().map(profile => ({
    id: profile.id,
    description: profile.description,
    capabilities: [...profile.capabilities],
  }));
}

export function isPermissionProfileId(value: unknown): value is PermissionProfileId {
  return typeof value === 'string' && listPermissionProfiles().some(profile => profile.id === value);
}

export function validatePermissionSelectionPayload(payload: unknown): PermissionProfileId | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const profileId = (payload as { profileId?: unknown }).profileId;
  return isPermissionProfileId(profileId) ? profileId : undefined;
}

export class StalePermissionContextError extends Error {
  constructor(message = 'Permissions changed since this run started. Send the request again to continue with the current permissions.') {
    super(message);
    this.name = 'StalePermissionContextError';
  }
}

export function validateBoundPermissionContext(
  context: SerializablePermissionContext | undefined,
  runId: string,
  toolId?: string,
): PermissionContextValidation {
  if (!context) {
    return { ok: false, code: 'invalid_permission_context', message: 'No permission context was bound to this run.' };
  }
  if (context.runId !== runId) {
    return { ok: false, code: 'stale_permission_context', message: 'Permission context is stale for this run.' };
  }
  if (toolId !== undefined && context.toolId === undefined) {
    return { ok: false, code: 'invalid_permission_context', message: 'Permission context is not bound to this tool.' };
  }
  if (toolId !== undefined && context.toolId !== toolId) {
    return { ok: false, code: 'stale_permission_context', message: 'Permission context is stale for this tool.' };
  }
  const canonical = resolvePermissionProfile(context.profileId);
  const canonicalCapabilities = [...canonical.capabilities].sort();
  if (
    context.capabilities.length !== canonicalCapabilities.length ||
    context.capabilities.some((capability, index) => capability !== canonicalCapabilities[index])
  ) {
    return { ok: false, code: 'invalid_permission_context', message: 'Permission context capabilities do not match the selected profile.' };
  }
  return { ok: true, context };
}

export function grantsFromPermissionContext(context: SerializablePermissionContext): GrantedPermissionSet {
  return {
    profiles: [context.profileId],
    approvalGranted: context.approvalGranted,
    elevationGranted: context.elevationGranted,
  };
}

export function denialFromAuthorization(
  decision: ToolAuthorizationDecision,
  profileId?: PermissionProfileId,
): PermissionDenial | undefined {
  if (decision.ok) {
    return undefined;
  }
  switch (decision.code) {
    case 'unknown_tool':
      return { code: 'unknown_tool', toolId: decision.toolId, profileId, message: `Unknown governed tool: ${decision.toolId}` };
    case 'missing_permission':
      return {
        code: 'missing_permission',
        toolId: decision.toolId,
        profileId,
        missingCapabilities: decision.missingCapabilities,
        message: `Missing permission: ${decision.missingCapabilities.join(', ')}`,
      };
    case 'approval_required':
      return { code: 'approval_required', toolId: decision.toolId, profileId, message: 'Explicit approval is required before this tool can run.' };
    case 'elevation_required':
      return { code: 'elevation_required', toolId: decision.toolId, profileId, message: 'Elevated confirmation is required before this tool can run.' };
    case 'invalid_metadata':
      return { code: 'invalid_permission_context', toolId: decision.toolId, profileId, message: 'Registered tool metadata is invalid.' };
  }
}

export function formatPermissionDenial(denial: PermissionDenial): string {
  return [
    `Authorization denied (${denial.code}).`,
    denial.toolId ? `Tool: ${denial.toolId}.` : undefined,
    denial.profileId ? `Profile: ${denial.profileId}.` : undefined,
    denial.message,
  ].filter(Boolean).join(' ');
}
