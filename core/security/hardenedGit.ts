/**
 * M54-A0 Hardened Host-Side Git Invocations.
 *
 * Neutralizes repository-planted execution triggers (.git/config hooks,
 * core.fsmonitor, diff.external, filters, protocol helpers).
 */
import { createSanitizedChildEnvironment } from './childEnvironment';

export const HARDENED_GIT_CONFIG_FLAGS: readonly string[] = [
  '-c', 'core.hooksPath=',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
  '-c', 'protocol.ext.allow=never',
  '-c', 'core.editor=',
];

export function hardenedGitArgs(userArgs: readonly string[]): string[] {
  return [...HARDENED_GIT_CONFIG_FLAGS, ...userArgs];
}

export function hardenedGitEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return createSanitizedChildEnvironment(process.env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...overrides,
  });
}


import * as child_process from 'node:child_process';

export function runHardenedGit(
  args: readonly string[],
  options: child_process.SpawnSyncOptions = {},
): child_process.SpawnSyncReturns<Buffer | string> {
  const finalArgs = hardenedGitArgs(args);
  const finalEnv = hardenedGitEnv(options.env as Record<string, string>);
  return child_process.spawnSync('git', finalArgs, {
    ...options,
    env: finalEnv,
  });
}
