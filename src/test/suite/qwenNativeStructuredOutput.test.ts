import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import * as vscodeMock from '../mocks/vscode';
import { buildCodingProposalResponseFormat } from '../../coding/CodingProposal';
import { OllamaProvider } from '../../providers/OllamaProvider';
import { ModelDispatchPlanner } from '../../reliability/ModelDispatchPlanner';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';
import { decideStructuredOutput } from '../../reliability/StructuredOutput';
import { MockProvider } from '../mocks/MockProvider';

/**
 * Production Karke resolves Qwen 3.6/3.8 model names such as
 * `qwen3.8:27b-mtp-q4_K_M`. Before `qwen-general-local` existed those fell to
 * the generic fallback profile (structuredOutput: 'unsupported'), so
 * `ModelDispatchPlanner` never attached the CodingProposal schema and Ollama
 * received no native `format`. These tests pin the truthful capability and the
 * request that carries it.
 */

class OpenAICompatibleMockProvider extends MockProvider {
  override readonly providerType = 'openai-compatible' as const;
}

const format = buildCodingProposalResponseFormat();

/** Captures the exact JSON body that Ollama /api/chat receives. */
async function captureOllamaBody(
  run: (provider: OllamaProvider) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    // Only /api/chat is under test; anything else (the provider's /api/ps residency lookup) is a plain 404.
    if (req.url !== '/api/chat') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: '{}' }, done: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind Qwen structured-output test server.');
  }
  const provider = new OllamaProvider(`http://127.0.0.1:${address.port}`);
  try {
    await run(provider);
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return bodies;
}

beforeEach(() => {
  vscodeMock._resetConfig();
});

afterEach(() => {
  vscodeMock._resetConfig();
});

describe('Qwen production profile resolution', () => {
  it('resolves the plain Qwen3.8 production name to the structured-output-capable profile', () => {
    const profile = ModelProfileRegistry.resolve('qwen3.8:27b-q4_K_M', 'ollama');
    expect(profile.id).toBe('qwen-general-local');
    expect(profile.structuredOutput).toBe('ollama_format');
    expect(profile.fallback).toBe(false);
  });

  it('resolves the Qwen3.8 MTP production name to the same profile', () => {
    const profile = ModelProfileRegistry.resolve('qwen3.8:27b-mtp-q4_K_M', 'ollama');
    expect(profile.id).toBe('qwen-general-local');
    expect(profile.structuredOutput).toBe('ollama_format');
  });

  it('resolves vendor-prefixed Qwen3.8 repacks measured in the benchmark', () => {
    expect(ModelProfileRegistry.resolve('orcarouter/Qwen3.8-27B-Uncensored:Q4_K_M', 'ollama').id)
      .toBe('qwen-general-local');
  });

  it('gives Qwen3.6 the capability its measured Ollama behaviour supports, not an assumed one', () => {
    // The benchmark ran qwen3.6:27b 5/5 schema-valid over native Ollama
    // `format`, so it carries the same measured capability — declared as
    // ollama_format because only the Ollama path was measured.
    const profile = ModelProfileRegistry.resolve('qwen3.6:27b', 'ollama');
    expect(profile.id).toBe('qwen-general-local');
    expect(profile.structuredOutput).toBe('ollama_format');
    expect(
      decideStructuredOutput({
        profile,
        providerType: 'ollama',
        toolsActive: false,
        hasImages: false,
        requestedFormat: format,
      }).active,
    ).toBe(true);
    // Never measured on an OpenAI-compatible server, so that channel stays shut.
    expect(
      decideStructuredOutput({
        profile,
        providerType: 'openai-compatible',
        toolsActive: false,
        hasImages: false,
        requestedFormat: format,
      }),
    ).toMatchObject({ supported: false, active: false, deferredReason: 'provider_restriction' });
  });

  it('keeps the Qwen coder and vision profiles ahead of the general profile', () => {
    expect(ModelProfileRegistry.resolve('qwen3-coder:30b', 'ollama').id).toBe('qwen-coder-local');
    expect(ModelProfileRegistry.resolve('qwen3.8-vl:27b', 'ollama').id).toBe('qwen-vision-local');
  });

  it('leaves unknown local models on the generic fallback', () => {
    const unknown = ModelProfileRegistry.resolve('local-mystery:latest', 'ollama');
    expect(unknown.id).toBe('generic-openai-compatible-local');
    expect(unknown.fallback).toBe(true);
    expect(unknown.structuredOutput).toBe('unsupported');
    // An unverified future Qwen release must not inherit the capability.
    expect(ModelProfileRegistry.resolve('qwen4.0:27b', 'ollama').id)
      .toBe('generic-openai-compatible-local');
  });

  it('leaves Devstral resolution and capability unchanged', () => {
    const devstral = ModelProfileRegistry.resolve('devstral-small-2:latest', 'ollama');
    expect(devstral.id).toBe('mistral-devstral-local');
    expect(devstral.structuredOutput).toBe('json_schema');
  });
});

