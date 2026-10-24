import * as crypto from 'crypto';
import * as path from 'path';

export const CODING_PROPOSAL_VERSION = 1 as const;
export const CODING_PROPOSAL_MAX_RESPONSE_BYTES = 1_000_000;
export const CODING_PROPOSAL_MAX_NESTING_DEPTH = 64;

export const CODING_PROPOSAL_OPERATION_TYPES = ['create', 'replace', 'delete', 'edit'] as const;
export const CODING_PROPOSAL_VALIDATION_COMMAND_KINDS = [
  'git-diff-check',
  'git-status-short',
  'tsc-no-emit',
  'vitest',
  'npm-script',
  'npm-test',
  'pytest',
] as const;
export const CODING_PROPOSAL_REQUIRED_FIELDS = [
  'version',
  'taskSummary',
  'operations',
  'validationCommands',
  'warnings',
  'status',
] as const;

/** `edit` is host-expanded to `replace` before validation completes, so no validated operation ever carries it. */
export type CodingFileOperationType = Exclude<typeof CODING_PROPOSAL_OPERATION_TYPES[number], 'edit'>;
export type CodingProposalStatus = 'proposed' | 'invalid';

export interface CodingFileOperation {
  type: CodingFileOperationType;
  path: string;
  reason: string;
  content?: string;
  /**
   * Legacy model-provided value. Accepted for backward compatibility only.
   * Host-bound execution derives authoritative file fingerprints separately.
   */
  expectedFingerprint?: string;
  /**
   * Host-assigned (never parsed from model output). Present only on a `replace` that the host derived from an
   * anchored `edit`: the digest of the on-disk bytes the edit was applied to. Binding fails closed if the file
   * no longer matches, so an expanded edit can never clobber a concurrent change.
   */
  editBaseSha256?: string;
  /**
   * Host-assigned alongside `editBaseSha256`: the exact anchors the model proposed. Never applied again; only used
   * to show the operation back to a model compactly instead of re-sending the whole expanded file.
   */
  anchoredEdits?: Array<{ oldText: string; newText: string }>;
}

export interface CodingValidationCommand {
  /** `node-check` is governed-floor only (never model-proposable): `args` is one workspace-relative .js/.cjs/.mjs path. */
  kind: 'git-diff-check' | 'git-status-short' | 'tsc-no-emit' | 'vitest' | 'npm-script' | 'npm-test' | 'pytest' | 'node-check';
  args?: string[];
  script?: string;
  /**
   * Host-assigned (never parsed from model output). Present only when the
   * named npm script is NOT declared by the base workspace package.json but IS
   * declared by the root package.json that this same proposal creates or
   * replaces. The runner executes the script only while the on-disk
   * package.json still matches that approved content; otherwise the
   * authorization is stale and the command fails closed.
   */
  authorization?: {
    source: 'approved-proposal-package-json';
    packageJsonSha256: string;
  };
}

/** EOL-insensitive so a checkout under core.autocrlf / .gitattributes does
 * not make an unchanged approved package.json look modified. */
export function approvedPackageJsonFingerprint(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Scripts declared by a root package.json that the proposal itself creates
 * or replaces with explicit content, plus that content's fingerprint. */
function proposalPackageJson(
  operations: ReadonlyArray<{ type: string; path: string; content?: string }>,
): { scripts: ReadonlySet<string>; packageJsonSha256: string } | undefined {
  const operation = operations.find(item =>
    (item.type === 'create' || item.type === 'replace')
    && typeof item.content === 'string'
    && normalizeRelativePath(item.path) === 'package.json');
  if (!operation?.content) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.content);
  } catch {
    return undefined;
  }
  const scripts = isRecord(parsed) && isRecord(parsed.scripts) ? parsed.scripts : {};
  return {
    scripts: new Set(Object.entries(scripts).filter(([, body]) => typeof body === 'string').map(([name]) => name)),
    packageJsonSha256: approvedPackageJsonFingerprint(operation.content),
  };
}

export interface CodingProposal {
  version: typeof CODING_PROPOSAL_VERSION;
  taskSummary: string;
  operations: CodingFileOperation[];
  validationCommands: CodingValidationCommand[];
  limits: {
    maxFiles: number;
    maxBytesPerFile: number;
    totalBytes: number;
  };
  warnings: string[];
  status: CodingProposalStatus;
}

export interface ProposalValidationResult {
  ok: boolean;
  proposal?: CodingProposal;
  errors: string[];
  conformance?: CodingProposalConformanceMetadata;
  /** Bounded, model-facing evidence for a repair turn (e.g. current text near a missed anchor). Never applied. */
  repairHints?: string[];
}

export interface CodingProposalConformanceMetadata {
  jsonFenceRemoved?: true;
  versionRepresentationNormalized?: true;
  taskSummaryAliasNormalized?: true;
  operationContainerAliasNormalized?: true;
  operationAliasNormalized?: true;
  duplicateOperationPathsConsolidated?: true;
  anchoredEditsExpanded?: true;
}

