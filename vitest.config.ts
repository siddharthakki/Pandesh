import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(process.cwd(), 'src/test/mocks/vscode.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/test/suite/**/*.{test,spec}.ts', 'core/test/**/*.{test,spec}.ts', 'apps/desktop/test/**/*.{test,spec}.ts'],
    // The exclusions mirror scripts/lib/test-impact.mjs's discovery rules
    // exactly: the platform tier has its own config, the live-model test
    // needs a real model, and the physical dogfood drives a real person's
    // workspace. A drift between the two would mean the "full sweep" and
    // the "impacted" tier disagree about what the repository contains.
    exclude: [
      'core/test/platform/**',
      'src/test/suite/agentPromptLive.test.ts',
      'src/test/suite/physicalDogfoodAcceptance.test.ts',
    ],
    setupFiles: ['src/test/setup/isolatedProfile.ts', 'src/test/setup/agentPanelHydration.ts'],
    // M15 autonomous-runtime tests drive real multi-stage governed graph runs
    // (fs + git + durable-queue round-trips per stage); the previous 5s default
    // left them marginal under full-suite load even before the in-chat
    // proposal/mutation approval gates added a few more durable-queue writes.
    testTimeout: 15_000,
    // Test FILES run in parallel again.
    //
    // The previous configuration forced `fileParallelism: false` because an
    // ASR test used to override an environment variable in place, and a
    // scoped override could then leak into another Core API test and report
    // the bundled transcription engine as unavailable. Every one of those
    // overrides is now an EXPLICIT env object handed to the function or to
    // the child Core process (`{ ...process.env, KARKEDIKHA_ASR_MODEL_DIR: … }`),
    // so nothing is written into the shared process environment any more and
    // the leak the guard was protecting against cannot happen.
    //
    // Keeping the files serial cost roughly four times the wall-clock of the
    // whole suite for no isolation benefit: each test file already runs in
    // its own isolated worker. The worker COUNT stays bounded so the suite
    // cannot outrun the machine's memory.
    fileParallelism: true,
    maxWorkers: Number(process.env.KARKEDIKHA_TEST_MAX_WORKERS ?? 4),
    minWorkers: 1,
    // A test file that leaves a child process running must not hang the
    // suite: Vitest's own teardown handles the rest.
    teardownTimeout: 20_000,
  },
});
