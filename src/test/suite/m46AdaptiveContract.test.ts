import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AttemptJournal, progressHistory } from '../../autonomous/recovery/AttemptJournal';
import { RecoveryController } from '../../autonomous/recovery/RecoveryController';
import { RecoverySupervisor } from '../../autonomous/recovery/RecoverySupervisor';
import { emptyDirectives, emptyFacts, type FailureCause, type StageOutcome } from '../../autonomous/recovery/RecoveryTypes';
import { buildFailureFingerprint } from '../../autonomy/FailureFingerprint';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';
import { adaptiveSchemaEnabled, assessProtocolOutcome, classifyContractFailure } from '../../reliability/ContractEnforcement';

const UNKNOWN = 'some-unlisted-model:12b';
let seq = 0;

function outcome(cause: FailureCause | undefined, subcode: string | undefined, extra: Partial<StageOutcome> = {}): StageOutcome {
  seq += 1;
  const ok = cause === undefined;
  return {
    attemptId: 'att', pass: seq, stage: ok ? 'validation' : 'proposal', ok, status: ok ? 'completed' : 'failed', cause, subcode,
    details: subcode ? [subcode] : [], facts: emptyFacts(), fingerprints: { failure: `f-${seq}` },
    model: { provider: 'ollama', model: UNKNOWN }, observedAt: new Date().toISOString(),
    failureFingerprint: ok ? undefined : buildFailureFingerprint({ semantics: [], subcode: subcode ?? cause, failureHash: `f-${seq}`, files: [], actions: '', evidence: undefined }),
    ...extra,
  };
}

describe('contract failure kinds', () => {
  it('separates syntax, key, type and schema failures', () => {
    expect(classifyContractFailure('response_not_json')).toBe('syntax');
    expect(classifyContractFailure('json_parse_failed')).toBe('syntax');
    expect(classifyContractFailure('version_unsupported')).toBe('key');
    expect(classifyContractFailure('operations_required')).toBe('key');
    expect(classifyContractFailure('operation_malformed')).toBe('type');
    expect(classifyContractFailure('content_prohibited_for_delete')).toBe('schema');
    expect(classifyContractFailure(undefined, ['response_not_json'])).toBe('syntax');
    expect(classifyContractFailure('validation_repair_unavailable', ['empty_content'])).toBe('syntax');
  });

  it('adaptive enforcement has one switch (and honours the older one)', () => {
    expect(adaptiveSchemaEnabled({})).toBe(true);
    expect(adaptiveSchemaEnabled({ OLLAMA_AGENT_ADAPTIVE_SCHEMA: '0' })).toBe(false);
    expect(adaptiveSchemaEnabled({ OLLAMA_AGENT_M46_CONSTRAINED: '0' })).toBe(false);
  });
});

describe('protocol failure versus reasoning failure', () => {
  it('no protocol failure means nothing to distinguish', () => {
    expect(assessProtocolOutcome([outcome('validation_failure', 'code_defect')]).verdict).toBe('NO_PROTOCOL_FAILURE');
  });
  it('a protocol failure followed by a completed task: the model knew the answer', () => {
    const verdict = assessProtocolOutcome([outcome('format_failure', 'version_unsupported'), outcome(undefined, undefined)]);
    expect(verdict.verdict).toBe('MODEL_KNEW_ANSWER_BUT_FAILED_PROTOCOL');
    expect(verdict.kinds).toEqual(['key']);
  });
  it('a protocol failure followed by a well-formed wrong proposal: the proposal was incorrect', () => {
    const verdict = assessProtocolOutcome([outcome('format_failure', 'response_not_json'), outcome('validation_failure', 'code_defect')]);
    expect(verdict.verdict).toBe('MODEL_PROPOSAL_INCORRECT');
    expect(verdict.incorrectAfter).toBe(1);
  });
  it('protocol failures only leave the reasoning unobserved, and provider stalls are neither', () => {
    const verdict = assessProtocolOutcome([outcome('format_failure', 'version_unsupported'), outcome('provider_failure', 'timeout'), outcome('format_failure', 'version_unsupported')]);
    expect(verdict.verdict).toBe('PROTOCOL_ONLY_UNOBSERVED');
    expect(verdict.wellFormedAfter).toBe(0);
  });
});

