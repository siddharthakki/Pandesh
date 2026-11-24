import { describe, it, expect } from 'vitest';
import { describeStep, missionActiveMs, missionHeadline, missionHeartbeatMs, missionProgress, toolWords, visibleMissions, type MissionView, type StepView } from '../renderer-v2/src/missionModel';
import { detectVideoGenerationIntent, isVideoProductionRequest } from '../src/host/desktopInteractionRouting';
import { isLoadFailure, LOAD_FAILURE } from '../renderer-v2/src/composerModel';

const step = (over: Partial<StepView>): StepView => ({ id: 's', idx: 0, agentId: 'operations', kind: 'work', title: 'Diagnostics', brief: 'b', status: 'pending', resultText: null, evidence: null, artifacts: [], error: null, startedAt: null, completedAt: null, ...over });
const mission = (over: Partial<MissionView>): MissionView => ({
  id: 'msn_1', conversationId: 'c1', objective: 'Find what is slow', status: 'running', workspaceRoot: null, resultSummary: null, reportMessageId: null, cancelRequestedAt: null,
  createdAt: '2026-11-16T10:00:00.000Z', updatedAt: '2026-11-16T10:00:00.000Z', completedAt: null, steps: [], agentNames: { operations: 'Operations', reviewer: 'Reviewer' }, liveActivity: null, pendingApprovals: [], ...over,
});
const NOW = Date.parse('2026-11-16T10:01:00.000Z');

describe('mission card model', () => {
  it('shows the phase from Core\'s record: working, reviewing, waiting for the person', () => {
    const working = mission({ steps: [step({ status: 'running' }), step({ id: 'r', idx: 1, agentId: 'reviewer', kind: 'review' })] });
    expect(missionHeadline(working)).toBe('Mission · working · Operations');
    expect(missionHeadline(mission({ steps: [step({ status: 'succeeded' }), step({ id: 'r', idx: 1, agentId: 'reviewer', kind: 'review', status: 'running' })] }))).toBe('Mission · reviewing · Reviewer');
    expect(missionHeadline({ ...working, pendingApprovals: [{ approvalId: 'a', toolName: 't', text: 'x', agentName: 'Operations', requestedAt: '' }] })).toBe('Mission · waiting for your OK');
    expect(missionHeadline(mission({ status: 'completed' }))).toBe('Mission complete · checked');
    expect(missionHeadline(mission({ status: 'completed_with_issues' }))).toBe('Mission finished · points to check');
    expect(missionHeadline(mission({ status: 'interrupted' }))).toBe('Mission interrupted');
  });

  it('counts only finished steps as done', () => {
    const m = mission({ steps: [step({ status: 'succeeded' }), step({ id: 'b', idx: 1, status: 'running' }), step({ id: 'c', idx: 2 })] });
    expect(missionProgress(m)).toEqual({ done: 1, total: 3, percent: 50 });
    expect(missionProgress(mission({ steps: [step({ status: 'unverified' })] })).percent).toBe(100);
  });

  it('a running step says what it is doing now, from the last recorded tool call', () => {
    const m = mission({ steps: [step({ status: 'running', startedAt: '2026-11-16T10:00:20.000Z' })], liveActivity: { tool: 'run_system_diagnostics', status: 'running', at: '' } });
    expect(describeStep(m.steps[0], m, NOW)).toEqual({ agent: 'Operations', state: '40s', sub: 'now: running system diagnostics', mark: 'run' });
    expect(describeStep(m.steps[0], { ...m, liveActivity: null }, NOW).sub).toBe('thinking about the brief');
    expect(toolWords('some_new_tool')).toBe('some new tool');
  });

  it('never presents an unbacked report as done', () => {
    const m = mission({});
    const unverified = describeStep(step({ status: 'unverified', evidence: { verified: [], unrelated: [], failed: [], unbacked: [], totalCalls: 0 } }), m, NOW);
    expect(unverified.mark).toBe('warn');
    expect(unverified.sub).toMatch(/treat it as opinion/);
    const done = describeStep(step({ status: 'succeeded', evidence: { verified: [{ tool: 'read_file', count: 2 }], unrelated: [], failed: [], unbacked: [], totalCalls: 2, seconds: 75 } }), m, NOW);
    expect(done).toMatchObject({ mark: 'done', state: '1m 15s', sub: 'ran read_file ×2' });
    expect(describeStep(step({ status: 'failed', error: 'the Coding agent\'s task ended as "failed"' }), m, NOW)).toMatchObject({ mark: 'fail', sub: 'the Coding agent\'s task ended as "failed"' });
  });

  it('a step whose own tools say something was not checked or delivered is not a plain tick', () => {
    const ev = { verified: [{ tool: 'media_inspect', count: 1 }], unrelated: [], failed: [], unbacked: [], totalCalls: 1, seconds: 20, caveats: ['Not verified: what the pictures show. Technical check only.', 'Incomplete: the upload sheet has no tags'] };
    const d = describeStep(step({ status: 'succeeded', evidence: ev }), mission({}), NOW);
    expect(d.mark).toBe('warn');
    expect(d.sub).toBe('ran media_inspect. Not verified: what the pictures show. Technical check only. (+1 more)');
    // A sample is a warning while the mission is open or ended with issues; once Core counted it as covering everything, it is not.
    const sample = { ...ev, caveats: ['Sampled: what the pictures show (3 frames of a.mp4)'] };
    expect(describeStep(step({ status: 'succeeded', evidence: sample }), mission({ status: 'completed_with_issues' }), NOW).mark).toBe('warn');
    expect(describeStep(step({ status: 'succeeded', evidence: sample }), mission({ status: 'completed' }), NOW).mark).toBe('done');
    expect(missionHeadline(mission({ status: 'completed_with_issues', steps: [step({ status: 'succeeded', evidence: ev })] }))).toBe('Mission finished · not everything checked');
  });

  it('shows running missions from any chat, and this chat\'s finished ones for a while', () => {
    const here = mission({ id: 'a', status: 'completed', completedAt: '2026-11-16T09:50:00.000Z' });
    const old = mission({ id: 'b', status: 'completed', completedAt: '2026-11-16T08:00:00.000Z' });
    const elsewhereRunning = mission({ id: 'c', conversationId: 'c2' });
    const elsewhereDone = mission({ id: 'd', conversationId: 'c2', status: 'completed', completedAt: '2026-11-16T09:59:00.000Z' });
    const elsewhereAsking = mission({ id: 'e', conversationId: 'c2', pendingApprovals: [{ approvalId: 'p', toolName: 'run_checks', text: 't', agentName: null, requestedAt: '2026-11-16T10:00:30.000Z' }] });
    expect(visibleMissions([here, old, elsewhereRunning, elsewhereDone, elsewhereAsking], 'c1', NOW).map((m) => m.id)).toEqual(['e', 'a']);
  });
});

