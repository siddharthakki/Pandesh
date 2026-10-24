import { spawnSync } from 'node:child_process';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { hardenedGitArgs, hardenedGitEnv } from '../security/hardenedGit';
import type { ModelToolCall } from './modelBackend';
import { decodeMissionTurn, type MissionAction } from './missionActions';
import {
  completionRefusal,
  formatObservation,
  readWorkspaceRange,
  type MissionCheckEvidence,
  type MissionEvidence,
  type MissionObservation,
} from './missionObservations';
import type { MissionLedgerEntry } from './missionCompaction';
import { resolveRepeatedRead, resolveRepeatedSearch } from './missionProgress';
import { searchWorkspace } from './missionSearch';
import { argvForCheck, classifyScopedCommand, type MissionEnvelope } from './scopedCommand';
import { listStagedPaths, reviewDigestFor, reviewWorkspaceDiff } from './missionDiffReview';
import {
  buildDeliveryManifest,
  findUnsafeDeliveryPaths,
  manifestsMatch,
} from './missionDeliveryManifest';
import { recoverRepositoryPath } from './repositoryPathRecovery';
import { verificationIsRequired } from './missionVerification';

export const AUTONOMOUS_MISSION_PROFILE = 'autonomous-mission';
/** @deprecated Lifetime 16-turn accounting is replaced by phase budgets. Kept as a compatibility export. */
export const MAX_MISSION_TURNS = 16;
export const MISSION_SYSTEM_PROMPT =
  'You are KarkeDikha running a Core-owned autonomous mission. Emit exactly one tool action per turn: search, read_file, propose_file_change, propose_text_edit, run_check, finish, or ask_user. Do not use shell commands. A prose-only reply never completes the task. Host verification plans are host-owned; do not search or read them. Core executes those checks after your approved mutation. If a turn is rejected for multiple calls, resend exactly one selected action. Do not repeat an unchanged search or read; use existing evidence, read a new relevant file, or propose a change. Prefer propose_text_edit for a small change to an existing file: give the exact find text that occurs exactly once in the file and its exact replace text; Core reads the file, verifies the anchor, and computes the full resulting content and diff itself — never send full file content for a small change. Use propose_file_change only for a new file or a genuinely complete rewrite. Required evidence before finish: approved mutation, passing focused validation, passing behavioral verification when a workspace verification plan exists, passing diff review, local commit SHA, and explicit local-commit delivery.';

export function isAutonomousMission(profile: string | undefined): boolean {
  return profile === AUTONOMOUS_MISSION_PROFILE;
}

export function selectMissionCalls(calls: ModelToolCall[]): ReturnType<typeof decodeMissionTurn> {
  return decodeMissionTurn(calls);
}

export function executeMissionAction(input: {
  action: MissionAction;
  envelope: MissionEnvelope;
  evidence: MissionEvidence;
  ledger?: readonly MissionLedgerEntry[];
}): { observation: MissionObservation; evidence: MissionEvidence; complete?: boolean; askUser?: string } {
  const { action, envelope } = input;
  let evidence = { ...input.evidence };

  if (action.action === 'search') {
    const repeated = resolveRepeatedSearch(action, input.ledger ?? []);
    if (repeated) return { observation: repeated, evidence };
    return { observation: searchWorkspace({ workspaceRoot: envelope.workspaceRoot, query: action.query, scopePath: action.path }), evidence };
  }
  if (action.action === 'read_file') {
    const repeated = resolveRepeatedRead(action, input.ledger ?? []);
    if (repeated) return { observation: repeated, evidence };
    return {
      observation: readWorkspaceRange({
        workspaceRoot: envelope.workspaceRoot,
        requestedPath: action.path,
        startLine: action.startLine,
        endLine: action.endLine,
      }),
      evidence,
    };
  }
  if (action.action === 'ask_user') {
    evidence = { ...evidence, deliveryStatus: 'needs_clarification' };
    return {
      observation: {
        action: 'ask_user',
        resultCount: 1,
        truncated: false,
        ok: true,
        output: action.question,
      },
      evidence,
      askUser: action.question,
    };
  }
  if (action.action === 'finish') {
    if (verificationIsRequired(envelope.workspaceRoot)) {
      evidence = { ...evidence, verificationRequired: true };
    }
    const refused = completionRefusal(evidence);
    if (refused) {
      return {
        observation: { action: 'finish', resultCount: 0, truncated: false, ok: false, output: refused },
        evidence,
      };
    }
    return {
      observation: { action: 'finish', resultCount: 1, truncated: false, ok: true, output: action.summary },
      evidence,
      complete: true,
    };
  }
  if (action.action === 'run_check') {
    return runTypedCheck(action.check, envelope, evidence, action.target);
  }
  return {
    observation: {
      action: action.action,
      path: action.path,
      resultCount: 1,
      truncated: false,
      ok: true,
      output: action.action === 'propose_text_edit'
        ? 'anchored edit submitted to Core mutation gate'
        : 'proposal submitted to Core mutation gate',
    },
    evidence,
  };
}

