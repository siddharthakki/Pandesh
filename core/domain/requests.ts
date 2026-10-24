import type { CoreDatabase } from '../db/connection';
import type {
  RequestEnvelopeRecord,
  RequestedMode,
  ResolvedMode,
  ToolPermissionPolicy,
  ContextPolicy,
} from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

export interface CreateRequestInput {
  clientId: string;
  currentMessage: string;
  requestedMode: RequestedMode;
  resolvedMode: ResolvedMode;
  routeReason: string;
  conversationId?: string | null;
  storyId?: string | null;
  projectId?: string | null;
  repositoryId?: string | null;
  repositoryLocationId?: string | null;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  toolPermissionPolicy?: ToolPermissionPolicy;
  contextPolicy: ContextPolicy;
  correlationId: string;
  idempotencyKey?: string | null;
}

const MAX_MESSAGE_CHARS = 100_000;
const DEFAULT_TOOL_POLICY: ToolPermissionPolicy = {};

function rowToRequest(row: Record<string, unknown>): RequestEnvelopeRecord {
  return {
    id: String(row.id),
    createdAt: String(row.createdAt),
    clientId: String(row.clientId),
    currentMessage: String(row.currentMessage),
    requestedMode: row.requestedMode as RequestedMode,
    resolvedMode: row.resolvedMode as ResolvedMode,
    routeReason: String(row.routeReason),
    conversationId: (row.conversationId as string) ?? null,
    storyId: (row.storyId as string) ?? null,
    projectId: (row.projectId as string) ?? null,
    repositoryId: (row.repositoryId as string) ?? null,
    repositoryLocationId: (row.repositoryLocationId as string) ?? null,
    requestedProvider: (row.requestedProvider as string) ?? null,
    requestedModel: (row.requestedModel as string) ?? null,
    toolPermissionPolicy: JSON.parse(String(row.toolPermissionPolicy ?? '{}')),
    contextPolicy: JSON.parse(String(row.contextPolicy ?? '{}')),
    correlationId: String(row.correlationId),
    idempotencyKey: (row.idempotencyKey as string) ?? null,
  };
}

export function getRequest(db: CoreDatabase, id: string): RequestEnvelopeRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM requests WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `request '${id}' not found`);
  return rowToRequest(row);
}

/**
 * Creates one canonical immutable request envelope. There is deliberately no
 * update route for this table — routing/execution metadata that changes over
 * time belongs on linked attempt/event records, per the M32 request-envelope
 * contract (docs/m32-architecture.md, docs/m32-decisions.md D2).
 */
export function createRequest(db: CoreDatabase, input: CreateRequestInput): RequestEnvelopeRecord {
  const message = input.currentMessage?.trim();
  if (!message) throw new CoreError('invalid_request', 'currentMessage is required');
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new CoreError('invalid_request', `currentMessage exceeds ${MAX_MESSAGE_CHARS} characters`);
  }
  if (input.requestedMode !== 'auto' && input.requestedMode !== input.resolvedMode) {
    throw new CoreError('invalid_request', 'resolvedMode must equal requestedMode unless requestedMode is auto');
  }

  return db.transaction(() => {
    if (input.conversationId) {
      const conversation = db.get('SELECT id FROM conversations WHERE id = ?', [input.conversationId]);
      if (!conversation) throw new CoreError('invalid_request', `conversation '${input.conversationId}' does not exist`);
    }
    if (input.storyId) {
      const story = db.get('SELECT id FROM stories WHERE id = ?', [input.storyId]);
      if (!story) throw new CoreError('invalid_request', `story '${input.storyId}' does not exist`);
    }
    const id = newId('req');
    const now = nowIso();
    db.run(
      `INSERT INTO requests (
         id, createdAt, clientId, currentMessage, requestedMode, resolvedMode, routeReason,
         conversationId, storyId, projectId, repositoryId, repositoryLocationId,
         requestedProvider, requestedModel, toolPermissionPolicy, contextPolicy, correlationId, idempotencyKey
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        input.clientId,
        message,
        input.requestedMode,
        input.resolvedMode,
        input.routeReason,
        input.conversationId ?? null,
        input.storyId ?? null,
        input.projectId ?? null,
        input.repositoryId ?? null,
        input.repositoryLocationId ?? null,
        input.requestedProvider ?? null,
        input.requestedModel ?? null,
        JSON.stringify(input.toolPermissionPolicy ?? DEFAULT_TOOL_POLICY),
        JSON.stringify(input.contextPolicy),
        input.correlationId,
        input.idempotencyKey ?? null,
      ],
    );
    recordRuntimeEvent(db, {
      domain: 'request',
      entityId: id,
      eventType: 'request_created',
      actor: input.clientId,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: { requestedMode: input.requestedMode, resolvedMode: input.resolvedMode, routeReason: input.routeReason },
    });
    return getRequest(db, id);
  });
}
