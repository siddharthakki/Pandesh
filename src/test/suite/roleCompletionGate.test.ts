import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { Config } from '../../config/Config';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ResolvedModelDefaults } from '../../config/ResolvedModelDefaults';
import { MockProvider } from '../mocks/MockProvider';

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

describe('specialist completion gate', () => {
  let root: string;
  let provider: MockProvider;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-role-gate-'));
    provider = new MockProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vi.spyOn(Config, 'getSequentialRolesEnabled').mockReturnValue(true);
    vi.spyOn(Config, 'getTrustedAutonomyEnabled').mockReturnValue(false);
    vi.spyOn(Config, 'getMaxReviewerRepairPasses').mockReturnValue(0);
    // agentModel/reviewerModel default to '' ("Auto" — see Defaults.ts);
    // simulated here as AgentPanel.loadModels() would populate it in real
    // usage (see Config.ts / ResolvedModelDefaults).
    ResolvedModelDefaults.set('agent', 'qwen3-coder:30b');
    ResolvedModelDefaults.set('reviewer', 'qwen3-coder:30b');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    ResolvedModelDefaults.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('retracts implementation completion when Validator rejects mechanical evidence', async () => {
    provider
      .enqueueText(JSON.stringify({
        taskSummary: 'Inspect and validate',
        acceptanceCriteria: ['Acceptance command passes'],
        risks: [],
        allowedPaths: ['**/*'],
        recommendedValidation: ['node -e "process.exit(0)"'],
      }))
      .enqueueText(JSON.stringify({
        summary: 'One bounded step',
        steps: [{ id: 'step-1', objective: 'Inspect', files: [], validation: [] }],
        assumptions: [],
      }))
      .enqueueText('Implementation complete.')
      .enqueueText(JSON.stringify({
        summary: 'No blocking code findings',
        blocking: false,
        findings: [],
      }))
      .enqueueText(JSON.stringify({
        passed: false,
        summary: 'Required evidence is insufficient.',
        requiredGatesPassed: false,
        reviewerBlocking: false,
        commandsRun: [],
      }));

    const runtime = new AgentRuntime(root, secretStorage());
    const errors: string[] = [];
    await runtime.run(
      'Inspect the project.',
      'agent',
      { onError: message => errors.push(message) },
      undefined,
      undefined,
      'role-gate-task',
      {
        validationCommands: [
          { category: 'acceptance', command: 'node -e "process.exit(0)"', required: true },
        ],
      },
    );

    const snapshot = await runtime.getTask('role-gate-task');
    expect(snapshot.phase).toBe('blocked');
    expect(snapshot.task.status).toBe('blocked');
    expect(errors.some(message => message.includes('Validator rejected'))).toBe(true);

    const events = await runtime.taskStore.getEvents('role-gate-task');
    expect(events.events.some(event =>
      event.type === 'phase_transition'
      && event.payload['from'] === 'completed'
      && event.payload['to'] === 'blocked'
      && event.payload['reason'] === 'validator_rejected',
    )).toBe(true);

    const workflow = JSON.parse(await fs.readFile(
      path.join(runtime.taskStore.getTaskDir('role-gate-task'), 'role-workflow.json'),
      'utf8',
    ));
    expect(workflow.finalStatus).toBe('failed');
    expect(workflow.validatorPassed).toBe(false);
  });
});
