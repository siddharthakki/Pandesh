const esbuild = require('esbuild');
const { execSync } = require('child_process');

// Build identity (see src/onboarding/BuildIdentity.ts). Failure to read git must never fail the build.
function git(args) {
  try { return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
}
const buildSha = git('rev-parse --short HEAD');
// Untracked files and the packaging artefacts do not make a build "dirty"; only modified tracked sources do.
const buildDirty = Boolean(git('status --porcelain --untracked-files=no -- src core package.json esbuild.js'));

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode', '@vscode/sqlite3'],
    logLevel: 'info',
    define: {
      __KKD_BUILD_SHA__: JSON.stringify(buildSha),
      __KKD_BUILD_DIRTY__: JSON.stringify(buildDirty),
      __KKD_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
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
