import * as path from 'path';
import { classifyTaskRequirements, TaskRequirementHints, TaskRequirements } from '../models/TaskModelSelection';

export type ExecutionTier = 'trivial' | 'small' | 'normal' | 'complex';

export interface ExecutionEscalation {
  fromTier?: ExecutionTier;
  reason?: string;
}

export interface ExecutionProfile {
  tier: ExecutionTier;
  /** 0 = deterministic host path, 1 = lightweight proposal call, 5 = full graph. */
  maxStages: 0 | 1 | 5;
  useDeterministicProposal: boolean;
  requirements: TaskRequirements;
  escalation: ExecutionEscalation;
  classificationReason: string;
  deterministicExtraction: {
    status: 'available' | 'unavailable';
    reason: string;
  };
}

export interface DeterministicFileWrite {
  path: string;
  content: string;
}

export interface DeterministicFileWriteAnalysis {
  write?: DeterministicFileWrite;
  reason:
    | 'accepted'
    | 'empty_goal'
    | 'goal_too_large'
    | 'unsupported_intent'
    | 'missing_path'
    | 'unsafe_path'
    | 'missing_literal_content'
    | 'ambiguous_content'
    | 'multiple_files'
    | 'multiple_instructions'
    | 'unsupported_steering';
}

const REPO_WIDE_SIGNAL = /\b(architecture|cross[- ]cutting|multi[- ]file|system[- ]wide|migration|redesign|race condition)\b/i;
const MUTATING_COMPLEXITY_AFTER_CONTENT = /\b(?:and|then|also)\s+(?:add|change|create|delete|edit|fix|implement|modify|move|patch|refactor|remove|rename|replace|update|write)\b/i;
const FILE_INTENT = /^(?:please\s+)?(?:create|add|make)\s+(?:(?:a\s+)?(?:new\s+)?file\s+)?(?:(?:called|named)\s+)?(?<path>`[^`\r\n]+`|"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;:\r\n]+)\s+(?<tail>[\s\S]+)$/i;
const CONTENT_FORMS = [
  /^(?:containing)\s+(?<content>[\s\S]*)$/i,
  /^(?:with)\s+(?:(?:the\s+)?(?:exact|literal)\s+)?(?:content\s+)?(?<content>[\s\S]*)$/i,
  /^(?:and\s+)?write\s+(?:(?:only|exactly|the\s+exact\s+content)\s+)?(?<content>[\s\S]*?)(?:\s+(?:in|into|to)\s+(?:it|the\s+file|that\s+file))?$/i,
] as const;
// A goal line beyond the literal content that itself opens with a directive
// verb is a second instruction (e.g. "Add an automated test ..." on its own
// line), not more file content. The greedy content capture in CONTENT_FORMS
// has no other way to see this: unlike MUTATING_COMPLEXITY_AFTER_CONTENT,
// which only catches a conjunction glued onto the same clause, a task
// objective written as separate imperative sentences carries no conjunction
// at all.
const DIRECTIVE_CONTINUATION_LINE = /^(?:please\s+)?(?:add|change|check|create|delete|do\s+not|don't|edit|ensure|fix|implement|modify|move|patch|refactor|remove|rename|replace|run|test|update|verify|write)\b/i;
const STEERING_HEADER = /\r?\n\r?\nSteering guidance from the user:\r?\n/i;
const STEERING_LINE = /^\[(?:\d+|\?)\]\s*(.+)$/;
const REPLACEMENT_STEERING = /^(?:please\s+)?use\s+(`[^`]+`|"[^"]+"|'[^']+'|[^\s,;:]+)\s+instead[.!]?$/i;

/**
 * Bounded deterministic intent analysis. It recognizes a grammatical shape,
 * validates one relative target path, requires explicitly supplied literal
 * content, and rejects extra work rather than guessing.
 */
