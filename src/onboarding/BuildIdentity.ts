/**
 * Which build is this? Several different VSIX builds all reported 0.1.1, so
 * the version alone cannot identify a build. The product SHA and dirty flag are
 * injected by esbuild (`define`) at bundle time from the checkout that produced
 * the bundle; outside a bundled build (unit tests, tsc) they read as "dev".
 *
 * A package cannot embed the hash of its own archive, so the package-level
 * identity is the product SHA plus the bundle timestamp; the archive SHA256 is
 * recorded next to the .vsix by the packaging helper, not inside it.
 */
declare const __KKD_BUILD_SHA__: string | undefined;
declare const __KKD_BUILD_DIRTY__: boolean | undefined;
declare const __KKD_BUILD_TIME__: string | undefined;

/** Milestone label shown in Setup. Bump with the milestone, not per build. */
export const BUILD_MILESTONE = 'M50 Public Preview';

export interface BuildIdentity {
  version: string;
  milestone: string;
  /** Short product commit SHA, or `dev` when not produced by the bundler. */
  sha: string;
  /** True when the bundle was produced from a working tree with uncommitted changes. */
  dirty: boolean;
  builtAt?: string;
}

export function getBuildIdentity(version: string): BuildIdentity {
  return {
    version,
    milestone: BUILD_MILESTONE,
    sha: typeof __KKD_BUILD_SHA__ === 'string' && __KKD_BUILD_SHA__ ? __KKD_BUILD_SHA__ : 'dev',
    dirty: typeof __KKD_BUILD_DIRTY__ === 'boolean' ? __KKD_BUILD_DIRTY__ : false,
    builtAt: typeof __KKD_BUILD_TIME__ === 'string' && __KKD_BUILD_TIME__ ? __KKD_BUILD_TIME__ : undefined,
  };
}

export function formatBuildIdentity(identity: BuildIdentity): string {
  return `${identity.version} · ${identity.milestone} · ${identity.sha}${identity.dirty ? '+dirty' : ''}`;
}
