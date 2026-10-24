// M42 real dogfood: real AutonomousTaskRuntime + a real local Ollama model.
//   node scripts/run-live-m42-dogfood.mjs                 # natural run
//   node scripts/run-live-m42-dogfood.mjs --inject-incident  # replay the incomplete-proposal failure class first
// Env: OLLAMA_AGENT_M42_MODEL (default qwen3.8:27b-mtp-q4_K_M), OLLAMA_AGENT_M42_KEEP=1 to keep the fixture repo.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const vitestEntry = path.join('node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(
  process.execPath,
  [vitestEntry, 'run', 'src/test/suite/m42LiveDogfood.test.ts', '--reporter=verbose'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      OLLAMA_AGENT_RUN_LIVE_M42: '1',
      ...(process.argv.includes('--inject-incident') ? { OLLAMA_AGENT_M42_INJECT_INCIDENT: '1' } : {}),
    },
  },
);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