export function analyzeDeterministicFileWrite(goal: string): DeterministicFileWriteAnalysis {
  const trimmed = goal.trim();
  if (!trimmed) return { reason: 'empty_goal' };
  if (Buffer.byteLength(trimmed, 'utf8') > 16_384) return { reason: 'goal_too_large' };

  const [base, steeringBlock, ...extraBlocks] = trimmed.split(STEERING_HEADER);
  if (extraBlocks.length > 0) return { reason: 'unsupported_steering' };
  const intent = FILE_INTENT.exec(base.trim());
  if (!intent?.groups) return { reason: /\b(?:create|add|make)\b/i.test(base) ? 'missing_path' : 'unsupported_intent' };

  const originalPath = unquote(intent.groups['path'] ?? '');
  if (!originalPath) return { reason: 'missing_path' };
  if (!isSafeRelativeFilePath(originalPath)) return { reason: 'unsafe_path' };

  const tail = intent.groups['tail']?.trim() ?? '';
  const contentMatch = CONTENT_FORMS.map(pattern => pattern.exec(tail)).find(Boolean);
  if (!contentMatch?.groups || contentMatch.groups['content'] === undefined) {
    return { reason: 'missing_literal_content' };
  }
  const rawContent = contentMatch.groups['content'];
  const quoted = isMatchingQuoted(rawContent.trim());
  const content = quoted ? unquote(rawContent.trim()) : rawContent.trim();
  if (!quoted && !content) return { reason: 'missing_literal_content' };
  if (!quoted && MUTATING_COMPLEXITY_AFTER_CONTENT.test(content)) return { reason: 'ambiguous_content' };
  // Unquoted content is taken verbatim from the rest of the goal text, so a
  // second sentence about a different requirement (a test, validation, a
  // second file) reads as more "content" unless it is caught explicitly.
  if (!quoted) {
    const trailingLines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(1);
    if (trailingLines.some(line => DIRECTIVE_CONTINUATION_LINE.test(line))) {
      return { reason: 'multiple_instructions' };
    }
  }

  // A second path-shaped token outside literal quotes means the request is not
  // an unambiguous single-file operation.
  const contentForPathScan = quoted ? '' : content;
  if (pathTokens(contentForPathScan).length > 0) return { reason: 'multiple_files' };

  let targetPath = originalPath;
  if (steeringBlock !== undefined) {
    const instructions = steeringBlock.split(/\r?\n/).filter(Boolean).map(line => {
      const numbered = STEERING_LINE.exec(line.trim());
      return numbered?.[1]?.trim() ?? line.trim();
    });
    for (const instruction of instructions) {
      const replacement = REPLACEMENT_STEERING.exec(instruction);
      if (!replacement) return { reason: 'unsupported_steering' };
      const candidate = unquote(replacement[1] ?? '');
      if (!isSafeRelativeFilePath(candidate)) return { reason: 'unsafe_path' };
      targetPath = candidate;
    }
  }

  return {
    reason: 'accepted',
    write: { path: normalizeRelativePath(targetPath), content },
  };
}

export function parseDeterministicFileWrite(goal: string): DeterministicFileWrite | undefined {
  return analyzeDeterministicFileWrite(goal).write;
}

export function isSafeRelativeFilePath(value: string): boolean {
  if (!value || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const normalized = normalizeRelativePath(value);
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return false;
  if (normalized.endsWith('/') || normalized.includes('//')) return false;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  if (segments[0] === '.git' || segments.includes('.git')) return false;
  return segments.every(segment => /^[\p{L}\p{N}._@()+ -]+$/u.test(segment));
}

function tierForRequirements(requirements: TaskRequirements, deterministic: boolean): ExecutionTier {
  if (deterministic) return 'trivial';
  if (!requirements.fileMutation) return 'normal';
  if (requirements.codingComplexity === 'high') return 'complex';
  return requirements.codingComplexity === 'low' ? 'small' : 'normal';
}

function maxStagesForTier(tier: ExecutionTier): 0 | 1 | 5 {
  if (tier === 'trivial') return 0;
  if (tier === 'complex') return 5;
  return 1;
}

export function classifyExecutionProfile(goal: string, hints: TaskRequirementHints = {}): ExecutionProfile {
  const extraction = analyzeDeterministicFileWrite(goal);
  const requirements = classifyTaskRequirements(goal, extraction.write
    ? { ...hints, fileMutation: true, codingComplexity: hints.codingComplexity ?? 'low' }
    : hints);
  const deterministic = requirements.fileMutation
    && requirements.codingComplexity !== 'high'
    && !REPO_WIDE_SIGNAL.test(goal)
    && Boolean(extraction.write);
  const tier = tierForRequirements(requirements, deterministic);
  return {
    tier,
    maxStages: maxStagesForTier(tier),
    useDeterministicProposal: deterministic,
    requirements,
    escalation: {},
    classificationReason: deterministic
      ? 'single_safe_relative_file_with_explicit_literal_content'
      : tier === 'complex'
        ? 'complex_task_requires_full_graph'
        : `${tier}_task_uses_lightweight_proposal`,
    deterministicExtraction: {
      status: extraction.write ? 'available' : 'unavailable',
      reason: extraction.reason,
    },
  };
}

const ESCALATION_ORDER: readonly ExecutionTier[] = ['trivial', 'small', 'normal', 'complex'];

export function escalateExecutionProfile(profile: ExecutionProfile, reason: string): ExecutionProfile {
  const currentIndex = ESCALATION_ORDER.indexOf(profile.tier);
  const nextTier = ESCALATION_ORDER[Math.min(currentIndex + 1, ESCALATION_ORDER.length - 1)];
  return {
    ...profile,
    tier: nextTier,
    maxStages: maxStagesForTier(nextTier),
    useDeterministicProposal: false,
    escalation: { fromTier: profile.tier, reason },
    classificationReason: `durable_escalation:${profile.tier}:${reason}`,
  };
}

export function executionProfileAllowsFullGraph(profile: ExecutionProfile, durableEscalationReason?: string): boolean {
  return profile.tier === 'complex'
    || Boolean(
      profile.escalation.fromTier
      && profile.escalation.reason
      && durableEscalationReason === profile.escalation.reason,
    );
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isMatchingQuoted(value: string): boolean {
  return value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('`') && value.endsWith('`'))
      || (value.startsWith('“') && value.endsWith('”')));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return isMatchingQuoted(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function pathTokens(value: string): string[] {
  return [...value.matchAll(/(?:^|\s)([\w./\\-]+\.[a-z0-9]{1,16})(?=$|\s|[,;:])/gi)].map(match => match[1]);
}
