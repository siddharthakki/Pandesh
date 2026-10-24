import { describe, it, expect, beforeEach } from 'vitest';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { DEFAULTS } from '../../config/Defaults';

describe('ModelCapabilityRegistry — known models', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());

  it('returns full capability record for qwen3-coder:30b (agent model)', () => {
    const caps = ModelCapabilityRegistry.getInstance().getCapabilities('qwen3-coder:30b');
    expect(caps.chat).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(false);
    expect(caps.embeddings).toBe(false);
    expect(caps.embeddingOnly).toBe(false);
    expect(caps.streaming).toBe(true);
    expect(caps.contextWindow).toBeGreaterThan(0);
  });

  it('returns tools=false for the autocomplete-only model (qwen2.5-coder:1.5b)', () => {
    const caps = ModelCapabilityRegistry.getInstance().getCapabilities('qwen2.5-coder:1.5b');
    expect(caps.tools).toBe(false);
    expect(caps.allowedRoles).toEqual(['autocomplete']);
  });

  it('returns vision=true for the vision model (qwen2.5vl:7b)', () => {
    const caps = ModelCapabilityRegistry.getInstance().getCapabilities('qwen2.5vl:7b');
    expect(caps.vision).toBe(true);
    expect(caps.tools).toBe(false);
  });

  it('marks nomic-embed-text as embeddingOnly', () => {
    const caps = ModelCapabilityRegistry.getInstance().getCapabilities('nomic-embed-text');
    expect(caps.embeddingOnly).toBe(true);
    expect(caps.chat).toBe(false);
    expect(caps.tools).toBe(false);
  });

  it('returns tools=false for mistral:7b', () => {
    const caps = ModelCapabilityRegistry.getInstance().getCapabilities('mistral:7b');
    expect(caps.tools).toBe(false);
  });
});

describe('ModelCapabilityRegistry — heuristic detection for unknown models', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());

  it('detects embedding-only for names matching "embed" pattern', () => {
    const caps = ModelCapabilityRegistry.getInstance().getCapabilities('custom-embed-model:latest');
    expect(caps.embeddingOnly).toBe(true);
  });

  it('detects vision for llava-prefixed names', () => {
    const caps = ModelCapabilityRegistry.getInstance().getCapabilities('llava:13b');
    expect(caps.vision).toBe(true);
    expect(caps.tools).toBe(false);
  });

  it('defaults unknown chat models to tools=true (optimistic)', () => {
    const caps = ModelCapabilityRegistry.getInstance().getCapabilities('unknown-model:7b');
    expect(caps.tools).toBe(true);
    expect(caps.embeddingOnly).toBe(false);
  });
});

describe('ModelCapabilityRegistry — role enforcement', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());

  it('isAllowedForRole returns false for autocomplete model used as agent', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    expect(reg.isAllowedForRole('qwen2.5-coder:1.5b', 'agent')).toBe(false);
    expect(reg.isAllowedForRole('qwen2.5-coder:1.5b', 'autocomplete')).toBe(true);
  });

  it('isAllowedForRole returns false for embedding model in chat role', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    expect(reg.isAllowedForRole('nomic-embed-text', 'chat')).toBe(false);
    expect(reg.isAllowedForRole('nomic-embed-text', 'embedding')).toBe(true);
  });

  it('isAllowedForRole returns true for agent model in agent role', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    expect(reg.isAllowedForRole(DEFAULTS.agentModel, 'agent')).toBe(true);
  });

  it('isAllowedForRole returns true for unknown model in any non-embedding role', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    expect(reg.isAllowedForRole('some-unknown:7b', 'agent')).toBe(true);
    expect(reg.isAllowedForRole('some-unknown:7b', 'chat')).toBe(true);
  });
});

describe('ModelCapabilityRegistry — overrides', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());

  it('explicit override takes highest priority', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    reg.setOverride('qwen3-coder:30b', { tools: false });
    expect(reg.getCapabilities('qwen3-coder:30b').tools).toBe(false);
  });

  it('probe cache result is applied under override priority', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    reg.cacheProbeResult('qwen3-coder:30b', 'ollama', { contextWindow: 65536 });
    expect(reg.getCapabilities('qwen3-coder:30b', 'ollama').contextWindow).toBe(65536);
  });

  it('hasProbedResult reports whether a runtime probe is already cached, so callers can skip re-querying the provider', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    expect(reg.hasProbedResult('qwen3.8:32b', 'ollama')).toBe(false);
    reg.cacheProbeResult('qwen3.8:32b', 'ollama', { contextWindow: 262144 });
    expect(reg.hasProbedResult('qwen3.8:32b', 'ollama')).toBe(true);
    // Scoped by provider type — a probe cached for one provider is not
    // reported as cached for another.
    expect(reg.hasProbedResult('qwen3.8:32b', 'openai-compatible')).toBe(false);
  });
});

describe('ModelCapabilityRegistry — defaults are sane', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());

  it('default agent model supports tools', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    expect(reg.supportsTools(DEFAULTS.agentModel)).toBe(true);
  });

  it('default autocomplete model does not support tools', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    expect(reg.supportsTools(DEFAULTS.autocompleteModel)).toBe(false);
  });

  it('default embedding model is embedding-only', () => {
    const reg = ModelCapabilityRegistry.getInstance();
    expect(reg.isEmbeddingOnly(DEFAULTS.embeddingModel)).toBe(true);
  });

  it('default agent model is not autocomplete model', () => {
    expect(DEFAULTS.agentModel).not.toBe(DEFAULTS.autocompleteModel);
  });
});
