import { describe, expect, it } from 'vitest';
import {
  CORE_ASSUMED_CONTEXT_TOKENS,
  LOOP_DELTA_MAX_CHARS,
  LOOP_DELTA_MIN_CHARS,
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  MISSION_LEDGER_MAX_CHARS,
  MISSION_LEDGER_MIN_CHARS,
  allocateContextAtAssembly,
  conversationReplayCapTokens,
  measurePromptChars,
  normalizeContextWindow,
  outputReserveTokens,
  resolveContextWindowChain,
  safetyMarginTokens,
  usableInputTokens,
  type ContextSurface,
  type ContextWindow,
} from '../shared/contextBudget';
import { estimatePromptTokens } from '../runtime/ollamaChatControls';
import { sanitizeModelSelectionWindow } from '../domain/attemptContext';
import type { ModelSelectionEvidence } from '../shared/wireTypes';

const window = (contextTokens: number, extra: Partial<ContextWindow> = {}): ContextWindow => ({
  contextTokens,
  source: 'provider_introspection',
  ...extra,
});

describe('normalizeContextWindow', () => {
  it('falls back to the conservative assumed default when absent, unlabelled or invalid', () => {
    const assumed = { contextTokens: CORE_ASSUMED_CONTEXT_TOKENS, source: 'assumed_default' };
    expect(normalizeContextWindow()).toEqual(assumed);
    expect(normalizeContextWindow({ contextTokens: 8192 })).toEqual(assumed);
    expect(normalizeContextWindow({ contextTokens: 8192, source: 'made_up' })).toEqual(assumed);
    expect(normalizeContextWindow({ contextTokens: -5, source: 'explicit_config' })).toEqual(assumed);
    expect(normalizeContextWindow({ contextTokens: Number.NaN, source: 'explicit_config' })).toEqual(assumed);
  });

  it('clamps a labelled window into range and keeps its source and output allowance', () => {
    expect(normalizeContextWindow({ contextTokens: 100, source: 'catalog_metadata' }).contextTokens).toBe(MIN_CONTEXT_TOKENS);
    expect(normalizeContextWindow({ contextTokens: 9e9, source: 'catalog_metadata' }).contextTokens).toBe(MAX_CONTEXT_TOKENS);
    expect(normalizeContextWindow({ contextTokens: 16_384.9, source: 'router_metadata', maxOutputTokens: 512 }))
      .toEqual({ contextTokens: 16_384, source: 'router_metadata', maxOutputTokens: 512 });
  });
});

describe('resolveContextWindowChain', () => {
  it('follows explicit → router → provider → catalog → assumed, recording the source', () => {
    expect(resolveContextWindowChain({ explicit: 4096, router: 8192, provider: 16384, catalog: 32768 }))
      .toMatchObject({ contextTokens: 4096, source: 'explicit_config' });
    expect(resolveContextWindowChain({ router: 8192, provider: 16384, catalog: 32768 }))
      .toMatchObject({ contextTokens: 8192, source: 'router_metadata' });
    expect(resolveContextWindowChain({ provider: 16384, catalog: 32768 }))
      .toMatchObject({ contextTokens: 16384, source: 'provider_introspection' });
    expect(resolveContextWindowChain({ catalog: 32768 }))
      .toMatchObject({ contextTokens: 32768, source: 'catalog_metadata' });
    expect(resolveContextWindowChain({}))
      .toEqual({ contextTokens: CORE_ASSUMED_CONTEXT_TOKENS, source: 'assumed_default' });
  });

  it('never raises an explicit window above what the provider itself reported', () => {
    expect(resolveContextWindowChain({ explicit: 65_536, provider: 8192 }))
      .toMatchObject({ contextTokens: 8192, source: 'explicit_config' });
  });
});

describe('window arithmetic', () => {
  it('reserves output and margin exactly as the repository budget always did', () => {
    expect(outputReserveTokens(window(8192))).toBe(1638);
    expect(outputReserveTokens(window(4096))).toBe(1024);
    expect(outputReserveTokens(window(131_072))).toBe(8192);
    expect(outputReserveTokens(window(32_768, { maxOutputTokens: 1_000_000 }))).toBe(16_384);
    expect(safetyMarginTokens(window(32_768))).toBe(3276);
    expect(usableInputTokens(window(32_768))).toBe(32_768 - 6553 - 3276);
  });

  it('caps conversation replay per surface', () => {
    expect(conversationReplayCapTokens('mission', window(32_768))).toBe(0);
    expect(conversationReplayCapTokens('saath_kar', window(32_768))).toBe(4915);
    expect(conversationReplayCapTokens('baat_kar', window(32_768))).toBe(9830);
    expect(conversationReplayCapTokens('baat_kar', window(131_072))).toBe(20_000);
    expect(conversationReplayCapTokens('saath_kar', window(262_144))).toBe(20_000);
  });

  it('measures prompts with the arithmetic estimatePromptTokens uses', () => {
    const messages = [
      { role: 'system' as const, content: 'a'.repeat(1000) },
      { role: 'user' as const, content: 'b'.repeat(333), images: ['x', 'y'] },
    ];
    const tools = [{ name: 't', description: 'd', parameters: {} }];
    expect(Math.ceil(measurePromptChars(messages, tools) / 4)).toBe(estimatePromptTokens({ messages, tools }));
    expect(measurePromptChars([{ content: 'abc' }])).toBe(3);
  });
});

