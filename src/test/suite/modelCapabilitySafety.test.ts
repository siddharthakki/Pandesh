import { describe, expect, it } from 'vitest';
import { classifyTaskRequirements, isGenerativeModel, selectTaskModel, TaskModelSelectionError, type TaskModelCandidate } from '../../models/TaskModelSelection';
import type { ModelCapability } from '../../models/ModelCapabilityRegistry';
import { modelBadges, modelKindOf, parseLocalOllamaModels, searchModels, satisfiesRequirements } from '../../../core/platform/modelCatalog';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const palette = require('../../../media/model-palette.js') as { normalize: (e: Record<string, unknown>) => { kind: string; coding: unknown; badges: string[] }; search: (m: unknown[], q: unknown) => Array<{ modelId: string }> };

const cap = (over: Partial<ModelCapability> = {}): ModelCapability => ({
  model: 'x', chat: true, tools: true, vision: false, embeddings: false, structuredOutput: true, streaming: true,
  contextWindow: 32768, outputLimit: 0, embeddingOnly: false, allowedRoles: [], ...over,
});
const candidate = (model: string, over: Partial<TaskModelCandidate> = {}): TaskModelCandidate => ({
  provider: 'ollama', model, available: true, capabilities: cap({ model }), configuredRoles: [], ...over,
});
const codingTask = classifyTaskRequirements('create a file', { repositoryExploration: true, toolCalling: true, fileMutation: true, validationRepair: false, codingComplexity: 'low' });

describe('hard generative capability distinction', () => {
  const embed = ['qwen3-embedding:4b', 'Qwen3-Reranker-0.6B', 'nomic-embed-text', 'bge-m3', 'text-embedding-3-small'];
  for (const id of embed) {
    it(`${id} is not generative, not CODING, and not selectable`, () => {
      expect(modelKindOf(id)).not.toBe('generative');
      const [d] = parseLocalOllamaModels([{ name: id }]);
      expect(d.coding).toBe(false);
      expect(modelBadges(d)).not.toContain('CODING');
      expect(searchModels([d], { filters: ['coding'] })).toHaveLength(0);
      expect(satisfiesRequirements(d, {}).ok).toBe(false);
      const row = palette.normalize({ name: id });
      expect(row.kind).not.toBe('generative');
      expect(row.badges).not.toContain('CODING');
      expect(palette.search([row], { filters: ['coding'] })).toHaveLength(0);
    });
  }
  it('real generative models stay generative and Coding-filterable', () => {
    const [qwen, gemma, oss] = parseLocalOllamaModels([{ name: 'qwen3-coder:30b' }, { name: 'gemma3:12b' }, { name: 'gpt-oss:20b' }]);
    for (const d of [qwen, gemma, oss]) expect(d.kind).toBe('generative');
    expect(qwen.coding).toBe(true);
    expect(gemma.coding).not.toBe(true);
  });
  it('embedding and reranker models are rejected by the selector, even as an exact manual pick', () => {
    for (const model of ['qwen3-embedding:4b', 'qwen3-reranker:0.6b']) {
      const c = candidate(model, { capabilities: cap({ model, chat: false, embeddingOnly: true, allowedRoles: ['embedding'] }), configuredRoles: ['embedding'] });
      expect(isGenerativeModel(c.capabilities)).toBe(false);
      expect(() => selectTaskModel({ provider: 'ollama', requirements: codingTask, candidates: [c], userOverride: { provider: 'ollama', model } })).toThrow(TaskModelSelectionError);
    }
  });
});

describe('installed != appropriate; manual is exact', () => {
  it('an unassigned generative model (Gemma / gpt-oss) is accepted as an exact manual pick', () => {
    for (const model of ['gemma3:12b', 'gpt-oss:20b']) {
      const other = candidate('qwen3-coder:30b', { configuredRoles: ['agent', 'edit', 'chat', 'reviewer'] });
      const picked = selectTaskModel({ provider: 'ollama', requirements: codingTask, candidates: [other, candidate(model)], userOverride: { provider: 'ollama', model } });
      expect(picked.selectedModel).toBe(model);
      expect(picked.overridden).toBe(true);
      expect(picked.suitabilitySummary).not.toMatch(/suited to this task/);
    }
  });
  it('the same unassigned model is NOT drawn by Auto, and the reason is accurate', () => {
    const only = candidate('gemma3:12b');
    try {
      selectTaskModel({ provider: 'ollama', requirements: codingTask, candidates: [only] });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskModelSelectionError);
      expect(String((error as Error).message)).not.toMatch(/only for autocomplete or embedding/);
    }
  });
  it('a weak best-available Auto pick never claims it is "suited to this task"', () => {
    const weak = candidate('spark-x2.5-4b', { configuredRoles: ['agent', 'edit', 'chat', 'reviewer'], reliability: 0.2 });
    const picked = selectTaskModel({ provider: 'ollama', requirements: codingTask, candidates: [weak] });
    expect(picked.suitabilitySummary).not.toMatch(/suited to this task/);
    expect(picked.suitabilitySummary).toMatch(/not established|best available/);
  });
});
