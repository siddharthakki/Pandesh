import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { _resetConfig, _setConfig } from '../mocks/vscode';
import { GovernedCodingExecutor, GovernedCodingExecutionRequest } from '../../coding/GovernedCodingExecutor';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { classifyExecutionProfile } from '../../orchestration/ExecutionProfile';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import {
  ChatMessage,
  ChatResponse,
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderConnectionError,
  ToolDefinition,
} from '../../providers/ProviderTypes';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { classifyTaskRequirements, selectTaskModel, TaskModelCandidate } from '../../models/TaskModelSelection';
import { decideCloudFallback, decideLoopLevelCloudEscalation } from '../../models/LocalFirstModelRouting';

/**
 * M42 product-level workflow coverage for automatic local-first model routing
 * and the bounded cloud fallback.
 *
 * Everything below runs through REAL production boundaries: the real
 * `GovernedCodingExecutor` lifecycle (readiness -> five-stage graph ->
 * proposal -> review -> approval -> mutation -> validation), the real
 * `LocalFirstModelDispatchRouter` it builds internally, the real
 * `ProviderGateway.resolveCloudFallback` consent gate reading real settings
 * and real SecretStorage, and real evidence/model-identity plumbing. Only the
 * two provider wire boundaries are faked: `ProviderGateway.create` supplies
 * the local provider, and `OpenAICompatibleProvider.prototype.chat` stands in
 * for the cloud endpoint's HTTP call.
 *
 * Because the cloud stand-in is the provider's own `chat` method, "cloud never
 * received repository/task context" is asserted directly: the spy records
 * every message that would have been transmitted.
 */

const LOCAL_MODEL = 'qwen3-coder:30b';
const WEAK_LOCAL_MODEL = 'qwen2.5-coder:1.5b';
const CLOUD_MODEL = 'gpt-4o-mini';
const CLOUD_BASE = 'https://cloud.example.invalid/v1';

// 'multi-file' + 'architecture' classify as high coding complexity, which is
// what authorizes the real five-stage graph (executionProfileAllowsFullGraph).
const GOAL = 'Fix the multi-file architecture bug in the marker validation so the real npm verify script passes.';

function proposalJson(operationType: 'create' | 'replace', content: string): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Repair marker.txt so validation passes',
    operations: [{ type: operationType, path: 'marker.txt', reason: 'routing test', content }],
    validationCommands: [{ kind: 'npm-script', script: 'verify' }],
    warnings: [],
    status: 'proposed',
  });
}

const GOOD_PROPOSAL = proposalJson('create', 'FIXED\n');

/** Local provider stand-in whose per-call behaviour is scripted by the test. */
class ScriptedLocalProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly prompts: string[] = [];
  constructor(private readonly behaviour: (callIndex: number) => 'ok' | 'connection_failure' | 'invalid_response') {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ name: LOCAL_MODEL, contextWindow: 40_960 }, { name: WEAK_LOCAL_MODEL, contextWindow: 8_192 }];
  }
  async getModelContextMetadata(model: string): Promise<ModelInfo | undefined> {
    return { name: model, contextWindow: model === WEAK_LOCAL_MODEL ? 8_192 : 40_960 };
  }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    const index = this.prompts.length;
    this.prompts.push(messages[0]?.content ?? '');
    const b = this.behaviour(index);
    if (b === 'connection_failure') {
      throw new ProviderConnectionError('Cannot connect to Ollama.', 'ollama', 'http://localhost:11434');
    }
    if (b === 'invalid_response') {
      return { message: { role: 'assistant', content: '' }, done: true };
    }
    return { message: { role: 'assistant', content: GOOD_PROPOSAL }, done: true };
  }
}