describe('Qwen production dispatch decision', () => {
  it('activates native structured output for a governed Qwen3.8 MTP coding request', async () => {
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: new MockProvider(),
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.profile.id).toBe('qwen-general-local');
    expect(session.structuredOutput).toMatchObject({ requested: true, supported: true, active: true });
    expect(session.structuredOutput.deferredReason).toBeUndefined();
    expect(session.options.responseFormat).toEqual(format);
  });

  it('does not let a generic-profile model advertise native schema support', async () => {
    const session = await ModelDispatchPlanner.createSession({
      model: 'local-mystery:latest',
      provider: new MockProvider(),
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.structuredOutput).toMatchObject({
      supported: false,
      active: false,
      deferredReason: 'profile_unsupported',
    });
    expect(session.options.responseFormat).toBeUndefined();
  });

  it('keeps every hard capability check intact for the Qwen profile', async () => {
    const withTools = await ModelDispatchPlanner.createSession({
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: new MockProvider(),
      toolsActive: true,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(withTools.structuredOutput.active).toBe(false);
    expect(withTools.structuredOutput.deferredReason).toBe('native_tools_active');

    const withImages = await ModelDispatchPlanner.createSession({
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: new MockProvider(),
      toolsActive: false,
      hasImages: true,
      requestedResponseFormat: format,
    });
    expect(withImages.structuredOutput.active).toBe(false);
    expect(withImages.structuredOutput.deferredReason).toBe('vision_request');

    const openAiCompatible = await ModelDispatchPlanner.createSession({
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: new OpenAICompatibleMockProvider(),
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(openAiCompatible.structuredOutput.active).toBe(false);
    expect(openAiCompatible.structuredOutput.deferredReason).toBe('provider_restriction');

    const notRequested = await ModelDispatchPlanner.createSession({
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: new MockProvider(),
      toolsActive: false,
      hasImages: false,
    });
    expect(notRequested.structuredOutput.active).toBe(false);
    expect(notRequested.structuredOutput.deferredReason).toBe('not_requested');
  });
});

describe('Qwen production provider request', () => {
  it('puts the CodingProposal schema on the Ollama request body for a supported Qwen model', async () => {
    const bodies = await captureOllamaBody(async (provider) => {
      const session = await ModelDispatchPlanner.createSession({
        model: 'qwen3.8:27b-mtp-q4_K_M',
        provider,
        toolsActive: false,
        hasImages: false,
        requestedResponseFormat: format,
      });
      await provider.chat([{ role: 'user', content: 'plan' }], [], session.options);
    });
    const chat = bodies.filter((body) => body['messages'] !== undefined);
    expect(chat).toHaveLength(1);
    expect(chat[0]['model']).toBe('qwen3.8:27b-mtp-q4_K_M');
    expect(chat[0]['format']).toEqual(format.schema);
  });

  it('sends no format for an unknown local model on the same path', async () => {
    const bodies = await captureOllamaBody(async (provider) => {
      const session = await ModelDispatchPlanner.createSession({
        model: 'local-mystery:latest',
        provider,
        toolsActive: false,
        hasImages: false,
        requestedResponseFormat: format,
      });
      await provider.chat([{ role: 'user', content: 'plan' }], [], session.options);
    });
    const chat = bodies.filter((body) => body['messages'] !== undefined);
    expect(chat).toHaveLength(1);
    expect(chat[0]['format']).toBeUndefined();
  });
});