/** The paths Core approved this mission, in canonical manifest order. */
export function authorizedManifest(evidence: MissionEvidence): string[] {
  const candidates = evidence.approvedPaths && evidence.approvedPaths.length > 0
    ? evidence.approvedPaths
    : evidence.approvedPath
      ? [evidence.approvedPath]
      : [];
  return buildDeliveryManifest(candidates);
}

/**
 * Stages exactly the reviewed manifest and nothing else.
 *
 * Fails closed when review is missing, when the reviewed files changed since
 * review, when an unsafe artifact appears, or when the resulting index does
 * not match the manifest exactly.
 */
export function stageAuthorizedManifest(
  workspaceRoot: string,
  evidence: MissionEvidence,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; reason: string } {
  const manifest = authorizedManifest(evidence);
  if (manifest.length === 0) {
    return { ok: false, reason: 'commit refused: no authorized changed-file manifest' };
  }
  const unsafe = findUnsafeDeliveryPaths(manifest);
  if (unsafe.length > 0) {
    return {
      ok: false,
      reason: `commit refused: unsafe artifact in delivery manifest: ${unsafe.map((item) => `${item.path} (${item.reason})`).join(', ')}`,
    };
  }
  if (!evidence.reviewDigest) {
    return { ok: false, reason: 'commit refused: delivery manifest was not diff reviewed' };
  }
  if (reviewDigestFor(workspaceRoot, manifest) !== evidence.reviewDigest) {
    return { ok: false, reason: 'commit refused: reviewed files changed after diff review' };
  }

  const run = (argv: string[]) => spawnSync('git', hardenedGitArgs(argv), { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true, env });
  const preStaged = listStagedPaths(workspaceRoot);
  const preStagedUnsafe = findUnsafeDeliveryPaths(preStaged);
  if (preStagedUnsafe.length > 0) {
    return {
      ok: false,
      reason: `commit refused: unsafe artifact staged: ${preStagedUnsafe.map((item) => `${item.path} (${item.reason})`).join(', ')}`,
    };
  }
  const strays = preStaged.filter((item) => !manifest.includes(item));
  if (strays.length > 0) {
    const reset = run(['reset', '--quiet', 'HEAD', '--', ...strays]);
    if (reset.status !== 0 && reset.status !== 1) {
      return { ok: false, reason: `commit refused: could not unstage paths outside the manifest: ${strays.join(', ')}` };
    }
  }
  const added = run(['add', '--', ...manifest]);
  if (added.status !== 0) {
    return { ok: false, reason: `commit refused: staging the manifest failed: ${(added.stderr || added.stdout || '').trim()}` };
  }
  const staged = listStagedPaths(workspaceRoot);
  const stagedUnsafe = findUnsafeDeliveryPaths(staged);
  if (stagedUnsafe.length > 0) {
    return {
      ok: false,
      reason: `commit refused: unsafe artifact staged: ${stagedUnsafe.map((item) => `${item.path} (${item.reason})`).join(', ')}`,
    };
  }
  if (!manifestsMatch(staged, manifest)) {
    return {
      ok: false,
      reason: `commit refused: staged paths differ from the reviewed manifest (staged ${staged.join(', ') || 'nothing'}; reviewed ${manifest.join(', ')})`,
    };
  }
  return { ok: true };
}

/** The structured identity of a typed check, independent of its output. */
export function missionCheckKind(check: 'test' | 'diff' | 'status' | 'commit'): MissionCheckEvidence['kind'] {
  if (check === 'test') return 'validation';
  if (check === 'diff') return 'diff_review';
  if (check === 'commit') return 'commit';
  return 'status';
}