export interface ProposalLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

export function buildCodingProposalJsonSchema(options: { allowDelete?: boolean } = {}): Record<string, unknown> {
  const allowDelete = options.allowDelete !== false;
  const operationBase = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'path', 'reason'],
    properties: {
      type: { enum: CODING_PROPOSAL_OPERATION_TYPES },
      path: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1 },
      content: { type: 'string' },
      expectedFingerprint: { type: 'string', minLength: 1 },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: [...CODING_PROPOSAL_REQUIRED_FIELDS],
    properties: {
      version: { const: CODING_PROPOSAL_VERSION },
      taskSummary: { type: 'string', minLength: 1 },
      operations: {
        type: 'array',
        minItems: 1,
        items: {
          oneOf: [
            {
              ...operationBase,
              required: ['type', 'path', 'reason', 'content'],
              properties: { ...operationBase.properties, type: { const: 'create' } },
            },
            {
              ...operationBase,
              required: ['type', 'path', 'reason', 'content'],
              properties: { ...operationBase.properties, type: { const: 'replace' } },
            },
            ...(allowDelete ? [{
              ...operationBase,
              required: ['type', 'path', 'reason'],
              properties: { ...operationBase.properties, type: { const: 'delete' } },
            }] : []),
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'path', 'reason', 'edits'],
              properties: {
                type: { const: 'edit' },
                path: { type: 'string', minLength: 1 },
                reason: { type: 'string', minLength: 1 },
                edits: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 20,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['oldText', 'newText'],
                    properties: {
                      oldText: { type: 'string', minLength: 1 },
                      newText: { type: 'string' },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      validationCommands: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind'],
              properties: {
                kind: { enum: CODING_PROPOSAL_VALIDATION_COMMAND_KINDS.filter(kind => kind !== 'vitest' && kind !== 'npm-script' && kind !== 'pytest') },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind'],
              properties: {
                kind: { const: 'pytest' },
                args: { type: 'array', items: { type: 'string' } },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'args'],
              properties: {
                kind: { const: 'vitest' },
                args: { type: 'array', items: { type: 'string' } },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'script'],
              properties: {
                kind: { const: 'npm-script' },
                script: { type: 'string', minLength: 1 },
              },
            },
          ],
        },
      },
      limits: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxFiles: { type: 'number' },
          maxBytesPerFile: { type: 'number' },
          totalBytes: { type: 'number' },
        },
      },
      warnings: { type: 'array', items: { type: 'string' } },
      status: { const: 'proposed' },
    },
  };
}

export function buildCodingProposalResponseFormat(options: { allowDelete?: boolean } = {}): { type: 'json_schema'; name: string; schema: Record<string, unknown> } {
  return {
    type: 'json_schema',
    name: 'forge_coding_proposal',
    schema: buildCodingProposalJsonSchema(options),
  };
}

/** A content-free `delete` is the cheapest branch for constrained decoding and a weak model collapses onto it
 * (empty-workspace build -> delete index.html; 146 KB edit -> delete event_forms.html). Offer it only when the task
 * itself talks about removal; validation still fails closed on any delete without explicit whole-file deletion intent. */
export function taskMentionsRemoval(task: string): boolean {
  return /\b(delete|deleting|remove|removing|drop|unlink|erase|rm|cleanup|clean up|get rid of)\b/i.test(task ?? '');
}

export function isRepairableCodingProposalFailure(errors: readonly string[]): boolean {
  if (errors.length === 0) {
    return false;
  }
  const repairable = new Set([
    'version_unsupported',
    'task_summary_required',
    'operations_required',
    'operations_empty',
    'operation_malformed',
    'operation_unsupported',
    'operation_reason_required',
    'operation_content_required',
    'path_required',
    'validation_command_malformed',
    'operation_placeholder_content_rejected',
    'validation_command_test_path_missing',
    'validation_command_scope_uncovered',
    'duplicate_operation_path',
    'validation_command_unsupported',
    'delete_intent_mismatch',
    'content_prohibited_for_delete',
    'edit_malformed',
    'edit_target_missing',
    'edit_count_exceeded',
    'edit_old_text_required',
    'edit_too_large',
    'edit_anchor_not_found',
    'edit_anchor_ambiguous',
    'edit_overlap',
    'edit_no_change',
    'edit_mixed_eol',
  ]);
  const excluded = new Set([
    'path_uri_scheme_rejected',
    'absolute_path_rejected',
    'invalid_path_separator',
    'path_traversal_rejected',
    'excluded_path_rejected',
    'credential_path_rejected',
    'file_count_limit_exceeded',
    'file_byte_limit_exceeded',
    'total_byte_limit_exceeded',
    'binary_content_rejected',
    'model_response_too_large',
    'model_response_too_deep',
    'prototype_pollution_rejected',
    'dangerous_validation_command',
  ]);
  return errors.every(error => repairable.has(error)) && !errors.some(error => excluded.has(error));
}

