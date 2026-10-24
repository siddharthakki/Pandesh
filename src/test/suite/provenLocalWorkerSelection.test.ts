import { describe, expect, it } from 'vitest';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import {
  classifyTaskRequirements,
  selectTaskModel,
  TaskModelCandidate,
  TaskModelSelectionError,
} from '../../models/TaskModelSelection';

/**
 * Focused coverage for the two live-proven local coding workers.
 *
 * These tests never lower a reliability floor and never relax a hard
 * capability: every case below runs the real `classifyTaskRequirements` +
 * `selectTaskModel` at the exact requirement shape `AgentPanel` builds for a
 * Karke Dikha coding turn (repository exploration, tool calling, file
 * mutation and validation repair all required), so the reliability bar is the
 * production one — `max(complexityFloor, 0.82)` for any validation-repair
 * task, i.e. 0.82 for low/medium and 0.88 for high.
 */

const DEVSTRAL = 'devstral-small-2:latest';
const QWEN38_MTP = 'qwen3.8:27b-mtp-q4_K_M';
/**
 * Other coding-capable models actually installed on the acceptance machine.
 * None has passed governed Karke acceptance, so none may inherit anything from
 * the two proven entries — not by quantization, not by family, not by alias.
 */
const UNPROVEN_INSTALLED = [
  'qwen3.8:27b-q4_K_M',
  'qwen3.6:27b',
  'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
  'orcarouter/Qwen3.8-27B-Uncensored:Q4_K_M',
] as const;
/** A real installed model with no acceptance evidence and no known-table entry. */
const UNKNOWN_LOCAL = 'laguna-xs-2.1:latest';

const GOAL = 'Fix the multi-file architecture bug in the marker validation so the real npm verify script passes.';

/** Exactly the requirement shape AgentPanel builds for a Karke Dikha turn. */
function karkeRequirements(codingComplexity: 'low' | 'medium' | 'high') {
  return classifyTaskRequirements(GOAL, {
    repositoryExploration: true,
    toolCalling: true,
    fileMutation: true,
    validationRepair: true,
    codingComplexity,
  });
}

/** Builds candidates exactly as AgentPanel does, including observed reliability. */
function candidatesFor(models: readonly string[], contextWindows: Record<string, number> = {}): TaskModelCandidate[] {
  const registry = ModelCapabilityRegistry.getInstance();
  return models.map(model => {
    const capabilities = registry.getCapabilities(model, 'ollama');
    const measured = contextWindows[model];
    return {
      provider: 'ollama',
      model,
      available: true,
      capabilities: measured ? { ...capabilities, contextWindow: measured } : capabilities,
      configuredRoles: ['agent'],
      reliability: registry.getObservedReliability(model),
      automaticSelectionExcluded: registry.isAutomaticSelectionExcluded(model),
    };
  });
}

