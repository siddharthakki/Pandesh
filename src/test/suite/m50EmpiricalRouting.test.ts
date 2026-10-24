import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _resetConfig } from '../mocks/vscode';
import { ModelCapabilityRegistry, type ModelCapability } from '../../models/ModelCapabilityRegistry';
import {
  TaskModelSelectionError,
  checkFrozenModelRunnable,
  classifyTaskRequirements,
  selectTaskModel,
  type TaskModelCandidate,
} from '../../models/TaskModelSelection';
import { buildProductionTaskModelCandidates } from '../../models/ProductionModelCandidates';
import { loadQualificationEvidence, parseQualificationEvidence } from '../../models/QualificationEvidenceStore';
import type { ModelRole } from '../../providers/InferenceTypes';
import type { InferenceProvider, ModelInfo } from '../../providers/ProviderTypes';
import { ROUTING_POLICY_VERSION } from '../../../core/domain/empiricalRouting';

/**
 * M50 production routing: the existing `selectTaskModel` path with the empirical ranking ladder, the
 * native/prompted tool protocol invariant (M49.2) and the frozen routing evidence. Fully deterministic;
 * no live model, no benchmark run. Model names are arbitrary on purpose: routing logic knows no model.
 */

const AGENT: readonly ModelRole[] = ['agent', 'edit', 'reviewer'];

function candidate(
  model: string,
  options: Partial<Omit<TaskModelCandidate, 'provider' | 'model' | 'available' | 'capabilities' | 'configuredRoles'>> & {
    available?: boolean;
    capabilities?: Partial<ModelCapability>;
  } = {},
): TaskModelCandidate {
  const { available, capabilities, ...rest } = options;
  const base = { ...ModelCapabilityRegistry.getInstance().getCapabilities(model, 'ollama'), contextWindow: 32_768, tools: true };
  return {
    provider: 'ollama',
    model,
    available: available ?? true,
    capabilities: { ...base, ...capabilities },
    configuredRoles: AGENT,
    reliability: 0.85,
    ...rest,
  };
}

/** A governed-coding-shaped requirement set: structured hints, tools required, validation repair. */
const codingTask = () => classifyTaskRequirements('', {
  repositoryExploration: true, toolCalling: true, fileMutation: true, validationRepair: true, codingComplexity: 'medium',
});

const evidence = (passCount: number, sampleCount: number, scenarioCount: number, medianDurationMs?: number) => ({
  passCount, sampleCount, scenarioCount, ...(medianDurationMs !== undefined ? { medianDurationMs } : {}),
});

const select = (candidates: TaskModelCandidate[], extra: Partial<Parameters<typeof selectTaskModel>[0]> = {}) =>
  selectTaskModel({ provider: 'ollama', requirements: codingTask(), candidates, ...extra });

beforeEach(() => {
  _resetConfig();
  ModelCapabilityRegistry.resetInstance();
});

