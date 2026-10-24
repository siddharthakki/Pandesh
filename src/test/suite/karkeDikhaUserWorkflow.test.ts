import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AutonomousTaskRuntime, type KarkeDikhaLifecycleAuthority } from '../../activation/M15AutonomousRuntime';
import { DurableTaskQueue, IsolatedWorktreeManager, TaskResourceScheduler, createDefaultAutonomousTask } from '../../autonomous/M15AutonomousWork';
import { ProviderGateway } from '../../providers/ProviderGateway';
import type { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';
import { openCoreDatabase } from '../../../core/db/openCore';
import { submitRequest } from '../../../core/domain/submission';
import { getAttempt } from '../../../core/domain/attempts';
import {
  beginKarkeDikhaValidation, cancelKarkeDikhaAttempt, claimKarkeDikhaAttempt,
  completeKarkeDikhaAttempt, failKarkeDikhaAttempt, recordKarkeDikhaExecutionQuality,
  reportKarkeDikhaValidation, requestKarkeDikhaApproval, resolveKarkeDikhaApproval,
  type KarkeDikhaWorkerCredentials,
} from '../../../core/domain/karkeDikhaLifecycle';
import type { ApprovalRecord } from '../../../core/shared/wireTypes';

const run = promisify(execFile);
const TASK = 'Add validation so registerUser rejects an empty username and update the relevant tests.';
const USERS = `'use strict';\n\nconst users = [];\n\nfunction registerUser(username) {\n  users.push(username);\n  return { username };\n}\n\nfunction listUsers() {\n  return users.slice();\n}\n\nmodule.exports = { registerUser, listUsers };\n`;
const TESTS = `'use strict';\n\nconst assert = require('node:assert');\nconst { registerUser, listUsers } = require('./users');\n\nfunction testRegisterUserAddsUser() {\n  const before = listUsers().length;\n  const result = registerUser('alice');\n  assert.strictEqual(result.username, 'alice');\n  assert.strictEqual(listUsers().length, before + 1);\n}\n\nfunction testRegisterUserRejectsEmptyUsername() {\n  assert.throws(() => registerUser(''), /Username cannot be empty/);\n}\n\nmodule.exports = { testRegisterUserAddsUser, testRegisterUserRejectsEmptyUsername };\n`;
const UPDATED_USERS = USERS.replace('function registerUser(username) {\n', "function registerUser(username) {\n  if (username === '') throw new Error('Username cannot be empty');\n");

class WorkflowProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly prompts: string[] = [];
  async healthCheck() {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: 'fixture-coder', contextWindow: 32_768 }]; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    const prompt = messages.map(message => message.content).join('\n');
    this.prompts.push(prompt);
    const proposal = {
      version: 1, taskSummary: 'Reject empty usernames',
      operations: [
        { type: 'replace', path: 'src/users.js', reason: 'Validate username', content: UPDATED_USERS },
        { type: 'replace', path: 'src/users.test.js', reason: 'Cover rejection', content: TESTS },
      ],
      validationCommands: [{ kind: 'npm-script', script: 'test' }], warnings: [], status: 'proposed',
    };
    // The lightweight tier now runs through the bounded pre-proposal
    // investigation loop, which requests an action envelope rather than a
    // bare CodingProposal.
    const body = prompt.includes('Investigation turn') ? { action: 'submit_proposal', proposal } : proposal;
    return { done: true, message: { role: 'assistant', content: JSON.stringify(body) } };
  }
}

async function git(root: string, ...args: string[]) { return (await run('git', args, { cwd: root, windowsHide: true })).stdout.trim(); }
function extensionContext(): vscode.ExtensionContext {
  return { subscriptions: [], extension: { packageJSON: {
    scripts: { 'test:live:m16': 'node scripts/live-m16-acceptance.mjs' },
    contributes: { commands: [{ command: 'ollama-agent.runEvaluationSuite' }, { command: 'ollama-agent.showQualityGateDecision' }] },
  } } } as vscode.ExtensionContext;
}
function decision(approval: ApprovalRecord, credentials: KarkeDikhaWorkerCredentials, resolution: 'approved' | 'rejected') {
  return { ...credentials, resolution, attemptId: approval.attemptId, gate: approval.kind,
    expectedAttemptRevision: approval.expectedAttemptRevision, expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest, expectedRevision: approval.revision, actor: 'test' } as const;
}

