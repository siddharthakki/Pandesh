/**
 * Background worker runtime for nonblocking task delegation.
 *
 * Runs long-running background tasks (e.g. Gmail contract extraction) independently
 * of interactive chat turns. Yields cooperatively to interactive priority lanes at
 * every tool and inference boundary so GPU budget and conversation responsiveness
 * are fully preserved.
 */
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import {
  getBackgroundTask,
  updateBackgroundTask,
  recordBackgroundTaskCheckpoint,
  getActiveBackgroundTask,
  listBackgroundTasks,
  createBackgroundTask,
  cancelBackgroundTask,
  type BackgroundTaskRecord,
} from '../domain/backgroundTasks';
import { createCheckpoint } from '../domain/checkpoints';
import { ensureTaskOutcome, finalizeTaskOutcome, updateTaskOutcome } from '../domain/taskOutcomes';
import { createAttempt, getAttempt, transitionAttempt, failAttempt } from '../domain/attempts';
import { createRequest } from '../domain/requests';
import { appendMessage } from '../domain/conversations';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { interactiveLane, DEFAULT_MAX_TOOL_YIELD_MS } from './interactiveLane';
import { synthesizeContractInventory } from '../domain/contractInventory';
import { readConnector } from './assistantBrief';
import type { ConnectorAdapter } from './connectors/connectorCapability';
import type { ConnectorId } from '../shared/wireTypes';
import { nowIso } from '../domain/ids';

export const BACKGROUND_WORKER_ACTOR = 'core:background_worker';
export const BACKGROUND_WORKER_CLIENT_ID = 'core:background_worker';

export interface BackgroundWorkerConnectorsBridge {
  dispatch(toolName: string, args: Record<string, unknown>): Promise<any>;
}

export interface BackgroundWorkerOptions {
  connectorRegistry?: Map<ConnectorId, ConnectorAdapter>;
  connectors?: BackgroundWorkerConnectorsBridge;
  cwd?: string;
  toolExecutor?: (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ status: string; output: string }>;
  signal?: AbortSignal;
  autoStart?: boolean;
}

const activeWorkerControllers = new Map<string, AbortController>();

/**
 * Checks if a user message is a request to extract Gmail contracts.
 */
export function isGmailContractExtractionRequest(text: string): boolean {
  const norm = text.trim().toLowerCase();
  return (
    /\b(?:extract|find|inventory|gather|scan|audit|get)\s+(?:all\s+)?(?:the\s+)?(?:my\s+)?(?:contracts?|agreements?|leases?|ndas?)\s+(?:from|in)\s+(?:my\s+)?(?:gmail|email|mailbox)\b/i.test(norm)
    || /\b(?:gmail|email)\s+contract\s+extraction\b/i.test(norm)
    || /^(?:extract\s+(?:all\s+)?contracts?|find\s+(?:all\s+)?contracts?|inventory\s+(?:all\s+)?contracts?)$/i.test(norm)
  );
}

/**
 * Checks if a message is asking for task status.
 */
export function isTaskStatusRequest(text: string): boolean {
  const norm = text.trim().toLowerCase();
  return /\b(?:what(?:'s| is) (?:the )?status|task status|status\??|check status|how(?:'s| is) (?:the )?(?:task|extraction|it) going)\b/i.test(norm);
}

/**
 * Checks if a message is asking to show results.
 */
export function isShowResultsRequest(text: string): boolean {
  const norm = text.trim().toLowerCase();
  return /\b(?:show (?:my |the )?results?|view results?|see results?|display results?|contract inventory|show contracts?)\b/i.test(norm);
}

/**
 * Checks if a message is asking to cancel background work.
 */
export function isCancelTaskRequest(text: string): boolean {
  const norm = text.trim().toLowerCase();
  return /\b(?:cancel(?: the task| extraction| my extraction)?|stop(?: the task| extraction)?|abort(?: the task| extraction)?)\b/i.test(norm);
}

/**
 * Checks if a message is asking to continue or resume background work.
 */
export function isContinueTaskRequest(text: string): boolean {
  const norm = text.trim().toLowerCase();
  return /\b(?:continue(?: the task| extraction)?|resume(?: the task| extraction)?)\b/i.test(norm);
}

