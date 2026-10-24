import type { CoreDatabase } from '../db/connection';
import type { CapabilityActionDisplayEntry, RecentWorkspaceCapabilityActionsSnapshot } from '../shared/wireTypes';
import { getAttemptContext } from './attemptContext';
import { listAttempts } from './attempts';
import { listCapabilityActions } from './capabilityDispatch';
import { getRequest } from './requests';
import { workspaceIdentity } from './attemptRehydration';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCAN_PAGE_SIZE = 200;

export interface ListRecentWorkspaceCapabilityActionsInput {
  workspaceRoot: string;
  limit?: number;
  /** ISO timestamp; attempts last updated before this are excluded. Defaults
   * to a 7-day bounded recency window — this is a display query, never an
   * unbounded history scan. */
  since?: string;
}

/**
 * M38: read-only capability-card display state for a workspace, deliberately
 * independent of `listWorkspaceAttemptRehydration()`'s active-execution-
 * recovery contract (core/domain/attemptRehydration.ts). That function
 * excludes terminal attempts by design — correctly, for resumability
 * decisions — but a resolved capability approval card must keep displaying
 * (as completed/denied, non-actionable) long after the attempt that created
 * it went terminal. This function never widens rehydration's meaning and
 * never touches `coreExecutionTurns`/execution state; it exists purely so
 * `AgentPanel` can restore capability cards for display without depending on
 * `rehydrateCoreAttempts()` completing, or on the owning attempt still being
 * active.
 *
 * Finds a bounded, recency-windowed set of this workspace's Saath Kar
 * requests (active or terminal — karke_dikha attempts have no chat
 * conversationId and are excluded), and for each distinct conversationId
 * re-derives its capability actions via the same `listCapabilityActions()`
 * the live/webview-recreation approval-card path already uses — reusing its
 * exact sanitized representation and actionable/outcome semantics rather
 * than inventing a new one. Deduplicates by approvalId (a conversation can
 * only ever have the actions its own anchor attempt actually created).
 *
 * Never creates, retries, claims, transitions, or resumes anything — a
 * strict read over already-durable rows.
 */
export function listRecentWorkspaceCapabilityActions(
  db: CoreDatabase,
  input: ListRecentWorkspaceCapabilityActionsInput,
): RecentWorkspaceCapabilityActionsSnapshot {
  const expectedWorkspace = workspaceIdentity(input.workspaceRoot);
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
  const sinceMs = input.since ? Date.parse(input.since) : Date.now() - DEFAULT_WINDOW_MS;

  const conversations: Array<{ conversationId: string; clientId: string; realAttemptId: string }> = [];
  const seenConversations = new Set<string>();

  outer: for (let offset = 0; conversations.length < limit; offset += SCAN_PAGE_SIZE) {
    // Newest-first across ALL workspaces (listAttempts orders by updatedAt
    // DESC with no workspace filter) — once we see an attempt older than the
    // window, every attempt from here on (this workspace or any other) is
    // also older, so it is safe to stop the whole scan rather than merely
    // skipping this one row.
    const page = listAttempts(db, { activeOnly: false, limit: SCAN_PAGE_SIZE, offset });
    if (page.length === 0) break;
    for (const attempt of page) {
      if (Date.parse(attempt.updatedAt) < sinceMs) break outer;
      if (attempt.kind === 'karke_dikha') continue;
      const context = getAttemptContext(db, attempt.id);
      if (!context.workspaceRoot || workspaceIdentity(context.workspaceRoot) !== expectedWorkspace) continue;
      const request = getRequest(db, attempt.requestId);
      if (!request.conversationId || seenConversations.has(request.conversationId)) continue;
      seenConversations.add(request.conversationId);
      conversations.push({ conversationId: request.conversationId, clientId: request.clientId, realAttemptId: attempt.id });
      if (conversations.length >= limit) break;
    }
    if (page.length < SCAN_PAGE_SIZE) break;
  }

  const actions: CapabilityActionDisplayEntry[] = [];
  const seenApprovalIds = new Set<string>();
  for (const { conversationId, clientId, realAttemptId } of conversations) {
    const snapshot = listCapabilityActions(db, { correlationId: conversationId, clientId });
    if (!snapshot.attemptId) continue;
    for (const action of snapshot.actions) {
      if (seenApprovalIds.has(action.approvalId)) continue;
      seenApprovalIds.add(action.approvalId);
      actions.push({ ...action, correlationId: conversationId, realAttemptId });
    }
  }
  return { actions };
}
