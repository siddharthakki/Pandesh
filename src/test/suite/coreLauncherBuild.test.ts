import { describe, expect, it } from 'vitest';
import { decideExistingCoreReuse } from '../../core-client/CoreLauncher';

describe('decideExistingCoreReuse', () => {
  const sameApi = {
    clientApiVersion: 1,
    runningApiVersion: 1,
    bundledCoreVersion: '0.1.0',
    runningCoreVersion: '0.1.0',
  };

  it('reconnects when the running bundle hash matches the bundled file', () => {
    expect(decideExistingCoreReuse({
      ...sameApi,
      bundledBundleHash: 'aaa',
      runningBundleHash: 'aaa',
      busy: false,
    })).toBe('connect');
  });

  it('replaces an idle Core whose bundle hash is missing or outdated', () => {
    expect(decideExistingCoreReuse({
      ...sameApi,
      bundledBundleHash: 'new-hash',
      runningBundleHash: undefined,
      busy: false,
    })).toBe('replace');
    expect(decideExistingCoreReuse({
      ...sameApi,
      bundledBundleHash: 'new-hash',
      runningBundleHash: 'old-hash',
      busy: false,
    })).toBe('replace');
  });

  it('does not replace an outdated Core that still has in-flight work', () => {
    expect(decideExistingCoreReuse({
      ...sameApi,
      bundledBundleHash: 'new-hash',
      runningBundleHash: 'old-hash',
      busy: true,
    })).toBe('incompatible-busy');
  });

  it('still replaces a newer bundled Core when the API version drifted', () => {
    expect(decideExistingCoreReuse({
      clientApiVersion: 2,
      runningApiVersion: 1,
      bundledCoreVersion: '0.2.0',
      runningCoreVersion: '0.1.0',
      bundledBundleHash: 'new-hash',
      runningBundleHash: 'old-hash',
      busy: false,
    })).toBe('replace');
  });

  it('does not replace or downgrade a newer running Core when API is compatible', () => {
    expect(decideExistingCoreReuse({
      clientApiVersion: 1,
      runningApiVersion: 1,
      bundledCoreVersion: '0.1.0',
      runningCoreVersion: '0.1.1',
      bundledBundleHash: 'new-hash',
      runningBundleHash: 'old-hash',
      busy: false,
    })).toBe('connect');
  });
});

