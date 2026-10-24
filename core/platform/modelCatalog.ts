/**
 * Unified model descriptors, trusted discovery parsers and search/filter (host-neutral).
 *
 * Unknown stays UNKNOWN: capability and price fields are filled only from provider
 * metadata or explicit catalog rules, never guessed from a model name — with one
 * labelled exception: the `coding` tag is a name-based *suitability hint* and is
 * reported with `codingSource: 'name-hint'` so callers can tell.
 */
import type { ProviderDescriptor } from './providerCatalog';

export type Tri = boolean | 'unknown';
export type Freeness = 'free' | 'paid' | 'trial' | 'promotional' | 'unknown';
export type Locality = 'local' | 'cloud';

export interface ModelPricing { promptUsdPerMTok?: number; completionUsdPerMTok?: number; perRequestUsd?: number }
export interface ModelQuota { requestsPerDay?: number; requestsPerMinute?: number; note?: string }

export interface ModelDescriptor {
  /** `local` for Ollama on this machine, otherwise the catalog provider id. */
  provider: string;
  providerName: string;
  modelId: string;
  displayName: string;
  locality: Locality;
  freeness: Freeness;
  freenessSource: 'provider-metadata' | 'catalog-rule' | 'none';
  contextWindow?: number;
  maxOutput?: number;
  tools: Tri;
  vision: Tri;
  structuredOutput: Tri;
  reasoning: Tri;
  streaming: Tri;
  coding: Tri;
  codingSource: 'name-hint' | 'none';
  /** Hard capability class. Only `generative` models may run chat/coding tasks. */
  kind: ModelKind;
  latencyMs?: number;
  privacy: 'local' | 'cloud-unknown-retention' | 'cloud-no-training-documented' | 'cloud-may-train';
  pricing?: ModelPricing;
  quota?: ModelQuota;
  aliases: string[];
}

export const LOCAL_PROVIDER_ID = 'local';

/** Picker/override value for a pool cloud model: `<providerId>::<exact model id>`. Cannot collide with an Ollama tag. */
export function encodeCloudModel(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function decodeCloudModel(value: string | undefined): { providerId: string; modelId: string } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const index = trimmed.indexOf('::');
  if (index <= 0) return undefined;
  const providerId = trimmed.slice(0, index);
  const modelId = trimmed.slice(index + 2).trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(providerId) || !modelId) return undefined;
  return { providerId, modelId };
}

/** Non-generative model kinds by id. An embedding/reranker is never a chat or coding model, whatever else its name says. */
const EMBEDDING_HINT = /(embed|^bge-|[-/]bge-|\be5-|\bgte-|minilm|text-embedding)/i;
const RERANKER_HINT = /rerank/i;
export type ModelKind = 'generative' | 'embedding' | 'reranker';
export function modelKindOf(modelId: string): ModelKind {
  if (RERANKER_HINT.test(modelId)) return 'reranker';
  if (EMBEDDING_HINT.test(modelId)) return 'embedding';
  return 'generative';
}
const CODING_HINT = /(coder|code|codestral|devstral|deepseek|qwen|gpt-oss|gpt-5|claude|gemini|llama-?3|kimi|glm|minimax|sonnet|opus)/i;

export function humanizeModelName(modelId: string): string {
  const base = modelId.split('/').pop() ?? modelId;
  const withoutSuffix = base.replace(/[:\-_](free|latest|instruct|cloud)$/i, '');
  return withoutSuffix
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])/g, c => c.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bOss\b/g, 'OSS')
    .replace(/\bV(\d)/g, 'V$1')
    .replace(/(\d)b\b/gi, '$1B');
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
function posInt(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n > 0 ? Math.floor(n) : undefined;
}

export function classifyFreeness(
  provider: ProviderDescriptor,
  modelId: string,
  pricing: ModelPricing | undefined,
): { freeness: Freeness; source: ModelDescriptor['freenessSource'] } {
  const rule = provider.modelRules?.freeness;
  if (rule?.kind === 'self-hosted') return { freeness: 'free', source: 'catalog-rule' };
  if (rule?.kind === 'pricing-zero') {
    if (pricing?.promptUsdPerMTok !== undefined && pricing.completionUsdPerMTok !== undefined) {
      const zero = pricing.promptUsdPerMTok === 0 && pricing.completionUsdPerMTok === 0 && (pricing.perRequestUsd ?? 0) === 0;
      return { freeness: zero ? 'free' : 'paid', source: 'provider-metadata' };
    }
    return { freeness: 'unknown', source: 'none' };
  }
  if (rule?.kind === 'id-suffix') {
    const lower = modelId.toLowerCase();
    return rule.suffixes.some(suffix => lower.endsWith(suffix.toLowerCase()))
      ? { freeness: 'free', source: 'catalog-rule' }
      : { freeness: 'unknown', source: 'none' };
  }
  if (rule?.kind === 'provider-tier') {
    if (rule.idPatterns && !rule.idPatterns.some(pattern => new RegExp(pattern, 'i').test(modelId))) {
      return { freeness: 'unknown', source: 'none' };
    }
    const kind = provider.freeTier.kind;
    const freeness: Freeness = kind === 'recurring' ? 'free' : kind === 'trial' ? 'trial' : kind === 'promotional' ? 'promotional' : kind === 'paid' ? 'paid' : 'unknown';
    return { freeness, source: freeness === 'unknown' ? 'none' : 'catalog-rule' };
  }
  return { freeness: 'unknown', source: 'none' };
}