describe('M50 AUTO selection', () => {
  it('selects a compatible candidate and excludes unavailable and hard-incompatible ones however good they look', () => {
    const result = select([
      candidate('gone:70b', { available: false, reliability: 0.99 }),
      candidate('too-small:7b', { reliability: 0.99, capabilities: { contextWindow: 2_048 } }),
      candidate('no-tools:30b', { reliability: 0.99, capabilities: { tools: false }, providerCapabilities: ['completion'] }),
      candidate('usable:14b', { reliability: 0.86 }),
    ]);
    expect(result.selectedModel).toBe('usable:14b');
    expect(result.overridden).toBe(false);
    const excluded = Object.fromEntries(result.rejectedCandidates.map(item => [item.model, item.hardReasons.join(' ')]));
    expect(excluded['gone:70b']).toMatch(/not available/i);
    expect(excluded['too-small:7b']).toMatch(/Context window/);
    expect(excluded['no-tools:30b']).toMatch(/Tool calling is required/);
    expect(result.routing).toMatchObject({ policyVersion: ROUTING_POLICY_VERSION, selectionMode: 'auto', compatibleCandidateCount: 1 });
    expect(result.routing.why[0]).toBe('Compatible with the current task');
  });

  it('a soft reliability threshold never blocks: the only compatible model below the floor is still selected', () => {
    const result = select([candidate('modest:8b', { reliability: 0.6 })]);
    expect(result.selectedModel).toBe('modest:8b');
    expect(result.belowPreferredConfidence).toBe(true);
    expect(result.routing.why).toContain('Below the preferred reliability bar, but the best compatible model available');
  });

  it('missing empirical data is allowed and recorded as unused', () => {
    const result = select([candidate('unmeasured:14b'), candidate('other:14b')]);
    expect(result.routing.empiricalEvidenceUsed).toBe(false);
    expect(result.routing.alternatives.every(item => item.qualification === 'no benchmark evidence')).toBe(true);
  });

  it('prompted tool protocol stays compatible: a model without native function calling is not hard-excluded', () => {
    const prompted = candidate('prompted:14b', {
      capabilities: { tools: false },
      providerCapabilities: ['completion', 'tools'],
    });
    const result = select([prompted]);
    expect(result.selectedModel).toBe('prompted:14b');
    expect(result.rejectedCandidates).toEqual([]);
    expect(result.routing.toolProtocol).toBe('prompted');
    expect(result.routing.why).toContain('Tool use through the prompted protocol');
  });

  it('an explicit prompted protocol is honoured; protocol none is still incompatible where tools are required', () => {
    expect(select([candidate('explicit:14b', { capabilities: { tools: false }, toolProtocol: 'prompted' })]).selectedModel).toBe('explicit:14b');
    expect(() => select([candidate('none:14b', { capabilities: { tools: false }, providerCapabilities: ['completion'] })]))
      .toThrowError(expect.objectContaining({ code: 'no_capable_model' }));
    // ...but only where tools are required: a plain question needs no tool path at all.
    const question = classifyTaskRequirements('', { repositoryExploration: false, toolCalling: false, fileMutation: false });
    expect(select([candidate('none:14b', { capabilities: { tools: false }, providerCapabilities: ['completion'] })], { requirements: question }).selectedModel)
      .toBe('none:14b');
  });

  it('native calling is preferred by the tool-protocol rung, not by exclusion of the prompted alternative', () => {
    const native = candidate('zzz-native:14b');
    const prompted = candidate('aaa-prompted:14b', { capabilities: { tools: false }, providerCapabilities: ['completion', 'tools'] });
    const result = select([prompted, native]);
    expect(result.selectedModel).toBe('zzz-native:14b');
    expect(result.routing.alternatives.map(item => item.model)).toContain('aaa-prompted:14b');
    expect(result.routing.alternatives[1].behindBecauseOf).toBe('tool_protocol');
  });

  it('a model whose provider declares no `completion` capability is never chat-eligible, whatever its name or registry guess says', () => {
    // Registry/name heuristic says chat:true; provider evidence (Ollama /api/show) says it cannot chat.
    const refused = candidate('arbitrary-flash:latest', { reliability: 0.99, providerCapabilities: ['insert'] });
    const good = candidate('plain:14b', { reliability: 0.8, providerCapabilities: ['completion', 'tools'] });
    const question = classifyTaskRequirements('', { repositoryExploration: false, toolCalling: false, fileMutation: false });
    const auto = select([refused, good], { requirements: question });
    expect(auto.selectedModel).toBe('plain:14b');
    expect(auto.rejectedCandidates.find(item => item.model === 'arbitrary-flash:latest')?.hardReasons.join(' ')).toMatch(/no chat capability/i);
    // Manual is equally exact: an explicit pick of it is refused with the incompatibility, never silently run.
    expect(() => select([refused], { requirements: question, userOverride: { provider: 'ollama', model: 'arbitrary-flash:latest' } }))
      .toThrowError(/no chat capability/i);
    // Unknown (no declared list) never refuses.
    expect(select([candidate('undeclared:14b')], { requirements: question }).selectedModel).toBe('undeclared:14b');
  });

  it('the legacy reliability estimate is a coarse fit bucket, never a global score', () => {
    // 0.79 is under the 0.82 validation-repair floor, yet it still executes when it is all there is.
    expect(select([candidate('only:14b', { reliability: 0.79 })]).selectedModel).toBe('only:14b');
    // Two candidates in the same bucket are not ordered by their estimates (0.83 vs 0.96, both comfortable): identity decides.
    const result = select([candidate('b:14b', { reliability: 0.96 }), candidate('a:14b', { reliability: 0.83 })]);
    expect(result.selectedModel).toBe('a:14b');
    expect(result.routing.alternatives[1].behindBecauseOf).toBe('identity');
    // A strong general fit is a different bucket from merely clearing the bar (medium coding bar is 0.76).
    const medium = classifyTaskRequirements('', { repositoryExploration: true, toolCalling: true, fileMutation: true, validationRepair: false, codingComplexity: 'medium' });
    expect(select([candidate('a:14b', { reliability: 0.78 }), candidate('b:14b', { reliability: 0.9 })], { requirements: medium }).selectedModel).toBe('b:14b');
    // The estimate matters only as the bucket: below the floor ranks behind meeting it, however close.
    expect(select([candidate('a:14b', { reliability: 0.81 }), candidate('b:14b', { reliability: 0.82 })]).selectedModel).toBe('b:14b');
  });

  it('meaningful empirical evidence outranks a higher heuristic reliability', () => {
    const result = select([
      candidate('heuristic:30b', { reliability: 0.95 }),
      candidate('proven:14b', { reliability: 0.85, qualification: evidence(18, 20, 3) }),
    ]);
    expect(result.selectedModel).toBe('proven:14b');
    expect(result.routing.empiricalEvidenceUsed).toBe(true);
    expect(result.routing.why).toContain('Relevant qualification evidence (benchmark 18/20 across 3 scenarios)');
    expect(result.routing.why.join(' ')).toMatch(/Preferred over 1 compatible alternative: it has stronger benchmark evidence/);
  });

  it('tiny or single-scenario evidence never dominates', () => {
    for (const thin of [evidence(8, 8, 1), evidence(2, 2, 2), evidence(4, 4, 1)]) {
      const withThin = select([candidate('other:30b'), candidate('lucky:14b', { qualification: thin })]);
      const without = select([candidate('other:30b'), candidate('lucky:14b')]);
      expect(withThin.selectedModel).toBe(without.selectedModel);
      expect(withThin.routing.empiricalEvidenceUsed).toBe(false);
    }
  });

  it('a meaningful poor record ranks below an unmeasured model but stays usable', () => {
    const poor = candidate('poor:30b', { reliability: 0.95, qualification: evidence(2, 12, 3) });
    expect(select([poor, candidate('unmeasured:14b', { reliability: 0.85 })]).selectedModel).toBe('unmeasured:14b');
    const alone = select([poor]);
    expect(alone.selectedModel).toBe('poor:30b');
    expect(alone.belowPreferredConfidence).toBe(true);
  });

  it('a configured default does not outrank task fit or stronger evidence in AUTO', () => {
    const belowFit = select([
      candidate('chosen:8b', { reliability: 0.7, explicitlyConfigured: true }),
      candidate('capable:30b', { reliability: 0.95 }),
    ]);
    expect(belowFit.selectedModel).toBe('capable:30b');
    const lessEvidence = select([
      candidate('chosen:14b', { explicitlyConfigured: true }),
      candidate('proven:30b', { qualification: evidence(19, 20, 3) }),
    ]);
    expect(lessEvidence.selectedModel).toBe('proven:30b');
  });

  it('a configured default is a late tie-break: it wins when everything above it ties, even over a lighter model', () => {
    const result = select([
      candidate('light:7b', { reliability: 0.85 }),
      candidate('chosen:30b', { reliability: 0.85, explicitlyConfigured: true }),
    ]);
    expect(result.selectedModel).toBe('chosen:30b');
    expect(result.routing.alternatives[1].behindBecauseOf).toBe('configured_default');
  });

  it('MANUAL is how an operator pins a model, and it outranks any AUTO ordering', () => {
    const result = select([
      candidate('pinned:8b', { reliability: 0.7 }),
      candidate('proven:30b', { qualification: evidence(19, 20, 3) }),
    ], { userOverride: { provider: 'ollama', model: 'pinned:8b' } });
    expect(result.selectedModel).toBe('pinned:8b');
    expect(result.routing.selectionMode).toBe('manual');
  });

  it('strong evidence supersedes a heuristic below the reliability floor, with no stale advisory', () => {
    const result = select([candidate('proven-small:3b', { reliability: 0.5, qualification: evidence(9, 10, 3) })]);
    expect(result.selectedModel).toBe('proven-small:3b');
    expect(result.belowPreferredConfidence).toBe(false);
    expect(result.eligibilityReason).toBe('No advisory concern.');
  });

  it('prefers a model that is already loaded when everything above it ties, and ignores partial residency data', () => {
    const warm = candidate('zzz-warm:14b', { resident: true });
    const cold = candidate('aaa-cold:14b', { resident: false });
    expect(select([cold, warm]).selectedModel).toBe('zzz-warm:14b');
    expect(select([cold, warm]).routing.why).toContain('Available locally and already loaded');
    expect(select([cold, warm, candidate('mmm-unknown:14b')]).selectedModel).toBe('aaa-cold:14b');
  });

  it('the choice does not depend on candidate order', () => {
    const pool = [
      candidate('a:14b', { reliability: 0.85 }),
      candidate('b:14b', { reliability: 0.85, qualification: evidence(9, 10, 3, 20_000) }),
      candidate('c:30b', { reliability: 0.92 }),
      candidate('d:7b', { reliability: 0.6, explicitlyConfigured: false }),
    ];
    const expected = select(pool).selectedModel;
    expect(select([...pool].reverse()).selectedModel).toBe(expected);
    expect(select([pool[2], pool[0], pool[3], pool[1]]).selectedModel).toBe(expected);
    expect(expected).toBe('b:14b');
  });

  it('records which models were compared, bounded', () => {
    const many = Array.from({ length: 9 }, (_, index) => candidate(`m${index}:14b`));
    const result = select(many);
    expect(result.routing.compatibleCandidateCount).toBe(9);
    expect(result.routing.alternatives.length).toBeLessThanOrEqual(5);
    expect(result.routing.alternatives[0].model).toBe(result.selectedModel);
  });
});

