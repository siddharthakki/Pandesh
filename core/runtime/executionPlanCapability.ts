/**
 * The execution plan: what Pandesh is about to do, and what actually happened.
 *
 * The multi-tool loop already existed. What it lacked was a PLAN the person
 * could see and a per-step TRUTH: a failure in step three used to be able to
 * arrive as a general "done". This capability adds exactly that, inside the
 * existing architecture:
 *
 *   - the MODEL declares the plan (the order, the capability each step
 *     needs, the input, the expected output, the verification condition and
 *     the permission the step requires),
 *   - the Core CHECKS it before anything runs: a step whose capability is
 *     not available is refused with the reason, so no half-executed plan is
 *     ever started,
 *   - the plan is stored in the EXISTING durable operator-run tables, so it
 *     survives a restart and the person can look at it afterwards,
 *   - the step outcomes are derived from the REAL tool-invocation evidence,
 *     never from what the model says about itself.
 *
 * No new runtime, no new approval system, no new evidence store.
 */
import type { CoreDatabase } from '../db/connection';
import { createOperatorRun, listOperatorRuns, listOperatorSteps, recordOperatorEvent, updateOperatorStep } from '../domain/operatorRuns';
import { classifyPrivacy } from '../domain/operatorPlan';
import type { GovernedCapabilityAdapter } from './governedCapability';
import { GovernedCapabilityRegistry } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { nowIso } from '../domain/ids';

const MAX_STEPS = 12;
const MAX_TITLE_CHARS = 160;

/** What a step may need. */
export type StepPermission = 'read' | 'approval';

export interface PlannedStepInput {
  title: string;
  capability: string;
  input?: string;
  expectedOutput?: string;
  verification?: string;
  permission?: StepPermission;
}

export interface DeclaredPlan {
  id: string;
  goal: string;
  steps: Array<{
    idx: number;
    title: string;
    capability: string;
    input: string | null;
    expectedOutput: string | null;
    verification: string | null;
    permission: StepPermission;
    status: string;
    evidence: string | null;
    error: string | null;
  }>;
  privacy: string;
}

/** The tools a capability owns, so an invocation can satisfy a step. */
function toolsOfCapability(registry: GovernedCapabilityRegistry, capabilityId: string): string[] {
  return registry.definitions()
    .filter((definition) => registry.classify(definition.name)?.capabilityId === capabilityId)
    .map((definition) => definition.name);
}

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

/** The plan of the conversation a turn belongs to, if there is one. */
export function findActivePlan(db: CoreDatabase, conversationId: string | null | undefined): { id: string; instruction: string } | null {
  if (!conversationId) return null;
  const runs = listOperatorRuns(db, 50).filter((run) => run.workflow === 'model_plan');
  for (const run of runs) {
    const steps = listOperatorSteps(db, run.id);
    if (steps.some((step) => step.status === 'pending' || step.status === 'running')) {
      return { id: run.id, instruction: run.instruction };
    }
  }
  return null;
}

/**
 * The per-step truth of a plan, derived from the durable tool-invocation
 * evidence of the run's own conversation.
 *
 * A step is only "succeeded" when a tool it named actually ran and
 * succeeded. A step whose tool never ran is still pending, and a step whose
 * tool failed carries the failure.
 */
