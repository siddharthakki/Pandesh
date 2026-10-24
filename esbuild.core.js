const esbuild = require('esbuild');
// The Core reports the SAME version as the app it ships inside. The single
// authoritative version string is `apps/desktop/package.json` — the product's
// own manifest, which Electron's app.getVersion() also reads. Reading the
// root package.json here would be a second copy that could drift.
const productPackageJson = require('./apps/desktop/package.json');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['core/index.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node22',
    outfile: 'out-core/core.js',
    // node:sqlite and node:* built-ins are resolved at runtime by the Electron-bundled Node; 'ws'
    // is bundled in (single-file Core, zero runtime node_modules dependency).
    //
    // @xenova/transformers (M36 pass-2 local audio transcription) and its
    // onnxruntime-web dependency are the one deliberate exception: they ship
    // real WASM binary files that must be loaded from disk at runtime, which
    // a single-file JS bundle cannot inline (unlike pdfjs-dist/mammoth, both
    // pure JS). Left external and resolved at runtime against the real
    // node_modules/@xenova + node_modules/onnxruntime-web directories shipped
    // alongside out-core/core.js in the packaged VSIX (see .vscodeignore) —
    // the same "real files, not inlined" treatment already used for
    // @vscode/sqlite3's native binary. `sharp`/`onnxruntime-node` are
    // optional dependencies of that dependency tree that core/attachments/
    // audioProcessing.ts's audio-only usage never actually imports; excluded
    // from bundling defensively so a missing optional native package can
    // never break the Core bundle build.
    external: ['@xenova/transformers', 'onnxruntime-web', 'onnxruntime-node', 'sharp'],
    define: {
      __KARKEDIKHA_CORE_VERSION__: JSON.stringify(productPackageJson.version),
    },
    logLevel: 'info',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
