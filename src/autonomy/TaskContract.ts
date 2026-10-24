import * as path from 'path';
import { TaskBudgets } from '../agent/AgentEngineTypes';

export type ContractStatus = 'proposed' | 'approved' | 'revoked';
export type ContractApprovalPolicy = 'supervised' | 'in-contract-autonomous';
export type ContractCheckpointPolicy = 'required' | 'enabled';

export interface TaskContract {
  schemaVersion: 1;
  contractId: string;
  taskId: string;
  goal: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  allowedCommands: string[];
  allowSafeCommands: boolean;
  /** Explicit standing approval for non-denied commands in trusted local mode. */
  allowTrustedCommands: boolean;
  budgets: TaskBudgets;
  approvalPolicy: ContractApprovalPolicy;
  checkpointPolicy: ContractCheckpointPolicy;
  status: ContractStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: 'user' | 'trusted-setting' | 'api';
  revokedAt?: string;
  revision: number;
}

export interface TaskContractInput {
  goal: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  allowedCommands?: string[];
  allowSafeCommands?: boolean;
  allowTrustedCommands?: boolean;
  budgets: TaskBudgets;
  approvalPolicy?: ContractApprovalPolicy;
  checkpointPolicy?: ContractCheckpointPolicy;
}

export interface ContractAction {
  toolName: string;
  paths: string[];
  command?: string;
  mutatesWorkspace: boolean;
}

export interface ContractDecision {
  inContract: boolean;
  reason: string;
}

function normalizeRelative(candidate: string): string {
  return candidate
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function containsTraversal(candidate: string): boolean {
  return normalizeRelative(candidate).split('/').some(segment => segment === '..');
}

function matchPath(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizeRelative(pattern);
  const normalizedCandidate = normalizeRelative(candidate);
  if (!normalizedPattern || containsTraversal(normalizedCandidate)) { return false; }
  if (normalizedPattern === '**' || normalizedPattern === '**/*') { return true; }
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, '');
    return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2).replace(/\/$/, '');
    if (!normalizedCandidate.startsWith(`${prefix}/`)) { return false; }
    return !normalizedCandidate.slice(prefix.length + 1).includes('/');
  }
  return normalizedCandidate === normalizedPattern;
}

const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^git\s+(status|diff|log|show|branch)\b/i,
  /^npm\s+run\s+(build|test|lint|validate|compile|typecheck)\b/i,
  /^npm\s+test(?:\s|$)/i,
  /^pnpm\s+(test|lint|build|run\s+(test|lint|build|validate|compile|typecheck))\b/i,
  /^yarn\s+(test|lint|build)\b/i,
  /^npx\s+(tsc|vitest|eslint|prettier)\b/i,
  /^tsc(?:\s|$)/i,
  /^vitest(?:\s|$)/i,
  /^pytest(?:\s|$)/i,
  /^python3?\s+-m\s+(pytest|unittest)\b/i,
  /^cargo\s+(check|test|fmt|clippy)\b/i,
  /^go\s+test\b/i,
  /^dotnet\s+(build|test|format)\b/i,
];

export function isSafeContractCommand(command: string): boolean {
  const trimmed = command.trim();
  return SAFE_COMMAND_PATTERNS.some(pattern => pattern.test(trimmed));
}

export class ContractEnforcer {
  evaluate(contract: TaskContract, action: ContractAction): ContractDecision {
    if (contract.status !== 'approved') {
      return { inContract: false, reason: `Task contract is ${contract.status}, not approved.` };
    }

    if (contract.approvalPolicy !== 'in-contract-autonomous') {
      return { inContract: false, reason: 'Task contract requires supervised approval.' };
    }

    if (action.toolName === 'run_command') {
      const command = action.command?.trim() ?? '';
      if (!command) {
        return { inContract: false, reason: 'Command is empty or missing.' };
      }
      if (contract.allowedCommands.some(allowed => allowed.trim() === command)) {
        return { inContract: true, reason: 'Command exactly matches the approved task contract.' };
      }
      if (contract.allowSafeCommands && isSafeContractCommand(command)) {
        return { inContract: true, reason: 'Command matches the task contract safe-validation command policy.' };
      }
      if (contract.allowTrustedCommands) {
        return {
          inContract: true,
          reason: 'Command is covered by the explicit full-access trusted task contract.',
        };
      }
      return { inContract: false, reason: 'Command is outside the approved task contract.' };
    }

    if (!action.mutatesWorkspace) {
      return { inContract: true, reason: 'Read-only action is within the approved task contract.' };
    }

    if (action.paths.length === 0) {
      return {
        inContract: false,
        reason: 'Mutation target could not be proven to be inside the approved path scope.',
      };
    }

    const outside = action.paths.filter(candidate => {
      if (path.isAbsolute(candidate) || containsTraversal(candidate)) { return true; }
      return !contract.allowedPaths.some(pattern => matchPath(pattern, candidate));
    });
    if (outside.length > 0) {
      return {
        inContract: false,
        reason: `Mutation is outside the approved path scope: ${outside.join(', ')}`,
      };
    }

    return { inContract: true, reason: 'All mutation targets are within the approved task contract.' };
  }
}
