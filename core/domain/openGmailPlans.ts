/**
 * Gmail previews made earlier in this conversation and still open, carried into the next turn.
 *
 * Production, 2026-11-12 (Build 164, gemma4:12b): gmail_plan_changes made a preview in one turn, and the reply named it
 * "gplan_1a2b3c4d...". When the user then said to apply it, the next turn had only that shortened id: tool results are
 * not part of the history (see earlierReads.ts). The model made up the rest of the id, and gmail_apply_plan found no
 * such plan. This module reads Core's own tool records for the conversation and the plan journal
 * (`gmail_change_plans`), and returns each preview that is still open, with its exact id, for the turn's state block.
 * Only the change, the message count and the search are carried, never a sender or a subject.
 */
import type { CoreDatabase } from '../db/connection';

export interface OpenGmailPlan {
  planId: string;
  /** The plain-language change, as on the approval card. */
  change: string;
  messages: number;
  /** The Gmail search the preview was made with. */
  query: string;
  createdAt: string;
  expiresAt: string;
}

const PLAN_ID_IN_OUTPUT = /"planId"\s*:\s*"(gplan_[0-9a-f-]{8,64})"/;

export function listOpenGmailPlans(
  db: CoreDatabase,
  conversationId: string,
  options: { excludeRequestId?: string; nowMs?: number; limit?: number } = {},
): OpenGmailPlan[] {
  const rows = db.all<{ evidence: string | null }>(
    `SELECT ti.evidence AS evidence
       FROM tool_invocations ti
       JOIN attempts a ON a.id = ti.attemptId
       JOIN requests r ON r.id = a.requestId
      WHERE r.conversationId = ? AND r.id != ? AND ti.status = 'succeeded' AND ti.toolName = 'gmail_plan_changes'
      ORDER BY ti.startedAt DESC, ti.rowid DESC
      LIMIT 40`,
    [conversationId, options.excludeRequestId ?? ''],
  );
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const seen = new Set<string>();
  const out: OpenGmailPlan[] = [];
  for (const row of rows) {
    let output = '';
    try {
      const evidence = JSON.parse(row.evidence ?? '') as { output?: unknown };
      output = typeof evidence.output === 'string' ? evidence.output : '';
    } catch { output = ''; }
    // The id opens the tool's output, so even Core's shortened copy of the output still holds it.
    const planId = PLAN_ID_IN_OUTPUT.exec(output)?.[1];
    if (!planId || seen.has(planId)) continue; // Core can record one call twice (the capability anchor)
    seen.add(planId);
    const stored = db.get<{ planJson: string; status: string; expiresAt: string }>(
      'SELECT planJson, status, expiresAt FROM gmail_change_plans WHERE planId = ?',
      [planId],
    );
    if (!stored || stored.status !== 'planned' || !(stored.expiresAt > nowIso)) continue;
    let plan: { operation?: { summary?: unknown }; messages?: unknown; query?: unknown; createdAt?: unknown; taskId?: unknown };
    try { plan = JSON.parse(stored.planJson); } catch { continue; }
    if (plan.taskId) continue; // a batch of a durable Gmail task is applied by that task, not from chat
    out.push({
      planId,
      change: typeof plan.operation?.summary === 'string' && plan.operation.summary ? plan.operation.summary : 'a Gmail label change',
      messages: Array.isArray(plan.messages) ? plan.messages.length : 0,
      query: typeof plan.query === 'string' ? plan.query : '',
      createdAt: typeof plan.createdAt === 'string' ? plan.createdAt : '',
      expiresAt: stored.expiresAt,
    });
    if (out.length >= (options.limit ?? 3)) break;
  }
  return out;
}

function utc(iso: string): string {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
}

/** The state-block section, or '' when no preview is open. Bounded: at most a few lines, each search cut. */
export function renderOpenGmailPlansSection(plans: readonly OpenGmailPlan[]): string {
  if (plans.length === 0) return '';
  const lines = plans.map((p) => {
    const query = p.query.length > 120 ? `${p.query.slice(0, 120)}…` : p.query;
    return `- planId ${p.planId}: ${p.change}; ${p.messages} message${p.messages === 1 ? '' : 's'}${query ? `; found with: ${query}` : ''}; made ${utc(p.createdAt)}, open until ${utc(p.expiresAt)}`;
  });
  return 'GMAIL PREVIEWS STILL OPEN IN THIS CONVERSATION (made with gmail_plan_changes; nothing in the mailbox has changed yet), newest first. '
    + 'When the user asks to apply one, call gmail_apply_plan with its planId exactly as written here, never shortened or retyped from memory; '
    + 'the user then approves the exact change. If it is unclear which one the user means, ask:\n'
    + lines.join('\n');
}
