/**
 * Missions: the durable record, the background runner (with a stand-in executor: no model runs), the lead's tools,
 * the privacy rule for passing results between steps, recovery after a restart, and what a clean mission leaves behind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { appendMessage, createConversation, listMessages } from '../domain/conversations';
import { createApproval, getApproval } from '../domain/approvals';
import { newId, nowIso } from '../domain/ids';
import {
  createMission, expireStepApprovals, getMission, interruptRunningMissionsOnBoot, listMissions, reopenMission, requestMissionCancel,
  similarFinishedMissions, updateMission, updateMissionStep, MAX_MISSION_STEPS,
} from '../domain/missions';
import { MissionRunner, existingPathsIn, missionProcedure, openCaveats, renderMissionReport, resultsForStep, reviewFoundProblems, stepBatches, toolCaveats } from '../runtime/missionRunner';
import { buildMissionTools, describeMission, missionRoster, missionTurnFact } from '../runtime/missionTools';
import { missionView, approvalLine } from '../api/missionRoutes';
import { hasActiveWorker } from '../runtime/assistantStatus';

let dir: string;
let db: CoreDatabase;
let n = 0;

function lead(message = 'Find out what is slow and have it checked') {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
  const r = submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'baat_kar', conversationId: conv.id, workspaceRoot: dir,
    capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${++n}`, toolPermissionPolicy: {},
    selectedProvider: 'ollama', selectedModel: 'zeta:1b',
  });
  return { conversationId: conv.id, attemptId: r.attempt.id };
}

const mission = (steps: Array<{ agentId: string; title?: string; brief?: string; kind?: 'work' | 'review'; parallel?: boolean }>, objective = 'Diagnose the slow computer and verify the findings') => {
  const l = lead();
  return createMission(db, {
    conversationId: l.conversationId, parentAttemptId: l.attemptId, clientId: 'test-client', objective, workspaceRoot: dir, selectedProvider: 'ollama', selectedModel: 'zeta:1b',
    steps: steps.map((s, i) => ({ agentId: s.agentId, title: s.title ?? `Step ${i + 1}`, brief: s.brief ?? (s.kind === 'review' ? 'Check the system diagnostics findings and the files of the earlier steps with your own tools.' : `Carry out step ${i + 1} of the plan.`), kind: s.kind, parallel: s.parallel })),
  });
};

type Script = (ctx: { attemptId: string; conversationId: string; brief: string; agentId: string }) => { status?: 'completed' | 'failed' | 'cancelled'; answer?: string; tools?: Array<{ name: string; status?: string; args?: string; evidence?: string }>; delayMs?: number };

/** Stands in for RuntimeExecutor: settles the delegated attempt the way a real run would leave it in the database. */
function fakeExecutor(script: Script) {
  const started: string[] = [];
  const cancelled = new Set<string>();
  const lanes: Array<string | undefined> = [];
  let active = 0;
  let maxActive = 0;
  return {
    started, cancelled, lanes, get maxActive() { return maxActive; },
    async execute(attemptId: string, options?: { lane?: 'interactive' | 'background' }) {
      started.push(attemptId);
      lanes.push(options?.lane);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const row = db.get<{ conversationId: string; brief: string; agentId: string }>('SELECT q.conversationId AS conversationId, q.currentMessage AS brief, r.agentId AS agentId FROM attempts a JOIN requests q ON q.id = a.requestId JOIN agent_runs r ON r.requestId = q.id WHERE a.id = ?', [attemptId])!;
      const out = script({ attemptId, ...row });
      const until = Date.now() + (out.delayMs ?? 0);
      while (Date.now() < until && !cancelled.has(attemptId)) await new Promise((r) => setTimeout(r, 5));
      for (const t of out.tools ?? []) {
        db.run('INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt, endedAt, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [newId('tinv'), attemptId, t.name, t.args ?? '{}', t.status ?? 'succeeded', nowIso(), nowIso(), t.evidence ?? '{}']);
      }
      const status = cancelled.has(attemptId) ? 'cancelled' : out.status ?? 'completed';
      if (status === 'completed' && out.answer) appendMessage(db, row.conversationId, { role: 'assistant', content: out.answer, actor: 'test' });
      db.run('UPDATE attempts SET status = ? WHERE id = ?', [status, attemptId]);
      active -= 1;
    },
    cancel(attemptId: string) { cancelled.add(attemptId); },
  };
}

function runner(script: Script, extra: Partial<ConstructorParameters<typeof MissionRunner>[0]> = {}) {
  const executor = fakeExecutor(script);
  const facts = new Map<string, { text: string; privateTexts: string[] }>();
  const r = new MissionRunner({
    db, executor, pollMs: 5,
    setHandoffFacts: (id, f) => { if (f) facts.set(id, f); },
    knownToolNames: () => ['run_system_diagnostics', 'read_file', 'media_inspect', 'web_research', 'find_skill'],
    ...extra,
  });
  return { r, executor, facts };
}

async function settle(r: MissionRunner, id: string) {
  for (let i = 0; i < 600 && (r.isRunning(id) || getMission(db, id).status === 'running'); i += 1) await new Promise((res) => setTimeout(res, 10));
  return getMission(db, id);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('mission record', () => {
  it('stores the plan in order and refuses an empty, vague or oversized one', () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'reviewer', kind: 'review' }]);
    expect(m.status).toBe('running');
    expect(m.steps.map((s) => [s.idx, s.agentId, s.kind, s.status])).toEqual([[0, 'operations', 'work', 'pending'], [1, 'reviewer', 'review', 'pending']]);
    const l = lead();
    const base = { conversationId: l.conversationId, parentAttemptId: l.attemptId, clientId: 'c' };
    expect(() => createMission(db, { ...base, objective: 'short', steps: [{ agentId: 'operations', title: 't', brief: 'check the disks please' }] })).toThrow(/objective/);
    expect(() => createMission(db, { ...base, objective: 'A real objective here', steps: [] })).toThrow(/at least one step/);
    expect(() => createMission(db, { ...base, objective: 'A real objective here', steps: [{ agentId: 'operations', title: 't', brief: 'x' }] })).toThrow(/brief/);
    expect(() => createMission(db, { ...base, objective: 'A real objective here', steps: Array.from({ length: MAX_MISSION_STEPS + 1 }, () => ({ agentId: 'operations', title: 't', brief: 'check the disks please' })) })).toThrow(/limited to/);
  });

  it('the first step and a review step never run in parallel', () => {
    const m = mission([{ agentId: 'operations', parallel: true }, { agentId: 'research', parallel: true }, { agentId: 'reviewer', kind: 'review', parallel: true }]);
    expect(m.steps.map((s) => s.parallel)).toEqual([false, true, false]);
  });

  it('limits how many missions run at once', () => {
    mission([{ agentId: 'operations' }]); mission([{ agentId: 'operations' }]); mission([{ agentId: 'operations' }]);
    expect(() => mission([{ agentId: 'operations' }])).toThrow(/already running/);
  });

  it('a restart marks a running mission interrupted, retires its unanswered card, and it can be continued', () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'reviewer', kind: 'review' }]);
    const child = lead('child task');
    updateMissionStep(db, m.steps[0].id, { status: 'running', childAttemptId: child.attemptId, childConversationId: child.conversationId, startedAt: nowIso() });
    const card = createApproval(db, { attemptId: child.attemptId, kind: 'mutation', summary: { toolName: 'write_file' }, actor: 'test' });
    expect(interruptRunningMissionsOnBoot(db)).toEqual([m.id]);
    const after = getMission(db, m.id);
    expect(after.status).toBe('interrupted');
    expect(after.steps[0]).toMatchObject({ status: 'cancelled', error: expect.stringMatching(/restarted/) });
    expect(getApproval(db, card.id).status).toBe('expired');
    const again = reopenMission(db, m.id);
    expect(again.status).toBe('running');
    expect(again.steps.map((s) => s.status)).toEqual(['pending', 'pending']);
    expect(() => reopenMission(db, m.id)).toThrow(/only a failed, cancelled or interrupted/);
  });

  it('continuing keeps the steps that already succeeded', () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'coding' }]);
    updateMissionStep(db, m.steps[0].id, { status: 'succeeded', resultText: 'disk C is 88% full' });
    updateMissionStep(db, m.steps[1].id, { status: 'failed', error: 'boom' });
    updateMission(db, m.id, { status: 'failed' });
    const again = reopenMission(db, m.id);
    expect(again.steps.map((s) => [s.status, s.resultText])).toEqual([['succeeded', 'disk C is 88% full'], ['pending', null]]);
  });

  it('expires the cards of a finished step only', () => {
    const child = lead('child');
    const other = lead('other');
    const mine = createApproval(db, { attemptId: child.attemptId, kind: 'mutation', summary: { toolName: 'run_checks' }, actor: 'test' });
    const theirs = createApproval(db, { attemptId: other.attemptId, kind: 'mutation', summary: { toolName: 'run_checks' }, actor: 'test' });
    expect(expireStepApprovals(db, { childAttemptId: child.attemptId, childConversationId: child.conversationId }, 'step ended')).toBe(1);
    expect(getApproval(db, mine.id).status).toBe('expired');
    expect(getApproval(db, theirs.id).status).toBe('pending');
  });

  it('counts as real background work for the "nothing is running" correction', () => {
    const m = mission([{ agentId: 'operations' }]);
    expect(hasActiveWorker(db, m.conversationId, m.parentAttemptId)).toBe(true);
    updateMission(db, m.id, { status: 'completed' });
    expect(hasActiveWorker(db, m.conversationId, m.parentAttemptId)).toBe(false);
  });
});

