import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const lib = path.join(desktopRoot, 'scripts', 'lib', 'build-identity.mjs');

type BuildIdentityModule = {
  readAppVersion: (repoRoot: string) => string;
  readBuildNumber: (repoRoot: string) => number;
  deriveReleaseChannel: (version: string, options?: { development?: boolean }) => string;
  composeBuildIdentity: (repoRoot: string, options?: { commit?: string | null; builtAt?: string; sourceState?: string }) => Record<string, unknown>;
  verifyBuildIdentity: (packagedRoot: string, repoRoot: string) => Record<string, unknown>;
  formatBuildIdentityLabel: (identity: { version: string; buildNumber: number; buildKind: string }) => string;
};

// The library is ESM and shared with the packaging scripts.
let buildIdentity: BuildIdentityModule;

beforeAll(async () => {
  buildIdentity = (await import(pathToFileURL(lib).href)) as BuildIdentityModule;
});

describe('Pandesh build identity', () => {
  it('has exactly one application version: the app manifest', () => {
    const appPackage = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as { version: string };
    expect(buildIdentity.readAppVersion(repoRoot)).toBe(appPackage.version);
    // The installer pin must not keep a second copy of the product version.
    const pin = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'installer', 'installer-pin.json'), 'utf8')) as Record<string, unknown>;
    expect(pin.productVersion).toBeUndefined();
  });

  it('uses a positive, monotonically increasing build number', () => {
    const buildNumber = buildIdentity.readBuildNumber(repoRoot);
    expect(Number.isInteger(buildNumber)).toBe(true);
    expect(buildNumber).toBeGreaterThan(0);
    const file = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'build-number.json'), 'utf8')) as { buildNumber: number };
    expect(file.buildNumber).toBe(buildNumber);
  });

  it('labels a development build as dev and never as an official build number', () => {
    const identity = buildIdentity.composeBuildIdentity(repoRoot, { commit: 'abc123', sourceState: 'dirty' });
    expect(identity.buildKind).toBe('development');
    expect(identity.releaseChannel).toBe('dev');
    expect(buildIdentity.formatBuildIdentityLabel(identity as never)).toContain('dev');
  });

  it('labels a clean build as a release with its build number', () => {
    const identity = buildIdentity.composeBuildIdentity(repoRoot, { commit: 'abc123', sourceState: 'clean' });
    expect(identity.buildKind).toBe('release');
    expect(identity.releaseChannel).not.toBe('dev');
    expect(buildIdentity.formatBuildIdentityLabel(identity as never)).toMatch(/· b\d+$/);
  });

  it('derives the release channel from the version', () => {
    expect(buildIdentity.deriveReleaseChannel('0.1.1')).toBe('stable');
    expect(buildIdentity.deriveReleaseChannel('0.2.0-alpha.1')).toBe('alpha');
    expect(buildIdentity.deriveReleaseChannel('0.2.0-beta.2')).toBe('beta');
    expect(buildIdentity.deriveReleaseChannel('0.2.0', { development: true })).toBe('dev');
  });

  it('rejects inconsistent build metadata', () => {
    const staging = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'pandesh-identity-'));
    try {
      const identity = buildIdentity.composeBuildIdentity(repoRoot, { commit: 'abc123', sourceState: 'clean' });
      fs.writeFileSync(
        path.join(staging, 'build-identity.json'),
        JSON.stringify({ ...identity, version: '9.9.9' }, null, 2),
      );
      expect(() => buildIdentity.verifyBuildIdentity(staging, repoRoot)).toThrow(/inconsistent/i);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('ships the build identity as a hashed part of the release manifest', () => {
    const manifest = fs.readFileSync(path.join(desktopRoot, 'scripts', 'lib', 'release-manifest.mjs'), 'utf8');
    expect(manifest).toMatch(/buildIdentity: 'build-identity\.json'/);
  });
});
