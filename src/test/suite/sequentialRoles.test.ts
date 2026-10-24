import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { Config } from '../../config/Config';
import { ResolvedModelDefaults } from '../../config/ResolvedModelDefaults';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { MockProvider } from '../mocks/MockProvider';

// agentModel/reviewerModel default to '' ("Auto" — see Defaults.ts); in real
// usage AgentPanel.loadModels() always runs discovery before a real request
// can be sent and populates ResolvedModelDefaults with what Auto actually
// selected (see Config.ts). These tests simulate that same ordering using a
// real ModelCapabilityRegistry-known name (not an arbitrary placeholder), so
// context-window/capability-dependent logic sees the same values a genuine
// discovered model would have.
const AUTO_AGENT_MODEL = 'qwen3-coder:30b';
const AUTO_REVIEWER_MODEL = 'qwen3-coder:30b';

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

describe('sequential specialist roles', () => {
  let root: string;
  let provider: MockProvider;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-roles-'));
    provider = new MockProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vi.spyOn(Config, 'getSequentialRolesEnabled').mockReturnValue(true);
    vi.spyOn(Config, 'getMaxReviewerRepairPasses').mockReturnValue(1);
    vi.spyOn(Config, 'getProgressHeartbeatMs').mockReturnValue(5000);
    runtime = new AgentRuntime(root, secretStorage());
    ResolvedModelDefaults.clear();
    ResolvedModelDefaults.set('agent', AUTO_AGENT_MODEL);
    ResolvedModelDefaults.set('reviewer', AUTO_REVIEWER_MODEL);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    ResolvedModelDefaults.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runs Supervisor, Planner, Implementer, Reviewer, and Validator with persisted handoffs', async () => {
    vi.spyOn(Config, 'getTrustedAutonomyEnabled').mockReturnValue(true);
    provider
      .enqueueText(JSON.stringify({
        taskSummary: 'Inspect the temporary project',
        acceptanceCriteria: ['Required acceptance command passes'],
        risks: ['Avoid unrelated files'],
        allowedPaths: ['**/*'],
        recommendedValidation: ['node -e "process.exit(0)"'],
      }))
      .enqueueText(JSON.stringify({
        summary: 'Inspect and validate',
        steps: [{
          id: 'step-1',
          objective: 'Inspect the project and finish without unnecessary edits',
          files: [],
          validation: ['node -e "process.exit(0)"'],
        }],
        assumptions: [],
      }))
      .enqueueText('Implementation completed without workspace changes.')
      .enqueueText(JSON.stringify({
        summary: 'No blocking findings',
        blocking: false,
        findings: [],
      }))
      .enqueueText(JSON.stringify({
        passed: true,
        summary: 'Mechanical validation and review support completion.',
        requiredGatesPassed: true,
        reviewerBlocking: false,
        commandsRun: ['node -e "process.exit(0)"'],
      }));

    const done: string[] = [];
    await runtime.run(
      'Inspect the project and validate it.',
      'agent',
      { onDone: content => done.push(content) },
      undefined,
      undefined,
      'roles-conversation',
      {
        validationCommands: [
          { category: 'acceptance', command: 'node -e "process.exit(0)"', required: true },
        ],
        allowedPaths: ['**/*'],
      },
    );

    expect(done).toHaveLength(1);
    expect(provider.capturedRequests).toHaveLength(5);
    expect(provider.capturedRequests[0].messages[0].content).toContain('Supervisor');
    expect(provider.capturedRequests[1].messages[0].content).toContain('Planner');
    expect(provider.capturedRequests[2].tools.length).toBeGreaterThan(0);
    expect(provider.capturedRequests[3].messages[0].content).toContain('Reviewer');
    expect(provider.capturedRequests[4].messages[0].content).toContain('Validator');

    const taskId = runtime.getTaskId();
    expect(taskId).toBe('roles-conversation');
    const taskDir = runtime.taskStore.getTaskDir(taskId!);
    for (const filename of [
      'task.json',
      'contract.json',
      'plan.json',
      'implementation.json',
      'review.json',
      'validation.json',
      'role-workflow.json',
      'heartbeat.json',
    ]) {
      await expect(fs.stat(path.join(taskDir, filename))).resolves.toBeDefined();
    }

    const contract = JSON.parse(await fs.readFile(path.join(taskDir, 'contract.json'), 'utf8'));
    expect(contract.status).toBe('approved');
    expect(contract.approvedBy).toBe('trusted-setting');

    const workflow = JSON.parse(await fs.readFile(path.join(taskDir, 'role-workflow.json'), 'utf8'));
    expect(workflow.finalStatus).toBe('completed');
    expect(workflow.repairPasses).toBe(0);
    expect(workflow.artifacts).toEqual([
      'task.json', 'plan.json', 'implementation.json', 'review.json', 'validation.json',
    ]);

    const heartbeat = JSON.parse(await fs.readFile(path.join(taskDir, 'heartbeat.json'), 'utf8'));
    expect(heartbeat.stopped).toBe(true);
  });

  it('performs one bounded repair turn when Reviewer reports a blocking finding', async () => {
    vi.spyOn(Config, 'getTrustedAutonomyEnabled').mockReturnValue(false);
    provider
      .enqueueText(JSON.stringify({
        taskSummary: 'Implement and review',
        acceptanceCriteria: ['Validation passes'],
        risks: [],
        allowedPaths: ['**/*'],
        recommendedValidation: ['node -e "process.exit(0)"'],
      }))
      .enqueueText(JSON.stringify({
        summary: 'One implementation step',
        steps: [{ id: 'step-1', objective: 'Implement', files: [], validation: [] }],
        assumptions: [],
      }))
      .enqueueText('Initial implementation complete.')
      .enqueueText(JSON.stringify({
        summary: 'A blocking issue remains',
        blocking: true,
        findings: [{
          severity: 'blocking',
          file: 'src/example.ts',
          message: 'The edge case is not handled.',
          remediation: 'Handle the edge case and validate it.',
        }],
      }))
      .enqueueText('Repair implementation complete.')
      .enqueueText(JSON.stringify({
        summary: 'Blocking issue resolved',
        blocking: false,
        findings: [],
      }))
      .enqueueText(JSON.stringify({
        passed: true,
        summary: 'Repair validated.',
        requiredGatesPassed: true,
        reviewerBlocking: false,
        commandsRun: ['node -e "process.exit(0)"'],
      }));

    const done: string[] = [];
    await runtime.run(
      'Implement the requested edge case.',
      'agent',
      { onDone: content => done.push(content) },
      undefined,
      undefined,
      'roles-repair-conversation',
      {
        validationCommands: [
          { category: 'acceptance', command: 'node -e "process.exit(0)"', required: true },
        ],
      },
    );

    expect(done).toHaveLength(1);
    expect(provider.capturedRequests).toHaveLength(7);
    const finalTaskId = runtime.getTaskId();
    expect(finalTaskId).toMatch(/^roles-repair-conversation_turn_/);
    const workflow = JSON.parse(await fs.readFile(
      path.join(runtime.taskStore.getTaskDir(finalTaskId!), 'role-workflow.json'),
      'utf8',
    ));
    expect(workflow.repairPasses).toBe(1);
    expect(workflow.finalStatus).toBe('completed');
  });
});
