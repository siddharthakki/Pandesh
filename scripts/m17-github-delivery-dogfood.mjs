#!/usr/bin/env node
// Explicitly opt-in real GitHub delivery acceptance. Never included in `npm run verify`.
import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
createRequire(import.meta.url)('./acceptance/m17-vscode-node-hook.cjs');
const sourceRoot = process.env.OA_GITHUB_DELIVERY_SOURCE_ROOT
  ? path.resolve(process.env.OA_GITHUB_DELIVERY_SOURCE_ROOT)
  : repoRoot;
const { M17DogfoodFailure, runM17GitHubDeliveryDogfood } = await import('../out/acceptance/M17GitHubDeliveryDogfood.js');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm17-github-delivery');

try {
  const evidence = await runM17GitHubDeliveryDogfood({ repositoryRoot: sourceRoot });
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, `${evidence.runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`M17_GITHUB_DELIVERY_DOGFOOD=${JSON.stringify(evidence)}`);
} catch (error) {
  const evidence = error instanceof M17DogfoodFailure ? error.evidence : undefined;
  if (evidence) {
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, `${evidence.runId}-failed.json`), `${JSON.stringify({ ...evidence, failure: error.message }, null, 2)}\n`, 'utf8');
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
