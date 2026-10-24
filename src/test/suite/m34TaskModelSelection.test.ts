import { beforeEach, describe, expect, it } from 'vitest';
import { ModelCapabilityRegistry, type ModelCapability } from '../../models/ModelCapabilityRegistry';
import {
  TaskModelSelectionError,
  classifyTaskRequirements,
  selectTaskModel,
  type TaskModelCandidate,
} from '../../models/TaskModelSelection';
import type { ModelRole } from '../../providers/InferenceTypes';

function candidate(
  model: string,
  roles: readonly ModelRole[],
  options: Partial<Omit<TaskModelCandidate, 'provider' | 'model' | 'available' | 'capabilities' | 'configuredRoles'>> & {
    provider?: string;
    available?: boolean;
    capabilities?: ModelCapability;
  } = {},
): TaskModelCandidate {
  const provider = options.provider ?? 'ollama';
  return {
    provider,
    model,
    available: options.available ?? true,
    capabilities: options.capabilities
      ?? ModelCapabilityRegistry.getInstance().getCapabilities(model, provider),
    configuredRoles: roles,
    cost: options.cost,
    reliability: options.reliability,
  };
}

describe('M34 task model requirement classification', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());

  it('distinguishes a small read-only explanation from repository implementation', () => {
    const explanation = classifyTaskRequirements('Explain what dependency injection means.');
    expect(explanation).toMatchObject({
      readOnlyExplanation: true,
      repositoryExploration: false,
      toolCalling: false,
      fileMutation: false,
      codingComplexity: 'none',
      minimumContextWindow: 4096,
      vision: false,
      validationRepair: false,
    });
    expect(explanation.requiredCapabilities).toEqual(['chat', 'context-4096']);

    const implementation = classifyTaskRequirements(
      'Fix the race condition across multiple files and repair the failing tests.',
    );
    expect(implementation).toMatchObject({
      readOnlyExplanation: false,
      repositoryExploration: true,
      toolCalling: true,
      fileMutation: true,
      codingComplexity: 'high',
      minimumContextWindow: 32768,
      vision: false,
      validationRepair: true,
    });
    expect(implementation.requiredCapabilities).toEqual([
      'chat',
      'repository-exploration',
      'tool-calling',
      'file-mutation',
      'coding-high',
      'validation-repair',
      'context-32768',
    ]);
  });

  it('honors explicit context and vision evidence without a selector model call', () => {
    const requirements = classifyTaskRequirements('Inspect the attached screenshot and explain the failure.', {
      minimumContextWindow: 24_000,
    });
    expect(requirements.vision).toBe(true);
    expect(requirements.minimumContextWindow).toBe(24_000);
    expect(requirements.requiredCapabilities).toContain('vision');
    expect(requirements.requiredCapabilities).toContain('context-24000');
  });

  it('does not treat ordinary file creation as validation/repair work', () => {
    const creation = classifyTaskRequirements('Create foo.txt containing hello');
    expect(creation.fileMutation).toBe(true);
    expect(creation.validationRepair).toBe(false);

    const fix = classifyTaskRequirements('Fix the failing test in cache.ts');
    expect(fix.validationRepair).toBe(true);

    const debugRepair = classifyTaskRequirements('Debug and repair the broken parser');
    expect(debugRepair.validationRepair).toBe(true);
  });
});

