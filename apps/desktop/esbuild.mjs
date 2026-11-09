import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));

async function bundle() {
  await esbuild.build({
    entryPoints: [path.join(desktopRoot, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(desktopRoot, 'out', 'main.js'),
    sourcemap: true,
    external: ['electron', '@xenova/transformers', 'onnxruntime-web', 'onnxruntime-node', 'sharp'],
    logLevel: 'info',
  });
  await esbuild.build({
    entryPoints: [path.join(desktopRoot, 'src', 'preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(desktopRoot, 'out', 'preload.js'),
    sourcemap: true,
    external: ['electron'],
    logLevel: 'info',
  });
  // Phase 2 UI (PANDESH_UI_V2): React from the repository's existing
  // dependencies, bundled to one local script so the renderer CSP
  // (script-src 'self', no network) is unchanged.
  await esbuild.build({
    entryPoints: [path.join(desktopRoot, 'renderer-v2', 'src', 'main.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    jsx: 'automatic',
    // PANDESH_UI_V2_DEV=1: readable development bundle with inline source maps (debugging only).
    minify: process.env.PANDESH_UI_V2_DEV !== '1',
    sourcemap: process.env.PANDESH_UI_V2_DEV === '1' ? 'inline' : false,
    nodePaths: [path.join(desktopRoot, '..', '..', 'node_modules')],
    define: { 'process.env.NODE_ENV': process.env.PANDESH_UI_V2_DEV === '1' ? '"development"' : '"production"' },
    outfile: path.join(desktopRoot, 'renderer', 'v2', 'app.js'),
    logLevel: 'info',
  });
}

bundle().catch((err) => {
  console.error(err);
  process.exit(1);
});
