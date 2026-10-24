#!/usr/bin/env node

import childProcess from 'child_process';
import { syncBuiltinESMExports } from 'module';

const originalSpawnSync = childProcess.spawnSync;

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

if (process.platform === 'win32') {
  childProcess.spawnSync = function spawnSyncWithWindowsArgumentSafety(command, args = [], options = {}) {
    if (options.shell === true) {
      const executable = command === 'npm' || command === 'npx' ? `${command}.cmd` : command;
      const invocation = [executable, ...args].map(quotePowerShellLiteral).join(' ');
      const script = `& ${invocation}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
      return originalSpawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { ...options, shell: false },
      );
    }
    return originalSpawnSync(command, args, options);
  };
  syncBuiltinESMExports();
}

await import('./m22-live-production-dogfood.mjs');
