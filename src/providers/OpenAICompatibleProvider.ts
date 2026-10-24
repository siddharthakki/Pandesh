import { ChatMessage, ChatResponse, ToolDefinition, ToolCall } from '../tools/ToolTypes';
import {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderType,
  StreamEvent,
  ProviderApiError,
  ProviderAuthError,
  ProviderConnectionError,
  ProviderModelNotFoundError,
  ProviderTimeoutError,
} from './ProviderTypes';

// ---------------------------------------------------------------------------
// Internal OpenAI wire types — only used inside this module
// ---------------------------------------------------------------------------

interface OAITextPart {
  type: 'text';
  text: string;
}

interface OAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}

type OAIContentPart = OAITextPart | OAIImagePart;

interface OAISystemMessage {
  role: 'system';
  content: string;
}

interface OAIUserMessage {
  role: 'user';
  content: string | OAIContentPart[];
}

interface OAIAssistantToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OAIAssistantToolCall[];
}

interface OAIToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

type OAIMessage =
  | OAISystemMessage
  | OAIUserMessage
  | OAIAssistantMessage
  | OAIToolMessage;

interface OAIModelsResponse {
  data: Array<{
    id: string;
    object: string;
    /** llama.cpp `llama-server`: names the server also accepts for this model. */
    aliases?: unknown;
    /** llama.cpp `llama-server`: runtime (`n_ctx`) and trained (`n_ctx_train`) context, `n_params`. */
    meta?: Record<string, unknown>;
    /** vLLM: the context length the served engine was started with. */
    max_model_len?: unknown;
  }>;
}

interface OAIResponseMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

interface OAIChatResponse {
  choices: Array<{
    message: OAIResponseMessage;
    finish_reason: string;
  }>;
}