describe('M50 MANUAL selection', () => {
  const pool = () => [
    candidate('weak:7b', { reliability: 0.5, qualification: evidence(1, 12, 3) }),
    candidate('strong:30b', { reliability: 0.95, qualification: evidence(19, 20, 3) }),
  ];

  it('preserves the user choice and ignores soft ranking', () => {
    const result = select(pool(), { userOverride: { provider: 'ollama', model: 'weak:7b' } });
    expect(result.selectedModel).toBe('weak:7b');
    expect(result.overridden).toBe(true);
    expect(result.routing.selectionMode).toBe('manual');
    expect(result.routing.why[0]).toBe('Your selected model');
    expect(result.routing.why.join(' ')).toMatch(/Advisory only/);
  });

  it('refuses a hard-incompatible manual model with the precise reasons and never substitutes', () => {
    const models = [
      candidate('tiny-context:7b', { capabilities: { contextWindow: 1_024 } }),
      candidate('strong:30b'),
    ];
    try {
      select(models, { userOverride: { provider: 'ollama', model: 'tiny-context:7b' } });
      expect.unreachable('a hard-incompatible manual model must be refused');
    } catch (error) {
      const refusal = error as TaskModelSelectionError;
      expect(refusal).toBeInstanceOf(TaskModelSelectionError);
      expect(refusal.code).toBe('override_incompatible');
      expect(refusal.hardReasons.join(' ')).toMatch(/Context window 1024 is below required/);
    }
  });
});