describe('allocateContextAtAssembly', () => {
  const surfaces: ContextSurface[] = ['baat_kar', 'saath_kar', 'mission'];

  it.each([4096, 8192, 32_768, 131_072])('splits a %i-token window without exceeding the usable input', (tokens) => {
    for (const surface of surfaces) {
      const fixedChars = 3000;
      const a = allocateContextAtAssembly({ surface, window: window(tokens), fixedChars });
      const usable = usableInputTokens(window(tokens));
      expect(a.usableInputTokens).toBe(usable);
      expect(a.fixedOverflow).toBe(false);
      expect(a.remainingChars).toBe((usable - Math.ceil(fixedChars / 4)) * 4);
      if (surface === 'baat_kar') {
        expect(a.conversationReplayChars).toBe(Math.min(conversationReplayCapTokens('baat_kar', window(tokens)) * 4, a.remainingChars));
        expect(a.loopDeltaChars).toBe(0);
        expect(a.missionLedgerChars).toBe(0);
      } else if (surface === 'saath_kar') {
        expect(a.missionLedgerChars).toBe(0);
        expect(a.conversationReplayChars).toBeLessThanOrEqual(Math.max(0, a.remainingChars - LOOP_DELTA_MIN_CHARS));
        expect(a.loopDeltaChars).toBeLessThanOrEqual(LOOP_DELTA_MAX_CHARS);
        expect(a.conversationReplayChars + a.loopDeltaChars).toBeLessThanOrEqual(a.remainingChars);
      } else {
        expect(a.conversationReplayChars).toBe(0);
        expect(a.loopDeltaChars).toBe(0);
        expect(a.missionLedgerChars).toBeGreaterThanOrEqual(MISSION_LEDGER_MIN_CHARS);
        expect(a.missionLedgerChars).toBeLessThanOrEqual(MISSION_LEDGER_MAX_CHARS);
      }
    }
  });

  it('gives an 8k window a replay that fits it (the F1 mismatch), not the fixed 80k chars', () => {
    const baat = allocateContextAtAssembly({ surface: 'baat_kar', window: window(8192), fixedChars: 4000 });
    expect(baat.conversationReplayChars).toBeLessThan(80_000);
    expect(baat.conversationReplayChars + baat.fixedChars).toBeLessThanOrEqual(baat.usableInputTokens * 4);
  });

  it('caps a large Saath window at the continuation-safe loop delta and 20k-token replay', () => {
    const a = allocateContextAtAssembly({ surface: 'saath_kar', window: window(262_144), fixedChars: 10_000 });
    expect(a.conversationReplayChars).toBe(80_000);
    expect(a.loopDeltaChars).toBe(LOOP_DELTA_MAX_CHARS);
  });

  it('clamps the mission ledger to its band', () => {
    expect(allocateContextAtAssembly({ surface: 'mission', window: window(4096), fixedChars: 0 }).missionLedgerChars)
      .toBeGreaterThanOrEqual(MISSION_LEDGER_MIN_CHARS);
    expect(allocateContextAtAssembly({ surface: 'mission', window: window(262_144), fixedChars: 0 }).missionLedgerChars)
      .toBe(MISSION_LEDGER_MAX_CHARS);
  });

  it('reports fixedOverflow and allocates nothing variable when the fixed parts alone do not fit', () => {
    const a = allocateContextAtAssembly({ surface: 'saath_kar', window: window(4096), fixedChars: 200_000 });
    expect(a.fixedOverflow).toBe(true);
    expect(a.remainingChars).toBe(0);
    expect(a.conversationReplayChars).toBe(0);
    expect(a.loopDeltaChars).toBe(0);
  });
});

describe('sanitizeModelSelectionWindow', () => {
  const base = {
    requiredCapabilities: {}, selectedProvider: 'ollama', selectedModel: 'm', selectionReason: 'r',
    suitabilitySummary: 's', userOverrode: false, candidates: [], escalationCandidates: [],
  } as unknown as ModelSelectionEvidence;

  it('keeps a valid labelled window and drops out-of-range or unlabelled values without rejecting', () => {
    expect(sanitizeModelSelectionWindow({ ...base, contextWindowTokens: 16_384, contextWindowSource: 'router_metadata', maxOutputTokens: 512 }))
      .toMatchObject({ contextWindowTokens: 16_384, contextWindowSource: 'router_metadata', maxOutputTokens: 512 });
    for (const bad of [
      { contextWindowTokens: 10, contextWindowSource: 'router_metadata' },
      { contextWindowTokens: MAX_CONTEXT_TOKENS + 1, contextWindowSource: 'router_metadata' },
      { contextWindowTokens: 8192.5, contextWindowSource: 'router_metadata' },
      { contextWindowTokens: 8192 },
      { contextWindowTokens: 8192, contextWindowSource: 'bogus' },
    ] as Array<Partial<ModelSelectionEvidence>>) {
      const cleaned = sanitizeModelSelectionWindow({ ...base, ...bad });
      expect(cleaned).not.toHaveProperty('contextWindowTokens');
      expect(cleaned).not.toHaveProperty('contextWindowSource');
    }
    expect(sanitizeModelSelectionWindow({ ...base, maxOutputTokens: -1 })).not.toHaveProperty('maxOutputTokens');
  });
});