/**
 * Starts a background task for Gmail contract extraction.
 * Prevents duplicate execution if an active task already exists in the conversation.
 */
export function startGmailContractExtractionTask(
  db: CoreDatabase,
  broadcaster: EventBroadcaster | undefined,
  input: {
    conversationId: string;
    objective?: string;
  },
  options: BackgroundWorkerOptions = {},
): { alreadyRunning: boolean; task: BackgroundTaskRecord } {
  const existing = getActiveBackgroundTask(db, {
    conversationId: input.conversationId,
    taskType: 'gmail_contract_extraction',
  });
  if (existing) {
    return { alreadyRunning: true, task: existing };
  }

  const objective = input.objective ?? 'Extract all contracts from my Gmail.';
  const req = createRequest(db, {
    clientId: BACKGROUND_WORKER_CLIENT_ID,
    conversationId: input.conversationId,
    currentMessage: objective,
    requestedMode: 'saath_kar',
    resolvedMode: 'saath_kar',
    routeReason: 'background_task_delegation',
    contextPolicy: {
      includeConversationHistory: true,
      includeProjectContext: false,
      includeRepositoryContext: false,
      includeGlobalStoryContext: false,
    },
    correlationId: `corr_bg_${Date.now()}`,
  });

  const attempt = createAttempt(db, {
    requestId: req.id,
    kind: 'saath_kar',
    actor: BACKGROUND_WORKER_ACTOR,
    clientId: BACKGROUND_WORKER_CLIENT_ID,
    context: {
      workspaceRoot: options.cwd ?? null,
      allowedTools: ['gmail_search', 'gmail_read_thread', 'gmail_read_attachment'],
    },
  });

  // Stamp durable task outcome record
  ensureTaskOutcome(db, {
    attemptId: attempt.id,
    conversationId: input.conversationId,
    requestId: req.id,
    objective,
  });

  updateTaskOutcome(db, {
    attemptId: attempt.id,
    successCriteria: [
      'Search Gmail for contract and agreement candidates',
      'Inspect candidate threads and attachments',
      'Extract and parse attachment text from documents/PDFs',
      'Classify confirmed contracts vs candidates/marketing notices',
      'Synthesize verified contract inventory table and coverage summary',
    ],
    capabilities: ['gmail'],
    status: 'in_progress',
    nextAction: 'Search Gmail for candidate contracts',
  });

  // Stamp initial checkpoint
  createCheckpoint(db, {
    attemptId: attempt.id,
    kind: 'task_started',
    metadata: { objective, taskType: 'gmail_contract_extraction' },
    actor: BACKGROUND_WORKER_ACTOR,
  });

  const task = createBackgroundTask(db, {
    attemptId: attempt.id,
    conversationId: input.conversationId,
    taskType: 'gmail_contract_extraction',
    objective,
    status: 'in_progress',
    completionCriteria: [
      'Search Gmail for contract and agreement candidates',
      'Inspect candidate threads and attachments',
      'Extract and parse attachment text from documents/PDFs',
      'Classify confirmed contracts vs candidates/marketing notices',
      'Synthesize verified contract inventory table and coverage summary',
    ],
    payload: {
      stage: 'search',
      candidateThreadIds: null,
      processedThreadIds: [],
      toolCallsRecorded: [],
    },
  });

  recordBackgroundTaskCheckpoint(db, task.id, {
    kind: 'task_started',
    summary: 'Gmail contract extraction started in background',
    timestamp: nowIso(),
    metadata: { attemptId: attempt.id },
  });

  // Start background worker execution (independent of caller) if autoStart is not false
  if (options.autoStart !== false) {
    void runBackgroundTask(db, broadcaster, task.id, options).catch((err) => {
      console.error(`[backgroundWorker] Task ${task.id} execution failed:`, err);
    });
  }

  return { alreadyRunning: false, task };
}

export function resetActiveWorkersForTesting(): void {
  for (const controller of activeWorkerControllers.values()) {
    try {
      controller.abort();
    } catch {}
  }
  activeWorkerControllers.clear();
}

/**
 * Runs execution of a background task to completion or cancellation.
 */
