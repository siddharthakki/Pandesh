/**
 * One authoritative version/build identity for Pandesh.
 *
 * There is exactly ONE source for the numbers a user sees:
 *
 *   - the application version comes from `apps/desktop/package.json` (the
 *     product's own manifest — the same file Electron's `app.getVersion()`
 *     reads);
 *   - the build number comes from `apps/desktop/build-number.json`, a
 *     committed counter that only ever increases.
 *
 * Everything else — the packaged `build-identity.json`, the Inno Setup
 * version, the release manifest, the desktop footer, the About panel and the
 * diagnostic log lines — is DERIVED from those two files at packaging time
 * and verified afterwards. No version number is maintained by hand in a
 * second place, and the packaged app never needs Git on the user's machine:
 * the commit SHA is captured during the build and embedded in the artifact.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BUILD_IDENTITY_FILE = 'build-identity.json';
export const BUILD_NUMBER_FILE = 'build-number.json';
export const BUILD_IDENTITY_SCHEMA = 1;

export const RELEASE_CHANNELS = ['dev', 'alpha', 'beta', 'stable'];

/**
 * The shape embedded in the packaged app. (Plain JavaScript on purpose: this
 * file is shared by the packaging scripts, the installer build and the
 * desktop tests.)
 */
export const BUILD_IDENTITY_SHAPE = Object.freeze({
  schema: 'number',
  version: 'string',
  buildNumber: 'number',
  buildKind: "'release' | 'development'",
  releaseChannel: 'string',
  commit: 'string | null',
  builtAt: 'string',
  installerVersion: 'string',
  coreVersion: 'string',
  sourceState: "'clean' | 'dirty'",
});

export function readAppVersion(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`apps/desktop/package.json has an unusable version: '${version}'`);
  }
  return version;
}

export function readBuildNumber(repoRoot) {
  const file = path.join(repoRoot, 'apps', 'desktop', BUILD_NUMBER_FILE);
  if (!fs.existsSync(file)) throw new Error(`build number file missing: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const buildNumber = Number(parsed.buildNumber);
  if (!Number.isInteger(buildNumber) || buildNumber <= 0) {
    throw new Error(`apps/desktop/${BUILD_NUMBER_FILE} must hold a positive integer buildNumber`);
  }
  return buildNumber;
}

/**
 * The channel follows the SemVer prerelease tag. A build that is not an
 * official release is 'dev' and says so — it never borrows a release channel.
 */
export function deriveReleaseChannel(version, { development = false } = {}) {
  if (development) return 'dev';
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)$/.exec(version)?.[1]?.toLowerCase() ?? '';
  if (!prerelease) return 'stable';
  if (prerelease.startsWith('alpha')) return 'alpha';
  if (prerelease.startsWith('beta') || prerelease.startsWith('rc')) return 'beta';
  return 'dev';
}

/** Builds the identity from the two committed sources plus the recorded source state. */
export function composeBuildIdentity(repoRoot, {
  commit = null,
  builtAt = new Date().toISOString(),
  sourceState = 'clean',
  releaseChannel = null,
} = {}) {
  const version = readAppVersion(repoRoot);
  const buildNumber = readBuildNumber(repoRoot);
  const development = sourceState !== 'clean';
  const derived = deriveReleaseChannel(version, { development });
  const channel = development ? 'dev' : (releaseChannel ?? (derived === 'stable' ? 'alpha' : derived));
  return {
    schema: BUILD_IDENTITY_SCHEMA,
    version,
    buildNumber,
    buildKind: development ? 'development' : 'release',
    releaseChannel: channel,
    commit: commit ? String(commit) : null,
    builtAt,
    installerVersion: version,
    coreVersion: version,
    sourceState,
  };
}

export function writeBuildIdentity(packagedRoot, identity) {
  fs.writeFileSync(path.join(packagedRoot, BUILD_IDENTITY_FILE), `${JSON.stringify(identity, null, 2)}\n`);
}

export function readBuildIdentity(packagedRoot) {
  const file = path.join(packagedRoot, BUILD_IDENTITY_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Fails when the packaged identity disagrees with the committed sources or
 * with itself. This is the automated check that rejects stale or
 * inconsistent build metadata.
 */
export function verifyBuildIdentity(packagedRoot, repoRoot) {
  const identity = readBuildIdentity(packagedRoot);
  if (!identity) throw new Error(`build identity missing from ${packagedRoot}`);
  const problems = [];
  const expectedVersion = readAppVersion(repoRoot);
  const expectedBuildNumber = readBuildNumber(repoRoot);
  if (identity.version !== expectedVersion) problems.push(`version ${identity.version} != ${expectedVersion}`);
  if (identity.buildNumber !== expectedBuildNumber) problems.push(`buildNumber ${identity.buildNumber} != ${expectedBuildNumber}`);
  if (identity.installerVersion !== identity.version) problems.push('installerVersion does not match the application version');
  if (identity.coreVersion !== identity.version) problems.push('coreVersion does not match the application version');
  if (!RELEASE_CHANNELS.includes(identity.releaseChannel)) problems.push(`unknown release channel '${identity.releaseChannel}'`);
  if (identity.buildKind === 'development' && identity.releaseChannel !== 'dev') {
    problems.push('a development build must report the dev channel');
  }
  if (problems.length) {
    throw new Error(`build identity is inconsistent: ${problems.join('; ')}`);
  }
  return identity;
}

/** The short label a user reads: `v0.1.1 · b142`, or `v0.1.1 · dev` for a local build. */
export function formatBuildIdentityLabel(identity) {
  if (!identity) return '';
  const version = String(identity.version ?? '').replace(/^v/i, '');
  if (!version) return '';
  if (identity.buildKind === 'development') return `v${version} · dev`;
  return `v${version} · b${identity.buildNumber}`;
}