function privacyFor(provider: ProviderDescriptor): ModelDescriptor['privacy'] {
  if (provider.privacyWarning && /train|improve/i.test(provider.privacyWarning)) return 'cloud-may-train';
  if (provider.providerResidency && /not used for training/i.test(provider.providerResidency)) return 'cloud-no-training-documented';
  return 'cloud-unknown-retention';
}

function baseCloudDescriptor(provider: ProviderDescriptor, modelId: string): ModelDescriptor {
  const providerTags = new Set(provider.capabilities);
  return {
    provider: provider.id,
    providerName: provider.displayName,
    modelId,
    displayName: humanizeModelName(modelId),
    locality: 'cloud',
    freeness: 'unknown',
    freenessSource: 'none',
    tools: 'unknown',
    vision: provider.modelRules?.vision?.kind === 'all' ? true : 'unknown',
    structuredOutput: 'unknown',
    reasoning: 'unknown',
    streaming: providerTags.has('streaming') ? true : 'unknown',
    kind: modelKindOf(modelId),
    coding: modelKindOf(modelId) === 'generative' && CODING_HINT.test(modelId) ? true : modelKindOf(modelId) === 'generative' ? 'unknown' : false,
    codingSource: modelKindOf(modelId) === 'generative' && CODING_HINT.test(modelId) ? 'name-hint' : 'none',
    privacy: privacyFor(provider),
    aliases: [],
  };
}

interface OaiModelEntry {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_model_len?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  max_completion_tokens?: unknown;
  pricing?: unknown;
  architecture?: unknown;
  supported_parameters?: unknown;
  top_provider?: unknown;
  modalities?: unknown;
  input_modalities?: unknown;
  capabilities?: unknown;
}

