import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { GovernedCodingExecutor, GovernedCodingExecutionRequest } from '../../coding/GovernedCodingExecutor';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { classifyExecutionProfile } from '../../orchestration/ExecutionProfile';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';
import { ExecutionRecoverySession } from '../../autonomous/recovery/ExecutionRecoverySession';
import { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';

/**
 * The full five-stage graph (complex tier) must enforce the same M42 grounding
 * precondition as the lightweight path: a replace of an existing file needs fresh
 * path+contentHash+revision evidence, supplied by the runtime — never assumed.
 */

const MODEL = 'qwen3-coder:30b';
const GOAL = 'implement a cross-cutting architecture redesign of the marker module';

const PROPOSAL = JSON.stringify({
  version: 1,
  taskSummary: 'Rewrite marker.txt',
  operations: [{ type: 'replace', path: 'marker.txt', reason: 'graph grounding test', content: 'FIXED\n' }],
  validationCommands: [{ kind: 'npm-script', script: 'verify' }],
  warnings: [],
  status: 'proposed',
});

class GraphProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly prompts: string[] = [];
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: MODEL, contextWindow: 40_960 }]; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    const prompt = messages[0]?.content ?? '';
    this.prompts.push(prompt);
    const proposalStage = /^Stage: (implementer|reviewer|validator)/.test(prompt);
    return { message: { role: 'assistant', content: proposalStage ? PROPOSAL : 'analysis text' }, done: true };
  }
}

async function git(root: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`))));
  });
}

describe('M42 grounding on the full multi-stage graph path', () => {
  let root: string;
  let journalRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-graph-grounding-'));
    journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-graph-grounding-journal-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.js' } }, null, 2));
    await fs.writeFile(
      path.join(root, 'check.js'),
      "const c=require('fs').readFileSync('marker.txt','utf8');if(!c.includes('FIXED')){process.exit(1);}console.log('ok');",
    );
    await fs.writeFile(path.join(root, 'marker.txt'), 'ORIGINAL\n');
    for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '.'], ['commit', '-m', 'init']]) {
      await git(root, args);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(journalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function run(seedEvidencePaths: string[]) {
    const provider = new GraphProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const journal = await AttemptJournal.open({ repositoryRoot: journalRoot, taskId: 'task_graph_grounding' });
    const session = new ExecutionRecoverySession({
      journal,
      workspaceRoot: root,
      attemptId: 'att',
      pass: 1,
      resolveBaseRevision: async () => 'base-1',
      seedEvidencePaths,
    });
    const executionProfile = classifyExecutionProfile(GOAL);
    expect(executionProfile.tier).toBe('complex');
    const approvals: string[] = [];
    const request: GovernedCodingExecutionRequest = {
      runId: 'graph-grounding-1',
      goal: GOAL,
      workspaceRoot: root,
      signal: new AbortController().signal,
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
      auditSource: 'test',
      extensionBuild: 'test-build',
      model: MODEL,
      executionProfile,
      recovery: session,
      callbacks: {
        checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
        reviewProposal: async () => { approvals.push('review'); return true; },
        approveExecution: async () => { approvals.push('approve'); return true; },
        confirmElevated: async () => true,
      },
    };
    const result = await new GovernedCodingExecutor().execute(request);
    return { result, approvals, provider };
  }

  it('rejects a graph proposal that replaces an existing file the runtime never supplied evidence for, before any approval or mutation', async () => {
    const { result, approvals } = await run([]);

    expect(result.status).toBe('grounding_failed');
    expect(result.graph?.status).toBe('completed');
    expect(result.groundingMissing?.map(item => item.path)).toEqual(['marker.txt']);
    expect(approvals).toEqual([]);
    expect(result.mutation).toBeUndefined();
    expect(await fs.readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('ORIGINAL\n');
  });

  it('admits the same proposal once the runtime has supplied fresh whole-file evidence, and shows that content to the graph', async () => {
    const { result, provider } = await run(['marker.txt']);

    expect(result.status).toBe('completed');
    expect(await fs.readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('FIXED\n');
    expect(provider.prompts.some(prompt => prompt.includes('COMPLETE current file') && prompt.includes('ORIGINAL'))).toBe(true);
  });
});
