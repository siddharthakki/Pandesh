import { ChatMessage, ChatResponse, ToolDefinition, ToolCall } from '../tools/ToolTypes';

export type ProviderType = 'ollama' | 'openai-compatible';

export interface ModelInfo {
  name: string;
  modifiedAt?: string;
  contextWindow?: number;
  declaredContextWindow?: number;
  /**
   * Total parameter count as reported by the provider's own model metadata
   * (Ollama `general.parameter_count`, llama.cpp `meta.n_params`). Undefined
   * when the provider does not publish it — never inferred from the name.
   */
  parameterCount?: number;
  /**
   * Other names the provider itself states it accepts for this exact model
   * (llama.cpp `aliases`, Ollama's implicit `:latest` tag). `name` stays the
   * canonical id that is dispatched.
   */
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProviderChatOptions {
  /** Model name as stored in the provider (e.g. "qwen3:14b", "mistral"). */
  model: string;
  /** Context window in tokens. */
  contextWindow: number;
  /** Max tokens to generate. 0 means use the provider default. */
  maxOutputTokens: number;
  /** Sampling temperature in the range 0.0–2.0. */
  temperature: number;
  /** Hard limit on how long a single request may take, in milliseconds. */
  timeoutMs: number;
  /** Optional structured response constraint for providers that support native JSON Schema output. */
  responseFormat?: ProviderResponseFormat;
  /**
   * Explicit request to disable a model's native "thinking"/reasoning
   * channel, when the profile has verified the provider honors it. `false`
   * sends the provider's disable-thinking signal (Ollama: `think:false`);
   * `undefined` (the default for every profile that doesn't set it) sends
   * nothing and preserves prior behavior exactly. Never true — only an
   * explicit disable is ever requested; nothing invents an enable signal a
   * model wasn't already going to use on its own. A provider that has no
   * such concept ignores this field entirely.
   */
  nativeThinking?: false;
}

export interface ProviderJsonSchemaResponseFormat {
  type: 'json_schema';
  name: string;
  schema: Record<string, unknown>;
}

export type ProviderResponseFormat = ProviderJsonSchemaResponseFormat;

/**
 * Shape of each event emitted by a streaming chat response.
 * The non-streaming `chat` method in InferenceProvider returns a full ChatResponse;
 * this type documents the event shape for future AsyncIterable streaming support.
 */
export type StreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; index: number; toolCall: ToolCall }
  | { type: 'done'; content: string };

/**
 * Core contract every inference backend must implement.
 * All network methods accept an optional AbortSignal for cancellation and
 * enforce options.timeoutMs independently via an internal deadline.
 */
export interface InferenceProvider {
  readonly providerType: ProviderType;

  /**
   * Base URL of the backend, when the provider has one. Part of a model's runtime identity: the same model name
   * behaves differently behind different servers. Optional so test doubles need not supply it.
   */
  readonly endpoint?: string;

  /**
   * Verifies the backend is reachable and responsive.
   * Throws ProviderConnectionError when the host cannot be reached.
   * Throws ProviderApiError on unexpected HTTP status codes.
   */
  healthCheck(signal?: AbortSignal): Promise<void>;

  /**
   * Returns all models available from this backend.
   * Throws ProviderConnectionError / ProviderAuthError / ProviderApiError on failure.
   */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;

  getModelContextMetadata?(model: string, signal?: AbortSignal): Promise<ModelInfo | undefined>;

  /**
   * Models currently loaded in the provider's memory, when the provider can say (Ollama `/api/ps`). Evidence for
   * residency ranking only; undefined means unknown.
   */
  listResidentModels?(signal?: AbortSignal): Promise<readonly string[] | undefined>;

  /**
   * Sends a chat completion request and returns the full response.
   * Respects signal for user-initiated cancellation and enforces options.timeoutMs.
   * Throws typed ProviderError subclasses on every failure path.
   */
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResponse>;

  /**
   * Streaming variant of chat. Yields token deltas, tool_call events, then a
   * final done event. Optional — providers that do not implement it fall back to
   * the non-streaming chat method in AgentLoop.
   */
  chatStream?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

// ---------------------------------------------------------------------------
// Typed error hierarchy — callers can switch on instanceof
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(message: string, public readonly providerType: ProviderType) {
    super(message);
    this.name = 'ProviderError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Bounded classification tags describing why a transport-level error was raised. */
export type ProviderErrorEvidenceTag =
  | 'transport:undici-headers'
  | 'transport:undici-body'
  | 'transport:undici-connect'
  | 'provider:configured-abort'
  | 'upstream:cancellation'
  | 'agent:configured-timeout';

/** The backend host is unreachable (network error or process not running). */
export class ProviderConnectionError extends ProviderError {
  constructor(
    message: string,
    providerType: ProviderType,
    public readonly baseUrl: string,
    public readonly evidenceTag?: ProviderErrorEvidenceTag,
  ) {
    super(message, providerType);
    this.name = 'ProviderConnectionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The request was cancelled by caller/upstream signal, not by a timeout or a connection failure. */
export class ProviderCancelledError extends ProviderError {
  constructor(
    message: string,
    providerType: ProviderType,
    public readonly evidenceTag: ProviderErrorEvidenceTag = 'upstream:cancellation',
  ) {
    super(message, providerType);
    this.name = 'ProviderCancelledError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The requested model does not exist on this backend. */
export class ProviderModelNotFoundError extends ProviderError {
  constructor(
    message: string,
    providerType: ProviderType,
    public readonly model: string,
  ) {
    super(message, providerType);
    this.name = 'ProviderModelNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The provided API key is absent or rejected by the backend. */
export class ProviderAuthError extends ProviderError {
  constructor(message: string, providerType: ProviderType) {
    super(message, providerType);
    this.name = 'ProviderAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The request exceeded the configured deadline. */
export class ProviderTimeoutError extends ProviderError {
  constructor(
    message: string,
    providerType: ProviderType,
    public readonly timeoutMs: number,
    public readonly timeoutOwner: 'agent' | 'transport' = 'agent',
    public readonly evidenceTag?: ProviderErrorEvidenceTag,
  ) {
    super(message, providerType);
    this.name = 'ProviderTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The backend returned an unexpected HTTP status code or malformed body. */
export class ProviderApiError extends ProviderError {
  constructor(
    message: string,
    providerType: ProviderType,
    public readonly statusCode: number,
  ) {
    super(message, providerType);
    this.name = 'ProviderApiError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
