import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetConfig, _setConfig } from '../mocks/vscode';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { buildProductionTaskModelCandidates } from '../../models/ProductionModelCandidates';
import {
  NO_VISION_MODEL_MESSAGE,
  VISION_MINIMUM_CONTEXT,
  classifyTaskRequirements,
  selectTaskModel,
  type TaskRequirements,
} from '../../models/TaskModelSelection';
import { OLLAMA_VISION_MINIMUM_CONTEXT } from '../../reliability/ModelDispatchPlanner';
import type { InferenceProvider, ModelInfo, ChatMessage, ChatResponse, ToolDefinition, ProviderChatOptions } from '../../providers/ProviderTypes';

/**
 * Live repro (Baat Kar, Auto, Ollama, image + "count pandas in this image") was refused with "No available configured
 * model ... satisfies the task requirements" although `ollama show` reports `vision` for gemma4:12b and
 * muse-glimmer:latest. Root cause: the selector demanded a 32K window for ANY vision task while the candidates' windows
 * were measured WITHOUT the dispatch vision floor (8K conservative fallback for unprofiled models), so every
 * provider-declared vision model failed "Context window 8192 is below required 32768".
 *
 * These tests drive the production candidate builder with the real `/api/show` capability lists, not hand-built records.
 */

class ScriptedProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly models: ModelInfo[]) {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return this.models; }
  async getModelContextMetadata(model: string): Promise<ModelInfo | undefined> { return this.models.find(m => m.name === model); }
  async chat(_m: ChatMessage[], _t: ToolDefinition[], _o: ProviderChatOptions): Promise<ChatResponse> { throw new Error('not used'); }
  async *chatStream(): AsyncIterable<never> { throw new Error('not used'); }
}