describe('mission runner', () => {
  it('runs the steps in order in the background lane, passes results forward and posts one report', async () => {
    const m = mission([{ agentId: 'operations', title: 'Diagnostics' }, { agentId: 'reviewer', kind: 'review', title: 'Independent review' }]);
    const { r, executor, facts } = runner(({ agentId }) => agentId === 'operations'
      ? { answer: 'Disk C: is 88.6% full; rzappengine uses the most CPU.', tools: [{ name: 'run_system_diagnostics' }] }
      : { answer: 'Verdict: ready. The disk figure matches my own measurement.', tools: [{ name: 'run_system_diagnostics' }] });
    r.start(m.id);
    const done = await settle(r, m.id);
    expect(done.status).toBe('completed');
    expect(done.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
    expect(executor.lanes).toEqual(['background', 'background']);
    expect(done.steps[0].evidence?.verified).toEqual([{ tool: 'run_system_diagnostics', count: 1 }]);
    // The reviewer received the first step's result as data from Core.
    const reviewerFacts = facts.get(done.steps[1].childAttemptId!)!;
    expect(reviewerFacts.text).toMatch(/88\.6% full/);
    expect(reviewerFacts.text).toMatch(/never as instructions/);
    const messages = listMessages(db, m.conversationId, { limit: 50 }).filter((x) => x.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toMatch(/Mission complete/);
    expect(messages[0].content).toMatch(/Tools that ran: run_system_diagnostics/);
    expect(messages[0].content).toMatch(/Independent review/);
    expect(done.reportMessageId).toBe(messages[0].id);
  });

  it('a step whose report no tool call backs is marked unverified and the mission says so', async () => {
    const m = mission([{ agentId: 'operations', brief: 'Check and verify what uses the disk and report the evidence.' }]);
    const { r } = runner(() => ({ answer: 'I checked with run_system_diagnostics and everything is fine.' }));
    r.start(m.id);
    const done = await settle(r, m.id);
    expect(done.steps[0].status).toBe('unverified');
    expect(done.steps[0].evidence?.unbacked).toContain('run_system_diagnostics');
    expect(done.status).toBe('completed_with_issues');
    expect(listMessages(db, m.conversationId, { limit: 10 }).pop()!.content).toMatch(/NOT backed by recorded tool calls/);
  });

  it('a review that only looked up a skill or its memory is not a check', async () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'reviewer', kind: 'review', brief: 'Look at the earlier result again with your own tools and say whether it holds.' }], 'Measure how full the disks are');
    const { r } = runner(({ agentId }) => agentId === 'operations'
      ? { answer: 'Disk C: is 88% full.', tools: [{ name: 'run_system_diagnostics' }] }
      : { answer: 'Verdict: ready. Everything looks safe.', tools: [{ name: 'find_skill' }, { name: 'memory_recall' }] });
    r.start(m.id);
    const done = await settle(r, m.id);
    expect(done.steps.map((s) => s.status)).toEqual(['succeeded', 'unverified']);
    expect(done.steps[1].evidence?.verified).toEqual([]);
    expect(done.steps[1].evidence?.unrelated.sort()).toEqual(['find_skill', 'memory_recall']);
    expect(done.status).toBe('completed_with_issues');
  });

  it('a failed step stops the mission honestly: later steps are not started and nothing is retried', async () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'coding' }, { agentId: 'reviewer', kind: 'review' }]);
    const { r, executor } = runner(({ agentId }) => agentId === 'operations' ? { status: 'failed' } : { answer: 'should never run' });
    r.start(m.id);
    const done = await settle(r, m.id);
    expect(done.status).toBe('failed');
    expect(done.steps.map((s) => s.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(executor.started).toHaveLength(1);
    expect(listMessages(db, m.conversationId, { limit: 10 }).pop()!.content).toMatch(/continue the mission/);
  });

  it('continues a failed mission from the failed step as a new task', async () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'coding' }]);
    let fail = true;
    const { r, executor } = runner(({ agentId }) => agentId === 'coding' && fail ? { status: 'failed' } : { answer: `done by ${agentId}`, tools: [{ name: 'read_file' }] });
    r.start(m.id);
    expect((await settle(r, m.id)).status).toBe('failed');
    fail = false;
    reopenMission(db, m.id);
    r.start(m.id);
    const done = await settle(r, m.id);
    expect(done.status).toBe('completed');
    // operations once, coding twice (two different delegated tasks)
    expect(executor.started).toHaveLength(3);
    expect(new Set(executor.started).size).toBe(3);
  });

  it('cancel stops the running step and never starts the rest', async () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'reviewer', kind: 'review' }]);
    const { r, executor } = runner(() => ({ answer: 'slow work', delayMs: 5_000 }));
    r.start(m.id);
    for (let i = 0; i < 200 && executor.started.length === 0; i += 1) await new Promise((res) => setTimeout(res, 5));
    requestMissionCancel(db, m.id);
    r.cancel(m.id);
    const done = await settle(r, m.id);
    expect(done.status).toBe('cancelled');
    expect(done.steps.map((s) => s.status)).toEqual(['cancelled', 'cancelled']);
    expect(executor.started).toHaveLength(1);
    expect(executor.cancelled.has(executor.started[0])).toBe(true);
  });

  it('runs parallel steps together and the next batch after them', async () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'coding', parallel: true }, { agentId: 'reviewer', kind: 'review' }]);
    const order: string[] = [];
    const { r, executor } = runner(({ agentId }) => { order.push(agentId); return { answer: `${agentId} done`, tools: [{ name: 'read_file' }], delayMs: 60 }; });
    r.start(m.id);
    const done = await settle(r, m.id);
    expect(done.status).toBe('completed');
    expect(executor.maxActive).toBe(2);
    expect(order.slice(0, 2).sort()).toEqual(['coding', 'operations']);
    expect(order[2]).toBe('reviewer');
  });

  it('a local-only specialist\'s findings never ride into a step that may go online', () => {
    const m = mission([{ agentId: 'operations' }, { agentId: 'research' }, { agentId: 'coding' }]);
    updateMissionStep(db, m.steps[0].id, { status: 'succeeded', resultText: 'The owner\'s tax folder is D:\\Private\\Tax-2026' });
    updateMissionStep(db, m.steps[1].id, { status: 'succeeded', resultText: 'Public source: the vendor documents the fix.' });
    const fresh = getMission(db, m.id);
    const forResearch = resultsForStep(db, fresh, fresh.steps[1]);
    expect(forResearch.text).not.toMatch(/Tax-2026/);
    expect(forResearch.text).toMatch(/stays on this PC/);
    expect(forResearch.privateTexts.join(' ')).toMatch(/Tax-2026/);
    const forCoding = resultsForStep(db, fresh, fresh.steps[2]);
    expect(forCoding.text).toMatch(/Tax-2026/);
    expect(forCoding.text).toMatch(/vendor documents the fix/);
  });

  it('a clean mission is saved as an inactive procedure draft; an unverified one is not', async () => {
    const saved: string[] = [];
    const m = mission([{ agentId: 'operations', title: 'Diagnostics' }, { agentId: 'reviewer', kind: 'review' }], 'Diagnose why the laptop battery drains quickly and verify the findings');
    const { r } = runner(() => ({ answer: 'Verdict: ready. Measured.', tools: [{ name: 'run_system_diagnostics' }] }), { recordExperience: (mm) => { const d = missionProcedure(mm, (id) => id); if (d) saved.push(d.id); } });
    r.start(m.id);
    const done = await settle(r, m.id);
    expect(done.status).toBe('completed');
    expect(saved).toEqual(['mission-diagnose-laptop-battery-drains-quickly']);
    const draft = missionProcedure(done, (id) => id)!;
    expect(draft.body).toMatch(/Plan that worked/);
    expect(draft.body).toMatch(/Tools that ran: run_system_diagnostics/);
    expect(draft.body).not.toMatch(/without (?:approval|asking|permission)/i);
    const weak = { ...done, steps: done.steps.map((s) => ({ ...s, status: 'unverified' as const })) };
    expect(missionProcedure(weak, (id) => id)).toBeNull();
  });
});