export const DEFAULT_PROPOSAL_LIMITS: ProposalLimits = {
  maxFiles: 12,
  maxBytesPerFile: 200_000,
  maxTotalBytes: 600_000,
};

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  'coverage',
  'tmp',
  'temp',
  '.cache',
  'cache',
]);

const CREDENTIAL_FILE_NAMES = new Set(['.env', '.env.local', '.npmrc', '.pypirc']);

export function fingerprintText(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export function parseAndValidateCodingProposal(
  raw: string,
  packageScripts: readonly string[],
  limits: ProposalLimits = DEFAULT_PROPOSAL_LIMITS,
): ProposalValidationResult {
  const extracted = extractCodingProposalJson(raw);
  if (!extracted.ok) {
    return { ok: false, errors: [extracted.error] };
  }
  const normalized = normalizeCodingProposalConformance(extracted.value);
  const conformance = mergeConformance(extracted.conformance, normalized.conformance);
  if (!normalized.ok) {
    return { ok: false, errors: normalized.errors, conformance };
  }
  const validation = validateCodingProposal(normalized.value, packageScripts, limits);
  return { ...validation, conformance };
}

export function extractCodingProposalJson(raw: string): { ok: true; value: unknown; conformance: CodingProposalConformanceMetadata } | { ok: false; error: string } {
  if (Buffer.byteLength(raw, 'utf8') > CODING_PROPOSAL_MAX_RESPONSE_BYTES) {
    return { ok: false, error: 'model_response_too_large' };
  }
  const trimmed = raw.trim();
  const conformance: CodingProposalConformanceMetadata = {};
  let json = trimmed;
  const fenced = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    json = fenced[1].trim();
    conformance.jsonFenceRemoved = true;
  } else if (/^```/m.test(trimmed)) {
    return { ok: false, error: 'malformed_model_response' };
  }
  if (!json.startsWith('{')) {
    return { ok: false, error: 'proposal_not_object' };
  }
  const end = findJsonObjectEnd(json);
  if (end === undefined) {
    return { ok: false, error: 'malformed_model_response' };
  }
  if (end !== json.length) {
    return { ok: false, error: 'trailing_model_response_text' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'malformed_model_response' };
  }
  const safetyError = validateParsedJsonSafety(parsed);
  if (safetyError) {
    return { ok: false, error: safetyError };
  }
  return { ok: true, value: parsed, conformance };
}

export function normalizeCodingProposalConformance(value: unknown): { ok: true; value: unknown; conformance: CodingProposalConformanceMetadata } | { ok: false; errors: string[]; conformance: CodingProposalConformanceMetadata } {
  const conformance: CodingProposalConformanceMetadata = {};
  if (!isRecord(value)) {
    return { ok: true, value, conformance };
  }
  const normalized: Record<string, unknown> = { ...value };
  if (typeof normalized.version === 'string' && normalized.version === String(CODING_PROPOSAL_VERSION)) {
    normalized.version = CODING_PROPOSAL_VERSION;
    conformance.versionRepresentationNormalized = true;
  }
  if ('contractVersion' in normalized) {
    if ('version' in normalized && normalized.version !== normalized.contractVersion && String(normalized.contractVersion) !== String(normalized.version)) {
      return { ok: false, errors: ['version_conflict'], conformance };
    }
    if (!('version' in normalized)) {
      normalized.version = normalized.contractVersion;
      conformance.versionRepresentationNormalized = true;
    }
  }
  const summary = normalizeAliasField(normalized, 'taskSummary', 'task_summary');
  if (!summary.ok) {
    return { ok: false, errors: ['task_summary_conflict'], conformance };
  }
  if (summary.normalized) {
    conformance.taskSummaryAliasNormalized = true;
  }
  const operations = normalizeAliasField(normalized, 'operations', 'fileOperations', 'file_operations');
  if (!operations.ok) {
    return { ok: false, errors: ['operations_conflict'], conformance };
  }
  if (operations.normalized) {
    conformance.operationContainerAliasNormalized = true;
  }
  const taskSummaryStr = typeof normalized.taskSummary === 'string' ? normalized.taskSummary : undefined;
  if (Array.isArray(normalized.operations)) {
    const rawOps = normalized.operations.map(operation => normalizeOperation(operation, conformance, taskSummaryStr));
    normalized.operations = consolidateSafeDuplicateOperations(rawOps, conformance);
  }
  return { ok: true, value: normalized, conformance };
}

export function validateCodingProposal(
  value: unknown,
  packageScripts: readonly string[],
  limits: ProposalLimits = DEFAULT_PROPOSAL_LIMITS,
): ProposalValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['proposal_not_object'] };
  }
  if (value.version !== CODING_PROPOSAL_VERSION) {
    errors.push('version_unsupported');
  }
  const taskSummary = stringField(value.taskSummary);
  if (!taskSummary) {
    errors.push('task_summary_required');
  }
  const operationsValue = Array.isArray(value.operations) ? value.operations : undefined;
  if (!operationsValue) {
    errors.push('operations_required');
  } else if (operationsValue.length === 0) {
    // The request-time schema declares `minItems: 1` (see
    // buildCodingProposalJsonSchema below), but that is only a hint to the
    // provider — Ollama's native grammar-constrained decoding enforces it,
    // but a real live run against an OpenAI-compatible cloud provider
    // (OrcaRouter/gpt-5.6-sol) returned `operations: []` under strict
    // structured output anyway, and this deterministic host-side check
    // never independently re-verified the constraint. An empty array is
    // truthy and Array.isArray-true, so it silently passed as "present" and
    // reached mutation with zero operations — which then satisfies
    // GovernedCodingExecutor's alreadySatisfied check vacuously (nothing to
    // verify a mismatch against), reporting a genuinely unfixed defect as
    // "completed: already satisfied" with no real evidence. A model that
    // believes no change is needed must say so through a real, verifiable
    // operation (e.g. a `replace` whose content already matches disk,
    // which alreadySatisfiedAtBinding already handles) — never through
    // silence.
    errors.push('operations_empty');
  }
  const validationValue = Array.isArray(value.validationCommands) ? value.validationCommands : [];
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((entry): entry is string => typeof entry === 'string').slice(0, 20)
    : [];

  const operations: CodingFileOperation[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  if (operationsValue) {
    if (operationsValue.length > limits.maxFiles) {
      errors.push('file_count_limit_exceeded');
    }
    for (const opValue of operationsValue) {
      if (!isRecord(opValue)) {
        errors.push('operation_malformed');
        continue;
      }
      const type = opValue.type;
      if (type !== 'create' && type !== 'replace' && type !== 'delete') {
        errors.push('operation_unsupported');
        continue;
      }
      const relativePath = stringField(opValue.path);
      const pathError = validateRelativeWorkspacePath(relativePath);
      if (pathError) {
        errors.push(pathError);
        continue;
      }
      if (!relativePath) {
        errors.push('path_required');
        continue;
      }
      const normalizedPath = normalizeRelativePath(relativePath);
      if (seenPaths.has(normalizedPath.toLowerCase())) {
        errors.push('duplicate_operation_path');
        continue;
      }
      seenPaths.add(normalizedPath.toLowerCase());
      const reason = stringField(opValue.reason);
      if (!reason) {
        errors.push('operation_reason_required');
      }
      const rawContent = stringField(opValue.content);
      if (type === 'delete') {
        if (rawContent !== undefined && rawContent.trim().length > 0) {
          errors.push('content_prohibited_for_delete');
        }
        if (!hasExplicitFileDeletionIntent(reason, taskSummary, normalizedPath)) {
          errors.push('delete_intent_mismatch');
        }
      }
      const content = type === 'delete' ? undefined : rawContent;
      if (type !== 'delete' && content === undefined) {
        errors.push('operation_content_required');
      }
      if (content !== undefined) {
        const bytes = Buffer.byteLength(content, 'utf8');
        totalBytes += bytes;
        if (bytes > limits.maxBytesPerFile) {
          errors.push('file_byte_limit_exceeded');
        }
        if (hasBinaryMarker(content)) {
          errors.push('binary_content_rejected');
        }
        if (hasPlaceholderContent(content)) {
          errors.push('operation_placeholder_content_rejected');
        }
      }
      const expectedFingerprint = stringField(opValue.expectedFingerprint);
      operations.push({ type, path: normalizedPath, reason: reason ?? '', content, expectedFingerprint });
    }
  }
  if (totalBytes > limits.maxTotalBytes) {
    errors.push('total_byte_limit_exceeded');
  }

  const validationCommands: CodingValidationCommand[] = [];
  const proposedPackage = proposalPackageJson(operations);
  for (const commandValue of validationValue) {
    const parsed = parseValidationCommand(commandValue, packageScripts, proposedPackage);
    if (parsed.error) {
      errors.push(parsed.error);
      if (parsed.dangerous) {
        errors.push('dangerous_validation_command');
      }
    } else if (parsed.command) {
      validationCommands.push(parsed.command);
    }
  }

  if (errors.length > 0 || !taskSummary) {
    return { ok: false, errors: [...new Set(errors)] };
  }
  return {
    ok: true,
    errors: [],
    proposal: {
      version: CODING_PROPOSAL_VERSION,
      taskSummary,
      operations,
      validationCommands,
      limits: { maxFiles: limits.maxFiles, maxBytesPerFile: limits.maxBytesPerFile, totalBytes },
      warnings,
      status: 'proposed',
    },
  };
}

export function validateRelativeWorkspacePath(input: string | undefined): string | undefined {
  if (!input) {
    return 'path_required';
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    return 'path_uri_scheme_rejected';
  }
  if (path.isAbsolute(input) || input.startsWith('/') || input.startsWith('\\')) {
    return 'absolute_path_rejected';
  }
  if (input.includes('\\')) {
    return 'invalid_path_separator';
  }
  const normalized = normalizeRelativePath(input);
  if (!normalized || normalized === '.') {
    return 'path_required';
  }
  const segments = normalized.split('/');
  if (segments.includes('..')) {
    return 'path_traversal_rejected';
  }
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) {
    return 'excluded_path_rejected';
  }
  if (CREDENTIAL_FILE_NAMES.has(segments[segments.length - 1].toLowerCase())) {
    return 'credential_path_rejected';
  }
  return undefined;
}

export function normalizeRelativePath(input: string): string {
  return path.posix.normalize(input.replace(/\\/g, '/'));
}

function parseValidationCommand(
  value: unknown,
  packageScripts: readonly string[],
  proposedPackage?: { scripts: ReadonlySet<string>; packageJsonSha256: string },
): { command?: CodingValidationCommand; error?: string; dangerous?: boolean } {
  const proposalAuthorization = (script: string): CodingValidationCommand['authorization'] | undefined =>
    proposedPackage?.scripts.has(script)
      ? { source: 'approved-proposal-package-json', packageJsonSha256: proposedPackage.packageJsonSha256 }
      : undefined;
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return { error: 'validation_command_malformed' };
  }
  let kind = value.kind;
  let args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : [];
  if (args.some(arg => /[|&;<>()>`*$]/.test(arg) || arg.includes('..'))) {
    return { error: 'validation_command_unsupported', dangerous: true };
  }
  // Normalize python -m pytest ... or python pytest ... to kind: 'pytest'
  if (kind === 'python') {
    if (args[0] === '-m' && args[1] === 'pytest') {
      kind = 'pytest';
      args = args.slice(2);
    } else if (args[0] === 'pytest') {
      kind = 'pytest';
      args = args.slice(1);
    }
  }
  switch (kind) {
    case 'git-diff-check':
    case 'git-status-short':
    case 'tsc-no-emit':
      return args.length === 0 ? { command: { kind } } : { error: 'validation_command_unsupported' };
    case 'npm-test': {
      if (args.length !== 0) return { error: 'validation_command_unsupported' };
      // Existing-repository behavior is unchanged: a base `test` script, or no
      // proposed package.json at all, keeps the original acceptance.
      if (packageScripts.includes('test') || !proposedPackage) return { command: { kind: 'npm-test' } };
      const authorization = proposalAuthorization('test');
      return authorization ? { command: { kind: 'npm-test', authorization } } : { error: 'validation_command_unsupported' };
    }
    case 'vitest':
      return args.every(arg => arg.endsWith('.test.ts') || arg === '--run' || arg === 'run')
        ? { command: { kind: 'vitest', args } }
        : { error: 'validation_command_unsupported' };
    case 'pytest': {
      if (args.length === 0) {
        return { command: { kind: 'pytest' } };
      }
      const safePytestArg = (arg: string): boolean => {
        if (/^-(v+|q+|s|x|k|m|rf|ra)$/.test(arg)) return true;
        if (/^--(maxfail(=\d+)?|tb=(short|auto|native|line|no)|durations=\d+|disable-warnings|verbose|quiet)$/.test(arg)) return true;
        if (/^\d+$/.test(arg)) return true;
        if (/^[a-zA-Z0-9_ ]+$/.test(arg)) return true;
        if (/^[a-zA-Z0-9_./-]+(::[a-zA-Z0-9_]+)?$/.test(arg)) return true;
        return false;
      };
      if (args.every(safePytestArg)) {
        return { command: { kind: 'pytest', args } };
      }
      return { error: 'validation_command_unsupported' };
    }
    case 'npm-script': {
      const script = stringField(value.script);
      if (!script || script === 'package' || script.startsWith('test:live') || args.length !== 0) {
        return { error: 'validation_command_unsupported' };
      }
      if (packageScripts.includes(script)) return { command: { kind: 'npm-script', script } };
      const authorization = proposalAuthorization(script);
      return authorization ? { command: { kind: 'npm-script', script, authorization } } : { error: 'validation_command_unsupported' };
    }
    default:
      return { error: 'validation_command_unsupported' };
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBinaryMarker(content: string): boolean {
  return content.includes('\u0000');
}

/**
 * Narrow, mechanical guard against the observed "247-line real implementation
 * replaced by a ~20-line pseudocode stub" failure mode: a create/replace
 * operation whose content is an obvious placeholder rather than a complete
 * implementation. Deliberately NOT a line-count/shrink heuristic (the goal
 * asked to avoid that) — only unmistakable placeholder markers a real
 * implementation would never contain.
 */
const PLACEHOLDER_CONTENT_PATTERNS: readonly RegExp[] = [
  // "// ... existing validation logic ...", "// ... rest of ...", etc.
  /\/\/\s*\.\.\.\s*(existing|rest of|remaining)\b/i,
  // A comment line that is only an ellipsis, with nothing else on it.
  /^[ \t]*\/\/\s*\.\.\.\s*$/m,
  // "TODO: implement", "TODO implementation", etc.
  /\bTODO\b[^\n]*\b(implement|implementation)\b/i,
];

function hasPlaceholderContent(content: string): boolean {
  return PLACEHOLDER_CONTENT_PATTERNS.some(pattern => pattern.test(content));
}

function findJsonObjectEnd(json: string): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      if (depth > CODING_PROPOSAL_MAX_NESTING_DEPTH) {
        return undefined;
      }
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

function validateParsedJsonSafety(value: unknown, depth = 0): string | undefined {
  if (depth > CODING_PROPOSAL_MAX_NESTING_DEPTH) {
    return 'model_response_too_deep';
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const error = validateParsedJsonSafety(entry, depth + 1);
      if (error) {
        return error;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return 'prototype_pollution_rejected';
    }
    const error = validateParsedJsonSafety(value[key], depth + 1);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function normalizeAliasField(
  target: Record<string, unknown>,
  canonical: string,
  ...aliases: string[]
): { ok: true; normalized: boolean } | { ok: false } {
  let normalized = false;
  for (const alias of aliases) {
    if (!(alias in target)) {
      continue;
    }
    if (canonical in target) {
      if (!jsonEquivalent(target[canonical], target[alias])) {
        return { ok: false };
      }
      continue;
    }
    target[canonical] = target[alias];
    normalized = true;
  }
  return { ok: true, normalized };
}

export const CODE_ELEMENT_PATTERN = /\b(branch|branches|function|functions|method|methods|class|classes|import|imports|condition|conditions|helper|helpers|variable|variables|logic|line|lines|statement|statements|arg|args|argument|arguments|parameter|parameters|test\s+case|test\s+cases|test\s+function|test\s+method|unit\s+test|unit\s+tests|switch\s+case|edge\s+case|null\s+check|type\s+check|bounds\s+check|block|blocks|field|fields|property|properties|export|exports|definition|definitions|call|calls|expression|expressions|loop|loops|clause|clauses|constant|constants|interface|interfaces|struct|structs|enum|enums|modifier|annotation|decorator)\b/i;
export const IN_OR_FROM_FILE_PATTERN = /\b(from|in|within|inside)\s+(the\s+)?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\b/i;
export const MODIFY_INTENT_PATTERN = /\b(fix|modify|update|patch|refactor|correct|repair|resolve|implement|rewrite|adjust|edit|revise|behavior|calculation|computation|pricing|discount|coupon|tax)\b/i;

export function stripNegatedPhrases(text: string): string {
  return text.replace(/\b(do\s+not|don't|dont|never|without)\s+(modify|edit|change|touch|update|patch|delete|remove)\b[^\n.,;]*/gi, '');
}

export function hasCodeElementIntent(...texts: (string | undefined)[]): boolean {
  for (const text of texts) {
    if (!text) continue;
    const stripped = stripNegatedPhrases(text);
    if (CODE_ELEMENT_PATTERN.test(stripped)) return true;
    if (IN_OR_FROM_FILE_PATTERN.test(stripped)) return true;
  }
  return false;
}

export function hasModifyIntent(...texts: (string | undefined)[]): boolean {
  for (const text of texts) {
    if (!text) continue;
    const stripped = stripNegatedPhrases(text);
    if (MODIFY_INTENT_PATTERN.test(stripped)) return true;
    if (CODE_ELEMENT_PATTERN.test(stripped)) return true;
    if (IN_OR_FROM_FILE_PATTERN.test(stripped)) return true;
  }
  return false;
}

export const EXPLICIT_FILE_DELETION_PHRASES: readonly RegExp[] = [
  /\b(delete|remove|drop|unlink|erase|rm)\s+(the\s+|this\s+)?(file|module|script)\b/i,
  /\b(delete|remove|drop|unlink|erase|rm)\s+(the\s+)?(obsolete|deprecated|unused|redundant|unneeded|dead|old)\s+(file|module|script)s?\b/i,
  /\b(delete|remove|drop|unlink|erase|rm)\s+.*?\b(entirely|completely|permanently)\b/i,
  /\b(delete|remove|drop|unlink|erase|rm)\s+.*?\bfrom\s+(the\s+)?(repository|repo|project|codebase|disk|workspace|git)\b/i,
];

export function hasExplicitFileDeletionIntent(
  reason?: string,
  taskSummary?: string,
  targetPath?: string,
): boolean {
  // If either reason or taskSummary expresses code-element deletion, it is NEVER whole-file deletion
  if (hasCodeElementIntent(reason)) return false;
  if (hasCodeElementIntent(taskSummary)) return false;

  // If taskSummary expresses modify intent, a delete operation conflicts with task intent
  if (hasModifyIntent(taskSummary)) return false;

  const combined = [reason, taskSummary].filter(Boolean).join(' ');
  if (!combined.trim()) return false;

  // Check explicit whole-file deletion phrasing
  for (const pattern of EXPLICIT_FILE_DELETION_PHRASES) {
    if (pattern.test(combined)) {
      return true;
    }
  }

  // If a target path or filename was provided, check if the text explicitly removes that exact file
  if (targetPath) {
    const baseName = path.posix.basename(targetPath.replace(/\\/g, '/'));
    const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedPath = targetPath.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathPattern = new RegExp(
      `\\b(delete|remove|drop|unlink|erase|rm)\\s+(the\\s+|this\\s+)?(obsolete\\s+|deprecated\\s+|unused\\s+|redundant\\s+|unneeded\\s+|dead\\s+|old\\s+)?(file\\s+)?(${escapedPath}|${escapedBase})(\\s+file)?\\b`,
      'i',
    );
    if (pathPattern.test(combined)) {
      if (!IN_OR_FROM_FILE_PATTERN.test(combined)) {
        return true;
      }
    }
  }

  return false;
}

function normalizeOperation(
  operation: unknown,
  conformance: CodingProposalConformanceMetadata,
  taskSummary?: string,
): unknown {
  if (!isRecord(operation)) {
    return operation;
  }
  const normalized: Record<string, unknown> = { ...operation };

  // A real anchored edit (type "edit" carrying an `edits` array) is its own operation, expanded by the host from
  // the file on disk. "edit" with `content` and no `edits` stays the legacy alias for a whole-file replace.
  if (typeof normalized.type === 'string' && normalized.type.toLowerCase().trim() === 'edit' && Array.isArray(normalized.edits)) {
    normalized.type = 'edit';
    return normalized;
  }
  // A single anchor written flat on the operation ({"type":"edit","oldText":..,"newText":..}) is the same edit;
  // it still has to match the file exactly once. Only the container shape is normalized, never the anchor text.
  if (
    typeof normalized.type === 'string' && normalized.type.toLowerCase().trim() === 'edit'
    && typeof normalized.oldText === 'string' && typeof normalized.newText === 'string'
    && normalized.content === undefined && normalized.edits === undefined
  ) {
    const { oldText, newText, ...rest } = normalized;
    conformance.operationAliasNormalized = true;
    return { ...rest, type: 'edit', edits: [{ oldText, newText }] };
  }

  // Normalize type/action aliases if type is missing or not a string
  if (typeof normalized.type !== 'string') {
    const aliasType = normalized.action ?? normalized.operation ?? normalized.kind ?? normalized.op;
    if (typeof aliasType === 'string') {
      normalized.type = aliasType;
      conformance.operationAliasNormalized = true;
    }
  }

  // Normalize content aliases if content is missing
  if (normalized.content === undefined) {
    const aliasContent = normalized.file_content ?? normalized.new_content ?? normalized.code ?? normalized.text ?? normalized.body ?? normalized.replacement ?? normalized.patch;
    if (typeof aliasContent === 'string') {
      normalized.content = aliasContent;
      conformance.operationAliasNormalized = true;
    }
  }

  if (typeof normalized.type === 'string') {
    const contentStr = typeof normalized.content === 'string' ? normalized.content : undefined;
    const hasContent = contentStr !== undefined && contentStr.trim().length > 0;
    const reasonStr = typeof normalized.reason === 'string' ? normalized.reason : undefined;
    const pathStr = typeof normalized.path === 'string' ? normalized.path : undefined;

    const operationType = normalizeOperationType(normalized.type, hasContent, reasonStr, taskSummary, pathStr);
    if (operationType !== normalized.type) {
      normalized.type = operationType;
      conformance.operationAliasNormalized = true;
    }
  }
  return normalized;
}

function normalizeOperationType(
  type: string,
  hasContent = false,
  reason?: string,
  taskSummary?: string,
  targetPath?: string,
): string {
  const lower = type.toLowerCase().trim();
  switch (lower) {
    case 'modify':
    case 'update':
    case 'edit':
    case 'patch':
      return 'replace';
    case 'add':
    case 'new':
      return 'create';
    case 'remove':
    case 'rm':
    case 'del':
    case 'delete': {
      // 1. Content presence: If content was provided, the model clearly intended to populate or modify the file, NEVER delete it.
      // Content supplied with a delete-like action must NEVER disappear silently.
      if (hasContent) {
        return 'replace';
      }
      // 2. If no content, but intent expresses modifying/fixing code, never infer deletion.
      // Normalizing to 'replace' forces validateCodingProposal to require content, triggering repair.
      if (hasModifyIntent(reason, taskSummary)) {
        return 'replace';
      }
      // 3. If explicit whole-file deletion intent is proven, keep 'delete'.
      if (hasExplicitFileDeletionIntent(reason, taskSummary, targetPath)) {
        return 'delete';
      }
      // 4. Ambiguous intent: preserve 'delete' so validateCodingProposal fails closed with 'delete_intent_mismatch'.
      return 'delete';
    }
    default:
      return type;
  }
}

export function mergeConformance(
  first: CodingProposalConformanceMetadata,
  second: CodingProposalConformanceMetadata,
): CodingProposalConformanceMetadata | undefined {
  const merged: CodingProposalConformanceMetadata = { ...first, ...second };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function consolidateSafeDuplicateOperations(
  operations: unknown[],
  conformance: CodingProposalConformanceMetadata,
): unknown[] {
  const pathGroups = new Map<string, number[]>();
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (isRecord(op) && typeof op.path === 'string' && op.path.trim().length > 0) {
      const norm = normalizeRelativePath(op.path.trim()).toLowerCase();
      const group = pathGroups.get(norm);
      if (group) {
        group.push(i);
      } else {
        pathGroups.set(norm, [i]);
      }
    }
  }

  const indicesToRemove = new Set<number>();
  let didConsolidate = false;

  for (const [, indices] of pathGroups) {
    if (indices.length <= 1) continue;

    const ops = indices.map(idx => operations[idx] as Record<string, unknown>);

    // Case 0: every operation is an anchored edit of the same file -> one edit carrying all anchors. Each anchor is
    // still matched exactly once against the original file and overlaps still fail closed during expansion.
    if (ops.every(op => op.type === 'edit' && Array.isArray(op.edits))) {
      (operations[indices[0]] as Record<string, unknown>).edits = ops.flatMap(op => op.edits as unknown[]);
      for (let k = 1; k < indices.length; k++) {
        indicesToRemove.add(indices[k]);
      }
      didConsolidate = true;
      continue;
    }

    // Case 1: All operations are 'delete' -> redundant deletions, keep first
    const allDelete = ops.every(op => op.type === 'delete');
    if (allDelete) {
      for (let k = 1; k < indices.length; k++) {
        indicesToRemove.add(indices[k]);
      }
      didConsolidate = true;
      continue;
    }

    // Case 2: All operations are 'replace' with identical non-empty content -> redundant edits, keep first
    const allReplace = ops.every(op => op.type === 'replace');
    const firstContent = ops[0].content;
    const allIdenticalContent =
      allReplace &&
      typeof firstContent === 'string' &&
      ops.every(op => op.content === firstContent);

    if (allIdenticalContent) {
      for (let k = 1; k < indices.length; k++) {
        indicesToRemove.add(indices[k]);
      }
      didConsolidate = true;
      continue;
    }

    // Case 3: Semantically incompatible operations (differing contents or mixed delete/replace).
    // Preserve fail-closed: do NOT merge, let duplicate_operation_path trigger repair or fail closed.
  }

  if (didConsolidate) {
    conformance.duplicateOperationPathsConsolidated = true;
    return operations.filter((_, idx) => !indicesToRemove.has(idx));
  }

  return operations;
}

export function detectWorkspaceValidationPolicy(
  workspaceRoot?: string,
  packageScripts: readonly string[] = [],
  files: readonly string[] = [],
): string[] {
  const commands: string[] = [
    '{"kind":"git-diff-check"}',
    '{"kind":"git-status-short"}',
  ];

  const hasPython = files.some(file =>
    file.endsWith('.py') ||
    file.includes('pytest.ini') ||
    file.includes('pyproject.toml') ||
    file.includes('setup.py') ||
    file.includes('conftest.py')
  );
  if (hasPython) {
    commands.push('{"kind":"pytest"} (or {"kind":"pytest","args":["<test-path>.py"]})');
  }

  const hasTs = files.some(file => file.endsWith('.ts') || file.endsWith('.tsx') || file.includes('tsconfig.json'));
  if (hasTs) {
    commands.push('{"kind":"tsc-no-emit"}');
  }

  const hasVitest = files.some(file => file.includes('vitest.config') || file.endsWith('.test.ts'));
  if (hasVitest) {
    commands.push('{"kind":"vitest","args":["--run","<test-path>.test.ts"]}');
  }

  if (packageScripts.includes('test')) {
    commands.push('{"kind":"npm-test"}');
  }
  const allowedScripts = packageScripts.filter(s => s !== 'package' && !s.startsWith('test:live') && s !== 'test');
  if (allowedScripts.length > 0) {
    commands.push(`{"kind":"npm-script","script":"<name>"} where <name> is one of: ${allowedScripts.join(', ')}`);
  }
  // npm validators are only offered where a package.json exists or this proposal creates one; a Python-only
  // workspace must not be steered toward `npm test`.
  if (!hasPython || files.some(file => file === 'package.json' || file.endsWith('/package.json'))) {
    commands.push(
      '{"kind":"npm-test"} or {"kind":"npm-script","script":"<name>"} for a script declared in the root package.json that THIS proposal creates or replaces with full content (only that exact script name)',
    );
  }

  return commands;
}