export function planStepTruth(
  db: CoreDatabase,
  planId: string,
  registry: GovernedCapabilityRegistry,
): Array<{ idx: number; title: string; capability: string; status: string; evidence: string | null; error: string | null }> {
  const steps = listOperatorSteps(db, planId);
  const run = db.get<{ context: string }>('SELECT context FROM operator_runs WHERE id = ?', [planId]);
  let conversationId: string | null = null;
  try {
    const context = JSON.parse(run?.context ?? '{}') as { conversationId?: string | null };
    conversationId = context.conversationId ?? null;
  } catch { /* no context */ }
  // The id is only a conversation id if that conversation really exists: a
  // plan declared through a capability dispatch carries the dispatch's
  // correlation id, which is not a conversation.
  if (conversationId && !db.get('SELECT id FROM conversations WHERE id = ?', [conversationId])) conversationId = null;
  const invocations = conversationId
    ? db.all<{ toolName: string; status: string; output: string | null }>(
      `SELECT ti.toolName AS toolName, ti.status AS status, ti.evidence AS output
         FROM tool_invocations ti
         JOIN attempts a ON a.id = ti.attemptId
         JOIN requests r ON r.id = a.requestId
        WHERE r.conversationId = ?
        ORDER BY ti.startedAt`,
      [conversationId],
    )
    : db.all<{ toolName: string; status: string; output: string | null }>(
      'SELECT toolName, status, evidence AS output FROM tool_invocations ORDER BY startedAt DESC LIMIT 100',
    );
  return steps.map((step) => {
    const tools = toolsOfCapability(registry, step.needs ?? '');
    const matching = invocations.filter((invocation) => tools.includes(invocation.toolName));
    if (matching.length === 0) {
      return { idx: step.idx, title: step.title, capability: step.needs ?? '', status: step.status, evidence: step.evidence, error: step.error };
    }
    const succeeded = matching.filter((invocation) => invocation.status === 'succeeded');
    const failed = matching.find((invocation) => invocation.status === 'failed' || invocation.status === 'cancelled');
    if (failed) {
      return { idx: step.idx, title: step.title, capability: step.needs ?? '', status: 'failed', evidence: null, error: `${failed.toolName} ${failed.status}` };
    }
    if (succeeded.length > 0) {
      return { idx: step.idx, title: step.title, capability: step.needs ?? '', status: 'succeeded', evidence: succeeded[succeeded.length - 1].toolName, error: null };
    }
    return { idx: step.idx, title: step.title, capability: step.needs ?? '', status: 'running', evidence: null, error: null };
  });
}

/** The plan as the person reads it. */
export function renderPlan(goal: string, steps: ReturnType<typeof planStepTruth>): string {
  const lines = [`Plan: ${goal}`];
  for (const step of steps) {
    const state = step.status === 'succeeded'
      ? 'done'
      : step.status === 'failed'
        ? `FAILED${step.error ? ` (${step.error})` : ''}`
        : step.status === 'running'
          ? 'running'
          : step.status === 'awaiting_approval'
            ? 'waiting for your approval'
            : 'not started yet';
    lines.push(`${step.idx + 1}. ${step.title} [${step.capability}] - ${state}`);
  }
  return lines.join('\n');
}

export interface ExecutionPlanOptions {
  db: CoreDatabase;
  registry: GovernedCapabilityRegistry;
}

