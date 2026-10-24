/**
 * Jarvis Connector Foundation — the one addition layered in front of
 * `dispatchCapability` (core/domain/capabilityDispatch.ts) for connector
 * tools: a read/draft/execute permission gate (requirement #2). Everything
 * else — approval envelope, evidence, idempotency, redaction, cancellation,
 * bounded execution — is the unmodified M38 fabric; this module never
 * duplicates it.
 *
 * The gate runs strictly before `dispatchCapability`: an ungranted tier never
 * creates an approval, never calls the adapter, and never reaches health
 * checks. A `read` grant therefore cannot execute a `draft`/`execute` tool no
 * matter what the caller (including model-proposed tool calls) asks for,
 * because the tier is fixed by the adapter's own tool -> tier map
 * (`ConnectorCapabilityAdapter.tier`), never by caller-supplied arguments.
 */
import type { CoreDatabase } from '../db/connection';
import type { CapabilityDispatchResult } from '../shared/wireTypes';
import type { ConnectorId } from '../shared/wireTypes';
import { dispatchCapability, ensureCapabilityAttempt, type DispatchCapabilityInput } from './capabilityDispatch';
import { hasConnectorPermission } from './connectors';
import { recordRuntimeEvent } from './runtimeEvents';
import { getGmailDraftBinding } from './gmailDrafts';
import { judgeConnectorMutationIntent } from './connectorIntent';
import { buildGmailSendPresentation } from '../runtime/connectors/gmailDraftDigest';
import type { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';

export async function dispatchConnectorAction(
  db: CoreDatabase,
  registry: GovernedCapabilityRegistry,
  adapters: Map<ConnectorId, ConnectorAdapter>,
  input: DispatchCapabilityInput & {
    /** The user's own request this tool call serves. A read-only or suggestion-only request cannot reach a mutation approval. */
    requestText?: string;
  },
): Promise<CapabilityDispatchResult> {
  const classification = registry.classify(input.toolName);
  if (!classification) {
    const attemptId = ensureCapabilityAttempt(db, input);
    return { outcome: 'unknown_tool', attemptId };
  }
  const adapter = [...adapters.values()].find((candidate) => candidate.id === classification.capabilityId);
  if (!adapter) {
    // Not a connector tool at all (e.g. workspace/github/research) — fall
    // through to the unmodified fabric, no tier gate applies.
    return dispatchCapability(db, registry, input);
  }

  const tier = adapter.tier(input.toolName);
  if (!hasConnectorPermission(db, adapter.connectorId, tier)) {
    const attemptId = ensureCapabilityAttempt(db, input);
    recordRuntimeEvent(db, {
      domain: 'connector',
      entityId: adapter.connectorId,
      eventType: 'connector_action_permission_denied',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { connectorId: adapter.connectorId, tier, toolName: input.toolName },
    });
    return {
      outcome: 'denied',
      attemptId,
      reason: `connector '${adapter.connectorId}' does not have the '${tier}' permission granted for '${input.toolName}'`,
    };
  }

  // The user's own words decide whether a calendar or inbox mutation may even ask for approval. A suggestion-only
  // request ("suggest three slots without creating events") is refused here, before any approval exists.
  const intent = judgeConnectorMutationIntent(input.toolName, input.requestText);
  if (!intent.allowed) {
    const attemptId = ensureCapabilityAttempt(db, input);
    recordRuntimeEvent(db, {
      domain: 'connector',
      entityId: adapter.connectorId,
      eventType: 'connector_action_refused_by_request_intent',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { connectorId: adapter.connectorId, tier, toolName: input.toolName },
    });
    return { outcome: 'denied', attemptId, reason: intent.reason };
  }

  if (input.toolName === 'gmail_send_draft') {
    return dispatchGmailSendDraft(db, registry, input);
  }

  // Connectors that bind live state into the approval (Calendar: the exact
  // event, plus an etag the executor re-checks) get to rewrite the arguments
  // and supply the card text BEFORE any approval exists. A refusal here never
  // creates an approval.
  if (adapter.prepare && tier !== 'read') {
    const prepared = await adapter.prepare(input.toolName, input.arguments, input.signal);
    if (!prepared.ok) {
      const attemptId = ensureCapabilityAttempt(db, input);
      return { outcome: 'denied', attemptId, reason: prepared.reason };
    }
    return dispatchCapability(db, registry, {
      ...input,
      arguments: prepared.arguments,
      ...(prepared.presentation ? { connectorPresentation: prepared.presentation } : {}),
    });
  }

  return dispatchCapability(db, registry, input);
}

/**
 * `gmail_send_draft`'s only argument is a draft ID — it carries no content of
 * its own to show a human. This builds the send-confirmation approval from
 * the digest and content recorded when the draft was created
 * (`core/domain/gmailDrafts.ts`, written by `gmail_create_draft`'s executor)
 * and freezes that digest into the approval as `gmailDraftProposal`, so
 * `gwsGmailAdapter.ts`'s executor can re-verify it against a fresh read of
 * the live draft immediately before sending. Refuses before ever creating an
 * approval when no binding exists — there is nothing safe to ask a human to
 * confirm sending.
 */
function dispatchGmailSendDraft(
  db: CoreDatabase,
  registry: GovernedCapabilityRegistry,
  input: DispatchCapabilityInput,
): Promise<CapabilityDispatchResult> {
  const draftId = typeof input.arguments.draftId === 'string' ? input.arguments.draftId.trim() : '';
  const binding = draftId ? getGmailDraftBinding(db, draftId) : undefined;
  if (!binding) {
    const attemptId = ensureCapabilityAttempt(db, input);
    return Promise.resolve({
      outcome: 'denied',
      attemptId,
      reason: draftId
        ? `no approved draft is on record for draft id '${draftId}'; create and approve the draft again before sending`
        : 'gmail_send_draft requires a draftId',
    });
  }
  return dispatchCapability(db, registry, {
    ...input,
    gmailDraftProposal: {
      expectedDigest: binding.digest,
      presentation: { ...buildGmailSendPresentation({
        accountEmail: binding.accountEmail,
        draftId: binding.draftId,
        threadId: binding.threadId,
        to: binding.to,
        cc: binding.cc,
        bcc: binding.bcc,
        subject: binding.subject,
        bodyText: binding.bodyText,
        bodyHtml: binding.bodyHtml,
      }) },
    },
  });
}
