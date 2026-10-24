import { beforeEach, describe, expect, it } from 'vitest';
import { chooseVisionModel, clearVisionCapabilityCache, fetchOllamaVisionModels, visionSelectionEvidence, type VisionFetch } from '../src/host/desktopVision';

const caps: Record<string, string[]> = {
  'lfm:24b': ['tools', 'thinking', 'completion'],
  'gemma4:12b': ['completion', 'vision', 'audio', 'tools'],
  'qwen3-coder:swift-27b': ['tools', 'thinking', 'completion', 'vision'],
  'clef-flash:latest': ['decision', 'vision'], // sees images but cannot chat
};

function fakeFetch(calls: string[] = []): VisionFetch {
  return async (_url, init) => {
    const model = String(JSON.parse(String(init?.body)).model);
    calls.push(model);
    if (model === 'boom') throw new Error('network');
    return { ok: model in caps, json: async () => ({ capabilities: caps[model] }) };
  };
}

beforeEach(() => clearVisionCapabilityCache());

describe('vision model discovery', () => {
  it('keeps only installed models that can both chat and see, in installed order', async () => {
    const found = await fetchOllamaVisionModels('http://x', ['lfm:24b', 'gemma4:12b', 'clef-flash:latest', 'qwen3-coder:swift-27b', 'boom', 'missing'], fakeFetch());
    expect(found).toEqual(['gemma4:12b', 'qwen3-coder:swift-27b']);
  });

  it('caches capability lookups per model', async () => {
    const calls: string[] = [];
    await fetchOllamaVisionModels('http://x', ['gemma4:12b'], fakeFetch(calls));
    await fetchOllamaVisionModels('http://x', ['gemma4:12b'], fakeFetch(calls));
    expect(calls).toEqual(['gemma4:12b']);
  });
});

describe('choosing the model for an image', () => {
  const vision = ['gemma4:12b', 'qwen3-coder:swift-27b'];
  it('keeps the user\'s own model when it can already see', () => {
    expect(chooseVisionModel({ selectedModel: 'gemma4:12b', isAuto: false, visionModels: vision })).toMatchObject({ model: 'gemma4:12b', differsFromSelection: false });
  });
  it('switches a text-only selection to a vision model and says so', () => {
    const choice = chooseVisionModel({ selectedModel: 'lfm:24b', isAuto: false, visionModels: vision })!;
    expect(choice.model).toBe('gemma4:12b');
    expect(choice.differsFromSelection).toBe(true);
    expect(choice.reason).toContain("can't see images");
  });
  it('Auto picks a vision model without calling it an override', () => {
    expect(chooseVisionModel({ selectedModel: 'auto', isAuto: true, visionModels: vision })).toMatchObject({ differsFromSelection: false });
  });
  it('returns null when nothing installed can see images (the caller must say so, not guess)', () => {
    expect(chooseVisionModel({ selectedModel: 'lfm:24b', isAuto: false, visionModels: [] })).toBeNull();
  });
});

describe('frozen selection evidence', () => {
  it('sets the vision flag Core requires and matches the chosen model', () => {
    const ev = visionSelectionEvidence({ mode: 'baat_kar', model: 'gemma4:12b', reason: 'because', userOverrode: false });
    expect(ev.requiredCapabilities.vision).toBe(true);
    expect(ev).toMatchObject({ selectedProvider: 'ollama', selectedModel: 'gemma4:12b', selectionReason: 'because', userOverrode: false });
    expect(visionSelectionEvidence({ mode: 'karke_dikha', model: 'm', reason: 'r', userOverrode: true }).requiredCapabilities.fileModification).toBe(true);
  });
});
