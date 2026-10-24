import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import {
  ATTEMPT_CONTEXT_SCHEMA_VERSION,
  REPOSITORY_CONTEXT_MAX_ESTIMATED_TOKENS,
  REPOSITORY_CONTEXT_MAX_PROMPT_CHARS,
  REPOSITORY_CONTEXT_MAX_SELECTED_FILES,
  type AttemptContextRecord,
  type AttemptKind,
  type AttemptPermittedCapabilities,
  type ContextPolicy,
  type FrozenAttachmentReference,
  type ModelSelectionEvidence,
  type RepositoryContextPackage,
  type RequestEnvelopeRecord,
  type ToolPermissionPolicy,
} from '../shared/wireTypes';
import { CONTEXT_WINDOW_SOURCES, MAX_CONTEXT_TOKENS, MIN_CONTEXT_TOKENS } from '../shared/contextBudget';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

const DEFAULT_PROVIDER = 'ollama';
const DEFAULT_MODEL = 'qwen2.5-coder:1.5b';

function firstNonBlank(...values: Array<string | null | undefined>): string {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? '';
}

export interface AttemptContextInput {
  workspaceRoot?: string | null;
  selectedProvider?: string | null;
  selectedModel?: string | null;
  modelSelection?: ModelSelectionEvidence;
  repositoryContext?: RepositoryContextPackage;
  retryGuidance?: string | null;
  /** Frozen attachment ids/hashes for this attempt (M36). Never carried
   * forward implicitly on retry — retryAttempt must pass the predecessor's
   * value explicitly if it wants to preserve it. */
  attachments?: FrozenAttachmentReference[];
  hasWorkspace?: boolean;
  gitCapable?: boolean;
  allowedTools?: string[];
  approvalPolicy?: ToolPermissionPolicy;
  /** Retry only: preserve the predecessor's stable context identity. */
  contextIdentity?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function contextHashOf(record: Omit<AttemptContextRecord, 'contextHash'>): string {
  return crypto.createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}

function rowToContext(row: Record<string, unknown>): AttemptContextRecord {
  return {
    id: String(row.id),
    contextIdentity: String(row.contextIdentity),
    requestId: String(row.requestId),
    attemptId: String(row.attemptId),
    resolvedMode: row.resolvedMode as AttemptKind,
    workspaceRoot: (row.workspaceRoot as string) ?? null,
    repositoryId: (row.repositoryId as string) ?? null,
    repositoryLocationId: (row.repositoryLocationId as string) ?? null,
    taskInput: String(row.taskInput),
    selectedProvider: String(row.selectedProvider),
    selectedModel: String(row.selectedModel),
    ...(row.modelSelection ? { modelSelection: JSON.parse(String(row.modelSelection)) as ModelSelectionEvidence } : {}),
    ...(row.repositoryContext ? { repositoryContext: JSON.parse(String(row.repositoryContext)) as RepositoryContextPackage } : {}),
    ...(row.retryGuidance !== null && row.retryGuidance !== undefined ? { retryGuidance: String(row.retryGuidance) } : {}),
    ...(row.attachments ? { attachments: JSON.parse(String(row.attachments)) as FrozenAttachmentReference[] } : {}),
    permittedCapabilities: JSON.parse(String(row.permittedCapabilities)),
    approvalPolicy: JSON.parse(String(row.approvalPolicy)),
    schemaVersion: Number(row.schemaVersion),
    createdAt: String(row.createdAt),
    contextHash: String(row.contextHash),
  };
}

/**
 * M45: the frozen context window is accepted only as an in-range integer with
 * a known source, and an out-of-range or unlabelled value is dropped rather
 * than rejected (older and third-party producers stay compatible). Core then
 * records its own conservative assumption instead of trusting a bad number.
 */
export function sanitizeModelSelectionWindow(selection: ModelSelectionEvidence): ModelSelectionEvidence {
  const { contextWindowTokens, contextWindowSource, maxOutputTokens, ...rest } = selection;
  const windowValid = Number.isInteger(contextWindowTokens)
    && (contextWindowTokens as number) >= MIN_CONTEXT_TOKENS
    && (contextWindowTokens as number) <= MAX_CONTEXT_TOKENS
    && (CONTEXT_WINDOW_SOURCES as readonly unknown[]).includes(contextWindowSource);
  const outputValid = Number.isInteger(maxOutputTokens)
    && (maxOutputTokens as number) > 0
    && (maxOutputTokens as number) <= MAX_CONTEXT_TOKENS;
  return {
    ...rest,
    ...(windowValid ? { contextWindowTokens, contextWindowSource } : {}),
    ...(outputValid ? { maxOutputTokens } : {}),
  };
}

/** The window fields worth recording on a `model_selection_decided` event. */
export function contextWindowEventMetadata(selection: ModelSelectionEvidence): Record<string, unknown> {
  return {
    ...(selection.contextWindowTokens !== undefined ? { contextWindowTokens: selection.contextWindowTokens } : {}),
    ...(selection.contextWindowSource !== undefined ? { contextWindowSource: selection.contextWindowSource } : {}),
    ...(selection.maxOutputTokens !== undefined ? { maxOutputTokens: selection.maxOutputTokens } : {}),
  };
}

function contextMaterial(record: AttemptContextRecord): Omit<AttemptContextRecord, 'contextHash'> {
  const { contextHash: _contextHash, ...material } = record;
  return material;
}

export function getAttemptContext(db: CoreDatabase, attemptId: string): AttemptContextRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM attempt_contexts WHERE attemptId = ?', [attemptId]);
  if (!row) throw new CoreError('context_missing', `attempt '${attemptId}' has no frozen context`);
  let context: AttemptContextRecord;
  try {
    context = rowToContext(row);
  } catch {
    throw new CoreError('context_mismatch', `frozen context is malformed for attempt '${attemptId}'`);
  }
  const attempt = db.get<{ requestId: string; kind: AttemptKind }>('SELECT requestId, kind FROM attempts WHERE id = ?', [attemptId]);
  if (!attempt) throw new CoreError('context_mismatch', `frozen context references missing attempt '${attemptId}'`);
  if (context.attemptId !== attemptId || context.requestId !== attempt.requestId || context.resolvedMode !== attempt.kind) {
    throw new CoreError('context_mismatch', `frozen context does not match attempt '${attemptId}'`);
  }
  if (context.schemaVersion !== ATTEMPT_CONTEXT_SCHEMA_VERSION || contextHashOf(contextMaterial(context)) !== context.contextHash) {
    throw new CoreError('context_mismatch', `frozen context hash mismatch for attempt '${attemptId}'`);
  }
  return context;
}

