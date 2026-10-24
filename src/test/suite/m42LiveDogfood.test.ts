/**
 * M42 REAL dogfood: the real AutonomousTaskRuntime + real governed executor + a REAL local Ollama model.
 *
 * Skipped unless OLLAMA_AGENT_RUN_LIVE_M42=1 (run via `npm run test:live:m42`). Nothing here mocks the
 * model: the only injected behavior is optional and explicit — `OLLAMA_AGENT_M42_INJECT_INCIDENT=1`
 * replays the failure class that triggered M42 (a proposal that edits a file it never read and carries
 * no content) for as long as the runtime has NOT yet supplied evidence; from then on every call goes to
 * the real model. The task text never names the answer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import { DurableTaskQueue, IsolatedWorktreeManager, TaskResourceScheduler, createDefaultAutonomousTask } from '../../autonomous/M15AutonomousWork';
import { TaskBudgetLedger } from '../../autonomous/TaskControl';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';
import { ProviderGateway } from '../../providers/ProviderGateway';
import type { InferenceProvider, ModelInfo, ProviderChatOptions } from '../../providers/ProviderTypes';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

const enabled = process.env.OLLAMA_AGENT_RUN_LIVE_M42 === '1';
const injectIncident = process.env.OLLAMA_AGENT_M42_INJECT_INCIDENT === '1';
const MODEL = process.env.OLLAMA_AGENT_M42_MODEL ?? 'qwen3.8:27b-mtp-q4_K_M';

const PRICING = `'use strict';
// Storefront pricing helpers.

const TAX_RATE = 0.2;

function roundToCents(value) {
  return Math.floor(value * 100) / 100;
}

function lineTotal(unitPrice, quantity) {
  return roundToCents(unitPrice * quantity);
}

function applyDiscount(total, percent) {
  if (percent <= 0) return total;
  return roundToCents(total - total * (percent / 100));
}

function withTax(total) {
  return roundToCents(total * (1 + TAX_RATE));
}

function orderTotal(lines, discountPercent = 0) {
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line.unitPrice, line.quantity), 0);
  return withTax(applyDiscount(subtotal, discountPercent));
}

module.exports = { roundToCents, lineTotal, applyDiscount, withTax, orderTotal };
`;

const PRICING_TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lineTotal, applyDiscount, orderTotal } = require('../src/pricing');

test('line totals are rounded to the nearest cent', () => {
  assert.equal(lineTotal(19.999, 1), 20);
  assert.equal(lineTotal(0.1, 3), 0.3);
  assert.equal(lineTotal(1.005, 3), 3.02);
});

test('discounts are rounded to the nearest cent', () => {
  assert.equal(applyDiscount(9.99, 15), 8.49);
});

test('order totals include tax and stay cent-exact', () => {
  assert.equal(orderTotal([{ unitPrice: 4.995, quantity: 2 }], 10), 10.79);
});
`;

/** Every provider call across all per-dispatch provider instances. */
const allCalls: Array<{ call: number; injected: boolean; model?: string; ms: number; recoveryNotes: boolean }> = [];

class IncidentProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly real: InferenceProvider) {}
  healthCheck(): Promise<void> { return this.real.healthCheck(); }
  listModels(): Promise<ModelInfo[]> { return this.real.listModels(); }
  async chat(messages: ChatMessage[], tools: ToolDefinition[], options: ProviderChatOptions): Promise<ChatResponse> {
    const started = Date.now();
    const prompt = messages.map(message => message.content).join('\n');
    const call = allCalls.length + 1;
    const recoveryNotes = prompt.includes('Runtime recovery notes');
    // While the runtime has NOT supplied evidence, the (simulated) weak model keeps failing the same way,
    // including on the compact repair request that lists operation_content_required.
    if (injectIncident && !recoveryNotes && (prompt.includes('Investigation turn') || prompt.includes('operation_content_required'))) {
      allCalls.push({ call, injected: true, model: options.model, ms: Date.now() - started, recoveryNotes });
      // The incident: an edit to an unread file with no content.
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            action: 'submit_proposal',
            proposal: {
              version: 1,
              taskSummary: 'Fix rounding in pricing',
              operations: [{ type: 'replace', path: 'src/pricing.js', reason: 'fix rounding' }],
              validationCommands: [{ kind: 'npm-script', script: 'test' }],
              warnings: [],
              status: 'proposed',
            },
          }),
        },
        done: true,
      };
    }
    const response = await this.real.chat(messages, tools, options);
    allCalls.push({ call, injected: false, model: options.model, ms: Date.now() - started, recoveryNotes });
    return response;
  }
}

function context(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: {
      packageJSON: {
        scripts: { 'test:live:m16': 'node scripts/live-m16-acceptance.mjs' },
        contributes: { commands: [{ command: 'ollama-agent.runEvaluationSuite' }, { command: 'ollama-agent.showQualityGateDecision' }] },
      },
    },
  } as unknown as vscode.ExtensionContext;
}

