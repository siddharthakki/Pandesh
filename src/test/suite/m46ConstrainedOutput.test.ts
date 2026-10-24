import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';
import { decideStructuredOutput } from '../../reliability/StructuredOutput';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';
import { RecoveryController } from '../../autonomous/recovery/RecoveryController';
import { RecoverySupervisor } from '../../autonomous/recovery/RecoverySupervisor';
import { emptyFacts, emptyDirectives, type StageOutcome } from '../../autonomous/recovery/RecoveryTypes';
import { deriveExecutionEconomy } from '../../autonomy/ExecutionEconomyProfile';

const UNKNOWN = 'some-unlisted-model:12b';
const KNOWN_SUPPORTED = 'qwen2.5-coder:1.5b';

const format = { type: 'json_schema' as const, name: 'x', schema: { type: 'object' } } as never;

describe('M46 constrained decoding as a recovery strategy', () => {
  afterEach(() => ModelProfileRegistry.clearObservedStructuredOutput());

  it('an unknown Ollama model has only the conservative fallback profile, so structured output is off', () => {
    const profile = ModelProfileRegistry.resolve(UNKNOWN, 'ollama');
    expect(profile.fallback).toBe(true);
    expect(profile.structuredOutput).toBe('unsupported');
    expect(decideStructuredOutput({ profile, providerType: 'ollama', toolsActive: false, hasImages: false, requestedFormat: format }).active).toBe(false);
    expect(ModelProfileRegistry.canTryConstrainedOutput(UNKNOWN, 'ollama')).toBe(true);
  });

  it('observing the strategy makes the next dispatch schema-constrained, and clearing restores the fallback', () => {
    expect(ModelProfileRegistry.observeStructuredOutput(UNKNOWN, 'ollama', 'ollama_format')).toBe(true);
    const profile = ModelProfileRegistry.resolve(UNKNOWN, 'ollama');
    expect(profile.structuredOutput).toBe('ollama_format');
    expect(decideStructuredOutput({ profile, providerType: 'ollama', toolsActive: false, hasImages: false, requestedFormat: format }).active).toBe(true);
    // A different model is untouched.
    expect(ModelProfileRegistry.resolve('another-unlisted:7b', 'ollama').structuredOutput).toBe('unsupported');
    ModelProfileRegistry.clearObservedStructuredOutput(UNKNOWN, 'ollama');
    expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe('unsupported');
  });

  it('never overrides a model that has its own profile', () => {
    const before = ModelProfileRegistry.resolve(KNOWN_SUPPORTED, 'ollama');
    expect(before.fallback).toBe(false);
    expect(ModelProfileRegistry.observeStructuredOutput(KNOWN_SUPPORTED, 'ollama', 'unsupported')).toBe(false);
    expect(ModelProfileRegistry.resolve(KNOWN_SUPPORTED, 'ollama')).toBe(before);
    expect(ModelProfileRegistry.canTryConstrainedOutput(KNOWN_SUPPORTED, 'ollama')).toBe(false);
  });

  it('is only offered on a backend that enforces the schema itself', () => {
    expect(ModelProfileRegistry.canTryConstrainedOutput(UNKNOWN, 'openai-compatible')).toBe(false);
  });
});

describe('M46 controller and supervisor use it', () => {
  let root: string;
  let journal: AttemptJournal;
  let seq: number;

  const formatFailure = (model = UNKNOWN): StageOutcome => ({
    attemptId: 'att', pass: 1, stage: 'proposal', ok: false, status: 'invalid_proposal', cause: 'format_failure', subcode: 'version_unsupported',
    details: ['version_unsupported'], facts: emptyFacts(), fingerprints: { failure: `f-${(seq += 1)}` }, model: { provider: 'ollama', model }, observedAt: new Date().toISOString(),
  });

  const controller = (options: { available?: boolean; progressAware?: boolean } = {}) => new RecoveryController({
    journal,
    candidates: [],
    modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
    budget: async () => undefined,
    allocateDecisionSequence: async () => (seq += 1),
    constrainedOutputAvailable: () => options.available ?? true,
    progressAware: options.progressAware,
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-constrained-'));
    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_c' });
    seq = 0;
  });
  afterEach(async () => {
    ModelProfileRegistry.clearObservedStructuredOutput();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('the first format failure changes the decoding strategy, not just the wording', async () => {
    const decision = await controller().decide(formatFailure());
    expect(decision.action).toBe('FORMAT_REPAIR');
    expect(decision.directives.strategy).toBe('constrained_output');
    expect(decision.expectedChange).toContain('changed_approach');
    expect(decision.reason).toMatch(/adaptive contract enforcement/);
  });

  it('is not offered when the model already decodes under a schema, or with adaptive enforcement off', async () => {
    expect((await controller({ available: false }).decide(formatFailure())).directives.strategy).toBeUndefined();
  });

  it('a second format failure is left to the existing ladder (change model), never repeated', async () => {
    const c = controller();
    await c.decide(formatFailure());
    await c.markDispatched(await c.decide(formatFailure()));
    const third = await controller().decide(formatFailure());
    expect(third.directives.strategy).toBeUndefined();
    expect(third.action).not.toBe('FORMAT_REPAIR');
  });

  it('the supervisor installs the strategy for the pass and releases it', async () => {
    const supervisor = await RecoverySupervisor.open({
      repositoryRoot: root, taskId: 'task_c3', worktreeRoot: root, candidates: [],
      modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
      resolveBaseRevision: async () => undefined,
      autonomy: { economyFor: () => deriveExecutionEconomy({ contextWindow: { contextTokens: 8_192, source: 'router_metadata' } }) },
    });
    const directives = { ...emptyDirectives(), strategy: 'constrained_output' as const };
    await supervisor.beginPass({ attemptId: 'att', model: { provider: 'ollama', model: UNKNOWN }, directives });
    expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe('ollama_format');
    supervisor.release();
    expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe('unsupported');
  });
});
