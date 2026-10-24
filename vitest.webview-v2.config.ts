import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/test/webview-v2/**/*.{test,spec}.tsx', 'src/test/webview-v2/**/*.{test,spec}.ts'],
    globals: false,
  },
  esbuild: {
    jsx: 'automatic',
  },
});
