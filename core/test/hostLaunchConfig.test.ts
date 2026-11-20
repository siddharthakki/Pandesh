import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script
import { mergeLaunchConfig } from '../../scripts/panda-bridge/set-host-launch.mjs';

describe('host launch config merge', () => {
  it('keeps dataDir and every other field; sets only the two launch fields', () => {
    const merged = mergeLaunchConfig({ dataDir: 'C:/d', pandeshExe: 'old', extra: { a: 1 } }, 'E:/Pandesh/electron/Pandesh.exe', 'E:/Pandesh/app');
    expect(merged).toEqual({ dataDir: 'C:/d', extra: { a: 1 }, pandeshExe: 'E:/Pandesh/electron/Pandesh.exe', pandeshArgs: ['E:/Pandesh/app'] });
  });
  it('refuses an unrecognised config instead of overwriting it', () => {
    expect(() => mergeLaunchConfig({}, 'a', 'b')).toThrow(/no dataDir/);
    expect(() => mergeLaunchConfig([], 'a', 'b')).toThrow(/not a JSON object/);
  });
});
