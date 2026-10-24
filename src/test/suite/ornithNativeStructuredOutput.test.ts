import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import * as vscodeMock from '../mocks/vscode';
import { buildCodingProposalResponseFormat } from '../../coding/CodingProposal';
import { OllamaProvider } from '../../providers/OllamaProvider';
import { ModelDispatchPlanner } from '../../reliability/ModelDispatchPlanner';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';
import { MockProvider } from '../mocks/MockProvider';

/**
 * Regression for the att_144a4f36 / att_4ed6e277 investigation: production
 * silently never attached Ollama's native `format` for
 * hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF because it fell to
 * GENERIC_LOCAL_PROFILE (`structuredOutput: 'unsupported'`), even though a
 * standalone probe against the same model+endpoint proved the schema works.
 * A live rerun with `OA_DEBUG_DISPATCH_DIAGNOSTICS` instrumentation confirmed
 * `formatAttached:false` and the resulting `empty_content` rejection.
 * Mirrors `qwenNativeStructuredOutput.test.ts`'s pattern (the precedent this
 * fix follows) at all three levels: profile resolution, dispatch decision,
 * and the actual serialized Ollama request body.
 */

const format = buildCodingProposalResponseFormat();
const ORNITH_MODEL = 'hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M';

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
    throw new Error('Failed to bind Ornith structured-output test server.');
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

describe('Ornith production profile resolution', () => {
  it('resolves the verified exact GGUF release to the structured-output-capable profile', () => {
    const profile = ModelProfileRegistry.resolve(ORNITH_MODEL, 'ollama');
    expect(profile.id).toBe('ornith-1.5-35b-a3b-local');
    expect(profile.structuredOutput).toBe('ollama_format');
    expect(profile.fallback).toBe(false);
  });

  it('does not extend the profile to an unverified different Ornith release', () => {
    const other = ModelProfileRegistry.resolve('hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:latest', 'ollama');
    expect(other.id).toBe('generic-openai-compatible-local');
    expect(other.structuredOutput).toBe('unsupported');
  });

  it('does not extend the profile to an unverified provider kind', () => {
    const openAiCompatible = ModelProfileRegistry.resolve(ORNITH_MODEL, 'openai-compatible');
    expect(openAiCompatible.id).toBe('generic-openai-compatible-local');
  });
});

describe('Ornith production dispatch decision', () => {
  it('activates native structured output for a governed Ornith coding request', async () => {
    const session = await ModelDispatchPlanner.createSession({
      model: ORNITH_MODEL,
      provider: new MockProvider(),
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.profile.id).toBe('ornith-1.5-35b-a3b-local');
    expect(session.structuredOutput).toMatchObject({ requested: true, supported: true, active: true });
    expect(session.structuredOutput.deferredReason).toBeUndefined();
    expect(session.options.responseFormat).toEqual(format);
  });

  // Regression: a follow-up live investigation (raw done_reason/eval_count,
  // normally discarded by OllamaProvider's typed response) proved format
  // alone was not sufficient — this model's `thinking` tokens are not
  // constrained by format's grammar and can exhaust the entire output budget
  // before any content is emitted (done_reason:"length", empty content).
  // Disabling native thinking (Ollama's own `think` request) fixed it live
  // (done_reason:"stop", valid proposal, well under budget).
  it('requests native thinking disabled for the verified Ornith release', async () => {
    const session = await ModelDispatchPlanner.createSession({
      model: ORNITH_MODEL,
      provider: new MockProvider(),
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.options.nativeThinking).toBe(false);
  });

  it('does not disable thinking for a model that never verified it needs to', async () => {
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: new MockProvider(),
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.options.nativeThinking).toBeUndefined();
  });
});

describe('Ornith production provider request', () => {
  // This is the regression: before the profile fix, this request never
  // carried `format` and the model was left to reason unconstrained inside a
  // 2048-token output budget — reproduced live as an empty_content failure.
  it('puts the CodingProposal schema on the Ollama request body for the verified Ornith release', async () => {
    const bodies = await captureOllamaBody(async (provider) => {
      const session = await ModelDispatchPlanner.createSession({
        model: ORNITH_MODEL,
        provider,
        toolsActive: false,
        hasImages: false,
        requestedResponseFormat: format,
      });
      await provider.chat([{ role: 'user', content: 'plan' }], [], session.options);
    });
    const chat = bodies.filter((body) => body['messages'] !== undefined);
    expect(chat).toHaveLength(1);
    expect(chat[0]['model']).toBe(ORNITH_MODEL);
    expect(chat[0]['format']).toEqual(format.schema);
  });

  // Regression for the proven-but-still-failing outcome: format alone
  // reached Ollama, but the request never told Ollama to disable thinking,
  // so the model's unconstrained thinking could still exhaust the output
  // budget before any schema-constrained content was emitted.
  it('puts think:false on the Ollama request body for the verified Ornith release', async () => {
    const bodies = await captureOllamaBody(async (provider) => {
      const session = await ModelDispatchPlanner.createSession({
        model: ORNITH_MODEL,
        provider,
        toolsActive: false,
        hasImages: false,
        requestedResponseFormat: format,
      });
      await provider.chat([{ role: 'user', content: 'plan' }], [], session.options);
    });
    const chat = bodies.filter((body) => body['messages'] !== undefined);
    expect(chat).toHaveLength(1);
    expect(chat[0]['think']).toBe(false);
  });

  it('sends no think field for a model that never verified it needs one', async () => {
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
    expect(chat[0]['think']).toBeUndefined();
  });
});