// SSE streaming chunk shape
interface OAIStreamDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OAIStreamChunk {
  choices?: Array<{
    delta?: OAIStreamDelta;
    finish_reason?: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider
// Used for LM Studio (default base URL http://localhost:1234) and any endpoint
// that speaks the OpenAI /v1/chat/completions protocol.
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements InferenceProvider {
  readonly providerType: ProviderType = 'openai-compatible';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  get endpoint(): string { return this.baseUrl; }

  private get authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async healthCheck(signal?: AbortSignal): Promise<void> {
    const { signal: timed, cleanup } = this.withTimeout(signal, 5_000);
    const probeUrl = this.apiUrl('models');
    try {
      let res: Response;
      try {
        res = await fetch(probeUrl, {
          headers: this.authHeaders,
          signal: timed,
        });
      } catch (e) {
        throw this.wrapFetchError(e, timed);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(
          `Authentication failed (HTTP ${res.status}). Check the API key stored in VS Code secrets.`,
          'openai-compatible',
        );
      }
      if (res.status === 404) {
        // A truthful 404 on the model-discovery endpoint means this host does not
        // speak the OpenAI-compatible protocol at the configured base URL — not a
        // generic "unreachable" failure. No model-generation call is made to reach
        // this verdict, so readiness never spends cloud tokens.
        throw new ProviderApiError(
          `This endpoint does not expose an OpenAI-compatible model list at ${probeUrl} (HTTP 404). `
            + 'Check that the base URL points at the provider\'s API root.',
          'openai-compatible',
          404,
        );
      }
      if (!res.ok) {
        throw new ProviderApiError(
          `Health check failed: HTTP ${res.status}`,
          'openai-compatible',
          res.status,
        );
      }
    } finally {
      cleanup();
    }
  }

  /**
   * Resolves a `/v1`-relative API path (`"models"`, `"chat/completions"`)
   * against the configured base URL — the single normalization point for
   * every endpoint this provider calls.
   *
   * The configured base URL may already carry the API version segment
   * (OpenAI convention, e.g. `https://api.openai.com/v1`, or OrcaRouter's
   * `https://api.orcarouter.ai/v1`) or may be a bare host root (LM Studio
   * convention, e.g. `http://localhost:1234`). Appending `/v1/${path}`
   * unconditionally is only correct for the bare-host-root case; for a base
   * that already ends in `/v1` it double-appends the version segment and
   * 404s against an otherwise-healthy, correctly-credentialed endpoint.
   * This does not change what gets requested for either form of base URL
   * that was already working (bare host root), and nothing here is ever
   * persisted as an endpoint — it is recomputed on every call.
   */
  private apiUrl(path: string): string {
    return /\/(v\d+[a-z]*\d*(\/openai)?|openai)$/i.test(this.baseUrl)
      ? `${this.baseUrl}/${path}`
      : `${this.baseUrl}/v1/${path}`;
  }

  /**
   * The raw `/models` JSON body. Cloud catalogs read provider-documented extensions from it (pricing,
   * modalities, supported parameters, context length), so the body is returned untouched.
   */
  async listModelsRaw(signal?: AbortSignal): Promise<unknown> {
    const { signal: timed, cleanup } = this.withTimeout(signal, 10_000);
    try {
      let res: Response;
      try {
        res = await fetch(this.apiUrl('models'), {
          headers: this.authHeaders,
          signal: timed,
        });
      } catch (e) {
        throw this.wrapFetchError(e, timed);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(
          `Authentication failed (HTTP ${res.status}). Check the API key stored in VS Code secrets.`,
          'openai-compatible',
        );
      }
      if (!res.ok) {
        throw new ProviderApiError(
          `Failed to list models: HTTP ${res.status}`,
          'openai-compatible',
          res.status,
        );
      }
      return await res.json();
    } finally {
      cleanup();
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const data = (await this.listModelsRaw(signal)) as OAIModelsResponse;
    if (!Array.isArray(data.data)) {
      throw new ProviderApiError('Provider model list response was malformed', 'openai-compatible', 200);
    }
    return (data.data ?? []).map(toModelInfo);
  }

  /**
   * The standard OpenAI `/v1/models` schema carries only `id`, so a strict
   * OpenAI-style server yields no context or size facts here. Local servers
   * that publish them as documented extensions (llama.cpp `meta`, vLLM
   * `max_model_len`) are read by `toModelInfo`; nothing is ever guessed.
   */
  async getModelContextMetadata(model: string, signal?: AbortSignal): Promise<ModelInfo | undefined> {
    const models = await this.listModels(signal);
    return models.find(item => item.name === model || item.aliases?.includes(model));
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const { signal: timed, cleanup } = this.withTimeout(signal, options.timeoutMs);
    try {
      const hasImages = messages.some((m) => m.images && m.images.length > 0);
      const oaiMessages = this.toOpenAIMessages(messages);

      const body: Record<string, unknown> = {
        model: options.model,
        messages: oaiMessages,
        stream: false,
        temperature: options.temperature,
      };
      if (options.maxOutputTokens > 0) {
        body['max_tokens'] = options.maxOutputTokens;
      }
      if (options.responseFormat?.type === 'json_schema') {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: options.responseFormat.name,
            strict: true,
            schema: options.responseFormat.schema,
          },
        };
      }
      // Omit tools for vision requests (same convention as OllamaProvider).
      if (!hasImages && tools.length > 0) {
        body['tools'] = tools;
        body['tool_choice'] = 'auto';
      }

      let res: Response;
      try {
        res = await fetch(this.apiUrl('chat/completions'), {
          method: 'POST',
          headers: this.authHeaders,
          body: JSON.stringify(body),
          signal: timed,
        });
      } catch (e) {
        throw this.wrapFetchError(e, timed);
      }

      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(
          `Authentication failed (HTTP ${res.status}). Set your API key via the extension settings.`,
          'openai-compatible',
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (
          res.status === 404 &&
          (text.toLowerCase().includes('model') || text.toLowerCase().includes('not found'))
        ) {
          throw new ProviderModelNotFoundError(
            `Model "${options.model}" not found at ${this.baseUrl}.`,
            'openai-compatible',
            options.model,
          );
        }
        throw new ProviderApiError(
          `Provider returned HTTP ${res.status}: ${text}`,
          'openai-compatible',
          res.status,
        );
      }

      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        throw new ProviderApiError(
          'Provider returned a non-JSON response',
          'openai-compatible',
          200,
        );
      }

      return this.normalizeResponse(raw as OAIChatResponse);
    } finally {
      cleanup();
    }
  }

