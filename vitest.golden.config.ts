import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Golden-journey integration suite: drives the REAL AgentPanel (host) and the
// REAL webview-v2 React app in the same process, connected by a fake
// postMessage channel that stands in for VS Code's webview bridge. Needs
// jsdom (for React) *and* the `vscode` module alias (for AgentPanel) at once,
// which the existing split configs (vitest.config.ts = node,
// vitest.webview-v2.config.ts = jsdom, no vscode alias) don't provide
// together — hence a dedicated config rather than overloading either.
export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(process.cwd(), 'src/test/mocks/vscode.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/test/golden/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/test/setup/agentPanelHydration.ts'],
    testTimeout: 20_000,
    fileParallelism: false,
  },
  esbuild: {
    jsx: 'automatic',
  },
});
