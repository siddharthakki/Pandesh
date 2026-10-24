import { AgentMode } from '../config/ConfigSchema';

const STRONG_READ_ONLY_PATTERNS: RegExp[] = [
  /\bread[- ]only\b/i,
  /\binspection only\b/i,
  /\breport only\b/i,
  /\bwithout modifying (?:anything|any files?|files?|the workspace)\b/i,
  /\bwithout (?:making|applying) (?:any )?changes\b/i,
  /\bdo not (?:modify|write|edit|change|create|delete) (?:any )?(?:files?|anything|the workspace)\b/i,
  /\bno (?:workspace |file )?changes\b/i,
];

const NATURAL_READ_ONLY_ACTION = /\b(?:inspect|read|review|summari[sz]e|explain|list|show|find|search|locate|check|compare|count|analy[sz]e)\b/i;
const REPOSITORY_INSPECTION_SUBJECT = /\b(?:repo(?:sitory)?|workspace|codebase|source code|files?|folders?|directories?|readme(?:\.md)?|package\.json|package-lock\.json|[a-z0-9_.-]+\.(?:md|json|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|java|c|cc|cpp|h|hpp|cs|go|rs|html|css|scss|xml|txt))\b/i;

const NEGATED_MUTATION_CLAUSE = /\b(?:do not|don't|never|without)\b[^.\n!?]{0,80}\b(?:create|add|update|edit|modify|fix|implement|write|delete|remove|rename|move|refactor|install|commit|push|apply|run|execute)\b/gi;
const POSITIVE_MUTATION_DIRECTIVE = /(?:^|[\n.!?]\s*|\b(?:and|then|also)\s+)(?:please\s+)?(?:create|add|update|edit|modify|fix|implement|write|delete|remove|rename|move|refactor|install|commit|push|apply)\b/im;

export type RepositoryEvidenceKind =
  | 'any_read'
  | 'file_read'
  | 'directory_listing'
  | 'file_search';

function hasNoMutationDirective(text: string): boolean {
  const withoutNegatedClauses = text.replace(NEGATED_MUTATION_CLAUSE, '');
  return !POSITIVE_MUTATION_DIRECTIVE.test(withoutNegatedClauses);
}

/**
 * Detect a strong, explicitly-worded read-only repository inspection request
 * (e.g. "read-only", "inspection only", "do not modify any files").
 *
 * This is the strict gate used for repository-evidence completion: it must
 * not fire on ordinary natural-language inspection wording ("Summarize the
 * repository purpose"), since that would force evidence retries on requests
 * that never asked for a read-only guarantee.
 */
export function isExplicitReadOnlyInspectionRequest(text: string): boolean {
  const explicitReadOnly = STRONG_READ_ONLY_PATTERNS.some(pattern => pattern.test(text));
  if (!explicitReadOnly) { return false; }
  return hasNoMutationDirective(text);
}

/**
 * Detect a read-only repository inspection request using either strong,
 * explicit wording or natural inspection phrasing ("inspect", "summarize",
 * "list", ...) paired with a repository subject.
 *
 * This intentionally requires strong user wording or natural inspection
 * wording. A narrow constraint such as "do not modify tests" must not
 * downgrade an otherwise mutating task.
 *
 * This is the natural-language gate used only to route ordinary Saath Kar
 * inspection requests to Ask mode. It is deliberately broader than
 * {@link isExplicitReadOnlyInspectionRequest} and must not be used for the
 * strict repository-evidence completion gate.
 */
export function isReadOnlyInspectionRequest(text: string): boolean {
  const naturalReadOnly = NATURAL_READ_ONLY_ACTION.test(text)
    && REPOSITORY_INSPECTION_SUBJECT.test(text);
  if (!isExplicitReadOnlyInspectionRequest(text) && !naturalReadOnly) {
    return false;
  }

  return hasNoMutationDirective(text);
}

/**
 * Extract the classes of repository evidence explicitly requested by a
 * read-only inspection. The result is intentionally small and deterministic;
 * it is used only as a completion guard, not as a general natural-language
 * planner.
 */
export function getRepositoryEvidenceRequirements(text: string): RepositoryEvidenceKind[] {
  if (!isExplicitReadOnlyInspectionRequest(text)) { return []; }

  const requirements = new Set<RepositoryEvidenceKind>();
  const requestsFileRead = /\bread\b[^.\n]{0,120}(?:package\.json|[a-z0-9_./\\-]+\.[a-z0-9]{1,12})\b/i.test(text);
  const requestsDirectoryListing = /\blist\b[^.\n]{0,120}\b(?:files?|directories?|folders?|entries)\b/i.test(text)
    || /\bfiles?\s+(?:directly\s+)?under\b/i.test(text);
  const requestsFileSearch = /\bcount\b[^.\n]{0,160}\bfiles?\b/i.test(text)
    || /\bfiles?\s+matching\b/i.test(text)
    || /(?:^|\s)[a-z0-9_./\\-]*[*?][a-z0-9_.*?./\\-]*/i.test(text);

  if (requestsFileRead) { requirements.add('file_read'); }
  if (requestsDirectoryListing) { requirements.add('directory_listing'); }
  if (requestsFileSearch) { requirements.add('file_search'); }
  if (requirements.size === 0) { requirements.add('any_read'); }

  return [...requirements];
}

/**
 * Agent mode is automatically constrained to Ask mode for explicit read-only
 * inspection requests. Ask mode retains repository read tools while policy
 * blocks writes and commands, and it does not enter mutation validation/repair.
 *
 * An Agent run that was given explicit validation commands is never
 * downgraded, even if the request text also reads as a natural inspection
 * request: the caller has already committed to the sequential specialist
 * workflow (Supervisor/Planner/Implementer/Reviewer/Validator), and that
 * workflow must not be silently bypassed.
 */
export function resolveExecutionMode(
  text: string,
  requestedMode: AgentMode,
  hasExplicitValidationCommands = false,
): AgentMode {
  if (hasExplicitValidationCommands) { return requestedMode; }
  return requestedMode === 'agent' && isReadOnlyInspectionRequest(text)
    ? 'ask'
    : requestedMode;
}

/** Preserve the Agent model when Auto mode is constrained to read-only Ask execution. */
export function resolveExecutionModelOverride(
  text: string,
  requestedMode: AgentMode,
  modelOverride: string | undefined,
  agentModel: string,
  hasExplicitValidationCommands = false,
): string | undefined {
  const effectiveMode = resolveExecutionMode(text, requestedMode, hasExplicitValidationCommands);
  return requestedMode === 'agent' && effectiveMode !== requestedMode
    ? modelOverride ?? agentModel
    : modelOverride;
}
