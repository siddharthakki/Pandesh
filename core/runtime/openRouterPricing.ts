/**
 * Conservative OpenRouter reservation pricing. Gate 1 uses per-token USD rates
 * from OpenRouter model metadata when available; unknown models use a high
 * conservative ceiling so reservations never under-estimate.
 */
import { openaiCompatibleApiUrl, OPENROUTER_OFFICIAL_API_BASE } from './openaiCompatibleBackend';

export interface OpenRouterTokenPricing {
  /** USD per prompt token. */
  promptUsdPerToken: number;
  /** USD per completion token. */
  completionUsdPerToken: number;
  source: 'model' | 'conservative_fallback';
}

/** Conservative fallback when model pricing is unknown (well above typical list). */
export const CONSERVATIVE_OPENROUTER_PRICING: OpenRouterTokenPricing = {
  promptUsdPerToken: 20 / 1_000_000,
  completionUsdPerToken: 80 / 1_000_000,
  source: 'conservative_fallback',
};

export function estimatePromptTokens(messages: ReadonlyArray<{ content: string }>): number {
  let chars = 0;
  for (const message of messages) chars += message.content.length;
  // Upper-bound token estimate: 1 token per 3 chars + fixed tool/schema overhead.
  return Math.max(1, Math.ceil(chars / 3) + 256);
}

export function boundedCompletionTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KARKEDIKHA_OPENROUTER_MAX_COMPLETION_TOKENS?.trim();
  const parsed = raw ? Number(raw) : 8192;
  if (!Number.isFinite(parsed) || parsed <= 0) return 8192;
  return Math.min(Math.floor(parsed), 32_768);
}

export function reservationUsd(
  promptTokens: number,
  maxCompletionTokens: number,
  pricing: OpenRouterTokenPricing,
): number {
  const input = promptTokens * pricing.promptUsdPerToken;
  const output = maxCompletionTokens * pricing.completionUsdPerToken;
  const total = input + output;
  return Math.ceil(total * 1_000_000) / 1_000_000;
}

/** Parse OpenRouter /models entry pricing.prompt and pricing.completion (USD per token strings). */
export function pricingFromModelRecord(record: Record<string, unknown>): OpenRouterTokenPricing | null {
  const pricing = record.pricing;
  if (!pricing || typeof pricing !== 'object') return null;
  const prompt = parseUsdPerToken((pricing as Record<string, unknown>).prompt);
  const completion = parseUsdPerToken((pricing as Record<string, unknown>).completion);
  if (prompt === null || completion === null) return null;
  return { promptUsdPerToken: prompt, completionUsdPerToken: completion, source: 'model' };
}

function parseUsdPerToken(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export async function fetchOpenRouterModelPricing(
  modelId: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  apiBase: string = OPENROUTER_OFFICIAL_API_BASE,
): Promise<OpenRouterTokenPricing> {
  const res = await fetchFn(openaiCompatibleApiUrl(apiBase, 'models'), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return CONSERVATIVE_OPENROUTER_PRICING;
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const match = (body.data ?? []).find((entry) => entry.id === modelId);
  if (!match) return CONSERVATIVE_OPENROUTER_PRICING;
  return pricingFromModelRecord(match) ?? CONSERVATIVE_OPENROUTER_PRICING;
}
