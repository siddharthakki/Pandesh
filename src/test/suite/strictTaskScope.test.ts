import { describe, expect, it } from 'vitest';
import {
  canonicalizeStrictTaskArguments,
  evaluateStrictTaskAction,
  extractStrictTaskScope,
} from '../../agent/StrictTaskScope';

const prompt = `Create exactly one new file:

docs/agent-smoke-test.md

Use exactly this content:

# Ollama Agent Smoke Test

* Workspace grounding: passed
* Model routing: passed
* Tool execution: passed
* Controlled write: passed

Requirements:

1. Do not modify any other file.
2. Request approval before creating the file.
3. After creating it, run \`npm run compile\`.
4. Do not run any other command.
5. Report the file created and whether compilation passed.`;

const expectedContent = `# Ollama Agent Smoke Test

* Workspace grounding: passed
* Model routing: passed
* Tool execution: passed
* Controlled write: passed`;

describe('strict task scope', () => {
  it('extracts the exact file, content, and command from a bounded task', () => {
    const scope = extractStrictTaskScope(prompt);

    expect(scope.strict).toBe(true);
    expect(scope.allowedPaths).toEqual(['docs/agent-smoke-test.md']);
    expect(scope.allowedCommands).toEqual(['npm run compile']);
    expect(scope.exactFileContents['docs/agent-smoke-test.md']).toBe(expectedContent);
  });

  it('allows the exact requested write', () => {
    const violation = evaluateStrictTaskAction(extractStrictTaskScope(prompt), {
      toolName: 'write_file',
      paths: ['docs/agent-smoke-test.md'],
      arguments: { path: 'docs/agent-smoke-test.md', content: expectedContent },
      workspaceRoot: 'C:\\Projects\\Jarvis',
      mutatesWorkspace: true,
    });

    expect(violation).toBeUndefined();
  });

  it('canonicalizes model-reconstructed content for the exact requested path', () => {
    const scope = extractStrictTaskScope(prompt);
    const args = canonicalizeStrictTaskArguments(
      scope,
      'write_file',
      { path: 'docs/agent-smoke-test.md', content: '# Different smoke test' },
      'C:\\Projects\\Jarvis',
    );

    expect(args).toEqual({
      path: 'docs/agent-smoke-test.md',
      content: expectedContent,
    });
    expect(evaluateStrictTaskAction(scope, {
      toolName: 'write_file',
      paths: ['docs/agent-smoke-test.md'],
      arguments: args,
      workspaceRoot: 'C:\\Projects\\Jarvis',
      mutatesWorkspace: true,
    })).toBeUndefined();
  });

  it('does not canonicalize another file', () => {
    const scope = extractStrictTaskScope(prompt);
    const args = canonicalizeStrictTaskArguments(
      scope,
      'write_file',
      { path: 'agent-smoke-test.js', content: 'console.log("test")' },
      'C:\\Projects\\Jarvis',
    );

    expect(args).toEqual({ path: 'agent-smoke-test.js', content: 'console.log("test")' });
    expect(evaluateStrictTaskAction(scope, {
      toolName: 'write_file',
      paths: ['agent-smoke-test.js'],
      arguments: args,
      workspaceRoot: 'C:\\Projects\\Jarvis',
      mutatesWorkspace: true,
    })).toMatch(/outside the exact file scope/i);
  });

  it('allows only the named command', () => {
    const scope = extractStrictTaskScope(prompt);
    expect(evaluateStrictTaskAction(scope, {
      toolName: 'run_command',
      paths: [],
      command: 'npm run compile',
      arguments: { command: 'npm run compile' },
      workspaceRoot: 'C:\\Projects\\Jarvis',
      mutatesWorkspace: true,
    })).toBeUndefined();

    expect(evaluateStrictTaskAction(scope, {
      toolName: 'run_command',
      paths: [],
      command: 'dir',
      arguments: { command: 'dir' },
      workspaceRoot: 'C:\\Projects\\Jarvis',
      mutatesWorkspace: true,
    })).toMatch(/outside the exact command scope/i);
  });
});
