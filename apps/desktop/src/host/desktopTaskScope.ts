import type { DesktopApprovalCard } from '../ipc';

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

export type DesktopScopeDecision = 'auto_approve' | 'prompt';

const OUT_OF_SCOPE_COMMAND = /\b(git\s+push|git\s+remote|git\s+fetch|git\s+pull|git\s+clone|npm\s+publish|curl\b|wget\b|invoke-webrequest|start\s+https?:|msiexec|bitsadmin|certutil|powershell\s+-enc)\b/i;
const VALIDATION_COMMAND = /^(npm(\.cmd)?\s+(test|run\s+(test|lint|typecheck|compile|build)(\S*)?)|node(\.exe)?\s+--test(\s|$))/i;
const DIR_COMMAND = /^dir(\s|$)/i;
const GIT_INSPECT_OR_COMMIT = /^git(\.exe)?\s+(status|diff|log|show|add|commit)\b/i;

export function commandLeavesWorkspace(part: string): boolean {
  return /(?:^|[\s"'=])(?:[a-zA-Z]:\\|\\\\)/.test(part) || /(^|[\\/])\.\.([\\/]|$)/.test(part);
}

export function classifyDesktopCommand(command: string): DesktopScopeDecision {
  const parts = command
    .split(/\s*(?:&&|\|\||\||&)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'prompt';
  for (const part of parts) {
    if (OUT_OF_SCOPE_COMMAND.test(part)) return 'prompt';
    if (commandLeavesWorkspace(part)) return 'prompt';
    if (DIR_COMMAND.test(part) || VALIDATION_COMMAND.test(part) || GIT_INSPECT_OR_COMMIT.test(part)) continue;
    return 'prompt';
  }
  return 'auto_approve';
}

export function classifyDesktopApproval(
  scope: DesktopTaskScope | null | undefined,
  card: Pick<DesktopApprovalCard, 'toolName' | 'paths' | 'detail' | 'scope'>,
): DesktopScopeDecision {
  if (!scope?.authorized) return 'prompt';
  if (card.toolName === 'authorize_mission' || card.toolName === 'propose_file_change') {
    return 'prompt';
  }
  if (card.toolName === 'inspect_page') {
    const pagePath = card.paths[0] ?? '';
    return pagePath && !commandLeavesWorkspace(pagePath) ? 'auto_approve' : 'prompt';
  }
  if (card.toolName === 'run_command') {
    const command = extractCommand(card);
    return command ? classifyDesktopCommand(command) : 'prompt';
  }
  return 'prompt';
}

function extractCommand(card: Pick<DesktopApprovalCard, 'detail' | 'scope'>): string {
  const scoped = card.scope.replace(/^run_command\s+/i, '').trim();
  if (scoped) return scoped;
  return card.detail.trim();
}
