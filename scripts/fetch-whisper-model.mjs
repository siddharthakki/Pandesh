#!/usr/bin/env node
// node scripts/fetch-whisper-model.mjs
//
// Fetches (once) the quantized whisper-base.en ONNX model files used by
// core/attachments/audioProcessing.ts for real local audio transcription,
// into ./models/whisper-base-en/ — a build-time step, never a runtime
// network call. The packaged extension loads these files locally
// (`env.allowRemoteModels = false`, `env.localModelPath` pointed at this
// directory) so a user running the packaged VSIX never needs network access
// to transcribe audio. Idempotent: skips entirely if the expected files are
// already present (e.g. already fetched by a previous `npm run
// package:win32-x64`), so this is safe to run on every build.
//
// Uses @xenova/transformers' own model-fetch machinery (the same code path
// that would otherwise run lazily at first-use in a dev environment) rather
// than a hand-rolled HTTP downloader, so the fetched files are guaranteed to
// be in exactly the shape the runtime pipeline expects.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const modelsDir = path.join(repoRoot, 'models');
const modelId = 'Xenova/whisper-base.en';
const modelDir = path.join(modelsDir, 'whisper-base-en');

const REQUIRED_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  path.join('onnx', 'encoder_model_quantized.onnx'),
  path.join('onnx', 'decoder_model_merged_quantized.onnx'),
];

function alreadyFetched() {
  return REQUIRED_FILES.every((relPath) => fs.existsSync(path.join(modelDir, modelId, relPath)));
}

async function main() {
  if (alreadyFetched()) {
    console.log(`[fetch-whisper-model] already present at ${path.join(modelDir, modelId)} — skipping fetch.`);
    return;
  }
  fs.mkdirSync(modelDir, { recursive: true });

  const { env, pipeline } = await import('@xenova/transformers');
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // this build-time fetch is the one legitimate network use
  env.localModelPath = modelDir;
  env.cacheDir = modelDir;
  env.useBrowserCache = false;

  console.log(`[fetch-whisper-model] fetching ${modelId} into ${modelDir} (build-time only; the packaged runtime never fetches over the network)...`);
  // Constructing the pipeline downloads (and quantized-caches) every file the
  // runtime will need; we don't need to keep the pipeline instance itself.
  await pipeline('automatic-speech-recognition', modelId, { quantized: true });

  if (!alreadyFetched()) {
    throw new Error(`fetch-whisper-model: expected files still missing after fetch under ${path.join(modelDir, modelId)}`);
  }
  console.log('[fetch-whisper-model] done.');
}

main().catch((err) => {
  console.error('[fetch-whisper-model] FAILED:', err);
  process.exit(1);
});
