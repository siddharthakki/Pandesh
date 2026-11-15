import { describe, expect, it } from 'vitest';
import { assessFit } from '../runtime/modelFit';
import { modelMemoryProfile } from '../runtime/ollamaModelInfo';

const GiB = 2 ** 30;
const gpu = { totalBytes: 24 * GiB, freeBytes: 20.5 * GiB };
const budget = 22.5 * GiB;
// qwen3.8:27b shaped: 16.5 GiB of weights; 8 GiB of cache at 32K halves per context step
const big = { weightsBytes: 16.5 * GiB, basis: 'architecture' as const, kvByCtx: [{ ctx: 4096, bytes: 1 * GiB }, { ctx: 8192, bytes: 2 * GiB }, { ctx: 16384, bytes: 4 * GiB }, { ctx: 32768, bytes: 8 * GiB }] };
const small = { weightsBytes: 7 * GiB, basis: 'architecture' as const, kvByCtx: [{ ctx: 4096, bytes: 0.2 * GiB }, { ctx: 8192, bytes: 0.4 * GiB }, { ctx: 16384, bytes: 0.8 * GiB }, { ctx: 32768, bytes: 1.6 * GiB }] };

describe('model fit report', () => {
  it('says a big model spills at Pandesh\'s context but fits a smaller one, with the numbers apart', () => {
    const r = assessFit({ profile: big, gpu, budgetBytes: budget });
    expect(r.state).toBe('spills');
    expect(r.maxFitCtx).toBe(16384);
    expect(r.label).toBe('Fits only up to 16K context');
    expect(r.summary).toMatch(/25\.5 GB at 32K context \(weights 16\.5 GB \+ cache 8\.0 GB \+ runtime 1\.0 GB\)/);
    expect(r).toMatchObject({ capacityBytes: 24 * GiB, budgetBytes: budget, availableBytes: 20.5 * GiB, weightsBytes: 16.5 * GiB });
    expect(r.uncertainty.join(' ')).toMatch(/can differ by a few GB/);
  });
  it('is measured, not estimated, once the model is loaded', () => {
    const on = assessFit({ profile: big, gpu, budgetBytes: budget, loaded: { sizeBytes: 20 * GiB, vramBytes: 20 * GiB, contextLength: 8192 } });
    expect(on).toMatchObject({ state: 'on_gpu', tone: 'ok' });
    expect(on.summary).toMatch(/Measured by Ollama/);
    const part = assessFit({ profile: big, gpu, budgetBytes: budget, loaded: { sizeBytes: 28 * GiB, vramBytes: 21 * GiB } });
    expect(part).toMatchObject({ state: 'partly_cpu', label: 'Loaded, 25% on the CPU' });
  });
  it('separates fits-the-budget from free-right-now', () => {
    expect(assessFit({ profile: small, gpu, budgetBytes: budget }).state).toBe('fits');
    expect(assessFit({ profile: small, gpu: { totalBytes: 24 * GiB, freeBytes: 4 * GiB }, budgetBytes: budget }).state).toBe('fits_when_free');
  });
  it('is too large only when even the smallest context does not fit, and unknown without data', () => {
    expect(assessFit({ profile: { ...big, weightsBytes: 40 * GiB }, gpu, budgetBytes: budget }).state).toBe('too_large');
    expect(assessFit({ gpu, budgetBytes: budget }).state).toBe('unknown');
    expect(assessFit({ profile: big, gpu: null }).state).toBe('unknown');
    expect(assessFit({ profile: big, gpu, budgetBytes: budget, embedding: true }).label).toBe('Embeddings');
  });
  it('builds a profile from the model layout, or falls back to a labeled rule of thumb', () => {
    const info = { 'general.architecture': 'qwen3', 'qwen3.block_count': 40, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096 };
    const p = modelMemoryProfile(10 * GiB, info)!;
    expect(p.basis).toBe('architecture');
    expect(p.kvByCtx.map((k) => k.ctx)).toEqual([4096, 8192, 16384, 32768]);
    expect(p.kvByCtx[3].bytes).toBe(8 * p.kvByCtx[0].bytes);
    expect(modelMemoryProfile(10 * GiB, {})!.basis).toBe('rule_of_thumb');
    expect(modelMemoryProfile(undefined, info)).toBeUndefined();
  });
});
