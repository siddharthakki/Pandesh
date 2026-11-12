/**
 * Escalation: Pandesh does not give up on a task while a stronger model it may use has not tried it.
 *
 * Owner report 2026-11-12 (widget chat): gemma4:12b ran two web searches, wrote nothing, said "I'm starting now", and
 * the turn ended as "completed". Auto reroute never looked at it — it only acts on FAILED attempts whose model Core
 * chose itself — and the desktop's model pick counted as exact. The owner's rule:
 *
 *   1. A turn that ended unfinished (a build request with nothing built, a turn with no reply) or failed with a model
 *      failure is continued by a stronger INSTALLED local model, announced in the chat.
 *   2. This repeats until the strongest local model has tried (at most MAX_ESCALATIONS steps).
 *   3. A cloud model is never used without asking the user first.
 *   4. When nothing stronger is left, Core reports from its records which models tried, what each really did, and why
 *      the task is not done — never "I'm working on it".
 *
 * Only local picks escalate: a cloud model the user picked is exact (it never silently falls back), and a stopped task
 * or one with a side effect already applied is never re-run.
 */
import type { CoreDatabase } from '../db/connection';
import type { AttemptRecord } from '../shared/wireTypes';
import { getAttempt, rerouteAttempt } from '../domain/attempts';
import { getAttemptContext } from '../domain/attemptContext';
import { getRequest } from '../domain/requests';
import { appendMessage } from '../domain/conversations';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { classifyFailureFingerprint } from '../platform/autoReroute';
import { providerDeclaresNoChat } from '../domain/empiricalRouting';
import { cloudProviderLabel } from './attemptModelBackend';
import type { PreferredCloudModel } from './cloudCredentials';

export const MAX_ESCALATIONS = 2;
const OLLAMA = 'ollama';

/** One installed local model, as Ollama reports it. */
export interface InstalledModel {
  name: string;
  /** Parameter count in billions (Ollama `details.parameter_size`); undefined when Ollama does not say. */
  paramsB?: number;
  capabilities: string[];
}

export type EscalationPlan =
  | { kind: 'escalate'; model: string; reason: string }
  | { kind: 'exhausted'; reason: string };

/** Models never chosen automatically: modified "uncensored" variants are the owner's to pick by hand. */
const NOT_AUTO = /abliterat|uncensor|heretic|jailbr/i;
const CODING_REQUEST = /\b(?:code|coding|script|program|app|widget|website|web\s*page|dashboard|function|bug|compile|build|python|javascript|typescript|html|css|api)\b/i;

export function parseParamsB(text: string | undefined): number | undefined {
  const m = String(text ?? '').trim().match(/^([\d.]+)\s*([BMK])?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] ?? 'B').toUpperCase();
  return unit === 'B' ? n : unit === 'M' ? n / 1000 : n / 1_000_000;
}

/**
 * The next model to try: the strongest installed local model that can chat (and use tools, when the task needs them),
 * has not tried this task yet, and is at least as strong as the strongest one that already tried. Strength is the
 * parameter count Ollama reports; ties go to a coding model for a coding request and a general one otherwise, then to
 * the name.
 */
export function planEscalation(input: {
  usedModels: readonly string[];
  installed: readonly InstalledModel[];
  needsTools: boolean;
  needsVision: boolean;
  requestText: string;
  escalationsSoFar: number;
}): EscalationPlan {
  if (input.escalationsSoFar >= MAX_ESCALATIONS) {
    return { kind: 'exhausted', reason: `${input.escalationsSoFar} stronger model${input.escalationsSoFar === 1 ? '' : 's'} already tried (the limit is ${MAX_ESCALATIONS})` };
  }
  const used = new Set(input.usedModels);
  const sizeOf = (name: string) => input.installed.find((m) => m.name === name)?.paramsB;
  const floor = Math.max(0, ...input.usedModels.map((m) => sizeOf(m) ?? 0));
  const coding = CODING_REQUEST.test(input.requestText);
  const candidates = input.installed.filter((m) =>
    !used.has(m.name)
    && !NOT_AUTO.test(m.name)
    && !providerDeclaresNoChat(m.capabilities)
    && m.capabilities.includes('completion')
    && (!input.needsTools || m.capabilities.includes('tools'))
    && (!input.needsVision || m.capabilities.includes('vision'))
    && m.paramsB !== undefined && m.paramsB >= floor);
  candidates.sort((a, b) => (b.paramsB! - a.paramsB!)
    // Equal size: a coding model for a coding request, a general model for anything else.
    || (Number(/coder/i.test(b.name) === coding) - Number(/coder/i.test(a.name) === coding))
    || a.name.localeCompare(b.name));
  const next = candidates[0];
  if (!next) return { kind: 'exhausted', reason: 'no stronger model is installed on this PC' };
  return { kind: 'escalate', model: next.name, reason: `${next.name} (${next.paramsB}B) is the strongest installed model that has not tried this yet` };
}

