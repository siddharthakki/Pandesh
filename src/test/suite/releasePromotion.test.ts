import { describe, expect, it } from 'vitest';
import { ReleaseChannelManager, ReleaseSigner } from '../../release/ReleaseChannelManager';

class LengthSigner implements ReleaseSigner {
  async sign(payload: string): Promise<{ signature: string; signer: string }> {
    return { signature: String(payload.length), signer: 'local-test' };
  }

  async verify(payload: string, signature: string, signer: string): Promise<boolean> {
    return signer === 'local-test' && signature === String(payload.length);
  }
}

describe('release promotion', () => {
  it('preserves the build fingerprint across channels', async () => {
    const manager = new ReleaseChannelManager(new LengthSigner());
    const source = await manager.create({
      version: '1.0.0',
      channel: 'development',
      commit: 'abcdef1',
      files: [{ path: 'extension.vsix', sha256: 'a'.repeat(64), sizeBytes: 100 }],
      sbomFingerprint: 'b'.repeat(64),
      buildInputs: { node: '22', platform: 'all' },
    });
    await manager.stage(source.manifest.releaseId, 100);
    const promoted = await manager.promote(source.manifest.releaseId, 'beta');

    expect(promoted.manifest.buildFingerprint).toBe(source.manifest.buildFingerprint);
    expect(await manager.verify(promoted.manifest.releaseId)).toBe(true);
  });
});
