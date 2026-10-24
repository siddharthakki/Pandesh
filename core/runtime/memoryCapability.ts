/**
 * M39 — Core-owned governed memory capability adapter.
 *
 * Registered in the existing `GovernedCapabilityRegistry` beside the M38
 * workspace/research/GitHub adapters, so every memory tool call travels the
 * exact same path: model tool call -> ToolExecutor/RuntimeExecutor ->
 * `POST /v1/capabilities/dispatch` -> capability classification -> the
 * existing 'mutation' approval envelope -> the existing approval restoration
 * -> the existing `tool_invocations` evidence -> this adapter -> one Core
 * SQLite domain transaction (`core/domain/memory.ts`).
 *
 * There is deliberately NO `memory_approvals` table, no second approval-card
 * protocol, and no memory-owned runtime. Consequential memory operations
 * (`memory_remember`, `memory_forget`, `memory_resolve_contradiction`) are
 * classified 'consequential' and therefore inherit the existing capability
 * mutation approval as their explicit user-consent step; read-only ones
 * (`memory_recall`, `memory_impact`, `memory_export`) run without one.
 */
import type { CoreDatabase } from '../db/connection';
import type { ModelToolDefinition, ModelToolCall } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from './toolRunner';
import type { CapabilityHealth, GovernedCapabilityAdapter } from './governedCapability';
import { CoreError } from '../domain/errors';
import {
  KNOWLEDGE_ENTITY_TYPES,
  KNOWLEDGE_RELATIONSHIP_TYPES,
  MAX_AFFECTED_ENTITIES,
  MAX_PREDICATE_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_VALUE_CHARS,
  MEMORY_RESOLUTION_POLICIES,
  MEMORY_SCOPE_TYPES,
  MEMORY_SENSITIVITIES,
  MEMORY_TYPES,
  analyzeMemoryImpact,
  exportMemory,
  forgetMemory,
  recallMemories,
  redactMemoryArguments,
  rememberMemory,
  resolveMemoryContradiction,
} from '../domain/memory';
import type { AffectedEntityInput } from '../domain/memory';

export const MEMORY_CAPABILITY_ID = 'memory';

export const MEMORY_CONSEQUENTIAL_TOOLS = ['memory_remember', 'memory_resolve_contradiction', 'memory_forget'] as const;
export const MEMORY_READ_ONLY_TOOLS = ['memory_recall', 'memory_impact', 'memory_export'] as const;
export const MEMORY_TOOL_NAMES: readonly string[] = [...MEMORY_CONSEQUENTIAL_TOOLS, ...MEMORY_READ_ONLY_TOOLS];

/** Bounded, and comfortably under `tool_invocations`' durable evidence bound
 * so a memory result is stored complete rather than replaced by a truncation
 * marker. */
const MAX_OUTPUT_CHARS = 32_000;

function bound(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

/**
 * Structured results are NEVER truncated mid-JSON: a half-serialized payload
 * is unparseable both for the model and for the product UI that renders the
 * evidence. An oversized result is replaced by a smaller, still-valid JSON
 * object that says so — the complete record always remains queryable from
 * Core's own tables.
 */
function ok(payload: unknown, resultCategory: string, normalizedArguments: Record<string, unknown>): ToolExecutionResult {
  const json = JSON.stringify(payload);
  const output = json.length <= MAX_OUTPUT_CHARS
    ? json
    : JSON.stringify({
      truncated: true,
      originalChars: json.length,
      resultCategory,
      note: 'The result exceeded the governed memory result bound; narrow the query (scope, subject, or memoryId) to retrieve it.',
    });
  return { status: 'succeeded', exitCode: 0, output, resultCategory, normalizedArguments };
}

function fail(message: string, resultCategory: string, normalizedArguments: Record<string, unknown>): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output: bound(message), resultCategory, normalizedArguments };
}

