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
 * Scripted host-wiring proof for the bounded pre-proposal investigation loop
 * (src/coding/InvestigationLoop.ts, reached through the REAL
 * GovernedCodingExecutor -> CodingPlanner.planWithInvestigation path — no
 * second/parallel autonomous runtime is introduced). Only the model layer is
 * a stub (via ProviderGateway.create), matching the existing
 * governedCodingValidationRepair.test.ts pattern. This proves the host
 * mechanics: a scripted read_file action actually reads the real workspace
 * and its content reaches the next turn's prompt; a submitted proposal still
 * goes through the exact existing CodingProposal validation and mutation
 * pipeline and passes a real, independently-written behavioral regression;
 * insufficient_context and no_change_claim never mutate the workspace and
 * never reach a completed status. Scripted success here is host-wiring
 * evidence only — real acceptance is the live cloud/local composer run.
 */

const MODEL = 'qwen3-coder:30b';
const GOAL = 'index.js has a bug: isValid() should compare against the real threshold defined in helper.js, not a hardcoded number. Fix it and make the real npm verify script pass.';

function envelope(action: Record<string, unknown>): string {
  return JSON.stringify(action);
}

const CORRECT_FIX_PROPOSAL = {
  version: 1,
  taskSummary: 'Use the real THRESHOLD exported by helper.js instead of a hardcoded number',
  operations: [{
    type: 'replace',
    path: 'index.js',
    reason: 'Compare against the real threshold from helper.js',
    content: "const { THRESHOLD } = require('./helper');\nfunction isValid(n) { return n > THRESHOLD; }\nmodule.exports = { isValid };\n",
  }],
  validationCommands: [{ kind: 'npm-script', script: 'verify' }],
  warnings: [],
  status: 'proposed',
};

/** Turn 1: requests the file the bug fix actually depends on. Turn 2: only
 * returns the correct fix if the previous turn's read result (the real
 * THRESHOLD value) is genuinely present in this turn's prompt — proving the
 * loop, not the fixture, produced that content. */
class InvestigateThenProposeProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly prompts: string[] = [];
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: MODEL, contextWindow: 40_960 }]; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    const prompt = messages[0]?.content ?? '';
    this.prompts.push(prompt);
    if (this.prompts.length === 1) {
      return { message: { role: 'assistant', content: envelope({ action: 'read_file', path: 'helper.js' }) }, done: true };
    }
    if (!prompt.includes('THRESHOLD') || !prompt.includes('42')) {
      // Wrong turn content reached the model — fail the fixture loudly
      // instead of silently guessing, so a wiring regression shows up here.
      return { message: { role: 'assistant', content: envelope({ action: 'insufficient_context', reason: 'read result missing', missing: ['helper.js'] }) }, done: true };
    }
    return { message: { role: 'assistant', content: envelope({ action: 'submit_proposal', proposal: CORRECT_FIX_PROPOSAL }) }, done: true };
  }
}

class SingleTurnProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly action: Record<string, unknown>) {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: MODEL, contextWindow: 40_960 }]; }
  async chat(): Promise<ChatResponse> {
    return { message: { role: 'assistant', content: envelope(this.action) }, done: true };
  }
}