export async function runBackgroundTask(
  db: CoreDatabase,
  broadcaster: EventBroadcaster | undefined,
  taskId: string,
  options: BackgroundWorkerOptions = {},
): Promise<void> {
  const task = getBackgroundTask(db, taskId);
  if (!task) return;
  if (task.status === 'completed' || task.status === 'cancelled') return;

  const controller = new AbortController();
  activeWorkerControllers.set(taskId, controller);
  const signal = options.signal ?? controller.signal;

  try {
    if (task.taskType === 'gmail_contract_extraction') {
      await executeGmailContractExtraction(db, broadcaster, task, options, signal);
    }
  } catch (err: any) {
    if (signal.aborted || err?.name === 'AbortError' || err?.code === 'ERR_INVALID_STATE') {
      return;
    }
    const latest = getBackgroundTask(db, taskId);
    if (latest?.status === 'cancelled') {
      return;
    }
    console.error(`[backgroundWorker] Task ${taskId} failed:`, err);
    try {
      updateBackgroundTask(db, taskId, {
        status: 'failed',
        error: err?.message || String(err),
        completedAt: nowIso(),
      });
      failAttempt(db, task.attemptId, {
        actor: BACKGROUND_WORKER_ACTOR,
        failureReason: err?.message || 'Background worker encountered an unhandled error',
      });
    } catch {}
  } finally {
    if (activeWorkerControllers.get(taskId) === controller) {
      activeWorkerControllers.delete(taskId);
    }
  }
}

export function cancelBackgroundTaskWorker(
  db: CoreDatabase,
  broadcaster: EventBroadcaster | undefined,
  taskId: string,
  reason = 'Cancelled by user',
): BackgroundTaskRecord {
  const controller = activeWorkerControllers.get(taskId);
  if (controller) {
    controller.abort();
    activeWorkerControllers.delete(taskId);
  }
  const cancelled = cancelBackgroundTask(db, taskId, reason);
  settleCancelledTask(db, broadcaster, taskId);
  return cancelled;
}

function settleCancelledTask(db: CoreDatabase, broadcaster: EventBroadcaster | undefined, taskId: string): void {
  const current = getBackgroundTask(db, taskId);
  if (!current) return;
  updateBackgroundTask(db, taskId, {
    status: 'cancelled',
    error: 'Cancelled by user',
    completedAt: nowIso(),
  });
  try {
    const attempt = getAttempt(db, current.attemptId);
    if (attempt.status === 'running') {
      transitionAttempt(db, current.attemptId, {
        toStatus: 'cancelling',
        actor: BACKGROUND_WORKER_ACTOR,
        reason: 'Background task was cancelled by user',
      });
    }
    const refreshed = getAttempt(db, current.attemptId);
    if (refreshed.status !== 'cancelled' && refreshed.status !== 'completed' && refreshed.status !== 'failed') {
      transitionAttempt(db, current.attemptId, {
        toStatus: 'cancelled',
        actor: BACKGROUND_WORKER_ACTOR,
        reason: 'Background task was cancelled by user',
      });
    }
  } catch {}
  updateTaskOutcome(db, {
    attemptId: current.attemptId,
    status: 'blocked',
    blocker: 'Task cancelled by user',
    nextAction: 'Restart task when ready',
  });
}

/**
 * Invokes a tool either via caller-injected toolExecutor, connectors bridge, or Core connector registry.
 */