describe('M50 FORCED (benchmark) selection', () => {
  it('keeps the exact forced model although a better-ranked model exists', () => {
    const result = select([
      candidate('forced:7b', { reliability: 0.5 }),
      candidate('best:30b', { reliability: 0.95, qualification: evidence(20, 20, 4) }),
    ], { userOverride: { provider: 'ollama', model: 'forced:7b' }, benchmarkForced: true });
    expect(result.selectedModel).toBe('forced:7b');
    expect(result.routing.selectionMode).toBe('forced');
    expect(result.routing.why[0]).toBe('Model forced by the benchmark runner');
  });

  it('never substitutes when the forced model is unavailable', () => {
    expect(() => select([
      candidate('forced:7b', { available: false }),
      candidate('best:30b'),
    ], { userOverride: { provider: 'ollama', model: 'forced:7b' }, benchmarkForced: true })).toThrowError(TaskModelSelectionError);
  });
});

describe('M50 task classification: one source of truth, structured first', () => {
  it('structured hints beat prompt keywords', () => {
    const requirements = classifyTaskRequirements('Refactor the architecture across multiple files and fix the failing tests', {
      fileMutation: false, repositoryExploration: false, toolCalling: false, validationRepair: false, codingComplexity: 'none',
    });
    expect(requirements).toMatchObject({ fileMutation: false, toolCalling: false, codingComplexity: 'none', validationRepair: false });
    expect(requirements.classification).toEqual({ source: 'structured', confidence: 'high' });
  });

  it('an explicit read-only objective overrides mutation keywords found in the prompt', () => {
    const requirements = classifyTaskRequirements('Do not modify any files. Explain how the update function works.');
    expect(requirements.fileMutation).toBe(false);
  });

  it('partial structure is reported as mixed, and the fields no hint set fall back to the prompt', () => {
    const requirements = classifyTaskRequirements('Fix the bug in the parser', { repositoryExploration: true, toolCalling: true });
    expect(requirements.classification).toEqual({ source: 'mixed', confidence: 'medium' });
    expect(requirements.fileMutation).toBe(true);
  });

  it('prompt-only classification is labelled a low-confidence hint', () => {
    expect(classifyTaskRequirements('Fix the bug in the parser').classification).toEqual({ source: 'prompt_hint', confidence: 'low' });
  });

  it('with nothing to go on the routing stays general and conservative', () => {
    const requirements = classifyTaskRequirements('hello there');
    expect(requirements.classification).toEqual({ source: 'general', confidence: 'low' });
    expect(requirements).toMatchObject({ fileMutation: false, toolCalling: false, repositoryExploration: false, codingComplexity: 'none' });
  });

  it('the frozen routing evidence carries the classification source', () => {
    const result = select([candidate('only:14b')]);
    expect(result.routing.classificationSource).toBe('structured');
    const free = selectTaskModel({ provider: 'ollama', requirements: classifyTaskRequirements('hello there'), candidates: [candidate('only:14b')] });
    expect(free.routing.classificationSource).toBe('general');
  });
});

