import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { parseAndValidateCodingProposal, approvedPackageJsonFingerprint } from '../../coding/CodingProposal';
import { CodingValidationRunner } from '../../coding/ValidationRunner';
import { GovernedCodingExecutor, GovernedCodingExecutionRequest } from '../../coding/GovernedCodingExecutor';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { classifyExecutionProfile } from '../../orchestration/ExecutionProfile';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';

/**
 * Validation may run an npm script that the base repository does not declare
 * only when the approved proposal's own root package.json declares that exact
 * script, and only while the on-disk package.json still matches the approved
 * content. Existing-repository behavior is unchanged.
 */

const PACKAGE_JSON = JSON.stringify({
  name: 'from-scratch',
  version: '1.0.0',
  scripts: { test: 'node --test' },
}, null, 2) + '\n';
const TEST_FILE = "const test = require('node:test');\nconst assert = require('node:assert');\n"
  + "test('adds', () => { assert.strictEqual(1 + 1, 2); });\n";

function proposal(validationCommands: unknown[], operations: unknown[] = [
  { type: 'create', path: 'package.json', reason: 'scripts', content: PACKAGE_JSON },
  { type: 'create', path: 'test/add.test.js', reason: 'test', content: TEST_FILE },
]): string {
  return JSON.stringify({ version: 1, taskSummary: 'Scaffold app', operations, validationCommands, warnings: [], status: 'proposed' });
}

describe('proposal-declared npm script validation authorization', () => {
  it('authorizes npm test in an empty repo when the approved package.json declares "test"', () => {
    const result = parseAndValidateCodingProposal(proposal([{ kind: 'npm-test' }]), []);
    expect(result.ok).toBe(true);
    expect(result.ok && result.proposal.validationCommands).toEqual([{
      kind: 'npm-test',
      authorization: { source: 'approved-proposal-package-json', packageJsonSha256: approvedPackageJsonFingerprint(PACKAGE_JSON) },
    }]);
  });

  it('rejects an npm script that the approved package.json does not declare', () => {
    const noTest = JSON.stringify({ name: 'x', scripts: { start: 'node server.js' } });
    const result = parseAndValidateCodingProposal(
      proposal([{ kind: 'npm-test' }], [{ type: 'create', path: 'package.json', reason: 'scripts', content: noTest }]),
      [],
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContain('validation_command_unsupported');
  });

  it('rejects a different script than the one the approved package.json declares', () => {
    const result = parseAndValidateCodingProposal(proposal([{ kind: 'npm-script', script: 'build' }]), []);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContain('validation_command_unsupported');
  });

  it('never accepts arbitrary shell, script args, or a model-supplied authorization', () => {
    for (const command of [
      { kind: 'shell', command: 'rm -rf .' },
      { kind: 'npm-script', script: 'test', args: ['--', '&&', 'curl', 'x'] },
      { kind: 'npm-script', script: 'deploy', authorization: { source: 'approved-proposal-package-json', packageJsonSha256: 'x' } },
    ]) {
      const result = parseAndValidateCodingProposal(proposal([command]), []);
      expect(result.ok, JSON.stringify(command)).toBe(false);
    }
  });

  it('leaves existing-repository scripts unchanged (no proposal authorization attached)', () => {
    const result = parseAndValidateCodingProposal(proposal([{ kind: 'npm-test' }, { kind: 'npm-script', script: 'lint' }]), ['test', 'lint']);
    expect(result.ok && result.proposal.validationCommands).toEqual([{ kind: 'npm-test' }, { kind: 'npm-script', script: 'lint' }]);
  });
});

describe('governed runner enforcement of proposal script authorization', () => {
  let root: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const markerScript = JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'1\')"' } }, null, 2) + '\n';

  it('treats the authorization as stale and does not execute the script when package.json changed after approval', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-script-auth-stale-'));
    const changedAfterApproval = markerScript.replace('"scripts": {', '"scripts": {\n    "pretest": "node -e 0",');
    expect(changedAfterApproval).not.toBe(markerScript);
    await fs.writeFile(path.join(root, 'package.json'), changedAfterApproval);
    const [result] = await new CodingValidationRunner(root, 60_000).runAll([{
      kind: 'npm-test',
      authorization: { source: 'approved-proposal-package-json', packageJsonSha256: approvedPackageJsonFingerprint(markerScript) },
    }]);
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain('validation-authorization-stale');
    await expect(fs.stat(path.join(root, 'ran.txt'))).rejects.toThrow();
  });

  it('runs the authorized script when the on-disk package.json matches the approved content, including a CRLF checkout', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-script-auth-ok-'));
    await fs.writeFile(path.join(root, 'package.json'), markerScript.replace(/\n/g, '\r\n'));
    const [result] = await new CodingValidationRunner(root, 60_000).runAll([{
      kind: 'npm-test',
      authorization: { source: 'approved-proposal-package-json', packageJsonSha256: approvedPackageJsonFingerprint(markerScript) },
    }]);
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(root, 'ran.txt'), 'utf8')).toBe('1');
  });
});

class ScaffoldProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: 'qwen3-coder:30b', contextWindow: 40_960 }]; }
  async chat(_messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    return { message: { role: 'assistant', content: JSON.stringify({ action: 'submit_proposal', proposal: JSON.parse(proposal([{ kind: 'npm-test' }])) }) }, done: true };
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

describe('empty repository end-to-end through GovernedCodingExecutor', () => {
  let root: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('approved proposal creates package.json with "test", mutation writes it, and npm test actually runs', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-script-auth-e2e-'));
    await fs.writeFile(path.join(root, 'README.md'), '# empty\n');
    await initGit(root);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScaffoldProvider());
    const goal = 'Scaffold a Node project with a built-in test runner test.';
    const approvedValidation: unknown[] = [];
    const request: GovernedCodingExecutionRequest = {
      runId: 'script-auth-e2e',
      goal,
      workspaceRoot: root,
      signal: new AbortController().signal,
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
      auditSource: 'test',
      extensionBuild: 'test-build',
      model: 'qwen3-coder:30b',
      executionProfile: classifyExecutionProfile(goal),
      maxValidationRepairCycles: 0,
      callbacks: {
        checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
        reviewProposal: async () => true,
        approveExecution: async approved => { approvedValidation.push(...approved.validationCommands); return true; },
        confirmElevated: async () => true,
      },
    };

    const result = await new GovernedCodingExecutor().execute(request);

    expect(approvedValidation).toEqual([expect.objectContaining({ kind: 'npm-test', authorization: expect.objectContaining({ source: 'approved-proposal-package-json' }) })]);
    expect(result.status).toBe('completed');
    expect(result.validations).toEqual([expect.objectContaining({ command: 'npm test', exitCode: 0, timedOut: false })]);
    expect(result.validations[0].output).toMatch(/pass 1/);
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
  }, 60_000);
});
