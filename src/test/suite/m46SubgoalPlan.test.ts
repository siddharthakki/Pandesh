import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  activeSubgoal,
  advancePlan,
  classifyTaskType,
  isReadOnlyObjective,
  planComplete,
  planDrift,
  shapeSubgoals,
  type SubgoalPlan,
} from '../../autonomy/SubgoalPlan';
import { deriveExecutionEconomy } from '../../autonomy/ExecutionEconomyProfile';
import type { RepoCandidate } from '../../autonomy/ContextCompiler';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';

const small = deriveExecutionEconomy({ contextWindow: { contextTokens: 8_192, source: 'router_metadata' } });
const standard = deriveExecutionEconomy({ contextWindow: { contextTokens: 32_768, source: 'router_metadata' } });
const large = deriveExecutionEconomy({ contextWindow: { contextTokens: 262_144, source: 'router_metadata' } });

const candidate = (path: string, score: number, reasons: string[] = ['x']): RepoCandidate => ({ path, score, reasons });
const REPAIR = 'Fix calculate_total so that total.test.ts passes.';
const files = [
  candidate('src/total.ts', 90),
  candidate('src/total.test.ts', 85),
  candidate('src/cart.ts', 60),
  candidate('src/index.ts', 50),
  candidate('src/format.ts', 40),
  candidate('src/util.ts', 30),
];

describe('M46 subgoal shaping', () => {
  it('classifies task types and read-only intent deterministically', () => {
    expect(classifyTaskType('Fix the failing checkout test')).toBe('repair');
    expect(classifyTaskType('Explain this repository architecture')).toBe('inspect');
    expect(classifyTaskType('Determine why calculate_total fails. Do not edit yet.')).toBe('diagnose');
    expect(classifyTaskType('Add pagination to the orders endpoint')).toBe('implement');
    expect(classifyTaskType('hello')).toBe('general');
    expect(isReadOnlyObjective('Diagnose it without editing anything')).toBe(true);
    expect(isReadOnlyObjective('Fix it')).toBe(false);
  });

  it('gives a small model bounded subgoals instead of the whole objective at once', () => {
    const plan = shapeSubgoals({ objective: REPAIR, profile: small, candidates: files, validationCommand: 'npm test -- total' });
    expect(plan.fragmented).toBe(true);
    expect(plan.subgoals.map(goal => goal.kind)).toEqual(['understand', 'change', 'verify']);
    for (const goal of plan.subgoals) expect(goal.files.length).toBeLessThanOrEqual(small.subgoal.maxFiles);
    const [understand, change, verify] = plan.subgoals;
    expect(understand.objective).toMatch(/Read .*Do not edit yet/);
    expect(understand.capability).toBe('read_only');
    expect(change.capability).toBe('propose_change');
    expect(change.expectedValidation).toBe('npm test -- total');
    expect(verify.deterministic).toBe(true);
    expect(plan.subgoals.filter(goal => goal.status === 'active')).toHaveLength(1);
    expect(plan.subgoals[0].status).toBe('active');
  });

  it('does not fragment a strong model: one subgoal that is the objective itself', () => {
    const plan = shapeSubgoals({ objective: REPAIR, profile: large, candidates: files });
    expect(plan.fragmented).toBe(false);
    expect(plan.subgoals).toHaveLength(1);
    expect(plan.subgoals[0].objective).toBe(REPAIR);
    const standardPlan = shapeSubgoals({ objective: REPAIR, profile: standard, candidates: files });
    expect(standardPlan.fragmented).toBe(false);
  });

  it('shapes a diagnosis into read-then-explain and never grants an edit capability', () => {
    const plan = shapeSubgoals({ objective: 'Determine why calculate_total() fails these two tests. Do not edit yet.', profile: small, candidates: files });
    expect(plan.readOnly).toBe(true);
    expect(plan.subgoals.map(goal => goal.kind)).toEqual(['understand', 'diagnose']);
    expect(plan.subgoals.every(goal => goal.capability === 'read_only')).toBe(true);
    expect(plan.subgoals[0].files).toContain('src/total.test.ts');
  });

  it('breaks an architecture survey into bounded reads followed by the original question', () => {
    const many = [
      candidate('package.json', 90, ['project manifest']),
      candidate('src/index.ts', 80, ['entrypoint']),
      candidate('README.md', 70, ['project documentation']),
      ...Array.from({ length: 8 }, (_, i) => candidate(`src/mod${i}.ts`, 50 - i)),
    ];
    const objective = 'Explain this repository architecture. Do not modify anything.';
    const plan = shapeSubgoals({ objective, profile: small, candidates: many });
    expect(plan.subgoals.length).toBeGreaterThan(2);
    expect(plan.subgoals.length).toBeLessThanOrEqual(6);
    expect(plan.subgoals[0].files).toEqual(expect.arrayContaining(['package.json', 'src/index.ts']));
    for (const goal of plan.subgoals) expect(goal.files.length).toBeLessThanOrEqual(small.subgoal.maxFiles);
    const last = plan.subgoals[plan.subgoals.length - 1];
    expect(last.kind).toBe('answer');
    expect(last.objective).toContain(objective.slice(0, 40));
  });

  it('does not drift from the objective, and detects when it has', () => {
    const plan = shapeSubgoals({ objective: REPAIR, profile: small, candidates: files });
    expect(planDrift(plan, REPAIR)).toEqual([]);
    expect(planDrift(plan, 'Fix something entirely different')).toEqual(expect.arrayContaining([expect.stringMatching(/objective changed/)]));
    const tampered: SubgoalPlan = { ...plan, subgoals: plan.subgoals.map(goal => goal.kind === 'change' ? { ...goal, objective: 'Refactor everything' } : goal) };
    expect(planDrift(tampered, REPAIR).join(' ')).toMatch(/does not carry the original objective/);
    const readOnlyPlan = shapeSubgoals({ objective: 'Why does it fail? Do not edit.', profile: small, candidates: files });
    const escalated: SubgoalPlan = { ...readOnlyPlan, subgoals: readOnlyPlan.subgoals.map((goal, i) => i === 0 ? { ...goal, capability: 'propose_change' as const } : goal) };
    expect(planDrift(escalated, 'Why does it fail? Do not edit.').join(' ')).toMatch(/read-only/);
  });

  it('advances deterministically from facts: reads satisfy understanding without a model turn', () => {
    const plan = shapeSubgoals({ objective: REPAIR, profile: small, candidates: files, validationCommand: 'npm test' });
    const read = new Set(plan.subgoals[0].files);
    const afterRead = advancePlan(plan, { filesRead: read, mutationApplied: false });
    expect(activeSubgoal(afterRead)?.kind).toBe('change');
    expect(afterRead.subgoals[0].status).toBe('done');
    const afterMutation = advancePlan(afterRead, { filesRead: read, mutationApplied: true });
    expect(activeSubgoal(afterMutation)?.kind).toBe('verify');
    const done = advancePlan(afterMutation, { filesRead: read, mutationApplied: true, validationPassed: true });
    expect(planComplete(done)).toBe(true);
    expect(activeSubgoal(done)).toBeUndefined();
    // Later subgoals are never marked done ahead of an unmet earlier one.
    const skipped = advancePlan(plan, { filesRead: new Set(), mutationApplied: true, validationPassed: true });
    expect(skipped.subgoals.map(goal => goal.status)).toEqual(['active', 'pending', 'pending']);
  });

  it('is a pure function of its input', () => {
    const a = shapeSubgoals({ objective: REPAIR, profile: small, candidates: files });
    const b = shapeSubgoals({ objective: REPAIR, profile: small, candidates: [...files].reverse() });
    expect(b).toEqual(a);
  });

  it('handles a workspace with nothing indexed: a valid single-step plan with no files', () => {
    const plan = shapeSubgoals({ objective: 'Add a README', profile: small, candidates: [] });
    expect(planDrift(plan, 'Add a README')).toEqual([]);
    expect(plan.subgoals.length).toBeGreaterThan(0);
  });
});

