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
 * Regression for the att_144a4f36/att_17d9bc34 investigation family: a
 * refusal caused by an unusable model response (empty content, insufficient
 * context — the real `empty_content` failure this session traced and fixed)
 * must never be reported as "Already satisfied." `mutationEvidence` — the
 * ONLY source `alreadySatisfied` is ever read from — is computed exclusively
 * from a real, applied, sha256-verified mutation
 * (`GovernedCodingExecutor.ts`'s post-mutation verification). No proposal
 * ever reaches that code when the model call itself fails, so this proves
 * the invariant holds through the REAL executor, not just by inspection.
 */

const MODEL = 'qwen3-coder:30b';
const GOAL = 'Fix the marker validation bug so the real npm verify script passes.';

class EmptyResponseProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: MODEL, contextWindow: 40_960 }]; }
  async chat(_messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    // Simulates the real, fixed empty_content dispatch failure (insufficient
    // context / no usable completion) — never a well-formed CodingProposal.
    return { message: { role: 'assistant', content: '' }, done: true };
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-insufficient-context-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }, null, 2));
  await initGit(root);
  return root;
}

function baseRequest(root: string): GovernedCodingExecutionRequest {
  return {
    runId: 'insufficient-context-test-1',
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
    },
  };
}

describe('GovernedCodingExecutor — an insufficient-context refusal is never "already satisfied"', () => {
  let root: string;

  beforeEach(async () => {
    root = await workspace();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('an empty-content model response never produces mutationEvidence, an alreadySatisfied claim, or a completed status', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new EmptyResponseProvider());

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root));

    expect(result.status).toBe('proposal_unavailable');
    expect(result.proposal).toBeUndefined();
    expect(result.executableProposal).toBeUndefined();
    // The invariant this regression exists to prove: mutationEvidence (the
    // only field alreadySatisfied is ever read from, both here and in
    // M15AutonomousRuntime's approveDelivery/mutation_evidence_missing gate)
    // is never fabricated when no real mutation was ever applied.
    expect(result.mutationEvidence).toBeUndefined();
    expect(result.status).not.toBe('completed');

    // No repository mutation actually happened — the runtime's own
    // `.ollama-agent` state directory is expected (it is never delivered;
    // see RUNTIME_INTERNAL_GIT_EXCLUDE_PATHSPEC) and excluded here the same
    // way delivery review excludes it.
    const status = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['status', '--porcelain'], { cwd: root, shell: false, windowsHide: true });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.on('error', reject);
      child.on('close', () => resolve(stdout));
    });
    const realChanges = status.split(/\r?\n/).filter(line => line.trim() && !line.includes('.ollama-agent'));
    expect(realChanges).toEqual([]);
  });
});
