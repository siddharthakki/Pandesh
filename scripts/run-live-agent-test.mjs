import { spawnSync } from 'node:child_process';
import path from 'node:path';

const vitestEntry = path.join('node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(
  process.execPath,
  [vitestEntry, 'run', 'src/test/suite/agentPromptLive.test.ts', '--reporter=verbose'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      RUN_LIVE_AGENT_TESTS: '1',
    },
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