describe('M46 subgoal persistence', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-subgoal-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('survives a restart: the reopened journal returns the same plan with its progress and success conditions', async () => {
    const plan = shapeSubgoals({ objective: REPAIR, profile: small, candidates: files, validationCommand: 'npm test' });
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_sg' });
    await journal.append({ t: 'subgoal_plan', plan });
    const advanced = advancePlan(plan, { filesRead: new Set(plan.subgoals[0].files), mutationApplied: false });
    await journal.append({ t: 'subgoal_plan', plan: advanced });

    const reopened = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_sg' });
    expect(reopened.state.subgoalPlan).toEqual(advanced);
    const restored = reopened.state.subgoalPlan!;
    expect(activeSubgoal(restored)?.kind).toBe('change');
    expect(activeSubgoal(restored)?.successCondition).toBe('The change is proposed and the approved validation passes.');
    expect(planDrift(restored, REPAIR)).toEqual([]);
  });

  it('a superseded objective clears the plan so the next pass reshapes it', async () => {
    const plan = shapeSubgoals({ objective: REPAIR, profile: small, candidates: files });
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_sg2' });
    await journal.append({ t: 'subgoal_plan', plan });
    await journal.append({ t: 'superseded', reason: 'instruction_revision_changed', instructionRevision: 2 });
    expect(journal.state.subgoalPlan).toBeUndefined();
    const reopened = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_sg2' });
    expect(reopened.state.subgoalPlan).toBeUndefined();
  });
});
