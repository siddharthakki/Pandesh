import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { MockProvider } from '../mocks/MockProvider';

const INSPECTION_PROMPT = [
  'This is a new independent task. Ignore all previous conversation history.',
  'Perform read-only repository inspection only.',
  'Use repository tools to:',
  '1. read package.json,',
  '2. list the files directly under src,',
  '3. count files matching src/test/suite/*.test.ts and src/test/suite/*.spec.ts.',
  'Report only the package name, npm scripts, TypeScript source directory, and test file count.',
  'Do not diagnose test failures. Do not modify files. Do not propose fixes.',
  'Do not run Jest. Do not run validation commands.',
].join('\n');

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

describe('prompt-driven agent regression', () => {
  let root: string;
  let provider: MockProvider;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-prompt-regression-'));
    await write(root, 'package.json', JSON.stringify({
      name: 'prompt-fixture',
      scripts: {
        compile: 'node -e "process.exit(9)"',
        test: 'node -e "process.exit(9)"',
      },
    }, null, 2));
    await write(root, 'src/index.ts', 'export const value = 1;\n');
    await write(root, 'src/test/suite/one.test.ts', 'export {};\n');
    await write(root, 'src/test/suite/two.spec.ts', 'export {};\n');
    await write(root, 'notes/jest-failure.txt', [
      'Jest is failing because ES modules are not configured.',
      'Fix the Jest configuration and TypeScript syntax errors.',
    ].join('\n'));

    provider = new MockProvider();
    provider
      .enqueueToolCall('read_file', { path: 'package.json' }, 'call_read_package')
      .enqueueToolCall('list_directory', { path: 'src', depth: 1 }, 'call_list_src')
      .enqueueToolCall('list_directory', { path: 'src/test/suite', depth: 1 }, 'call_list_tests')
      .enqueueText([
        'Package name: prompt-fixture',
        'npm scripts: compile, test',
        'TypeScript source directory: src',
        'Test file count: 2',
      ].join('\n'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    runtime = new AgentRuntime(root, secretStorage());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('prompts the runtime, uses read tools, validates the report, and never enters repair', async () => {
    const tools: string[] = [];
    let finalContent = '';
    const errors: string[] = [];

    await runtime.run(
      INSPECTION_PROMPT,
      'agent',
      {
        onToolStart: toolName => tools.push(toolName),
        onDone: content => { finalContent = content; },
        onError: message => errors.push(message),
      },
      undefined,
      'qwen3-coder:30b',
      'prompt_readonly_inspection',
    );

    const snapshot = await runtime.getTask('prompt_readonly_inspection');
    const eventState = await runtime.taskStore.getEvents('prompt_readonly_inspection');
    const firstRequestText = provider.capturedRequests[0].messages
      .filter(message => message.role === 'user')
      .map(message => message.content)
      .join('\n');

    expect(snapshot.task.mode).toBe('ask');
    expect(snapshot.phase).toBe('completed');
    expect(snapshot.usage.repairAttempts).toBe(0);
    expect(snapshot.validationPassed).toBe(true);
    expect(errors).toEqual([]);
    expect(tools).toEqual(['read_file', 'list_directory', 'list_directory']);
    expect(tools).not.toContain('run_command');
    expect(tools).not.toEqual(expect.arrayContaining([
      'write_file', 'edit_file', 'replace_in_file', 'apply_patch', 'create_directory',
    ]));

    expect(firstRequestText).toContain('Perform read-only repository inspection only.');
    expect(firstRequestText).not.toContain('Automatically selected repository context');
    expect(firstRequestText).not.toContain('Jest is failing');

    expect(finalContent).toContain('prompt-fixture');
    expect(finalContent).toContain('compile, test');
    expect(finalContent).toContain('TypeScript source directory: src');
    expect(finalContent).toContain('Test file count: 2');
    expect(finalContent).not.toMatch(/fix (?:the )?jest|es modules are not configured/i);

    expect(eventState.events.some(event => event.type === 'repair_started')).toBe(false);
    expect(eventState.events.some(event =>
      event.type === 'validation_result' && event.payload['skippedForMode'] === true,
    )).toBe(true);
  });
});
