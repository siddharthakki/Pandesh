import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { MockProvider } from '../mocks/MockProvider';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { classifyTaskRequirements, selectTaskModel, type TaskModelCandidate } from '../../models/TaskModelSelection';
import { resolveCandidateCapabilities } from '../../models/ProductionModelCandidates';
import { resolveModelContextLimit } from '../../reliability/ModelDispatchPlanner';

/**
 * M41: unknown/unlisted Ollama models must use measured runtime context
 * metadata — reused from the exact same production path
 * ModelDispatchPlanner.createSession uses (InferenceProvider.getModelContextMetadata)
 * — before TaskModelSelection decides eligibility, instead of being judged
 * solely against ModelCapabilityRegistry's conservative 8192 name-pattern
 * heuristic.
 */

// Deliberately NOT present in ModelCapabilityRegistry's static KNOWN table —
// exercises the name-pattern heuristic fallback (contextWindow 8192), not a
// hand-added registry entry.
const UNKNOWN_MODEL = 'qwen3.8:32b';
const KNOWN_MODEL = 'qwen3-coder:30b';
// Matches no ModelProfile either, so with no provider metadata both the gate
// and the dispatch truthfully fall through to the conservative 8K fallback.
const PROFILELESS_MODEL = 'acme-local-model:32b';

/** The window the real dispatch would use (ModelDispatchPlanner.createSession's own resolver). */
function dispatchWindow(model: string, providerType: 'ollama' | 'openai-compatible', userOverride?: number) {
  return resolveModelContextLimit({ model, providerType, userOverride });
}

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