describe('adaptive enforcement in the recovery loop', () => {
  let root: string;
  let journal: AttemptJournal;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-adaptive-'));
    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_a' });
  });
  afterEach(async () => {
    ModelProfileRegistry.clearObservedStructuredOutput();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('a protocol failure does not enter the progress window and is not assessed as a hypothesis', async () => {
    const controller = new RecoveryController({
      journal, candidates: [], modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
      budget: async () => undefined, allocateDecisionSequence: async () => (seq += 1), constrainedOutputAvailable: () => true,
    });
    await controller.decide(outcome('validation_failure', 'code_defect'));
    const decision = await controller.decide(outcome('format_failure', 'version_unsupported'));
    expect(decision.progress).toBeUndefined();
    expect(progressHistory(journal.state)).toHaveLength(1);
  });

  it('records why the contract mode changed, and whether enforcement helped', async () => {
    for (const helped of [true, false]) {
      const taskId = helped ? 'task_h' : 'task_n';
      const supervisor = await RecoverySupervisor.open({
        repositoryRoot: root, taskId, worktreeRoot: root, candidates: [],
        modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
        resolveBaseRevision: async () => undefined,
        adaptiveSchema: true,
      });
      await supervisor.journal.append({ t: 'outcome', outcome: outcome('format_failure', 'version_unsupported') });
      const handle = await supervisor.beginPass({ attemptId: 'att-2', model: { provider: 'ollama', model: UNKNOWN }, directives: { ...emptyDirectives(), strategy: 'constrained_output' } });
      expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe('ollama_format');
      const next = helped ? outcome('validation_failure', 'code_defect') : outcome('format_failure', 'response_not_json');
      await (supervisor as unknown as { judgeConstrainedOutput(o: StageOutcome, h: unknown): Promise<void> }).judgeConstrainedOutput(next, handle);
      const modes = supervisor.journal.state.contractModes;
      expect(modes.map(mode => mode.change)).toEqual(['enforced', helped ? 'kept' : 'released']);
      expect(modes[0]).toMatchObject({ from: 'prompt_only', to: 'provider_schema', trigger: { kind: 'key', subcode: 'version_unsupported' } });
      expect(modes[0].reason).toMatch(/protocol failure, not a reasoning failure/);
      expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe(helped ? 'ollama_format' : 'unsupported');
      supervisor.release();
    }
  });

  it('the mode changes survive a restart (they are journaled)', async () => {
    const supervisor = await RecoverySupervisor.open({
      repositoryRoot: root, taskId: 'task_r', worktreeRoot: root, candidates: [],
      modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
      resolveBaseRevision: async () => undefined, adaptiveSchema: true,
    });
    await supervisor.beginPass({ attemptId: 'a', model: { provider: 'ollama', model: UNKNOWN }, directives: { ...emptyDirectives(), strategy: 'constrained_output' } });
    supervisor.release();
    const reopened = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_r' });
    expect(reopened.state.contractModes).toHaveLength(1);
  });
});

describe('enforcement is a strategy, not a belief', () => {
  it('an unusable reply under the enforced schema reverts to the prompt-only contract once, then changes model', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-release-'));
    try {
      const supervisor = await RecoverySupervisor.open({
        repositoryRoot: root, taskId: 'task_rel', worktreeRoot: root, candidates: [],
        modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
        resolveBaseRevision: async () => undefined, adaptiveSchema: true,
      });
      const model = { provider: 'ollama', model: UNKNOWN };
      const initial = await supervisor.controller.decide(outcome('format_failure', 'version_unsupported', { model }));
      expect(initial.directives.strategy).toBe('constrained_output');
      await supervisor.controller.markDispatched(initial);
      await supervisor.beginPass({ attemptId: 'a1', model, directives: initial.directives });
      expect(supervisor.activeConstrained(model)).toBe(true);
      // The enforced pass still returned an empty completion (a syntax failure).
      const empty = outcome('format_failure', 'validation_repair_unavailable', { details: ['empty_content'], model });
      const first = await supervisor.controller.decide(empty);
      expect(first.action).toBe('FORMAT_REPAIR');
      expect(first.directives.strategy).toBe('prompt_only_contract');
      await supervisor.beginPass({ attemptId: 'a2', model, directives: first.directives });
      expect(supervisor.activeConstrained(model)).toBe(false);
      expect(ModelProfileRegistry.resolve(UNKNOWN, 'ollama').structuredOutput).toBe('unsupported');
      expect(supervisor.journal.state.contractModes.map(mode => mode.change)).toEqual(['enforced', 'released']);
      // A second unusable reply is no longer a contract-mode question.
      const second = await supervisor.controller.decide(outcome('format_failure', 'validation_repair_unavailable', { details: ['empty_content'], model }));
      expect(second.directives.strategy).toBeUndefined();
      supervisor.release();
    } finally {
      ModelProfileRegistry.clearObservedStructuredOutput();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('provider stalls never enter the hypothesis window', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-stall-'));
    try {
      const j = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_stall' });
      await j.append({ t: 'outcome', outcome: outcome('validation_failure', 'code_defect') });
      await j.append({ t: 'outcome', outcome: outcome('provider_failure', 'timeout') });
      await j.append({ t: 'outcome', outcome: outcome('format_failure', 'response_not_json') });
      expect(progressHistory(j.state)).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
