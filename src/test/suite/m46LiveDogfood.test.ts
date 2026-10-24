/**
 * M46 REAL dogfood: the real AutonomousTaskRuntime + real governed executor + a REAL local Ollama model,
 * on a multi-file bug the task text does not locate.
 *
 * Skipped unless OLLAMA_AGENT_RUN_LIVE_M46=1 (run via `node scripts/run-live-m46-dogfood.mjs`).
 * Nothing mocks the model. `OLLAMA_AGENT_M46_AUTONOMY=0` switches the M46 layer off (exactly the M42/M45
 * behaviour), which is the A/B baseline; the default runs it on. Prompt sizes are recorded from the
 * provider boundary so the effect of the Context Pack on what the model actually receives is measured.
 *
 * Env: OLLAMA_AGENT_M46_MODEL, OLLAMA_AGENT_M46_CONTEXT (num_ctx override, tokens), OLLAMA_AGENT_M46_OUT
 * (append one JSON result line), OLLAMA_AGENT_M46_TIMEOUT_MIN (default 20), OLLAMA_AGENT_M46_KEEP=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import { DurableTaskQueue, IsolatedWorktreeManager, TaskResourceScheduler, createDefaultAutonomousTask } from '../../autonomous/M15AutonomousWork';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';
import { assessProtocolOutcome } from '../../reliability/ContractEnforcement';
import { LADDER_FILES, LADDER_TASK, LADDER_TEST_FILES } from './m46LiveLadderFixture';
import { injectedReply, newInjectionState, newWeakValidationState, weakValidationReply } from './m46LiveInjection';
import { CodingValidationRunner } from '../../coding/ValidationRunner';
import { ProviderGateway } from '../../providers/ProviderGateway';
import type { InferenceProvider, ModelInfo, ProviderChatOptions } from '../../providers/ProviderTypes';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

const enabled = process.env.OLLAMA_AGENT_RUN_LIVE_M46 === '1';
const MODEL = process.env.OLLAMA_AGENT_M46_MODEL ?? 'qwen3.8:27b-mtp-q4_K_M';
const AUTONOMY = process.env.OLLAMA_AGENT_M46_AUTONOMY !== '0';
const CONTEXT = Number(process.env.OLLAMA_AGENT_M46_CONTEXT ?? 0);
const TIMEOUT_MIN = Number(process.env.OLLAMA_AGENT_M46_TIMEOUT_MIN ?? 20);
const SCENARIO = process.env.OLLAMA_AGENT_M46_SCENARIO === 'ladder' ? 'ladder' : 'cart';
const ADAPTIVE = process.env.OLLAMA_AGENT_ADAPTIVE_SCHEMA !== '0';
const TASK = SCENARIO === 'ladder' ? LADDER_TASK : 'The cart total is wrong whenever a discount is applied. Find the cause and fix it.';
const TEST_FILES = SCENARIO === 'ladder' ? LADDER_TEST_FILES : ['test/cart.test.js', 'test/users.test.js'];

const FILES: Record<string, string> = SCENARIO === 'ladder' ? LADDER_FILES : {
  'package.json': JSON.stringify({ name: 'shop-fixture', version: '1.0.0', scripts: { test: 'node --test test/cart.test.js test/users.test.js', verify: 'node --test test/cart.test.js test/users.test.js' } }, null, 2),
  '.gitignore': '.ollama-agent/\n',
  'README.md': '# shop-fixture\n\nA tiny storefront: pricing, tax, cart, inventory and user helpers.\n',
  'src/index.js': "'use strict';\nmodule.exports = { ...require('./cart'), ...require('./inventory'), ...require('./users') };\n",
  'src/pricing.js': `'use strict';
function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

function lineTotal(unitPrice, quantity) {
  return roundToCents(unitPrice * quantity);
}

// percent is a whole-number percentage: 10 means 10% off.
function applyDiscount(total, percent) {
  if (!percent) return total;
  return roundToCents(total - total * percent);
}

module.exports = { roundToCents, lineTotal, applyDiscount };
`,
  'src/tax.js': "'use strict';\nconst { roundToCents } = require('./pricing');\n\nconst TAX_RATE = 0.2;\n\nfunction withTax(total) {\n  return roundToCents(total * (1 + TAX_RATE));\n}\n\nmodule.exports = { TAX_RATE, withTax };\n",
  'src/cart.js': "'use strict';\nconst { lineTotal, applyDiscount } = require('./pricing');\nconst { withTax } = require('./tax');\n\nfunction subtotal(items) {\n  return items.reduce((sum, item) => sum + lineTotal(item.price, item.qty), 0);\n}\n\nfunction cartTotal(items, discountPercent = 0) {\n  return withTax(applyDiscount(subtotal(items), discountPercent));\n}\n\nmodule.exports = { subtotal, cartTotal };\n",
  'src/format.js': "'use strict';\nfunction money(amount) {\n  return `$${amount.toFixed(2)}`;\n}\n\nmodule.exports = { money };\n",
  'src/inventory.js': "'use strict';\nconst stock = new Map();\n\nfunction restock(sku, count) {\n  stock.set(sku, (stock.get(sku) ?? 0) + count);\n}\n\nfunction available(sku) {\n  return stock.get(sku) ?? 0;\n}\n\nmodule.exports = { restock, available };\n",
  'src/users.js': "'use strict';\nfunction displayName(user) {\n  return `${user.first} ${user.last}`.trim();\n}\n\nmodule.exports = { displayName };\n",
  'test/cart.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cartTotal, subtotal } = require('../src/cart');

test('subtotal adds the line totals', () => {
  assert.equal(subtotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
});

test('a cart without a discount is charged tax only', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 30);
});

test('a 10% discount is applied before tax', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }], 10), 27);
});
`,
  'test/users.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { displayName } = require('../src/users');\n\ntest('displayName joins first and last', () => {\n  assert.equal(displayName({ first: 'Ada', last: 'Lovelace' }), 'Ada Lovelace');\n});\n",
};

interface CallRecord { call: number; ms: number; promptChars: number; hasPack: boolean; hasNotes: boolean; }
const calls: CallRecord[] = [];
/** Provider calls started and not yet answered: a stall (e.g. the Ollama role:tool continuation) is a provider fault, not a model failure. */
let inflight = 0;
const INJECT = SCENARIO === 'ladder' && process.env.OLLAMA_AGENT_M46_INJECT === '1';
const injection = newInjectionState();
const WEAKVAL = SCENARIO === 'cart' && process.env.OLLAMA_AGENT_M46_WEAKVAL === '1';
const weakValidation = newWeakValidationState();
/** Validator commands the governed executor actually ran, per validation pass (M46.9 evidence). */
const envelopeEvents: string[][] = [];
/** With OLLAMA_AGENT_M46_TRACE=1: the head of every prompt and reply, to see what a small model actually did. */
const traces: Array<{ call: number; fullPrompt?: string; promptHead: string; promptTail: string; reply: string }> = [];

class MeasuringProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly real: InferenceProvider) {}
  healthCheck(): Promise<void> { return this.real.healthCheck(); }
  listModels(): Promise<ModelInfo[]> { return this.real.listModels(); }
  get endpoint(): string | undefined { return this.real.endpoint; }
  getModelContextMetadata(model: string, signal?: AbortSignal): Promise<ModelInfo | undefined> { return this.real.getModelContextMetadata?.(model, signal) ?? Promise.resolve(undefined); }
  async chat(messages: ChatMessage[], tools: ToolDefinition[], options: ProviderChatOptions): Promise<ChatResponse> {
    const started = Date.now();
    const prompt = messages.map(message => message.content).join('\n');
    inflight += 1;
    let response: ChatResponse;
    try {
      const scripted = INJECT ? injectedReply(prompt, injection) : WEAKVAL ? weakValidationReply(prompt, weakValidation) : undefined;
      response = scripted !== undefined ? { message: { role: 'assistant', content: scripted }, done: true } : await this.real.chat(messages, tools, options);
    } catch (error) {
      if (process.env.OLLAMA_AGENT_M46_TRACE === '1') traces.push({ call: calls.length + 1, promptHead: prompt.slice(0, 200), promptTail: '', reply: `<<ERROR ${error instanceof Error ? error.message : String(error)}>>` });
      throw error;
    } finally {
      inflight -= 1;
    }
    calls.push({ call: calls.length + 1, ms: Date.now() - started, promptChars: prompt.length, hasPack: prompt.includes('# Context Pack'), hasNotes: prompt.includes('Runtime recovery notes') });
    if (process.env.OLLAMA_AGENT_M46_TRACE === '1') {
      traces.push({ call: calls.length, fullPrompt: String(response.message?.content ?? '').length === 0 ? prompt : undefined, promptHead: prompt.slice(0, 1500), promptTail: prompt.slice(-1500), reply: String(response.message?.content ?? '').slice(0, 6000) + (String(response.message?.content ?? '').length === 0 ? ' <<EMPTY raw=' + JSON.stringify(response).slice(0, 600) + '>>' : '') });
    }
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

async function runTests(root: string): Promise<number> {
  const { spawn } = await import('child_process');
  return new Promise<number>(resolve => {
    const child = spawn(process.execPath, ['--test', ...TEST_FILES], { cwd: root, stdio: 'ignore', windowsHide: true });
    child.on('close', code => resolve(code ?? 1));
  });
}

describe.skipIf(!enabled)('M46 live dogfood (real local model, real autonomous runtime, multi-file bug)', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m46-live-'));
    for (const [file, content] of Object.entries(FILES)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content);
    }
    for (const args of [['init'], ['config', 'user.email', 'dogfood@example.test'], ['config', 'user.name', 'M46 Dogfood'], ['add', '.'], ['commit', '-m', 'shop fixture']]) {
      await git(root, args);
    }
  });

  afterAll(async () => {
    if (process.env.OLLAMA_AGENT_M46_KEEP !== '1') await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    else console.log(`M46_LIVE fixture kept at ${root}`);
  });

  it(`repairs the cart discount bug (model=${MODEL}, autonomy=${AUTONOMY ? 'on' : 'off'})`, async () => {
    expect(await runTests(root)).not.toBe(0); // the bug is real before the run

    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', MODEL);
    vscodeMock._setConfig('ollama-agent.requestTimeout', 900_000);
    if (CONTEXT > 0) vscodeMock._setConfig('ollama-agent.contextWindow', CONTEXT);
    const realCreate = ProviderGateway.create.bind(ProviderGateway);
    vi.spyOn(ProviderGateway, 'create').mockImplementation(async (...args: Parameters<typeof ProviderGateway.create>) => new MeasuringProvider(await realCreate(...args)));
    const cloudSpy = vi.spyOn(ProviderGateway, 'resolveCloudFallback');
    const realRunAll = CodingValidationRunner.prototype.runAll;
    vi.spyOn(CodingValidationRunner.prototype, 'runAll').mockImplementation(async function (this: CodingValidationRunner, commands, signal) {
      const results = await realRunAll.call(this, commands, signal);
      envelopeEvents.push(results.map(item => `${item.command} => ${item.exitCode}`));
      return results;
    });

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

    const task = await queue.enqueue(createDefaultAutonomousTask(root, TASK));
    const started = Date.now();
    runtime.wake();
    // The harness owns the deadline so a stalled provider still yields a classified result instead of a bare timeout.
    const deadline = Date.now() + (TIMEOUT_MIN - 1) * 60_000;
    const settled = await Promise.race([
      runtime.waitForIdle().then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), Math.max(1, deadline - Date.now()))),
    ]);
    const stalledInProvider = !settled && inflight > 0;
    const afterRun = await queue.get(task.taskId);
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });

    let delivered = false;
    let testsPass = false;
    if (afterRun?.state === 'waiting_for_delivery_approval') {
      await runtime.approveDelivery(task.taskId);
      delivered = (await queue.get(task.taskId))?.state === 'completed';
      testsPass = delivered && (await runTests(root)) === 0;
    }
    const diff = delivered ? await git(root, ['diff', 'HEAD~1', 'HEAD', '--stat']).catch(() => '') : '';
    const packs = await journalPacks(root, task.taskId);
    const result = {
      model: MODEL,
      autonomy: AUTONOMY,
      contextTokens: CONTEXT || undefined,
      finalState: afterRun?.state,
      delivered,
      testsPass,
      terminal: journal.state.terminal?.terminalState,
      scenario: SCENARIO,
      injected: INJECT ? injection.injected : WEAKVAL ? weakValidation.injected : undefined,
      validationEnvelope: envelopeEvents,
      adaptiveSchema: AUTONOMY && ADAPTIVE,
      settled,
      passes: journal.state.passes,
      decisions: journal.state.decisions.map(decision => `${decision.action}${decision.cause ? `/${decision.cause}` : ''}${decision.directives.strategy ? `+${decision.directives.strategy}` : ''}${decision.progress ? `[${decision.progress.verdict}]` : ''}`),
      modelCalls: calls.length,
      promptCharsTotal: calls.reduce((sum, call) => sum + call.promptChars, 0),
      promptCharsMax: Math.max(0, ...calls.map(call => call.promptChars)),
      callsWithPack: calls.filter(call => call.hasPack).length,
      modelMs: calls.reduce((sum, call) => sum + call.ms, 0),
      wallMs: Date.now() - started,
      evidenceFiles: [...journal.state.evidence.keys()],
      packs,
      subgoals: journal.state.subgoalPlan?.subgoals.map(goal => `${goal.kind}:${goal.status}`),
      validation: journal.state.outcomes.flatMap(outcome => outcome.facts.validationFailures.map(failure => `pass${outcome.pass} ${failure.kind} tests=[${(failure.semantic?.tests ?? []).join('; ')}] classes=[${(failure.semantic?.errorClasses ?? []).join(',')}]`)),
      failure: afterRun?.failure ? JSON.stringify(afterRun.failure).slice(0, 400) : undefined,
      diffStat: diff,
      cloudCalled: cloudSpy.mock.calls.length > 0,
      contractModes: journal.state.contractModes.map(mode => `pass${mode.pass} ${mode.change} ${mode.from}->${mode.to} [${mode.trigger.kind}:${mode.trigger.subcode ?? '-'}]`),
      protocol: assessProtocolOutcome(journal.state.outcomes),
      causes: journal.state.outcomes.map(outcome => (outcome.ok ? 'ok' : `${outcome.cause}/${outcome.subcode ?? '-'}`)),
      outcomeDetails: journal.state.outcomes.filter(outcome => !outcome.ok).map(outcome => outcome.details.slice(0, 4).join(' ; ').slice(0, 300)),
      ladder: {
        hypothesisRepeated: journal.state.decisions.some(decision => decision.progress?.verdict === 'same_failure_same_patch_family' || decision.progress?.verdict === 'no_new_evidence' || (decision.progress?.streak ?? 0) >= 2),
        evidenceWidened: journal.state.evidenceWidenings.length > 0 || journal.state.decisions.some(decision => decision.directives.strategy === 'widen_evidence'),
        widenedFiles: journal.state.evidenceWidenings.flatMap(item => item.paths),
        modelChanged: journal.state.decisions.some(decision => decision.action === 'CHANGE_MODEL'),
        noProgress: journal.state.terminal?.terminalState === 'NO_PROGRESS' || journal.state.decisions.some(decision => decision.terminalState === 'NO_PROGRESS'),
        verdicts: journal.state.decisions.map(decision => decision.progress?.verdict ?? '-'),
      },
      runtimeProfile: await readRuntimeProfile(MODEL),
      runClass: '',
    };
    result.runClass = classifyRun({
      testsPass,
      delivered,
      settled,
      stalledInProvider,
      causes: journal.state.outcomes.map(outcome => (outcome.ok ? 'ok' : outcome.cause ?? 'unknown')),
      protocolVerdict: result.protocol.verdict,
    });
    console.log('M46_LIVE_RESULT ' + JSON.stringify(result));
    if (traces.length > 0 && process.env.OLLAMA_AGENT_M46_OUT) await fs.writeFile(`${process.env.OLLAMA_AGENT_M46_OUT}.trace.json`, JSON.stringify(traces, null, 2));
    if (process.env.OLLAMA_AGENT_M46_OUT) await fs.appendFile(process.env.OLLAMA_AGENT_M46_OUT, JSON.stringify(result) + '\n');
    expect(cloudSpy).not.toHaveBeenCalled();
    runtime.dispose();
  }, TIMEOUT_MIN * 60_000);
});

