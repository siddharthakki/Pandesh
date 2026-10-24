import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  InferenceProvider,
  ModelInfo,
  ProviderApiError,
  ProviderCancelledError,
  ProviderChatOptions,
  ProviderConnectionError,
  ProviderTimeoutError,
  ProviderType,
} from '../../providers/ProviderTypes';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';
import {
  PROFILE_TTL_MS,
  RuntimeProfileStore,
  conservativeProfile,
  makeIdentity,
  runtimeKey,
} from '../../runtimeProfile/RuntimeCapabilityProfile';
import { probeRuntime } from '../../runtimeProfile/RuntimeProbe';
import { RuntimeIntelligence } from '../../runtimeProfile/RuntimeIntelligence';
import { negotiateContract } from '../../reliability/ContractNegotiator';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';
import {
  ProviderHealthController,
  ProviderHealthError,
  classifyProviderProblem,
  describeProviderHealth,
} from '../../reliability/ProviderHealthController';
import { classifyFailureCause, classifyGovernedFailure, countsAsReasoningFailure } from '../../reliability/FailureClassification';
import { recompileForAdmission, trimBody } from '../../reliability/AdmissionRecovery';
import { ContextBudgetPlanner } from '../../reliability/ContextBudget';
import { resolveContextLimit } from '../../reliability/ModelProfiles';
import { ProviderGatewayGovernedModelExecutionDependency } from '../../agent/ProviderGatewayGovernedModelExecutionDependency';
import { GOVERNED_MODEL_CONTRACT_VERSION } from '../../agent/GovernedModelExecutionTypes';
import { buildCodingProposalPrompt } from '../../coding/CodingPlanner';

const UNKNOWN = 'unlisted-model-x:12b';

type ChatScript = (messages: ChatMessage[], tools: ToolDefinition[], options: ProviderChatOptions, call: number) => ChatResponse | Error | Promise<ChatResponse | Error>;

class ScriptedProvider implements InferenceProvider {
  readonly providerType: ProviderType;
  calls: Array<{ messages: ChatMessage[]; tools: ToolDefinition[]; options: ProviderChatOptions }> = [];
  constructor(private readonly script: ChatScript, readonly endpoint = 'http://localhost:11434', providerType: ProviderType = 'ollama', private readonly meta: Partial<ModelInfo> = {}) {
    this.providerType = providerType;
  }
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return []; }
  async getModelContextMetadata(model: string): Promise<ModelInfo | undefined> { return { name: model, ...this.meta }; }
  async chat(messages: ChatMessage[], tools: ToolDefinition[], options: ProviderChatOptions): Promise<ChatResponse> {
    this.calls.push({ messages, tools, options });
    const result = await this.script(messages, tools, options, this.calls.length);
    if (result instanceof Error) throw result;
    return result;
  }
}

const text = (content: string): ChatResponse => ({ message: { role: 'assistant', content }, done: true });
const timeout = (tag?: 'transport:undici-headers' | 'transport:undici-body') => new ProviderTimeoutError('timed out', 'ollama', 1000, 'transport', tag);
const PROBE_JSON = '{"ok": true, "word": "ready"}';

/** A capable runtime: follows the prompt contract, honours the schema, native tools work end to end. */
const strongScript: ChatScript = (messages, tools) => {
  if (tools.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') return text('done');
    return { message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'probe_echo', arguments: { word: 'ready' } } }] }, done: true };
  }
  return text(PROBE_JSON);
};

/** gemma4:12b-shaped: reasoning eats the small budget unless it is switched off; tools not offered. */
const thinkingScript: ChatScript = (_m, tools, options) => {
  if (tools.length > 0) return text('I would call it');
  return options.nativeThinking === false ? text(PROBE_JSON) : text('');
};

