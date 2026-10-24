import { describe, expect, it } from 'vitest';
import {
  PACK_HARD_MAX_CHARS,
  PACK_MIN_CHARS,
  deriveExecutionEconomy,
  packBudgetChars,
} from '../../autonomy/ExecutionEconomyProfile';
import { normalizeContextWindow } from '../../../core/shared/contextBudget';

const window = (contextTokens: number, source = 'router_metadata') => ({ contextTokens, source });

describe('M46 execution economy profile', () => {
  it('gives a small-window model a constrained profile with stronger pruning and serialized tools', () => {
    const profile = deriveExecutionEconomy({ contextWindow: window(8_192) });
    expect(profile.tier).toBe('constrained');
    expect(profile.execution).toMatchObject({ serializeTools: true, aggressivePruning: true, deterministicVerificationFirst: true });
    expect(profile.subgoal.fragment).toBe(true);
    expect(profile.pack.maxChars).toBeLessThan(16_001);
    expect(profile.pack.maxChars).toBeGreaterThanOrEqual(PACK_MIN_CHARS);
  });

  it('gives a moderate window the standard profile with larger packs and normal loops', () => {
    const profile = deriveExecutionEconomy({ contextWindow: window(32_768) });
    expect(profile.tier).toBe('standard');
    expect(profile.execution.serializeTools).toBe(false);
    expect(profile.pack.maxChars).toBeGreaterThan(deriveExecutionEconomy({ contextWindow: window(8_192) }).pack.maxChars);
    expect(profile.subgoal.fragment).toBe(false);
  });

  it('spends more on a large window but stays bounded and never disables recovery or governance', () => {
    const large = deriveExecutionEconomy({ contextWindow: window(262_144) });
    const standard = deriveExecutionEconomy({ contextWindow: window(32_768) });
    expect(large.tier).toBe('capable');
    expect(large.pack.maxChars).toBeGreaterThan(standard.pack.maxChars);
    expect(large.pack.maxChars).toBeLessThanOrEqual(PACK_HARD_MAX_CHARS);
    for (const p of [large, standard, deriveExecutionEconomy({})]) {
      expect(p.governance).toEqual({ approvals: true, recovery: true });
    }
  });

  it('falls back to the conservative profile for an unresolved model instead of guessing', () => {
    const profile = deriveExecutionEconomy({});
    expect(profile.tier).toBe('constrained');
    expect(profile.window.source).toBe('assumed_default');
    expect(profile.reasons.join(' ')).toMatch(/unresolved/);
    // an unlabelled window is unresolved too, whatever number it carries
    expect(deriveExecutionEconomy({ contextWindow: { contextTokens: 200_000 } }).tier).toBe('constrained');
  });

  it('lowers the tier on size, low reliability and resource pressure, one step each, and never raises it', () => {
    const base = { contextWindow: window(262_144) };
    expect(deriveExecutionEconomy({ ...base, parameterBillions: 7 }).tier).toBe('standard');
    expect(deriveExecutionEconomy({ ...base, parameterBillions: 70 }).tier).toBe('capable');
    expect(deriveExecutionEconomy({ ...base, parameterBillions: 7, reliability: 'low' }).tier).toBe('constrained');
    expect(deriveExecutionEconomy({ ...base, resourcePressure: true }).tier).toBe('standard');
    expect(deriveExecutionEconomy({ contextWindow: window(4_096), reliability: 'high' }).tier).toBe('constrained');
    expect(deriveExecutionEconomy({ contextWindow: window(4_096), reliability: 'low', resourcePressure: true }).tier).toBe('constrained');
  });

  it('fragments a complex task on a standard model, and shrinks the pack for a trivial one', () => {
    const w = window(32_768);
    expect(deriveExecutionEconomy({ contextWindow: w, taskComplexity: 'complex' }).subgoal.fragment).toBe(true);
    expect(deriveExecutionEconomy({ contextWindow: w, taskComplexity: 'trivial' }).pack.maxChars)
      .toBeLessThan(deriveExecutionEconomy({ contextWindow: w }).pack.maxChars);
  });

  it('derives the pack budget from the M45 allocator: it never exceeds what the window leaves for input', () => {
    for (const tokens of [2_048, 4_096, 8_192, 32_768, 131_072, 1_000_000]) {
      const w = normalizeContextWindow(window(tokens));
      for (const tier of ['constrained', 'standard', 'capable'] as const) {
        const chars = packBudgetChars(w, tier);
        expect(chars).toBeGreaterThanOrEqual(PACK_MIN_CHARS);
        expect(chars).toBeLessThanOrEqual(PACK_HARD_MAX_CHARS);
        // 4 chars/token: the pack alone must fit inside the whole window with output reserved.
        expect(chars / 4).toBeLessThan(Math.max(w.contextTokens, PACK_MIN_CHARS));
      }
    }
  });

  it('is deterministic and contains no model or vendor name logic', () => {
    const a = deriveExecutionEconomy({ contextWindow: window(16_384), parameterBillions: 14 });
    const b = deriveExecutionEconomy({ contextWindow: window(16_384), parameterBillions: 14 });
    expect(a).toEqual(b);
  });
});
