import { describe, expect, it } from 'vitest';
import { buildJourneys, cardsFrom, chatJourney, codeJourney, missionJourney, reviewFoundGaps } from '../renderer-v2/src/journeyModel';
import type { MissionView } from '../renderer-v2/src/missionModel';
import type { BridgeActivityItem } from '../renderer-v2/src/Missions';
import type { TaskRow } from '../renderer-v2/src/bridge';

const step = (idx: number, kind: 'work' | 'review', status: MissionView['steps'][0]['status'], extra: Partial<MissionView['steps'][0]> = {}) => ({
  id: `s${idx}`, idx, agentId: kind === 'review' ? 'reviewer' : 'operations', kind, title: kind === 'review' ? 'Check it' : 'Write the checklist', brief: 'brief text here',
  status, resultText: null, evidence: null, artifacts: [], error: null, startedAt: null, completedAt: null, ...extra,
});
const mission = (p: Partial<MissionView>): MissionView => ({
  id: 'msn_1', conversationId: 'conv_1', objective: 'A packing checklist, reviewed', status: 'running', workspaceRoot: null, resultSummary: null, reportMessageId: null, cancelRequestedAt: null,
  createdAt: '2026-11-23T10:00:00Z', updatedAt: '2026-11-23T10:01:00Z', completedAt: null, steps: [step(0, 'work', 'running'), step(1, 'review', 'pending')],
  agentNames: { operations: 'Operations', reviewer: 'Reviewer' }, liveActivity: null, pendingApprovals: [], ...p,
});
const states = (j: { stages: Array<{ state: string }> }) => j.stages.map((s) => s.state).join(' ');

