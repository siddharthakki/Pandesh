import {
  InferenceProvider,
  ProviderApiError,
  ProviderCancelledError,
  ProviderChatOptions,
  ProviderTimeoutError,
} from '../providers/ProviderTypes';
import type { ChatMessage, ToolDefinition } from '../tools/ToolTypes';
import type { ProbeStepId, RuntimeCapabilityProfile } from './RuntimeCapabilityProfile';

/**
 * Bounded, cheap capability probe. It asks the runtime a handful of tiny questions whose answers change what KKD
 * does, and nothing else. Worst case: 6 short requests (schema, prompt-only, schema with reasoning off, tool call,
 * tool continuation), each with its own deadline, all under one overall deadline. Every step is independent: a step
 * that fails or times out leaves its field `unknown`/negative and the probe carries on, so a runtime that cannot be
 * probed yields a conservative profile instead of an error.
 */

export interface ProbeOptions {
  /** Per-request deadline. A cold model load is the reason the first request gets more. */
  requestTimeoutMs?: number;
  firstRequestTimeoutMs?: number;
  /** Overall ceiling; steps still pending when it passes are skipped. */
  overallTimeoutMs?: number;
  /** Probe the native tool path and the post-tool continuation (where a stall was seen live). */
  probeTools?: boolean;
  /**
   * The window the real dispatch will use (`num_ctx`). The probe must send the SAME value: a different one makes
   * Ollama reload the model, which is slow and would time the probe out on the very thing it measures.
   */
  contextWindow?: number;
  contextProvenance?: string;
  signal?: AbortSignal;
  now?: () => number;
  /**
   * Called with a snapshot after every answered step, so a probe that is cut short (the window closes, the process
   * is killed, the runtime goes quiet) still leaves everything it learned. The snapshot is `complete: false`
   * until the probe finishes.
   */
  onProgress?: (partial: RuntimeCapabilityProfile) => void | Promise<void>;
}

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, word: { type: 'string' } },
  required: ['ok', 'word'],
  additionalProperties: false,
} as const;
const PROBE_PROMPT = 'Reply with one JSON object only: {"ok": true, "word": "ready"}. No other text.';
const PROBE_OUTPUT_TOKENS = 384;

const ECHO_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'probe_echo',
    description: 'Echo a short word back.',
    parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
  },
};

function looksLikeProbeJson(text: string): boolean {
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null && typeof parsed['ok'] === 'boolean';
  } catch {
    return false;
  }
}

type StepResult =
  | { kind: 'reply'; message: ChatMessage; done: boolean; ms: number }
  | { kind: 'timeout' | 'cancelled' | 'rejected' | 'error'; ms: number };

