const path = require('path');
const common = { bundle: true, platform: 'node', external: ['vscode-nonexistent'], logLevel: 'warning', alias: { vscode: path.resolve('src/test/mocks/vscode.ts') } };
Promise.all([
  require('esbuild').build({ ...common, entryPoints: ['bench/repo_bench.ts'], outfile: 'out-bench/repo_bench.js' }),
  require('esbuild').build({ ...common, entryPoints: ['bench/fastpath_bench.ts'], outfile: 'out-bench/fastpath_bench.js' }),
  require('esbuild').build({ ...common, entryPoints: ['bench/e2e_ollama.ts'], outfile: 'out-bench/e2e_ollama.js' }),
]).catch(() => process.exit(1));