describe('runtime identity and the profile cache', () => {
  it('the same model behind a different runtime or configuration is a different profile', () => {
    const base = makeIdentity({ model: 'm:12b', providerType: 'ollama', endpoint: 'http://localhost:11434/' });
    expect(runtimeKey(base)).toBe(runtimeKey(makeIdentity({ model: 'm:12b', providerType: 'ollama', endpoint: 'http://localhost:11434' })));
    expect(runtimeKey(base)).not.toBe(runtimeKey(makeIdentity({ model: 'm:12b', providerType: 'openai-compatible', endpoint: 'http://localhost:11434' })));
    expect(runtimeKey(base)).not.toBe(runtimeKey(makeIdentity({ model: 'm:12b', providerType: 'ollama', endpoint: 'http://localhost:8080' })));
    expect(runtimeKey(base)).not.toBe(runtimeKey(makeIdentity({ model: 'm:12b', providerType: 'ollama', endpoint: 'http://localhost:11434', contextOverride: 8192 })));
    // Re-pulling the model changes modifiedAt, which invalidates what was learned.
    expect(runtimeKey(base)).not.toBe(runtimeKey(makeIdentity({ model: 'm:12b', providerType: 'ollama', endpoint: 'http://localhost:11434', modelModifiedAt: '2026-09-01' })));
  });

  describe('store', () => {
    let dir: string;
    beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm47-profile-')); });
    afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

    it('survives a restart, expires, and tolerates a corrupt file', async () => {
      const file = path.join(dir, 'p.json');
      const identity = makeIdentity({ model: 'm:12b', providerType: 'ollama' });
      const probed = { ...conservativeProfile(identity), source: 'probe' as const, probedAt: new Date().toISOString(), structuredSchema: 'yes' as const };
      await new RuntimeProfileStore(file).put(probed);

      const reopened = new RuntimeProfileStore(file);
      expect((await reopened.get(identity))?.structuredSchema).toBe('yes');

      const later = new RuntimeProfileStore(file, () => new Date(Date.now() + PROFILE_TTL_MS + 1000));
      expect(await later.get(identity)).toBeUndefined();

      await fs.writeFile(file, '{ not json', 'utf8');
      expect(await new RuntimeProfileStore(file).get(identity)).toBeUndefined();
      await new RuntimeProfileStore(file).put(probed);
      expect(await new RuntimeProfileStore(file).get(identity)).toBeDefined();
    });

    it('forgets a model everywhere it was seen', async () => {
      const store = new RuntimeProfileStore(path.join(dir, 'p.json'));
      const a = makeIdentity({ model: 'm:12b', providerType: 'ollama', endpoint: 'http://a' });
      const b = makeIdentity({ model: 'm:12b', providerType: 'ollama', endpoint: 'http://b' });
      await store.put({ ...conservativeProfile(a), source: 'probe', probedAt: new Date().toISOString() });
      await store.put({ ...conservativeProfile(b), source: 'probe', probedAt: new Date().toISOString() });
      expect(await store.invalidateModel('m:12b')).toBe(2);
      expect(await store.get(a)).toBeUndefined();
    });
  });
});