export function createAttemptContext(
  db: CoreDatabase,
  attemptId: string,
  request: RequestEnvelopeRecord,
  input: AttemptContextInput = {},
): AttemptContextRecord {
  const existing = db.get('SELECT id FROM attempt_contexts WHERE attemptId = ?', [attemptId]);
  if (existing) throw new CoreError('conflict', `attempt '${attemptId}' already has frozen context`);

  const id = newId('ctx');
  const contextIdentity = input.contextIdentity ?? id;
  const allowedTools = [...new Set(input.allowedTools ?? request.toolPermissionPolicy.allowedTools ?? [])].sort();
  const permittedCapabilities: AttemptPermittedCapabilities = {
    hasWorkspace: input.hasWorkspace ?? Boolean(input.workspaceRoot || request.repositoryId || request.repositoryLocationId),
    gitCapable: input.gitCapable ?? false,
    allowedTools,
    contextPolicy: normalizeContextPolicy(request.contextPolicy),
  };
  const material: Omit<AttemptContextRecord, 'contextHash'> = {
    id,
    contextIdentity,
    requestId: request.id,
    attemptId,
    resolvedMode: request.resolvedMode,
    workspaceRoot: input.workspaceRoot ?? null,
    repositoryId: request.repositoryId,
    repositoryLocationId: request.repositoryLocationId,
    taskInput: request.currentMessage,
    selectedProvider: firstNonBlank(input.selectedProvider, request.requestedProvider, DEFAULT_PROVIDER),
    selectedModel: firstNonBlank(input.selectedModel, request.requestedModel, process.env.KARKEDIKHA_DEFAULT_MODEL, DEFAULT_MODEL),
    ...(input.modelSelection ? { modelSelection: sanitizeModelSelectionWindow(input.modelSelection) } : {}),
    ...(input.repositoryContext ? { repositoryContext: normalizeRepositoryContext(input.repositoryContext) } : {}),
    ...(input.retryGuidance ? { retryGuidance: input.retryGuidance } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    permittedCapabilities,
    approvalPolicy: input.approvalPolicy ?? request.toolPermissionPolicy,
    schemaVersion: ATTEMPT_CONTEXT_SCHEMA_VERSION,
    createdAt: nowIso(),
  };
  const contextHash = contextHashOf(material);
  db.run(
    `INSERT INTO attempt_contexts (
       id, contextIdentity, requestId, attemptId, resolvedMode, workspaceRoot,
       repositoryId, repositoryLocationId, taskInput, selectedProvider,
       selectedModel, modelSelection, retryGuidance, permittedCapabilities,
       approvalPolicy, schemaVersion, createdAt, contextHash, attachments,
       repositoryContext
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      contextIdentity,
      request.id,
      attemptId,
      request.resolvedMode,
      material.workspaceRoot,
      request.repositoryId,
      request.repositoryLocationId,
      request.currentMessage,
      material.selectedProvider,
      material.selectedModel,
      material.modelSelection ? canonicalJson(material.modelSelection) : null,
      material.retryGuidance ?? null,
      canonicalJson(permittedCapabilities),
      canonicalJson(material.approvalPolicy),
      material.schemaVersion,
      material.createdAt,
      contextHash,
      material.attachments ? canonicalJson(material.attachments) : null,
      material.repositoryContext ? canonicalJson(material.repositoryContext) : null,
    ],
  );
  return getAttemptContext(db, attemptId);
}

export function normalizeRepositoryContext(input: RepositoryContextPackage): RepositoryContextPackage {
  const prompt = String(input.prompt ?? '');
  if (!prompt || prompt.length > REPOSITORY_CONTEXT_MAX_PROMPT_CHARS) {
    throw new CoreError('invalid_request', `repository context prompt must be non-empty and at most ${REPOSITORY_CONTEXT_MAX_PROMPT_CHARS} characters`);
  }
  if (!Array.isArray(input.selectedFiles) || input.selectedFiles.length > REPOSITORY_CONTEXT_MAX_SELECTED_FILES) {
    throw new CoreError('invalid_request', `repository context may identify at most ${REPOSITORY_CONTEXT_MAX_SELECTED_FILES} selected files`);
  }
  const selectedFiles = input.selectedFiles.map((file) => {
    const relativePath = String(file.path ?? '').replace(/\\/g, '/');
    if (!relativePath || relativePath.length > 500 || /^([A-Za-z]:|\/)/.test(relativePath) || relativePath.split('/').includes('..')) {
      throw new CoreError('invalid_request', 'repository context selected files must use bounded repository-relative paths');
    }
    const estimatedTokens = Number(file.estimatedTokens);
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0 || estimatedTokens > REPOSITORY_CONTEXT_MAX_ESTIMATED_TOKENS) {
      throw new CoreError('invalid_request', 'repository context file token estimates must be bounded non-negative numbers');
    }
    return { path: relativePath, estimatedTokens: Math.floor(estimatedTokens), ...(file.complete === true ? { complete: true } : {}) };
  });
  const estimatedTokens = Number(input.estimatedTokens);
  if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0 || estimatedTokens > REPOSITORY_CONTEXT_MAX_ESTIMATED_TOKENS) {
    throw new CoreError('invalid_request', 'repository context token estimate must be a bounded non-negative number');
  }
  const packageHash = input.packageHash === undefined ? undefined : String(input.packageHash);
  if (packageHash !== undefined && !/^[a-f0-9]{64}$/i.test(packageHash)) {
    throw new CoreError('invalid_request', 'repository context package hash must be SHA-256');
  }
  const computedHash = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  if (packageHash !== undefined && packageHash.toLowerCase() !== computedHash) {
    throw new CoreError('invalid_request', 'repository context package hash does not match its prompt');
  }
  return {
    prompt,
    selectedFiles,
    estimatedTokens: Math.floor(estimatedTokens),
    packageHash: computedHash,
  };
}

function normalizeContextPolicy(policy: ContextPolicy): ContextPolicy {
  return {
    includeConversationHistory: Boolean(policy.includeConversationHistory),
    includeProjectContext: Boolean(policy.includeProjectContext),
    includeRepositoryContext: Boolean(policy.includeRepositoryContext),
    includeGlobalStoryContext: Boolean(policy.includeGlobalStoryContext),
  };
}
