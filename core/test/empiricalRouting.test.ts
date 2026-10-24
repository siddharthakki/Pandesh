import { describe, expect, it } from 'vitest';
import {
  M50_V1_EVIDENCE_POLICY,
  M50_V1_FIT_POLICY,
  MAX_ROUTING_ALTERNATIVES,
  MIN_MEANINGFUL_SAMPLES,
  ROUTING_POLICY_VERSION,
  assessQualification,
  deriveToolProtocol,
  describeAutoWhy,
  ladderContext,
  rankCandidates,
  taskFitBucket,
  toAlternatives,
  toolProtocolSupportsTools,
  type LadderCandidate,
  type QualificationEvidence,
} from '../domain/empiricalRouting';

function candidate(model: string, overrides: Partial<LadderCandidate> = {}): LadderCandidate {
  return {
    provider: 'ollama',
    model,
    taskFit: 'adequate',
    qualificationTier: 'neutral',
    configuredDefault: false,
    ...overrides,
  };
}

const order = (candidates: readonly LadderCandidate[]) => rankCandidates(candidates).map(item => item.candidate.model);

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

describe('M50 empirical routing — policy', () => {
  it('records an explicit policy version', () => {
    expect(ROUTING_POLICY_VERSION).toBe('m50-v1');
  });

  it('the evidence threshold is an explicit versioned m50-v1 constant, not a significance claim', () => {
    expect(M50_V1_EVIDENCE_POLICY).toEqual({ version: 'm50-v1', minScenarios: 2, minSamples: 5, strongPassRate: 0.8, poorPassRate: 0.5 });
  });
});

describe('M50 empirical routing — tool protocol (M49.2 invariant)', () => {
  it('native function calling is supported', () => {
    const protocol = deriveToolProtocol({ nativeToolCalling: true });
    expect(protocol).toBe('native');
    expect(toolProtocolSupportsTools(protocol)).toBe(true);
  });

  it('a model without native calling but whose provider accepts the tool payload is prompted, and supported', () => {
    const protocol = deriveToolProtocol({ nativeToolCalling: false, providerCapabilities: ['completion', 'tools'] });
    expect(protocol).toBe('prompted');
    expect(toolProtocolSupportsTools(protocol)).toBe(true);
  });

  it('no native calling and no provider evidence of a tool path is none, and incompatible where tools are required', () => {
    for (const providerCapabilities of [undefined, [], ['completion']]) {
      const protocol = deriveToolProtocol({ nativeToolCalling: false, providerCapabilities });
      expect(protocol).toBe('none');
      expect(toolProtocolSupportsTools(protocol)).toBe(false);
    }
  });

  it('native tool support wins regardless of what the provider list says', () => {
    expect(deriveToolProtocol({ nativeToolCalling: true, providerCapabilities: ['completion'] })).toBe('native');
  });
});

describe('M50 empirical routing — qualification evidence is cautious', () => {
  const evidence = (passCount: number, sampleCount: number, scenarioCount: number): QualificationEvidence => ({ passCount, sampleCount, scenarioCount });

  it('absence of evidence is neutral, never a penalty', () => {
    expect(assessQualification(undefined)).toMatchObject({ meaningful: false, tier: 'neutral' });
    expect(assessQualification(evidence(0, 0, 0))).toMatchObject({ meaningful: false, tier: 'neutral' });
  });

  it('a perfect single-scenario sample cannot become a strong signal', () => {
    expect(assessQualification(evidence(8, 8, 1))).toMatchObject({ meaningful: false, tier: 'neutral' });
  });

  it('a tiny sample cannot become a strong or a poor signal', () => {
    expect(assessQualification(evidence(2, 2, 2)).tier).toBe('neutral');
    expect(assessQualification(evidence(0, MIN_MEANINGFUL_SAMPLES - 1, 3)).tier).toBe('neutral');
  });

  it('meaningful evidence is bucketed: strong, mixed (neutral) and poor', () => {
    expect(assessQualification(evidence(9, 10, 3))).toMatchObject({ meaningful: true, tier: 'strong' });
    expect(assessQualification(evidence(6, 10, 3))).toMatchObject({ meaningful: true, tier: 'neutral' });
    expect(assessQualification(evidence(2, 10, 3))).toMatchObject({ meaningful: true, tier: 'poor' });
  });
});