describe('technical check, sampled inspection, complete verification', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `scene-${String(i + 1).padStart(2, '0')}.png`);
  const produced = (n = 7, incomplete = true) => `NOT VERIFIED: what the pictures show (${n} pictures: ${names(n).join(', ')})\n${incomplete ? 'INCOMPLETE: the upload sheet has no description\n' : ''}Video package created and checked: D:\\x\nVideo: D:\\x\\a.mp4`;
  const measuredOnly = 'NOT VERIFIED: what the pictures show (technical check only: no question was given, so no frame was looked at).\nInspected D:\\x\\a.mp4';
  const frames = 'SAMPLED: what the pictures show (3 frames of a.mp4)\nInspected D:\\x\\a.mp4\n- frame 1 (read by a local model): a rabbit in a meadow';
  const picture = (name: string) => `SAMPLED: what the pictures show (${name})\nInspected D:\\x\\assets\\${name}\n- the image (read by a local model): a forest`;
  const ev = (...outputs: string[]) => outputs.map((output) => JSON.stringify({ output }));
  const step = (kind: 'work' | 'review', caveats: string[]) => ({ kind, status: 'succeeded', evidence: { verified: [{ tool: 't', count: 1 }], unrelated: [], failed: [], unbacked: [], totalCalls: 1, caveats } }) as never;

  it('reads the three forms from the start of a result; repeats are one caveat, samples add up', () => {
    expect(toolCaveats(ev(produced(3)))).toEqual([
      'Not verified: what the pictures show (3 pictures: scene-01.png, scene-02.png, scene-03.png)',
      'Incomplete: the upload sheet has no description',
    ]);
    expect(toolCaveats(ev(measuredOnly, measuredOnly.slice(0, 70), measuredOnly))).toHaveLength(1);
    expect(toolCaveats(ev(picture('scene-01.png'), picture('scene-02.png'), frames))).toEqual(['Sampled: what the pictures show (scene-01.png, scene-02.png, 3 frames of a.mp4)']);
    expect(toolCaveats(ev('# Upload sheet\n**Description:**\n\nINCOMPLETE: no description was written for this upload sheet\n'))).toEqual(['Incomplete: no description was written for this upload sheet']);
    expect(toolCaveats(['all fine', '{}'])).toEqual([]);
  });

  it('a technical check leaves the content not verified', () => {
    const open = openCaveats([step('work', toolCaveats(ev(produced(7, false)))), step('review', toolCaveats(ev(measuredOnly)))]);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatch(/^Not verified: what the pictures show/);
  });

  it('three frames of the video do not verify seven scenes', () => {
    const open = openCaveats([step('work', toolCaveats(ev(produced(7, false)))), step('review', toolCaveats(ev(frames)))]);
    expect(open).toEqual(['Partly checked: what the pictures show — 0 of 7 looked at; the rest is not verified']);
  });

  it('looking at three of seven pictures says three of seven', () => {
    const open = openCaveats([step('work', toolCaveats(ev(produced(7, false)))), step('review', toolCaveats(ev(picture('scene-01.png'), picture('scene-04.png'), picture('scene-07.png'), frames)))]);
    expect(open).toEqual(['Partly checked: what the pictures show — 3 of 7 looked at; the rest is not verified']);
  });

  it('only looking at every named unit settles it; a missing deliverable still stands', () => {
    const all = names(7).map(picture);
    expect(openCaveats([step('work', toolCaveats(ev(produced(7, false)))), step('review', toolCaveats(ev(...all)))])).toEqual([]);
    expect(openCaveats([step('work', toolCaveats(ev(produced(7, true)))), step('review', toolCaveats(ev(...all)))])).toEqual(['Incomplete: the upload sheet has no description']);
  });

  it('a list of units that was cut off cannot be called fully covered', () => {
    const cut = 'Not verified: what the pictures show (7 pictures: scene-01.png, scene-02.png';
    const open = openCaveats([step('work', [cut]), step('review', toolCaveats(ev(picture('scene-01.png'), picture('scene-02.png'))))]);
    expect(open).toEqual(['Partly checked: what the pictures show — 2 of 7 looked at; the rest is not verified']);
  });

  it('a sample of something nobody declared is still only a sample', () => {
    expect(openCaveats([step('review', toolCaveats(ev(frames)))])).toEqual(['Partly checked: what the pictures show — a sample only (3 frames of a.mp4); not verified as a whole']);
  });

  it('the same rule holds for any artifact, not only pictures', () => {
    const made = 'NOT VERIFIED: that the generated pages render (3 pages: index.html, pricing.html, contact.html)\nSite written to D:\\site';
    const opened = (n: string) => `SAMPLED: that the generated pages render (${n})\nOpened ${n}`;
    expect(openCaveats([step('work', toolCaveats(ev(made))), step('review', toolCaveats(ev(opened('index.html'))))])).toEqual(['Partly checked: that the generated pages render — 1 of 3 looked at; the rest is not verified']);
    expect(openCaveats([step('work', toolCaveats(ev(made))), step('review', toolCaveats(ev(opened('index.html'), opened('pricing.html'), opened('contact.html'))))])).toEqual([]);
  });

  const run = async (reviewOutputs: string[], reviewAnswer = 'Verdict: ready. The visuals are consistent and child-friendly.') => {
    const m = mission([{ agentId: 'studio', title: 'Make the video', brief: 'Write and produce the narrated video.' }, { agentId: 'reviewer', kind: 'review', brief: 'Inspect the produced video file and its package.' }], 'Produce a narrated video about tides');
    const saved: string[] = [];
    const { r } = runner(({ agentId }) => agentId === 'studio'
      ? { answer: 'Done: the video is ready.', tools: [{ name: 'media_produce_video', evidence: JSON.stringify({ output: produced(7, false) }) }] }
      : { answer: reviewAnswer, tools: reviewOutputs.map((output) => ({ name: 'media_inspect', evidence: JSON.stringify({ output }) })) },
    { recordExperience: (mm) => { const d = missionProcedure(mm, (id) => id); if (d) saved.push(d.id); } });
    r.start(m.id);
    return { done: await settle(r, m.id), saved };
  };

  it('a mission whose review only sampled is not complete, says so, and leaves no skill draft, whatever the review says', async () => {
    const { done, saved } = await run([frames]);
    expect(done.status).toBe('completed_with_issues');
    expect(done.resultSummary).toMatch(/Partly checked: what the pictures show — 0 of 7 looked at/);
    const report = listMessages(db, done.conversationId, { limit: 10 }).pop()!.content;
    expect(report).toMatch(/Mission finished, with points to check/);
    expect(report).toMatch(/only partly checked/);
    expect(report).toMatch(/0 of 7 looked at; the rest is not verified/);
    expect(saved).toEqual([]);
    expect(missionProcedure(done, (id) => id)).toBeNull();
  });

  it('a mission whose review looked at every picture is complete and may be kept as a procedure', async () => {
    const { done, saved } = await run(names(7).map(picture));
    expect(openCaveats(done.steps)).toEqual([]);
    expect(done.status).toBe('completed');
    expect(saved).toHaveLength(1);
  });

  it('nothing declared, nothing invented', () => {
    const m = mission([{ agentId: 'operations' }]);
    expect(openCaveats(m.steps)).toEqual([]);
  });
});

