import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { GovernedCodingExecutor, GovernedCodingExecutionRequest } from '../../coding/GovernedCodingExecutor';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { classifyExecutionProfile } from '../../orchestration/ExecutionProfile';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';

/**
 * P1.1 acceptance on the coupon-before-loyalty fixture (starts at `2 failed, 2 passed`). Everything below the model
 * boundary is production: GovernedCodingExecutor, validation envelope/floor, approval callbacks, mutator and a real
 * pytest process. The deterministic cases script ONLY the model reply (labelled as such, never a live success); the
 * live case (KKD_P11_LIVE=1) uses the real Ollama provider.
 */
const BUGGY = `from decimal import Decimal

def calculate_total(subtotal, coupon, loyalty_percent):
    subtotal = Decimal(str(subtotal))
    coupon = Decimal(str(coupon))
    loyalty_percent = Decimal(str(loyalty_percent))

    # BUG: loyalty is applied before coupon
    discounted = subtotal * (1 - loyalty_percent / 100)
    return discounted - coupon
`;
const FIXED = `from decimal import Decimal

def calculate_total(subtotal, coupon, loyalty_percent):
    subtotal = Decimal(str(subtotal))
    coupon = Decimal(str(coupon))
    loyalty_percent = Decimal(str(loyalty_percent))

    after_coupon = max(subtotal - coupon, Decimal("0"))
    return after_coupon * (1 - loyalty_percent / 100)
`;
const TESTS = `from decimal import Decimal
from pricing import calculate_total

def test_no_discounts():
    assert calculate_total(100, 0, 0) == Decimal("100")

def test_coupon_first():
    assert calculate_total(100, 10, 20) == Decimal("72")

def test_coupon_exceeds_subtotal():
    assert calculate_total(50, 100, 10) == Decimal("0")

def test_loyalty_only():
    assert calculate_total(100, 0, 20) == Decimal("80")
`;

const LIVE = process.env.KKD_P11_LIVE === '1';
const MODEL = process.env.KKD_P11_MODEL || 'qwen3-coder:swift-27b';
const GOAL = 'calculate_total applies the loyalty discount before the coupon. Fix pricing.py so the coupon is applied first. Validate with python -m pytest -q.';

function proposalJson(validationCommands: unknown[]): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Apply coupon before loyalty',
    operations: [{ type: 'replace', path: 'pricing.py', reason: 'coupon first', content: FIXED }],
    validationCommands,
    warnings: [],
    status: 'proposed',
  });
}

class ScriptedModel implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly reply: string) {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: MODEL, contextWindow: 40_960 }]; }
  async chat(_m: ChatMessage[], _t: ToolDefinition[], _o: ProviderChatOptions): Promise<ChatResponse> {
    return { message: { role: 'assistant', content: JSON.stringify({ action: 'submit_proposal', proposal: JSON.parse(this.reply) }) }, done: true };
  }
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
    child.stdout.on('data', d => { out += String(d); });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`git ${args.join(' ')}`))));
  });
}

function request(root: string, approve: boolean, progress: string[]): GovernedCodingExecutionRequest {
  return {
    runId: 'p11-acceptance',
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
      reviewProposal: async () => approve,
      approveExecution: async () => approve,
      confirmElevated: async () => approve,
      onProgress: phase => progress.push(phase),
    },
  };
}

describe('P1.1 python acceptance through the governed executor', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'p11-accept-'));
    await fs.writeFile(path.join(root, 'pricing.py'), BUGGY);
    await fs.writeFile(path.join(root, 'test_pricing.py'), TESTS);
    await fs.writeFile(path.join(root, '.gitignore'), '__pycache__/\n.pytest_cache/\n.ollama-agent/\n');
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 't@example.com']);
    await git(root, ['config', 'user.name', 'T']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'init']);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('(scripted model) selects pytest instead of npm test, changes only pricing.py and records 4 passed', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedModel(proposalJson([{ kind: 'npm-test' }, { kind: 'git-diff-check' }])));
    const progress: string[] = [];
    const result = await new GovernedCodingExecutor().execute(request(root, true, progress));

    expect(result.status).toBe('completed');
    const commands = result.validations.map(validation => validation.command);
    expect(commands.some(command => command.includes('npm'))).toBe(false);
    const pytest = result.validations.find(validation => validation.command.startsWith('pytest'));
    expect(pytest?.exitCode).toBe(0);
    expect(pytest?.output).toContain('4 passed');
    expect(progress.some(event => event.includes('inapplicableDropped=1'))).toBe(true);
    expect((await git(root, ['status', '--porcelain'])).trim().split(/\r?\n/)).toEqual(['M pricing.py']);
  }, 120_000);

  it('(scripted model) a denied approval prevents any mutation', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedModel(proposalJson([{ kind: 'pytest', args: ['-q'] }])));
    const result = await new GovernedCodingExecutor().execute(request(root, false, []));
    expect(result.status).not.toBe('completed');
    expect(await fs.readFile(path.join(root, 'pricing.py'), 'utf8')).toBe(BUGGY);
    expect((await git(root, ['status', '--porcelain'])).trim()).toBe('');
  }, 120_000);

  it.skipIf(!LIVE)('(LIVE model) real Ollama model fixes pricing.py and real pytest returns 4 passed', async () => {
    const progress: string[] = [];
    const result = await new GovernedCodingExecutor().execute(request(root, true, progress));
    const commands = result.validations.map(validation => validation.command);
    console.log('P11_LIVE', JSON.stringify({ status: result.status, commands, progress: progress.filter(p => p.startsWith('validation')) }));
    expect(result.status).toBe('completed');
    expect(commands.some(command => command.includes('npm'))).toBe(false);
    expect(result.validations.find(validation => validation.command.startsWith('pytest'))?.output).toContain('4 passed');
    expect((await git(root, ['status', '--porcelain'])).trim().split(/\r?\n/)).toEqual(['M pricing.py']);
  }, 1_500_000);
});