export async function probeRuntime(
  provider: InferenceProvider,
  base: RuntimeCapabilityProfile,
  options: ProbeOptions = {},
): Promise<RuntimeCapabilityProfile> {
  const now = options.now ?? Date.now;
  const started = now();
  const overallMs = options.overallTimeoutMs ?? 120_000;
  const requestMs = options.requestTimeoutMs ?? 30_000;
  const firstMs = options.firstRequestTimeoutMs ?? 90_000;
  // Resuming: a base that already answered some steps keeps those answers and its evidence; only the rest is asked.
  const profile: RuntimeCapabilityProfile = {
    ...base,
    source: 'probe',
    reasoning: { ...base.reasoning },
    providerHealth: { ...base.providerHealth },
    evidence: base.completedSteps?.length ? [...base.evidence] : [],
    completedSteps: [...(base.completedSteps ?? [])],
    complete: false,
  };
  const done = (id: ProbeStepId): boolean => profile.completedSteps?.includes(id) === true;
  const markDone = async (id: ProbeStepId): Promise<void> => {
    if (!done(id)) profile.completedSteps = [...(profile.completedSteps ?? []), id];
    profile.probedAt = new Date(now()).toISOString();
    await options.onProgress?.({
      ...profile,
      reasoning: { ...profile.reasoning },
      providerHealth: { ...profile.providerHealth },
      completedSteps: [...(profile.completedSteps ?? [])],
      evidence: [...profile.evidence],
    });
  };
  const note = (text: string): void => { profile.evidence.push(text); };
  if (profile.completedSteps?.length) note(`resuming probe after ${profile.completedSteps.join(', ')}`);
  let firstRequest = true;
  let unresponsive = false;
  const overBudget = (): boolean => unresponsive || now() - started >= overallMs || options.signal?.aborted === true;

  const model = base.identity.model;
  const chatOptions = (extra: Partial<ProviderChatOptions>, timeoutMs: number): ProviderChatOptions => ({
    model,
    contextWindow: options.contextWindow ?? 8192,
    maxOutputTokens: PROBE_OUTPUT_TOKENS,
    temperature: 0,
    timeoutMs,
    ...extra,
  });
  const step = async (messages: ChatMessage[], tools: ToolDefinition[], extra: Partial<ProviderChatOptions>): Promise<StepResult> => {
    const timeoutMs = firstRequest ? firstMs : requestMs;
    firstRequest = false;
    const t0 = now();
    try {
      const response = await provider.chat(messages, tools, chatOptions(extra, timeoutMs), options.signal);
      return { kind: 'reply', message: response.message, done: response.done, ms: now() - t0 };
    } catch (error) {
      const ms = now() - t0;
      if (error instanceof ProviderTimeoutError) { unresponsive = true; return { kind: 'timeout', ms }; }
      if (error instanceof ProviderCancelledError) return { kind: 'cancelled', ms };
      if (error instanceof ProviderApiError && error.statusCode >= 400 && error.statusCode < 500) return { kind: 'rejected', ms };
      return { kind: 'error', ms };
    }
  };

  // Free: what the provider says about the served context window. The effective window is the one dispatch uses.
  try {
    const meta = await provider.getModelContextMetadata?.(model, options.signal);
    if (options.contextWindow) {
      profile.contextWindow = { tokens: options.contextWindow, provenance: options.contextProvenance ?? 'dispatch' };
      note(`effective context ${options.contextWindow} tokens (${options.contextProvenance ?? 'dispatch'})${meta?.declaredContextWindow ? `; model declares ${meta.declaredContextWindow}` : ''}`);
    } else if (meta?.contextWindow) {
      profile.contextWindow = { tokens: meta.contextWindow, provenance: 'provider_runtime' };
      note(`context ${meta.contextWindow} tokens reported by the runtime`);
    } else if (meta?.declaredContextWindow) {
      profile.contextWindow = { tokens: meta.declaredContextWindow, provenance: 'declared' };
      note(`context ${meta.declaredContextWindow} tokens declared by the model (served window not reported)`);
    }
  } catch {
    note('context metadata unavailable');
  }

  const messages: ChatMessage[] = [{ role: 'user', content: PROBE_PROMPT }];
  const format = { type: 'json_schema' as const, name: 'runtime_probe', schema: SCHEMA as unknown as Record<string, unknown> };

  // 1. Provider-enforced schema, default reasoning. Also the first request, so it pays the cold load.
  if (!done('schema') && !overBudget()) {
    const result = await step(messages, [], { responseFormat: format });
    profile.latencyMs = result.ms;
    if (result.kind === 'reply') {
      const text = result.message.content ?? '';
      if (result.done && text.length === 0) {
        profile.emptyCompletion = 'observed';
        profile.reasoning.supported = 'yes';
        profile.structuredSchema = 'unknown';
        note(`schema probe returned an empty completion in ${result.ms}ms at ${PROBE_OUTPUT_TOKENS} output tokens (reasoning consumed the budget)`);
      } else if (looksLikeProbeJson(text)) {
        profile.structuredSchema = 'yes';
        profile.emptyCompletion = 'not_observed';
        profile.practicalOutputTokens = Math.ceil(text.length / 4);
        note(`schema probe returned well-formed JSON in ${result.ms}ms`);
      } else {
        profile.structuredSchema = 'no';
        note('schema probe returned text that did not satisfy the schema: enforcement not honoured');
      }
    } else if (result.kind === 'rejected') {
      profile.structuredSchema = 'no';
      note('runtime rejected a schema-constrained request');
    } else {
      if (result.kind === 'timeout') profile.providerHealth.timeouts += 1;
      note(`schema probe ${result.kind} after ${result.ms}ms: capabilities left unknown`);
    }
    // A timeout or error answered nothing, so it is not a completed step: a resumed probe asks again.
    if (result.kind === 'reply' || result.kind === 'rejected') await markDone('schema');
  }

  // 2. Reasoning off: only worth asking when reasoning ate the budget, or to learn whether it can be disabled.
  if (!done('reasoning_off') && !overBudget() && profile.emptyCompletion === 'observed') {
    const result = await step(messages, [], { responseFormat: format, nativeThinking: false });
    if (result.kind === 'reply' && looksLikeProbeJson(result.message.content ?? '')) {
      profile.reasoning.canDisable = 'yes';
      profile.structuredSchema = 'yes';
      note(`reasoning disabled: same request answered in ${result.ms}ms`);
    } else if (result.kind === 'reply') {
      profile.reasoning.canDisable = 'no';
      note('reasoning disable request did not change the outcome');
    }
    if (result.kind === 'reply') await markDone('reasoning_off');
  }

  // 3. Prompt-only contract: can it follow the JSON contract without a decoder forcing it?
  if (!done('prompt_only') && !overBudget()) {
    const result = await step(messages, [], {});
    if (result.kind === 'reply') {
      const text = result.message.content ?? '';
      profile.latencyMs = Math.min(profile.latencyMs ?? result.ms, result.ms);
      if (text.length === 0 && result.done) {
        profile.emptyCompletion = 'observed';
        profile.reasoning.supported = 'yes';
        profile.promptOnlyContract = 'no';
        note('prompt-only probe returned an empty completion');
      } else {
        profile.promptOnlyContract = looksLikeProbeJson(text) ? 'yes' : 'no';
        if (profile.emptyCompletion === 'unknown') profile.emptyCompletion = 'not_observed';
        note(`prompt-only JSON contract ${profile.promptOnlyContract === 'yes' ? 'followed' : 'not followed'}`);
      }
      await markDone('prompt_only');
    }
  }

  // 4. Native tools and the continuation after a tool result.
  if (options.probeTools !== false && !done('tools') && !overBudget()) {
    const ask: ChatMessage[] = [{ role: 'user', content: 'Call the probe_echo tool with word "ready". Do not answer in text.' }];
    const call = await step(ask, [ECHO_TOOL], {});
    if (call.kind === 'reply' && call.message.tool_calls?.length) {
      profile.nativeTools = 'yes';
      const toolCall = call.message.tool_calls[0];
      if (!overBudget()) {
        const cont = await step([
          ...ask,
          { role: 'assistant', content: call.message.content ?? '', tool_calls: [toolCall] },
          { role: 'tool', content: '{"echo":"ready"}', tool_call_id: toolCall.id, tool_name: toolCall.function.name },
        ], [ECHO_TOOL], {});
        if (cont.kind === 'reply') {
          profile.postToolContinuation = 'healthy';
          note(`native tool call and continuation completed (${cont.ms}ms)`);
        } else if (cont.kind === 'timeout') {
          profile.postToolContinuation = 'stalls';
          profile.providerHealth.stalls += 1;
          note(`native tool result continuation stalled after ${cont.ms}ms: prefer supplying evidence outside the native tool loop`);
        } else {
          profile.postToolContinuation = 'unknown';
          note(`tool continuation ${cont.kind}`);
        }
      }
    } else if (call.kind === 'reply') {
      profile.nativeTools = 'no';
      profile.postToolContinuation = 'unsupported';
      note('runtime answered in text instead of a native tool call');
    } else if (call.kind === 'rejected') {
      profile.nativeTools = 'no';
      profile.postToolContinuation = 'unsupported';
      note('runtime rejected a request that carries tool definitions');
    } else if (call.kind === 'timeout') {
      profile.nativeTools = 'unknown';
      profile.providerHealth.timeouts += 1;
      note(`tool probe timed out after ${call.ms}ms`);
    }
    if (call.kind === 'reply' || call.kind === 'rejected') await markDone('tools');
  }

  if (unresponsive) note('runtime did not answer within the probe deadline: remaining probes skipped, profile stays conservative');
  profile.probedAt = new Date(now()).toISOString();
  // Complete only when every applicable step was actually answered. A probe that ran out of budget, was cancelled or
  // hit an unresponsive runtime is partial: usable now, short-lived, and resumed rather than repeated.
  const required: ProbeStepId[] = ['schema', 'prompt_only', ...(options.probeTools !== false ? ['tools' as const] : []), ...(profile.emptyCompletion === 'observed' ? ['reasoning_off' as const] : [])];
  profile.complete = required.every(done);
  note(`probe ${profile.complete ? 'finished' : 'stopped early (partial profile)'} in ${now() - started}ms`);
  return profile;
}
