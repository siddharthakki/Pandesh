// M46 ablation: N runs per arm, interleaved (arm order rotates each round) so drift affects every arm equally.
//   node scripts/run-live-m46-ablation.mjs --model gemma4:12b --runs 10 --out ablation.jsonl [--scenario cart|ladder] [--context 8192] [--arms off,noadaptive,adaptive]
// Arms: off = M46 disabled (M42/M45 baseline); noadaptive = M46 on, adaptive schema disabled; adaptive = M46 on, adaptive schema enabled.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const ARM_ARGS = {
  off: ['--autonomy', 'off', '--adaptive-schema', 'off'],
  noadaptive: ['--autonomy', 'on', '--adaptive-schema', 'off'],
  adaptive: ['--autonomy', 'on', '--adaptive-schema', 'on'],
};
const arms = arg('arms', 'off,noadaptive,adaptive').split(',');
const runs = Number(arg('runs', '10'));
const out = path.resolve(arg('out', 'm46-ablation.jsonl'));
const base = ['scripts/run-live-m46-dogfood.mjs', '--model', arg('model', 'gemma4:12b'), '--scenario', arg('scenario', 'cart'), '--out', out];
if (arg('context')) base.push('--context', arg('context'));
if (arg('timeout-min')) base.push('--timeout-min', arg('timeout-min'));

for (let round = 0; round < runs; round += 1) {
  const order = arms.map((_, index) => arms[(index + round) % arms.length]);
  for (const arm of order) {
    console.log(`ABLATION round=${round + 1}/${runs} arm=${arm} ${new Date().toISOString()}`);
    const result = spawnSync(process.execPath, [...base, ...ARM_ARGS[arm]], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const line = (result.stdout ?? '').split('\n').find(text => text.includes('M46_LIVE_RESULT'));
    console.log(line ? `  -> ${line.slice(line.indexOf('{')).slice(0, 220)}` : `  -> NO RESULT (exit ${result.status}) ${(result.stderr ?? '').slice(-300)}`);
  }
}
