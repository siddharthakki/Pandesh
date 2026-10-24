export type ToolPermissionCapability =
  | 'workspace.read'
  | 'workspace.write'
  | 'process.execute'
  | 'network.model'
  | 'task.lifecycle'
  | 'metadata.write'
  | 'sensitive.elevated';

export type PermissionProfileId =
  | 'workspace-read'
  | 'workspace-mutate'
  | 'process-validation'
  | 'model-provider-access'
  | 'task-lifecycle-control'
  | 'metadata-state'
  | 'sensitive-elevated';

export interface PermissionProfile {
  id: PermissionProfileId;
  description: string;
  capabilities: readonly ToolPermissionCapability[];
}

export type GrantedPermissionSet = Readonly<{
  profiles: readonly PermissionProfileId[];
  capabilities?: readonly ToolPermissionCapability[];
  approvalGranted?: boolean;
  elevationGranted?: boolean;
}>;

function profile(
  id: PermissionProfileId,
  description: string,
  capabilities: readonly ToolPermissionCapability[],
): Readonly<PermissionProfile> {
  return Object.freeze({ id, description, capabilities: Object.freeze([...capabilities]) });
}

export const PERMISSION_PROFILES = Object.freeze({
  workspaceRead: profile('workspace-read', 'Read-only workspace inspection.', ['workspace.read']),
  workspaceMutate: profile('workspace-mutate', 'Bounded workspace mutation.', ['workspace.read', 'workspace.write']),
  processValidation: profile('process-validation', 'Run bounded local validation processes.', ['workspace.read', 'process.execute']),
  modelProviderAccess: profile('model-provider-access', 'Call configured model/provider endpoints.', ['network.model']),
  taskLifecycleControl: profile('task-lifecycle-control', 'Control governed task lifecycle state.', ['task.lifecycle']),
  metadataState: profile('metadata-state', 'Write governed scheduler or reservation metadata.', ['metadata.write']),
  sensitiveElevated: profile('sensitive-elevated', 'Operate on elevated or sensitive governed surfaces.', ['sensitive.elevated']),
} as const);

const PROFILE_BY_ID = new Map<PermissionProfileId, Readonly<PermissionProfile>>(
  Object.values(PERMISSION_PROFILES).map(value => [value.id, value]),
);

export function listPermissionProfiles(): readonly Readonly<PermissionProfile>[] {
  return [...PROFILE_BY_ID.values()]
    .map(profileValue => cloneProfile(profileValue))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function resolvePermissionProfile(id: PermissionProfileId): Readonly<PermissionProfile> {
  const found = PROFILE_BY_ID.get(id);
  if (!found) {
    throw new Error(`Unknown permission profile: ${id}`);
  }
  return cloneProfile(found);
}

export function capabilitiesForGrantedPermissions(grants: GrantedPermissionSet): ReadonlySet<ToolPermissionCapability> {
  const capabilities = new Set<ToolPermissionCapability>(grants.capabilities ?? []);
  for (const profileId of grants.profiles) {
    const found = PROFILE_BY_ID.get(profileId);
    if (!found) {
      continue;
    }
    for (const capability of found.capabilities) {
      capabilities.add(capability);
    }
  }
  return capabilities;
}

function cloneProfile(value: Readonly<PermissionProfile>): Readonly<PermissionProfile> {
  return Object.freeze({
    id: value.id,
    description: value.description,
    capabilities: Object.freeze([...value.capabilities]),
  });
}