describe('M34 capability-aware task model selection', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());

  it('automatic selection uses a technically viable candidate below the preferred reliability floor rather than failing closed (UNKNOWN != INCOMPATIBLE)', () => {
    const requirements = classifyTaskRequirements('Add validation and run the relevant tests.');
    const capabilities = { ...ModelCapabilityRegistry.getInstance().getCapabilities('compatible:27b', 'ollama'), contextWindow: 32_768 };
    const result = selectTaskModel({
      provider: 'ollama',
      requirements,
      candidates: [candidate('compatible:27b', ['agent', 'edit', 'reviewer'], { capabilities, reliability: 0.79 })],
    });

    // No hard incompatibility exists, so the candidate is technically viable —
    // it must be selected as the best available fallback, not rejected as
    // "no capable model", but the shortfall must remain observable.
    expect(result.selectedModel).toBe('compatible:27b');
    expect(result.overridden).toBe(false);
    expect(result.belowPreferredConfidence).toBe(true);
    expect(result.rejectedCandidates).toEqual([]);
    expect(result.diagnostics.join(' ')).toMatch(/Reliability 0\.79 is below required 0\.82/i);
  });

  it('honors an explicit hard-compatible model below the advisory reliability floor', () => {
    const requirements = classifyTaskRequirements('Add validation and run the relevant tests.');
    const capabilities = { ...ModelCapabilityRegistry.getInstance().getCapabilities('compatible:27b', 'ollama'), contextWindow: 32_768 };
    const result = selectTaskModel({
      provider: 'ollama',
      requirements,
      userOverride: { provider: 'ollama', model: 'compatible:27b' },
      candidates: [candidate('compatible:27b', ['agent', 'edit', 'reviewer'], { capabilities, reliability: 0.79 })],
    });

    expect(result.selectedModel).toBe('compatible:27b');
    expect(result.overridden).toBe(true);
    expect(result.diagnostics.join(' ')).toMatch(/advisory assessment.*reliability 0\.79 is below required 0\.82/i);
  });

  it.each([
    {
      label: 'required tools are unsupported',
      requirements: classifyTaskRequirements('Inspect this repository.', { toolCalling: true }),
      options: { capabilities: { ...ModelCapabilityRegistry.getInstance().getCapabilities('compatible:27b', 'ollama'), tools: false } },
      reason: /tool calling is required/i,
    },
    {
      label: 'required vision is unsupported',
      requirements: classifyTaskRequirements('Inspect the attached image.', { vision: true }),
      options: { capabilities: { ...ModelCapabilityRegistry.getInstance().getCapabilities('compatible:27b', 'ollama'), vision: false } },
      reason: /vision input is required/i,
    },
    {
      label: 'the model is unavailable',
      requirements: classifyTaskRequirements('Explain this code.'),
      options: { available: false },
      reason: /model is not available/i,
    },
    {
      label: 'the context requirement is impossible',
      requirements: classifyTaskRequirements('Inspect this repository.', { minimumContextWindow: 32_768 }),
      options: { capabilities: { ...ModelCapabilityRegistry.getInstance().getCapabilities('compatible:27b', 'ollama'), contextWindow: 8_192 } },
      reason: /context window 8192 is below required 32768/i,
    },
    {
      label: 'its configured role cannot mutate files',
      requirements: classifyTaskRequirements('Add validation to users.ts.'),
      roles: ['chat'] as const,
      options: {},
      reason: /file mutation requires an agent or edit role/i,
    },
  ])('rejects an explicit model when $label', ({ requirements, options, reason, roles }) => {
    expect(() => selectTaskModel({
      provider: 'ollama',
      requirements,
      userOverride: { provider: 'ollama', model: 'compatible:27b' },
      candidates: [candidate('compatible:27b', roles ?? ['agent', 'edit', 'reviewer'], { ...options, reliability: 1 })],
    })).toThrowError(expect.objectContaining({ code: 'override_incompatible', message: expect.stringMatching(reason) }));
  });

  it('selects by task fit among capable models rather than the merely cheapest configured model', () => {
    // The cheapest model must not win merely on cost: a model below the task's bar (the 7b here) is ranked
    // behind, and among models that clear it the choice is by coarse task-fit bucket, evidence, tool protocol,
    // residency and cost, never by comparing 0.93 with 0.98 (M50: no global reliability score). Both the 30b and
    // the 70b are `adequate` for this high-complexity bar, so the lighter one wins and the 70b stays available
    // as the stronger escalation option.
    const requirements = classifyTaskRequirements(
      'Fix the race condition across multiple files and repair the failing tests.',
    );
    const result = selectTaskModel({
      provider: 'ollama',
      requirements,
      candidates: [
        candidate('qwen2.5-coder:1.5b', ['autocomplete']),
        candidate('qwen2.5-coder:7b', ['agent', 'edit', 'reviewer'], { cost: 7, reliability: 0.83 }),
        candidate('qwen3-coder:30b', ['agent', 'edit', 'reviewer'], { cost: 30, reliability: 0.93 }),
        candidate('llama3.1:70b', ['agent', 'reviewer'], { cost: 70, reliability: 0.98 }),
      ],
    });

    expect(result.selectedProvider).toBe('ollama');
    expect(result.selectedModel).toBe('qwen3-coder:30b');
    expect(result.overridden).toBe(false);
    expect(result.suitabilitySummary).toBe('Using a stronger coding model suited to this task');
    expect(result.reason).toMatch(/best-fitting available model/i);
    expect(result.requiredCapabilities).toEqual(requirements.requiredCapabilities);
    expect(result.escalationCandidates.map(item => item.model)).toEqual(['llama3.1:70b']);
    expect(result.rejectedCandidates.find(item => item.model === 'qwen2.5-coder:1.5b')?.reasons)
      .toContain('Model is configured only for autocomplete or embedding.');
    expect(result.rejectedCandidates.find(item => item.model === 'qwen2.5-coder:7b')?.reasons[0])
      .toMatch(/reliability/i);
  });

  it('never crosses providers and explains unavailable, embedding, and role-only rejections', () => {
    const requirements = classifyTaskRequirements('Explain what dependency injection means.');
    const result = selectTaskModel({
      provider: 'ollama',
      requirements,
      candidates: [
        candidate('cloud-cheap', ['chat'], { provider: 'openai-compatible', cost: 1, reliability: 1 }),
        candidate('nomic-embed-text', ['embedding'], { cost: 1, reliability: 1 }),
        candidate('qwen3:8b', ['chat'], { available: false, cost: 8, reliability: 0.9 }),
        candidate('mistral:7b', ['chat'], { cost: 7, reliability: 0.7 }),
      ],
    });

    expect(result.selectedModel).toBe('mistral:7b');
    expect(result.diagnostics).toContain('Automatic selection stayed on the configured provider.');
    expect(result.rejectedCandidates.find(item => item.model === 'cloud-cheap')?.reasons)
      .toContain('Different provider; provider switching is not permitted.');
    expect(result.rejectedCandidates.find(item => item.model === 'nomic-embed-text')?.reasons)
      .toContain('Embedding-only models cannot run tasks.');
    expect(result.rejectedCandidates.find(item => item.model === 'qwen3:8b')?.reasons)
      .toContain('Model is not available.');
  });

  it('uses a deterministic lexical tie-break independent of candidate order', () => {
    const requirements = classifyTaskRequirements('Explain dependency injection.');
    const alpha = candidate('alpha:14b', ['chat'], { cost: 10, reliability: 0.9 });
    const beta = candidate('beta:14b', ['chat'], { cost: 10, reliability: 0.9 });

    expect(selectTaskModel({ provider: 'ollama', requirements, candidates: [beta, alpha] }).selectedModel)
      .toBe('alpha:14b');
    expect(selectTaskModel({ provider: 'ollama', requirements, candidates: [alpha, beta] }).selectedModel)
      .toBe('alpha:14b');
  });

  it('retains a same-provider user override and diagnoses suitability without silently falling back', () => {
    const requirements = classifyTaskRequirements(
      'Fix the race condition across multiple files and repair the failing tests.',
    );
    const result = selectTaskModel({
      provider: 'ollama',
      requirements,
      userOverride: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
      candidates: [
        candidate('qwen2.5-coder:7b', ['agent', 'edit', 'reviewer'], { cost: 7, reliability: 0.83 }),
        candidate('qwen3-coder:30b', ['agent', 'edit', 'reviewer'], { cost: 30, reliability: 0.93 }),
      ],
    });

    expect(result.selectedModel).toBe('qwen2.5-coder:7b');
    expect(result.overridden).toBe(true);
    expect(result.reason).toMatch(/explicit model override/i);
    expect(result.diagnostics.join(' ')).toMatch(/reliability 0\.83 is below required 0\.88/i);
    expect(result.escalationCandidates.map(item => item.model)).toEqual(['qwen3-coder:30b']);
  });

  it('fails closed for a cross-provider override and when no capable model exists', () => {
    const requirements = classifyTaskRequirements('Implement a validated repository change.');
    const models = [candidate('qwen2.5-coder:1.5b', ['autocomplete'])];

    expect(() => selectTaskModel({
      provider: 'ollama',
      requirements,
      candidates: models,
      userOverride: { provider: 'openai-compatible', model: 'cloud-model' },
    })).toThrowError(expect.objectContaining({ code: 'override_provider_mismatch' }));

    try {
      selectTaskModel({ provider: 'ollama', requirements, candidates: models });
      throw new Error('Expected model selection to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskModelSelectionError);
      expect(error).toMatchObject({ code: 'no_capable_model' });
      expect((error as TaskModelSelectionError).rejectedCandidates[0]?.reasons)
        .toContain('Model is configured only for autocomplete or embedding.');
    }
  });
});
