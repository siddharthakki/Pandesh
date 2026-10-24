import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { GovernedCodingExecutor, GovernedCodingExecutionRequest } from '../../coding/GovernedCodingExecutor';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { classifyExecutionProfile } from '../../orchestration/ExecutionProfile';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { deriveValidationEnvelope } from '../../coding/ValidationFloor';
import { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';

/**
 * M46.9 governed minimum validation envelope. The regression reproduces the
 * dogfood `delivered_wrong` class on the cart-discount fixture shape: the model
 * proposes a semantically wrong patch and chooses only `git-diff-check`.
 */

const MODEL = 'qwen3-coder:30b';
const GOAL = 'The cart total is wrong whenever a discount is applied. Find the cause and fix it.';

const PRICING_BUGGY = "'use strict';\nfunction applyDiscount(total, percent) {\n  return total * (percent / 100);\n}\nmodule.exports = { applyDiscount };\n";
const PRICING_WRONG_PATCH = "'use strict';\nfunction applyDiscount(total, percent) {\n  return total * (1 - percent / 10);\n}\nmodule.exports = { applyDiscount };\n";
const PRICING_CORRECT = "'use strict';\nfunction applyDiscount(total, percent) {\n  return total * (1 - percent / 100);\n}\nmodule.exports = { applyDiscount };\n";
const CART = "'use strict';\nconst { applyDiscount } = require('./pricing');\nfunction cartTotal(total, percent = 0) {\n  return applyDiscount(total, percent);\n}\nmodule.exports = { cartTotal };\n";
const CART_TEST = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { cartTotal } = require('../src/cart');\ntest('a 10% discount takes 10% off', () => {\n  assert.equal(cartTotal(100, 10), 90);\n});\n";

function proposalJson(content: string, validationCommands: unknown[]): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Fix discount calculation',
    operations: [{ type: 'replace', path: 'src/pricing.js', reason: 'fix discount', content }],
    validationCommands,
    warnings: [],
    status: 'proposed',
  });
}

const WEAK_ONLY = [{ kind: 'git-diff-check' }];

class FixtureProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly initial: string, private readonly repair: string) {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: MODEL, contextWindow: 40_960 }]; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    const prompt = messages[0]?.content ?? '';
    if (prompt.includes('Stage: validator (bounded proposal repair)')) {
      return { message: { role: 'assistant', content: this.repair }, done: true };
    }
    return { message: { role: 'assistant', content: JSON.stringify({ action: 'submit_proposal', proposal: JSON.parse(this.initial) }) }, done: true };
  }
}