async function initGit(root: string): Promise<void> {
  for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '.'], ['commit', '-m', 'init']]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`))));
    });
  }
}

async function workspaceWithVerifyScript(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-routing-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.js' } }, null, 2));
  await fs.writeFile(
    path.join(root, 'check.js'),
    "const fs=require('fs');const c=fs.readFileSync('marker.txt','utf8');"
    + "if(!c.includes('FIXED')){console.error('marker not fixed');process.exit(1);}console.log('ok');",
  );
  await initGit(root);
  return root;
}

/** A SecretStorage that really holds the cloud fallback credential. */
function secretsWith(entries: Record<string, string>): GovernedCodingExecutionRequest['secrets'] {
  return {
    get: async (key: string) => entries[key],
    store: async (key: string, value: string) => { entries[key] = value; },
    delete: async (key: string) => { delete entries[key]; },
    onDidChange: () => ({ dispose: () => undefined }),
  } as never;
}

interface RunOptions {
  root: string;
  automaticModelSelection: boolean;
  signal?: AbortSignal;
  cloudKey?: string;
  cloudFallbackPermitted?: boolean;
  callbacks?: Partial<GovernedCodingExecutionRequest['callbacks']>;
}

function baseRequest(options: RunOptions): GovernedCodingExecutionRequest {
  const { root } = options;
  return {
    runId: 'routing-test-1',
    goal: GOAL,
    workspaceRoot: root,
    signal: options.signal ?? new AbortController().signal,
    secrets: secretsWith(options.cloudKey ? { 'ollama-agent.cloudFallbackApiKey': options.cloudKey } : {}),
    auditSource: 'test',
    extensionBuild: 'test-build',
    model: LOCAL_MODEL,
    automaticModelSelection: options.automaticModelSelection,
    executionProfile: classifyExecutionProfile(GOAL),
    maxValidationRepairCycles: 0,
    cloudFallbackPermitted: options.cloudFallbackPermitted,
    callbacks: {
      checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
      reviewProposal: async () => true,
      approveExecution: async () => true,
      confirmElevated: async () => true,
      ...options.callbacks,
    },
  };
}

/** Enables the explicit cloud-fallback consent policy plus its configuration. */
function enableCloudFallbackPolicy(): void {
  // This endpoint is not in the provider catalog, so its model is UNKNOWN-cost: the suite opts in to paid cloud.
  _setConfig('ollama-agent.cloudSpendMode', 'UNRESTRICTED');
  _setConfig('ollama-agent.modelRoutingPolicy', 'local-first-cloud-fallback');
  _setConfig('ollama-agent.cloudFallbackApiBase', CLOUD_BASE);
  _setConfig('ollama-agent.cloudFallbackModel', CLOUD_MODEL);
}

describe('M42 local-first model routing with bounded cloud fallback', () => {
  let root: string;
  let cloudChat: ReturnType<typeof vi.spyOn>;
  const cloudCalls: ChatMessage[][] = [];

  beforeEach(async () => {
    _resetConfig();
    cloudCalls.length = 0;
    root = await workspaceWithVerifyScript();
    // The cloud wire boundary. Every call recorded here is repository/task
    // context that would really have left the machine.
    cloudChat = vi.spyOn(OpenAICompatibleProvider.prototype, 'chat').mockImplementation(
      async (messages: ChatMessage[]) => {
        cloudCalls.push(messages);
        return { message: { role: 'assistant', content: GOOD_PROPOSAL }, done: true } as ChatResponse;
      },
    ) as never;
    vi.spyOn(OpenAICompatibleProvider.prototype, 'getModelContextMetadata').mockResolvedValue({
      name: CLOUD_MODEL,
      contextWindow: 128_000,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetConfig();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // -------------------------------------------------------------------------
  // A. LOCAL SUCCESS
  // -------------------------------------------------------------------------

  it('A1: automatic selection ranks two configured local models and picks the compatible one', () => {
    const registry = ModelCapabilityRegistry.getInstance();
    const candidates: TaskModelCandidate[] = [LOCAL_MODEL, WEAK_LOCAL_MODEL].map(model => ({
      provider: 'ollama',
      model,
      available: true,
      capabilities: registry.getCapabilities(model, 'ollama'),
      configuredRoles: model === WEAK_LOCAL_MODEL ? ['autocomplete', 'agent'] : ['agent'],
    }));
    const requirements = classifyTaskRequirements(GOAL, {
      repositoryExploration: true,
      toolCalling: true,
      fileMutation: true,
      validationRepair: true,
      codingComplexity: 'high',
    });

    const selected = selectTaskModel({ provider: 'ollama', candidates, requirements });

    expect(selected.selectedProvider).toBe('ollama');
    expect(selected.selectedModel).toBe(LOCAL_MODEL);
    expect(selected.overridden).toBe(false);
    // The small model is hard-rejected on capability, not merely outranked:
    // its capability record permits only the autocomplete role, and it has
    // neither tool calling nor a large enough context for this task.
    const rejected = selected.rejectedCandidates.find(item => item.model === WEAK_LOCAL_MODEL);
    expect(rejected).toBeDefined();
    expect(rejected?.reasons.join(' ')).toContain('Tool calling is required.');
    expect(rejected?.reasons.join(' ')).toContain('Context window');
  });

  it('A2: when the local model succeeds, the cloud provider is never called and evidence records the local model', async () => {
    // Cloud fallback is fully permitted and configured — proving cloud is
    // skipped because local SUCCEEDED, not because it was unavailable.
    enableCloudFallbackPolicy();
    const local = new ScriptedLocalProvider(() => 'ok');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);

    const result = await new GovernedCodingExecutor().execute(
      baseRequest({ root, automaticModelSelection: true, cloudKey: 'sk-test' }),
    );

    expect(result.status).toBe('completed');
    expect(cloudCalls).toHaveLength(0);
    expect(cloudChat).not.toHaveBeenCalled();
    for (const stage of result.graph?.stages ?? []) {
      expect(stage.model).toBe(LOCAL_MODEL);
      expect(stage.providerType).toBe('ollama');
      expect(stage.evidence.modelEvidence.routing?.fallbackUsed).toBe(false);
      expect(stage.evidence.modelEvidence.routing?.executedModel).toBe(LOCAL_MODEL);
    }
    expect(await fs.readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('FIXED\n');
  });

  // -------------------------------------------------------------------------
  // B. LOCAL RECOVERABLE FAILURE -> CLOUD FALLBACK
  // -------------------------------------------------------------------------

  it('B: a recoverable local provider failure falls back to the permitted cloud model once and the same governed lifecycle completes', async () => {
    enableCloudFallbackPolicy();
    // Only the first local dispatch fails; the fallback covers that stage and
    // the remaining stages run locally again.
    const local = new ScriptedLocalProvider(index => (index === 0 ? 'connection_failure' : 'ok'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);
    const progress: string[] = [];
    const evidence: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];

    const result = await new GovernedCodingExecutor().execute(baseRequest({
      root,
      automaticModelSelection: true,
      cloudKey: 'sk-test',
      callbacks: {
        onProgress: phase => progress.push(phase),
        onEvidence: async item => { evidence.push(item); },
      },
    }));

    // Same governed lifecycle: proposal -> review -> approval -> mutation -> validation.
    expect(result.status).toBe('completed');
    expect(await fs.readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('FIXED\n');

    // Exactly one cloud execution.
    expect(cloudCalls).toHaveLength(1);

    // Truthful identity: the fallback stage reports the CLOUD model/provider,
    // never the local one it was routed away from.
    const stages = result.graph?.stages ?? [];
    const fallbackStage = stages.find(stage => stage.evidence.modelEvidence.routing?.fallbackUsed === true);
    expect(fallbackStage).toBeDefined();
    expect(fallbackStage?.model).toBe(CLOUD_MODEL);
    expect(fallbackStage?.providerType).toBe('openai-compatible');

    const routing = fallbackStage?.evidence.modelEvidence.routing;
    expect(routing?.selection).toBe('automatic');
    expect(routing?.attemptedModel).toBe(LOCAL_MODEL);
    expect(routing?.executedModel).toBe(CLOUD_MODEL);
    expect(routing?.executedProviderType).toBe('openai-compatible');
    expect(routing?.fallbackDecision).toBe('used');
    // Sanitized failure information only — no provider exception text.
    expect(routing?.localFailureCode).toBe('provider_failure');
    expect(routing?.localFailureReason).toBe('The governed model provider failed during execution.');

    expect(progress.some(phase => phase.startsWith('model_routing_fallback'))).toBe(true);
    const fallbackEvidence = evidence.find(item => item.eventType === 'model_routing_fallback');
    expect(fallbackEvidence?.metadata.attemptedModel).toBe(LOCAL_MODEL);
    expect(fallbackEvidence?.metadata.executedModel).toBe(CLOUD_MODEL);
    expect(fallbackEvidence?.metadata.localFailureCode).toBe('provider_failure');

    // Later stages returned to the local model — fallback is per-failure, not sticky.
    expect(stages.filter(stage => stage.model === LOCAL_MODEL).length).toBeGreaterThan(0);
  });

  it('B2: local model invalid response with cloud permitted executes permitted fallback with truthful identity and event details', async () => {
    enableCloudFallbackPolicy();
    // M46/M47: an empty completion is first retried locally as an identical request. A single bad reply followed by a
    // good one therefore never reaches the cloud; the permitted fallback applies once the retry fails too. So the
    // first stage's two local attempts (original + retry) are both empty, and later calls succeed.
    const local = new ScriptedLocalProvider(index => (index < 2 ? 'invalid_response' : 'ok'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);
    const progress: string[] = [];
    const evidence: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];

    const result = await new GovernedCodingExecutor().execute(baseRequest({
      root,
      automaticModelSelection: true,
      cloudKey: 'sk-test',
      cloudFallbackPermitted: true,
      callbacks: {
        onProgress: phase => progress.push(phase),
        onEvidence: async item => { evidence.push(item); },
      },
    }));

    // 1. Permitted fallback may occur and completes
    expect(result.status).toBe('completed');
    expect(cloudCalls).toHaveLength(1);

    // 2. Fallback stage has correct provider identity and model
    const stages = result.graph?.stages ?? [];
    const fallbackStage = stages.find(stage => stage.evidence.modelEvidence.routing?.fallbackUsed === true);
    expect(fallbackStage).toBeDefined();
    expect(fallbackStage?.model).toBe(CLOUD_MODEL);
    expect(fallbackStage?.providerType).toBe('openai-compatible');

    // 3. Routing evidence has correct source model, destination model, provider, and reason
    const routing = fallbackStage?.evidence.modelEvidence.routing;
    expect(routing?.attemptedModel).toBe(LOCAL_MODEL);
    expect(routing?.executedModel).toBe(CLOUD_MODEL);
    expect(routing?.executedProviderType).toBe('openai-compatible');
    expect(routing?.executedProviderType).not.toBe('unknown');
    expect(routing?.localFailureCode).toBe('invalid_model_response');
    expect(routing?.fallbackDecision).toBe('used');

    // 4. Progress event and evidence event report correct provider, source, destination, and reason
    const progressEvent = progress.find(phase => phase.startsWith('model_routing_fallback'));
    expect(progressEvent).toBeDefined();
    expect(progressEvent).toContain(`from=${LOCAL_MODEL}`);
    expect(progressEvent).toContain(`to=${CLOUD_MODEL}`);
    expect(progressEvent).toContain('provider=openai-compatible');
    expect(progressEvent).not.toContain('provider=unknown');
    expect(progressEvent).toContain('reason=invalid_model_response');

    const fallbackEvidence = evidence.find(item => item.eventType === 'model_routing_fallback');
    expect(fallbackEvidence).toBeDefined();
    expect(fallbackEvidence?.metadata.attemptedModel).toBe(LOCAL_MODEL);
    expect(fallbackEvidence?.metadata.executedModel).toBe(CLOUD_MODEL);
    expect(fallbackEvidence?.metadata.executedProviderType).toBe('openai-compatible');
    expect(fallbackEvidence?.metadata.executedProviderType).not.toBe('unknown');
    expect(fallbackEvidence?.metadata.localFailureCode).toBe('invalid_model_response');
  });

  it('B3: a single empty local reply is recovered by the local retry and never sends context to the permitted cloud endpoint', async () => {
    enableCloudFallbackPolicy();
    const local = new ScriptedLocalProvider(index => (index === 0 ? 'invalid_response' : 'ok'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);

    const result = await new GovernedCodingExecutor().execute(baseRequest({
      root,
      automaticModelSelection: true,
      cloudKey: 'sk-test',
      cloudFallbackPermitted: true,
    }));

    expect(result.status).toBe('completed');
    expect(cloudCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // C. CLOUD FALLBACK DISABLED
  // -------------------------------------------------------------------------

  it('C: with the routing policy left local-only, the same local failure never reaches the configured cloud endpoint', async () => {
    // Endpoint, model and credential are all present; only consent is absent.
    _setConfig('ollama-agent.cloudFallbackApiBase', CLOUD_BASE);
    _setConfig('ollama-agent.cloudFallbackModel', CLOUD_MODEL);
    const local = new ScriptedLocalProvider(() => 'connection_failure');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);

    const result = await new GovernedCodingExecutor().execute(
      baseRequest({ root, automaticModelSelection: true, cloudKey: 'sk-test' }),
    );

    // No repository/task context left the machine.
    expect(cloudCalls).toHaveLength(0);
    expect(cloudChat).not.toHaveBeenCalled();

    // Truthful blocked outcome, not a fabricated success.
    expect(result.status).toBe('graph_incomplete');
    expect(result.graph?.failureCode).toBe('provider_failure');
    const routing = result.graph?.stages[0]?.evidence.modelEvidence.routing;
    expect(routing?.fallbackUsed).toBe(false);
    expect(routing?.fallbackDecision).toBe('cloud_fallback_not_permitted');
    await expect(fs.readFile(path.join(root, 'marker.txt'), 'utf8')).rejects.toThrow();
  });

  it('C3: KARKEDIKHA_MODEL_ROUTING_POLICY=local-only pins routing even when workspace policy allows cloud', async () => {
    const previous = process.env.KARKEDIKHA_MODEL_ROUTING_POLICY;
    process.env.KARKEDIKHA_MODEL_ROUTING_POLICY = 'local-only';
    try {
      enableCloudFallbackPolicy();
      const local = new ScriptedLocalProvider(() => 'connection_failure');
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);
      const result = await new GovernedCodingExecutor().execute(
        baseRequest({ root, automaticModelSelection: true, cloudKey: 'sk-test' }),
      );
      expect(cloudCalls).toHaveLength(0);
      expect(cloudChat).not.toHaveBeenCalled();
      expect(result.graph?.stages[0]?.evidence.modelEvidence.routing?.fallbackDecision)
        .toBe('cloud_fallback_not_permitted');
    } finally {
      if (previous === undefined) delete process.env.KARKEDIKHA_MODEL_ROUTING_POLICY;
      else process.env.KARKEDIKHA_MODEL_ROUTING_POLICY = previous;
    }
  });

  it('C4: local model invalid response with cloud NOT permitted never calls cloud provider', async () => {
    _setConfig('ollama-agent.cloudFallbackApiBase', CLOUD_BASE);
    _setConfig('ollama-agent.cloudFallbackModel', CLOUD_MODEL);
    const local = new ScriptedLocalProvider(() => 'invalid_response');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);

    const result = await new GovernedCodingExecutor().execute(
      baseRequest({ root, automaticModelSelection: true, cloudKey: 'sk-test', cloudFallbackPermitted: false }),
    );

    // Local model failed with invalid response + cloud NOT permitted -> NO cloud call
    expect(cloudCalls).toHaveLength(0);
    expect(cloudChat).not.toHaveBeenCalled();
    expect(result.status).toBe('graph_incomplete');
    expect(result.graph?.failureCode).toBe('invalid_model_response');
    const routing = result.graph?.stages[0]?.evidence.modelEvidence.routing;
    expect(routing?.fallbackUsed).toBe(false);
    expect(routing?.fallbackDecision).toBe('cloud_fallback_not_permitted');
    await expect(fs.readFile(path.join(root, 'marker.txt'), 'utf8')).rejects.toThrow();
  });

  it('C2: the consent gate itself fails closed on policy, endpoint, model and credential independently', async () => {
    const secrets = secretsWith({ 'ollama-agent.cloudFallbackApiKey': 'sk-test' });

    expect((await ProviderGateway.resolveCloudFallback(secrets)).reason).toBe('policy_local_only');

    _setConfig('ollama-agent.modelRoutingPolicy', 'local-first-cloud-fallback');
    _setConfig('ollama-agent.cloudSpendMode', 'UNRESTRICTED');
    expect((await ProviderGateway.resolveCloudFallback(secrets)).reason).toBe('endpoint_not_configured');

    _setConfig('ollama-agent.cloudFallbackApiBase', CLOUD_BASE);
    expect((await ProviderGateway.resolveCloudFallback(secrets)).reason).toBe('model_not_configured');

    _setConfig('ollama-agent.cloudFallbackModel', CLOUD_MODEL);
    expect((await ProviderGateway.resolveCloudFallback(secretsWith({}))).reason).toBe('credential_missing');

    // Hard spend gate: with the default FREE_ONLY policy an endpoint/model that is not known to be free is refused.
    _setConfig('ollama-agent.cloudSpendMode', 'FREE_ONLY');
    expect((await ProviderGateway.resolveCloudFallback(secrets)).reason).toBe('spend_policy_blocks');
    _setConfig('ollama-agent.cloudSpendMode', 'UNRESTRICTED');

    const resolved = await ProviderGateway.resolveCloudFallback(secrets);
    expect(resolved.available).toBe(true);
    expect(resolved.model).toBe(CLOUD_MODEL);
    expect(resolved.providerType).toBe('openai-compatible');
    // Resolving a route must not itself transmit anything.
    expect(cloudChat).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // D. EXPLICIT MODEL OVERRIDE
  // -------------------------------------------------------------------------

  it('D: an explicitly overridden model is never silently replaced, even when cloud fallback is fully permitted', async () => {
    enableCloudFallbackPolicy();
    const local = new ScriptedLocalProvider(() => 'connection_failure');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);

    const result = await new GovernedCodingExecutor().execute(
      baseRequest({ root, automaticModelSelection: false, cloudKey: 'sk-test' }),
    );

    expect(cloudCalls).toHaveLength(0);
    expect(result.status).toBe('graph_incomplete');
    const routing = result.graph?.stages[0]?.evidence.modelEvidence.routing;
    expect(routing?.selection).toBe('explicit_override');
    expect(routing?.fallbackDecision).toBe('explicit_model_override');
    expect(routing?.executedModel).toBe(LOCAL_MODEL);
  });

  // -------------------------------------------------------------------------
  // E. NON-FALLBACK FAILURES
  // -------------------------------------------------------------------------

  it('E1: user cancellation never routes to cloud', async () => {
    enableCloudFallbackPolicy();
    const controller = new AbortController();
    const local = new ScriptedLocalProvider(() => 'ok');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);
    controller.abort();

    const result = await new GovernedCodingExecutor().execute(baseRequest({
      root,
      automaticModelSelection: true,
      cloudKey: 'sk-test',
      signal: controller.signal,
    }));

    expect(cloudCalls).toHaveLength(0);
    expect(['cancelled', 'graph_incomplete', 'readiness_blocked']).toContain(result.status);
  });

  it('E2: a rejected proposal ends the task without any cloud call', async () => {
    enableCloudFallbackPolicy();
    const local = new ScriptedLocalProvider(() => 'ok');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);

    const result = await new GovernedCodingExecutor().execute(baseRequest({
      root,
      automaticModelSelection: true,
      cloudKey: 'sk-test',
      callbacks: { reviewProposal: async () => false },
    }));

    expect(result.status).toBe('proposal_rejected');
    expect(cloudCalls).toHaveLength(0);
    await expect(fs.readFile(path.join(root, 'marker.txt'), 'utf8')).rejects.toThrow();
  });

  it('E3: the routing policy classifies governance/user outcomes as non-fallback', () => {
    const base = {
      automaticSelection: true,
      fallbackAlreadyAttempted: false,
      cloudFallbackPermittedAndConfigured: true,
    } as const;
    expect(decideCloudFallback({ ...base, localStatus: 'completed' })).toBe('local_succeeded');
    expect(decideCloudFallback({ ...base, localStatus: 'cancelled', localFailureCode: 'cancelled' })).toBe('failure_not_recoverable');
    expect(decideCloudFallback({ ...base, localStatus: 'failed', localFailureCode: 'execution_rejected' })).toBe('failure_not_recoverable');
    expect(decideCloudFallback({ ...base, localStatus: 'failed', localFailureCode: 'timeout' })).toBe('used');
    expect(decideCloudFallback({ ...base, localStatus: 'failed', localFailureCode: 'provider_failure', automaticSelection: false })).toBe('explicit_model_override');
    expect(decideCloudFallback({ ...base, localStatus: 'failed', localFailureCode: 'provider_failure', fallbackAlreadyAttempted: true })).toBe('already_attempted');
    expect(decideCloudFallback({ ...base, localStatus: 'failed', localFailureCode: 'provider_failure', cloudFallbackPermittedAndConfigured: false })).toBe('cloud_fallback_not_permitted');
  });

  it('E4: loop-level cloud recovery may run for an explicit local primary after exhausted investigation or persistent unusable output', () => {
    const permitted = {
      fallbackAlreadyAttempted: false,
      cloudFallbackPermittedAndConfigured: true,
    } as const;
    expect(decideLoopLevelCloudEscalation({ ...permitted, reason: 'investigation_exhausted' })).toBe('loop_level_used');
    expect(decideLoopLevelCloudEscalation({ ...permitted, reason: 'persistent_unusable_output' })).toBe('loop_level_used');
    expect(decideLoopLevelCloudEscalation({
      ...permitted,
      reason: 'investigation_exhausted',
      localFailureCode: 'cancelled',
    })).toBe('failure_not_recoverable');
    expect(decideLoopLevelCloudEscalation({
      ...permitted,
      reason: 'persistent_unusable_output',
      localFailureCode: 'execution_rejected',
    })).toBe('failure_not_recoverable');
    expect(decideLoopLevelCloudEscalation({
      ...permitted,
      reason: 'investigation_exhausted',
      fallbackAlreadyAttempted: true,
    })).toBe('already_attempted');
    expect(decideLoopLevelCloudEscalation({
      reason: 'investigation_exhausted',
      fallbackAlreadyAttempted: false,
      cloudFallbackPermittedAndConfigured: false,
    })).toBe('cloud_fallback_not_permitted');
    // Per-call policy is unchanged: explicit override still blocks ordinary fallback.
    expect(decideCloudFallback({
      automaticSelection: false,
      fallbackAlreadyAttempted: false,
      cloudFallbackPermittedAndConfigured: true,
      localStatus: 'failed',
      localFailureCode: 'provider_failure',
    })).toBe('explicit_model_override');
  });

  // -------------------------------------------------------------------------
  // F. LOOP BOUND
  // -------------------------------------------------------------------------

  it('F: a task gets exactly one cloud fallback — a second local failure is not routed again', async () => {
    enableCloudFallbackPolicy();
    // Stage 1 fails locally (fallback #1 covers it), stage 2 also fails
    // locally. There must be no second fallback and no third model.
    const local = new ScriptedLocalProvider(index => (index === 0 || index === 1 ? 'connection_failure' : 'ok'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(local);
    const progress: string[] = [];

    const result = await new GovernedCodingExecutor().execute(baseRequest({
      root,
      automaticModelSelection: true,
      cloudKey: 'sk-test',
      callbacks: { onProgress: phase => progress.push(phase) },
    }));

    expect(cloudCalls).toHaveLength(1);
    expect(progress.filter(phase => phase.startsWith('model_routing_fallback'))).toHaveLength(1);

    // Truthful terminal state — the second local failure is reported as-is.
    expect(result.status).toBe('graph_incomplete');
    expect(result.graph?.failureCode).toBe('provider_failure');
    const stages = result.graph?.stages ?? [];
    expect(stages[0]?.model).toBe(CLOUD_MODEL);
    const failed = stages[stages.length - 1];
    expect(failed?.status).toBe('failed');
    expect(failed?.model).toBe(LOCAL_MODEL);
    expect(failed?.evidence.modelEvidence.routing?.fallbackDecision).toBe('already_attempted');
    await expect(fs.readFile(path.join(root, 'marker.txt'), 'utf8')).rejects.toThrow();
  });
});
