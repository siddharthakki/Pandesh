import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { vscode: resolve(process.cwd(), 'src/test/mocks/vscode.ts') } },
  test: {
    environment: 'node',
    include: ['core/test/platform/**/*.platform.test.ts'],
    setupFiles: ['src/test/setup/agentPanelHydration.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
