import type { CoreDatabase } from '../db/connection';
import type { AttemptContextRecord } from '../shared/wireTypes';
import { getOpenRouterBudget } from '../domain/openRouterBudget';
import {
  ModelBackendError,
  OllamaModelBackend,
  type ModelBackend,
} from './modelBackend';
import {
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_OFFICIAL_API_BASE,
  OpenAICompatibleModelBackend,
} from './openaiCompatibleBackend';
import {
  ORCAROUTER_PROVIDER,
  sharedCloudCredentials,
  type CloudCredentialStore,
  type CloudProviderCredential,
} from './cloudCredentials';
import { ProviderCatalog } from '../platform/providerCatalog';
import { spendVerdict } from '../platform/cloudRouting';
import { CostGuard } from '../platform/cloudSkills';

export const SUPPORTED_ATTEMPT_PROVIDERS = ['ollama', 'openrouter', ORCAROUTER_PROVIDER] as const;

const builtinPoolCatalog = new ProviderCatalog();

/**
 * Cloud pool providers: any catalog provider (the data-driven free-cloud pool) or any provider the host has
 * delivered a credential for. `openrouter` keeps its legacy spend-capped path unless the host delivered a pool
 * credential for it (see `usesOpenRouterPool`).
 */
export function isPoolProvider(provider: string, credentials: CloudCredentialStore = sharedCloudCredentials): boolean {
  if (provider === 'ollama' || provider === 'openrouter') return false;
  return builtinPoolCatalog.has(provider) || credentials.get(provider) !== undefined;
}

/** OpenRouter as a pool member: the host pushed a key and no legacy spend cap is in play. */
export function usesOpenRouterPool(context: AttemptContextRecord, credentials: CloudCredentialStore = sharedCloudCredentials): boolean {
  return context.selectedProvider === 'openrouter'
    && credentials.get('openrouter') !== undefined
    && context.modelSelection?.spendCapUsd === undefined;
}

export function isSupportedAttemptProvider(provider: string): boolean {
  return provider === 'ollama' || provider === 'openrouter' || isPoolProvider(provider);
}

/** True for providers that send repository/task content to a remote service. */
export function isCloudAttemptProvider(provider: string): boolean {
  return provider === 'openrouter' || isPoolProvider(provider);
}

/**
 * True when an attempt runs the free-cloud public-text path: any free-pool provider (Groq, Gemini, Cloudflare, custom,
 * OpenRouter with a delivered pool key) or any request the host marked as public text. The legacy spend-capped
 * `openrouter` path and explicit OrcaRouter keep their own authorized execution and are not narrowed to one message.
 * Decided from the provider and the frozen context, never from a client-set flag alone.
 */
export function isFreeCloudPublicTextAttempt(context: AttemptContextRecord, credentials: CloudCredentialStore = sharedCloudCredentials): boolean {
  const provider = context.selectedProvider;
  if (!isCloudAttemptProvider(provider)) return false;
  if (context.modelSelection?.routingPolicy === 'explicit-cloud' || context.modelSelection?.cloudPublicTextApproved === true) return true;
  if (usesOpenRouterPool(context, credentials)) return true;
  return provider !== 'openrouter' && provider !== ORCAROUTER_PROVIDER;
}

export function cloudProviderLabel(provider: string): string {
  return builtinPoolCatalog.get(provider)?.displayName ?? provider;
}

export interface ResolveAttemptModelBackendInput {
  context: AttemptContextRecord;
  db: CoreDatabase;
  injectedBackend?: ModelBackend;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  cloudCredentials?: CloudCredentialStore;
}

/**
 * Manual OrcaRouter selection means exactly that model on exactly that
 * endpoint: a missing credential or model refuses the call. It never falls
 * back to Ollama or to another cloud model.
 */
export function refuseOrcaRouterBeforeFetch(
  context: AttemptContextRecord,
  credentials: CloudCredentialStore,
): CloudProviderCredential {
  return refuseCloudProviderBeforeFetch(context, credentials, ORCAROUTER_PROVIDER);
}

