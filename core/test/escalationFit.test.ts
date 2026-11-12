/**
 * Owner test of Build 166 (2026-11-12): "Write a haiku" escalated as an unbuilt file; escalation chose 27B models that
 * do not fit the 24 GB RTX 3090 (one turn took 20 minutes, the loaded model then blocked the next turns); "what's on my
 * screen" escalated to a model that cannot see; qwen2.5vl:7b was sent tools it cannot use.
 */
import { describe, expect, it } from 'vitest';
import { asksToMakeSomething } from '../runtime/makeIntent';
import { estimateKvCacheBytes, estimateModelBytes, gpuBudgetBytes } from '../runtime/ollamaModelInfo';
import { needsSight, planEscalation, type InstalledModel } from '../runtime/escalation';

const GiB = 2 ** 30;

/** model_info from Ollama /api/show on the owner's PC (only the keys the estimate reads). */
const QWEN38 = { 'general.architecture': 'qwen35', 'qwen35.block_count': 65, 'qwen35.attention.head_count': 24, 'qwen35.attention.head_count_kv': 4, 'qwen35.embedding_length': 5120, 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256 };
const GEMMA26 = {
  'general.architecture': 'gemma4', 'gemma4.block_count': 30, 'gemma4.attention.head_count': 16, 'gemma4.embedding_length': 2816,
  'gemma4.attention.head_count_kv': [8, 8, 8, 8, 8, 2, 8, 8, 8, 8, 8, 2, 8, 8, 8, 8, 8, 2, 8, 8, 8, 8, 8, 2, 8, 8, 8, 8, 8, 2],
  'gemma4.attention.key_length': 512, 'gemma4.attention.value_length': 512, 'gemma4.attention.sliding_window': 1024,
};
const GPTOSS = { 'general.architecture': 'gpt-oss', 'gpt-oss.block_count': 24, 'gpt-oss.attention.head_count': 64, 'gpt-oss.attention.head_count_kv': 8, 'gpt-oss.embedding_length': 2880, 'gpt-oss.attention.key_length': 64, 'gpt-oss.attention.value_length': 64, 'gpt-oss.attention.sliding_window': 128 };

describe('asksToMakeSomething', () => {
  it('a text written in the reply is not something to build', () => {
    for (const t of ['Write a haiku about autumn in Ulm.', 'Write a short poem for my mother', 'Draft an email to the landlord about the heating', 'Make a joke about Mondays', 'write me a summary of this article'])
      expect(asksToMakeSomething(t), t).toBe(false);
  });
  it('anything that must exist outside the chat still is', () => {
    for (const t of ['Write a haiku and save it to haiku.txt', 'Build a widget that shows the weather', 'make an image of chicken biryani', 'Create a task: renew my passport', 'Write a python script that renames my photos', 'Read every file and write a one-line summary of each into summary.md', 'Draft an email in Gmail to Anna'])
      expect(asksToMakeSomething(t), t).toBe(true);
  });
  it('no making verb, no build', () => {
    expect(asksToMakeSomething('What is the weather in Ulm?')).toBe(false);
  });
});

describe('GPU memory estimate at 32K context', () => {
  it('matches what Ollama really loaded on the owner\'s PC', () => {
    // qwen3.8:27b-mtp: 16.5 GiB file, loaded as 24 GiB (26% on the CPU).
    expect(estimateModelBytes(16.5 * GiB, QWEN38, 32768)! / GiB).toBeGreaterThan(23);
    // gemma4:26b: sliding-window layers keep only 1024 tokens; it fits.
    const gemmaKv = estimateKvCacheBytes(GEMMA26, 32768)!;
    expect(gemmaKv / GiB).toBeLessThan(1.5);
    expect(estimateModelBytes(14.6 * GiB, GEMMA26, 32768)! / GiB).toBeLessThan(18);
    expect(estimateModelBytes(12.8 * GiB, GPTOSS, 32768)! / GiB).toBeLessThan(16);
  });
  it('an unknown shape falls back to a margin on the file size; no file size means unknown', () => {
    expect(estimateModelBytes(10 * GiB, {}, 32768)! / GiB).toBeCloseTo(13.5, 1);
    expect(estimateModelBytes(undefined, QWEN38, 32768)).toBeUndefined();
  });
  it('the budget keeps 1.5 GiB for the desktop; no GPU means no limit', () => {
    expect(gpuBudgetBytes(24576)! / GiB).toBeCloseTo(22.5, 1);
    expect(gpuBudgetBytes(undefined)).toBeUndefined();
  });
});

describe('planEscalation with the GPU budget', () => {
  const installed: InstalledModel[] = [
    { name: 'gemma4:12b', paramsB: 11.9, capabilities: ['completion', 'vision', 'tools'], estimatedBytes: 9.2 * GiB },
    { name: 'qwen2.5vl:7b', paramsB: 8.3, capabilities: ['completion', 'vision'], estimatedBytes: 8.3 * GiB },
    { name: 'gpt-oss:20b', paramsB: 20.9, capabilities: ['completion', 'tools', 'thinking'], estimatedBytes: 14.6 * GiB },
    { name: 'gemma4:26b-a4b-it-qat', paramsB: 25.2, capabilities: ['completion', 'vision', 'tools'], estimatedBytes: 16.6 * GiB },
    { name: 'qwen3.8:27b-mtp-q4_K_M', paramsB: 27.3, capabilities: ['completion', 'vision', 'tools'], estimatedBytes: 25.6 * GiB },
    { name: 'qwen3-coder:swift-27b', paramsB: 27.3, capabilities: ['completion', 'vision', 'tools'], estimatedBytes: 26.8 * GiB },
  ];
  const budget = gpuBudgetBytes(24576);
  const base = { installed, needsTools: true, needsVision: false, escalationsSoFar: 0, requestText: 'Build a widget', gpuBudgetBytes: budget };

  it('skips the 27B models that do not fit and takes the strongest one that does', () => {
    expect(planEscalation({ ...base, usedModels: ['gemma4:12b'] })).toMatchObject({ kind: 'escalate', model: 'gemma4:26b-a4b-it-qat' });
  });
  it('after the strongest fitting model, it says the bigger ones do not fit instead of loading them', () => {
    const plan = planEscalation({ ...base, usedModels: ['gemma4:26b-a4b-it-qat'] });
    expect(plan).toMatchObject({ kind: 'exhausted' });
    expect(plan.kind === 'exhausted' && plan.reason).toMatch(/do not fit in its graphics memory/);
  });
  it('without a known GPU it behaves as before', () => {
    expect(planEscalation({ ...base, gpuBudgetBytes: undefined, usedModels: ['gemma4:12b'] })).toMatchObject({ kind: 'escalate', model: 'qwen3-coder:swift-27b' });
  });
  it('a screen question only goes to a model that can see', () => {
    expect(needsSight("whats on my screen")).toBe(true);
    expect(needsSight("What's on my screen?")).toBe(true);
    expect(needsSight('Describe the attached picture')).toBe(true);
    expect(needsSight('make an image of chicken biryani')).toBe(false);
    expect(needsSight('Write a haiku about autumn in Ulm.')).toBe(false);
    const plan = planEscalation({ ...base, needsTools: false, needsVision: needsSight("whats on my screen"), usedModels: ['qwen2.5vl:7b'] });
    expect(plan).toMatchObject({ kind: 'escalate', model: 'gemma4:26b-a4b-it-qat' });
    expect(installed.find((m) => m.name === (plan as { model: string }).model)!.capabilities).toContain('vision');
  });
});
