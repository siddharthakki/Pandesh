import { digest } from './FailureFingerprint';
import type { PackTaskType, RepoCandidate } from './ContextCompiler';
import type { EconomyTier, ExecutionEconomyProfile } from './ExecutionEconomyProfile';

/**
 * M46 task shaping: turns a mission objective into a few bounded subgoals.
 *
 * "Fix this whole application" is not a problem a small model can hold. "Read these
 * three files. Do not edit yet. Say why calculate_total fails." is. The plan below is
 * deterministic (no model call), owned by the MissionSupervisor's task, persisted in
 * the AttemptJournal so a restart resumes the same plan, and never rewrites the
 * objective: the last subgoal always carries the original objective verbatim.
 *
 * A strong model is not fragmented: with `subgoal.fragment === false` the plan is a
 * single subgoal that is the objective itself.
 */

export const SUBGOAL_PLAN_VERSION = 1 as const;
const MAX_SUBGOALS = 6;
const MAX_TEXT = 600;

export type SubgoalKind = 'understand' | 'inspect' | 'diagnose' | 'change' | 'verify' | 'answer';
export type SubgoalStatus = 'pending' | 'active' | 'done';
export type SubgoalCapability = 'read_only' | 'propose_change';

export interface Subgoal {
  id: string;
  index: number;
  kind: SubgoalKind;
  objective: string;
  successCondition: string;
  expectedValidation?: string;
  /** Files the subgoal is about; the Context Pack requests these first. */
  files: string[];
  capability: SubgoalCapability;
  /** Upper bound on what one dispatch of this subgoal may touch. */
  maxScope: string;
  /** True when the runtime can carry the step out or check it without asking a model. */
  deterministic: boolean;
  status: SubgoalStatus;
}

export interface SubgoalPlan {
  v: typeof SUBGOAL_PLAN_VERSION;
  planId: string;
  /** The objective exactly as received. The plan is invalid if this no longer matches the task. */
  objective: string;
  objectiveHash: string;
  taskType: PackTaskType;
  readOnly: boolean;
  tier: EconomyTier;
  fragmented: boolean;
  subgoals: Subgoal[];
}

// ── classification ──────────────────────────────────────────────────────────

