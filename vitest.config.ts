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
    exclude: ['core/test/platform/**', 'src/test/suite/agentPromptLive.test.ts'],
    setupFiles: ['src/test/setup/agentPanelHydration.ts'],
    // M15 autonomous-runtime tests drive real multi-stage governed graph runs
    // (fs + git + durable-queue round-trips per stage); the previous 5s default
    // left them marginal under full-suite load even before the in-chat
    // proposal/mutation approval gates added a few more durable-queue writes.
    testTimeout: 15_000,
    // M36's honest-unavailable ASR coverage temporarily supplies a process
    // environment override. Files must not run concurrently with the real
    // transcription coverage, or that scoped override can leak into another
    // Core API test and falsely report the bundled engine as unavailable.
    fileParallelism: false,
  },
});