async function git(root: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`))));
  });
}

async function writeFixture(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node --test test/cart.test.js' } }, null, 2));
  await fs.writeFile(path.join(root, 'src', 'pricing.js'), PRICING_BUGGY);
  await fs.writeFile(path.join(root, 'src', 'cart.js'), CART);
  await fs.writeFile(path.join(root, 'test', 'cart.test.js'), CART_TEST);
}

function request(root: string, onProgress?: (phase: string) => void): GovernedCodingExecutionRequest {
  return {
    runId: 'm46-9-test',
    goal: GOAL,
    workspaceRoot: root,
    signal: new AbortController().signal,
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
    auditSource: 'test',
    extensionBuild: 'test-build',
    model: MODEL,
    executionProfile: classifyExecutionProfile(GOAL),
    maxValidationRepairCycles: 1,
    callbacks: {
      checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
      reviewProposal: async () => true,
      approveExecution: async () => true,
      confirmElevated: async () => true,
      onProgress,
    },
  };
}

describe('M46.9 governed minimum validation envelope', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-govval-')); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('deriveValidationEnvelope', () => {
    it('adds the relevant test to a weak model choice and keeps the model command (additive, floor first)', async () => {
      await writeFixture(root);
      const envelope = await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['src/pricing.js'], modelCommands: [{ kind: 'git-diff-check' }] });
      // The JS syntax floor (node-check) is additive and goes first; the semantic floor is still the manifest test.
      expect(envelope.commands.map(command => command.kind)).toEqual(['node-check', 'npm-test', 'git-diff-check']);
      expect(envelope.floorAdded.map(command => command.kind)).toEqual(['node-check', 'npm-test']);
      expect(envelope.confidence).toBe('semantic');
    });

    it('does not duplicate a validator the model already requested', async () => {
      await writeFixture(root);
      const envelope = await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['src/pricing.js'], modelCommands: [{ kind: 'npm-test' }, { kind: 'git-diff-check' }] });
      expect(envelope.commands.map(command => command.kind)).toEqual(['node-check', 'npm-test', 'git-diff-check']);
      expect(envelope.floorAdded.map(command => command.kind)).toEqual(['node-check']);
    });

    it('uses discovered Python tests for changed Python source in a plain (non-Git) folder', async () => {
      await fs.mkdir(path.join(root, 'tests'), { recursive: true });
      await fs.writeFile(path.join(root, 'cart.py'), 'def total(x):\n    return x\n');
      await fs.writeFile(path.join(root, 'tests', 'test_cart.py'), 'from cart import total\n\ndef test_total():\n    assert total(2) == 2\n');
      const envelope = await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['cart.py'], modelCommands: [{ kind: 'git-diff-check' }] });
      expect(envelope.commands[0]).toEqual({ kind: 'pytest', args: ['tests/test_cart.py'] });
      expect(envelope.confidence).toBe('semantic');
    });

    it('records semantic_validation_unavailable instead of faking confidence when no semantic validator is known', async () => {
      await fs.writeFile(path.join(root, 'tool.js'), 'module.exports = 1;\n');
      const envelope = await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['tool.js'], modelCommands: [{ kind: 'git-diff-check' }] });
      // Only the syntax floor applies: structural, not behavioural, and reported as exactly that.
      expect(envelope.floorAdded).toEqual([{ kind: 'node-check', args: ['tool.js'] }]);
      expect(envelope.commands).toEqual([{ kind: 'node-check', args: ['tool.js'] }, { kind: 'git-diff-check' }]);
      expect(envelope.confidence).toBe('structural_only');
    });

    it('ignores a placeholder npm test script and does not gate docs-only changes', async () => {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
      await fs.writeFile(path.join(root, 'a.js'), 'x\n');
      expect((await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['a.js'], modelCommands: [] })).floorAdded).toEqual([{ kind: 'node-check', args: ['a.js'] }]);
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      expect((await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['README.md'], modelCommands: [] })).floorAdded).toEqual([]);
    });
  });

  describe('delivery (dogfood delivered_wrong class)', () => {
    it('does NOT deliver a wrong semantic patch when the model chose only git-diff-check', async () => {
      await writeFixture(root);
      await git(root, ['init']);
      await git(root, ['config', 'user.email', 't@example.com']);
      await git(root, ['config', 'user.name', 'T']);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);
      const wrong = proposalJson(PRICING_WRONG_PATCH, WEAK_ONLY);
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new FixtureProvider(wrong, wrong));
      const progress: string[] = [];

      const result = await new GovernedCodingExecutor().execute(request(root, phase => progress.push(phase)));

      expect(result.status).not.toBe('completed');
      expect(result.validations.some(validation => validation.command === 'npm test' && validation.exitCode !== 0)).toBe(true);
      expect(progress.some(event => event.startsWith('validation_envelope confidence=semantic floorAdded=2'))).toBe(true);
    });

    it('still delivers the correct patch once the governed validator passes', async () => {
      await writeFixture(root);
      await git(root, ['init']);
      await git(root, ['config', 'user.email', 't@example.com']);
      await git(root, ['config', 'user.name', 'T']);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);
      const correct = proposalJson(PRICING_CORRECT, WEAK_ONLY);
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new FixtureProvider(correct, correct));

      const result = await new GovernedCodingExecutor().execute(request(root));

      expect(result.status).toBe('completed');
      expect(result.validations.map(validation => validation.command)).toEqual(['node --check src/pricing.js', 'npm test', 'git diff --check']);
      expect(result.validations.every(validation => validation.exitCode === 0)).toBe(true);
      expect(result.validationPhase).toMatchObject({ status: 'completed', failedCommandCount: 0, confidence: 'semantic' });
    });
  });
});
