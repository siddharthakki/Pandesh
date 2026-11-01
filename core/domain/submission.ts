import type { CoreDatabase } from '../db/connection';
import type {
  AttemptRecord,
  ExecutionCapabilityRequirements,
  ModelSelectionEvidence,
  RepositoryContextPackage,
  RequestEnvelopeRecord,
  RequestedMode,
  ResolvedMode,
  ToolPermissionPolicy,
} from '../shared/wireTypes';
import { MAX_ATTACHMENTS_PER_TURN } from '../shared/wireTypes';
import { CoreError } from './errors';
import { classifyRequest, type RepositoryCapabilityHint } from './routing';
import { buildContextPolicy } from './contextPolicy';
import { createRequest, getRequest } from './requests';
import { createAttempt, getAttempt } from './attempts';
import { recordExecutionQuality } from './executionQuality';
import { appendMessage } from './conversations';
import { recordConversationTurn } from './conversationLedger';
import { linkAttachmentsToMessage } from './attachments';
import { routeModel } from './modelRouting';
import { contextWindowEventMetadata, getAttemptContext, sanitizeModelSelectionWindow } from './attemptContext';
import type { InstalledModelsCatalog } from '../runtime/ollamaCatalog';

/**
 * The conversation modes that may receive a caller-supplied bounded
 * repository package. Deliberately an explicit allowlist rather than a
 * negated guard: Baat Kar grounds read-only answers in it, and Saath Kar
 * needs the same evidence to find the right file and the surrounding
 * conventions before proposing a change. Karke Dikha is excluded — it builds
 * its own story/repository evidence through its own lifecycle — and no future
 * mode is admitted here by accident.
 */
const REPOSITORY_CONTEXT_MODES: ReadonlySet<ResolvedMode> = new Set<ResolvedMode>(['baat_kar', 'saath_kar']);

export interface SubmitRequestInput {
  clientId: string;
  currentMessage: string;
  /** May be `'auto'` — the server (not the caller) then owns routing. */
  requestedMode: RequestedMode;
  conversationId?: string | null;
  storyId?: string | null;
  projectId?: string | null;
  repositoryId?: string | null;
  repositoryLocationId?: string | null;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  workspaceRoot?: string | null;
  selectedProvider?: string | null;
  selectedModel?: string | null;
  modelSelection?: ModelSelectionEvidence;
  installedModelsCatalog?: InstalledModelsCatalog;
  /** The user's explicit context window for a Core-routed (Auto) attempt. */
  contextWindowOverrideTokens?: number;
  repositoryContext?: RepositoryContextPackage;
  effectiveAllowedTools?: string[];
  toolPermissionPolicy?: ToolPermissionPolicy;
  capability?: RepositoryCapabilityHint;
  correlationId: string;
  idempotencyKey?: string | null;
  /** M36: stable, already-`ready` attachment ids for this turn (max 5). Requires
   * `conversationId` — attachments are always conversation-scoped. Appending the
   * user message, linking these attachments to it, creating the request, and
   * creating the first attempt all happen in this one transaction so a message
   * can never be durably appended without its attachment links and attempt. */
  attachmentIds?: string[];
  /** M36 regeneration reuses an already durable user message rather than
   * appending a duplicate.  Only Core may supply this through its narrow
   * regenerate route. */
  reuseUserMessageId?: string | null;
  regenerateAssistantMessageId?: string | null;
}

export interface SubmitRequestResult {
  request: RequestEnvelopeRecord;
  attempt: AttemptRecord;
  planningOnly: boolean;
  messageId: string | null;
  /** True when no new attempt was created: the objective already has a live attempt, which is returned instead. */
  duplicateOfActiveAttempt?: boolean;
  /**
   * The model selection frozen into the attempt's context. Callers that need
   * to know the actually-routed model synchronously (e.g. Desktop's cockpit
   * display for Auto routing) must read it from here rather than waiting on
   * the `model_selection_decided` runtime event, which is broadcast before
   * this HTTP response is sent and can arrive at a client-side listener
   * before it has finished attaching itself to the new attempt.
   */
  modelSelection: ModelSelectionEvidence;
}

const LIVE_ATTEMPT_STATUSES = ['created', 'queued', 'running', 'waiting_for_approval', 'validating', 'paused', 'blocked', 'cancelling', 'recovery_required'];

