#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { warmModels } from './realModelWarmupHarness.mjs';

function valueFor(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const evidencePath = valueFor('--evidence');
if (!evidencePath) throw new Error('--evidence <path> is required');

const timeoutMs = Number(valueFor('--timeout-ms') ?? process.env.KARKEDIKHA_REAL_MODEL_WARMUP_TIMEOUT_MS ?? 180000);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');

const url = process.env.KARKEDIKHA_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const model = process.env.KARKEDIKHA_ACCEPTANCE_MODEL ?? 'qwen2.5:14b';
const codingModel = process.env.KARKEDIKHA_ACCEPTANCE_CODING_MODEL ?? 'qwen3-coder:30b';
const models = [...new Set([model, codingModel])].map((candidate) => ({
  model: candidate,
  purpose: candidate === codingModel ? 'coding' : 'chat',
}));

const evidence = await warmModels({ url, models, timeoutMs });
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
for (const result of evidence.models) {
  console.log(`[real-model-warmup] ${result.model} ${result.status} elapsedMs=${result.elapsedMs} timeoutMs=${result.timeoutMs}${result.error ? ` error=${result.error}` : ''}`);
}
console.log(`[real-model-warmup] status=${evidence.status} exitCode=${evidence.exitCode} evidence=${evidencePath}`);
process.exitCode = evidence.exitCode;
