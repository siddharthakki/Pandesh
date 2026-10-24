#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const [, , requestedEntry, ...forwardedArgs] = process.argv;
if (!requestedEntry) {
  process.stderr.write('Usage: node scripts/run-bundled-entry.mjs <entry.ts|entry.mjs> [...args]\n');
  process.exitCode = 2;
} else {
  const repositoryRoot = process.cwd();
  const entry = path.resolve(repositoryRoot, requestedEntry);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'karkedikha-bundled-entry-'));
  const esm = path.extname(entry) === '.mjs';
  const output = path.join(temporaryRoot, esm ? 'entry.mjs' : 'entry.cjs');
  const headlessAcceptance = path.basename(entry) === 'm18-m22-headless-e2e.mjs';

  try {
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: esm ? 'esm' : 'cjs',
      target: 'node20',
      packages: 'external',
      sourcemap: 'inline',
      sourcesContent: false,
      logLevel: 'warning',
      plugins: [sourceResolutionPlugin(repositoryRoot, headlessAcceptance)],
    });

    const exitCode = await runNode(output, forwardedArgs, repositoryRoot);
    process.exitCode = exitCode;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function sourceResolutionPlugin(repositoryRoot, headlessAcceptance) {
  return {
    name: 'karkedikha-source-resolution',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/out\// }, args => {
        const relative = args.path.slice('../out/'.length).replace(/\.js$/i, '.ts');
        return { path: path.join(repositoryRoot, 'src', relative) };
      });
      if (headlessAcceptance) {
        buildApi.onResolve({ filter: /^vscode$/ }, () => ({
          path: path.join(repositoryRoot, 'src', 'test', 'mocks', 'vscode.ts'),
        }));
      }
    },
  };
}

function runNode(entry, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.stderr.write(`Bundled entry terminated by signal ${signal}.\n`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