async function git(root: string, args: string[]): Promise<string> {
  const { execFile } = await import('child_process');
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

describe.skipIf(!enabled)('M42 live dogfood (real local model, real autonomous runtime)', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m42-live-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'test'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'pricing-fixture',
      version: '1.0.0',
      scripts: { test: 'node --test test/pricing.test.js', verify: 'node --test test/pricing.test.js' },
    }, null, 2));
    await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n');
    await fs.writeFile(path.join(root, 'src', 'pricing.js'), PRICING);
    await fs.writeFile(path.join(root, 'test', 'pricing.test.js'), PRICING_TEST);
    for (const args of [['init'], ['config', 'user.email', 'dogfood@example.test'], ['config', 'user.name', 'M42 Dogfood'], ['add', '.'], ['commit', '-m', 'pricing fixture']]) {
      await git(root, args);
    }
  });

  afterAll(async () => {
    if (process.env.OLLAMA_AGENT_M42_KEEP !== '1') {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      console.log(`M42_LIVE fixture kept at ${root}`);
    }
  });

  it(`recovers from the incomplete-proposal failure class on the SAME task and reaches COMPLETE (model=${MODEL}, injectIncident=${injectIncident})`, async () => {
    // Fixture sanity: the hidden tests fail before the fix.
    await expect(new Promise<number>(resolve => {
      import('child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, ['--test', 'test/pricing.test.js'], { cwd: root, stdio: 'ignore', windowsHide: true });
        child.on('close', code => resolve(code ?? 1));
      });
    })).resolves.not.toBe(0);

    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', MODEL);
    vscodeMock._setConfig('ollama-agent.requestTimeout', 900_000);
    const realCreate = ProviderGateway.create.bind(ProviderGateway);
    vi.spyOn(ProviderGateway, 'create').mockImplementation(async (...args: Parameters<typeof ProviderGateway.create>) => {
      return new IncidentProvider(await realCreate(...args));
    });
    const cloudSpy = vi.spyOn(ProviderGateway, 'resolveCloudFallback');

    const queue = new DurableTaskQueue(root);
    const runtime = new AutonomousTaskRuntime(
      context(), root, queue,
      new TaskResourceScheduler({ maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 } }),
      new IsolatedWorktreeManager(root),
    );
    runtime.onProposalApprovalRequired(async task => {
      if (task.pendingProposal) await runtime.approveProposal(task.taskId, task.pendingProposal.proposalId).catch(() => undefined);
    });
    runtime.onMutationApprovalRequired(async task => {
      if (task.pendingMutationApproval) await runtime.approveMutation(task.taskId, task.pendingMutationApproval.requestId).catch(() => undefined);
    });

    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'Fix the rounding bug in the pricing module so money amounts are rounded to the nearest cent.'));
    const started = Date.now();
    runtime.wake();
    await runtime.waitForIdle();
    const afterRun = await queue.get(task.taskId);
    const progress = (await queue.events(task.taskId)).filter(event => event.type === 'progress').map(event => String(event.payload.progress));

    console.log('M42_LIVE state', afterRun?.state, JSON.stringify(afterRun?.failure ?? null));
    console.log('M42_LIVE decisions\n' + progress.filter(line => line.startsWith('recovery_') || line.startsWith('proposal_ungrounded') || line.startsWith('validation_')).join('\n'));
    console.log('M42_LIVE model calls', JSON.stringify(allCalls));

    expect(afterRun?.state).toBe('waiting_for_delivery_approval');
    await runtime.approveDelivery(task.taskId);
    const completed = await queue.get(task.taskId);
    expect(completed?.state).toBe('completed');

    // Evidence: same task, journal, ledger, real diff, real validation, zero cloud.
    expect((await queue.list()).map(item => item.taskId)).toEqual([task.taskId]);
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    const summary = await TaskBudgetLedger.readSummary(root, task.taskId);
    console.log('M42_LIVE journal passes', journal.state.passes, 'decisions', JSON.stringify(journal.state.decisions.map(decision => `${decision.action}${decision.cause ? `/${decision.cause}` : ''}`)));
    console.log('M42_LIVE evidence', JSON.stringify([...journal.state.evidence.entries()].map(([file, entries]) => [file, entries.map(entry => `${entry.source}:${entry.contentHash.slice(7, 15)}`)])));
    console.log('M42_LIVE ledger', JSON.stringify({ totals: summary?.totals, recovery: summary?.recoveryByFailureClass, wouldBlock: summary?.wouldBlockCount }));
    console.log('M42_LIVE wall_ms', Date.now() - started);
    expect(journal.state.terminal).toMatchObject({ terminalState: 'COMPLETE' });
    expect(cloudSpy).not.toHaveBeenCalled();
    if (injectIncident) {
      expect(journal.state.decisions.some(decision => decision.action === 'REINVESTIGATE' && decision.cause === 'grounding_failure')).toBe(true);
      expect(journal.state.evidence.get('src/pricing.js')?.some(entry => entry.source === 'runtime_seed')).toBe(true);
    }
    const delivered = await fs.readFile(path.join(root, 'src', 'pricing.js'), 'utf8');
    console.log('M42_LIVE delivered pricing.js diff:\n' + await git(root, ['diff', 'HEAD~1', 'HEAD', '--', 'src/pricing.js']));
    expect(delivered).not.toBe(PRICING);
    // The delivered workspace really passes the (hidden-to-the-model) tests.
    const code = await new Promise<number>(resolve => {
      import('child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, ['--test', 'test/pricing.test.js'], { cwd: root, stdio: 'inherit', windowsHide: true });
        child.on('close', exit => resolve(exit ?? 1));
      });
    });
    expect(code).toBe(0);
    runtime.dispose();
  }, 25 * 60_000);
});