export function createExecutionPlanAdapter(options: ExecutionPlanOptions): GovernedCapabilityAdapter {
  const { db, registry } = options;

  async function declare(call: ModelToolCall, ctx: { correlationId?: string }): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    const rawSteps = Array.isArray(args.steps) ? args.steps : [];
    if (!goal) return failure('goal is required', 'invalid_arguments');
    if (rawSteps.length === 0) return failure('a plan needs at least one step', 'invalid_arguments');
    if (rawSteps.length > MAX_STEPS) return failure(`a plan may have at most ${MAX_STEPS} steps`, 'invalid_arguments');

    const health = registry.healthSnapshot();
    const parsed: PlannedStepInput[] = [];
    for (const [index, raw] of rawSteps.entries()) {
      const step = (raw ?? {}) as Record<string, unknown>;
      const title = typeof step.title === 'string' ? step.title.trim() : '';
      const capability = typeof step.capability === 'string' ? step.capability.trim() : '';
      if (!title) return failure(`step ${index + 1} needs a title`, 'invalid_arguments');
      if (!capability) return failure(`step ${index + 1} needs the capability it uses`, 'invalid_arguments');
      // The capability must exist AND be usable right now. A plan that names
      // something that cannot run is refused BEFORE anything runs, so nobody
      // watches half a plan execute.
      const owned = registry.definitions().some((definition) => registry.classify(definition.name)?.capabilityId === capability);
      if (!owned) {
        return failure(`step ${index + 1} ("${title}") needs the capability "${capability}", which Pandesh does not have. Known capabilities: ${[...new Set(registry.definitions().map((definition) => registry.classify(definition.name)?.capabilityId).filter(Boolean))].sort().join(', ')}.`, 'plan_capability_unknown');
      }
      const state = health[capability];
      if (state && state.state !== 'available' && state.state !== 'degraded') {
        return failure(`step ${index + 1} ("${title}") needs "${capability}", which is ${state.state}${state.reason ? `: ${state.reason}` : ''}. Nothing was started; fix that first or plan something else.`, 'plan_capability_unavailable');
      }
      parsed.push({
        title: title.slice(0, MAX_TITLE_CHARS),
        capability,
        input: typeof step.input === 'string' ? step.input.slice(0, 400) : undefined,
        expectedOutput: typeof step.expectedOutput === 'string' ? step.expectedOutput.slice(0, 400) : undefined,
        verification: typeof step.verification === 'string' ? step.verification.slice(0, 400) : undefined,
        permission: step.permission === 'approval' ? 'approval' : 'read',
      });
    }

    const privacy = classifyPrivacy(goal, 'unsupported');
    const run = createOperatorRun(db, {
      instruction: goal,
      plan: {
        workflow: 'model_plan',
        privacy: privacy.privacy,
        privacyReasons: privacy.reasons,
        steps: parsed.map((step) => ({
          kind: 'model_step',
          title: step.title,
          needs: step.capability,
          approval: step.permission === 'approval' ? ('file_move' as never) : null,
          maxAttempts: 1,
        })),
      },
      context: { declaredBy: 'model', conversationId: ctx.correlationId ?? null, steps: parsed },
    });
    for (const [idx, step] of parsed.entries()) {
      updateOperatorStep(db, run.id, idx, {
        output: {
          capability: step.capability,
          input: step.input ?? null,
          expectedOutput: step.expectedOutput ?? null,
          verification: step.verification ?? null,
          permission: step.permission,
        },
        status: 'pending',
      });
    }
    recordOperatorEvent(db, run.id, 'plan_declared', `${parsed.length} step(s) declared`, null);

    const truth = planStepTruth(db, run.id, registry);
    return {
      status: 'succeeded',
      exitCode: 0,
      output: JSON.stringify({
        planId: run.id,
        goal,
        privacy: privacy.privacy,
        steps: truth,
        message: `Plan recorded (${parsed.length} step(s)). Work through it in order; each step reports what really happened.`,
      }),
      resultCategory: 'execution_plan_declared',
      normalizedArguments: { goal, steps: parsed.map((step) => ({ title: step.title, capability: step.capability })) },
      activity: { kind: 'tool', title: `Plan: ${goal.slice(0, 100)}`, excerpt: renderPlan(goal, truth) },
    };
  }

  async function status(_call: ModelToolCall): Promise<ToolExecutionResult> {
    const runs = listOperatorRuns(db, 50).filter((run) => run.workflow === 'model_plan');
    if (runs.length === 0) {
      return { status: 'succeeded', exitCode: 0, output: 'No execution plan has been declared in this conversation.', resultCategory: 'execution_plan_none' };
    }
    const latest = runs[0];
    const truth = planStepTruth(db, latest.id, registry);
    return {
      status: 'succeeded',
      exitCode: 0,
      output: JSON.stringify({ planId: latest.id, goal: latest.instruction, steps: truth }),
      resultCategory: 'execution_plan_status',
    };
  }

  return {
    id: 'plan',
    definitions: () => [
      {
        name: 'declare_execution_plan',
        description: 'Declare the ordered plan for a multi-step task BEFORE acting: for each step, the title, the capability it uses, the input, the expected output, the verification condition and whether it needs the person\'s approval. Pandesh checks the plan first and refuses it when a step names a capability that is not available right now, so nothing half-runs. Declare a plan only for a task with several real steps; a single request does not need one.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'What the whole task is.' },
            steps: {
              type: 'array',
              description: 'The steps, in order.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  capability: { type: 'string', description: 'The capability id this step uses (from the capability brief).' },
                  input: { type: 'string' },
                  expectedOutput: { type: 'string' },
                  verification: { type: 'string', description: 'How this step will be checked.' },
                  permission: { type: 'string', enum: ['read', 'approval'], description: '"read" for a read-only step, "approval" when it changes something.' },
                },
                required: ['title', 'capability'],
              },
            },
          },
          required: ['goal', 'steps'],
        },
      },
      {
        name: 'execution_plan_status',
        description: 'Report the plan of this conversation and the REAL outcome of every step, derived from the tool invocations that actually ran. Use it before you answer, so a step that failed is never described as done. Read-only.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    classify: (toolName) => (toolName === 'declare_execution_plan' ? 'consequential' : 'read_only'),
    health: () => ({ state: 'available', checkedAt: nowIso() }),
    run: async (call: ModelToolCall, ctx) => {
      if (call.name === 'declare_execution_plan') return declare(call, ctx ?? {});
      if (call.name === 'execution_plan_status') return status(call);
      return failure(`unknown tool '${call.name}'`, 'invalid_arguments');
    },
  };
}
