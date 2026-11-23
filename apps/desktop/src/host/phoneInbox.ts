/**
 * Phone Inbox: what needs the owner, what finished, what went wrong — built on the PC from Core's own records and sent
 * to the paired phone as a short list. Nothing here decides or runs anything:
 *  - decisions are Core's pending approval cards (GET /v1/approvals/pending), answered through the same
 *    resolveAssistantApproval path the PC uses, and only while Core still lists them as pending;
 *  - a cloud coding engine's request and a code change waiting for review need the full PC review, so the phone
 *    shows them as "review on your PC" without a one-tap approve;
 *  - results and problems are finished/failed missions and worker tasks, with the specialists' own result text.
 * Pure, so tested without a server.
 */

export type InboxKind = 'decision' | 'result' | 'problem';
export interface InboxItem {
  id: string; kind: InboxKind; title: string; detail: string; at: string; source: string;
  /** Present when the phone may answer it: the Core approval id. */
  approvalId?: string;
  /** A decision that needs the full review on the PC. */
  reviewOnPc?: boolean;
  /** For results: the outcome in the specialists' words (trimmed), and what checked it. */
  body?: string; review?: string; verdict?: 'reviewed' | 'gaps' | 'not_reviewed';
}

interface Approval { id: string; attemptId: string; status: string; requestedAt: string; presentation?: Record<string, unknown> | null; summary?: Record<string, unknown> | null }
interface Step { kind: string; agentId: string; title: string; status: string; resultText: string | null; error: string | null }
interface Mission { id: string; conversationId: string; objective: string; status: string; resultSummary: string | null; updatedAt: string; completedAt: string | null; steps: Step[]; agentNames?: Record<string, string> }
interface Bridge { id: string; instruction: string; executor: string | null; state: string; stateLabel: string; reason: string; createdAt: string; lastEventAt: string | null; verification: string | null; codeChange?: { project: string; awaitingReview: boolean; changedFiles: string[] } | null; outcome?: { summary: string } | null }
interface BridgeApproval { taskId: string; agentLabel: string; provider: string; instruction: string; requestedAt: string }
interface Task { attemptId: string; conversationId: string | null; title: string }

export const RESULT_WINDOW_MS = 48 * 3600_000;
const BODY_MAX = 1800;
const ENGINE: Record<string, string> = { claude: 'Claude Code', opencode: 'OpenCode', hermes: 'Hermes', antigravity: 'Antigravity', native: 'Pandesh' };

/** A review that reports missing items or gaps in its own words. */
export const reviewFoundGaps = (text: string | null): boolean => Boolean(text && /❌|(?<!(nothing|no|not) )\bmissing\b|(?<!no )\bgaps? (found|identified)\b|\bnot addressed\b|(?<!not )\bincomplete\b/i.test(text));
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