describe('Karke Dikha deterministic user workflow', () => {
  let root: string;
  let provider: WorkflowProvider;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-karke-workflow-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'test'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/users.js'), USERS);
    await fs.writeFile(path.join(root, 'src/users.test.js'), TESTS.replace("function testRegisterUserRejectsEmptyUsername() {\n  assert.throws(() => registerUser(''), /Username cannot be empty/);\n}\n\n", '').replace(', testRegisterUserRejectsEmptyUsername', ''));
    await fs.writeFile(path.join(root, 'test/run-all.js'), "for (const fn of Object.values(require('../src/users.test'))) fn();\n");
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node test/run-all.js' } }));
    await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n.core-test.db*\n');
    for (const args of [['init'], ['config', 'user.email', 'workflow@example.invalid'], ['config', 'user.name', 'Workflow'], ['add', '.'], ['commit', '-m', 'fixture']]) await git(root, ...args);
    provider = new WorkflowProvider();
    vscodeMock._resetConfig();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', 'fixture-coder');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
  });
  afterEach(async () => { vi.restoreAllMocks(); vscodeMock._resetConfig(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('routes, grounds, approves, validates and delivers the accepted two-file change through Core authority', async () => {
    const core = openCoreDatabase(path.join(root, '.core-test.db')).db;
    try {
      const submitted = submitRequest(core, { clientId: 'test', currentMessage: TASK, requestedMode: 'karke_dikha',
        workspaceRoot: root, requestedProvider: 'ollama', requestedModel: 'fixture-coder', capability: { hasWorkspace: true, gitCapable: true }, correlationId: 'workflow' });
      const claimed = claimKarkeDikhaAttempt(core, submitted.attempt.id, { owner: 'workflow', actor: 'test' });
      const credentials: KarkeDikhaWorkerCredentials = { owner: 'workflow', fenceToken: claimed.fence.token, frozenContextHash: claimed.context.contextHash };
      const queue = new DurableTaskQueue(root);
      const resources = new TaskResourceScheduler({ maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 } });
      const worktrees = new IsolatedWorktreeManager(root);
      const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, TASK), taskId: submitted.attempt.id, attemptId: submitted.attempt.id,
        providerModelRoutingSnapshot: { provider: 'ollama', model: 'fixture-coder' }, githubDelivery: { transport: 'fake' } });
      const authority: KarkeDikhaLifecycleAuthority = {
        context: claimed.context,
        heartbeat: async () => undefined,
        requestApproval: async (kind, summary) => requestKarkeDikhaApproval(core, task.attemptId, { ...credentials, kind, summary, actor: 'test' }).approval,
        resolveApproval: async (approval, resolution, disposition) => { resolveKarkeDikhaApproval(core, approval.id, { ...decision(approval, credentials, resolution), disposition }); },
        beginValidation: async () => { beginKarkeDikhaValidation(core, task.attemptId, { ...credentials, actor: 'test' }); },
        reportValidation: async evidence => reportKarkeDikhaValidation(core, task.attemptId, { ...credentials, evidence, actor: 'test' }),
        recordExecutionQuality: async evidence => { recordKarkeDikhaExecutionQuality(core, task.attemptId, { ...credentials, ...evidence, actor: 'test' }); },
        complete: async summary => { completeKarkeDikhaAttempt(core, task.attemptId, { ...credentials, summary, actor: 'test' }); },
        fail: async reason => { failKarkeDikhaAttempt(core, task.attemptId, { ...credentials, failureReason: reason, actor: 'test' }); },
        cancel: async () => { cancelKarkeDikhaAttempt(core, task.attemptId, { ...credentials, actor: 'test' }); },
      };
      const runtime = new AutonomousTaskRuntime(extensionContext(), root, queue, resources, worktrees);
      runtime.requireCoreAuthorityForNewWork();
      runtime.bindCoreAuthority(task.taskId, authority);
      runtime.onProposalApprovalRequired(async current => runtime.approveProposal(current.taskId, current.pendingProposal!.proposalId));
      runtime.onMutationApprovalRequired(async current => runtime.approveMutation(current.taskId, current.pendingMutationApproval!.requestId));
      vscodeMock._setQuickPickSelection({ label: 'Summary: Reject empty usernames' });
      vscodeMock._setWarningMessageSelection('Approve Execution');
      runtime.wake();
      await runtime.waitForIdle();
      const ready = await queue.get(task.taskId);
      expect(ready?.state, JSON.stringify({ failure: ready?.failure, events: await queue.events(task.taskId) }, null, 2)).toBe('waiting_for_delivery_approval');
      expect(ready?.executionProfile).toMatchObject({ tier: 'normal', maxStages: 1 });
      expect(provider.prompts).toHaveLength(1);
      const prompt = provider.prompts[0].replace(/\r\n/g, '\n');
      for (const content of [USERS, 'node:assert', 'node test/run-all.js']) expect(prompt).toContain(content);
      expect(provider.prompts[0]).toContain('COMPLETE current file');
      expect(ready?.validationRepairAttempts ?? 0).toBe(0);
      expect(ready?.mutationEvidence?.changedPaths.sort()).toEqual(['src/users.js', 'src/users.test.js']);
      await runtime.approveDelivery(task.taskId);
      expect((await queue.get(task.taskId))?.state).toBe('completed');
      expect(getAttempt(core, task.attemptId).status).toBe('completed');
      expect((await git(root, 'show', '--format=', '--name-only', 'HEAD')).split(/\r?\n/).sort()).toEqual(['src/users.js', 'src/users.test.js']);
      expect((await run('node', ['test/run-all.js'], { cwd: root, windowsHide: true })).stderr).toBe('');
      runtime.dispose();
    } finally { core.close(); }
  }, 30_000);
});