/** The newest still-active attempt of this conversation for the same mode/workspace/objective, if any. */
export function findActiveDuplicateAttempt(
  db: CoreDatabase,
  key: { conversationId: string; resolvedMode: string; currentMessage: string; workspaceRoot: string | null },
): { id: string; requestId: string; userMessageId: string | null } | undefined {
  const rows = db.all<{ id: string; requestId: string; userMessageId: string | null; workspaceRoot: string | null }>(
    `SELECT a.id AS id, a.requestId AS requestId, t.userMessageId AS userMessageId, c.workspaceRoot AS workspaceRoot
       FROM attempts a
       JOIN requests r ON r.id = a.requestId
       JOIN conversation_turns t ON t.requestId = a.requestId
       LEFT JOIN attempt_contexts c ON c.attemptId = a.id
      WHERE r.conversationId = ? AND r.resolvedMode = ? AND r.currentMessage = ?
        AND a.status IN (${LIVE_ATTEMPT_STATUSES.map(() => '?').join(',')})
      ORDER BY a.createdAt DESC`,
    [key.conversationId, key.resolvedMode, key.currentMessage, ...LIVE_ATTEMPT_STATUSES],
  );
  return rows.find(row => (row.workspaceRoot ?? null) === key.workspaceRoot);
}

/**
 * The one atomic Core submission path (audit correction points 1–5, F1/F5).
 *
 * Before this, a caller made two independent round-trips — `POST
 * /v1/routing/classify` to get a suggestion, then `POST /v1/requests` with
 * client-supplied `resolvedMode`/`routeReason`/`contextPolicy` that `/v1/requests`
 * trusted outright — followed by a third `POST /v1/attempts` call. Nothing
 * stopped a caller from skipping classification, sending a stale or
 * self-chosen `resolvedMode`, or creating a request with no attempt at all.
 * `submitRequest` collapses all of it into one function, one DB transaction:
 * classify (only when `requestedMode` is `'auto'` — an explicit non-auto mode
 * is honored as-is, which is the documented override mechanism, not a bypass),
 * derive the context policy, create the immutable request, create its first
 * attempt. Callers get back one canonical `{ request, attempt }` result or
 * nothing is created at all.
 *
 * `capability` (workspace/git) is accepted from the caller, not independently
 * derived here — Core does not yet have its own filesystem/git probe (that is
 * still a client-reported hint, same as the pre-existing `/v1/routing/classify`
 * contract). Making capability itself Core-derived is unfinished follow-up
 * work, tracked in docs/m32-progress.md, not silently claimed as done here.
 */
