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
}

bundle().catch((err) => {
  console.error(err);
  process.exit(1);
});
