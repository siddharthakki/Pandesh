import { describe, it, expect, afterEach } from 'vitest';
import { resolveHermesLocalOllamaProvider, hermesProviderFor, hermesAutoRouteAllowed } from '../runtime/hermesEngine';

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

  it('a profile pinned to a custom endpoint on local Ollama runs as provider "custom"', () => {
    const profile = ['model:', '  provider: custom', '  base_url: http://127.0.0.1:11434/v1', '  default: gemma4:12b', 'fallback_providers: []'].join('\n');
    expect(resolveHermesLocalOllamaProvider(profile)).toBe('custom');
    // A custom endpoint that is NOT local Ollama is not treated as local.
    expect(resolveHermesLocalOllamaProvider(['model:', '  provider: custom', '  base_url: https://openrouter.ai/api/v1'].join('\n'))).toBeNull();
  });

  it('auto-routing to Hermes is opt-in per task class, with a kill switch', () => {
    expect(hermesAutoRouteAllowed('workspace_coding', {})).toBe(false);
    expect(hermesAutoRouteAllowed('workspace_coding', { PANDESH_HERMES_ROUTES: 'workspace_coding' })).toBe(true);
    expect(hermesAutoRouteAllowed('specialist', { PANDESH_HERMES_ROUTES: 'workspace_coding' })).toBe(false);
    expect(hermesAutoRouteAllowed('specialist', { PANDESH_HERMES_ROUTES: 'all', HERMES_ENABLED: 'false' })).toBe(false);
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
