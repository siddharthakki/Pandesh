import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { OllamaProvider } from '../../providers/OllamaProvider';

/**
 * Covers OllamaProvider.getModelContextMetadata's real parsing boundary: an
 * actual HTTP `/api/show` response, decoded and parsed by the product code.
 *
 * The M41 selection tests stub `InferenceProvider.getModelContextMetadata`
 * directly (MockProvider returns a prepared ModelInfo), so they begin
 * downstream of this parse and cannot observe a key-naming gap here. Ollama
 * keys the declared context length by architecture
 * (`<general.architecture>.context_length`), so a model whose architecture is
 * not in the explicit fallback list reported no context at all — leaving
 * selection on the registry's conservative 8192 heuristic.
 */

/** Serves one fixed `/api/show` JSON body, exactly as Ollama would. */
class ShowServer {
  private server: http.Server | undefined;

  constructor(private readonly body: unknown, private readonly status = 200) {}

  async start(): Promise<string> {
    this.server = http.createServer((_req, res) => {
      res.writeHead(this.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.body));
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind show server');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}

let active: ShowServer | undefined;

async function metadataFor(body: unknown, model = 'test-model', status = 200) {
  active = new ShowServer(body, status);
  const baseUrl = await active.start();
  const provider = new OllamaProvider(baseUrl);
  try {
    return await provider.getModelContextMetadata(model);
  } finally {
    await provider.dispose();
  }
}

afterEach(async () => {
  await active?.stop();
  active = undefined;
});

describe('OllamaProvider.getModelContextMetadata /api/show parsing', () => {
  // A: the exact payload shape that reproduced the installed-product failure.
  it('A: reads the architecture-keyed context length for qwen35 (qwen3.8 builds)', async () => {
    const info = await metadataFor({
      parameters: 'top_k                          20\ntop_p                          0.95\ntemperature                    1',
      details: { format: 'gguf', family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M' },
      model_info: {
        'general.architecture': 'qwen35',
        'qwen35.context_length': 262_144,
        'qwen35.embedding_length': 5120,
      },
    }, 'qwen3.8:27b-q4_K_M');

    expect(info?.declaredContextWindow).toBe(262_144);
    // No `num_ctx` in parameters, so the runtime value is absent — the
    // declared value is what callers fall back to.
    expect(info?.contextWindow).toBeUndefined();
  });

  // B: a different unlisted architecture, to prove A is not a one-off.
  it('B: reads the architecture-keyed context length for qwen3', async () => {
    const info = await metadataFor({
      details: { format: 'gguf', family: 'qwen3' },
      model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40_960 },
    }, 'qwen3-embedding:4b');

    expect(info?.declaredContextWindow).toBe(40_960);
  });

  // C: the reason this must not be a generic "*.context_length" scan.
  it('C: prefers the architecture context length over rope original_context_length', async () => {
    const info = await metadataFor({
      parameters: 'temperature                    0.15',
      details: { format: 'gguf', family: 'mistral3' },
      model_info: {
        'general.architecture': 'mistral3',
        // Deliberately ordered so a naive key scan would hit the rope key first.
        'mistral3.rope.scaling.original_context_length': 8_192,
        'mistral3.context_length': 393_216,
      },
    }, 'devstral-small-2:latest');

    expect(info?.declaredContextWindow).toBe(393_216);
    expect(info?.declaredContextWindow).not.toBe(8_192);
  });

  it('C2: same precedence for laguna, with the rope key declared last', async () => {
    const info = await metadataFor({
      details: { format: 'gguf', family: 'laguna' },
      model_info: {
        'general.architecture': 'laguna',
        'laguna.context_length': 262_144,
        'laguna.rope.scaling.original_context_length': 8_192,
      },
    }, 'laguna-xs-2.1:latest');

    expect(info?.declaredContextWindow).toBe(262_144);
  });

  // D: the pre-existing explicit fallback keys must stay green.
  it('D: still reads llama.context_length', async () => {
    const info = await metadataFor({
      details: { format: 'gguf', family: 'llama' },
      model_info: { 'general.architecture': 'llama', 'llama.context_length': 131_072 },
    }, 'llama3.1:8b');

    expect(info?.declaredContextWindow).toBe(131_072);
  });

  it('D2: still reads qwen2.context_length', async () => {
    const info = await metadataFor({
      details: { format: 'gguf', family: 'qwen2' },
      model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32_768 },
    }, 'qwen2.5:14b');

    expect(info?.declaredContextWindow).toBe(32_768);
  });

  it('D3: still reads a fallback key when the architecture key is absent', async () => {
    const info = await metadataFor({
      model_info: { 'general.architecture': 'exotic-arch', 'general.context_length': 16_384 },
    });

    expect(info?.declaredContextWindow).toBe(16_384);
  });

  it('D4: a runtime num_ctx parameter is still reported as contextWindow', async () => {
    const info = await metadataFor({
      parameters: 'num_ctx                        8192\ntemperature                    0.7',
      model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 2_048 },
    }, 'nomic-embed-text:latest');

    expect(info?.contextWindow).toBe(8_192);
    expect(info?.declaredContextWindow).toBe(2_048);
  });

  // E: malformed/missing architecture must fall back conservatively and never
  // invent or crash on a context window.
  it('E: a missing architecture falls back to the explicit keys', async () => {
    const info = await metadataFor({ model_info: { 'llama.context_length': 8_192 } });
    expect(info?.declaredContextWindow).toBe(8_192);
  });

  it('E2: a non-string architecture is ignored rather than used as a key', async () => {
    const info = await metadataFor({
      model_info: { 'general.architecture': 42, 'general.context_length': 4_096 },
    });
    expect(info?.declaredContextWindow).toBe(4_096);
  });

  it('E3: an empty/whitespace architecture is ignored', async () => {
    const info = await metadataFor({
      model_info: { 'general.architecture': '   ', '.context_length': 999_999, 'context_length': 2_048 },
    });
    expect(info?.declaredContextWindow).toBe(2_048);
  });

  it('E4: no usable context anywhere reports undefined rather than a guess', async () => {
    const info = await metadataFor({
      details: { format: 'gguf', family: 'mystery' },
      model_info: { 'general.architecture': 'mystery', 'mystery.embedding_length': 4096 },
    });

    expect(info).toBeDefined();
    expect(info?.declaredContextWindow).toBeUndefined();
    expect(info?.contextWindow).toBeUndefined();
  });

  it('E5: a zero or negative architecture context length is not accepted', async () => {
    const info = await metadataFor({
      model_info: { 'general.architecture': 'broken', 'broken.context_length': 0, 'general.context_length': 32_768 },
    });

    expect(info?.declaredContextWindow).toBe(32_768);
  });

  it('E6: an empty model_info reports no context', async () => {
    const info = await metadataFor({ details: {} });
    expect(info?.declaredContextWindow).toBeUndefined();
  });

  it('E7: a non-200 /api/show reports no metadata at all', async () => {
    const info = await metadataFor({ error: 'model not found' }, 'missing:model', 404);
    expect(info).toBeUndefined();
  });
});

describe('OllamaProvider size and identity evidence (F: Ollama regression)', () => {
  it('reports the exact general.parameter_count from /api/show, and nothing when absent', async () => {
    const withCount = await metadataFor({
      details: { parameter_size: '27.3B' },
      model_info: { 'general.architecture': 'qwen35', 'general.parameter_count': 27_300_000_000, 'qwen35.context_length': 262_144 },
    });
    expect(withCount?.parameterCount).toBe(27_300_000_000);

    const without = await metadataFor({ model_info: { 'general.architecture': 'qwen35' } });
    expect(without?.parameterCount).toBeUndefined();
  });

  it('publishes the untagged name as an alias of a :latest model only', async () => {
    active = new ShowServer({ models: [
      { name: 'devstral-small-2:latest', modified_at: '' },
      { name: 'qwen3.8:27b-mtp-q4_K_M', modified_at: '' },
    ] });
    const provider = new OllamaProvider(await active.start());
    try {
      const models = await provider.listModels();
      expect(models.map(m => [m.name, m.aliases])).toEqual([
        ['devstral-small-2:latest', ['devstral-small-2']],
        ['qwen3.8:27b-mtp-q4_K_M', undefined],
      ]);
    } finally {
      await provider.dispose();
    }
  });
});