export function submitRequest(db: CoreDatabase, input: SubmitRequestInput): SubmitRequestResult {
  return db.transaction(() => {
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_TURN) {
      throw new CoreError('invalid_request', `a turn may include at most ${MAX_ATTACHMENTS_PER_TURN} attachments`);
    }
    if (attachmentIds.length > 0 && !input.conversationId) {
      throw new CoreError('invalid_request', 'attachmentIds requires conversationId — attachments are conversation-scoped');
    }
    if ((input.reuseUserMessageId || input.regenerateAssistantMessageId) && !input.conversationId) {
      throw new CoreError('invalid_request', 'regeneration requires a durable conversation');
    }
    if (input.reuseUserMessageId && attachmentIds.length > 0) {
      throw new CoreError('invalid_request', 'regeneration reuses frozen attachment evidence and cannot add attachments');
    }

    const decision =
      input.requestedMode === 'auto'
        ? classifyRequest(input.currentMessage, input.capability)
        : { resolvedMode: input.requestedMode, routeReason: 'explicit mode requested by caller', planningOnly: false };

    if (input.requestedMode !== 'auto' && !isResolvedMode(input.requestedMode)) {
      throw new CoreError('invalid_request', `requestedMode '${input.requestedMode}' is not a resolvable mode`);
    }
    if (input.repositoryContext && !REPOSITORY_CONTEXT_MODES.has(decision.resolvedMode)) {
      throw new CoreError('invalid_request', `supplemental repository context is not supported for '${decision.resolvedMode}'`);
    }
    if (input.repositoryContext && (!input.workspaceRoot || input.capability?.hasWorkspace === false)) {
      throw new CoreError('invalid_request', 'supplemental repository context requires an available workspace identity');
    }

    // Duplicate-attempt guard. Hydration, history selection, replay, reload and a double UI dispatch all re-submit a
    // turn whose attempt is STILL ACTIVE. The authoritative identity is the conversation's live attempt (same mode,
    // workspace and objective), not text alone: a terminal attempt never blocks, and an explicit regenerate/retry
    // goes through its own path (`reuseUserMessageId` / `retryAttempt`), so Run again stays legitimate.
    if (input.conversationId && !input.reuseUserMessageId && !input.regenerateAssistantMessageId) {
      const live = findActiveDuplicateAttempt(db, {
        conversationId: input.conversationId, resolvedMode: decision.resolvedMode,
        currentMessage: input.currentMessage, workspaceRoot: input.workspaceRoot ?? null,
      });
      if (live) {
        const request = getRequest(db, live.requestId);
        return {
          request, attempt: getAttempt(db, live.id), planningOnly: decision.planningOnly,
          messageId: live.userMessageId, modelSelection: getAttemptContext(db, live.id).modelSelection as ModelSelectionEvidence,
          duplicateOfActiveAttempt: true,
        };
      }
    }

    const contextPolicy = buildContextPolicy(decision.resolvedMode, {
      hasConversation: Boolean(input.conversationId),
      hasRepository: decision.resolvedMode === 'baat_kar'
        ? Boolean(input.repositoryContext)
        : input.capability?.hasWorkspace !== false,
      hasStory: Boolean(input.storyId),
    });

    const request = createRequest(db, {
      clientId: input.clientId,
      currentMessage: input.currentMessage,
      requestedMode: input.requestedMode,
      resolvedMode: decision.resolvedMode,
      routeReason: decision.routeReason,
      conversationId: input.conversationId ?? null,
      storyId: input.storyId ?? null,
      projectId: input.projectId ?? null,
      repositoryId: input.repositoryId ?? null,
      repositoryLocationId: input.repositoryLocationId ?? null,
      requestedProvider: input.requestedProvider ?? null,
      requestedModel: input.requestedModel ?? null,
      toolPermissionPolicy: input.toolPermissionPolicy ?? {},
      contextPolicy,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    const selectedProvider = input.selectedProvider ?? input.modelSelection?.selectedProvider ?? input.requestedProvider ?? null;
    const selectedModel = input.selectedModel ?? input.modelSelection?.selectedModel ?? input.requestedModel ?? null;
    const isAutoSelection = !selectedProvider && !selectedModel && !input.modelSelection;
    // The frozen window is sanitized here so the event and the frozen context agree.
    const modelSelection = sanitizeModelSelectionWindow(input.modelSelection ?? (
      isAutoSelection && input.installedModelsCatalog
        ? routeModel(decision.resolvedMode, input.toolPermissionPolicy?.profile, input.installedModelsCatalog, {
            contextWindowOverrideTokens: input.contextWindowOverrideTokens,
          })
        : legacySelectionEvidence(
            decision.resolvedMode,
            selectedProvider ?? 'ollama',
            selectedModel ?? process.env.KARKEDIKHA_DEFAULT_MODEL ?? 'qwen2.5-coder:1.5b',
            Boolean(input.requestedModel),
          )
    ));
    if (
      (selectedProvider && modelSelection.selectedProvider !== selectedProvider)
      || (selectedModel && modelSelection.selectedModel !== selectedModel)
    ) {
      throw new CoreError('invalid_request', 'model-selection evidence does not match the selected provider/model');
    }

    // M36: append the user message, link its attachments, and freeze their
    // ids/hashes into the attempt context — all inside this one transaction,
    // so a message can never durably exist without its attachment links and
    // its attempt (the exact partial-state gap docs/m36-gap-map.md flags).
    let messageId: string | null = null;
    let frozenAttachments: ReturnType<typeof linkAttachmentsToMessage> = [];
    if (input.conversationId && input.reuseUserMessageId) {
      const existing = db.get<{ id: string; role: string; content: string }>('SELECT id, role, content FROM conversation_messages WHERE id = ?', [input.reuseUserMessageId]);
      if (!existing || existing.role !== 'user' || !listMessagesForConversation(db, input.conversationId).some(message => message.id === existing.id)) {
        throw new CoreError('not_found', 'the response regeneration user turn is not available in this conversation');
      }
      messageId = existing.id;
    } else if (input.conversationId) {
      const message = appendMessage(db, input.conversationId, {
        role: 'user',
        content: input.currentMessage,
        actor: input.clientId,
        clientId: input.clientId,
      });
      messageId = message.id;
      if (attachmentIds.length > 0) {
        frozenAttachments = linkAttachmentsToMessage(db, messageId, input.conversationId, attachmentIds);
      }
    }
    const hasImageAttachment = frozenAttachments.some((attachment) => attachment.kind === 'image');
    if (hasImageAttachment && !modelSelection.requiredCapabilities.vision) {
      throw new CoreError(
        'invalid_request',
        'this turn includes an image attachment and requires a vision-capable model selection; refusing to fall back to text-only processing',
      );
    }

    const attempt = createAttempt(db, {
      requestId: request.id,
      kind: decision.resolvedMode,
      actor: input.clientId,
      clientId: input.clientId,
      context: {
        // Workspace identity is retained for activation correlation in every
        // mode. Baat Kar still receives no repository context because its
        // frozen contextPolicy excludes it; identity is not content access.
        workspaceRoot: input.workspaceRoot ?? null,
        selectedProvider: modelSelection.selectedProvider,
        selectedModel: modelSelection.selectedModel,
        modelSelection,
        ...(input.repositoryContext ? { repositoryContext: input.repositoryContext } : {}),
        ...(frozenAttachments.length > 0 ? { attachments: frozenAttachments } : {}),
        hasWorkspace: input.capability?.hasWorkspace ?? Boolean(input.workspaceRoot),
        gitCapable: input.capability?.gitCapable ?? false,
        allowedTools:
          decision.resolvedMode === 'saath_kar'
            ? input.effectiveAllowedTools ?? input.toolPermissionPolicy?.allowedTools
            : input.toolPermissionPolicy?.allowedTools ?? [],
        approvalPolicy: input.toolPermissionPolicy ?? {},
      },
    });
    if (input.conversationId) {
      recordConversationTurn(db, {
        conversationId: input.conversationId,
        requestId: request.id,
        attemptId: attempt.id,
        userMessageId: messageId,
        mode: decision.resolvedMode,
        createdAt: request.createdAt,
        titleCandidate: input.currentMessage,
      });
    }

    if (input.regenerateAssistantMessageId) {
      const original = db.get<{ id: string; role: string }>('SELECT id, role FROM conversation_messages WHERE id = ?', [input.regenerateAssistantMessageId]);
      if (!original || original.role !== 'assistant' || !messageId) {
        throw new CoreError('not_found', 'the assistant response to regenerate is unavailable');
      }
      db.run(
        'INSERT INTO regeneration_requests (attemptId, conversationId, originalAssistantMessageId, userMessageId, createdAt) VALUES (?, ?, ?, ?, ?)',
        [attempt.id, input.conversationId, original.id, messageId, new Date().toISOString()],
      );
    }

    recordExecutionQuality(db, attempt.id, {
      eventType: 'model_selection_decided',
      actor: input.clientId,
      clientId: input.clientId,
      idempotencyKey: `model-selection:${attempt.id}`,
      metadata: {
        requiredCapabilities: modelSelection.requiredCapabilities,
        selectedProvider: modelSelection.selectedProvider,
        selectedModel: modelSelection.selectedModel,
        selectionReason: modelSelection.selectionReason,
        suitabilitySummary: modelSelection.suitabilitySummary,
        userOverrode: modelSelection.userOverrode,
        escalationCandidates: modelSelection.escalationCandidates,
        ...contextWindowEventMetadata(modelSelection),
      },
    });

    return { request, attempt, planningOnly: decision.planningOnly, messageId, modelSelection };
  });
}

function listMessagesForConversation(db: CoreDatabase, conversationId: string): Array<{ id: string }> {
  // Keep the regeneration authorization in the submission transaction.  This
  // mirrors the ancestry projection without importing the workbench module.
  return db.all<{ id: string }>(
    `WITH RECURSIVE lineage(conversationId, branchPointMessageId, depth) AS (
       SELECT ? AS conversationId, NULL AS branchPointMessageId, 0
       UNION ALL
       SELECT b.parentConversationId, b.branchPointMessageId, lineage.depth + 1
       FROM conversation_branches b JOIN lineage ON b.conversationId = lineage.conversationId WHERE lineage.depth < 32
     )
     SELECT m.id FROM conversation_messages m JOIN lineage l ON l.conversationId = m.conversationId
     WHERE l.depth = 0 OR m.seq <= (SELECT seq FROM conversation_messages WHERE id = l.branchPointMessageId)`,
    [conversationId],
  );
}

function legacySelectionEvidence(
  mode: 'baat_kar' | 'saath_kar' | 'karke_dikha',
  provider: string,
  model: string,
  userOverrode: boolean,
): ModelSelectionEvidence {
  const requiredCapabilities: ExecutionCapabilityRequirements = {
    readOnlyExplanation: mode === 'baat_kar',
    repositoryExploration: mode !== 'baat_kar',
    toolCalling: mode === 'saath_kar',
    fileModification: mode === 'karke_dikha',
    codingComplexity: mode === 'karke_dikha' ? 'medium' : mode === 'saath_kar' ? 'low' : 'none',
    contextRequirement: mode === 'karke_dikha' ? 'large' : mode === 'saath_kar' ? 'medium' : 'small',
    vision: false,
    validationAndRepair: mode === 'karke_dikha',
  };
  return {
    requiredCapabilities,
    selectedProvider: provider,
    selectedModel: model,
    selectionReason: userOverrode ? 'User selected this configured model.' : 'Selected from the configured model for this mode.',
    suitabilitySummary: mode === 'karke_dikha'
      ? 'Using a coding model suited to this task'
      : mode === 'saath_kar'
        ? 'Using a tool-capable model suited to this task'
        : 'Using a conversational model suited to this task',
    userOverrode,
    candidates: [{ provider, model, available: true, capable: true, costRank: 0, rejectionReasons: [] }],
    escalationCandidates: [],
  };
}

function isResolvedMode(mode: RequestedMode): mode is 'baat_kar' | 'saath_kar' | 'karke_dikha' {
  return mode === 'baat_kar' || mode === 'saath_kar' || mode === 'karke_dikha';
}