describe('proven local coding worker selection', () => {
  it('records truthful measured capabilities for both proven workers', () => {
    const registry = ModelCapabilityRegistry.getInstance();
    for (const model of [DEVSTRAL, QWEN38_MTP]) {
      const caps = registry.getCapabilities(model, 'ollama');
      expect(caps.chat).toBe(true);
      expect(caps.tools).toBe(true);
      expect(caps.structuredOutput).toBe(true);
      expect(caps.vision).toBe(false);
      expect(caps.embeddingOnly).toBe(false);
      expect(caps.allowedRoles).toContain('agent');
    }
    // Declared context lengths read from the provider's own model metadata.
    expect(registry.getCapabilities(DEVSTRAL, 'ollama').contextWindow).toBe(393_216);
    expect(registry.getCapabilities(QWEN38_MTP, 'ollama').contextWindow).toBe(262_144);
  });

  it('excludes only Devstral from automatic selection on this machine', () => {
    const registry = ModelCapabilityRegistry.getInstance();
    expect(registry.isAutomaticSelectionExcluded(DEVSTRAL)).toBe(true);
    expect(registry.isAutomaticSelectionExcluded(QWEN38_MTP)).toBe(false);
  });

  // Devstral is excluded from AUTOMATIC selection on this machine (see
  // ModelCapabilityRegistry.AUTOMATIC_SELECTION_EXCLUDED, 2026-09-08): real
  // Hands-off dogfood evidence plus compareAutomaticPreference's cost-first
  // tie-break (24.0B < 27.3B) meant the smaller, less-reliable-by-measurement
  // model kept winning automatically over qwen3.8:27b-mtp-q4_K_M despite its
  // materially higher observed reliability (0.84 vs 0.88). The exclusion is
  // advisory only — an explicit override still works (test 6 below).
  it('1: a low-complexity coding task automatically selects the non-excluded proven worker', () => {
    const selected = selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([DEVSTRAL, QWEN38_MTP]),
      requirements: karkeRequirements('low'),
    });
    expect(selected.selectedModel).toBe(QWEN38_MTP);
    expect(selected.overridden).toBe(false);
    const rejectedDevstral = selected.rejectedCandidates.find(item => item.model === DEVSTRAL);
    expect(rejectedDevstral?.reasons.join(' ')).toContain('Automatic selection is disabled for this model on this machine');
  });

  it('2: a medium-complexity coding task automatically selects the non-excluded proven worker', () => {
    const selected = selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([DEVSTRAL, QWEN38_MTP]),
      requirements: karkeRequirements('medium'),
    });
    expect(selected.selectedModel).toBe(QWEN38_MTP);
    const rejectedDevstral = selected.rejectedCandidates.find(item => item.model === DEVSTRAL);
    expect(rejectedDevstral?.reasons.join(' ')).toContain('Automatic selection is disabled for this model on this machine');
  });

  it('2b: the non-excluded proven worker alone still satisfies the medium bar; Devstral alone no longer clears automatic selection', () => {
    const qwenAlone = selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([QWEN38_MTP]),
      requirements: karkeRequirements('medium'),
    });
    expect(qwenAlone.selectedModel).toBe(QWEN38_MTP);

    expect(() => selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([DEVSTRAL]),
      requirements: karkeRequirements('medium'),
    })).toThrow(TaskModelSelectionError);
  });

  it('3: the high bar is met only by the worker whose evidence supports it', () => {
    const selected = selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([DEVSTRAL, QWEN38_MTP]),
      requirements: karkeRequirements('high'),
    });
    // Every hard capability of both workers satisfies a high-complexity task
    // (tools, no vision requirement, context far above the 32K minimum, agent
    // role). The differentiator is observed reliability: 0.88 clears the high
    // floor, 0.84 does not — the floor itself is untouched.
    expect(selected.selectedModel).toBe(QWEN38_MTP);
    const rejected = selected.rejectedCandidates.find(item => item.model === DEVSTRAL);
    expect(rejected?.reasons.join(' ')).toContain('Reliability 0.84 is below required 0.88.');
  });

  it('4: no other installed model inherits proven-worker EVIDENCE — it stays a below-preferred-confidence fallback, never a hard failure or a promoted proven pick', () => {
    const registry = ModelCapabilityRegistry.getInstance();
    expect(registry.getObservedReliability(QWEN38_MTP)).toBe(0.88);
    expect(registry.getObservedReliability(DEVSTRAL)).toBe(0.84);

    const provenCaps = registry.getCapabilities(QWEN38_MTP, 'ollama');
    for (const model of [...UNPROVEN_INSTALLED, UNKNOWN_LOCAL]) {
      // Observed reliability is exact-name only — nothing inherits it.
      expect(registry.getObservedReliability(model)).toBeUndefined();
      // The automatic-selection exclusion is exact-name only too — a sibling
      // quantization of Devstral must not inherit it.
      expect(registry.isAutomaticSelectionExcluded(model)).toBe(false);

      // Capabilities are exact-name only too: a sibling quantization, another
      // family version, an HF alias and a derivative must all keep the generic
      // heuristic record rather than the proven model's measured one.
      const caps = registry.getCapabilities(model, 'ollama');
      expect(caps.contextWindow).not.toBe(provenCaps.contextWindow);
      expect(caps.allowedRoles).toEqual([]);

      // None of them is technically INCOMPATIBLE (no hard capability gap,
      // and this test hands each one the same generous measured context
      // window) — so alone, each is still technically viable and automatic
      // selection uses it as the best available fallback (UNKNOWN !=
      // INCOMPATIBLE). What it must never get is proven-worker-level
      // confidence: the selection stays explicitly below the preferred
      // reliability threshold, and 4b below proves a genuinely proven
      // worker is still preferred over it when one is configured too.
      const alone = selectTaskModel({
        provider: 'ollama',
        candidates: candidatesFor([model], { [model]: 262_144 }),
        requirements: karkeRequirements('medium'),
      });
      expect(alone.selectedModel).toBe(model);
      expect(alone.belowPreferredConfidence).toBe(true);
      expect(alone.diagnostics.join(' ')).toMatch(/below required/);
    }
  });

  it('4b: a proven worker still wins over every unproven installed candidate', () => {
    const selected = selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor(
        [DEVSTRAL, QWEN38_MTP, ...UNPROVEN_INSTALLED, UNKNOWN_LOCAL],
        Object.fromEntries([...UNPROVEN_INSTALLED, UNKNOWN_LOCAL].map(model => [model, 262_144])),
      ),
      requirements: karkeRequirements('high'),
    });
    expect(selected.selectedModel).toBe(QWEN38_MTP);
    for (const model of [...UNPROVEN_INSTALLED, UNKNOWN_LOCAL]) {
      expect(selected.rejectedCandidates.some(item => item.model === model)).toBe(true);
    }
  });

  it('5: hard capability mismatch still rejects a proven worker', () => {
    // Neither proven worker has vision; a vision task must still fail closed.
    expect(() => selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([DEVSTRAL, QWEN38_MTP]),
      requirements: classifyTaskRequirements(GOAL, {
        repositoryExploration: true,
        toolCalling: true,
        fileMutation: true,
        validationRepair: true,
        codingComplexity: 'medium',
        vision: true,
      }),
    })).toThrow(TaskModelSelectionError);

    // An unavailable model is still rejected regardless of observed reliability.
    const offline = candidatesFor([QWEN38_MTP]).map(candidate => ({ ...candidate, available: false }));
    expect(() => selectTaskModel({
      provider: 'ollama',
      candidates: offline,
      requirements: karkeRequirements('medium'),
    })).toThrow(TaskModelSelectionError);

    // A context window below the high-task minimum is still a hard rejection.
    const tiny = candidatesFor([QWEN38_MTP]).map(candidate => ({
      ...candidate,
      capabilities: { ...candidate.capabilities, contextWindow: 4_096 },
    }));
    expect(() => selectTaskModel({
      provider: 'ollama',
      candidates: tiny,
      requirements: karkeRequirements('high'),
    })).toThrow(TaskModelSelectionError);
  });

  it('6: explicit override semantics are unchanged for these models', () => {
    // An override below the advisory bar is still retained, with the advisory
    // recorded as a diagnostic rather than a replacement.
    const overridden = selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([DEVSTRAL, QWEN38_MTP]),
      requirements: karkeRequirements('high'),
      userOverride: { provider: 'ollama', model: DEVSTRAL },
    });
    expect(overridden.selectedModel).toBe(DEVSTRAL);
    expect(overridden.overridden).toBe(true);
    expect(overridden.diagnostics.join(' ')).toContain('Explicit override retained');
    // The automatic-selection exclusion is advisory, exactly like the
    // reliability shortfall it's reported alongside — an explicit override
    // still bypasses it.
    expect(overridden.diagnostics.join(' ')).toContain('Automatic selection is disabled for this model on this machine');

    // A hard-incompatible override still fails closed.
    expect(() => selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([DEVSTRAL, QWEN38_MTP]),
      requirements: classifyTaskRequirements(GOAL, {
        repositoryExploration: true,
        toolCalling: true,
        fileMutation: true,
        validationRepair: true,
        codingComplexity: 'medium',
        vision: true,
      }),
      userOverride: { provider: 'ollama', model: QWEN38_MTP },
    })).toThrow(TaskModelSelectionError);

    // Cross-provider overrides remain forbidden.
    expect(() => selectTaskModel({
      provider: 'ollama',
      candidates: candidatesFor([QWEN38_MTP]),
      requirements: karkeRequirements('medium'),
      userOverride: { provider: 'openai-compatible', model: QWEN38_MTP },
    })).toThrow(TaskModelSelectionError);
  });
});
