import { describe, expect, it } from 'vitest';
import {
  assertPromptFitsContext,
  benchmarkSamplingOptions,
  estimatePromptTokens,
  ollamaPayloadControls,
  resolveImplicitNumCtx,
  resolveOllamaChatControls,
} from '../runtime/ollamaChatControls';
import { AUTONOMOUS_MISSION_PROFILE } from '../runtime/missionLoop';

describe('ollamaChatControls', () => {
  it('omits controls by default so Ollama model defaults apply', () => {
    const resolved = resolveOllamaChatControls({
      profile: AUTONOMOUS_MISSION_PROFILE,
      model: 'qwen3.8:27b-mtp-q4_K_M',
    });
    expect(resolved.numCtx).toBeUndefined();
    expect(resolved.think).toBeUndefined();
    expect(ollamaPayloadControls(resolved)).toEqual({});
  });

  it('applies explicit caller overrides for measured experiments', () => {
    const resolved = resolveOllamaChatControls({
      profile: AUTONOMOUS_MISSION_PROFILE,
      model: 'qwen3.8:27b-mtp-q4_K_M',
      overrides: { numCtx: 8192 },
    });
    expect(resolved.numCtx).toBe(8192);
    expect(resolved.think).toBeUndefined();
    expect(ollamaPayloadControls(resolved)).toEqual({ options: { num_ctx: 8192 } });
  });

  it('includes think only when explicitly set', () => {
    expect(ollamaPayloadControls({ think: false })).toEqual({ think: false });
    expect(ollamaPayloadControls({ think: true, numCtx: 8192 })).toEqual({
      think: true,
      options: { num_ctx: 8192 },
    });
  });

  it('benchmark sampling options are absent by default and only set from explicit valid env values', () => {
    expect(benchmarkSamplingOptions({})).toEqual({});
    expect(benchmarkSamplingOptions({ KKD_BENCHMARK_SEED: '', KKD_BENCHMARK_TEMPERATURE: ' ' })).toEqual({});
    expect(benchmarkSamplingOptions({ KKD_BENCHMARK_SEED: 'abc', KKD_BENCHMARK_TEMPERATURE: 'hot' })).toEqual({});
    expect(benchmarkSamplingOptions({ KKD_BENCHMARK_SEED: '42' })).toEqual({ seed: 42 });
    expect(benchmarkSamplingOptions({ KKD_BENCHMARK_SEED: '0', KKD_BENCHMARK_TEMPERATURE: '0' })).toEqual({ seed: 0, temperature: 0 });
    expect(benchmarkSamplingOptions({ KKD_BENCHMARK_TEMPERATURE: '0.2' })).toEqual({ temperature: 0.2 });
  });

  it('estimates prompt size and refuses oversized input instead of truncating', () => {
    const huge = 'x'.repeat(40_000); // ~10k tokens estimate
    expect(estimatePromptTokens({ messages: [{ role: 'user', content: huge }] })).toBeGreaterThan(8_000);
    expect(() => assertPromptFitsContext({
      messages: [{ role: 'user', content: huge }],
      numCtx: 8192,
      outputReserve: 512,
    })).toThrow(/prompt_exceeds_context/);
    expect(() => assertPromptFitsContext({
      messages: [{ role: 'user', content: 'small' }],
      numCtx: 8192,
    })).not.toThrow();
    // No numCtx → no silent truncation and no false refusal
    expect(() => assertPromptFitsContext({
      messages: [{ role: 'user', content: huge }],
    })).not.toThrow();
  });

  it('sizes num_ctx to a large repository-grounded prompt so Ollama cannot truncate away the current user query', () => {
    // Shape of the live Saath Kar failure: ~24K chars of repository excerpts,
    // 40 tool definitions, then the user query followed by tool turns. With
    // num_ctx omitted Ollama dropped the user turn and returned HTTP 500
    // "no user query found in messages".
    const tools = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'x'.repeat(300),
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }));
    const messages = [
      { role: 'system' as const, content: 's'.repeat(1_500) },
      { role: 'system' as const, content: 'r'.repeat(24_000) },
      { role: 'user' as const, content: 'Inspect package.json and src/ui/AgentPanel.ts' },
      { role: 'assistant' as const, content: 'Reading.' },
      { role: 'tool' as const, content: '[read_file] ok' },
    ];
    const numCtx = resolveImplicitNumCtx({ messages, tools });
    expect(numCtx).toBeDefined();
    expect(() => assertPromptFitsContext({ messages, tools, numCtx })).not.toThrow();
    expect(numCtx!).toBeGreaterThanOrEqual(estimatePromptTokens({ messages, tools }));
    // Small prompts keep the omit-all model-default behaviour, and an
    // explicit profile value is never overridden.
    expect(resolveImplicitNumCtx({ messages: [{ role: 'user', content: 'hi' }] })).toBeUndefined();
    expect(resolveImplicitNumCtx({ messages, tools, numCtx: 65_536 })).toBe(65_536);
  });

  it('M45: sizes the implicit window with the real output reserve and never above the frozen window', () => {
    const messages = [{ role: 'user' as const, content: 'q'.repeat(12_000) }]; // ~3k tokens
    // Historic default reserve 2048: ceil(3000*1.3)+2048 = 5948 -> 8192 bucket.
    expect(resolveImplicitNumCtx({ messages })).toBe(8_192);
    // A larger output reserve moves the bucket up: 3900 + 8192 = 12092 -> 16384.
    expect(resolveImplicitNumCtx({ messages, outputReserveTokens: 8_192 })).toBe(16_384);
    // The frozen window is a hard cap on the implicit value.
    expect(resolveImplicitNumCtx({ messages, outputReserveTokens: 8_192, maxContextTokens: 12_288 })).toBe(12_288);
    // An explicit profile/env num_ctx is untouched by either.
    expect(resolveImplicitNumCtx({ messages, numCtx: 65_536, outputReserveTokens: 8_192, maxContextTokens: 8_192 })).toBe(65_536);
    // A prompt that fits the default server window stays omit-all only when reserve leaves room.
    expect(resolveImplicitNumCtx({ messages: [{ role: 'user', content: 'hi' }], outputReserveTokens: 1_024 })).toBeUndefined();
  });

  it('M45: the guard checks the implicit window against the same output reserve', () => {
    const messages = [{ role: 'user' as const, content: 'q'.repeat(28_000) }]; // ~7k tokens
    expect(() => assertPromptFitsContext({ messages, numCtx: 8_192, outputReserve: 512 })).not.toThrow();
    expect(() => assertPromptFitsContext({ messages, numCtx: 8_192, outputReserve: 1_638 })).toThrow(/prompt_exceeds_context/);
  });
});
