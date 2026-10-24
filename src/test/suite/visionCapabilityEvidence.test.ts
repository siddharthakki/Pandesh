import { beforeEach, describe, expect, it } from 'vitest';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { classifyTaskRequirements, selectTaskModel, type TaskModelCandidate } from '../../models/TaskModelSelection';
import type { ModelRole } from '../../providers/InferenceTypes';

const registry = () => ModelCapabilityRegistry.getInstance();

function candidate(model: string, providerCapabilities: readonly string[] | undefined, roles: readonly ModelRole[] = ['chat', 'agent', 'edit', 'reviewer']): TaskModelCandidate {
  return {
    provider: 'ollama', model, available: true,
    capabilities: { ...registry().getCapabilities(model, 'ollama'), contextWindow: 65_536 },
    configuredRoles: roles, reliability: 0.9,
    ...(providerCapabilities ? { providerCapabilities } : {}),
  };
}

describe('F3: vision routing follows provider-declared capability, never model names', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());
  const requirements = () => classifyTaskRequirements('What is shown here?', { vision: true });

  it('Auto chooses a model the provider DECLARES as vision-capable even though no name table knows it', () => {
    // "zeta-9b" matches no static vision prefix: only the provider declaration can make it eligible.
    expect(registry().getCapabilities('zeta-9b', 'ollama').vision).toBe(false);
    const result = selectTaskModel({
      provider: 'ollama',
      requirements: requirements(),
      candidates: [
        candidate('zeta-9b', ['completion', 'vision', 'tools']),
        candidate('plain-coder:7b', ['completion', 'tools']),
        candidate('nomic-embed-text', ['embedding'], ['embedding']),
      ],
    });
    expect(result.selectedModel).toBe('zeta-9b');
    expect(result.overridden).toBe(false);
  });

  it('a name that merely LOOKS like a vision model is refused when the provider declares no vision', () => {
    expect(registry().getCapabilities('llava:7b', 'ollama').vision).toBe(true); // the name heuristic would have accepted it
    let error: any;
    try {
      selectTaskModel({ provider: 'ollama', requirements: requirements(), candidates: [candidate('llava:7b', ['completion'], ['vision'])] });
    } catch (caught) { error = caught; }
    expect(error?.rejectedCandidates?.[0]?.hardReasons.join(' ')).toMatch(/does not declare vision/i);
  });

  it('Manual pin of a non-vision generative model is an explicit incompatibility, never a silent substitution', () => {
    let error: unknown;
    try {
      selectTaskModel({
        provider: 'ollama',
        requirements: requirements(),
        userOverride: { provider: 'ollama', model: 'plain-coder:7b' },
        candidates: [candidate('plain-coder:7b', ['completion', 'tools']), candidate('zeta-9b', ['completion', 'vision'])],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'override_incompatible', message: expect.stringMatching(/vision/i) });
  });

  it('embedding/reranker models are never vision-eligible, even if they declare vision', () => {
    expect(() => selectTaskModel({
      provider: 'ollama',
      requirements: requirements(),
      candidates: [candidate('emb-vis', ['embedding', 'vision'], ['embedding'])],
    })).toThrow();
  });

  it('with no provider declaration the static record still decides (support is never invented)', () => {
    expect(selectTaskModel({
      provider: 'ollama',
      requirements: requirements(),
      candidates: [candidate('llava:7b', undefined, ['vision']), candidate('plain-coder:7b', undefined)],
    }).selectedModel).toBe('llava:7b');
  });
});
