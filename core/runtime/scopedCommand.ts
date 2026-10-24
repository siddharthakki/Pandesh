/**
 * Typed mission checks. Free-form shell is not a model action. Network,
 * install, outside-path, and push are rejected unless the frozen task
 * envelope explicitly authorizes them.
 */
import {
  evaluateRunCommand,
  hasParentDirectorySegment,
  isAbsolutePathToken,
  type CommandPolicyEnvelope,
} from './commandPolicy';

export type MissionEnvelope = CommandPolicyEnvelope;

export type ScopedCommandDecision = { allow: true; argv: string[] } | { allow: false; reason: string };

export function commandLeavesWorkspace(command: string): boolean {
  return isAbsolutePathToken(command) || /(?:^|[\s"'=])(?:[a-zA-Z]:\\|\\\\)/.test(command) || hasParentDirectorySegment(command);
}

export function classifyScopedCommand(command: string, envelope: MissionEnvelope): ScopedCommandDecision {
  const trimmed = command.trim();
  if (!trimmed) return { allow: false, reason: 'empty command' };
  const policy = evaluateRunCommand(trimmed, envelope);
  if (policy.decision === 'deny') return { allow: false, reason: policy.reason };
  return { allow: false, reason: 'free-form shell is not a mission action; use run_check' };
}

export function argvForCheck(
  check: 'test' | 'diff' | 'status' | 'commit',
  envelope: MissionEnvelope,
  target?: string,
): ScopedCommandDecision {
  if (target && commandLeavesWorkspace(target)) {
    return { allow: false, reason: 'check target is outside the selected repository' };
  }
  if (check === 'test') {
    return {
      allow: true,
      argv: target
        ? [process.execPath, '--test', target]
        : [process.execPath, '--test'],
    };
  }
  if (check === 'diff') return { allow: true, argv: ['git', 'diff'] };
  if (check === 'status') return { allow: true, argv: ['git', 'status', '--short'] };
  if (check === 'commit') {
    if (envelope.pushAuthorized === undefined) {
      return { allow: false, reason: 'commit envelope missing' };
    }
    return { allow: true, argv: ['git', 'commit'] };
  }
  return { allow: false, reason: 'unknown check' };
}