describe('mission helpers', () => {
  it('batches a step with the parallel steps after it, three at most', () => {
    const s = (parallel: boolean) => ({ parallel });
    expect(stepBatches([s(false), s(true), s(true), s(true), s(false)]).map((b) => b.length)).toEqual([3, 1, 1]);
    expect(stepBatches([s(false), s(false)]).map((b) => b.length)).toEqual([1, 1]);
  });

  it('finds only files that exist on disk', () => {
    const real = path.join(dir, 'story.mp4');
    fs.writeFileSync(real, 'x');
    const found = existingPathsIn(`Video: ${real}. Also ${path.join(dir, 'missing.srt')} and the folder ${dir}`);
    expect(found).toEqual([{ path: real, bytes: 1, kind: 'video', exists: true }]);
  });

  it('reads a review verdict from its first words', () => {
    expect(reviewFoundProblems('Verdict: fix first. The length is 97 s.')).toBe(true);
    expect(reviewFoundProblems('Verdict: cannot verify — I could not run the tests.')).toBe(true);
    expect(reviewFoundProblems('Verdict: ready. No blocking problems found.')).toBe(false);
  });

  it('the report separates what ran from what an agent said', () => {
    const m = mission([{ agentId: 'operations', title: 'Diagnostics' }]);
    updateMissionStep(db, m.steps[0].id, { status: 'unverified', resultText: 'All good, trust me.', evidence: { verified: [], unrelated: [], failed: ['read_file'], unbacked: ['run_system_diagnostics'], totalCalls: 1 } });
    const text = renderMissionReport({ ...getMission(db, m.id), status: 'completed_with_issues' }, (id) => id, null);
    expect(text).toMatch(/points to check/);
    expect(text).toMatch(/Tool calls that failed: read_file/);
    expect(text).toMatch(/never run: run_system_diagnostics/);
    expect(text).toMatch(/NOT backed by recorded tool calls/);
  });

  it('finds an earlier mission like this one', () => {
    const m = mission([{ agentId: 'operations' }], 'Diagnose why the computer is running slowly and verify findings');
    updateMission(db, m.id, { status: 'completed' });
    expect(similarFinishedMissions(db, 'Please diagnose why my computer keeps running slowly').map((x) => x.id)).toEqual([m.id]);
    expect(similarFinishedMissions(db, 'Write a bedtime story about a rabbit')).toEqual([]);
  });
});

