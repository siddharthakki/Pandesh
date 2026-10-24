// Focused, standalone package-content assertion for the production VSIX.
//
// Usage as a module: import { assertPackagedContent } and call it with the
// path to an *extracted* VSIX's `extension/` directory.
// Usage as a CLI: node scripts/acceptance/packageContentAssertion.mjs <extractedExtensionDir>
//
// This does not trust .vscodeignore assumptions — it inspects the actual
// produced VSIX contents (paths and, for text files, contents) and fails
// loudly on any prohibited harness/test/orchestration material, and
// separately verifies required production assets are present.

import * as fs from 'fs';
import * as path from 'path';

export const PROHIBITED_SUBSTRINGS = [
  'scripts/acceptance',
  'scripts\\acceptance',
  'companion-driver',
  'fakeOllamaServer',
  'run-packaged-acceptance',
  'runInHost',
  'uiDriver',
  'plainVsCodeHost',
  'acceptanceHarness',
  'autoApprove',
  'm32AcceptanceHarness',
  'm32-saathcancel-fixture',
  'ping -n 20 127.0.0.1',
];

const TEXT_FILE_EXTENSIONS = new Set(['.js', '.json', '.md', '.txt', '.ts', '.mjs', '.cjs']);
const MAX_TEXT_SCAN_BYTES = 2 * 1024 * 1024; // skip scanning huge bundled files (e.g. .node binaries never match anyway)

// out/extension.js and out-core/core.js are the ONLY shipped JS artifacts (see esbuild.js /
// esbuild.core.js + .vscodeignore): everything under src/ and core/ is bundled into these two
// single files, so individual pre-bundle module paths (e.g. out/coding/GovernedCodingExecutor.js)
// never exist in a packaged VSIX and must not be asserted here.
const REQUIRED_FILES = [
  'package.json',
  path.join('out', 'extension.js'),
  path.join('out-core', 'core.js'),
  // M35 — the inline-approval webview ships as unbundled static assets under
  // media/, not inside out/extension.js (see m35InlineApprovalTimeline.test.ts
  // "ships the inline behavior in the packaged webview"). Package-content
  // assertion previously never confirmed these actually made it into the
  // VSIX; a .vscodeignore regression here would have shipped silently.
  path.join('media', 'chat.html'),
  path.join('media', 'chat.js'),
  path.join('media', 'chat-sidebar-ui.js'),
  path.join('media', 'chat-autonomous.js'),
];

function walk(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        results.push(full);
      }
    }
  }
  return results;
}

function isProbablySourceTs(filePath) {
  return /\.tsx?$/.test(filePath) && !/\.d\.tsx?$/.test(filePath) && !filePath.includes(`${path.sep}out${path.sep}`);
}

/**
 * @param {string} extractedExtensionDir absolute path to the extracted VSIX's `extension/` directory
 */
export function assertPackagedContent(extractedExtensionDir) {
  const allFiles = walk(extractedExtensionDir);

  const topLevelDirs = fs
    .readdirSync(extractedExtensionDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  const prohibitedPathMatches = [];
  const prohibitedStringMatches = [];

  for (const file of allFiles) {
    const relative = path.relative(extractedExtensionDir, file);
    for (const needle of PROHIBITED_SUBSTRINGS) {
      if (relative.includes(needle)) {
        prohibitedPathMatches.push({ file: relative, needle });
      }
    }
    if (isProbablySourceTs(file)) {
      prohibitedPathMatches.push({ file: relative, needle: '<production .ts source file>' });
    }

    const ext = path.extname(file).toLowerCase();
    if (TEXT_FILE_EXTENSIONS.has(ext)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const isRuntimeBundle = relative === path.join('out', 'extension.js')
        || relative === path.join('out-core', 'core.js');
      if (stat.size > MAX_TEXT_SCAN_BYTES && !isRuntimeBundle) continue;

      // package.json's own "scripts" field holds npm devtool script
      // definitions (e.g. "node scripts/acceptance/run-packaged-
      // acceptance.mjs"). VS Code never executes that field at runtime for
      // an installed extension, so it is inert manifest metadata, not
      // shipped harness code. Scan the rest of package.json (contributes,
      // main, activationEvents, dependencies, ...) normally.
      let content;
      if (relative === 'package.json') {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete parsed.scripts;
        content = JSON.stringify(parsed);
      } else {
        content = fs.readFileSync(file, 'utf8');
      }
      for (const needle of PROHIBITED_SUBSTRINGS) {
        if (content.includes(needle)) {
          prohibitedStringMatches.push({ file: relative, needle });
        }
      }
    }
  }

  const requiredFileResults = REQUIRED_FILES.map(relative => {
    const full = path.join(extractedExtensionDir, relative);
    return { file: relative, present: fs.existsSync(full) };
  });

  const referencedPandaAssets = new Set();
  for (const file of allFiles) {
    const relative = path.relative(extractedExtensionDir, file);
    if (!relative.startsWith(`media${path.sep}`) || !/\.(?:js|html|css)$/.test(relative)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(/['"`]([a-z0-9-]+\.webp)['"`]/gi)) {
      referencedPandaAssets.add(match[1]);
    }
  }
  const pandaAssetResults = [...referencedPandaAssets].sort().map(file => ({
    file: path.join('media', 'panda', file),
    present: fs.existsSync(path.join(extractedExtensionDir, 'media', 'panda', file)),
  }));

  let commandContributionResult = { present: false, detail: 'package.json missing or unreadable' };
  const packageJsonPath = path.join(extractedExtensionDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const commands = pkg.contributes?.commands ?? [];
    const found = commands.some(cmd => cmd.command === 'ollama-agent.startAutonomousTask');
    commandContributionResult = {
      present: found,
      detail: found
        ? 'ollama-agent.startAutonomousTask is contributed in packaged package.json'
        : 'ollama-agent.startAutonomousTask NOT found in packaged package.json contributes.commands',
    };
  }

  const report = {
    extractedExtensionDir,
    packagedFileCount: allFiles.length,
    topLevelDirs,
    prohibitedPathMatches,
    prohibitedStringMatches,
    requiredFileResults,
    pandaAssetResults,
    commandContributionResult,
  };

  const missingRequired = requiredFileResults.filter(r => !r.present);
  const missingPandaAssets = pandaAssetResults.filter(r => !r.present);
  const ok =
    prohibitedPathMatches.length === 0 &&
    prohibitedStringMatches.length === 0 &&
    missingRequired.length === 0 &&
    missingPandaAssets.length === 0 &&
    commandContributionResult.present;

  return { ok, report };
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/acceptance/packageContentAssertion.mjs <extractedExtensionDir>');
    process.exit(2);
  }
  const { ok, report } = assertPackagedContent(path.resolve(target));
  console.log(JSON.stringify(report, null, 2));
  if (!ok) {
    console.error('FAILED: prohibited content present or required content missing.');
    process.exit(1);
  }
  console.log('PASSED: package-content assertion.');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'packageContentAssertion.mjs') {
  main();
}