function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function parseAffectedEntities(raw: unknown): AffectedEntityInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CoreError('invalid_request', 'affectedEntities must be an array');
  if (raw.length > MAX_AFFECTED_ENTITIES) {
    throw new CoreError('invalid_request', `affectedEntities must contain at most ${MAX_AFFECTED_ENTITIES} entries`);
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CoreError('invalid_request', 'each affectedEntities entry must be an object');
    }
    const record = entry as Record<string, unknown>;
    return {
      type: asString(record.type) as AffectedEntityInput['type'],
      canonicalKey: asString(record.canonicalKey ?? record.key),
      label: record.label === undefined ? undefined : asString(record.label),
      relationship: record.relationship === undefined ? undefined : asString(record.relationship) as AffectedEntityInput['relationship'],
    };
  });
}

/**
 * The durable evidence source for a remembered fact. The model may name a
 * conversation/message explicitly, but the default — and the one the packaged
 * product uses — is Core resolving the correlated conversation's latest user
 * message itself. Core always re-reads the source row and computes the hash;
 * a caller-supplied hash is never accepted.
 */
function resolveSource(
  db: CoreDatabase,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): { conversationId: string; messageId: string } {
  const conversationId = asString(args.sourceConversationId) || asString(ctx.correlationId);
  if (!conversationId) {
    throw new CoreError('invalid_request', 'memory_remember could not resolve a durable source conversation');
  }
  const messageId = asString(args.sourceMessageId);
  if (messageId) return { conversationId, messageId };
  const latest = db.get<{ id: string }>(
    "SELECT id FROM conversation_messages WHERE conversationId = ? AND role = 'user' ORDER BY seq DESC LIMIT 1",
    [conversationId],
  );
  if (!latest) {
    throw new CoreError('invalid_request', `no durable user message exists in conversation '${conversationId}' to evidence this memory`);
  }
  return { conversationId, messageId: latest.id };
}

