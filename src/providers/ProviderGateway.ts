import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { ChatMessage, ChatResponse, ToolDefinition } from '../tools/ToolTypes';
import {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderType,
  StreamEvent,
} from './ProviderTypes';
// Wrapper inventory note: ReliableOllamaProvider below is the only provider
// decorator/wrapper in this repository (verified against all InferenceProvider
// implementations). Any future wrapper must forward every optional
// capability/metadata method — getModelContextMetadata in particular — so the
// delegate's runtime context metadata is never silently lost.
import { OllamaProvider } from './OllamaProvider';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { loadBuiltinCatalog } from '../../core/platform/providerCatalog';
import { classifyFreeness, humanizeModelName } from '../../core/platform/modelCatalog';
import { spendVerdict } from '../../core/platform/cloudRouting';

/** VS Code SecretStorage key used to persist the optional API key. */
const SECRET_KEY = 'ollama-agent.apiKey';

/**
 * Separate SecretStorage key for the cloud fallback endpoint's credential.
 * Deliberately distinct from SECRET_KEY so configuring a cloud fallback can
 * never repurpose (or be satisfied by) the primary provider's key.
 */
const CLOUD_FALLBACK_SECRET_KEY = 'ollama-agent.cloudFallbackApiKey';

/** Why no cloud fallback route is available. Enum only. */
export type CloudFallbackUnavailableReason =
  | 'policy_local_only'
  | 'endpoint_not_configured'
  | 'model_not_configured'
  | 'credential_missing'
  /** The hard cloud spend policy (default FREE_ONLY) does not allow this model. */
  | 'spend_policy_blocks';

/**
 * A fully configured, executable cloud fallback route. Constructed only when
 * the user's routing policy permits it AND every piece of configuration is
 * present, so merely resolving this never opens a connection or transmits
 * repository/task context.
 */
export interface CloudFallbackRouteResolution {
  available: boolean;
  reason?: CloudFallbackUnavailableReason;
  provider?: InferenceProvider;
  providerType?: ProviderType;
  model?: string;
}

function legacyFallbackAllowedBySpendPolicy(baseUrl: string, model: string): boolean {
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return false; }
  const provider = loadBuiltinCatalog().providers.find(candidate => {
    try { return new URL(candidate.baseUrl.replace(/\{[A-Za-z]+\}/g, 'x')).hostname.toLowerCase() === host; } catch { return false; }
  });
  const freeness = provider ? classifyFreeness(provider, model, undefined).freeness : 'unknown';
  return spendVerdict(Config.getCloudSpendPolicy(), {
    locality: 'cloud',
    freeness,
    displayName: humanizeModelName(model),
    providerName: provider?.displayName ?? host,
  }).allowed;
}

/**
 * Keeps plain Ollama chat streaming, but uses the complete native response when
 * tool definitions are present. The complete response contains the structured
 * assistant tool-call message required by the next agent-loop turn.
 */
class ReliableOllamaProvider implements InferenceProvider {
  readonly providerType: ProviderType = 'ollama';

  constructor(private readonly delegate: OllamaProvider) {}

  healthCheck(signal?: AbortSignal): Promise<void> {
    return this.delegate.healthCheck(signal);
  }

  listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return this.delegate.listModels(signal);
  }

  /** Forwards the delegate's runtime context metadata (num_ctx, declared context length). */
  getModelContextMetadata(model: string, signal?: AbortSignal): Promise<ModelInfo | undefined> {
    return this.delegate.getModelContextMetadata(model, signal);
  }

  /** Forwards the delegate's residency evidence (Ollama `/api/ps`) for the router's load-cost preference. */
  listResidentModels(signal?: AbortSignal): Promise<readonly string[] | undefined> {
    return this.delegate.listResidentModels(signal);
  }

  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return this.delegate.chat(messages, tools, options, signal);
  }

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    if (tools.length === 0) {
      yield* this.delegate.chatStream(messages, tools, options, signal);
      return;
    }

    const response = await this.delegate.chat(messages, tools, options, signal);
    const content = response.message.content ?? '';

    if (content) {
      yield { type: 'token', delta: content };
    }

    const toolCalls = response.message.tool_calls ?? [];
    for (let index = 0; index < toolCalls.length; index++) {
      yield { type: 'tool_call', index, toolCall: toolCalls[index] };
    }

    yield { type: 'done', content };
  }
}

/**
 * Creates the active InferenceProvider based on the current VS Code settings.
 *
 * - 'ollama'             → Ollama native API (no API key required)
 * - 'openai-compatible'  → OpenAI-compatible API (optional SecretStorage key)
 *
 * LM Studio users should set providerType to 'openai-compatible' and point
 * apiBase at http://localhost:1234 (the LM Studio default).
 */
export class ProviderGateway {
  static async create(secrets: vscode.SecretStorage): Promise<InferenceProvider> {
    const providerType = Config.getProviderType();
    const baseUrl = Config.getApiBase();

    if (providerType === 'ollama') {
      return new ReliableOllamaProvider(new OllamaProvider(baseUrl));
    }

    const apiKey = (await secrets.get(SECRET_KEY)) ?? '';
    return new OpenAICompatibleProvider(baseUrl, apiKey);
  }

  /**
   * Resolves the optional cloud fallback route (M42).
   *
   * Fails closed at every step: the default routing policy is 'local-only',
   * and even with the policy enabled a missing endpoint, model or credential
   * yields `available: false` with an enum reason. No provider object is
   * constructed until all four requirements hold, and constructing one still
   * performs no network I/O.
   */
  static async resolveCloudFallback(secrets: vscode.SecretStorage): Promise<CloudFallbackRouteResolution> {
    if (Config.getModelRoutingPolicy() !== 'local-first-cloud-fallback') {
      return { available: false, reason: 'policy_local_only' };
    }
    const baseUrl = Config.getCloudFallbackApiBase();
    if (!baseUrl) return { available: false, reason: 'endpoint_not_configured' };
    const model = Config.getCloudFallbackModel();
    if (!model) return { available: false, reason: 'model_not_configured' };
    const apiKey = (await secrets.get(CLOUD_FALLBACK_SECRET_KEY)) ?? '';
    if (!apiKey.trim()) return { available: false, reason: 'credential_missing' };
    // Hard spend gate: the legacy single-endpoint fallback is subject to the same policy as the pool. Free status is
    // established from the catalog entry for that endpoint's host; an endpoint the catalog does not know stays UNKNOWN.
    if (!legacyFallbackAllowedBySpendPolicy(baseUrl, model)) return { available: false, reason: 'spend_policy_blocks' };

    return {
      available: true,
      provider: new OpenAICompatibleProvider(baseUrl, apiKey),
      providerType: 'openai-compatible',
      model,
    };
  }

  /** Persists the cloud fallback endpoint's API key in VS Code SecretStorage. */
  static async storeCloudFallbackApiKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
    await secrets.store(CLOUD_FALLBACK_SECRET_KEY, key);
  }

  /** Removes the stored cloud fallback API key. */
  static async deleteCloudFallbackApiKey(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(CLOUD_FALLBACK_SECRET_KEY);
  }

  /** Persists an API key in VS Code SecretStorage. */
  static async storeApiKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
    await secrets.store(SECRET_KEY, key);
  }

  /** Removes a previously stored API key. */
  static async deleteApiKey(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(SECRET_KEY);
  }
}