export function buildPhoneInbox(i: { approvals: Approval[]; missions: Mission[]; bridge: Bridge[]; bridgeApprovals: BridgeApproval[]; tasks: Task[]; now: number }): { items: InboxItem[]; counts: Record<InboxKind, number> } {
  const items: InboxItem[] = [];
  const titleOf = new Map(i.tasks.map((t) => [t.attemptId, t.title]));

  for (const a of i.approvals.filter((x) => x.status === 'pending')) {
    const p = (a.presentation ?? a.summary ?? {}) as Record<string, unknown>;
    const tool = String(p.toolName ?? '').replace(/_/g, ' ');
    items.push({
      id: `approval:${a.id}`, kind: 'decision', approvalId: a.id, at: a.requestedAt, source: 'Pandesh',
      title: tool === 'mission start' ? 'Start a mission?' : tool ? `Allow ${tool}?` : 'Pandesh asks for your OK',
      detail: typeof p.cardText === 'string' ? p.cardText : (titleOf.get(a.attemptId) ?? 'An action waits for your decision'),
    });
  }
  for (const a of i.bridgeApprovals) {
    items.push({ id: `cloud:${a.taskId}`, kind: 'decision', reviewOnPc: true, at: a.requestedAt, source: `${a.agentLabel} (${a.provider})`, title: `Let ${a.agentLabel} run a task?`, detail: `${trim(a.instruction, 240)} — the full request (what it may read, where it runs) is on your PC.` });
  }
  for (const b of i.bridge.filter((x) => !(x.executor ?? '').startsWith('service:'))) {
    const src = b.executor ? `${ENGINE[b.executor] ?? b.executor} via Kandev` : 'Kandev';
    if (b.codeChange?.awaitingReview) {
      items.push({ id: `change:${b.id}`, kind: 'decision', reviewOnPc: true, at: b.lastEventAt ?? b.createdAt, source: src, title: `Review a change to ${b.codeChange.project}`, detail: `${b.codeChange.changedFiles.length} file${b.codeChange.changedFiles.length === 1 ? '' : 's'} changed in a private copy. ${b.outcome?.summary ? trim(b.outcome.summary, 300) : ''} Review the diff on your PC.` });
      continue;
    }
    const at = b.lastEventAt ?? b.createdAt;
    if (i.now - Date.parse(at) > RESULT_WINDOW_MS) continue;
    if (b.state === 'completed') items.push({ id: `task:${b.id}`, kind: 'result', at, source: src, title: trim(b.instruction, 140), detail: b.outcome?.summary ? trim(b.outcome.summary, 400) : b.stateLabel, verdict: b.verification === 'independent' || b.verification === 'human-reviewed' ? 'reviewed' : 'not_reviewed' });
    else if (b.state === 'failed') items.push({ id: `task:${b.id}`, kind: 'problem', at, source: src, title: trim(b.instruction, 140), detail: b.reason || b.stateLabel });
  }
  for (const m of i.missions) {
    const at = m.completedAt ?? m.updatedAt;
    if (m.status === 'running' || i.now - Date.parse(at) > RESULT_WINDOW_MS) continue;
    const work = m.steps.filter((s) => s.kind === 'work' && s.resultText);
    const review = m.steps.find((s) => s.kind === 'review' && s.resultText) ?? null;
    if (m.status === 'completed' || m.status === 'completed_with_issues') {
      const gaps = reviewFoundGaps(review?.resultText ?? null);
      items.push({
        id: `mission:${m.id}`, kind: 'result', at, source: 'Mission', title: trim(m.objective, 140),
        detail: m.status === 'completed_with_issues' ? 'Finished with issues: some steps could not be verified.' : review ? (gaps ? 'Done. The Reviewer found gaps.' : 'Done and reviewed.') : 'Done. No independent review was planned.',
        body: work.length ? trim(work.map((s) => s.resultText as string).join('\n\n'), BODY_MAX) : undefined,
        review: review ? trim(review.resultText as string, 900) : undefined,
        verdict: review ? (gaps ? 'gaps' : 'reviewed') : 'not_reviewed',
      });
    } else {
      const failed = m.steps.find((s) => s.status === 'failed');
      // The first line of a step error is Core's reason; what follows is the agent's own output, readable on request.
      const err = failed?.error ?? '';
      const nl = err.indexOf('\n');
      const reason = nl > 0 ? err.slice(0, nl) : err;
      const rest = nl > 0 ? err.slice(nl + 1).trim() : '';
      items.push({
        id: `mission:${m.id}`, kind: 'problem', at, source: 'Mission', title: trim(m.objective, 140),
        detail: failed ? trim(`${failed.title}: ${reason || 'failed'}`, 320) : m.status === 'interrupted' ? 'Interrupted. Continue it from Missions on your PC.' : m.resultSummary ?? m.status,
        body: rest ? trim(rest, BODY_MAX) : undefined,
      });
    }
  }
  const order: Record<InboxKind, number> = { decision: 0, problem: 1, result: 2 };
  items.sort((a, b) => order[a.kind] - order[b.kind] || b.at.localeCompare(a.at));
  return { items, counts: { decision: items.filter((x) => x.kind === 'decision').length, result: items.filter((x) => x.kind === 'result').length, problem: items.filter((x) => x.kind === 'problem').length } };
}