function runTypedCheck(
  check: 'test' | 'diff' | 'status' | 'commit',
  envelope: MissionEnvelope,
  evidence: MissionEvidence,
  target?: string,
): { observation: MissionObservation; evidence: MissionEvidence; complete?: boolean } {
  const kind = missionCheckKind(check);
  const scoped = argvForCheck(check, envelope, target);
  if (!scoped.allow) {
    return {
      observation: {
        action: 'run_check',
        resultCount: 0,
        truncated: false,
        ok: false,
        output: scoped.reason,
        check: { kind, status: 'refused' },
      },
      evidence,
    };
  }
  if (target) {
    const recovery = recoverRepositoryPath({ workspaceRoot: envelope.workspaceRoot, requestedPath: target, target: 'read' });
    if (!recovery.resolvedPath || (recovery.status !== 'resolved' && recovery.status !== 'corrected')) {
      return {
        observation: {
          action: 'run_check',
          path: target,
          resultCount: 0,
          truncated: false,
          ok: false,
          output: `check target blocked: ${recovery.reason}`,
          check: { kind, status: 'blocked' },
        },
        evidence,
      };
    }
  }
  if (check === 'diff') {
    const review = reviewWorkspaceDiff(envelope.workspaceRoot, authorizedManifest(evidence));
    evidence = { ...evidence, diffReview: review.verdict, reviewDigest: review.reviewDigest };
    return {
      observation: {
        action: 'run_check',
        resultCount: review.changedPaths.length,
        truncated: false,
        ok: review.verdict === 'pass',
        output: review.summary,
        check: {
          kind: 'diff_review',
          status: review.verdict === 'pass' ? 'passed' : 'rejected',
          // Only a passing review establishes a deliverable manifest; a
          // rejection reports what it looked at, not what may be committed.
          ...(review.verdict === 'pass'
            ? { reviewedPaths: review.changedPaths, reviewDigest: review.reviewDigest }
            : {}),
        },
      },
      evidence,
    };
  }
  if (check === 'commit') {
    if (verificationIsRequired(envelope.workspaceRoot)) {
      evidence = { ...evidence, verificationRequired: true };
    }
    if (!evidence.validationPassed || evidence.diffReview !== 'pass' || !evidence.approvedMutation || (evidence.verificationRequired && !evidence.verificationPassed)) {
      return {
        observation: {
          action: 'run_check',
          resultCount: 0,
          truncated: false,
          ok: false,
          output: completionRefusal({ ...evidence, commitSha: undefined, deliveryStatus: undefined }) ?? 'commit refused',
          check: { kind: 'commit', status: 'refused' },
        },
        evidence,
      };
    }
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'karkedikha-mission',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'mission@karkedikha.local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'karkedikha-mission',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'mission@karkedikha.local',
    };
    const staging = stageAuthorizedManifest(envelope.workspaceRoot, evidence, gitEnv);
    if (!staging.ok) {
      return {
        observation: {
          action: 'run_check',
          resultCount: 0,
          truncated: false,
          ok: false,
          output: staging.reason,
          check: { kind: 'commit', status: 'blocked' },
        },
        evidence: { ...evidence, diffReview: 'reject', deliveryStatus: 'blocked' },
      };
    }
    const committed = spawnSync('git', hardenedGitArgs(['-c', 'user.name=karkedikha-mission', '-c', 'user.email=mission@karkedikha.local', 'commit', '-m', 'mission: apply approved change']), {
      cwd: envelope.workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: gitEnv,
    });
    if (committed.status !== 0) {
      return {
        observation: {
          action: 'run_check',
          resultCount: 0,
          truncated: false,
          ok: false,
          output: committed.stderr || committed.stdout || 'git commit failed',
          check: { kind: 'commit', status: 'failed', exitCode: committed.status },
        },
        evidence,
      };
    }
    const sha = spawnSync('git', hardenedGitArgs(['rev-parse', 'HEAD']), { cwd: envelope.workspaceRoot, encoding: 'utf8', windowsHide: true, env: gitEnv });
    const commitSha = (sha.stdout || '').trim();
    evidence = { ...evidence, commitSha, deliveryStatus: 'local_commit' };
    return {
      observation: {
        action: 'run_check',
        resultCount: 1,
        truncated: false,
        ok: true,
        output: `committed ${commitSha}`,
        check: {
          kind: 'commit',
          status: 'passed',
          commitSha,
          reviewedPaths: authorizedManifest(evidence),
          reviewDigest: evidence.reviewDigest,
        },
      },
      evidence,
      complete: true,
    };
  }
  const argv = scoped.argv;
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: envelope.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const ok = result.status === 0;
  if (check === 'test') {
    evidence = {
      ...evidence,
      validationPassed: ok,
      validationCommand: argv.join(' '),
      validationExitCode: result.status,
    };
  }
  return {
    observation: {
      action: 'run_check',
      path: target,
      resultCount: ok ? 1 : 0,
      truncated: output.length > 4000,
      ok,
      output: output.slice(0, 4000) || `exit ${result.status}`,
      check: {
        kind,
        status: ok ? 'passed' : 'failed',
        command: argv.join(' '),
        exitCode: result.status,
      },
    },
    evidence,
  };
}

export function rejectFreeFormCommand(command: string, envelope: MissionEnvelope): MissionObservation {
  const decision = classifyScopedCommand(command, envelope);
  return {
    action: 'run_command',
    resultCount: 0,
    truncated: false,
    ok: false,
    output: decision.allow ? 'unexpected allow' : decision.reason,
  };
}

export function observationMessage(observation: MissionObservation): string {
  return formatObservation(observation);
}