/** What Ollama has installed right now, with parameter counts and capabilities. Undefined when Ollama is unreachable. */
export async function localInstalledModels(baseUrl = process.env.KARKEDIKHA_OLLAMA_URL || 'http://127.0.0.1:11434'): Promise<InstalledModel[] | undefined> {
  try {
    const tags = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!tags.ok) return undefined;
    const body = await tags.json() as { models?: Array<{ name: string; details?: { parameter_size?: string } }> };
    const models = body.models ?? [];
    return await Promise.all(models.map(async (m) => {
      let capabilities: string[] = [];
      try {
        const show = await fetch(`${baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model: m.name }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000) });
        if (show.ok) capabilities = ((await show.json()) as { capabilities?: string[] }).capabilities ?? [];
      } catch { /* unknown capabilities: the model is simply not a candidate */ }
      return { name: m.name, paramsB: parseParamsB(m.details?.parameter_size), capabilities };
    }));
  } catch {
    return undefined;
  }
}

export interface UnfinishedTurn { reason: 'nothing_built' | 'no_reply' | 'model_failure'; detail: string; toolsRun: string[] }

function chainOf(db: CoreDatabase, attempt: AttemptRecord): AttemptRecord[] {
  const chain: AttemptRecord[] = [attempt];
  let cursor = attempt;
  while (cursor.predecessorAttemptId && chain.length < 16) {
    cursor = getAttempt(db, cursor.predecessorAttemptId);
    chain.push(cursor);
  }
  return chain;
}

function toolsRunBy(db: CoreDatabase, attemptId: string): string[] {
  return db.all<{ toolName: string }>("SELECT toolName FROM tool_invocations WHERE attemptId = ? AND status IN ('succeeded','completed')", [attemptId])
    .map((r) => r.toolName).filter((t) => !/^(?:update_task_outcome|request_tools)$/.test(t));
}

/** Why this attempt did not finish its task, from Core's records; null when it did (or was stopped by the user). */
export function unfinishedTurnOf(db: CoreDatabase, attemptId: string, isMutatingTool: (tool: string) => boolean): UnfinishedTurn | null {
  const attempt = getAttempt(db, attemptId);
  if (attempt.cancelRequestedAt || attempt.status === 'cancelled') return null;
  if (attempt.status === 'completed') {
    const row = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'turn_unfinished' ORDER BY sequence DESC LIMIT 1", [attemptId]);
    if (!row) return null;
    let meta: { reason?: string; toolsRun?: string[] } = {};
    try { meta = JSON.parse(row.metadata) as typeof meta; } catch { /* reason stays generic */ }
    const toolsRun = toolsRunBy(db, attemptId);
    return meta.reason === 'no_reply'
      ? { reason: 'no_reply', detail: 'the model produced no reply', toolsRun }
      : { reason: 'nothing_built', detail: 'nothing was built — no file was written or changed', toolsRun };
  }
  if (attempt.status === 'failed' && attempt.failureReason && classifyFailureFingerprint(attempt.failureReason)) {
    // A side effect already applied is never repeated by another model.
    const applied = db.all<{ toolName: string; status: string }>('SELECT toolName, status FROM tool_invocations WHERE attemptId = ?', [attemptId])
      .some((r) => isMutatingTool(r.toolName) && r.status !== 'failed' && r.status !== 'cancelled');
    if (applied) return null;
    return { reason: 'model_failure', detail: attempt.failureReason.slice(0, 240), toolsRun: toolsRunBy(db, attemptId) };
  }
  return null;
}

function counted(tools: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
}

/** The chat line that announces the switch. */
export function escalationNotice(failedModel: string, why: UnfinishedTurn, nextModel: string): string {
  const ran = why.toolsRun.length ? ` (it only ran ${counted(why.toolsRun)})` : '';
  return `**${failedModel} did not finish this:** ${why.detail}${ran}. Continuing with **${nextModel}**, a stronger model on this PC — same request, nothing to do on your side.`;
}

/** What the stronger model is told before it starts (from Core's records, never from the weaker model's reply). */
export function escalationGuidance(failedModel: string, why: UnfinishedTurn): string {
  const ran = why.toolsRun.length ? `It ran: ${counted(why.toolsRun)}.` : 'It ran no tool.';
  return `Pandesh escalated this request to you because ${failedModel} did not finish it: ${why.detail}. ${ran} Ignore any earlier reply in this chat that says the work is starting or under way — it is not. Do the work now with your tools in this turn (create the files, run them, check them), then say exactly what exists. If something truly cannot be done here, say what and why.`;
}

/** What a cloud model would receive if the user says yes — stated before anything is sent. */
export function cloudOfferText(offer: PreferredCloudModel): string {
  const label = cloudProviderLabel(offer.provider);
  return [
    `**Want me to hand this to the cloud model ${offer.model} (${label})?** It is free and runs on ${label}'s servers, not on this PC. If you say yes, it receives:`,
    '- the messages in this chat, including this request;',
    '- whatever its tools return while it works: files it reads in the selected folder, web pages, and — only if it uses those tools — your Gmail, Calendar or memory content.',
    'Nothing has been sent yet. Reply **yes** to hand it over, or **no** to keep everything on this PC.',
  ].join('\n');
}

/** The final report once no stronger model is left; with `offer`, it ends by asking before any cloud use. */
export function exhaustedReport(steps: ReadonlyArray<{ model: string; why: UnfinishedTurn }>, reason: string, offer?: PreferredCloudModel): string {
  const lines = ['**This request is not done.** Here is what really happened (from the records):', ''];
  for (const s of steps) lines.push(`- **${s.model}**: ${s.why.detail}${s.why.toolsRun.length ? ` — ran ${counted(s.why.toolsRun)}` : ''}.`);
  lines.push('', `It stopped because ${reason}. Nothing is running in the background.`);
  if (offer) {
    lines.push('', cloudOfferText(offer));
  } else {
    lines.push('A cloud model is never used without your OK. To offer one here, choose a free cloud model in Settings → Cloud; otherwise you can rephrase the request, split it into smaller steps, or pick another model and ask again.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The answer to the cloud offer: a short "yes" / "no" in the same chat, right after the offer.
// ---------------------------------------------------------------------------------------------------------------

const YES = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|go\s+ahead|do\s+it|please\s+do|hand\s+it\s+over|use\s+(?:the\s+)?cloud(?:\s+model)?|try\s+(?:the\s+)?cloud(?:\s+model)?)\b[\s\w,.!']*$/i;
const NO = /^\s*(?:no|nope|nah|don'?t|do\s+not|keep\s+it\s+local|stay\s+local|not\s+now|cancel)\b/i;

/** 'yes' / 'no' when a short message answers the offer; null for anything else (a new request stays a request). */
export function classifyOfferReply(text: string): 'yes' | 'no' | null {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return null;
  if (NO.test(t)) return 'no';
  if (/\b(?:don'?t|do not|not)\b/i.test(t)) return null; // "yes but not now" is not a clear yes
  return YES.test(t) ? 'yes' : null;
}

export interface PendingCloudOffer { offerAttemptId: string; provider: string; model: string }

/**
 * The offer this chat is waiting on: the newest `cloud_offer` in the conversation, with no request after the offered
 * attempt's own request except the current one, and not yet answered.
 */
export function pendingCloudOffer(db: CoreDatabase, conversationId: string, currentRequestId: string): PendingCloudOffer | null {
  if (!conversationId) return null;
  const offer = db.get<{ entityId: string; metadata: string; requestId: string; createdAt: string }>(
    `SELECT e.entityId AS entityId, e.metadata AS metadata, a.requestId AS requestId, q.createdAt AS createdAt
       FROM runtime_events e JOIN attempts a ON a.id = e.entityId JOIN requests q ON q.id = a.requestId
      WHERE e.eventType = 'cloud_offer' AND q.conversationId = ? ORDER BY e.sequence DESC LIMIT 1`,
    [conversationId],
  );
  if (!offer) return null;
  const later = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE conversationId = ? AND createdAt > ? AND id NOT IN (?, ?)',
    [conversationId, offer.createdAt, offer.requestId, currentRequestId]);
  if (Number(later?.n ?? 0) > 0) return null;
  const answered = db.get("SELECT 1 FROM runtime_events WHERE eventType IN ('cloud_offer_accepted','cloud_offer_declined') AND metadata LIKE ? LIMIT 1", [`%"offerAttemptId":"${offer.entityId}"%`]);
  if (answered) return null;
  try {
    const meta = JSON.parse(offer.metadata) as { provider?: string; model?: string };
    return meta.provider && meta.model ? { offerAttemptId: offer.entityId, provider: meta.provider, model: meta.model } : null;
  } catch { return null; }
}

export function cloudOfferAcceptedReply(offer: PendingCloudOffer): string {
  return `Handing this to **${offer.model}** (${cloudProviderLabel(offer.provider)}) now. It works on the same request with this chat's messages and its tools; its answer will appear here.`;
}

export const CLOUD_OFFER_DECLINED_REPLY = 'OK — nothing was sent to a cloud model, and the request stays as it is. You can rephrase it, split it into smaller steps, or pick another model and ask again.';

/**
 * After the user said yes: the successor that runs the offered task on the cloud model (the user's approval is frozen in
 * its context as `cloudChatApproved`, source `approved_offer`). Undefined when it cannot start; then the reason is in
 * the chat. Never throws.
 */
export function startAcceptedCloudOffer(deps: Pick<EscalationDeps, 'db' | 'actor' | 'mutate' | 'isMutatingTool'>, acceptingAttemptId: string): AttemptRecord | undefined {
  const { db } = deps;
  try {
    const row = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'cloud_offer_accepted' LIMIT 1", [acceptingAttemptId]);
    if (!row) return undefined;
    const offer = JSON.parse(row.metadata) as PendingCloudOffer;
    const offered = getAttempt(db, offer.offerAttemptId);
    const why = unfinishedTurnOf(db, offered.id, deps.isMutatingTool) ?? { reason: 'nothing_built' as const, detail: 'it was not finished', toolsRun: [] };
    const chain = chainOf(db, offered);
    const tried = chain.map((a) => getAttemptContext(db, a.id).selectedModel).reverse();
    return deps.mutate(() => {
      const successor = rerouteAttempt(db, {
        predecessorAttemptId: offered.id,
        actor: deps.actor,
        provider: offer.provider,
        model: offer.model,
        cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'free' },
        cloudChatApproved: true,
        fingerprint: why.reason,
        reason: `Cloud model approved by the user after ${tried.join(', ')} did not finish`,
        rerouteIndex: chain.length,
        continuesUnfinishedTurn: true,
        guidance: `Pandesh handed this request to you after the local models ${tried.join(', ')} did not finish it (the last one: ${why.detail}). The user approved using you for it. Ignore any earlier reply in this chat that says the work is starting or under way — it is not. Do the work now with your tools in this turn, then say exactly what exists.`,
      });
      recordRuntimeEvent(db, { domain: 'attempt', entityId: successor.id, eventType: 'attempt_escalated', actor: deps.actor, metadata: { predecessorAttemptId: offered.id, failedModel: tried.at(-1), selectedModel: offer.model, provider: offer.provider, why: why.reason, reason: 'approved cloud offer' } });
      return successor;
    });
  } catch (err) {
    try {
      const conversationId = getRequest(db, getAttempt(db, acceptingAttemptId).requestId).conversationId;
      deps.mutate(() => {
        if (conversationId) appendMessage(db, conversationId, { role: 'assistant', content: `The cloud model could not be started: ${err instanceof Error ? err.message : String(err)}. Nothing was sent.`, actor: deps.actor });
      });
    } catch { /* nothing more to do */ }
    return undefined;
  }
}

export interface EscalationDeps {
  db: CoreDatabase;
  actor: string;
  installedModels: () => Promise<InstalledModel[] | undefined>;
  isMutatingTool: (toolName: string) => boolean;
  /** Runs a mutation and broadcasts what it changed. */
  mutate: <T>(fn: () => T) => T;
  /** The free cloud model the user chose, when its key is delivered — offered (never used) once the local ladder ends. */
  cloudOffer?: () => PreferredCloudModel | undefined;
}

/**
 * After an attempt ended: the successor to run on a stronger model, or undefined (task finished, not escalatable, or
 * the ladder is exhausted — then the final report has been written to the chat). Never throws.
 */
export async function maybeEscalate(deps: EscalationDeps, attemptId: string): Promise<AttemptRecord | undefined> {
  const { db } = deps;
  try {
    const attempt = getAttempt(db, attemptId);
    if (attempt.kind !== 'baat_kar' && attempt.kind !== 'saath_kar') return undefined;
    // An Auto reroute already took over this attempt.
    if (db.get('SELECT 1 FROM attempts WHERE predecessorAttemptId = ? LIMIT 1', [attemptId])) return undefined;
    const why = unfinishedTurnOf(db, attemptId, deps.isMutatingTool);
    if (!why) return undefined;
    const context = getAttemptContext(db, attemptId);
    const request = getRequest(db, attempt.requestId);
    const chain = chainOf(db, attempt);
    const stepsOf = () => chain.slice().reverse().map((a) => ({ model: getAttemptContext(db, a.id).selectedModel, why: unfinishedTurnOf(db, a.id, deps.isMutatingTool) }))
      .filter((s): s is { model: string; why: UnfinishedTurn } => Boolean(s.why));
    if (context.selectedProvider !== OLLAMA) {
      // The cloud model the user approved after the local ladder did not finish either: the top of the ladder. A cloud
      // model picked before the chat is exact and never falls back; its own reply already says what happened.
      if (context.modelSelection?.cloudChatSource === 'approved_offer') {
        deps.mutate(() => {
          if (request.conversationId) appendMessage(db, request.conversationId, { role: 'assistant', content: exhaustedReport(stepsOf(), 'the cloud model you approved did not finish it either — there is no stronger model to try'), actor: deps.actor });
          recordRuntimeEvent(db, { domain: 'attempt', entityId: attemptId, eventType: 'escalation_exhausted', actor: deps.actor, metadata: { reason: 'approved cloud model did not finish', models: stepsOf().map((s) => s.model) } });
        });
      }
      return undefined;
    }
    const usedModels = chain.map((a) => getAttemptContext(db, a.id).selectedModel);
    const escalationsSoFar = chain.filter((a) => db.get("SELECT 1 FROM runtime_events WHERE entityId = ? AND eventType = 'attempt_escalated' LIMIT 1", [a.id])).length;
    const installed = await deps.installedModels();
    const plan: EscalationPlan = installed
      ? planEscalation({
        usedModels, installed, escalationsSoFar, requestText: request.currentMessage,
        needsTools: attempt.kind === 'saath_kar',
        needsVision: Boolean(context.modelSelection?.requiredCapabilities?.vision),
      })
      : { kind: 'exhausted', reason: 'the local model server (Ollama) could not list its models' };

    if (plan.kind === 'exhausted') {
      const steps = stepsOf();
      // Asked, never used: the chosen free cloud model is offered only in a chat (an attempt with a conversation).
      const offer = request.conversationId ? deps.cloudOffer?.() : undefined;
      deps.mutate(() => {
        if (request.conversationId) appendMessage(db, request.conversationId, { role: 'assistant', content: exhaustedReport(steps, plan.reason, offer), actor: deps.actor });
        recordRuntimeEvent(db, { domain: 'attempt', entityId: attemptId, eventType: 'escalation_exhausted', actor: deps.actor, metadata: { reason: plan.reason, models: steps.map((s) => s.model) } });
        if (offer) recordRuntimeEvent(db, { domain: 'attempt', entityId: attemptId, eventType: 'cloud_offer', actor: deps.actor, metadata: { provider: offer.provider, model: offer.model } });
      });
      return undefined;
    }

    return deps.mutate(() => {
      if (request.conversationId) appendMessage(db, request.conversationId, { role: 'assistant', content: escalationNotice(context.selectedModel, why, plan.model), actor: deps.actor });
      const successor = rerouteAttempt(db, {
        predecessorAttemptId: attemptId,
        actor: deps.actor,
        provider: OLLAMA,
        model: plan.model,
        fingerprint: why.reason,
        reason: `Escalation ${escalationsSoFar + 1}: ${context.selectedModel} — ${why.detail}; ${plan.reason}`,
        rerouteIndex: escalationsSoFar + 1,
        continuesUnfinishedTurn: true,
        guidance: escalationGuidance(context.selectedModel, why),
      });
      recordRuntimeEvent(db, {
        domain: 'attempt', entityId: successor.id, eventType: 'attempt_escalated', actor: deps.actor,
        metadata: { predecessorAttemptId: attemptId, failedModel: context.selectedModel, selectedModel: plan.model, why: why.reason, reason: plan.reason },
      });
      return successor;
    });
  } catch (err) {
    try {
      recordRuntimeEvent(db, { domain: 'attempt', entityId: attemptId, eventType: 'escalation_failed', actor: deps.actor, metadata: { error: err instanceof Error ? err.message : String(err) } });
    } catch { /* the original outcome is already durable */ }
    return undefined;
  }
}
