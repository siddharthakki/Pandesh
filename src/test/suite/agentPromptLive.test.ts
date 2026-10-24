import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';

const liveDescribe = process.env.RUN_LIVE_AGENT_TESTS === '1' ? describe : describe.skip;

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

async function write(root: string, relative: string, content: string): Promise<void> {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, 'utf8');
}

liveDescribe('live Ollama agent prompt smoke test', () => {
  let root: string;
  const testVscode = vscode as typeof vscode & {
    _setConfig(key: string, value: unknown): void;
    _resetConfig(): void;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-live-prompt-'));
    await write(root, 'package.json', JSON.stringify({
      name: 'live-prompt-fixture',
      scripts: {
        compile: 'node -e "process.exit(9)"',
        test: 'node -e "process.exit(9)"',
      },
    }, null, 2));
    await write(root, 'src/index.ts', 'export const value = 1;\n');
    await write(root, 'src/test/suite/one.test.ts', 'export {};\n');
    await write(root, 'src/test/suite/two.spec.ts', 'export {};\n');
    await write(root, 'notes/unrelated-jest-errors.txt', [
      'Jest is failing because ES modules are not configured.',
      'Fix the Jest configuration.',
    ].join('\n'));

    testVscode._setConfig('ollama-agent.providerType', 'ollama');
    testVscode._setConfig('ollama-agent.apiBase', process.env.OLLAMA_AGENT_LIVE_BASE ?? 'http://localhost:11434');
    testVscode._setConfig('ollama-agent.agentModel', process.env.OLLAMA_AGENT_LIVE_MODEL ?? 'qwen3-coder:30b');
    testVscode._setConfig('ollama-agent.chatModel', process.env.OLLAMA_AGENT_LIVE_MODEL ?? 'qwen3-coder:30b');
    testVscode._setConfig('ollama-agent.requestTimeout', 300_000);
    testVscode._setConfig('ollama-agent.maxIterations', 10);
  });

  afterEach(async () => {
    testVscode._resetConfig();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('answers an inspection prompt using read tools without validation repair', async () => {
    const runtime = new AgentRuntime(root, secretStorage());
    const toolNames: string[] = [];
    const errors: string[] = [];
    let finalContent = '';
    const prompt = [
      'This is a new independent task. Ignore all previous conversation history.',
      'Perform read-only repository inspection only.',
      'Use repository tools to read package.json, list files directly under src,',
      'and count files matching src/test/suite/*.test.ts and src/test/suite/*.spec.ts.',
      'Report only the package name, npm scripts, TypeScript source directory, and test file count.',
      'Do not diagnose test failures. Do not modify files. Do not propose fixes.',
      'Do not run Jest. Do not run validation commands.',
    ].join('\n');

    await runtime.run(
      prompt,
      'agent',
      {
        onToolStart: toolName => toolNames.push(toolName),
        onDone: content => { finalContent = content; },
        onError: message => errors.push(message),
      },
      undefined,
      process.env.OLLAMA_AGENT_LIVE_MODEL ?? 'qwen3-coder:30b',
      `live_prompt_${Date.now()}`,
    );

    const taskId = runtime.getTaskId();
    expect(taskId).toBeTruthy();
    const snapshot = await runtime.getTask(taskId!);

    expect(errors).toEqual([]);
    expect(snapshot.task.mode).toBe('ask');
    expect(snapshot.phase).toBe('completed');
    expect(snapshot.usage.repairAttempts).toBe(0);
    expect(toolNames).toContain('read_file');
    expect(toolNames.some(name => name === 'list_directory' || name === 'search_files')).toBe(true);
    expect(toolNames).not.toContain('run_command');
    expect(toolNames.some(name => [
      'write_file', 'edit_file', 'replace_in_file', 'apply_patch', 'create_directory',
    ].includes(name))).toBe(false);

    expect(finalContent).toContain('live-prompt-fixture');
    expect(finalContent).toMatch(/compile/i);
    expect(finalContent).toMatch(/test/i);
    expect(finalContent).toMatch(/\bsrc\b/i);
    expect(finalContent).toMatch(/(?:test file count\D*2|\b2\s+(?:test|files))/i);
    expect(finalContent).not.toMatch(/fix (?:the )?jest|es modules are not configured/i);
  }, 360_000);
});
