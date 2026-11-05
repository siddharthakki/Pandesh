/**
 * Which test files a change can possibly break.
 *
 * The repository has ~650 Vitest files. Running all of them after every
 * source edit is the reason feedback takes tens of minutes, so the scoped
 * tiers need a defensible answer to "what could this change break?".
 *
 * The mapping is derived from the real import graph, not from a hand-kept
 * list: a test file is impacted when it imports a changed module, or
 * imports a module that imports a changed module (one hop of production
 * code). On top of that, changes that touch the governed/approval/mutation
 * surface always pull in the security invariant suites, because those
 * invariants are cross-cutting and a filename match would miss them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TEST_ROOTS = ['src/test/suite', 'core/test', 'apps/desktop/test'];

/** Test files that are always run when the governed surface changes. */
export const GOVERNANCE_INVARIANT_SUITES = [
  'core/test/governedRuntimeInvariants.test.ts',
  'core/test/m54SecurityKernel.test.ts',
  'core/test/mutationIntentGovernanceMatrix.test.ts',
  'core/test/mutationReplayUncertainty.test.ts',
  'core/test/approvalBoundary.test.ts',
  'core/test/cancellationLifecycle.test.ts',
  'core/test/piApprovalEnforcement.test.ts',
  'core/test/m38CapabilityDispatch.test.ts',
  'core/test/windowsConfinement.test.ts',
  'apps/desktop/test/desktopApproval.test.ts',
];

/** Source paths whose change alters the governed execution surface. */
const GOVERNANCE_SURFACE = [
  /^core\/domain\/approvals?\.ts$/,
  /^core\/domain\/capabilityDispatch\.ts$/,
  /^core\/domain\/connectorDispatch\.ts$/,
  /^core\/domain\/permissionModes\.ts$/,
  /^core\/domain\/mutation.*\.ts$/,
  /^core\/domain\/idempotency\.ts$/,
  /^core\/runtime\/governedCapability\.ts$/,
  /^core\/runtime\/processTree\.ts$/,
  /^core\/runtime\/processOwnership\.ts$/,
  /^core\/runtime\/capabilityDispatch.*\.ts$/,
  /^core\/security\//,
  /^apps\/desktop\/src\/host\/desktopApproval\.ts$/,
];

const IMPORT_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

/** Repo-relative POSIX path of a file. */
export function relPosix(repoRoot, absolute) {
  return toPosix(path.relative(repoRoot, absolute));
}

/** Every test file the repository runs, in a stable order. */
export function discoverTestFiles(repoRoot) {
  const files = [];
  for (const root of TEST_ROOTS) {
    const dir = path.join(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'platform') continue; // platform tier has its own config
          walk(full);
          continue;
        }
        if (!/\.(?:test|spec)\.ts$/.test(entry.name)) continue;
        if (entry.name === 'agentPromptLive.test.ts') continue;
        if (entry.name === 'physicalDogfoodAcceptance.test.ts') continue;
        files.push(full);
      }
    };
    walk(dir);
  }
  return files.sort();
}

/** The import specifiers a source file mentions. */
export function importsOf(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  }
  return [...found];
}

/** Resolves a relative import specifier to a repo-relative module path. */
function resolveRelative(fromFile, specifier, repoRoot) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    `${base}.js`,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return relPosix(repoRoot, candidate);
  }
  return null;
}

/**
 * The reverse import graph over repository source files:
 * module -> the modules that import it.
 */
export function buildImportGraph(repoRoot, sourceFiles) {
  const importers = new Map();
  for (const file of sourceFiles) {
    for (const specifier of importsOf(file)) {
      const resolved = resolveRelative(file, specifier, repoRoot);
      if (!resolved) continue;
      const list = importers.get(resolved) ?? [];
      list.push(relPosix(repoRoot, file));
      importers.set(resolved, list);
    }
  }
  return importers;
}

/**
 * The test files that a set of changed source files can break.
 *
 * `changed` — repo-relative POSIX paths of changed source files.
 * `testFiles` — absolute paths of the discovered test files.
 * `importers` — reverse import graph (module -> importers).
 */
export function impactedTestFiles(changed, testFiles, importers, repoRoot, options = {}) {
  const { oneHop = true } = options;
  const changedSet = new Set(changed.map(toPosix));
  const direct = new Set();
  const oneHopModules = new Set();

  for (const testFile of testFiles) {
    const testRel = relPosix(repoRoot, testFile);
    for (const specifier of importsOf(testFile)) {
      const resolved = resolveRelative(testFile, specifier, repoRoot);
      if (!resolved) continue;
      if (changedSet.has(resolved)) { direct.add(testRel); break; }
      oneHopModules.add(resolved);
    }
  }

  // A test that imports a module which imports a changed module is also
  // affected: the change is one hop away from what the test exercises. The
  // fast unit tier opts out of this widening; the regression tier keeps it.
  if (oneHop) {
    for (const testFile of testFiles) {
      const testRel = relPosix(repoRoot, testFile);
      if (direct.has(testRel)) continue;
      for (const specifier of importsOf(testFile)) {
        const resolved = resolveRelative(testFile, specifier, repoRoot);
        if (!resolved) continue;
        const parents = importers.get(resolved) ?? [];
        if (parents.some((parent) => changedSet.has(parent))) { direct.add(testRel); break; }
      }
    }
  }

  const governanceTouched = changed.some((file) => GOVERNANCE_SURFACE.some((pattern) => pattern.test(file)));
  const result = new Set(direct);
  if (governanceTouched) {
    for (const suite of GOVERNANCE_INVARIANT_SUITES) {
      const absolute = path.join(repoRoot, suite);
      if (fs.existsSync(absolute)) result.add(toPosix(suite));
    }
  }
  return { files: [...result].sort(), governanceTouched, oneHopModules: [...oneHopModules].length };
}

/** All repository source files (excluding tests) for the import graph. */
export function discoverSourceFiles(repoRoot) {
  const roots = ['core', 'src', 'apps/desktop/src'];
  const files = [];
  for (const root of roots) {
    const dir = path.join(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (/(?:^|[\\/])(?:test|tests)[\\/]/.test(full)) continue;
        if (/\.(?:test|spec)\.ts$/.test(entry.name)) continue;
        files.push(full);
      }
    };
    walk(dir);
  }
  return files.sort();
}
