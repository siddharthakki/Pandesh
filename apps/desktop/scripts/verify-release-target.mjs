/**
 * Verifies the release target before a portable/installer build is cut.
 *
 *   npm run desktop:verify-release-target
 *
 * The release target is the working tree that the next package-portable /
 * package-installer run will fingerprint. This check answers the one question
 * a release build must be able to answer before it spends minutes bundling:
 * "if we build right now, will the artifact identify itself as the version
 * and build number we committed — from a clean tree of the recorded commit?"
 *
 * It is deliberately cheap: nothing is rebuilt. It reads the committed
 * sources the packaging scripts themselves read (apps/desktop/package.json
 * version, apps/desktop/build-number.json) and, when a portable tree already
 * exists in dist/pandesh-win32-x64, proves that tree still matches them —
 * manifest hashes, embedded build identity, and the source commit it was
 * built from. A stale tree is reported as such, not silently rebuilt.
 *
 * Exit codes: 0 = target verified (tree present and consistent, or absent
 * as expected), 1 = the target cannot be cleanly released (see reasons).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppVersion, readBuildNumber, formatBuildIdentityLabel } from './lib/build-identity.mjs';
import { gitSourceState, readReleaseManifest, verifyReleaseManifest } from './lib/release-manifest.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const portableRoot = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');

const failures = [];

function check(ok, detail) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${detail}`);
  if (!ok) failures.push(detail);
  return ok;
}

function main() {
  const version = readAppVersion(repoRoot);
  const buildNumber = readBuildNumber(repoRoot);
  console.log(`Pandesh release target — v${version} · b${buildNumber}`);

  const source = gitSourceState(repoRoot);
  check(source.sourceState === 'clean',
    source.sourceState === 'clean'
      ? `working tree is clean at ${source.commit.slice(0, 7)}`
      : `working tree is DIRTY at ${source.commit.slice(0, 7)} (${source.dirtyFiles.length} source file(s) changed) — `
        + 'a build cut now would be recorded as a development build, not v' + version + ' · b' + buildNumber);

  const hasTree = fs.existsSync(path.join(portableRoot, 'build-fingerprint.json'));
  if (!hasTree) {
    console.log('  ok   no packaged tree in dist/pandesh-win32-x64 — the target is a fresh build');
    return;
  }

  console.log(`  -- verifying existing tree at ${portableRoot} --`);
  let manifest;
  try {
    manifest = readReleaseManifest(portableRoot);
  } catch (err) {
    check(false, `release manifest is unreadable: ${err.message}`);
    return;
  }

  check(source.sourceState === 'clean' && manifest.commit === source.commit,
    manifest.commit === source.commit
      ? `tree is a build of the current HEAD (${manifest.commit.slice(0, 7)})`
      : `tree was built from ${manifest.commit.slice(0, 7)} but HEAD is now ${source.commit.slice(0, 7)} — the tree is stale`);
  if (manifest.sourceState === 'dirty') {
    check(false, `tree records a DIRTY source state (${(manifest.dirtyFiles ?? []).length} file(s)) and is not releasable as a clean build`);
  }

  try {
    verifyReleaseManifest(portableRoot, manifest);
    check(true, 'all mandatory bundle hashes match the release manifest');
  } catch (err) {
    check(false, err.message);
  }

  const identity = manifest.buildIdentity;
  if (!identity) {
    check(false, 'release manifest has no embedded build identity');
  } else {
    check(identity.version === version,
      `build identity version ${identity.version} ${identity.version === version ? 'matches' : 'does NOT match'} the committed ${version}`);
    check(identity.buildNumber === buildNumber,
      `build identity buildNumber ${identity.buildNumber} ${identity.buildNumber === buildNumber ? 'matches' : 'does NOT match'} the committed ${buildNumber}`);
    check(identity.sourceState === 'clean',
      `build identity source state is '${identity.sourceState}'`
        + (identity.sourceState === 'clean' ? '' : ' — a development build cannot pass as a release'));
    if (identity.sourceState === 'clean') {
      console.log(`       ${formatBuildIdentityLabel(identity)} — ${manifest.builtAt}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`  FAIL ${err.message}`);
  process.exit(1);
}

if (failures.length) {
  console.log(`\nFAILED: release target is not ready (${failures.length} problem(s)):`);
  for (const detail of failures) console.log(`  - ${detail}`);
  console.log('Fix the problems above, then re-run `npm run desktop:verify-release-target`.');
  process.exit(1);
}
console.log('\nPASSED: release target is verified.');
