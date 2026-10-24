/**
 * The Hermes specialist surface, reachable from a Pandesh conversation.
 *
 * Hermes is a real installed agent with its own skill library. Core already
 * spoke the official Runs API (`core/runtime/hermesEngine.ts`), but the chat
 * model could not discover or invoke a skill: there was no route, and no
 * tool that named a skill at all.
 *
 * This adapter is that route:
 *   - `hermes_list_skills` reads the installed skill set (the live
 *     `/v1/skills` endpoint, or the local Hermes install when that endpoint
 *     is broken — the result always says which one it used),
 *   - `hermes_invoke_skill` runs one real skill through `POST /v1/runs` and
 *     returns Hermes' own result, including the tools it actually called.
 *
 * Invocation is consequential (it starts an external agent that can act), so
 * it goes through the existing approval fabric like every other mutation.
 */
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { HermesEngine } from './hermesEngine';

const READ_ONLY_TOOLS = new Set(['hermes_list_skills']);

export interface HermesSkillCapabilityOptions {
  /** Overrides the provider the run is routed through. Defaults to the
   * installed Hermes `ollama-launch` provider so a run stays on the local
   * model instead of silently leaving the machine. */
  provider?: string;
  model?: string;
}

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

function nonEmptyString(value: unknown, maxChars = 4000): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed.length <= maxChars ? trimmed : null;
}

export function createHermesSkillCapabilityAdapter(options: HermesSkillCapabilityOptions = {}): GovernedCapabilityAdapter {
  async function listSkills(): Promise<ToolExecutionResult> {
    const result = await HermesEngine.listSkills();
    if (result.skills.length === 0) {
      return {
        status: 'failed',
        exitCode: 1,
        output: `No Hermes skills were found (source: ${result.source}${result.apiError ? `; ${result.apiError}` : ''}).`,
        resultCategory: 'hermes_no_skills',
      };
    }
    const header = `Installed Hermes skills (${result.skills.length}, source: ${result.source}${result.apiError ? ` — the live API failed: ${result.apiError}` : ''}):`;
    const lines = result.skills.map((skill) => `- ${skill.name}${skill.description ? ` — ${skill.description}` : ''}`);
    return { status: 'succeeded', exitCode: 0, output: [header, ...lines].join('\n'), resultCategory: 'hermes_skills_listed' };
  }

  async function invokeSkill(call: ModelToolCall, ctx: { cwd: string; signal?: AbortSignal }): Promise<ToolExecutionResult> {
    const skill = nonEmptyString(call.arguments.skill ?? call.arguments.name, 120);
    if (!skill) return failure('skill is required', 'invalid_arguments');
    const task = nonEmptyString(call.arguments.task ?? call.arguments.input ?? call.arguments.prompt);
    if (!task) return failure('task is required', 'invalid_arguments');

    const listed = await HermesEngine.listSkills();
    const known = listed.skills.find((candidate) => candidate.name.toLowerCase() === skill.toLowerCase());
    if (!known) {
      return failure(
        `Hermes has no installed skill named '${skill}'. Known skills: ${listed.skills.map((s) => s.name).join(', ') || '(none)'}`,
        'hermes_skill_not_found',
      );
    }

    const run = await HermesEngine.invokeSkill({
      skill: known.name,
      task,
      model: options.model,
      provider: options.provider ?? 'ollama-launch',
      workspaceRoot: ctx.cwd,
      signal: ctx.signal,
    });

    const calledTools = run.toolCalls.map((call_) => `${call_.tool} (${call_.status ?? 'unknown'})`);
    const summary = [
      `Hermes run ${run.runId ?? '(no run id)'} for skill '${known.name}' — status: ${run.status}.`,
      calledTools.length ? `Tools Hermes actually called: ${calledTools.join(', ')}` : 'Tools Hermes actually called: (none recorded)',
      run.error ? `Error: ${run.error}` : '',
      'Result:',
      run.output || '(no output returned by Hermes)',
    ].filter((line) => line.length > 0).join('\n');

    if (run.status === 'cancelled') {
      return { status: 'failed', exitCode: 1, output: summary, resultCategory: 'hermes_skill_cancelled', normalizedArguments: { skill: known.name, runId: run.runId } };
    }
    if (run.status !== 'completed') {
      return { status: 'failed', exitCode: 1, output: summary, resultCategory: 'hermes_skill_failed', normalizedArguments: { skill: known.name, runId: run.runId } };
    }
    return { status: 'succeeded', exitCode: 0, output: summary, resultCategory: 'hermes_skill_invoked', normalizedArguments: { skill: known.name, runId: run.runId } };
  }

  return {
    id: 'hermes',
    definitions: () => [
      {
        name: 'hermes_list_skills',
        description: 'List the skills installed in the local Hermes agent (name + description), with the source the list came from. Read-only.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'hermes_invoke_skill',
        description: 'Run one installed Hermes skill on a task and return Hermes\' own result, including the tools it actually called. Consequential — Hermes can act on the machine.',
        parameters: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'The exact installed skill name (from hermes_list_skills).' },
            task: { type: 'string', description: 'What the skill should do.' },
          },
          required: ['skill', 'task'],
        },
      },
    ],
    classify: (toolName) => (READ_ONLY_TOOLS.has(toolName) ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async (call, ctx) => {
      switch (call.name) {
        case 'hermes_list_skills': return listSkills();
        case 'hermes_invoke_skill': return invokeSkill(call, ctx);
        default: return Promise.resolve(failure(`unknown tool '${call.name}'`, 'invalid_arguments'));
      }
    },
  };
}