describe('bounded runtime probe', () => {
  const identity = makeIdentity({ model: UNKNOWN, providerType: 'ollama', endpoint: 'http://localhost:11434' });

  it('a capable runtime is profiled as capable and nothing is constrained', async () => {
    const provider = new ScriptedProvider(strongScript, undefined, 'ollama', { contextWindow: 32768 });
    const profile = await probeRuntime(provider, conservativeProfile(identity));
    expect(profile.source).toBe('probe');
    expect(profile.contextWindow).toEqual({ tokens: 32768, provenance: 'provider_runtime' });
    expect(profile.structuredSchema).toBe('yes');
    expect(profile.promptOnlyContract).toBe('yes');
    expect(profile.emptyCompletion).toBe('not_observed');
    expect(profile.nativeTools).toBe('yes');
    expect(profile.postToolContinuation).toBe('healthy');
    expect(negotiateContract(profile)).toMatchObject({ interaction: 'native_default', reasoning: 'default', contractMode: 'prompt_only' });
    // cheap: schema, prompt-only, tool call, continuation
    expect(provider.calls.length).toBeLessThanOrEqual(4);
    expect(provider.calls.every(call => call.options.maxOutputTokens <= 512)).toBe(true);
  });

  it('a reasoning-trap runtime is profiled from behaviour, and the negotiator starts it enforced with reasoning off', async () => {
    const provider = new ScriptedProvider(thinkingScript);
    const profile = await probeRuntime(provider, conservativeProfile(identity));
    expect(profile.emptyCompletion).toBe('observed');
    expect(profile.reasoning).toMatchObject({ supported: 'yes', canDisable: 'yes' });
    expect(profile.structuredSchema).toBe('yes');
    expect(profile.promptOnlyContract).toBe('no');
    const decision = negotiateContract(profile);
    expect(decision).toMatchObject({ interaction: 'provider_schema', contractMode: 'provider_schema', reasoning: 'disabled', basis: 'profile' });
  });

  it('a stalled post-tool continuation is recorded as a stall, not a failure of the model', async () => {
    const provider = new ScriptedProvider((messages, tools, options, call) => {
      if (tools.length > 0 && messages[messages.length - 1].role === 'tool') return timeout('transport:undici-body');
      return strongScript(messages, tools, options, call);
    });
    const profile = await probeRuntime(provider, conservativeProfile(identity));
    expect(profile.nativeTools).toBe('yes');
    expect(profile.postToolContinuation).toBe('stalls');
    expect(profile.providerHealth.stalls).toBe(1);
  });

  it('an unreachable runtime yields a conservative, non-rejecting profile', async () => {
    const provider = new ScriptedProvider(() => new ProviderConnectionError('down', 'ollama', 'http://x'));
    const profile = await probeRuntime(provider, conservativeProfile(identity));
    expect(profile.structuredSchema).toBe('unknown');
    expect(negotiateContract(profile).interaction).toBe('native_default');
  });

  it('sends the dispatch context window, never the model declared one, and stops after one timeout', async () => {
    const provider = new ScriptedProvider(() => timeout('transport:undici-headers'), undefined, 'ollama', { contextWindow: undefined, declaredContextWindow: 262144 });
    const profile = await probeRuntime(provider, conservativeProfile(identity), { contextWindow: 8192, contextProvenance: 'user_override' });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].options.contextWindow).toBe(8192);
    expect(profile.contextWindow).toEqual({ tokens: 8192, provenance: 'user_override' });
    expect(profile.evidence.join(' ')).toMatch(/262144/);
    expect(profile.evidence.join(' ')).toMatch(/remaining probes skipped/);
    expect(negotiateContract(profile).basis).toBe('default');
  });

  it('respects the overall deadline', async () => {
    let clock = 0;
    const provider = new ScriptedProvider(() => { clock += 100_000; return text(PROBE_JSON); });
    const profile = await probeRuntime(provider, conservativeProfile(identity), { now: () => clock, overallTimeoutMs: 150_000 });
    expect(provider.calls.length).toBeLessThanOrEqual(2);
    // Out of budget before every step answered: a partial profile, said so, and resumable (M47.1 lifecycle).
    expect(profile.complete).toBe(false);
    expect(profile.evidence.some(line => line.startsWith('probe stopped early'))).toBe(true);
  });
});

