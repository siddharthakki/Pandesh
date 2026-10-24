export interface ExecutionEnvironment {
  platform: NodeJS.Platform;
  shell: string;
  inspectGuidance: string;
  commandGuidance: string;
}

export function describeExecutionEnvironment(
  platform: NodeJS.Platform = process.platform,
): ExecutionEnvironment {
  if (platform === 'win32') {
    return {
      platform,
      shell: 'cmd.exe',
      inspectGuidance:
        'Prefer read_file to inspect files. Do not use Unix utilities (ls, cat, head, grep) or bash redirects such as 2>/dev/null; they fail on cmd.exe. List files with dir. For in-page UI checks use inspect_page on a workspace-relative HTML path, or on a live page on this machine (http://127.0.0.1:<port>/...). Do not install browsers or npm packages, and do not search for browser executables.',
      commandGuidance:
        'Commands run via cmd.exe /d /s /c. Use Windows command syntax. Quote commit messages with double quotes, not single quotes.',
    };
  }
  return {
    platform,
    shell: '/bin/sh',
      inspectGuidance:
        'Prefer read_file to inspect files rather than cat, head, or sed when exact file content is needed. For in-page UI checks use inspect_page on a workspace-relative HTML path, or on a live page on this machine (http://127.0.0.1:<port>/...). Do not install browsers or npm packages, and do not search for browser executables.',
    commandGuidance: 'Commands run via /bin/sh -c in the working directory.',
  };
}

export function executionEnvironmentPrompt(
  platform: NodeJS.Platform = process.platform,
): string {
  const env = describeExecutionEnvironment(platform);
  return `Operating environment: ${env.platform}. Shell: ${env.shell}. ${env.inspectGuidance} ${env.commandGuidance}`;
}

export function runCommandToolDescription(
  platform: NodeJS.Platform = process.platform,
): string {
  const env = describeExecutionEnvironment(platform);
  return `Run a command in the working directory via ${env.shell} and return combined stdout/stderr and exit code. ${env.inspectGuidance} ${env.commandGuidance}`;
}