/**
 * One label per run, keeping provider faults apart from model faults:
 *   fixed            tests pass after delivery
 *   provider_stall   a provider call never answered before the deadline, or the last failure was a provider failure
 *   incomplete       the deadline passed with nothing in flight and no delivery (slow, not stalled)
 *   protocol_failed  the model never produced a usable proposal (only envelope failures)
 *   model_failed     well-formed proposals that were wrong, or no convergence
 */
function classifyRun(input: { testsPass: boolean; delivered: boolean; settled: boolean; stalledInProvider: boolean; causes: string[]; protocolVerdict: string }): string {
  if (input.testsPass) return 'fixed';
  if (input.delivered) return 'delivered_wrong';
  if (input.stalledInProvider) return 'provider_stall';
  if (input.causes[input.causes.length - 1] === 'provider_failure') return 'provider_stall';
  if (!input.settled) return 'incomplete';
  if (input.protocolVerdict === 'PROTOCOL_ONLY_UNOBSERVED' || (input.causes.length > 0 && input.causes.every(cause => cause === 'format_failure'))) return 'protocol_failed';
  return 'model_failed';
}

async function journalPacks(root: string, taskId: string): Promise<Array<{ pass: number; chars: number; budget: number; tier?: string; selected: number; rejected: number; source?: string }>> {
  const out: Array<{ pass: number; chars: number; budget: number; tier?: string; selected: number; rejected: number; source?: string }> = [];
  const walk = async (dir: string): Promise<string | undefined> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = await walk(full); if (found) return found; }
      else if (entry.name === 'journal.jsonl' && full.includes(taskId)) return full;
    }
    return undefined;
  };
  const file = await walk(path.join(root, '.ollama-agent'));
  if (!file) return out;
  for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { t: string; pass?: number; pack?: { packChars: number; budgetChars: number; tier?: string; selected: unknown[]; rejected: unknown[]; intelSource?: string } };
      if (record.t === 'context_pack' && record.pack) out.push({ pass: record.pass ?? 0, chars: record.pack.packChars, budget: record.pack.budgetChars, tier: record.pack.tier, selected: record.pack.selected.length, rejected: record.pack.rejected.length, source: record.pack.intelSource });
    } catch { /* torn line */ }
  }
  return out;
}


/** M47: the capability profile the run produced for this model, when runtime probing was on (OLLAMA_AGENT_RUNTIME_PROBE=1). */
async function readRuntimeProfile(model: string): Promise<unknown> {
  const file = process.env.OLLAMA_AGENT_RUNTIME_PROFILE_STORE;
  if (!file) return undefined;
  try {
    const store = JSON.parse(await fs.readFile(file, 'utf8')) as { profiles?: Record<string, { identity?: { model?: string } }> };
    return Object.values(store.profiles ?? {}).filter(profile => profile.identity?.model === model);
  } catch {
    return undefined;
  }
}