async function initGit(root: string): Promise<void> {
  for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '.'], ['commit', '-m', 'init']]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`))));
    });
  }
}

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-investigation-loop-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.js' } }, null, 2));
  await fs.writeFile(path.join(root, 'helper.js'), 'module.exports = { THRESHOLD: 42 };\n');
  await fs.writeFile(
    path.join(root, 'index.js'),
    'function isValid(n) { return n > 10; }\nmodule.exports = { isValid };\n',
  );
  // The independently established behavioral regression: written here, once,
  // before any model call — never shown to the model as anything other than
  // "the real npm verify script". Fails on the original hardcoded-10 bug
  // (isValid(20) would wrongly be true) and only passes a fix that actually
  // uses helper.js's real THRESHOLD (42), not a hardcoded/guessed number.
  await fs.writeFile(
    path.join(root, 'check.js'),
    "const { isValid } = require('./index');\n"
    + "if (isValid(20) !== false) { console.error('expected isValid(20) to be false (below THRESHOLD)'); process.exit(1); }\n"
    + "if (isValid(50) !== true) { console.error('expected isValid(50) to be true (at/above THRESHOLD)'); process.exit(1); }\n"
    + "console.log('ok');\n",
  );
  await initGit(root);
  return root;
}

function baseRequest(root: string, callbacks: Partial<GovernedCodingExecutionRequest['callbacks']> = {}): GovernedCodingExecutionRequest {
  return {
    runId: 'investigation-loop-test-1',
    goal: GOAL,
    workspaceRoot: root,
    signal: new AbortController().signal,
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
    auditSource: 'test',
    extensionBuild: 'test-build',
    model: MODEL,
    executionProfile: classifyExecutionProfile(GOAL),
    maxValidationRepairCycles: 2,
    callbacks: {
      checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
      reviewProposal: async () => true,
      approveExecution: async () => true,
      confirmElevated: async () => true,
      ...callbacks,
    },
  };
}

async function gitStatusLines(root: string): Promise<string[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['status', '--porcelain'], { cwd: root, shell: false, windowsHide: true });
    let out = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
  return stdout.split(/\r?\n/).filter(line => line.trim() && !line.includes('.ollama-agent'));
}

describe('GovernedCodingExecutor — bounded pre-proposal investigation loop', () => {
  let root: string;

  beforeEach(async () => {
    root = await workspace();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('retrieves a cross-file dependency via read_file, then delivers a proposal that passes the real independently-established regression', async () => {
    const provider = new InvestigateThenProposeProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const progressEvents: string[] = [];

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root, {
      onProgress: phase => progressEvents.push(phase),
    }));

    expect(result.status).toBe('completed');
    expect(provider.prompts).toHaveLength(2);
    // Turn 2 genuinely received the real file content the read_file action
    // fetched from the actual workspace — the loop mechanics under test —
    // not a fixture-specific hint hardcoded into the prompt builder. (This
    // tiny fixture is small enough that RepositoryContextService's ordinary
    // candidate selection already includes every file whole regardless of
    // the read; proving that a real, larger repository's selection actually
    // OMITS the helper — and that the loop is what closes that gap — is what
    // the live cloud/local composer acceptance run below proves instead.)
    expect(provider.prompts[1]).toContain('THRESHOLD: 42');
    expect(progressEvents.some(event => event.startsWith('investigation_turn turn=1 action=read_file') && event.includes('path=helper.js'))).toBe(true);
    expect(progressEvents).toContainEqual(expect.stringMatching(/^investigation_turn turn=2 action=submit_proposal/));

    const written = await fs.readFile(path.join(root, 'index.js'), 'utf8');
    expect(written).toContain('THRESHOLD');
    expect(written).not.toContain('n > 10');
  });

  it('does not require any investigation turns when the answer is already available', async () => {
    const provider = new SingleTurnProvider({ action: 'submit_proposal', proposal: CORRECT_FIX_PROPOSAL });
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root));

    expect(result.status).toBe('completed');
  });

  it('reports insufficient_context honestly, with no mutation and no completed status', async () => {
    const provider = new SingleTurnProvider({
      action: 'insufficient_context',
      reason: 'The threshold helper.js exports is not visible in what has been shown so far.',
      missing: ['helper.js'],
    });
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root));

    expect(result.status).toBe('insufficient_context_reported');
    expect(result.status).not.toBe('completed');
    expect(result.proposal).toBeUndefined();
    expect(result.mutationEvidence).toBeUndefined();
    expect(await gitStatusLines(root)).toEqual([]);
  });

  it('reports a no_change_claim without ever completing the task on that claim alone', async () => {
    const provider = new SingleTurnProvider({
      action: 'no_change_claim',
      reason: 'isValid already behaves correctly for the cases that matter.',
      evidence: 'Read index.js and helper.js; the comparison is intentional.',
    });
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root));

    expect(result.status).toBe('no_change_claim_reported');
    expect(result.status).not.toBe('completed');
    expect(result.proposal).toBeUndefined();
    expect(result.mutationEvidence).toBeUndefined();
    expect(await gitStatusLines(root)).toEqual([]);
  });

  it('never mutates the workspace when proposal approval is rejected', async () => {
    const provider = new SingleTurnProvider({ action: 'submit_proposal', proposal: CORRECT_FIX_PROPOSAL });
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root, {
      reviewProposal: async () => false,
    }));

    expect(result.status).toBe('proposal_rejected');
    expect(result.mutationEvidence).toBeUndefined();
    expect(await gitStatusLines(root)).toEqual([]);
    const originalContent = await fs.readFile(path.join(root, 'index.js'), 'utf8');
    expect(originalContent).toContain('n > 10');
  });

  it('never mutates the workspace when execution approval is rejected', async () => {
    const provider = new SingleTurnProvider({ action: 'submit_proposal', proposal: CORRECT_FIX_PROPOSAL });
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root, {
      approveExecution: async () => false,
    }));

    expect(result.status).toBe('execution_rejected');
    expect(result.mutationEvidence).toBeUndefined();
    expect(await gitStatusLines(root)).toEqual([]);
    const originalContent = await fs.readFile(path.join(root, 'index.js'), 'utf8');
    expect(originalContent).toContain('n > 10');
  });
});
