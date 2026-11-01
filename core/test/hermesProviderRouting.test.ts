import { describe, it, expect, afterEach } from 'vitest';
import { resolveHermesLocalOllamaProvider, hermesProviderFor } from '../runtime/hermesEngine';

const CONFIG = [
  'model:',
  '  base_url: https://inference-api.nousresearch.com/v1',
  '  default: upstage/solar-mini4:free',
  '  provider: nous',
  'providers:',
  '  cloudy:',
  '    api: https://openrouter.ai/api/v1',
  '  ollama-launch:',
  '    api: http://127.0.0.1:11434/v1',
  '    default_model: qwen3.8:27b-mtp-q4_K_M',
  'fallback_providers: []',
].join('\n');

describe('Hermes provider routing', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('finds the provider whose endpoint is local Ollama, not the cloud default', () => {
    expect(resolveHermesLocalOllamaProvider(CONFIG)).toBe('ollama-launch');
  });

  it('returns null when no provider points at local Ollama', () => {
    expect(resolveHermesLocalOllamaProvider('providers:\n  cloudy:\n    api: https://openrouter.ai/api/v1\n')).toBeNull();
    expect(resolveHermesLocalOllamaProvider('model:\n  provider: nous\n')).toBeNull();
  });

  it('honors an explicit provider exactly', () => {
    expect(hermesProviderFor('qwen3.8:27b-mtp-q4_K_M', 'my-provider')).toBe('my-provider');
  });

  it('fails closed instead of letting Hermes pick its cloud default', () => {
    delete process.env.HERMES_OLLAMA_PROVIDER;
    process.env.HERMES_HOME = '/nonexistent-hermes-home';
    expect(() => hermesProviderFor('qwen3.8:27b-mtp-q4_K_M')).toThrow(/cannot run locally/);
  });
});