  // ---------------------------------------------------------------------------
  // Streaming chat (SSE)
  // ---------------------------------------------------------------------------

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const { signal: timed, cleanup } = this.withTimeout(signal, options.timeoutMs);
    try {
      const hasImages = messages.some((m) => m.images && m.images.length > 0);
      const oaiMessages = this.toOpenAIMessages(messages);

      const body: Record<string, unknown> = {
        model: options.model,
        messages: oaiMessages,
        stream: true,
        temperature: options.temperature,
      };
      if (options.maxOutputTokens > 0) {
        body['max_tokens'] = options.maxOutputTokens;
      }
      if (options.responseFormat?.type === 'json_schema') {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: options.responseFormat.name,
            strict: true,
            schema: options.responseFormat.schema,
          },
        };
      }
      if (!hasImages && tools.length > 0) {
        body['tools'] = tools;
        body['tool_choice'] = 'auto';
      }

      let res: Response;
      try {
        res = await fetch(this.apiUrl('chat/completions'), {
          method: 'POST',
          headers: this.authHeaders,
          body: JSON.stringify(body),
          signal: timed,
        });
      } catch (e) {
        throw this.wrapFetchError(e, timed);
      }

      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(
          `Authentication failed (HTTP ${res.status}).`,
          'openai-compatible',
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderApiError(
          `Provider returned HTTP ${res.status}: ${text}`,
          'openai-compatible',
          res.status,
        );
      }
      if (!res.body) {
        throw new ProviderApiError('Empty response body', 'openai-compatible', 200);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';

      // Accumulate streaming tool-call fragments keyed by call index.
      // Each entry builds up the full tool call as chunks arrive.
      const toolCallAccum: Map<number, {
        id: string;
        name: string;
        argsRaw: string;
      }> = new Map();

      try {
        outer: while (true) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (e) {
            throw this.wrapFetchError(e, timed);
          }
          if (chunk.done) { break; }
          buffer += decoder.decode(chunk.value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') {
              if (trimmed === 'data: [DONE]') { break outer; }
              continue;
            }
            if (!trimmed.startsWith('data: ')) { continue; }

            let parsed: OAIStreamChunk;
            try {
              parsed = JSON.parse(trimmed.slice(6)) as OAIStreamChunk;
            } catch {
              continue;
            }

            const delta = parsed.choices?.[0]?.delta;
            if (!delta) { continue; }

            // Text content
            if (delta.content) {
              fullContent += delta.content;
              yield { type: 'token', delta: delta.content };
            }

            // Tool call fragments
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccum.has(idx)) {
                  toolCallAccum.set(idx, { id: tc.id ?? `call_${idx}`, name: '', argsRaw: '' });
                }
                const acc = toolCallAccum.get(idx)!;
                if (tc.function?.name) { acc.name += tc.function.name; }
                if (tc.function?.arguments) { acc.argsRaw += tc.function.arguments; }
                if (tc.id) { acc.id = tc.id; }
              }
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      // Emit accumulated tool calls
      if (toolCallAccum.size > 0) {
        const sorted = [...toolCallAccum.entries()].sort(([a], [b]) => a - b);
        for (const [idx, acc] of sorted) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(acc.argsRaw) as Record<string, unknown>; } catch { /* keep empty */ }
          yield {
            type: 'tool_call',
            index: idx,
            toolCall: { id: acc.id, function: { name: acc.name, arguments: args } },
          };
        }
        yield { type: 'done', content: fullContent };
      } else {
        yield { type: 'done', content: fullContent };
      }
    } finally {
      cleanup();
    }
  }

  // ---------------------------------------------------------------------------
  // ChatMessage → OpenAI wire format conversion
  //
  // Tool result messages carry a `tool_call_id` that must match the `id` on the
  // preceding assistant message's tool_calls entry. IDs are read from the stored
  // ToolCall.id (set on round-trip from this provider) or derived from a stable
  // synthetic key; pairing is resolved structurally via resolveToolCallId.
  // ---------------------------------------------------------------------------

  private toOpenAIMessages(messages: ChatMessage[]): OAIMessage[] {
    const result: OAIMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'system') {
        result.push({ role: 'system', content: msg.content });

      } else if (msg.role === 'user') {
        if (msg.images && msg.images.length > 0) {
          const parts: OAIContentPart[] = [{ type: 'text', text: msg.content }];
          for (const img of msg.images) {
            // Encode as JPEG base64 data URL (images were already base64-encoded
            // by AgentPanel; we don't know the original MIME type so use jpeg).
            parts.push({
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${img}` },
            });
          }
          result.push({ role: 'user', content: parts });
        } else {
          result.push({ role: 'user', content: msg.content });
        }

      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const toolCalls: OAIAssistantToolCall[] = msg.tool_calls.map((tc, tcIdx) => ({
            id: tc.id ?? `call_${i}_${tcIdx}`,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: JSON.stringify(tc.function.arguments),
            },
          }));
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: toolCalls,
          });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }

      } else if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          tool_call_id: this.resolveToolCallId(messages, i),
          content: msg.content,
        });
      }
    }

    return result;
  }

  /**
   * Resolves the tool_call_id for a tool result message at `toolIdx` by
   * scanning backward to the assistant message that issued the call, then
   * picking the ToolCall at the matching offset position.
   *
   * This is purely structural — no accumulated state required — so it remains
   * correct even when earlier messages have been pruned from the context window.
   */
  private resolveToolCallId(messages: ChatMessage[], toolIdx: number): string {
    // Walk backward past any preceding tool messages to find the assistant.
    let assistantIdx = -1;
    for (let j = toolIdx - 1; j >= 0; j--) {
      if (messages[j].role === 'tool') { continue; }
      if (messages[j].role === 'assistant') { assistantIdx = j; }
      break;
    }
    if (assistantIdx === -1 || !messages[assistantIdx].tool_calls?.length) {
      return `call_fallback_${toolIdx}`;
    }
    // Count how many tool messages precede this one in the same run.
    let offset = 0;
    for (let j = assistantIdx + 1; j < toolIdx; j++) {
      if (messages[j].role === 'tool') { offset++; }
    }
    const tc = messages[assistantIdx].tool_calls![offset];
    // Synthetic fallback uses the same formula as the assistant branch so IDs match.
    return tc?.id ?? `call_${assistantIdx}_${offset}`;
  }

  // ---------------------------------------------------------------------------
  // OpenAI response → ChatResponse normalisation
  // ---------------------------------------------------------------------------

  private normalizeResponse(raw: OAIChatResponse): ChatResponse {
    const choices = raw.choices;
    if (!choices || choices.length === 0) {
      throw new ProviderApiError(
        'Provider response has no choices',
        'openai-compatible',
        200,
      );
    }

    const msg = choices[0].message;
    if (!msg) {
      throw new ProviderApiError(
        'Provider response choice has no message',
        'openai-compatible',
        200,
      );
    }

    let toolCalls: ToolCall[] | undefined;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        return {
          id: tc.id,   // preserve for round-trip tool_call_id pairing
          function: {
            name: tc.function.name,
            arguments: args,
          },
        };
      });
    }

    return {
      message: {
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: toolCalls,
      },
      done: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Timeout + error helpers
  // ---------------------------------------------------------------------------

  private withTimeout(
    upstream: AbortSignal | undefined,
    timeoutMs: number,
  ): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new ProviderTimeoutError(
          `Request timed out after ${timeoutMs}ms`,
          'openai-compatible',
          timeoutMs,
        ),
      );
    }, timeoutMs);

    if (upstream) {
      if (upstream.aborted) {
        clearTimeout(timer);
        controller.abort(upstream.reason as Error | undefined);
      } else {
        upstream.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            controller.abort(upstream.reason as Error | undefined);
          },
          { once: true },
        );
      }
    }

    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  }

  private wrapFetchError(
    e: unknown,
    timedSignal: AbortSignal,
  ): ProviderConnectionError | ProviderTimeoutError {
    if (e instanceof Error && e.name === 'AbortError') {
      const reason = timedSignal.reason;
      if (reason instanceof ProviderTimeoutError) {
        return reason;
      }
      return new ProviderConnectionError(
        'Request was cancelled.',
        'openai-compatible',
        this.baseUrl,
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes('ECONNREFUSED') ||
      msg.includes('fetch failed') ||
      msg.includes('Failed to fetch')
    ) {
      return new ProviderConnectionError(
        `Cannot connect to ${this.baseUrl}. Make sure the service is running (e.g. LM Studio server).`,
        'openai-compatible',
        this.baseUrl,
      );
    }
    return new ProviderConnectionError(
      `Request failed: ${msg}`,
      'openai-compatible',
      this.baseUrl,
    );
  }
}

/**
 * Maps one `/v1/models` entry to `ModelInfo`, reading only fields the serving
 * engine documents: llama.cpp publishes `meta.n_ctx` (the context the server
 * was actually started with, i.e. the hard runtime ceiling), `meta.n_ctx_train`
 * (the model's trained context) and `meta.n_params`, plus `aliases`; vLLM
 * publishes `max_model_len`. Absent or non-positive values stay undefined.
 */
function toModelInfo(entry: OAIModelsResponse['data'][number]): ModelInfo {
  const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
  const contextWindow = positiveInteger(meta['n_ctx']) ?? positiveInteger(entry.max_model_len);
  const declaredContextWindow = positiveInteger(meta['n_ctx_train']);
  const parameterCount = positiveInteger(meta['n_params']);
  const aliases = Array.isArray(entry.aliases)
    ? [...new Set(entry.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0 && alias !== entry.id))]
    : [];
  return {
    name: entry.id,
    ...(contextWindow ? { contextWindow } : {}),
    ...(declaredContextWindow ? { declaredContextWindow } : {}),
    ...(parameterCount ? { parameterCount } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
