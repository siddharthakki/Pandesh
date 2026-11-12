/**
 * What an installed Ollama model can do and how much GPU memory it needs at Pandesh's context size.
 *
 * Build 165 escalated to qwen3.8:27b-mtp (16.5 GB of weights + ~8 GB of context cache at 32K) on a 24 GB RTX 3090:
 * a quarter of it ran on the CPU, one turn took 20 minutes and the loaded model then blocked the next messages
 * (owner test, 2026-11-12). It also sent 52 tool definitions to qwen2.5vl:7b, which cannot use tools.
 */

/** Ollama `/api/show` model_info: per-architecture keys such as `qwen35.block_count`. */
export type ModelInfo = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Bytes of KV cache at `numCtx` tokens (f16). Sliding-window layers hold only their window; with per-layer KV head
 * counts (Gemma), the layers with the fewest KV heads are the global ones. Unknown shape → undefined.
 */
export function estimateKvCacheBytes(info: ModelInfo, numCtx: number): number | undefined {
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] as string : '';
  if (!arch) return undefined;
  const g = (k: string) => info[`${arch}.${k}`];
  const layers = num(g('block_count'));
  if (!layers) return undefined;
  const heads = num(g('attention.head_count'));
  const emb = num(g('embedding_length'));
  const headDim = heads && emb ? emb / heads : undefined;
  const kLen = num(g('attention.key_length')) ?? headDim;
  const vLen = num(g('attention.value_length')) ?? headDim;
  if (!kLen || !vLen) return undefined;
  const window = num(g('attention.sliding_window'));
  const kvRaw = g('attention.head_count_kv');
  const kvPerLayer: number[] = Array.isArray(kvRaw)
    ? (kvRaw as unknown[]).map((v) => num(v) ?? 0)
    : Array.from({ length: layers }, () => num(kvRaw) ?? heads ?? 0);
  if (kvPerLayer.some((n) => n <= 0)) return undefined;
  const minKv = Math.min(...kvPerLayer);
  const mixed = Array.isArray(kvRaw) && kvPerLayer.some((n) => n !== minKv);
  let tokens = 0;
  kvPerLayer.forEach((kv, i) => {
    // Sliding window: Gemma marks global layers by fewer KV heads; otherwise assume every other layer is global.
    const isLocal = window !== undefined && window < numCtx && (mixed ? kv !== minKv : i % 2 === 1);
    tokens += kv * (isLocal ? window! : numCtx);
  });
  return tokens * (kLen + vLen) * 2;
}

/** Weights + KV cache + 1 GiB of compute buffers. Undefined when the shape is unknown. */
export function estimateModelBytes(fileBytes: number | undefined, info: ModelInfo | undefined, numCtx: number): number | undefined {
  if (!fileBytes || fileBytes <= 0) return undefined;
  const kv = info ? estimateKvCacheBytes(info, numCtx) : undefined;
  return fileBytes + (kv ?? fileBytes * 0.25) + 2 ** 30;
}

/** The GPU budget for one model: total VRAM less 1.5 GiB for the desktop and other programs. */
export function gpuBudgetBytes(totalVramMb: number | undefined): number | undefined {
  if (!totalVramMb || totalVramMb <= 0) return undefined;
  return (totalVramMb - 1536) * 1024 * 1024;
}

interface ShowResult { capabilities: string[]; modelInfo: ModelInfo }
const showCache = new Map<string, { at: number; value: ShowResult | null }>();

/** `/api/show` for one model, cached for 5 minutes. Null when Ollama does not answer. */
export async function showModel(baseUrl: string, model: string, now = Date.now()): Promise<ShowResult | null> {
  const key = `${baseUrl}|${model}`;
  const hit = showCache.get(key);
  if (hit && now - hit.at < 5 * 60_000) return hit.value;
  let value: ShowResult | null = null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/api/show`, {
      method: 'POST', body: JSON.stringify({ model }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = await res.json() as { capabilities?: string[]; model_info?: ModelInfo };
      value = { capabilities: body.capabilities ?? [], modelInfo: body.model_info ?? {} };
    }
  } catch { /* unknown */ }
  showCache.set(key, { at: now, value });
  return value;
}

/** True only when Ollama says the model has capabilities and "tools" is not among them. Unknown → false. */
export async function modelLacksTools(baseUrl: string, model: string): Promise<boolean> {
  const shown = await showModel(baseUrl, model);
  return Boolean(shown && shown.capabilities.length > 0 && !shown.capabilities.includes('tools'));
}

/** Test seam. */
export function clearModelInfoCache(): void { showCache.clear(); }