describe('M50 empirical routing — task fit buckets', () => {
  it('buckets the suitability prior against the task bar; the margin is a versioned constant', () => {
    expect(M50_V1_FIT_POLICY).toEqual({ version: 'm50-v1', comfortableFrom: 0.8 });
    expect(taskFitBucket({ prior: 0.95, floor: 0.76, empiricallyProven: false })).toBe('comfortable');
    expect(taskFitBucket({ prior: 0.78, floor: 0.76, empiricallyProven: false })).toBe('adequate');
    expect(taskFitBucket({ prior: 0.7, floor: 0.76, empiricallyProven: false })).toBe('below');
    // The bucket never rises above what the task's own bar allows: a bar of 0.88 needs a prior of 0.88.
    expect(taskFitBucket({ prior: 0.85, floor: 0.88, empiricallyProven: false })).toBe('below');
  });

  it('never recreates 0.79 < 0.82 => cannot execute: a bucket is a rank, never a gate', () => {
    expect(taskFitBucket({ prior: 0.79, floor: 0.82, empiricallyProven: false })).toBe('below');
    expect(order([candidate('only', { taskFit: 'below' })])).toEqual(['only']);
  });

  it('meaningful benchmark evidence lifts a below-bar prior to adequate, never to comfortable', () => {
    expect(taskFitBucket({ prior: 0.5, floor: 0.82, empiricallyProven: true })).toBe('adequate');
  });
});

describe('M50 empirical routing — ranking ladder', () => {
  it('1: a comfortable fit outranks an adequate one, which outranks below; estimates inside a bucket never order', () => {
    expect(order([candidate('a-adequate'), candidate('z-comfortable', { taskFit: 'comfortable' })])).toEqual(['z-comfortable', 'a-adequate']);
    expect(order([candidate('z-same'), candidate('a-same')])).toEqual(['a-same', 'z-same']);
  });

  it('1: task fit outranks everything below it, including a configured default and strong evidence', () => {
    const fits = candidate('fits');
    const configuredButBelow = candidate('configured-below', { taskFit: 'below', configuredDefault: true, qualificationTier: 'strong' });
    expect(order([configuredButBelow, fits])).toEqual(['fits', 'configured-below']);
  });

  it('a configured default does NOT outrank stronger evidence or a better tool protocol in AUTO', () => {
    const configured = candidate('configured', { configuredDefault: true, qualificationTier: 'poor' });
    const proven = candidate('proven', { qualificationTier: 'strong' });
    expect(order([configured, proven])).toEqual(['proven', 'configured']);
    const prompted = candidate('prompted', { configuredDefault: true, toolProtocol: 'prompted' });
    const native = candidate('native', { toolProtocol: 'native' });
    expect(order([prompted, native])).toEqual(['native', 'prompted']);
  });

  it('2: meaningful qualification outranks everything after it', () => {
    const proven = candidate('proven', { qualificationTier: 'strong', parameterBillions: 70, resident: false });
    const light = candidate('light', { parameterBillions: 7, resident: true });
    expect(order([light, proven])).toEqual(['proven', 'light']);
  });

  it('2: a poor meaningful record ranks below an unmeasured model, which stays fully usable', () => {
    const poor = candidate('poor', { qualificationTier: 'poor' });
    const unknown = candidate('unknown');
    expect(order([poor, unknown])).toEqual(['unknown', 'poor']);
    expect(order([poor])).toEqual(['poor']);
  });

  it('2: low-sample evidence is neutral, so it cannot beat an equal model on a later rung', () => {
    const lucky = candidate('aaa-lucky', {
      qualificationTier: assessQualification({ passCount: 3, sampleCount: 3, scenarioCount: 1 }).tier,
      resident: false,
    });
    const resident = candidate('zzz-resident', { resident: true });
    expect(order([lucky, resident])).toEqual(['zzz-resident', 'aaa-lucky']);
  });

  it('3: tool protocol decides only when every candidate has it (tools required)', () => {
    const native = candidate('zzz-native', { toolProtocol: 'native' });
    const prompted = candidate('aaa-prompted', { toolProtocol: 'prompted' });
    expect(order([prompted, native])).toEqual(['zzz-native', 'aaa-prompted']);
    expect(ladderContext([native, candidate('no-tools-needed')]).useToolProtocol).toBe(false);
  });

  it('4: residency decides only when every candidate has the datum', () => {
    const warm = candidate('zzz-warm', { resident: true });
    const cold = candidate('aaa-cold', { resident: false });
    expect(order([cold, warm])).toEqual(['zzz-warm', 'aaa-cold']);
    const unknown = candidate('mmm-unknown');
    expect(ladderContext([cold, warm, unknown]).useResidency).toBe(false);
    expect(order([cold, warm, unknown])).toEqual(['aaa-cold', 'mmm-unknown', 'zzz-warm']);
  });

  it('5: latency decides by octave and only when every candidate has it', () => {
    const fast = candidate('zzz-fast', { latencyMs: 10_000 });
    const slow = candidate('aaa-slow', { latencyMs: 40_000 });
    expect(order([slow, fast])).toEqual(['zzz-fast', 'aaa-slow']);
    const jitter = candidate('aaa-jitter', { latencyMs: 11_000 });
    expect(order([jitter, fast])).toEqual(['aaa-jitter', 'zzz-fast']);
    expect(ladderContext([fast, candidate('none')]).useLatency).toBe(false);
  });

  it('6: a configured default is a late tie-break, after latency and before size', () => {
    const configured = candidate('zzz-configured', { configuredDefault: true, parameterBillions: 70, latencyMs: 10_000 });
    const other = candidate('aaa-other', { parameterBillions: 7, latencyMs: 10_000 });
    expect(order([other, configured])).toEqual(['zzz-configured', 'aaa-other']);
    const faster = candidate('aaa-faster', { latencyMs: 2_000, parameterBillions: 7 });
    expect(order([configured, faster])).toEqual(['aaa-faster', 'zzz-configured']);
  });

  it('7: parameter size is only a late tie-break, smaller first, and never beats a higher rung', () => {
    const small = candidate('zzz-small', { parameterBillions: 8 });
    const large = candidate('aaa-large', { parameterBillions: 70 });
    expect(order([large, small])).toEqual(['zzz-small', 'aaa-large']);
    const strongLarge = candidate('strong-large', { parameterBillions: 70, qualificationTier: 'strong' });
    expect(order([small, strongLarge])).toEqual(['strong-large', 'zzz-small']);
  });

  it('8: identical candidates are ordered by provider:model identity', () => {
    expect(order([candidate('b'), candidate('a'), candidate('c')])).toEqual(['a', 'b', 'c']);
    const other = { ...candidate('a'), provider: 'zeta' };
    expect(rankCandidates([other, candidate('a')]).map(item => item.candidate.provider)).toEqual(['ollama', 'zeta']);
  });

  it('is independent of input order for every permutation', () => {
    const pool = [
      candidate('a', { resident: true, latencyMs: 20_000, parameterBillions: 14 }),
      candidate('b', { resident: true, latencyMs: 20_000, parameterBillions: 14 }),
      candidate('c', { resident: false, latencyMs: 5_000, parameterBillions: 7 }),
      candidate('d', { qualificationTier: 'poor', resident: false, latencyMs: 5_000, parameterBillions: 7 }),
      candidate('e', { qualificationTier: 'strong', resident: false, latencyMs: 90_000, parameterBillions: 30 }),
      candidate('f', { configuredDefault: true, taskFit: 'below', resident: false, latencyMs: 90_000, parameterBillions: 30 }),
    ];
    const expected = order(pool);
    for (const permutation of permutations(pool)) expect(order(permutation)).toEqual(expected);
    expect(expected[0]).toBe('e');
    expect(expected[expected.length - 1]).toBe('f');
  });

  it('records which rung put each candidate behind the one above it', () => {
    const ranked = rankCandidates([
      candidate('top', { qualificationTier: 'strong' }),
      candidate('mid'),
      candidate('low', { taskFit: 'below' }),
    ]);
    expect(ranked.map(item => item.behindBecauseOf)).toEqual([null, 'qualification', 'task_fit']);
  });
});