/** Parses an OpenAI-compatible `/models` body (with OpenRouter/Groq-style documented extensions). */
export function parseOpenAiCompatibleModels(provider: ProviderDescriptor, body: unknown): ModelDescriptor[] {
  const list: unknown = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new Error('Provider model list response was malformed');
  const out: ModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const raw of list as OaiModelEntry[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const id = typeof raw.id === 'string' ? raw.id.replace(/^models\//, '') : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const d = baseCloudDescriptor(provider, id);
    if (typeof raw.name === 'string' && raw.name.trim() && raw.name.length < 120) d.displayName = raw.name.trim();
    if (typeof raw.display_name === 'string' && raw.display_name.trim()) d.displayName = raw.display_name.trim();
    d.contextWindow = posInt(raw.context_length) ?? posInt(raw.context_window) ?? posInt(raw.max_model_len) ?? posInt(raw.inputTokenLimit);
    d.maxOutput = posInt(raw.max_completion_tokens) ?? posInt(raw.outputTokenLimit) ?? posInt((raw.top_provider as { max_completion_tokens?: unknown } | undefined)?.max_completion_tokens);

    let pricing: ModelPricing | undefined;
    if (typeof raw.pricing === 'object' && raw.pricing !== null) {
      const p = raw.pricing as Record<string, unknown>;
      const prompt = num(p.prompt);
      const completion = num(p.completion);
      if (prompt !== undefined || completion !== undefined) {
        pricing = {
          promptUsdPerMTok: prompt !== undefined ? prompt * 1_000_000 : undefined,
          completionUsdPerMTok: completion !== undefined ? completion * 1_000_000 : undefined,
          perRequestUsd: num(p.request),
        };
        d.pricing = pricing;
      }
    }
    const params = Array.isArray(raw.supported_parameters) ? (raw.supported_parameters as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
    if (params) {
      d.tools = params.includes('tools');
      d.structuredOutput = params.includes('structured_outputs') || params.includes('response_format');
      d.reasoning = params.includes('reasoning') || params.includes('include_reasoning');
    }
    const arch = typeof raw.architecture === 'object' && raw.architecture !== null ? raw.architecture as { input_modalities?: unknown; modality?: unknown } : undefined;
    const inputs = Array.isArray(arch?.input_modalities) ? arch!.input_modalities as unknown[]
      : Array.isArray(raw.input_modalities) ? raw.input_modalities as unknown[]
      : Array.isArray(raw.modalities) ? raw.modalities as unknown[] : undefined;
    if (inputs) d.vision = inputs.includes('image');
    else if (typeof arch?.modality === 'string') d.vision = /image/.test(arch.modality.split('->')[0]);
    const caps = typeof raw.capabilities === 'object' && raw.capabilities !== null ? raw.capabilities as Record<string, unknown> : undefined;
    if (caps) {
      if (typeof caps.vision === 'boolean') d.vision = caps.vision;
      if (typeof caps.function_calling === 'boolean') d.tools = caps.function_calling;
      if (typeof caps.tools === 'boolean') d.tools = caps.tools;
    }
    const classified = classifyFreeness(provider, id, pricing);
    d.freeness = classified.freeness;
    d.freenessSource = classified.source;
    out.push(d);
  }
  return out;
}

/** Parses Ollama `/api/tags`-style local inventories. Local models are free by construction (no metering). */
export function parseLocalOllamaModels(models: ReadonlyArray<{ name: string; contextWindow?: number; aliases?: string[] }>): ModelDescriptor[] {
  return models.map(model => ({
    provider: LOCAL_PROVIDER_ID,
    providerName: 'Ollama',
    modelId: model.name,
    displayName: humanizeModelName(model.name),
    locality: 'local' as const,
    freeness: 'free' as const,
    freenessSource: 'catalog-rule' as const,
    contextWindow: model.contextWindow,
    tools: 'unknown' as const,
    vision: 'unknown' as const,
    structuredOutput: 'unknown' as const,
    reasoning: 'unknown' as const,
    streaming: true,
    kind: modelKindOf(model.name),
    coding: (modelKindOf(model.name) === 'generative' && CODING_HINT.test(model.name) ? true : modelKindOf(model.name) === 'generative' ? 'unknown' : false) as Tri,
    codingSource: modelKindOf(model.name) === 'generative' && CODING_HINT.test(model.name) ? 'name-hint' as const : 'none' as const,
    privacy: 'local' as const,
    aliases: model.aliases ?? [],
  }));
}

export type ModelFilter = 'all' | 'local' | 'cloud' | 'free' | 'vision' | 'coding' | 'tools';
export const MODEL_FILTERS: readonly ModelFilter[] = ['all', 'local', 'cloud', 'free', 'vision', 'coding', 'tools'];

export function modelKey(d: Pick<ModelDescriptor, 'provider' | 'modelId'>): string {
  return d.provider === LOCAL_PROVIDER_ID ? d.modelId : encodeCloudModel(d.provider, d.modelId);
}

/** Badges a row shows. UNKNOWN never becomes FREE; unknown capabilities show no badge at all. */
export function modelBadges(d: ModelDescriptor): string[] {
  const badges: string[] = [d.locality === 'local' ? 'LOCAL' : 'CLOUD'];
  if (d.freeness === 'free') badges.push('FREE');
  else if (d.freeness === 'paid') badges.push('PAID');
  else if (d.freeness === 'trial') badges.push('TRIAL');
  else if (d.freeness === 'promotional') badges.push('PROMO');
  if (d.kind === 'embedding') badges.push('EMBEDDING');
  else if (d.kind === 'reranker') badges.push('RERANKER');
  else {
    if (d.vision === true) badges.push('VISION');
    if (d.tools === true) badges.push('TOOLS');
    if (d.coding === true) badges.push('CODING');
  }
  return badges;
}

function matchesFilter(d: ModelDescriptor, filter: ModelFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'local': return d.locality === 'local';
    case 'cloud': return d.locality === 'cloud';
    case 'free': return d.freeness === 'free';
    case 'vision': return d.kind === 'generative' && d.vision === true;
    case 'coding': return d.kind === 'generative' && d.coding === true;
    case 'tools': return d.kind === 'generative' && d.tools === true;
  }
}

/** A model may be picked for a chat/coding task only when it is generative (embedding/reranker rows are shown, never selectable). */
export function isSelectableForTasks(d: Pick<ModelDescriptor, 'kind'>): boolean {
  return d.kind === 'generative';
}

function searchText(d: ModelDescriptor): string {
  return [d.modelId, d.displayName, d.provider, d.providerName, ...d.aliases, ...modelBadges(d), d.freeness === 'free' ? 'free' : '', d.locality].join(' ').toLowerCase();
}

export interface ModelQuery {
  text?: string;
  filters?: readonly ModelFilter[];
  /** Keys of recently used models, most recent first. */
  recent?: readonly string[];
  limit?: number;
}

/** Every whitespace-separated query token must match (AND), so "free deepseek" narrows. */
export function searchModels(models: readonly ModelDescriptor[], query: ModelQuery = {}): ModelDescriptor[] {
  const tokens = (query.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const filters = (query.filters ?? []).filter(filter => filter !== 'all');
  const recent = new Map((query.recent ?? []).map((key, index) => [key, index]));
  const scored: Array<{ d: ModelDescriptor; score: number }> = [];
  for (const d of models) {
    if (!filters.every(filter => matchesFilter(d, filter))) continue;
    let score = 0;
    if (tokens.length > 0) {
      const haystack = searchText(d);
      if (!tokens.every(token => haystack.includes(token))) continue;
      const id = d.modelId.toLowerCase();
      const name = d.displayName.toLowerCase();
      for (const token of tokens) {
        if (id === token || name === token) score += 50;
        else if (id.startsWith(token) || name.startsWith(token)) score += 20;
        else if (id.includes(token) || name.includes(token)) score += 8;
      }
    }
    const recency = recent.get(modelKey(d));
    if (recency !== undefined) score += 30 - Math.min(recency, 25);
    scored.push({ d, score });
  }
  scored.sort((a, b) => b.score - a.score
    || (a.d.locality === b.d.locality ? 0 : a.d.locality === 'local' ? -1 : 1)
    || a.d.providerName.localeCompare(b.d.providerName)
    || a.d.displayName.localeCompare(b.d.displayName));
  const result = scored.map(entry => entry.d);
  return query.limit ? result.slice(0, query.limit) : result;
}

/** Recommended: free, tool-capable, large-context models first. Pure ranking over reported metadata. */
export function recommendedModels(models: readonly ModelDescriptor[], count = 4): ModelDescriptor[] {
  models = models.filter(isSelectableForTasks);
  const rank = (d: ModelDescriptor): number =>
    (d.freeness === 'free' ? 4 : 0)
    + (d.tools === true ? 3 : 0)
    + (d.coding === true ? 2 : 0)
    + (d.vision === true ? 1 : 0)
    + Math.min(2, (d.contextWindow ?? 0) / 100_000);
  return [...models].filter(d => d.freeness === 'free').sort((a, b) => rank(b) - rank(a) || a.displayName.localeCompare(b.displayName)).slice(0, count);
}

export class ModelCatalog {
  private readonly byProvider = new Map<string, ModelDescriptor[]>();
  /** Replaces one provider's inventory (a refresh); other providers are untouched. */
  setInventory(providerId: string, models: ModelDescriptor[]): void { this.byProvider.set(providerId, models); }
  removeProvider(providerId: string): void { this.byProvider.delete(providerId); }
  providerModels(providerId: string): readonly ModelDescriptor[] { return this.byProvider.get(providerId) ?? []; }
  all(): ModelDescriptor[] { return [...this.byProvider.values()].flat(); }
  find(provider: string, modelId: string): ModelDescriptor | undefined {
    return this.byProvider.get(provider)?.find(d => d.modelId === modelId || d.aliases.includes(modelId));
  }
  get size(): number { return this.all().length; }
}

/** Capability requirements a task places on a model. */
export interface ModelRequirements {
  vision?: boolean;
  tools?: boolean;
  minContext?: number;
  /** Minimum output tokens the task needs; a model reporting less cannot finish it. */
  minOutput?: number;
  structuredOutput?: boolean;
}

/** `ok` only when the model is KNOWN to satisfy; unknown does not satisfy a hard requirement. */
export function satisfiesRequirements(d: ModelDescriptor, req: ModelRequirements): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (d.kind !== 'generative') reasons.push(`${d.kind} models are not generative and cannot run tasks`);
  if (req.vision && d.vision !== true) reasons.push(d.vision === false ? 'no vision support' : 'vision support not confirmed');
  if (req.tools && d.tools === false) reasons.push('no tool support');
  if (req.structuredOutput && d.structuredOutput === false) reasons.push('no structured output');
  if (req.minOutput && d.maxOutput !== undefined && d.maxOutput < req.minOutput) reasons.push(`max output ${d.maxOutput} < ${req.minOutput}`);
  if (req.minContext && d.contextWindow !== undefined && d.contextWindow < req.minContext) reasons.push(`context ${d.contextWindow} < ${req.minContext}`);
  return { ok: reasons.length === 0, reasons };
}