describe('M41 runtime context metadata refines task-model selection', () => {
  let root: string;
  let provider: MockProvider;
  let panel: AgentPanel;

  beforeEach(async () => {
    vscodeMock._resetConfig();
    ModelCapabilityRegistry.resetInstance();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m41-'));
    provider = new MockProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const extensionRoot = process.cwd();
    const context = {
      secrets: secretStorage(),
      extensionUri: vscode.Uri.file(extensionRoot),
    } as unknown as vscode.ExtensionContext;
    panel = new AgentPanel(context, root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    ModelCapabilityRegistry.resetInstance();
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Best-effort temp cleanup on Windows.
    }
  });

  // ---------------------------------------------------------------------
  // A + B + C + cache reuse: AgentPanel.resolveCandidateCapabilities, the
  // helper that now backs selectModelForTask's TaskModelCandidate.capabilities.
  // ---------------------------------------------------------------------

  describe('resolveCandidateCapabilities', () => {
    // Now the ONE shared production helper (ProductionModelCandidates.ts) —
    // AgentPanel no longer has a private copy of this; OnboardingService
    // uses the exact same function.
    function resolve(model: string, providerType: 'ollama' = 'ollama') {
      const registry = ModelCapabilityRegistry.getInstance();
      return resolveCandidateCapabilities(provider, providerType, model, registry);
    }

    it('A: an unknown/unlisted model heuristically defaults to 8192, but a candidate built from measured provider metadata (262144) uses the measured value', async () => {
      // Lock in the premise: the static registry's name-pattern heuristic for
      // an unlisted model is exactly the conservative 8192 fallback.
      const heuristic = ModelCapabilityRegistry.getInstance().getCapabilities(UNKNOWN_MODEL, 'ollama');
      expect(heuristic.contextWindow).toBe(8192);

      provider.modelContextMetadata = { name: UNKNOWN_MODEL, contextWindow: 262_144 };
      const caps = await resolve(UNKNOWN_MODEL);
      expect(caps.contextWindow).toBe(262_144);
    });

    it('B: a failed provider probe invents nothing: the gate falls to the same non-provider tier the dispatch uses', async () => {
      vi.spyOn(provider, 'getModelContextMetadata').mockRejectedValue(new Error('ollama /api/show unreachable'));
      // qwen3.8:32b matches the qwen-general-local profile, whose operational
      // limit is what createSession would really send as num_ctx.
      const caps = await resolve(UNKNOWN_MODEL);
      expect(dispatchWindow(UNKNOWN_MODEL, 'ollama')).toMatchObject({ effectiveLimit: 32_768, provenance: 'profile_operational' });
      expect(caps.contextWindow).toBe(32_768);

      ModelCapabilityRegistry.resetInstance();
      const profileless = await resolve(PROFILELESS_MODEL);
      expect(dispatchWindow(PROFILELESS_MODEL, 'ollama')).toMatchObject({ effectiveLimit: 8192, provenance: 'profile_operational' });
      expect(profileless.contextWindow).toBe(8192);
    });

    it('C: a known model with no reported runtime metadata is gated at the window dispatch will actually use, not its declared table value', async () => {
      // provider.modelContextMetadata left undefined — MockProvider reports no metadata.
      // The capability table records a 40960 declared window, but createSession
      // sends the qwen-coder-local profile's operational 32768; gating on 40960
      // would admit tasks the real request cannot hold.
      const caps = await resolve(KNOWN_MODEL);
      expect(ModelCapabilityRegistry.getInstance().getCapabilities(KNOWN_MODEL, 'ollama').contextWindow).toBe(40_960);
      expect(caps.contextWindow).toBe(dispatchWindow(KNOWN_MODEL, 'ollama').effectiveLimit);
      expect(caps.contextWindow).toBe(32_768);
    });

    it('reuses a cached probe result instead of re-querying the provider', async () => {
      provider.modelContextMetadata = { name: UNKNOWN_MODEL, contextWindow: 262_144 };
      const spy = vi.spyOn(provider, 'getModelContextMetadata');

      const first = await resolve(UNKNOWN_MODEL);
      const second = await resolve(UNKNOWN_MODEL);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(first.contextWindow).toBe(262_144);
      expect(second.contextWindow).toBe(262_144);
    });
  });

  // ---------------------------------------------------------------------
  // Direct-cloud-primary baseline gap: OpenAICompatibleProvider.getModelContextMetadata()
  // structurally can never report a context length (OpenAI's /v1/models
  // response has no such field, unlike Ollama's /api/show) — see
  // OpenAICompatibleProvider.ts. Every unrecognized openai-compatible model
  // therefore stayed at the registry's conservative 8192 heuristic here,
  // even when the user explicitly configured a larger ollama-agent.contextWindow
  // — a real inconsistency with ModelDispatchPlanner.resolveContextLimit(),
  // which already treats that same setting as the top-priority userOverride
  // for the real request. This is the confirmed root cause a real OrcaRouter
  // baseline run hit live: an unrecognized cloud model (structuredOutput-capable,
  // tools:true via the default-allow heuristic) was hard-rejected on
  // "Context window 8192 is below required 16384" alone.
  describe('resolveCandidateCapabilities respects an explicit user context-window override', () => {
    function resolveWithOverride(model: string, userOverrideContextWindow?: number) {
      const registry = ModelCapabilityRegistry.getInstance();
      return resolveCandidateCapabilities(provider, 'openai-compatible', model, registry, undefined, userOverrideContextWindow);
    }

    it('raises an unrecognized model stuck at the 8192 heuristic default up to the explicit override', async () => {
      // provider.modelContextMetadata left undefined — matches
      // OpenAICompatibleProvider's real behavior for a provider whose
      // /v1/models response never carries a context length.
      const withoutOverride = await resolveWithOverride('openai/gpt-5.6-sol');
      expect(withoutOverride.contextWindow).toBe(8192);

      const withOverride = await resolveWithOverride('openai/gpt-5.6-sol', 16384);
      expect(withOverride.contextWindow).toBe(16384);
    });

    it('an explicit override below the measured window is authoritative, exactly as in dispatch', async () => {
      // resolveContextLimit makes an explicit setting the effective limit in
      // both directions, so every real request is budgeted at 16384. Gating
      // at 131072 would admit tasks the dispatch will not give that room.
      provider.modelContextMetadata = { name: 'openai/gpt-5.6-sol', contextWindow: 131072 };
      const caps = await resolveWithOverride('openai/gpt-5.6-sol', 16384);
      expect(caps.contextWindow).toBe(16384);
      expect(resolveModelContextLimit({
        model: 'openai/gpt-5.6-sol',
        providerType: 'openai-compatible',
        providerMetadata: { contextWindow: 131072 },
        userOverride: 16384,
      })).toMatchObject({ effectiveLimit: 16384, provenance: 'user_override' });
    });

    it('end-to-end: without the context fix, an unrecognized cloud model is hard-rejected even as an explicit override; with it, the SEPARATE, unrelated, advisory-only reliability floor no longer blocks plain automatic selection either (UNKNOWN != INCOMPATIBLE)', async () => {
      const registry = ModelCapabilityRegistry.getInstance();
      const requirements = classifyTaskRequirements('', {
        repositoryExploration: true, toolCalling: true, fileMutation: true,
        validationRepair: true, codingComplexity: 'medium',
      });
      const baseCandidate: TaskModelCandidate = {
        provider: 'openai-compatible',
        model: 'openai/gpt-5.6-sol',
        available: true,
        configuredRoles: ['chat', 'agent', 'edit', 'reviewer'],
        reliability: undefined,
        automaticSelectionExcluded: false,
        capabilities: await resolveCandidateCapabilities(provider, 'openai-compatible', 'openai/gpt-5.6-sol', registry),
      };
      // Before the fix: HARD-rejected (context window) — blocks even an
      // explicit per-turn override, exactly like a real composer model pick.
      expect(() => selectTaskModel({
        provider: 'openai-compatible',
        candidates: [baseCandidate],
        requirements,
        userOverride: { provider: 'openai-compatible', model: 'openai/gpt-5.6-sol' },
      })).toThrow(/override_incompatible|Context window/);

      const overriddenCandidate: TaskModelCandidate = {
        ...baseCandidate,
        capabilities: await resolveCandidateCapabilities(provider, 'openai-compatible', 'openai/gpt-5.6-sol', registry, undefined, 16384),
      };
      // With the context fix, no hard incompatibility remains, so the model
      // is technically viable — plain automatic selection (no explicit
      // override) now uses it as the best available candidate rather than
      // failing closed on the SEPARATE, unrelated, advisory-only reliability
      // floor. The floor still affects confidence/ranking (see
      // `belowPreferredConfidence` and `diagnostics`), it just no longer
      // masquerades as a capability gap — a real, by-design distinction
      // (TaskModelSelection.ts: "UNKNOWN != INCOMPATIBLE").
      const automatic = selectTaskModel({ provider: 'openai-compatible', candidates: [overriddenCandidate], requirements });
      expect(automatic.selectedModel).toBe('openai/gpt-5.6-sol');
      expect(automatic.belowPreferredConfidence).toBe(true);
      expect(automatic.diagnostics.join(' ')).toMatch(/below required/);
      // The explicit-override path a real composer model pick uses
      // (AgentPanel.selectModelForTask's userOverride) succeeds identically —
      // advisory reasons never block an override, before or after this fix.
      const result = selectTaskModel({
        provider: 'openai-compatible',
        candidates: [overriddenCandidate],
        requirements,
        userOverride: { provider: 'openai-compatible', model: 'openai/gpt-5.6-sol' },
      });
      expect(result.selectedModel).toBe('openai/gpt-5.6-sol');
    });
  });

  // ---------------------------------------------------------------------
  // D: the same refinement, proven at the TaskModelSelection layer for a
  // medium-complexity file mutation.
  // ---------------------------------------------------------------------

  describe('TaskModelSelection eligibility for a medium file mutation', () => {
    const GOAL = 'Update the parser module to handle a new token type.';

    function candidateFor(contextWindow: number): TaskModelCandidate {
      const registry = ModelCapabilityRegistry.getInstance();
      registry.cacheProbeResult(UNKNOWN_MODEL, 'ollama', { contextWindow });
      return {
        provider: 'ollama',
        model: UNKNOWN_MODEL,
        available: true,
        capabilities: registry.getCapabilities(UNKNOWN_MODEL, 'ollama'),
        configuredRoles: ['agent'],
      };
    }

    it('is rejected for context alone under the bare 8192 heuristic (pre-fix baseline)', () => {
      const requirements = classifyTaskRequirements(GOAL, { repositoryExploration: true, toolCalling: true });
      expect(requirements.codingComplexity).toBe('medium');
      expect(requirements.minimumContextWindow).toBe(16_384);

      const registry = ModelCapabilityRegistry.getInstance();
      const candidate: TaskModelCandidate = {
        provider: 'ollama',
        model: UNKNOWN_MODEL,
        available: true,
        capabilities: registry.getCapabilities(UNKNOWN_MODEL, 'ollama'), // unprobed: 8192
        configuredRoles: ['agent'],
      };

      expect(() => selectTaskModel({ provider: 'ollama', candidates: [candidate], requirements }))
        .toThrow(/no_capable_model|No available configured model/);

      try {
        selectTaskModel({ provider: 'ollama', candidates: [candidate], requirements });
      } catch (error) {
        const rejected = (error as { rejectedCandidates?: { reasons: string[] }[] }).rejectedCandidates ?? [];
        expect(rejected[0]?.reasons.join(' ')).toMatch(/Context window 8192 is below required 16384/);
      }
    });

    it('D: is NOT rejected once the candidate carries measured (262144) runtime context', () => {
      const requirements = classifyTaskRequirements(GOAL, { repositoryExploration: true, toolCalling: true });
      expect(requirements.minimumContextWindow).toBe(16_384);

      const candidate = candidateFor(262_144);
      const result = selectTaskModel({ provider: 'ollama', candidates: [candidate], requirements });

      expect(result.selectedModel).toBe(UNKNOWN_MODEL);
      expect(result.rejectedCandidates).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // End-to-end: selectModelForTask itself (not just the helper) refines the
  // TaskModelCandidate it builds for an unlisted model configured for a role.
  // ---------------------------------------------------------------------

  describe('selectModelForTask end-to-end', () => {
    const GOAL = 'Update the parser module to handle a new token type.';

    function selectModelForTask(goal: string) {
      return (panel as unknown as {
        selectModelForTask: (
          goal: string,
          mode: 'baat_kar' | 'saath_kar' | 'karke_dikha',
          modelOverride?: string,
          hasImageAttachment?: boolean,
        ) => Promise<{ candidates: { model: string; capable: boolean; rejectionReasons: string[] }[] }>;
      }).selectModelForTask(goal, 'saath_kar', undefined, false);
    }

    it('rejects the unlisted role-configured model for context alone before it has been probed', async () => {
      // A name no profile matches: with no runtime metadata, dispatch would
      // really run it at the 8K fallback, so the gate must reject it.
      const UNKNOWN_MODEL = PROFILELESS_MODEL;
      vscodeMock._setConfig('ollama-agent.agentModel', UNKNOWN_MODEL);
      // Only the unlisted model is reported available, so it is the only
      // candidate that can possibly be selected — isolating its own
      // rejection reason instead of a same-provider competitor's.
      vi.spyOn(provider, 'listModels').mockResolvedValue([{ name: UNKNOWN_MODEL }]);
      // No modelContextMetadata configured — MockProvider reports no runtime metadata.

      let caught: { rejectedCandidates?: { model: string; reasons: string[] }[] } | undefined;
      try {
        await selectModelForTask(GOAL);
      } catch (error) {
        caught = error as typeof caught;
      }
      expect(caught).toBeDefined();
      const entry = caught?.rejectedCandidates?.find(c => c.model === UNKNOWN_MODEL);
      expect(entry).toBeDefined();
      expect(entry?.reasons).toEqual(['Context window 8192 is below required 16384.']);
    });

    it('accepts the unlisted role-configured model once its measured runtime context is sufficient', async () => {
      vscodeMock._setConfig('ollama-agent.agentModel', UNKNOWN_MODEL);
      vi.spyOn(provider, 'listModels').mockResolvedValue([{ name: UNKNOWN_MODEL }]);
      provider.modelContextMetadata = { name: UNKNOWN_MODEL, contextWindow: 262_144 };

      const evidence = await selectModelForTask(GOAL);
      const entry = evidence.candidates.find(c => c.model === UNKNOWN_MODEL);
      expect(entry).toBeDefined();
      expect(entry?.capable).toBe(true);
      expect(entry?.rejectionReasons).toHaveLength(0);
    });
  });
});