describe('M50 empirical evidence loading', () => {
  it('parses valid entries by exact lowercased name and skips invalid ones', () => {
    const map = parseQualificationEvidence({
      schemaVersion: 1,
      models: {
        'Model-A:20b': { passCount: 9, sampleCount: 10, scenarioCount: 3, medianDurationMs: 25_000 },
        'bad-more-passes': { passCount: 11, sampleCount: 10, scenarioCount: 3 },
        'bad-negative': { passCount: -1, sampleCount: 10, scenarioCount: 3 },
        'bad-shape': 'nope',
      },
    });
    expect([...map.keys()]).toEqual(['model-a:20b']);
    expect(map.get('model-a:20b')).toEqual({ passCount: 9, sampleCount: 10, scenarioCount: 3, medianDurationMs: 25_000 });
  });

  it('routing works with no evidence at all: wrong schema, junk and a missing file are all empty, never an error', () => {
    expect(parseQualificationEvidence(null).size).toBe(0);
    expect(parseQualificationEvidence({ schemaVersion: 2, models: {} }).size).toBe(0);
    expect(parseQualificationEvidence('x').size).toBe(0);
    expect(loadQualificationEvidence(path.join(os.tmpdir(), 'kkd-no-such-evidence-file.json')).size).toBe(0);
    const junk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-evidence-')), 'junk.json');
    fs.writeFileSync(junk, '{ not json');
    expect(loadQualificationEvidence(junk).size).toBe(0);
  });
});