describe('Wish journeys', () => {
  it('a running mission is at Execute; its review is still ahead', () => {
    const j = missionJourney(mission({}), null);
    expect(states(j)).toBe('done done done done now todo todo');
    expect(j.now).toBe('execute');
    expect(j.live).toBe(true);
  });

  it('a step asking for approval puts the mission at Permissions with an Allow action', () => {
    const j = missionJourney(mission({ pendingApprovals: [{ approvalId: 'apr_1', toolName: 'write_file', text: 'write file — path: a.md', agentName: 'Operations', requestedAt: '2026-11-23T10:01:00Z' }] }), null);
    expect(j.now).toBe('permissions');
    expect(j.needsYou).toBe(true);
    expect(j.actions[0]).toEqual({ kind: 'allow', approvalId: 'apr_1', text: 'write file — path: a.md' });
  });

  it('a completed mission with a review is verified and delivered; without one, Verify says it was not planned', () => {
    const done = missionJourney(mission({ status: 'completed', steps: [step(0, 'work', 'succeeded'), step(1, 'review', 'succeeded', { resultText: 'No gaps found' })] }), { headline: 'Verified', verifiedOutputs: [], artifacts: [], nextAction: null, independentlyReviewed: true, partialOrFailed: [] });
    expect(states(done)).toBe('done done done done done done done');
    expect(done.headline).toMatch(/independently reviewed/);
    const noReview = missionJourney(mission({ status: 'completed', steps: [step(0, 'work', 'succeeded')] }), null);
    expect(noReview.stages[5]).toMatchObject({ state: 'skip' });
  });

  it('a review that found gaps is a caveat at Verify, and the result and review are readable in place (live run 2026-11-23)', () => {
    const j = missionJourney(mission({ status: 'completed', steps: [step(0, 'work', 'succeeded', { resultText: '# Checklist\n- [ ] Charge' }), step(1, 'review', 'succeeded', { resultText: '| Power bank capacity check | ❌ Not addressed |' })] }), null);
    expect(j.stages[5].state).toBe('warn');
    expect(j.headline).toMatch(/Reviewer found gaps/);
    expect(j.outputs?.map((o) => o.kind)).toEqual(['work', 'review']);
    expect(reviewFoundGaps('No gaps found; nothing missing.')).toBe(false);
    expect(reviewFoundGaps('Critical Missing Items: flight delay buffer')).toBe(true);
  });

  it('an unverified work step is shown as done with a caveat, never as plain done', () => {
    const j = missionJourney(mission({ status: 'completed', steps: [step(0, 'work', 'unverified')] }), null);
    expect(j.stages[4].state).toBe('warn');
  });

  it('a Kandev change waiting for the owner is at Verify; a deliverable result offers to bring it into the checkout', () => {
    const b: BridgeActivityItem = {
      id: 't1', origin: { client: 'Pandesh', title: null, via: null }, instruction: 'Add multiply()', executor: 'claude', state: 'waiting_for_approval', stateLabel: 'Waiting for approval', reason: '',
      progress: null, elapsedMs: null, heartbeatAgeMs: null, verification: null, conversationId: null, createdAt: '2026-11-23T10:00:00Z', latest: null, lastEventAt: null, eventCount: 12, branch: null,
      pendingWorkerActions: [], storyId: 's', codeChange: { project: 'CalcDemo', baseRef: 'main', awaitingReview: true, changedFiles: ['a.js'], deliverable: false, delivered: null },
    };
    expect(codeJourney(b, null).now).toBe('verify');
    const done = codeJourney({ ...b, state: 'completed', verification: 'human-reviewed', codeChange: { ...b.codeChange!, awaitingReview: false, deliverable: true } }, null);
    expect(done.actions.some((a) => a.kind === 'deliver')).toBe(true);
    // Regression (live 2026-11-23): an optional "bring into checkout" made finished tasks count as needing the owner.
    expect(done.needsYou).toBe(false);
  });

  it('a wish sent from the screen follows its chat until a mission takes over, keeping the owner\'s words', () => {
    const task = (status: string): TaskRow => ({ attemptId: 'a', requestId: 'r', conversationId: 'conv_1', kind: 'chat', status, title: 't', provider: null, model: null, worker: 'w', activity: '', createdAt: '2026-11-23T10:00:00Z', startedAt: null, completedAt: null, elapsedMs: 0, lastEventAt: null, lastEventType: null, cancelRequestedAt: null, failureReason: null, cancellable: false, live: true, leaseExpiresAt: null, interrupted: false });
    const w = { conversationId: 'conv_1', text: 'Make me a packing checklist', at: '2026-11-23T10:00:00Z' };
    expect(chatJourney(w, [], null).now).toBe('understand');
    expect(chatJourney(w, [task('waiting_for_approval')], { conversationId: 'conv_1', approvalId: 'x', detail: 'Start a mission' }).now).toBe('permissions');
    // Regression (live 2026-11-23): a card in a chat that is not open was shown as "Pandesh is on it" with no way to review it.
    const notOpen = chatJourney(w, [{ ...task('waiting_for_approval'), activity: 'Running mission_start', createdAt: '2026-11-23T10:05:00Z' }, task('completed')], null);
    expect(notOpen).toMatchObject({ now: 'permissions', needsYou: true });
    expect(notOpen.headline).toMatch(/proposes a mission\. Read it and decide here/);
    expect(notOpen.actions[0]).toMatchObject({ kind: 'review_chat' });
    // Regression (live 2026-11-23): a card in a chat that was not open could not be approved there and expired. It is decided on the wish itself.
    const cards = cardsFrom([{ id: 'appr_9', attemptId: 'a', status: 'pending', requestedAt: '2026-11-23T10:02:19Z', presentation: { toolName: 'mission_start', cardText: 'Pandesh wants to start a background mission: "X".' } }], [task('waiting_for_approval')]);
    expect(cards[0]).toMatchObject({ conversationId: 'conv_1', toolName: 'mission_start' });
    const decideHere = chatJourney(w, [task('waiting_for_approval')], null, cards);
    expect(decideHere.actions[0]).toEqual({ kind: 'allow', approvalId: 'appr_9', text: 'Pandesh wants to start a background mission: "X".' });
    expect(decideHere.stages[3].detail).toContain('background mission');
    // Regression (live 2026-11-23): the turn ended with Core's "This request is not done" (resultStatus failed); it is not an answer.
    const notDone = chatJourney(w, [{ ...task('completed'), resultStatus: 'failed' }], null);
    expect(notDone).toMatchObject({ failed: true, now: 'execute' });
    expect(notDone.stages[6].state).toBe('todo');
    const answered = chatJourney(w, [task('completed')], null);
    expect(answered.stages[5]).toMatchObject({ state: 'skip' });
    const all = buildJourneys({ tracked: [w], missions: [mission({})], bridge: [], approvals: [], tasks: [task('completed')], pending: null, receipts: {} });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'mission', title: 'Make me a packing checklist' });
    // Owner feedback 2026-11-23: missions no wish asked for are Missions' business, not duplicated here.
    const other = buildJourneys({ tracked: [w], missions: [mission({}), mission({ id: 'msn_2', conversationId: 'conv_other' })], bridge: [], approvals: [], tasks: [], pending: null, receipts: {} });
    expect(other.map((j) => j.id)).toEqual(['m:msn_1']);
  });
});