const definitions: ModelToolDefinition[] = [
  {
    name: 'memory_remember',
    description:
      'Durably remember one explicitly authorized fact or decision, with source evidence, scope, and sensitivity. '
      + 'Consequential — the user must approve the exact proposed memory before anything is written. '
      + 'Never call this for ordinary conversation; only when the user has asked for something to be remembered.',
    parameters: {
      type: 'object',
      properties: {
        memoryType: { type: 'string', enum: [...MEMORY_TYPES], description: 'Kind of memory being written.' },
        scopeType: { type: 'string', enum: [...MEMORY_SCOPE_TYPES], description: 'What the memory is scoped to.' },
        scopeId: { type: 'string', maxLength: 200, description: 'Concrete owning scope, e.g. the project name.' },
        subject: { type: 'string', maxLength: MAX_SUBJECT_CHARS, description: 'What the fact is about.' },
        predicate: { type: 'string', maxLength: MAX_PREDICATE_CHARS, description: 'The property being asserted.' },
        value: { type: 'string', maxLength: MAX_VALUE_CHARS, description: 'The asserted value.' },
        sensitivity: { type: 'string', enum: [...MEMORY_SENSITIVITIES], description: 'Sensitivity classification.' },
        sourceConversationId: { type: 'string', maxLength: 100, description: 'Optional durable Core conversation id; Core resolves the correlated conversation when omitted.' },
        sourceMessageId: { type: 'string', maxLength: 100, description: 'Optional durable Core message id; Core resolves the latest user message when omitted.' },
        expiresAt: { type: 'string', maxLength: 40, description: 'Optional ISO-8601 expiry.' },
        affectedEntities: {
          type: 'array',
          maxItems: MAX_AFFECTED_ENTITIES,
          description: 'Repository files, GitHub issues, and product records this decision affects.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: [...KNOWLEDGE_ENTITY_TYPES] },
              canonicalKey: { type: 'string', maxLength: 300, description: 'Repository-relative path, owner/repository#number, or a Core project/product-request/story identity.' },
              label: { type: 'string', maxLength: 200 },
              relationship: { type: 'string', enum: [...KNOWLEDGE_RELATIONSHIP_TYPES] },
            },
            required: ['type', 'canonicalKey'],
          },
        },
      },
      required: ['memoryType', 'scopeType', 'scopeId', 'subject', 'predicate', 'value', 'sensitivity'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Retrieve durable remembered facts for a scope, with their evidence and any unresolved contradictions. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        scopeType: { type: 'string', enum: [...MEMORY_SCOPE_TYPES] },
        scopeId: { type: 'string', maxLength: 200 },
        subject: { type: 'string', maxLength: MAX_SUBJECT_CHARS },
        predicate: { type: 'string', maxLength: MAX_PREDICATE_CHARS },
        includeHistorical: { type: 'boolean', description: 'Include historical/expired facts as well as active ones.' },
      },
      required: [],
    },
  },
  {
    name: 'memory_resolve_contradiction',
    description: 'Resolve a detected contradiction between two remembered facts using an explicit policy. Consequential — requires approval. Both facts are always preserved.',
    parameters: {
      type: 'object',
      properties: {
        contradictionId: { type: 'string', maxLength: 100 },
        policy: { type: 'string', enum: [...MEMORY_RESOLUTION_POLICIES] },
      },
      required: ['contradictionId', 'policy'],
    },
  },
  {
    name: 'memory_impact',
    description: 'Identify the repository files, GitHub issues, and product records a remembered decision affects, with relationship paths and evidence. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', maxLength: 100 },
        entityId: { type: 'string', maxLength: 100 },
        maxDepth: { type: 'number', description: 'Bounded traversal depth (1-4).' },
      },
      required: [],
    },
  },
  {
    name: 'memory_export',
    description: 'Export an auditable JSON representation of remembered facts, their evidence chain, contradictions, entities, and relationships. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', maxLength: 100 },
        scopeType: { type: 'string', enum: [...MEMORY_SCOPE_TYPES] },
        scopeId: { type: 'string', maxLength: 200 },
      },
      required: [],
    },
  },
  {
    name: 'memory_forget',
    description: 'Forget (tombstone) one remembered fact so it is no longer recalled as active. Consequential — requires approval. The governed deletion itself remains auditable.',
    parameters: {
      type: 'object',
      properties: { memoryId: { type: 'string', maxLength: 100 } },
      required: ['memoryId'],
    },
  },
];

export interface MemoryCapabilityOptions {
  db: CoreDatabase;
  actor?: string;
}