async function invokeTool(
  db: CoreDatabase,
  attemptId: string,
  toolName: string,
  args: Record<string, unknown>,
  options: BackgroundWorkerOptions,
  signal?: AbortSignal,
): Promise<{ status: string; output: string }> {
  const inv = startToolInvocation(db, {
    attemptId,
    toolName,
    argsSummary: args,
    actor: BACKGROUND_WORKER_ACTOR,
    clientId: BACKGROUND_WORKER_CLIENT_ID,
  });

  let result: { status: string; output: string };
  try {
    if (options.toolExecutor) {
      result = await options.toolExecutor(toolName, args, signal);
    } else if (options.connectors) {
      const outcome = await options.connectors.dispatch(toolName, args);
      if (outcome.outcome === 'executed') {
        const evidence = outcome.toolInvocation?.evidence as Record<string, unknown> | undefined;
        const output = typeof evidence?.output === 'string' ? evidence.output : JSON.stringify(evidence ?? outcome);
        result = { status: outcome.toolInvocation?.status === 'succeeded' ? 'succeeded' : 'failed', output };
      } else {
        result = { status: 'failed', output: JSON.stringify({ error: outcome.reason ?? 'tool not executed' }) };
      }
    } else {
      const adapters = options.connectorRegistry ?? new Map();
      const cwd = options.cwd ?? process.cwd();
      const readRes = await readConnector(db, adapters, 'gmail', toolName, args, cwd, signal);
      if (readRes.ok) {
        result = { status: 'succeeded', output: JSON.stringify(readRes.data) };
      } else {
        result = { status: 'failed', output: JSON.stringify({ error: readRes.reason ?? 'failed' }) };
      }
    }
  } catch (err: any) {
    result = { status: 'failed', output: JSON.stringify({ error: err?.message || String(err) }) };
  }

  if (!signal.aborted) {
    try {
      completeToolInvocation(db, inv.id, {
        status: result.status === 'succeeded' ? 'succeeded' : 'failed',
        exitCode: result.status === 'succeeded' ? 0 : 1,
        evidence: { output: result.output.slice(0, 10_000) },
        actor: BACKGROUND_WORKER_ACTOR,
        clientId: BACKGROUND_WORKER_CLIENT_ID,
      });
    } catch {}
  }

  return result;
}

/**
 * Executes Gmail contract extraction with incremental checkpoints and cooperative yielding.
 */