describe('contract negotiation', () => {
  const identity = makeIdentity({ model: UNKNOWN, providerType: 'ollama' });
  const probed = (over: Partial<ReturnType<typeof conservativeProfile>> = {}) => ({ ...conservativeProfile(identity), source: 'probe' as const, ...over });

  it('with no profile or a conservative one nothing is forced', () => {
    expect(negotiateContract(undefined).interaction).toBe('native_default');
    expect(negotiateContract(conservativeProfile(identity)).basis).toBe('default');
  });

  it('a protocol failure on a schema-capable runtime enforces the schema and turns reasoning off only if it can be', () => {
    const profile = probed({ structuredSchema: 'yes', reasoning: { supported: 'yes', canDisable: 'yes' } });
    expect(negotiateContract(profile, { protocolFailures: 1 })).toMatchObject({ interaction: 'provider_schema', reasoning: 'disabled', basis: 'live_observation' });
    const noDisable = probed({ structuredSchema: 'yes', reasoning: { supported: 'yes', canDisable: 'no' } });
    expect(negotiateContract(noDisable, { protocolFailures: 1 }).reasoning).toBe('default');
  });

  it('enforcement that did not help is never started again, and the kill switch wins', () => {
    const harmed = probed({ structuredSchema: 'yes', promptOnlyContract: 'no', schemaEnforcementHelps: 'no' });
    expect(negotiateContract(harmed)).toMatchObject({ interaction: 'prompt_contract', contractMode: 'prompt_only' });
    expect(negotiateContract(probed({ structuredSchema: 'yes', promptOnlyContract: 'no' }), {}, { OLLAMA_AGENT_ADAPTIVE_SCHEMA: '0' }).interaction).toBe('native_default');
    expect(negotiateContract(probed({ structuredSchema: 'yes' }), { enforcementHarmful: true }).basis).toBe('live_observation');
  });

  it('a runtime that once helped by enforcement starts enforced next time', () => {
    expect(negotiateContract(probed({ schemaEnforcementHelps: 'yes' }))).toMatchObject({ interaction: 'provider_schema', basis: 'profile' });
  });

  it('empty completions alone switch reasoning off without touching the contract', () => {
    const profile = probed({ emptyCompletion: 'observed', promptOnlyContract: 'yes', reasoning: { supported: 'yes', canDisable: 'yes' } });
    expect(negotiateContract(profile)).toMatchObject({ interaction: 'prompt_contract', contractMode: 'prompt_only', reasoning: 'disabled' });
  });
});

describe('negotiated start reaches the dispatch profile without disturbing M46 state', () => {
  afterEach(() => { ModelProfileRegistry.clearNegotiation(); ModelProfileRegistry.clearObservedStructuredOutput(); });

  it('applies to an unknown model only, and can be cleared', () => {
    expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe('unsupported');
    expect(ModelProfileRegistry.applyNegotiation(UNKNOWN, 'ollama', { schemaEnforced: true, reasoningOff: true })).toBe(true);
    const resolved = ModelProfileRegistry.resolve(UNKNOWN, 'ollama');
    expect(resolved).toMatchObject({ structuredOutput: 'ollama_format', disableNativeThinking: true });
    expect(ModelProfileRegistry.hasNegotiatedSchema(UNKNOWN, 'ollama')).toBe(true);
    // M46's own observation is independent and is cleared by its own call.
    ModelProfileRegistry.observeStructuredOutput(UNKNOWN, 'ollama', 'ollama_format');
    ModelProfileRegistry.clearObservedStructuredOutput();
    expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe('ollama_format');
    ModelProfileRegistry.applyNegotiation(UNKNOWN, 'ollama', { schemaEnforced: false, reasoningOff: false });
    expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe('unsupported');
    const known = ModelProfileRegistry.all().find(profile => !profile.fallback && profile.family === 'qwen-coder');
    expect(known).toBeDefined();
    expect(ModelProfileRegistry.applyNegotiation('qwen2.5-coder:14b', 'ollama', { schemaEnforced: true, reasoningOff: true })).toBe(false);
  });
});