describe('a video that has to be produced goes to the lead, not to one text-to-video render', () => {
  it.each([
    'Pandesh, create a 60–90 second faceless bedtime story video for children about a clever rabbit. Make it engaging, narrate it, add visuals, subtitles and music if suitable, and prepare everything for YouTube.',
    'Make a 2 minute explainer video about tides with a voice-over',
    'Create a video with subtitles about our bakery',
  ])('production: %s', (text) => {
    expect(isVideoProductionRequest(text)).toBe(true);
    expect(detectVideoGenerationIntent(text)).toBe(false);
  });

  it.each([
    'Generate a short cinematic clip of waves at sunset',
    'Make a 4 second video of a fox running',
    'Create an animation of a spinning coin',
  ])('one render: %s', (text) => {
    expect(isVideoProductionRequest(text)).toBe(false);
    expect(detectVideoGenerationIntent(text)).toBe(true);
  });
});

describe('the "could not load this chat" notice', () => {
  it('is recognised exactly, so a later successful load retires it and nothing else', () => {
    expect(isLoadFailure(`${LOAD_FAILURE}Core is not connected`)).toBe(true);
    expect(isLoadFailure('Not sent: Core is not connected')).toBe(false);
    expect(isLoadFailure('Stop requested — waiting for the worker to confirm.')).toBe(false);
    expect(isLoadFailure(null)).toBe(false);
  });
});

describe('mission clock', () => {
  it('charges a resumed mission only for the time its running steps have been running, not since it was created', () => {
    const m = mission({ createdAt: '2026-11-14T10:00:00.000Z', updatedAt: '2026-11-16T10:00:40.000Z', steps: [step({ status: 'running', startedAt: '2026-11-16T10:00:08.000Z' }), step({ id: 'b', idx: 1, status: 'running', startedAt: '2026-11-16T10:00:30.000Z' })] });
    expect(missionActiveMs(m, NOW)).toBe(52_000);
    expect(missionHeartbeatMs(m, NOW)).toBe(20_000);
    expect(missionActiveMs(mission({ steps: [step({ status: 'pending' })] }), NOW)).toBeNull();
  });
});