describe('M50 empirical routing — explanation', () => {
  it('produces concise operator lines, not a score table', () => {
    const ranked = rankCandidates([
      candidate('winner', { qualificationTier: 'strong', resident: true }),
      candidate('other', { resident: true }),
    ]);
    const why = describeAutoWhy({
      selected: ranked[0].candidate,
      selectedQualification: assessQualification({ passCount: 9, sampleCount: 10, scenarioCount: 3 }),
      ranked,
      belowPreferredConfidence: false,
      toolProtocol: 'native',
      toolsRequired: true,
      resident: true,
    });
    expect(why).toEqual([
      'Compatible with the current task',
      'Native tool calling',
      'Available locally and already loaded',
      'Relevant qualification evidence (benchmark 9/10 across 3 scenarios)',
      'Preferred over 1 compatible alternative: it has stronger benchmark evidence',
    ]);
  });

  it('says so when a model is the only compatible one, uses the prompted protocol, or is below the preferred bar', () => {
    const ranked = rankCandidates([candidate('only')]);
    const why = describeAutoWhy({
      selected: ranked[0].candidate,
      selectedQualification: assessQualification(undefined),
      ranked,
      belowPreferredConfidence: true,
      toolProtocol: 'prompted',
      toolsRequired: true,
      resident: false,
    });
    expect(why).toContain('Tool use through the prompted protocol');
    expect(why).toContain('Only compatible model installed');
    expect(why).toContain('Below the preferred reliability bar, but the best compatible model available');
    expect(why.some(line => /qualification/i.test(line))).toBe(false);
  });

  it('bounds the alternatives it records', () => {
    const many = rankCandidates(Array.from({ length: 12 }, (_, i) => candidate(`m${String(i).padStart(2, '0')}`)));
    expect(toAlternatives(many)).toHaveLength(MAX_ROUTING_ALTERNATIVES);
  });
});