const READ_ONLY_PHRASE = /\b(?:do not|don't|dont|without|never)\s+(?:edit|modify|change|write|touch|alter)|\bread[- ]only\b|\bno (?:edits|changes|modifications)\b/i;
const INSPECT_WORDS = /\b(?:explain|describe|summari[sz]e|overview|architecture|walk ?through|inspect|what does|how does|understand)\b/i;
const DIAGNOSE_WORDS = /\b(?:why|diagnose|investigate|root cause|figure out|find out|what(?:'s| is) (?:wrong|failing|causing))\b/i;
const REPAIR_WORDS = /\b(?:fix|repair|bug|broken|regression|failing|fails|crash(?:es)?)\b/i;
const IMPLEMENT_WORDS = /\b(?:implement|add|create|build|refactor|migrate|change|update|rename|remove|write|support)\b/i;

export function isReadOnlyObjective(objective: string): boolean {
  return READ_ONLY_PHRASE.test(objective);
}

export function classifyTaskType(objective: string): PackTaskType {
  const readOnly = isReadOnlyObjective(objective);
  if (readOnly) return DIAGNOSE_WORDS.test(objective) || REPAIR_WORDS.test(objective) ? 'diagnose' : 'inspect';
  if (REPAIR_WORDS.test(objective) && !INSPECT_WORDS.test(objective)) return 'repair';
  if (DIAGNOSE_WORDS.test(objective) && !IMPLEMENT_WORDS.test(objective)) return 'diagnose';
  if (INSPECT_WORDS.test(objective) && !IMPLEMENT_WORDS.test(objective) && !REPAIR_WORDS.test(objective)) return 'inspect';
  if (REPAIR_WORDS.test(objective)) return 'repair';
  if (IMPLEMENT_WORDS.test(objective)) return 'implement';
  return 'general';
}

// ── shaping ─────────────────────────────────────────────────────────────────

export interface ShapeInput {
  objective: string;
  profile: ExecutionEconomyProfile;
  candidates?: readonly RepoCandidate[];
  taskType?: PackTaskType;
  /** The approved validation command, when the task has one. */
  validationCommand?: string;
}

function flat(text: string, max = MAX_TEXT): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function listFiles(files: readonly string[]): string {
  return files.length > 0 ? files.join(', ') : 'the relevant files';
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

export function shapeSubgoals(input: ShapeInput): SubgoalPlan {
  const objective = input.objective;
  const readOnly = isReadOnlyObjective(objective);
  const taskType = input.taskType ?? classifyTaskType(objective);
  const { profile } = input;
  const perGoal = Math.max(1, profile.subgoal.maxFiles);
  const ranked = [...(input.candidates ?? [])].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  const tests = ranked.filter(candidate => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./i.test(candidate.path)).map(candidate => candidate.path);
  const source = ranked.filter(candidate => !tests.includes(candidate.path)).map(candidate => candidate.path);
  const fragment = profile.subgoal.fragment && taskType !== 'general';
  const planId = digest(`${objective}|${profile.tier}|${fragment}`).slice(0, 12);
  const goals: Array<Omit<Subgoal, 'id' | 'index' | 'status'>> = [];
  const text = flat(objective);

  if (!fragment) {
    const files = ranked.slice(0, perGoal).map(candidate => candidate.path);
    goals.push({
      kind: taskType === 'inspect' ? 'answer' : taskType === 'diagnose' ? 'diagnose' : 'change',
      objective: text,
      successCondition: readOnly ? 'The question is answered from the code, without changing any file.' : 'The requested change is made and validation passes.',
      expectedValidation: readOnly ? undefined : input.validationCommand,
      files,
      capability: readOnly ? 'read_only' : 'propose_change',
      maxScope: `${perGoal} file(s) at a time`,
      deterministic: false,
    });
  } else if (taskType === 'inspect') {
    const structural = ranked.filter(candidate => candidate.reasons.some(reason => /manifest|entrypoint|documentation/.test(reason))).map(candidate => candidate.path).slice(0, perGoal);
    const rest = source.filter(path => !structural.includes(path)).slice(0, perGoal * 2);
    if (structural.length > 0) {
      goals.push({ kind: 'inspect', objective: `Read ${listFiles(structural)}. Do not modify anything. Note what the project is and how it starts.`, successCondition: 'Purpose and entry points are noted.', files: structural, capability: 'read_only', maxScope: `${perGoal} file(s)`, deterministic: true });
    }
    for (const group of chunk(rest, perGoal)) {
      goals.push({ kind: 'inspect', objective: `Read ${listFiles(group)}. Do not modify anything. Note each file's responsibility.`, successCondition: 'Each listed file has a one-line responsibility.', files: group, capability: 'read_only', maxScope: `${perGoal} file(s)`, deterministic: true });
    }
    goals.push({ kind: 'answer', objective: `Complete the original request using only what was read: ${text}`, successCondition: 'The request is answered and every claim is grounded in a file that was read.', files: [], capability: 'read_only', maxScope: 'one answer', deterministic: false });
  } else if (taskType === 'diagnose' || (readOnly && taskType !== 'implement')) {
    const files = [...tests.slice(0, 2), ...source].slice(0, perGoal);
    goals.push({ kind: 'understand', objective: `Read ${listFiles(files)}. Do not edit any file.`, successCondition: 'Every listed file was read.', files, capability: 'read_only', maxScope: `${perGoal} file(s)`, deterministic: true });
    goals.push({ kind: 'diagnose', objective: `Complete the original request without editing anything: ${text}`, successCondition: 'The cause is stated with the file and the function or line responsible.', files, capability: 'read_only', maxScope: 'one explanation', deterministic: false });
  } else {
    // repair / implement
    const understand = [...source.slice(0, Math.max(1, perGoal - Math.min(tests.length, 1))), ...tests.slice(0, 1)].slice(0, perGoal);
    const targets = source.slice(0, Math.min(2, perGoal));
    goals.push({ kind: 'understand', objective: `Read ${listFiles(understand)}. Do not edit yet.`, successCondition: 'Every listed file was read.', files: understand, capability: 'read_only', maxScope: `${perGoal} file(s)`, deterministic: true });
    goals.push({
      kind: 'change',
      objective: `Complete the original request with the smallest change that satisfies it${targets.length ? `, changing only ${listFiles(targets)} unless the evidence shows otherwise` : ''}: ${text}`,
      successCondition: 'The change is proposed and the approved validation passes.',
      expectedValidation: input.validationCommand,
      files: targets.length > 0 ? targets : understand,
      capability: 'propose_change',
      maxScope: `${Math.max(1, targets.length)} file(s)`,
      deterministic: false,
    });
    goals.push({ kind: 'verify', objective: `Run ${input.validationCommand ?? 'the approved validation'} and report the result.`, successCondition: 'Validation passes.', expectedValidation: input.validationCommand, files: [], capability: 'read_only', maxScope: 'the approved validation only', deterministic: true });
  }

  // The plan must never lose the objective: the last model-facing subgoal carries it verbatim.
  const bounded = goals.slice(0, MAX_SUBGOALS);
  return {
    v: SUBGOAL_PLAN_VERSION,
    planId,
    objective,
    objectiveHash: digest(objective),
    taskType,
    readOnly,
    tier: profile.tier,
    fragmented: fragment,
    subgoals: bounded.map((goal, index) => ({
      ...goal,
      id: `${planId}.${index + 1}`,
      index,
      status: index === 0 ? 'active' : 'pending',
    })),
  };
}

// ── drift check ─────────────────────────────────────────────────────────────

/** Reasons a plan no longer describes the task; empty means it is safe to continue with. */
export function planDrift(plan: SubgoalPlan, currentObjective: string): string[] {
  const problems: string[] = [];
  if (plan.v !== SUBGOAL_PLAN_VERSION) problems.push('plan version is not supported');
  if (plan.objectiveHash !== digest(currentObjective) || plan.objective !== currentObjective) problems.push('the task objective changed after the plan was made');
  const modelFacing = plan.subgoals.filter(goal => !goal.deterministic);
  const last = modelFacing[modelFacing.length - 1];
  if (!last) problems.push('the plan has no model-facing subgoal');
  else if (!flat(last.objective, 4000).includes(flat(currentObjective).slice(0, 200))) problems.push('the final subgoal does not carry the original objective');
  if (plan.readOnly) {
    const writer = plan.subgoals.find(goal => goal.capability !== 'read_only');
    if (writer) problems.push(`subgoal ${writer.id} would edit files in a read-only task`);
  }
  if (plan.subgoals.filter(goal => goal.status === 'active').length > 1) problems.push('more than one subgoal is active');
  return problems;
}

// ── progress ────────────────────────────────────────────────────────────────

export interface SubgoalFacts {
  /** Repository-relative paths delivered to the model or read by the runtime. */
  filesRead: ReadonlySet<string>;
  /** A mutation has been applied to the worktree. */
  mutationApplied: boolean;
  /** The latest validation run passed. */
  validationPassed?: boolean;
  /** The model-facing answer subgoals the caller has recorded as finished. */
  answered?: boolean;
}

function satisfied(goal: Subgoal, facts: SubgoalFacts): boolean {
  switch (goal.kind) {
    case 'understand':
    case 'inspect':
      return goal.files.length > 0 && goal.files.every(file => facts.filesRead.has(file));
    case 'change':
      return facts.mutationApplied;
    case 'verify':
      return facts.validationPassed === true;
    case 'diagnose':
    case 'answer':
      return facts.answered === true;
  }
}

/** Marks satisfied subgoals done, in order, and activates the first one that is not. Pure. */
export function advancePlan(plan: SubgoalPlan, facts: SubgoalFacts): SubgoalPlan {
  let blocked = false;
  const subgoals = plan.subgoals.map(goal => {
    if (blocked) return { ...goal, status: 'pending' as const };
    if (satisfied(goal, facts)) return { ...goal, status: 'done' as const };
    blocked = true;
    return { ...goal, status: 'active' as const };
  });
  return { ...plan, subgoals };
}

export function activeSubgoal(plan: SubgoalPlan): Subgoal | undefined {
  return plan.subgoals.find(goal => goal.status === 'active');
}

export function planComplete(plan: SubgoalPlan): boolean {
  return plan.subgoals.every(goal => goal.status === 'done');
}
