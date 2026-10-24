import { describe, expect, it } from 'vitest';
import { CoreToolRunner } from '../runtime/toolRunner';
import {
  describeExecutionEnvironment,
  executionEnvironmentPrompt,
  runCommandToolDescription,
} from '../runtime/executionEnvironment';

describe('execution environment', () => {
  it('describes Windows cmd.exe and steers inspection to read_file', () => {
    const env = describeExecutionEnvironment('win32');
    expect(env.shell).toBe('cmd.exe');
    expect(env.inspectGuidance).toMatch(/read_file/);
    expect(env.inspectGuidance).toMatch(/ls, cat, head/);
    expect(env.inspectGuidance).toMatch(/inspect_page/);
    expect(env.commandGuidance).toMatch(/double quotes/);
    expect(runCommandToolDescription('win32')).toMatch(/cmd\.exe/);
    expect(executionEnvironmentPrompt('win32')).toMatch(/win32/);
  });

  it('describes POSIX /bin/sh without Windows cmd syntax', () => {
    const env = describeExecutionEnvironment('linux');
    expect(env.shell).toBe('/bin/sh');
    expect(runCommandToolDescription('linux')).not.toMatch(/cmd\.exe/);
  });

  it('exposes the live-shell description on the run_command tool', () => {
    const runner = new CoreToolRunner();
    const runCommand = runner.definitions().find((tool) => tool.name === 'run_command');
    expect(runCommand?.description).toMatch(/read_file/);
    if (process.platform === 'win32') {
      expect(runCommand?.description).toMatch(/cmd\.exe/);
    } else {
      expect(runCommand?.description).toMatch(/\/bin\/sh/);
    }
  });
});
