import { describe, expect, it } from 'vitest';
import { buildPhoneInbox } from '../src/host/phoneInbox';

const NOW = Date.parse('2026-11-23T11:00:00Z');
const step = (kind: string, status: string, resultText: string | null) => ({ kind, agentId: kind === 'review' ? 'reviewer' : 'personal', title: kind === 'review' ? 'Gap review' : 'Draft', status, resultText, error: null });
const base = {
  approvals: [
    { id: 'appr_1', attemptId: 'att_1', status: 'pending', requestedAt: '2026-11-23T10:02:19Z', presentation: { toolName: 'mission_start', cardText: 'Pandesh wants to start a background mission: "Raise funds".' } },
    { id: 'appr_old', attemptId: 'att_2', status: 'expired', requestedAt: '2026-11-23T09:58:22Z', presentation: { toolName: 'mission_start', cardText: 'old' } },
  ],
  missions: [
    { id: 'msn_1', conversationId: 'c1', objective: 'Trip checklist, reviewed', status: 'completed', resultSummary: null, updatedAt: '2026-11-23T10:24:17Z', completedAt: '2026-11-23T10:24:17Z', steps: [step('work', 'succeeded', '# Checklist\n- [ ] Charge'), step('review', 'succeeded', '| Power bank capacity check | ❌ Not addressed |')] },
    { id: 'msn_old', conversationId: 'c2', objective: 'Old', status: 'completed', resultSummary: null, updatedAt: '2026-11-18T10:00:00Z', completedAt: '2026-11-18T10:00:00Z', steps: [] },
    { id: 'msn_run', conversationId: 'c3', objective: 'Running', status: 'running', resultSummary: null, updatedAt: '2026-11-23T10:59:00Z', completedAt: null, steps: [] },
  ],
  bridge: [
    { id: 't1', instruction: 'Add multiply()', executor: 'claude', state: 'waiting_for_approval', stateLabel: 'Waiting', reason: '', createdAt: '2026-11-23T10:00:00Z', lastEventAt: '2026-11-23T10:30:00Z', verification: null, codeChange: { project: 'CalcDemo', awaitingReview: true, changedFiles: ['a.js'] }, outcome: null },
    { id: 't2', instruction: 'Watchdog', executor: 'service:watchdog', state: 'failed', stateLabel: 'Failed', reason: 'x', createdAt: '2026-11-23T10:00:00Z', lastEventAt: '2026-11-23T10:30:00Z', verification: null },
  ],
  bridgeApprovals: [{ taskId: 't9', agentLabel: 'Claude Code', provider: 'Anthropic', instruction: 'Refactor', requestedAt: '2026-11-23T10:40:00Z' }],
  tasks: [{ attemptId: 'att_1', conversationId: 'c4', title: 'Raise funds' }],
  now: NOW,
};

describe('Phone Inbox', () => {
  it('lists only pending cards as answerable decisions, with the card text; sensitive reviews stay on the PC', () => {
    const { items, counts } = buildPhoneInbox(base);
    const decisions = items.filter((i) => i.kind === 'decision');
    expect(decisions.map((d) => d.id).sort()).toEqual(['approval:appr_1', 'change:t1', 'cloud:t9']);
    expect(decisions.find((d) => d.id === 'approval:appr_1')).toMatchObject({ approvalId: 'appr_1', title: 'Start a mission?', detail: expect.stringContaining('Raise funds') });
    for (const id of ['change:t1', 'cloud:t9']) {
      const d = decisions.find((x) => x.id === id)!;
      expect(d.reviewOnPc).toBe(true);
      expect(d.approvalId).toBeUndefined();
    }
    expect(counts).toEqual({ decision: 3, result: 1, problem: 0 });
  });

  it('a finished mission carries its result and the review, with the review verdict; old, running and service work stay out', () => {
    const r = buildPhoneInbox(base).items.find((i) => i.kind === 'result')!;
    expect(r).toMatchObject({ id: 'mission:msn_1', verdict: 'gaps', detail: 'Done. The Reviewer found gaps.' });
    expect(r.body).toContain('Checklist');
    expect(r.review).toContain('Power bank');
    expect(buildPhoneInbox(base).items.some((i) => ['mission:msn_old', 'mission:msn_run', 'task:t2'].includes(i.id))).toBe(false);
  });

  it('a failed step shows Core\'s reason as the description and keeps the agent\'s output behind Read result (live 2026-11-23)', () => {
    const err = 'the Personal agent\'s task ended as "failed" after 29s. Its last message: **NOT DONE** (checked by Pandesh Core): gmail_create_draft reported that it could not do it.\n\nHere\'s your **Checklist**\n- water';
    const { items } = buildPhoneInbox({ ...base, approvals: [], bridge: [], bridgeApprovals: [], missions: [{ id: 'm', conversationId: 'c', objective: 'Hiking list', status: 'failed', resultSummary: null, updatedAt: '2026-11-23T10:36:08Z', completedAt: '2026-11-23T10:36:08Z', steps: [{ kind: 'work', agentId: 'personal', title: 'Draft', status: 'failed', resultText: null, error: err }] }] });
    expect(items[0].detail).toMatch(/^Draft: .*gmail_create_draft reported that it could not do it\.$/);
    expect(items[0].body).toContain('Checklist');
  });

  it('decisions come first, then problems, then results', () => {
    const { items } = buildPhoneInbox({ ...base, missions: [...base.missions, { id: 'msn_f', conversationId: 'c5', objective: 'Broke', status: 'failed', resultSummary: 'nope', updatedAt: '2026-11-23T10:50:00Z', completedAt: '2026-11-23T10:50:00Z', steps: [] }] });
    expect(items.map((i) => i.kind)).toEqual(['decision', 'decision', 'decision', 'problem', 'result']);
  });
});