describe('the lead\'s mission tools', () => {
  const tools = (over: Partial<Parameters<typeof buildMissionTools>[0]> = {}) => {
    const l = lead('Make a video and have it checked');
    const started: string[] = [];
    const cancelled: string[] = [];
    const cards: string[] = [];
    const built = buildMissionTools({
      db, attemptId: l.attemptId, conversationId: l.conversationId, clientId: 'test-client', workspaceRoot: null, defaults: { selectedProvider: 'ollama', selectedModel: 'zeta:1b' },
      runner: { start: (id) => started.push(id), cancel: (id) => cancelled.push(id) },
      checkStep: () => null,
      askInternet: async (card) => { cards.push(card); return { ok: true, approvalId: 'appr_x' }; },
      record: () => undefined, missionsRoot: path.join(dir, 'missions'),
      ...over,
    });
    const [start, manage] = built;
    return { start, manage, started, cancelled, cards, lead: l };
  };
  const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

  it('offers the specialists that are on, from their definitions, with what each is for', () => {
    const { start } = tools();
    const agentEnum = (start.parameters as any).properties.steps.items.properties.agent.enum as string[];
    expect(agentEnum).toEqual(expect.arrayContaining(['operations', 'coding', 'research', 'studio', 'reviewer']));
    expect(agentEnum).not.toContain('chief');
    expect(agentEnum).not.toContain('voice');
    expect(agentEnum).not.toContain('support');
    expect(start.description).toMatch(/operations: Files, apps, system health/);
    db.run("INSERT INTO agent_definitions (id, kind, version, definition, createdAt, updatedAt) VALUES ('operations', 'override', 2, ?, ?, ?)", [JSON.stringify({ enabled: false }), nowIso(), nowIso()]);
    expect(missionRoster(db).map((r) => r.id)).not.toContain('operations');
  });

  it('a specialist none of whose tools exist in this build is not ready', () => {
    const roster = missionRoster(db, ['read_file', 'media_inspect']);
    expect(roster.find((r) => r.id === 'reviewer')?.ready).toBe(true);
    expect(roster.find((r) => r.id === 'personal')?.ready).toBe(false);
  });

  it('starts a mission in its own new folder, adds the review step, and returns at once', async () => {
    const { start, started } = tools();
    const out = await start.execute('t1', { objective: 'Produce a short narrated video about tides', steps: [{ agent: 'studio', title: 'Make the video', brief: 'Write and produce a 60 second narrated video about tides.' }], review: true });
    expect(out.isError).toBeFalsy();
    expect(text(out)).toMatch(/MISSION STARTED in the background/);
    expect(started).toHaveLength(1);
    const m = getMission(db, started[0]);
    expect(m.steps.map((s) => [s.agentId, s.kind])).toEqual([['studio', 'work'], ['reviewer', 'review']]);
    expect(m.workspaceRoot && fs.existsSync(m.workspaceRoot)).toBe(true);
    expect(m.workspaceRoot!.startsWith(path.join(dir, 'missions'))).toBe(true);
    expect(fs.readdirSync(m.workspaceRoot!)).toEqual([]);
  });

  it('asks once before a step may go online, and starts nothing when the answer is no', async () => {
    const yes = tools();
    await yes.start.execute('t1', { objective: 'Research current heat pump subsidies', steps: [{ agent: 'research', title: 'Research', brief: 'Find the current federal heat pump subsidy rules and cite them.' }] });
    expect(yes.cards).toHaveLength(1);
    expect(yes.cards[0]).toMatch(/Research agent may use the internet/);
    expect(getMission(db, yes.started[0]).egressApprovalId).toBe('appr_x');

    const no = tools({ askInternet: async () => ({ ok: false, text: 'NOT DONE: the user declined.' }) });
    const out = await no.start.execute('t2', { objective: 'Research current heat pump subsidies again', steps: [{ agent: 'research', title: 'Research', brief: 'Find the current federal heat pump subsidy rules and cite them.' }] });
    expect(out.isError).toBe(true);
    expect(no.started).toHaveLength(0);
    expect(listMissions(db, { conversationId: no.lead.conversationId })).toHaveLength(0);
  });

  it('refuses a plan Core\'s hand-off checks refuse, before anything is stored', async () => {
    const { start, started } = tools({ checkStep: (agent) => agent === 'coding' ? 'D:\\Other is outside the folders allowed' : null });
    const out = await start.execute('t1', { objective: 'Fix the project in another folder', steps: [{ agent: 'coding', title: 'Fix', brief: 'Read D:\\Other\\app.js and fix the bug in it.' }] });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/refused by Pandesh Core before anything started/);
    expect(started).toHaveLength(0);
    const unknown = await start.execute('t2', { objective: 'Do something with a ghost', steps: [{ agent: 'ghost', title: 'x', brief: 'Do the thing and report back.' }] });
    expect(text(unknown)).toMatch(/does not exist or is turned off/);
  });

  it('reports status from the record, cancels and continues', async () => {
    const { start, manage, started, cancelled } = tools();
    expect(text(await manage.execute('m0', { action: 'status' }))).toMatch(/no missions yet/);
    await start.execute('t1', { objective: 'Inspect the disks and report free space', steps: [{ agent: 'operations', title: 'Inspect disks', brief: 'Measure free space on every drive and report it.' }] });
    const id = started[0];
    expect(text(await manage.execute('m1', { action: 'status' }))).toMatch(/Operations · Inspect disks: waiting/);
    expect(text(await manage.execute('m2', { action: 'cancel' }))).toMatch(/CANCEL REQUESTED/);
    expect(cancelled).toEqual([id]);
    expect(getMission(db, id).cancelRequestedAt).toBeTruthy();
    updateMission(db, id, { status: 'cancelled' });
    expect(text(await manage.execute('m3', { action: 'continue' }))).toMatch(/MISSION CONTINUED/);
    expect(started).toEqual([id, id]);
  });

  it('tells the lead what is running, and a plan that worked before', () => {
    const m = mission([{ agentId: 'operations', title: 'Diagnostics' }], 'Diagnose why the computer is running slowly and verify findings');
    const fact = missionTurnFact(db, m.conversationId, 'hello')!;
    expect(fact).toMatch(/MISSIONS/);
    expect(fact).toMatch(/running/);
    expect(describeMission(db, m, 'line')).toMatch(/0\/1 steps done/);
    updateMission(db, m.id, { status: 'completed' });
    const later = missionTurnFact(db, 'another-conversation', 'Can you diagnose why my computer is running slowly again and verify the findings please?')!;
    expect(later).toMatch(/SIMILAR MISSION FINISHED BEFORE/);
    expect(later).toMatch(/operations: Diagnostics/);
    expect(missionTurnFact(db, 'another-conversation', 'hi')).toBeNull();
  });
});