describe('RuntimeIntelligence service', () => {
  afterEach(() => RuntimeIntelligence.resetShared());

  it('is inert unless enabled, so scripted providers see no extra requests', async () => {
    const provider = new ScriptedProvider(strongScript);
    expect(await new RuntimeIntelligence({ enabled: false }).prepare(provider, UNKNOWN)).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it('accepts an unknown model, probes once, applies the negotiated start, and reuses the cache', async () => {
    const provider = new ScriptedProvider(thinkingScript);
    const runtime = RuntimeIntelligence.configureShared({ enabled: true });
    const first = await runtime.prepare(provider, UNKNOWN);
    expect(first?.profile.source).toBe('probe');
    expect(first?.decision.interaction).toBe('provider_schema');
    expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama')).toMatchObject({ structuredOutput: 'ollama_format', disableNativeThinking: true });
    const callsAfterProbe = provider.calls.length;
    await runtime.prepare(provider, UNKNOWN);
    expect(provider.calls.length).toBe(callsAfterProbe);
  });

  it('live enforcement outcomes change the next start, and harm reverts it', async () => {
    const provider = new ScriptedProvider(strongScript);
    const runtime = RuntimeIntelligence.configureShared({ enabled: true });
    await runtime.prepare(provider, UNKNOWN);
    expect(ModelProfileRegistry.hasNegotiatedSchema(UNKNOWN, 'ollama')).toBe(false);
    await runtime.recordByModel('ollama', UNKNOWN, 'schema_helped');
    expect(ModelProfileRegistry.hasNegotiatedSchema(UNKNOWN, 'ollama')).toBe(true);
    await runtime.recordByModel('ollama', UNKNOWN, 'schema_harmful');
    expect(ModelProfileRegistry.hasNegotiatedSchema(UNKNOWN, 'ollama')).toBe(false);
  });

  it('a probe that outlives the blocking budget lets the first dispatch proceed conservatively', async () => {
    const provider = new ScriptedProvider(async () => { await new Promise(resolve => setTimeout(resolve, 200)); return text(PROBE_JSON); });
    const runtime = RuntimeIntelligence.configureShared({ enabled: true, blockingBudgetMs: 20 });
    const prepared = await runtime.prepare(provider, UNKNOWN);
    expect(prepared?.profile.source).toBe('conservative');
    expect(prepared?.decision.basis).toBe('default');
  });
});

describe('provider health ladder', () => {
  const fast = () => new ProviderHealthController({ maxRetries: 1, backoffMs: 0, minRemainingMs: 0 }, async () => undefined);

  it('classifies without confusing provider problems with anything semantic', () => {
    expect(classifyProviderProblem(timeout('transport:undici-headers'))).toBe('timeout');
    expect(classifyProviderProblem(timeout('transport:undici-body'))).toBe('response_stall');
    expect(classifyProviderProblem(new ProviderApiError('boom', 'ollama', 503))).toBe('server_error');
    expect(classifyProviderProblem(new ProviderApiError('n_ctx exceeded: prompt is too long', 'ollama', 400))).toBe('context_envelope_rejected');
    expect(classifyProviderProblem(new ProviderApiError('bad', 'ollama', 404))).toBe('client_rejected');
    expect(classifyProviderProblem(new ProviderConnectionError('down', 'ollama', 'x'))).toBe('provider_unavailable');
    expect(classifyProviderProblem(new ProviderCancelledError('c', 'ollama'))).toBe('cancelled');
  });

  it('a timeout is retried once and recovers', async () => {
    let n = 0;
    const result = await fast().run(async () => (++n === 1 ? Promise.reject(timeout('transport:undici-headers')) : text('ok')), { canDisableReasoning: false });
    expect(n).toBe(2);
    expect(describeProviderHealth(result.events)).toBe('provider_health:timeout>retry_same,recovered');
  });

  it('is bounded: a second failure stops with the original error and both events', async () => {
    let n = 0;
    const error = await fast().run(async () => { n++; throw new ProviderApiError('boom', 'ollama', 502); }, { canDisableReasoning: false }).catch(e => e);
    expect(n).toBe(2);
    expect(error).toBeInstanceOf(ProviderHealthError);
    expect((error as ProviderHealthError).cause_).toBeInstanceOf(ProviderApiError);
    expect((error as ProviderHealthError).events.map(event => event.step)).toEqual(['retry_backoff', 'stop']);
  });

  it('never retries cancellation or a client rejection', async () => {
    for (const failure of [new ProviderCancelledError('c', 'ollama'), new ProviderApiError('nope', 'ollama', 401)]) {
      let n = 0;
      await fast().run(async () => { n++; throw failure; }, { canDisableReasoning: true }).catch(() => undefined);
      expect(n).toBe(1);
    }
  });

  it('an unreachable runtime is not retried here: the configured reroute owns that recovery', async () => {
    let n = 0;
    const error = await fast().run(async () => { n++; throw new ProviderConnectionError('down', 'ollama', 'x'); }, { canDisableReasoning: false }).catch(e => e);
    expect(n).toBe(1);
    expect((error as ProviderHealthError).problem).toBe('provider_unavailable');
  });

  it('cancellation is terminal: no retry, and nothing new starts once the signal is aborted', async () => {
    const controller = new AbortController();
    let n = 0;
    const error = await fast().run(async () => { n++; controller.abort(); throw timeout('transport:undici-headers'); }, { canDisableReasoning: true, signal: controller.signal }).catch(e => e);
    expect(n).toBe(1);
    expect((error as ProviderHealthError).problem).toBe('timeout');
    expect((error as ProviderHealthError).events.at(-1)?.step).toBe('stop');
    // Already cancelled before dispatch: the provider is still handed the aborted signal once (it owns abort handling,
    // as in M46) and its cancellation is terminal. A provider that ignores the signal still gets no second attempt.
    const pre = new AbortController(); pre.abort();
    let started = 0;
    const cancelled = await fast().run(async () => { started++; throw new ProviderCancelledError('c', 'ollama'); }, { canDisableReasoning: true, signal: pre.signal }).catch(e => e);
    expect(started).toBe(1);
    expect((cancelled as ProviderHealthError).problem).toBe('cancelled');
    let ignoredSignal = 0;
    const emptyIgnoring = await fast().run(async () => { ignoredSignal++; return text(''); }, { canDisableReasoning: true, signal: pre.signal }).catch(e => e);
    expect(ignoredSignal).toBe(1);
    expect((emptyIgnoring as ProviderHealthError).problem).toBe('empty_completion');
  });

  it('an empty completion is answered by reasoning off, once, and only when that is permitted', async () => {
    const modes: string[] = [];
    const result = await fast().run(async ({ reasoning }) => { modes.push(reasoning); return reasoning === 'disabled' ? text('{"a":1}') : text(''); }, { canDisableReasoning: true });
    expect(modes).toEqual(['default', 'disabled']);
    expect(describeProviderHealth(result.events)).toBe('provider_health:empty_completion>retry_reasoning_off,recovered');

    let n = 0;
    const stillEmpty = await fast().run(async () => { n++; return text(''); }, { canDisableReasoning: false });
    expect(n).toBe(1);
    expect(stillEmpty.response.message.content).toBe('');
  });
});

describe('failure classes', () => {
  it('keeps protocol, reasoning, provider, admission and policy apart', () => {
    expect(classifyFailureCause('format_failure')).toBe('contract_protocol_failure');
    expect(classifyFailureCause('validation_failure')).toBe('model_reasoning_failure');
    expect(classifyFailureCause('provider_failure')).toBe('provider_failure');
    expect(classifyFailureCause('policy_boundary')).toBe('policy_environment_failure');
    expect(classifyGovernedFailure('execution_rejected')).toBe('context_admission_failure');
    expect(classifyGovernedFailure('timeout')).toBe('provider_failure');
    expect(classifyGovernedFailure('invalid_model_response', 'empty_content')).toBe('contract_protocol_failure');
    expect(countsAsReasoningFailure(classifyFailureCause('format_failure'))).toBe(false);
    expect(countsAsReasoningFailure(classifyFailureCause('provider_failure'))).toBe(false);
    expect(countsAsReasoningFailure(classifyFailureCause('semantic_failure'))).toBe(true);
  });
});

function repositoryContext(files: Array<{ path: string; lines: number }>): string {
  let out = 'Selected repository content (bounded to 16000 characters):\nNo tools are available.\n';
  for (const file of files) {
    const body = Array.from({ length: file.lines }, (_, i) => (i === Math.floor(file.lines * 0.7) ? `export function applyDiscount(cart) { return cart.total; } // ${file.path}` : `const filler_${i} = ${i}; // ${file.path}`)).join('\n');
    out += `\n### ${file.path}\nCOMPLETE current file; sha256:abc\n\`\`\`\n${body}\n\`\`\`\n`;
  }
  return out;
}

describe('admission recompilation', () => {
  const profile = ModelProfileRegistry.resolve(UNKNOWN, 'ollama');
  const limit = resolveContextLimit({ model: UNKNOWN, profile, userOverride: 4096 });
  const planner = new ContextBudgetPlanner();
  const measure = (prompt: string) => planner.preflight({ messages: [{ role: 'user', content: prompt }], tools: [], profile, limit, maxOutputTokens: 600 });

  const fileNames = Array.from({ length: 60 }, (_, i) => `src/module${i}.ts (100 bytes)`);
  const promptFor = (context: string): string => buildCodingProposalPrompt('Fix applyDiscount so that a 10 percent coupon takes ten percent off the cart total', fileNames, context)
    + '\nThe previous planning-only response failed strict CodingProposal validation.\nSanitized validation codes: response_not_json';

  it('a request that fits is left byte-identical', () => {
    const prompt = promptFor(repositoryContext([{ path: 'src/cart.ts', lines: 10 }]));
    const result = recompileForAdmission(prompt, measure);
    expect(result.ok).toBe(true);
    expect(result.prompt).toBe(prompt);
    expect(result.steps).toHaveLength(0);
  });

  it('an oversized repository block is recompiled to fit, keeping contract, task, failure and the relevant lines', () => {
    const prompt = promptFor(repositoryContext([
      { path: 'src/cart.ts', lines: 400 },
      { path: 'src/other.ts', lines: 400 },
      { path: 'config/billing.js', lines: 400 },
    ]));
    expect(measure(prompt).ok).toBe(false);
    const result = recompileForAdmission(prompt, measure);
    expect(result.ok).toBe(true);
    expect(measure(result.prompt).ok).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    // Highest-value material is untouched.
    expect(result.prompt).toContain('You must output one JSON object only.');
    expect(result.prompt).toContain('Task: Fix applyDiscount so that a 10 percent coupon');
    expect(result.prompt).toContain('Sanitized validation codes: response_not_json');
    // The line naming the task's own identifier survives trimming of the first (most relevant) file.
    expect(result.prompt).toContain('export function applyDiscount(cart) { return cart.total; } // src/cart.ts');
    // A trimmed file is no longer claimed to be complete.
    expect(result.prompt).toContain('TRUNCATED current file; remainder omitted (reduced to fit the model context window)');
    expect(result.prompt).not.toContain('COMPLETE current file');
  });

  it('refuses only when the minimal request cannot fit', () => {
    const tiny = resolveContextLimit({ model: UNKNOWN, profile, userOverride: 900 });
    const tightMeasure = (p: string) => planner.preflight({ messages: [{ role: 'user', content: p }], tools: [], profile, limit: tiny, maxOutputTokens: 600 });
    const result = recompileForAdmission(promptFor(repositoryContext([{ path: 'src/cart.ts', lines: 300 }])), tightMeasure);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/minimal request/);
  });

  it('trimBody keeps head and the lines that mention the task', () => {
    const body = Array.from({ length: 200 }, (_, i) => (i === 150 ? 'function needle() {}' : `line ${i}`)).join('\n');
    const trimmed = trimBody(body, 300, ['needle']);
    expect(trimmed.length).toBeLessThan(600);
    expect(trimmed).toContain('line 0');
    expect(trimmed).toContain('function needle() {}');
    expect(trimmed).toContain('…');
  });
});

describe('governed dispatch integration', () => {
  afterEach(() => { RuntimeIntelligence.resetShared(); ModelProfileRegistry.clearObservedStructuredOutput(); });

  const request = (prompt: string) => ({
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId: 'r1', invocationId: 'i1', taskId: 't1', model: UNKNOWN, providerType: 'ollama' as const, prompt,
  });
  const dependency = (provider: InferenceProvider) => new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

  it('admits an oversized repair prompt by recompiling instead of rejecting it', async () => {
    const provider = new ScriptedProvider(() => text('{"ok":true}'));
    const prompt = buildCodingProposalPrompt('Fix applyDiscount', ['a.ts'], repositoryContext([{ path: 'src/big.ts', lines: 2500 }, { path: 'src/big2.ts', lines: 2500 }]));
    const outcome = await dependency(provider).execute(request(prompt));
    expect(outcome.completion).toBe('{"ok":true}');
    expect(provider.calls[0].messages[0].content.length).toBeLessThan(prompt.length);
    expect(outcome.contextEvidence.adaptation).toMatch(/^admission_recompile:fit:/);
    expect(provider.calls[0].messages[0].content).toContain('Task: Fix applyDiscount');
  });

  it('does not recompile when the kill switch is off', async () => {
    const previous = process.env.OLLAMA_AGENT_ADMISSION_RECOVERY;
    process.env.OLLAMA_AGENT_ADMISSION_RECOVERY = '0';
    try {
      const provider = new ScriptedProvider(() => text('{}'));
      const prompt = buildCodingProposalPrompt('Fix it', ['a.ts'], repositoryContext([{ path: 'src/big.ts', lines: 4000 }]));
      await expect(dependency(provider).execute(request(prompt))).rejects.toMatchObject({ failureCode: 'execution_rejected' });
      expect(provider.calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_AGENT_ADMISSION_RECOVERY; else process.env.OLLAMA_AGENT_ADMISSION_RECOVERY = previous;
    }
  });

  it('recovers from one provider timeout and records it apart from the model', async () => {
    const provider = new ScriptedProvider((_m, _t, _o, call) => (call === 1 ? timeout('transport:undici-headers') : text('{"a":1}')));
    const outcome = await dependency(provider).execute(request('hello'));
    expect(outcome.completion).toBe('{"a":1}');
    expect(provider.calls).toHaveLength(2);
    expect(outcome.contextEvidence.adaptation).toBe('provider_health:timeout>retry_same,recovered');
  });

  it('a persistent timeout keeps its existing failure code so routing still sees the same failure', async () => {
    const provider = new ScriptedProvider(() => timeout('transport:undici-body'));
    await expect(dependency(provider).execute(request('hello'))).rejects.toMatchObject({ failureCode: 'timeout', contextEvidence: { adaptation: 'provider_health:response_stall>retry_same,response_stall>stop' } });
    expect(provider.calls).toHaveLength(2);
  });

  it('keeps the M46 empty-completion adaptation text exactly', async () => {
    const provider = new ScriptedProvider((_m, _t, options) => (options.nativeThinking === false ? text('{"a":1}') : text('')));
    const outcome = await dependency(provider).execute(request('hello'));
    expect(outcome.contextEvidence.adaptation).toBe('disable_thinking:empty_completion');
  });

  it('uses the negotiated start: reasoning off and schema enforced before any failure', async () => {
    RuntimeIntelligence.configureShared({ enabled: true });
    const provider = new ScriptedProvider(thinkingScript);
    const outcome = await dependency(provider).execute({ ...request('hello'), responseFormat: { type: 'json_schema', name: 's', schema: { type: 'object' } } });
    expect(outcome.completion).toBe(PROBE_JSON);
    const real = provider.calls[provider.calls.length - 1].options;
    expect(real.nativeThinking).toBe(false);
    expect(real.responseFormat).toBeDefined();
    // No empty-completion retry was needed: the start was already right.
    expect(outcome.contextEvidence.adaptation).toBeUndefined();
  });
});
