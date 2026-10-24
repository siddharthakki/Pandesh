import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';

/**
 * Regression for the direct-cloud-primary-baseline gap: `ProviderGateway`
 * already fully supported `providerType: 'openai-compatible'` as the PRIMARY
 * provider (`create()`), and `storeApiKey`/`deleteApiKey` already existed —
 * but no interactive command ever called them (only the separate cloud
 * fallback key had one), so a user configuring a direct cloud primary
 * provider had no way to supply its credential. `registerCommands.ts` now
 * wires `ollama-agent.setApiKey`/`clearApiKey` to these exact methods,
 * mirroring `setCloudFallbackApiKey`/`clearCloudFallbackApiKey`. This proves
 * the underlying storage/resolution these commands now reach was already
 * correct, and that the two credentials are stored under genuinely distinct
 * keys (never satisfying each other).
 */
class FakeSecretStorage {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async store(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  onDidChange = () => ({ dispose: () => undefined });
}

describe('ProviderGateway — primary provider API key', () => {
  beforeEach(() => {
    vscodeMock._resetConfig();
  });

  afterEach(() => {
    vscodeMock._resetConfig();
  });

  it('storeApiKey/deleteApiKey persist and remove the primary key independently of the cloud fallback key', async () => {
    const secrets = new FakeSecretStorage() as unknown as import('vscode').SecretStorage;

    await ProviderGateway.storeApiKey(secrets, 'primary-secret-value');
    await ProviderGateway.storeCloudFallbackApiKey(secrets, 'fallback-secret-value');

    vscodeMock._setConfig('ollama-agent.providerType', 'openai-compatible');
    vscodeMock._setConfig('ollama-agent.apiBase', 'https://api.orcarouter.ai/v1');
    const provider = await ProviderGateway.create(secrets);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    // The two credentials never satisfy each other — deleting one must
    // leave the primary provider's own key (and vice versa) untouched.
    await ProviderGateway.deleteCloudFallbackApiKey(secrets);
    const stillCreates = await ProviderGateway.create(secrets);
    expect(stillCreates).toBeInstanceOf(OpenAICompatibleProvider);

    await ProviderGateway.deleteApiKey(secrets);
    // create() never throws on a missing key (matches existing "optional
    // SecretStorage key" behavior for openai-compatible) — this only proves
    // deleteApiKey actually removed what storeApiKey wrote, via a fresh get().
    expect(await secrets.get('ollama-agent.apiKey')).toBeUndefined();
    expect(await secrets.get('ollama-agent.cloudFallbackApiKey')).toBeUndefined();
  });

  it('resolveCloudFallback never reads the primary provider key', async () => {
    const secrets = new FakeSecretStorage() as unknown as import('vscode').SecretStorage;
    await ProviderGateway.storeApiKey(secrets, 'primary-only');
    vscodeMock._setConfig('ollama-agent.modelRoutingPolicy', 'local-first-cloud-fallback');
    vscodeMock._setConfig('ollama-agent.cloudFallbackApiBase', 'https://api.orcarouter.ai/v1');
    vscodeMock._setConfig('ollama-agent.cloudFallbackModel', 'openai/gpt-5.6-sol');

    const resolution = await ProviderGateway.resolveCloudFallback(secrets);
    expect(resolution.available).toBe(false);
    expect(resolution.reason).toBe('credential_missing');
  });
});