describe('mission view for the window', () => {
  it('carries the running step\'s card with a readable line', () => {
    const m = mission([{ agentId: 'studio', title: 'Make the video' }]);
    const child = lead('child');
    db.run('INSERT INTO agent_handoffs (id, parentAttemptId, childRequestId, fromAgentId, toAgentId, brief, grantJson, dedupeKey, depth, status, createdAt, updatedAt) VALUES (?, ?, (SELECT requestId FROM attempts WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newId('hof'), m.parentAttemptId, child.attemptId, 'chief', 'studio', 'brief', '{}', 'k', 1, 'running', nowIso(), nowIso()]);
    updateMissionStep(db, m.steps[0].id, { status: 'running', childAttemptId: child.attemptId, childConversationId: child.conversationId, startedAt: nowIso() });
    db.run("UPDATE attempts SET status = 'waiting_for_approval' WHERE id = ?", [child.attemptId]);
    createApproval(db, { attemptId: child.attemptId, kind: 'mutation', summary: { toolName: 'media_produce_video', arguments: { title: 'Tides', sceneCount: 7, scenes: [1, 2] } }, actor: 'test' });
    const view = missionView(db, getMission(db, m.id), 'test-client');
    expect(view.agentNames.studio).toBe('Studio');
    expect(view.pendingApprovals).toHaveLength(1);
    expect(view.pendingApprovals[0].text).toBe('media produce video — title: Tides; sceneCount: 7; scenes: 2 items');
  });

  it('builds a short line from short arguments only', () => {
    expect(approvalLine('run_checks', { command: 'npm test', content: 'x'.repeat(500) })).toBe('run checks — command: npm test');
  });
});