describe('M50 production candidate construction', () => {
  function fakeProvider(models: Record<string, Partial<ModelInfo>>, resident?: string[]): InferenceProvider {
    return {
      providerType: 'ollama',
      healthCheck: async () => undefined,
      listModels: async () => Object.keys(models).map(name => ({ name })),
      getModelContextMetadata: async (model: string) => ({ name: model, ...models[model] }),
      listResidentModels: async () => resident,
    } as unknown as InferenceProvider;
  }

  it('derives the tool protocol from provider evidence and attaches benchmark and residency evidence', async () => {
    const provider = fakeProvider({
      'native-tools:14b': { contextWindow: 32_768, metadata: { capabilities: ['completion', 'tools'] } },
      'inline-tools:custom': { contextWindow: 32_768, metadata: { capabilities: ['completion', 'tools'] } },
      'no-tools:custom': { contextWindow: 32_768, metadata: { capabilities: ['completion'] } },
    });
    // The registry heuristic lists no native tools for a model named like this one.
    ModelCapabilityRegistry.getInstance().setOverride('inline-tools:custom', { tools: false });
    ModelCapabilityRegistry.getInstance().setOverride('no-tools:custom', { tools: false });
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['native-tools:14b', 'inline-tools:custom', 'no-tools:custom'],
      qualificationEvidence: new Map([['native-tools:14b', evidence(9, 10, 3)]]),
      residentModels: ['native-tools:14b'],
    });
    const by = Object.fromEntries(candidates.map(item => [item.model, item]));
    expect(by['native-tools:14b'].toolProtocol).toBe('native');
    expect(by['inline-tools:custom'].toolProtocol).toBe('prompted');
    expect(by['no-tools:custom'].toolProtocol).toBe('none');
    expect(by['native-tools:14b'].qualification).toEqual(evidence(9, 10, 3));
    expect(by['inline-tools:custom'].qualification).toBeUndefined();
    expect(by['native-tools:14b'].resident).toBe(true);
    expect(by['no-tools:custom'].resident).toBe(false);
  });

  it('leaves residency unknown (not cold) when the provider cannot say', async () => {
    const candidates = await buildProductionTaskModelCandidates({
      provider: fakeProvider({ 'm:14b': { contextWindow: 32_768 } }, undefined),
      providerType: 'ollama',
      availableModelNames: ['m:14b'],
    });
    expect(candidates[0].resident).toBeUndefined();
    expect(candidates[0].qualification).toBeUndefined();
  });
});

describe('M50 frozen routing decision on resume', () => {
  const installed = (...names: string[]) => names.map(name => ({ name }));
  const frozen = { frozenProvider: 'ollama', frozenModel: 'chosen:14b', activeProvider: 'ollama' };

  it('reuses the exact frozen model when it is still installed, even though a better-ranked model now exists', () => {
    const check = checkFrozenModelRunnable({ ...frozen, installedModels: installed('chosen:14b', 'later-better:70b') });
    expect(check).toEqual({ runnable: true, verified: true });
  });

  it('is structural only: a model that would rank poorly today is still resumed', () => {
    // The check takes no candidates, scores or evidence at all; there is nothing to re-rank.
    expect(checkFrozenModelRunnable({ ...frozen, installedModels: installed('chosen:14b') }).runnable).toBe(true);
  });

  it('stops with a precise diagnostic when the exact model is no longer installed, never picking a replacement', () => {
    const check = checkFrozenModelRunnable({ ...frozen, installedModels: installed('later-better:70b', 'other:7b') });
    expect(check.runnable).toBe(false);
    if (check.runnable) return;
    expect(check.code).toBe('frozen_model_not_installed');
    expect(check.diagnostic).toContain('ollama:chosen:14b');
    expect(check.diagnostic).toContain('No replacement was selected');
    expect(check.diagnostic).toContain('start a new attempt');
    expect(check.diagnostic).not.toContain('later-better');
  });

  it('stops when the active provider is no longer the frozen provider', () => {
    const check = checkFrozenModelRunnable({ ...frozen, activeProvider: 'openai', installedModels: installed('chosen:14b') });
    expect(check).toMatchObject({ runnable: false, code: 'frozen_provider_changed' });
  });

  it('does not declare a model missing on no evidence: an unlistable provider leaves the same model to dispatch', () => {
    expect(checkFrozenModelRunnable({ ...frozen, installedModels: undefined })).toEqual({ runnable: true, verified: false });
    expect(checkFrozenModelRunnable({ ...frozen, installedModels: [] })).toEqual({ runnable: true, verified: false });
  });

  it('matches by provider-published alias and case-insensitively', () => {
    expect(checkFrozenModelRunnable({ ...frozen, frozenModel: 'Chosen:14B', installedModels: installed('chosen:14b') }).runnable).toBe(true);
    expect(checkFrozenModelRunnable({ ...frozen, installedModels: [{ name: 'chosen:14b-q4', aliases: ['chosen:14b'] }] }).runnable).toBe(true);
  });
});