const CODER: ModelInfo = { name: 'qwen3-coder:30b', declaredContextWindow: 262_144, metadata: { capabilities: ['completion', 'tools'] } };
const GEMMA: ModelInfo = { name: 'gemma4:12b', declaredContextWindow: 262_144, parameterCount: 11.9e9, metadata: { capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'] } };
const MUSE: ModelInfo = { name: 'muse-glimmer:latest', declaredContextWindow: 131_072, parameterCount: 27.9e9, metadata: { capabilities: ['completion', 'vision', 'tools', 'thinking'] } };

/** Same shape AgentPanel.taskRequirementsFor produces for Baat Kar with an image attached. */
function baatImageRequirements(prompt = 'count pandas in this image'): TaskRequirements {
  return classifyTaskRequirements(prompt, {
    repositoryExploration: false, toolCalling: false, fileMutation: false, validationRepair: false, codingComplexity: 'none', vision: true,
  });
}

async function candidatesFor(models: ModelInfo[], hasImages = true) {
  return buildProductionTaskModelCandidates({
    provider: new ScriptedProvider(models),
    providerType: 'ollama',
    availableModelNames: models.map(m => m.name),
    availableModels: models,
    hasImages,
  });
}

describe('Baat Kar + Auto + image routes to a provider-declared vision model', () => {
  beforeEach(() => { _resetConfig(); ModelCapabilityRegistry.resetInstance(); });

  it('"count pandas in this image" selects a vision model, never the text-only coder', async () => {
    const candidates = await candidatesFor([CODER, GEMMA, MUSE]);
    const selected = selectTaskModel({ provider: 'ollama', candidates, requirements: baatImageRequirements() });
    expect(['gemma4:12b', 'muse-glimmer:latest']).toContain(selected.selectedModel);
    expect(selected.overridden).toBe(false);
    expect(selected.requiredCapabilities).toContain('vision');
    expect(selected.suitabilitySummary).not.toMatch(/coding model/i);
  });

  it('still routes when role settings name only the text-only coder (vision models carry no configured role)', async () => {
    _setConfig('ollama-agent.chatModel', 'qwen3-coder:30b');
    const candidates = await candidatesFor([CODER, GEMMA, MUSE]);
    const selected = selectTaskModel({ provider: 'ollama', candidates, requirements: baatImageRequirements() });
    expect(['gemma4:12b', 'muse-glimmer:latest']).toContain(selected.selectedModel);
  });

  it('the image prompt does not need to match any "analyze/inspect ... image" keyword: the attachment alone requires vision', () => {
    expect(classifyTaskRequirements('count pandas in this image').vision).toBe(false); // prompt text alone is not evidence
    expect(baatImageRequirements().vision).toBe(true);
    expect(baatImageRequirements().minimumContextWindow).toBe(VISION_MINIMUM_CONTEXT);
  });

  it('a model unknown to every name table is chosen purely because the provider declares vision', async () => {
    const zeta: ModelInfo = { name: 'zeta-9b', declaredContextWindow: 65_536, metadata: { capabilities: ['completion', 'vision'] } };
    const selected = selectTaskModel({ provider: 'ollama', candidates: await candidatesFor([CODER, zeta]), requirements: baatImageRequirements() });
    expect(selected.selectedModel).toBe('zeta-9b');
  });

  it('provider capability evidence stays authoritative: a vision-LOOKING name without a declaration is refused', async () => {
    const llava: ModelInfo = { name: 'llava:7b', declaredContextWindow: 32_768, metadata: { capabilities: ['completion'] } };
    expect(ModelCapabilityRegistry.getInstance().getCapabilities('llava:7b', 'ollama').vision).toBe(true); // the heuristic would accept it
    let error: any;
    try { selectTaskModel({ provider: 'ollama', candidates: await candidatesFor([llava]), requirements: baatImageRequirements() }); } catch (e) { error = e; }
    expect(error?.code).toBe('no_capable_model');
    expect(error?.message).toContain(NO_VISION_MODEL_MESSAGE);
    expect(error?.rejectedCandidates?.[0]?.hardReasons.join(' ')).toMatch(/does not declare vision/i);
  });

  it('the selector floor equals the dispatch floor, so selection and dispatch cannot disagree again', () => {
    expect(VISION_MINIMUM_CONTEXT).toBe(OLLAMA_VISION_MINIMUM_CONTEXT);
  });
});

describe('refusals are explicit and truthful', () => {
  beforeEach(() => { _resetConfig(); ModelCapabilityRegistry.resetInstance(); });

  it('no vision-capable model installed: "No configured vision-capable model is available", not the generic refusal', async () => {
    let error: any;
    try { selectTaskModel({ provider: 'ollama', candidates: await candidatesFor([CODER]), requirements: baatImageRequirements() }); } catch (e) { error = e; }
    expect(error?.code).toBe('no_capable_model');
    expect(error.message).toContain(NO_VISION_MODEL_MESSAGE);
    expect(error.message).not.toMatch(/satisfies the task requirements/);
  });

  it('a vision model that exists but is refused for another reason is named, not reported as "no vision model"', async () => {
    const tiny: ModelInfo = { name: 'tiny-vl:2b', declaredContextWindow: 4_096, metadata: { capabilities: ['completion', 'vision'] } };
    const candidates = (await candidatesFor([tiny])).map(c => ({ ...c, capabilities: { ...c.capabilities, contextWindow: 4_096 } }));
    let error: any;
    try { selectTaskModel({ provider: 'ollama', candidates, requirements: baatImageRequirements() }); } catch (e) { error = e; }
    expect(error?.message).not.toContain(NO_VISION_MODEL_MESSAGE);
    expect(error?.message).toMatch(/tiny-vl:2b.*Context window 4096/);
  });

  it('Manual pin of a non-vision model is an explicit incompatibility, never a silent substitution', async () => {
    let error: any;
    try {
      selectTaskModel({
        provider: 'ollama',
        candidates: await candidatesFor([CODER, GEMMA]),
        requirements: baatImageRequirements(),
        userOverride: { provider: 'ollama', model: 'qwen3-coder:30b' },
      });
    } catch (e) { error = e; }
    expect(error?.code).toBe('override_incompatible');
    expect(error.message).toMatch(/Provider does not declare vision support/);
  });

  it('Manual pin of a provider-declared vision model is honoured', async () => {
    const selected = selectTaskModel({
      provider: 'ollama',
      candidates: await candidatesFor([CODER, GEMMA, MUSE]),
      requirements: baatImageRequirements(),
      userOverride: { provider: 'ollama', model: 'muse-glimmer:latest' },
    });
    expect(selected.selectedModel).toBe('muse-glimmer:latest');
    expect(selected.overridden).toBe(true);
  });
});

describe('status copy and wiring', () => {
  const root = path.resolve(__dirname, '../../..');

  it('an image task never reports "a coding model"', async () => {
    ModelCapabilityRegistry.resetInstance();
    for (const prompt of ['count pandas in this image', 'fix the bug in this screenshot', 'create a diagram like this photo']) {
      const requirements = classifyTaskRequirements(prompt, { vision: true });
      const selected = selectTaskModel({ provider: 'ollama', candidates: await candidatesFor([GEMMA]), requirements });
      expect(selected.suitabilitySummary).not.toMatch(/coding model/i);
    }
  });

  it('the production path passes the image flag into candidate building and clears stale status on a failed selection', () => {
    const panel = fs.readFileSync(path.join(root, 'src/ui/AgentPanel.ts'), 'utf8');
    expect(panel).toMatch(/hasImages: hasImageAttachment,/);
    expect(panel).toContain("type: 'modelSelectionFailed'");
    const webview = fs.readFileSync(path.join(root, 'media/chat-runtime-fixes.js'), 'utf8');
    expect(webview).toMatch(/message\.type === 'modelSelectionFailed' \|\| message\.type === 'newConversation'/);
  });

  it('the Ollama request carries the image bytes in the real `images` field (executor -> backend)', () => {
    const backend = fs.readFileSync(path.join(root, 'core/runtime/modelBackend.ts'), 'utf8');
    expect(backend).toMatch(/images: m\.images/);
  });
});
