// M46 real dogfood: real AutonomousTaskRuntime + a real local Ollama model on a multi-file bug.
//   node scripts/run-live-m46-dogfood.mjs --model <name> [--autonomy off] [--adaptive-schema off] [--scenario cart|ladder]
//        [--context 8192] [--out results.jsonl] [--timeout-min 20]
// Runs one model/mode. Loop over models and `--autonomy off|on` for the A/B comparison.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const vitestEntry = path.join('node_modules', 'vitest', 'vitest.mjs');
const env = {
  ...process.env,
  OLLAMA_AGENT_RUN_LIVE_M46: '1',
  OLLAMA_AGENT_M46_MODEL: arg('model', process.env.OLLAMA_AGENT_M46_MODEL ?? 'qwen3.8:27b-mtp-q4_K_M'),
  OLLAMA_AGENT_M46_AUTONOMY: arg('autonomy', 'on') === 'off' ? '0' : '1',
  OLLAMA_AGENT_ADAPTIVE_SCHEMA: arg('adaptive-schema', 'on') === 'off' ? '0' : '1',
  OLLAMA_AGENT_M46_SCENARIO: arg('scenario', 'cart'),
  ...(arg('inject', 'off') === 'on' ? { OLLAMA_AGENT_M46_INJECT: '1' } : {}),
  ...(arg('weak-validation', 'off') === 'on' ? { OLLAMA_AGENT_M46_WEAKVAL: '1' } : {}),
};
if (arg('context')) env.OLLAMA_AGENT_M46_CONTEXT = arg('context');
if (arg('out')) env.OLLAMA_AGENT_M46_OUT = path.resolve(arg('out'));
if (arg('timeout-min')) env.OLLAMA_AGENT_M46_TIMEOUT_MIN = arg('timeout-min');

const result = spawnSync(
  process.execPath,
  [vitestEntry, 'run', 'src/test/suite/m46LiveDogfood.test.ts', '--reporter=verbose'],
  { stdio: 'inherit', env },
);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
