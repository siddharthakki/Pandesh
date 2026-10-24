/**
 * The packaged build identity, read at runtime.
 *
 * The identity is embedded in the packaged tree during packaging (see
 * `apps/desktop/scripts/lib/build-identity.mjs`) and read from disk here. Git
 * is NEVER needed on the user's machine: the commit SHA was captured during
 * the build and shipped inside the artifact.
 *
 * A development run (no packaged identity file) reports itself as a
 * development build with no build number. It never claims an official build
 * number it was not given.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BUILD_IDENTITY_FILE = 'build-identity.json';

export type BuildKind = 'release' | 'development';
export type ReleaseChannel = 'dev' | 'alpha' | 'beta' | 'stable';

export interface DesktopBuildIdentity {
  version: string;
  buildNumber: number | null;
  buildKind: BuildKind;
  releaseChannel: ReleaseChannel;
  commit: string | null;
  builtAt: string | null;
  installerVersion: string | null;
  coreVersion: string | null;
  sourceState: 'clean' | 'dirty';
}

function asChannel(value: unknown): ReleaseChannel {
  return value === 'alpha' || value === 'beta' || value === 'stable' ? value : 'dev';
}

/** Reads the embedded identity from a packaged tree, or null when absent. */
export function readPackagedBuildIdentity(productRoot: string): DesktopBuildIdentity | null {
  try {
    const file = path.join(productRoot, BUILD_IDENTITY_FILE);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const version = String(parsed.version ?? '').trim();
    if (!version) return null;
    const buildNumber = Number(parsed.buildNumber);
    return {
      version,
      buildNumber: Number.isInteger(buildNumber) && buildNumber > 0 ? buildNumber : null,
      buildKind: parsed.buildKind === 'release' ? 'release' : 'development',
      releaseChannel: asChannel(parsed.releaseChannel),
      commit: parsed.commit ? String(parsed.commit) : null,
      builtAt: parsed.builtAt ? String(parsed.builtAt) : null,
      installerVersion: parsed.installerVersion ? String(parsed.installerVersion) : null,
      coreVersion: parsed.coreVersion ? String(parsed.coreVersion) : null,
      sourceState: parsed.sourceState === 'clean' ? 'clean' : 'dirty',
    };
  } catch {
    return null;
  }
}

/**
 * The build identity of the running app.
 *
 * `appVersion` is what Electron reports from the app manifest, so it always
 * agrees with the installed product. A packaged identity file refines it with
 * the build number, commit and channel; without one, the app is a local
 * development build and says so.
 */
export function resolveBuildIdentity(productRoot: string, appVersion: string): DesktopBuildIdentity {
  const packaged = readPackagedBuildIdentity(productRoot);
  if (packaged) return packaged;
  return {
    version: String(appVersion ?? '').trim(),
    buildNumber: null,
    buildKind: 'development',
    releaseChannel: 'dev',
    commit: null,
    builtAt: null,
    installerVersion: null,
    coreVersion: null,
    sourceState: 'dirty',
  };
}

/** The short label a user reads: `v0.1.1 · b142`, or `v0.1.1 · dev`. */
export function formatBuildIdentityLabel(identity: DesktopBuildIdentity): string {
  const version = identity.version.replace(/^v/i, '');
  if (!version) return '';
  if (identity.buildKind !== 'release' || identity.buildNumber === null) return `v${version} · dev`;
  return `v${version} · b${identity.buildNumber}`;
}

/**
 * The block a user can copy into a bug report. It names the build, the
 * platform and the runtime state — and deliberately NOTHING that could carry
 * a credential (no tokens, no paths under the user profile, no conversation
 * content, no model output).
 */
export function formatDiagnosticsReport(input: {
  identity: DesktopBuildIdentity;
  productName: string;
  coreVersion: string | null;
  coreConnected: boolean;
  platform: string;
  arch: string;
  electronVersion: string | null;
  nodeVersion: string | null;
}): string {
  const { identity } = input;
  const lines = [
    `${input.productName} ${identity.version}`,
    `build: ${identity.buildNumber === null ? 'development' : `b${identity.buildNumber}`} (${identity.buildKind}, ${identity.releaseChannel})`,
    `commit: ${identity.commit ?? 'unknown'}`,
    `built: ${identity.builtAt ?? 'unknown'}`,
    `installer: ${identity.installerVersion ?? 'unknown'}`,
    `core: ${input.coreVersion ?? 'unknown'} (${input.coreConnected ? 'connected' : 'not connected'})`,
    `platform: ${input.platform} ${input.arch}`,
    `electron: ${input.electronVersion ?? 'unknown'}`,
    `node: ${input.nodeVersion ?? 'unknown'}`,
  ];
  if (input.coreVersion && input.coreVersion !== identity.version) {
    lines.push(`warning: the running Core version (${input.coreVersion}) differs from the desktop version (${identity.version})`);
  }
  return lines.join('\n');
}
