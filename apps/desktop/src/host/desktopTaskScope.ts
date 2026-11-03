/** What a coding task may ASK to do. Each step still needs approval, unless Auto mode and a Core standing authorization cover it. */
export const DESKTOP_PERMITTED_ACTIONS = [
  'inspect files with read_file',
  'edit files in this repository with propose_file_change',
  'run local tests and validation in this repository',
  'inspect workspace pages with inspect_page',
  'create a local git commit in this repository',
] as const;

export interface DesktopTaskScope {
  repository: string;
  permittedActions: string[];
  deliveryDestination: string;
  pushAuthorized: boolean;
  authorized: boolean;
}

export function describeDesktopTaskScope(repository: string | null): DesktopTaskScope | null {
  if (!repository) return null;
  return {
    repository,
    permittedActions: [...DESKTOP_PERMITTED_ACTIONS],
    deliveryDestination: `local git commit in ${repository}`,
    pushAuthorized: false,
    authorized: false,
  };
}

export function authorizeDesktopTaskScope(scope: DesktopTaskScope): DesktopTaskScope {
  return { ...scope, authorized: true };
}

/**
 * The desktop host never decides an approval. Automatic approval of in-scope commands moved into Core
 * (core/domain/permissionModes.ts): it applies only in Auto mode, only under a standing authorization the user
 * granted, and only after Core re-checks the actual command, workspace and pinned package.json scripts.
 */