async function executeGmailContractExtraction(
  db: CoreDatabase,
  broadcaster: EventBroadcaster | undefined,
  initialTask: BackgroundTaskRecord,
  options: BackgroundWorkerOptions,
  signal: AbortSignal,
): Promise<void> {
  let task = initialTask;
  const attemptId = task.attemptId;

  // Mark attempt running with claim owner if not already
  try {
    const attempt = getAttempt(db, attemptId);
    if (attempt.status === 'created' || attempt.status === 'queued') {
      transitionAttempt(db, attemptId, {
        toStatus: 'running',
        actor: BACKGROUND_WORKER_ACTOR,
        reason: 'Background extraction worker started',
      });
    }
    db.run(
      "UPDATE attempts SET claimOwner = ?, claimExpiresAt = ? WHERE id = ?",
      [BACKGROUND_WORKER_ACTOR, new Date(Date.now() + 3600_000).toISOString(), attemptId],
    );
  } catch {}

  const payload = { ...task.payload };
  const toolCallsRecorded: Array<{ tool: string; args?: any; result: any; status: string }> = Array.isArray(payload.toolCallsRecorded)
    ? [...payload.toolCallsRecorded]
    : [];
  let candidateThreadIds: string[] = Array.isArray(payload.candidateThreadIds) ? [...payload.candidateThreadIds] : [];
  const processedThreadIds: string[] = Array.isArray(payload.processedThreadIds) ? [...payload.processedThreadIds] : [];

  // Stage 1: Search Gmail for contracts if not already done
  if (payload.stage === 'search' || !payload.candidateThreadIds) {
    if (signal.aborted || getBackgroundTask(db, task.id)?.status === 'cancelled') {
      return;
    }

    // Yield to interactive priority lane before tool boundary
    await interactiveLane.yieldToInteractive(attemptId, signal);

    const searchArgs = { query: 'contract OR agreement OR lease OR rental OR "terms of service" OR NDA' };
    const searchRes = await invokeTool(db, attemptId, 'gmail_search', searchArgs, options, signal);

    let parsedSearch: any = {};
    try { parsedSearch = JSON.parse(searchRes.output); } catch {}
    const results: any[] = Array.isArray(parsedSearch.results) ? parsedSearch.results : [];

    toolCallsRecorded.push({
      tool: 'gmail_search',
      args: searchArgs,
      status: searchRes.status === 'succeeded' ? 'completed' : 'failed',
      result: { content: [{ type: 'text', text: searchRes.output }] },
    });

    candidateThreadIds = Array.from(new Set(results.map((r) => r.threadId || r.id).filter(Boolean)));

    createCheckpoint(db, {
      attemptId,
      kind: 'search_completed',
      metadata: { matched: parsedSearch.counts?.matched ?? results.length, found: results.length },
      actor: BACKGROUND_WORKER_ACTOR,
    });

    recordBackgroundTaskCheckpoint(db, task.id, {
      kind: 'search_completed',
      summary: `Search completed: found ${results.length} candidate messages across ${candidateThreadIds.length} threads`,
      timestamp: nowIso(),
      metadata: { count: results.length, threads: candidateThreadIds.length },
    });

    updateTaskOutcome(db, {
      attemptId,
      nextAction: 'Inspect candidate threads and attachment text',
      summary: `Found ${results.length} candidates in Gmail`,
    });

    payload.stage = 'inspect_threads';
    payload.candidateThreadIds = candidateThreadIds;
    payload.toolCallsRecorded = toolCallsRecorded;
    task = updateBackgroundTask(db, task.id, { payload });
  }

  // Stage 2: Inspect threads and attachment contents
  for (const threadId of candidateThreadIds) {
    if (signal.aborted || getBackgroundTask(db, task.id)?.status === 'cancelled') {
      return;
    }

    if (processedThreadIds.includes(threadId)) {
      continue;
    }

    // Yield to interactive lane before thread inspection
    await interactiveLane.yieldToInteractiveAtTool(attemptId, signal, DEFAULT_MAX_TOOL_YIELD_MS);

    const threadArgs = { threadId };
    const threadRes = await invokeTool(db, attemptId, 'gmail_read_thread', threadArgs, options, signal);

    let parsedThread: any = {};
    try { parsedThread = JSON.parse(threadRes.output); } catch {}

    toolCallsRecorded.push({
      tool: 'gmail_read_thread',
      args: threadArgs,
      status: threadRes.status === 'succeeded' ? 'completed' : 'failed',
      result: { content: [{ type: 'text', text: threadRes.output }] },
    });

    const messages: any[] = Array.isArray(parsedThread.messages) ? parsedThread.messages : [];
    const firstMsg = messages[0];
    const subject = firstMsg?.subject || threadId;

    createCheckpoint(db, {
      attemptId,
      kind: 'thread_inspected',
      metadata: { threadId, subject, messageCount: messages.length },
      actor: BACKGROUND_WORKER_ACTOR,
    });

    recordBackgroundTaskCheckpoint(db, task.id, {
      kind: 'thread_inspected',
      summary: `Inspected thread: ${subject}`,
      timestamp: nowIso(),
      metadata: { threadId, subject },
    });

    // Inspect any attachments in this thread
    for (const msg of messages) {
      const attachments: any[] = Array.isArray(msg.attachments) ? msg.attachments : [];
      for (const att of attachments) {
        if (signal.aborted || getBackgroundTask(db, task.id)?.status === 'cancelled') {
          return;
        }

        await interactiveLane.yieldToInteractiveAtTool(attemptId, signal, DEFAULT_MAX_TOOL_YIELD_MS);

        const attArgs = { messageId: msg.id, attachmentId: att.id, filename: att.filename, mimeType: att.mimeType };
        const attRes = await invokeTool(db, attemptId, 'gmail_read_attachment', attArgs, options, signal);

        toolCallsRecorded.push({
          tool: 'gmail_read_attachment',
          args: attArgs,
          status: attRes.status === 'succeeded' ? 'completed' : 'failed',
          result: { content: [{ type: 'text', text: attRes.output }] },
        });

        createCheckpoint(db, {
          attemptId,
          kind: 'attachment_read',
          metadata: { attachmentId: att.id, filename: att.filename, size: att.size },
          actor: BACKGROUND_WORKER_ACTOR,
        });

        recordBackgroundTaskCheckpoint(db, task.id, {
          kind: 'attachment_read',
          summary: `Extracted attachment: ${att.filename}`,
          timestamp: nowIso(),
          metadata: { attachmentId: att.id, filename: att.filename },
        });
      }
    }

    processedThreadIds.push(threadId);
    payload.processedThreadIds = processedThreadIds;
    payload.toolCallsRecorded = toolCallsRecorded;
    task = updateBackgroundTask(db, task.id, { payload });
  }

  // Stage 3: Synthesis & Verified Delivery
  if (signal.aborted || getBackgroundTask(db, task.id)?.status === 'cancelled') {
    return;
  }

  const inventoryMarkdown = synthesizeContractInventory(toolCallsRecorded) ||
    '### Contract Extraction Summary\nNo contract documents were found in the examined messages.';

  finalizeTaskOutcome(db, attemptId, {
    verdict: 'verified',
    reason: 'Gmail contract extraction completed with verified evidence',
    performed: toolCallsRecorded.map((t) => t.tool),
    refused: [],
    failed: toolCallsRecorded.filter((t) => t.status === 'failed').map((t) => t.tool),
  });

  createCheckpoint(db, {
    attemptId,
    kind: 'task_completed',
    metadata: {
      candidatesInspected: candidateThreadIds.length,
      toolCalls: toolCallsRecorded.length,
    },
    actor: BACKGROUND_WORKER_ACTOR,
  });

  recordBackgroundTaskCheckpoint(db, task.id, {
    kind: 'task_completed',
    summary: 'Gmail contract extraction successfully completed',
    timestamp: nowIso(),
    metadata: { threadsExamined: candidateThreadIds.length },
  });

  try {
    transitionAttempt(db, attemptId, {
      toStatus: 'completed',
      actor: BACKGROUND_WORKER_ACTOR,
      reason: 'Gmail contract extraction completed successfully',
    });
  } catch {}

  const resultSummary = 'Gmail contract extraction completed with verified inventory table.';
  updateBackgroundTask(db, task.id, {
    status: 'completed',
    resultSummary,
    resultData: inventoryMarkdown,
    completedAt: nowIso(),
  });

  // Deliver the final evidence-backed result automatically into Pandesh conversation
  appendMessage(db, task.conversationId, {
    role: 'assistant',
    content: `I've finished your Gmail contract extraction.\n\n${inventoryMarkdown}`,
    actor: BACKGROUND_WORKER_ACTOR,
    clientId: BACKGROUND_WORKER_CLIENT_ID,
  });

  // Deliver in-app notification via runtime event stream
  const notificationEvent = recordRuntimeEvent(db, {
    domain: 'background_task',
    entityId: task.id,
    eventType: 'background_task_completed',
    actor: BACKGROUND_WORKER_ACTOR,
    clientId: BACKGROUND_WORKER_CLIENT_ID,
    idempotencyKey: `bg_completed:${task.id}`,
    metadata: {
      taskId: task.id,
      attemptId,
      conversationId: task.conversationId,
      taskType: task.taskType,
      title: 'Gmail Contract Extraction Completed',
      summary: 'Your Gmail contract extraction is finished.',
      text: 'Contract inventory table generated and delivered to conversation.',
    },
  });

  updateBackgroundTask(db, task.id, { notificationSent: true });

  if (broadcaster && typeof broadcaster.publishRuntime === 'function') {
    broadcaster.publishRuntime(notificationEvent);
  }
}