/** Same exact-model/exact-provider rule for every pool provider; error codes are `<provider>_model_missing|key_missing`. */
export function refuseCloudProviderBeforeFetch(
  context: AttemptContextRecord,
  credentials: CloudCredentialStore,
  provider: string,
): CloudProviderCredential {
  const label = cloudProviderLabel(provider);
  const code = provider.replace(/[^a-z0-9]/g, '');
  if (!context.selectedModel.trim()) {
    throw new ModelBackendError(`${label} model is required; refusing to substitute`, `${code}_model_missing`);
  }
  const credential = credentials.get(provider);
  if (!credential) {
    throw new ModelBackendError(
      `${label} is not configured in Core (no API key was delivered); refusing the call and not falling back to a local model`,
      `${code}_key_missing`,
    );
  }
  return credential;
}

/**
 * Defence in depth for the hard spend policy. The host decides, but Core also refuses a cloud-pool call whose frozen
 * context lacks the spend facts or whose model the frozen policy forbids, so a bug or a replayed request cannot charge.
 */
export function refuseCloudSpendBeforeFetch(context: AttemptContextRecord): void {
  const spend = context.modelSelection?.cloudSpend;
  const label = cloudProviderLabel(context.selectedProvider);
  if (!spend) {
    throw new ModelBackendError(
      `${label} call refused: the attempt carries no cloud spend policy, so it cannot be shown to be free. Nothing was sent.`,
      'cloud_spend_unspecified',
    );
  }
  const verdict = spendVerdict(
    { mode: spend.mode, allowCredits: spend.allowCredits },
    { locality: 'cloud', freeness: spend.modelFreeness, displayName: context.selectedModel, providerName: label },
  );
  if (!verdict.allowed) throw new ModelBackendError(`${verdict.reason} Nothing was sent.`, 'cloud_spend_blocked');
}

export function refuseOpenRouterBeforeFetch(context: AttemptContextRecord, db: CoreDatabase): void {
  if (context.selectedProvider !== 'openrouter') return;
  const cap = context.modelSelection?.spendCapUsd;
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) {
    throw new ModelBackendError('OpenRouter USD spend cap is required; refusing the call', 'openrouter_cap_missing');
  }
  if (!context.selectedModel.trim()) {
    throw new ModelBackendError('OpenRouter model is required; refusing to substitute', 'openrouter_model_missing');
  }
  const env = process.env;
  if (!(env[OPENROUTER_API_KEY_ENV] ?? '').trim()) {
    throw new ModelBackendError('OpenRouter API key is not available to Core; refusing the call', 'openrouter_key_missing');
  }
  const ledger = getOpenRouterBudget(db, context.attemptId);
  if (ledger?.hasUnresolved) {
    throw new ModelBackendError(
      'OpenRouter billing is unresolved for this attempt; refusing further cloud calls',
      'openrouter_billing_unresolved',
    );
  }
}

export function resolveAttemptModelBackend(input: ResolveAttemptModelBackendInput): ModelBackend {
  const { context, db } = input;
  const provider = context.selectedProvider;
  if (provider === 'ollama') {
    return input.injectedBackend ?? new OllamaModelBackend();
  }
  const credentials = input.cloudCredentials ?? sharedCloudCredentials;
  if (isPoolProvider(provider, credentials) || usesOpenRouterPool(context, credentials)) {
    const credential = refuseCloudProviderBeforeFetch(context, credentials, provider);
    refuseCloudSpendBeforeFetch(context);
    return new OpenAICompatibleModelBackend({
      baseUrl: credential.baseUrl,
      apiKey: credential.apiKey,
      provider,
      label: cloudProviderLabel(provider),
      fetchFn: input.fetchFn,
      // Spend was verified above, so the guard only enforces the per-attempt request/token ceiling.
      cloudSkills: { costGuard: new CostGuard({ mode: 'UNRESTRICTED' }) },
    });
  }
  if (provider !== 'openrouter') {
    throw new ModelBackendError(
      `Core execution does not support provider '${provider}' and will not switch providers silently`,
      'unsupported_provider',
    );
  }
  refuseOpenRouterBeforeFetch(context, db);
  const env = input.env ?? process.env;
  const apiKey = (env[OPENROUTER_API_KEY_ENV] ?? '').trim();
  return new OpenAICompatibleModelBackend({
    baseUrl: OPENROUTER_OFFICIAL_API_BASE,
    apiKey,
    provider: 'openrouter',
    fetchFn: input.fetchFn,
  });
}
