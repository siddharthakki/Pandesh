const esbuild = require('esbuild');

// Bundles the standalone Node CLIs consumed by `release:check`/`e2e:check`
// (npm run package:verify). These have no `vscode` import — unlike
// src/extension.ts (esbuild.js) and core/index.ts (esbuild.core.js), they
// were never wired into a build step, so `node out/release/cli.js` /
// `node out/e2e/cli.js` had nothing to run (tsconfig.json has `noEmit: true`,
// so `tsc -p ./` alone never produces out/release or out/e2e).
async function main() {
  await esbuild.build({
    entryPoints: ['src/release/cli.ts', 'src/e2e/cli.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outdir: 'out',
    outbase: 'src',
    external: ['vscode', '@vscode/sqlite3'],
    logLevel: 'info',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