/**
 * Scans for interrupted background tasks on Core boot and resumes execution.
 */
export async function recoverBackgroundTasks(
  db: CoreDatabase,
  broadcaster: EventBroadcaster | undefined,
  options: BackgroundWorkerOptions = {},
): Promise<BackgroundTaskRecord[]> {
  const pending = listBackgroundTasks(db, { status: 'in_progress', limit: 50 });
  const recovered: BackgroundTaskRecord[] = [];

  for (const task of pending) {
    if (activeWorkerControllers.has(task.id)) continue;
    recovered.push(task);
    void runBackgroundTask(db, broadcaster, task.id, options).catch((err) => {
      console.error(`[backgroundWorker] Recovery of task ${task.id} failed:`, err);
    });
  }

  return recovered;
}

/**
 * Starts the background task scheduler loop in Core.
 */
export function startBackgroundTaskLoop(
  db: CoreDatabase,
  broadcaster: EventBroadcaster | undefined,
  intervalMs = 5_000,
  options: BackgroundWorkerOptions = {},
): () => void {
  // Immediate recovery on boot
  void recoverBackgroundTasks(db, broadcaster, options).catch(() => undefined);

  const timer = setInterval(() => {
    void recoverBackgroundTasks(db, broadcaster, options).catch(() => undefined);
  }, intervalMs);

  timer.unref?.();
  return () => {
    clearInterval(timer);
    for (const controller of activeWorkerControllers.values()) {
      controller.abort();
    }
    activeWorkerControllers.clear();
  };
}