export function createMemoryCapabilityAdapter(options: MemoryCapabilityOptions): GovernedCapabilityAdapter {
  const db = options.db;
  const actor = options.actor ?? 'core:memory';
  const health: CapabilityHealth = { state: 'available', checkedAt: new Date().toISOString() };

  async function run(call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    // Every result echoes REDACTED arguments so a secret can never reach
    // `tool_invocations.evidence` even on the failure path.
    const safeArgs = redactMemoryArguments(args);
    // Cancellation must fence the write before it is attempted: an adapter
    // that observes an aborted signal performs zero M39 writes.
    if (ctx.signal?.aborted) {
      return fail('memory action was cancelled before any durable write occurred', 'memory_cancelled', safeArgs);
    }
    try {
      switch (call.name) {
        case 'memory_remember': {
          const source = resolveSource(db, args, ctx);
          const result = rememberMemory(db, {
            memoryType: asString(args.memoryType) as never,
            scopeType: asString(args.scopeType) as never,
            scopeId: asString(args.scopeId),
            subject: asString(args.subject),
            predicate: asString(args.predicate),
            value: asString(args.value),
            sensitivity: asString(args.sensitivity) as never,
            sourceConversationId: source.conversationId,
            sourceMessageId: source.messageId,
            expiresAt: args.expiresAt === undefined ? null : asString(args.expiresAt) || null,
            affectedEntities: parseAffectedEntities(args.affectedEntities),
            consentApprovalId: ctx.approvalId ?? null,
            toolInvocationId: ctx.invocationId ?? null,
            attemptId: ctx.attemptId ?? null,
            actor,
          });
          return ok({
            memoryId: result.memory.id,
            deduplicated: result.deduplicated,
            memory: result.memory,
            evidence: result.evidence,
            entities: result.entities,
            relationships: result.relationships,
            contradictions: result.contradictions,
            redaction: result.redaction,
          }, result.deduplicated ? 'memory_remember_deduplicated' : 'memory_remember_succeeded', safeArgs);
        }
        case 'memory_recall': {
          const result = recallMemories(db, {
            scopeType: args.scopeType === undefined ? undefined : asString(args.scopeType) as never,
            scopeId: args.scopeId === undefined ? undefined : asString(args.scopeId),
            subject: args.subject === undefined ? undefined : asString(args.subject),
            predicate: args.predicate === undefined ? undefined : asString(args.predicate),
            includeHistorical: Boolean(args.includeHistorical),
          });
          return ok(result, 'memory_recall_succeeded', safeArgs);
        }
        case 'memory_resolve_contradiction': {
          const result = resolveMemoryContradiction(db, {
            contradictionId: asString(args.contradictionId),
            policy: asString(args.policy) as never,
            approvalId: ctx.approvalId ?? null,
            toolInvocationId: ctx.invocationId ?? null,
            actor,
          });
          return ok(result, result.alreadyResolved ? 'memory_resolution_deduplicated' : 'memory_resolution_succeeded', safeArgs);
        }
        case 'memory_impact': {
          const result = analyzeMemoryImpact(db, {
            memoryId: args.memoryId === undefined ? undefined : asString(args.memoryId),
            entityId: args.entityId === undefined ? undefined : asString(args.entityId),
            maxDepth: args.maxDepth === undefined ? undefined : Number(args.maxDepth),
          });
          return ok(result, 'memory_impact_succeeded', safeArgs);
        }
        case 'memory_export': {
          const result = exportMemory(db, {
            memoryId: args.memoryId === undefined ? undefined : asString(args.memoryId),
            scopeType: args.scopeType === undefined ? undefined : asString(args.scopeType) as never,
            scopeId: args.scopeId === undefined ? undefined : asString(args.scopeId),
          });
          return ok(result, 'memory_export_succeeded', safeArgs);
        }
        case 'memory_forget': {
          const result = forgetMemory(db, {
            memoryId: asString(args.memoryId),
            approvalId: ctx.approvalId ?? null,
            toolInvocationId: ctx.invocationId ?? null,
            actor,
          });
          return ok(result, result.alreadyForgotten ? 'memory_forget_deduplicated' : 'memory_forget_succeeded', safeArgs);
        }
        default:
          return fail(`unknown memory tool '${call.name}'`, 'memory_invalid_arguments', safeArgs);
      }
    } catch (error) {
      const message = error instanceof CoreError || error instanceof Error ? error.message : String(error);
      const category = error instanceof CoreError && error.code === 'not_found' ? 'memory_not_found' : 'memory_invalid_arguments';
      // The message itself is redacted: a validation failure must never echo
      // a raw secret back into durable tool evidence.
      return fail(redactMemoryArguments({ message }).message as string, category, safeArgs);
    }
  }

  return {
    id: MEMORY_CAPABILITY_ID,
    definitions: () => definitions,
    classify: (toolName) => ((MEMORY_CONSEQUENTIAL_TOOLS as readonly string[]).includes(toolName) ? 'consequential' : 'read_only'),
    health: () => health,
    // Applied by `dispatchCapability` before the approval summary and the
    // `tool_invocations.argsSummary` are written, so a raw secret never lands
    // in the approval envelope or in governed evidence.
    redactArguments: (_toolName, args) => redactMemoryArguments(args),
    run,
  };
}
