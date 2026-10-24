import { Agent } from 'undici';
import { RESIDENCY_LOOKUP_TIMEOUT_MS, budgetForRequest, knownResident, modelIsResident, noteModelResident, residentModelNames, type RequestBudget } from './OllamaColdStart';
import { ChatMessage, ChatResponse, ToolDefinition, ToolCall } from '../tools/ToolTypes';
import {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderType,
  StreamEvent,
  ProviderApiError,
  ProviderCancelledError,
  ProviderConnectionError,
  ProviderErrorEvidenceTag,
  ProviderModelNotFoundError,
  ProviderTimeoutError,
} from './ProviderTypes';
import { createOllamaAgent, postJson, postNdjsonStream } from './OllamaTransport';

export type OllamaFetchDiagnosticCode =
  | 'UND_ERR_HEADERS_TIMEOUT'
  | 'UND_ERR_BODY_TIMEOUT'
  | 'UND_ERR_CONNECT_TIMEOUT'
  | 'UND_ERR_SOCKET'
  | 'ECONNRESET'
  | 'ECONNREFUSED'
  | 'ETIMEDOUT';

export interface OllamaFetchErrorDiagnostic {
  topLevelName?: string;
  topLevelCode?: string;
  nestedCauseName?: string;
  nestedCauseCode?: string;
  nestedCauseConstructorName?: string;
  classification?: OllamaFetchDiagnosticCode;
}

const BOUNDED_FETCH_ERROR_CODES: ReadonlySet<OllamaFetchDiagnosticCode> = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

// ---------------------------------------------------------------------------
// Internal wire types — only used inside this module
// ---------------------------------------------------------------------------

interface OllamaTagsResponse {
  models: Array<{ name: string; modified_at: string }>;
}

interface OllamaRawMessage {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    function?: {
      name?: string;
      arguments?: unknown;
    };
  }>;
}

interface OllamaRawResponse {
  message?: OllamaRawMessage;
  done?: boolean;
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  parameters?: string;
  details?: Record<string, unknown>;
  /** Provider-declared capabilities, e.g. ["completion", "tools", "insert"]. */
  capabilities?: string[];
}

// Each NDJSON line from a streaming /api/chat response.
interface OllamaStreamChunk {
  message?: OllamaRawMessage;
  done?: boolean;
}

// ---------------------------------------------------------------------------
// OllamaProvider
// ---------------------------------------------------------------------------

export class OllamaProvider implements InferenceProvider {
  readonly providerType: ProviderType = 'ollama';

  // Single reusable undici Agent for chat/chatStream requests only — health
  // check, model listing, and model metadata calls stay on global fetch.
  // Owned by this instance; never a per-request dispatcher, and never wired
  // through setGlobalDispatcher. Callers must invoke dispose() when done
  // with this provider instance (idempotent, safe to call more than once).
  private agent: Agent | undefined;
  private disposed = false;

  constructor(private readonly baseUrl: string) {}

  get endpoint(): string { return this.baseUrl; }

  private getAgent(headersTimeoutMs: number, bodyTimeoutMs: number): Agent {
    if (!this.agent) {
      this.agent = createOllamaAgent({ headersTimeoutMs, bodyTimeoutMs });
    }
    return this.agent;
  }

  /** Idempotently closes the reusable undici Agent. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    const agent = this.agent;
    this.agent = undefined;
    if (agent) {
      await agent.close();
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<void> {
    const { signal: timed, cleanup } = this.withTimeout(signal, 5_000);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/tags`, { signal: timed });
      } catch (e) {
        throw this.wrapFetchError(e, timed, signal);
      }
      if (!res.ok) {
        throw new ProviderApiError(
          `Ollama health check failed: HTTP ${res.status}`,
          'ollama',
          res.status,
        );
      }
    } finally {
      cleanup();
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { signal: timed, cleanup } = this.withTimeout(signal, 10_000);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/tags`, { signal: timed });
      } catch (e) {
        throw this.wrapFetchError(e, timed, signal);
      }
      if (!res.ok) {
        throw new ProviderApiError(
          `Failed to list Ollama models: HTTP ${res.status}`,
          'ollama',
          res.status,
        );
      }
      const data = (await res.json()) as OllamaTagsResponse;
      if (!Array.isArray(data.models)) {
        throw new ProviderApiError('Ollama model list response was malformed', 'ollama', 200);
      }
      return (data.models ?? []).map((m) => ({
        name: m.name,
        modifiedAt: m.modified_at,
        // Ollama resolves an untagged reference to `:latest`, so a setting
        // naming `devstral-small-2` addresses the listed `devstral-small-2:latest`.
        ...(m.name.endsWith(':latest') ? { aliases: [m.name.slice(0, -':latest'.length)] } : {}),
      }));
    } finally {
      cleanup();
    }
  }

  /**
   * Models Ollama reports as loaded right now (`/api/ps`), or undefined when it cannot say. Evidence for the
   * router's residency preference only: unknown is never treated as "not loaded", and the lookup is tightly bounded.
   */
  async listResidentModels(signal?: AbortSignal): Promise<readonly string[] | undefined> {
    const { signal: timed, cleanup } = this.withTimeout(signal, RESIDENCY_LOOKUP_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/ps`, { signal: timed });
      if (!res.ok) return undefined;
      return residentModelNames(await res.json());
    } catch {
      return undefined;
    } finally {
      cleanup();
    }
  }

  async getModelContextMetadata(model: string, signal?: AbortSignal): Promise<ModelInfo | undefined> {
    const { signal: timed, cleanup } = this.withTimeout(signal, 10_000);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
          signal: timed,
        });
      } catch (e) {
        throw this.wrapFetchError(e, timed, signal);
      }
      if (!res.ok) {
        return undefined;
      }
      const data = (await res.json()) as OllamaShowResponse;
      const parameterContext = parseOllamaNumCtx(data.parameters);
      const info = data.model_info ?? {};
      // Ollama keys the declared context length by the model's own
      // architecture (`<general.architecture>.context_length`), so the
      // architecture reported in the same payload is the only reliable way to
      // find it — a fixed key list silently misses every architecture not
      // enumerated in it (qwen35, qwen3moe, gemma4, mistral3, ...), which
      // makes those models fall back to the registry's conservative 8192
      // heuristic. The explicit keys remain as fallbacks for payloads that
      // report no usable architecture.
      //
      // Deliberately NOT a scan for any key ending in `context_length`:
      // several architectures also publish
      // `<arch>.rope.scaling.original_context_length` (e.g. 8192 alongside a
      // real 262144), so a scan would let key order decide the answer and
      // could return the smaller pre-scaling value.
      const architecture = typeof info['general.architecture'] === 'string'
        ? info['general.architecture'].trim()
        : '';
      const declared = firstPositiveNumber([
        architecture ? info[`${architecture}.context_length`] : undefined,
        info['llama.context_length'],
        info['qwen2.context_length'],
        info['general.context_length'],
        info['context_length'],
      ]);
      const parameterCount = firstPositiveNumber([info['general.parameter_count']]);
      return {
        name: model,
        contextWindow: parameterContext,
        declaredContextWindow: declared,
        ...(parameterCount ? { parameterCount } : {}),
        metadata: {
          parameters: data.parameters,
          details: data.details,
          ...(Array.isArray(data.capabilities) ? { capabilities: data.capabilities } : {}),
        },
      };
    } finally {
      cleanup();
    }
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const budget = await this.requestBudget(options, signal);
    const { signal: timed, cleanup } = this.withTimeout(signal, budget.timeoutMs, budget.note);
    try {
      const hasImages = messages.some((m) => m.images && m.images.length > 0);
      // The context window is never adjusted here: vision minimums are
      // resolved by ModelDispatchPlanner before preflight, so the value
      // approved by preflight is exactly the num_ctx sent to Ollama.
      const ollamaOptions: Record<string, unknown> = {
        num_ctx: options.contextWindow,
        temperature: options.temperature,
      };
      if (options.maxOutputTokens > 0) {
        ollamaOptions['num_predict'] = options.maxOutputTokens;
      }

      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: false,
        options: ollamaOptions,
      };
      if (options.responseFormat?.type === 'json_schema') {
        body['format'] = options.responseFormat.schema;
      }
      if (options.nativeThinking === false) {
        body['think'] = false;
      }
      // Omit tools entirely for vision requests — sending tools confuses vision models.
      if (!hasImages && tools.length > 0) {
        body['tools'] = tools;
      }

      const { headersTimeoutMs, bodyTimeoutMs } = this.deriveTransportTimeouts(budget.timeoutMs);
      let result: { statusCode: number; text: string };
      try {
        result = await postJson({
          baseUrl: this.baseUrl,
          path: '/api/chat',
          body,
          signal: timed,
          timeouts: { headersTimeoutMs, bodyTimeoutMs },
          agent: this.getAgent(headersTimeoutMs, bodyTimeoutMs),
        });
      } catch (e) {
        throw this.wrapTransportError(e, timed, signal, budget.note);
      }

      if (result.statusCode < 200 || result.statusCode >= 300) {
        if (result.statusCode === 404 && result.text.includes('model')) {
          throw new ProviderModelNotFoundError(
            `Model "${options.model}" not found. Run: ollama pull ${options.model}`,
            'ollama',
            options.model,
          );
        }
        throw new ProviderApiError(
          `Ollama returned HTTP ${result.statusCode}: ${result.text}`,
          'ollama',
          result.statusCode,
        );
      }

      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        throw new ProviderApiError('Ollama returned a non-JSON response', 'ollama', 200);
      }

      // It answered, so it is loaded: remember that and skip the residency lookup on the next request.
      noteModelResident(this.baseUrl, options.model);
      return this.normalizeResponse(raw as OllamaRawResponse, tools);
    } finally {
      cleanup();
    }
  }

  // ---------------------------------------------------------------------------
  // Streaming chat
  // ---------------------------------------------------------------------------

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const budget = await this.requestBudget(options, signal);
    const { signal: timed, cleanup } = this.withTimeout(signal, budget.timeoutMs, budget.note);
    try {
      const hasImages = messages.some((m) => m.images && m.images.length > 0);
      // Same invariant as chat(): num_ctx is exactly the preflight-approved value.
      const ollamaOptions: Record<string, unknown> = {
        num_ctx: options.contextWindow,
        temperature: options.temperature,
      };
      if (options.maxOutputTokens > 0) {
        ollamaOptions['num_predict'] = options.maxOutputTokens;
      }

      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: true,
        options: ollamaOptions,
      };
      if (options.responseFormat?.type === 'json_schema') {
        body['format'] = options.responseFormat.schema;
      }
      if (options.nativeThinking === false) {
        body['think'] = false;
      }
      if (!hasImages && tools.length > 0) {
        body['tools'] = tools;
      }

      const { headersTimeoutMs, bodyTimeoutMs } = this.deriveTransportTimeouts(budget.timeoutMs);
      let streamResult: { statusCode: number; lines: AsyncIterable<unknown>; destroy: (error?: Error) => void };
      try {
        streamResult = await postNdjsonStream({
          baseUrl: this.baseUrl,
          path: '/api/chat',
          body,
          signal: timed,
          timeouts: { headersTimeoutMs, bodyTimeoutMs },
          agent: this.getAgent(headersTimeoutMs, bodyTimeoutMs),
        });
      } catch (e) {
        throw this.wrapTransportError(e, timed, signal, budget.note);
      }

      if (streamResult.statusCode < 200 || streamResult.statusCode >= 300) {
        let text = '';
        try {
          for await (const line of streamResult.lines) {
            text += typeof line === 'string' ? line : JSON.stringify(line);
          }
        } catch { /* best-effort error body capture */ }
        streamResult.destroy();
        if (streamResult.statusCode === 404 && text.includes('model')) {
          throw new ProviderModelNotFoundError(
            `Model "${options.model}" not found. Run: ollama pull ${options.model}`,
            'ollama',
            options.model,
          );
        }
        throw new ProviderApiError(
          `Ollama returned HTTP ${streamResult.statusCode}: ${text}`,
          'ollama',
          streamResult.statusCode,
        );
      }

      let fullContent = '';
      let sawDone = false;

      // ndjsonLines() owns body cleanup in its own try/finally: an early
      // `break` here calls the async generator's `.return()`, which runs
      // that finally and destroys the response body deterministically.
      outer: for await (const parsedUnknown of streamResult.lines) {
        const parsed = parsedUnknown as OllamaStreamChunk;
        const delta = parsed.message?.content ?? '';
        if (delta) {
          fullContent += delta;
          yield { type: 'token', delta };
        }

        if (parsed.done) {
          sawDone = true;
          noteModelResident(this.baseUrl, options.model);
          yield* this.yieldFinalEvents(parsed, fullContent, tools);
          break outer;
        }
      }

      if (!sawDone) {
        // Stream ended without a done:true chunk — emit done with what we have.
        yield { type: 'done', content: fullContent };
      }
    } finally {
      cleanup();
    }
  }

  private *yieldFinalEvents(
    chunk: OllamaStreamChunk,
    fullContent: string,
    tools: ToolDefinition[],
  ): Iterable<StreamEvent> {
    const toolCalls = this.normalizeToolCalls(chunk.message?.tool_calls);
    let displayContent = fullContent;

    if (toolCalls.length > 0) {
      for (let idx = 0; idx < toolCalls.length; idx++) {
        yield { type: 'tool_call', index: idx, toolCall: toolCalls[idx] };
      }
    } else if (fullContent.trim()) {
      // Some models embed tool calls as JSON text in the content stream.
      const validNames = new Set(tools.map((t) => t.function.name));
      const { calls, textContent } = this.extractToolCalls(fullContent, validNames);
      if (calls.length > 0) {
        for (let idx = 0; idx < calls.length; idx++) {
          yield { type: 'tool_call', index: idx, toolCall: calls[idx] };
        }
        displayContent = textContent;
      }
    }

    yield { type: 'done', content: displayContent };
  }

  // ---------------------------------------------------------------------------
  // Response normalisation (mirrors OllamaClient for backward compatibility)
  // ---------------------------------------------------------------------------

  private normalizeResponse(raw: OllamaRawResponse, tools: ToolDefinition[]): ChatResponse {
    const msg = raw.message;
    if (!msg) {
      throw new ProviderApiError('Ollama response missing "message" field', 'ollama', 200);
    }

    let toolCalls = this.normalizeToolCalls(msg.tool_calls);
    const rawContent = String(msg.content ?? '');

    // Some models (qwen2.5-coder, llama3.1) embed tool calls as JSON text in
    // content instead of — or in addition to — the tool_calls field.
    let displayContent = rawContent;
    if (toolCalls.length === 0 && rawContent.trim()) {
      const validNames = new Set(tools.map((t) => t.function.name));
      const { calls, textContent } = this.extractToolCalls(rawContent, validNames);
      if (calls.length > 0) {
        toolCalls = calls;
        displayContent = textContent;
      }
    }

    return {
      message: {
        role: (msg.role as ChatMessage['role']) ?? 'assistant',
        content: displayContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      done: Boolean(raw.done ?? true),
    };
  }

  /**
   * Extracts tool calls from content that may be:
   *   1. Pure JSON object:   `{"name":"read_file","arguments":{...}}`
   *   2. JSON array:         `[{"name":"read_file",...}, ...]`
   *   3. Multiple JSON objects on separate lines (one per line)
   *   4. Mixed prose + JSON: "I'll read the file:\n{\"name\":...}"
   *
   * Returns both the extracted calls and content with JSON lines stripped so
   * the UI can show explanatory prose without raw JSON.
   */
  private extractToolCalls(
    content: string,
    validNames: ReadonlySet<string>,
  ): { calls: ToolCall[]; textContent: string } {
    if (validNames.size === 0) {
      return { calls: [], textContent: content };
    }

    const lines = content.split('\n');
    const calls: ToolCall[] = [];
    const keptLines: string[] = [];

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const parsed = JSON.parse(t);
          const extracted = this.callsFromParsed(parsed, validNames);
          if (extracted.length > 0) {
            calls.push(...extracted);
            continue;
          }
        } catch { /* not valid JSON — fall through */ }
      }
      keptLines.push(line);
    }

    if (calls.length > 0) {
      return { calls, textContent: keptLines.join('\n').trimEnd() };
    }

    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const extracted = this.callsFromParsed(parsed, validNames);
        if (extracted.length > 0) {
          return { calls: extracted, textContent: '' };
        }
      } catch { /* not valid JSON */ }
    }

    return { calls: [], textContent: content };
  }

  private callsFromParsed(parsed: unknown, validNames: ReadonlySet<string>): ToolCall[] {
    if (Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>[])
        .filter((item) => typeof item['name'] === 'string' && validNames.has(item['name'] as string))
        .map((item) => ({
          function: {
            name: item['name'] as string,
            arguments: this.normalizeArgs(item['arguments'] ?? item['parameters']),
          },
        }));
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj['name'] === 'string' && validNames.has(obj['name'])) {
        return [{
          function: {
            name: obj['name'],
            arguments: this.normalizeArgs(obj['arguments'] ?? obj['parameters']),
          },
        }];
      }
    }
    return [];
  }

  private normalizeArgs(raw: unknown): Record<string, unknown> {
    if (!raw) { return {}; }
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return {};
  }

  private normalizeToolCalls(
    raw: OllamaRawMessage['tool_calls'],
  ): ToolCall[] {
    if (!Array.isArray(raw)) { return []; }
    const calls: ToolCall[] = [];

    for (const item of raw) {
      const fn = item.function;
      if (!fn) { continue; }

      calls.push({
        function: {
          name: String(fn.name ?? ''),
          arguments: this.normalizeArgs(fn.arguments),
        },
      });
    }
    return calls;
  }

  // ---------------------------------------------------------------------------
  // Timeout + error helpers
  // ---------------------------------------------------------------------------

  /**
   * The deadline for one chat request. Ollama can say whether the model is resident (`/api/ps`); a model known not
   * to be loaded gets one bounded startup allowance on top of the normal timeout, and everything else keeps the
   * normal timeout exactly. The lookup is itself tightly bounded and any failure means "unknown", never "cold".
   */
  private async requestBudget(options: ProviderChatOptions, signal: AbortSignal | undefined): Promise<RequestBudget> {
    // A model that answered a moment ago is still loaded: no lookup, no extra request, normal timeout.
    if (knownResident(this.baseUrl, options.model)) return budgetForRequest(options.timeoutMs, true);
    const resident = await this.residency(options.model, signal);
    if (resident === true) noteModelResident(this.baseUrl, options.model);
    return budgetForRequest(options.timeoutMs, resident);
  }

  private async residency(model: string, signal: AbortSignal | undefined): Promise<boolean | undefined> {
    const { signal: timed, cleanup } = this.withTimeout(signal, RESIDENCY_LOOKUP_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/ps`, { signal: timed });
      if (!res.ok) return undefined;
      return modelIsResident(await res.json(), model);
    } catch {
      return undefined;
    } finally {
      cleanup();
    }
  }

  private withTimeout(
    upstream: AbortSignal | undefined,
    timeoutMs: number,
    note = '',
  ): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new ProviderTimeoutError(
          `Request timed out after ${timeoutMs}ms${note ? ` (${note})` : ''}`,
          'ollama',
          timeoutMs,
          'agent',
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

  /**
   * headersTimeout/bodyTimeout are derived from the caller's overall
   * options.timeoutMs, but deliberately set tighter than it (up to 2000ms
   * less, min 1ms) so that undici's own protocol-level timers fire — and are
   * classified with a precise transport evidence tag — before the outer
   * AbortController (set up in withTimeout) races them to the same deadline.
   * The 2000ms margin also absorbs undici's coarse internal timer-wheel
   * granularity (observed ~1s resolution on this runtime: a headersTimeout of
   * e.g. 250ms does not fire at 250ms, it fires on the next ~1s tick), so a
   * transport timeout reliably surfaces before the outer budget for any
   * options.timeoutMs generous enough to leave the margin (in practice, the
   * configured provider default of 900_000ms leaves ample room). The
   * configured AbortSignal remains the authoritative overall budget and
   * always fires by options.timeoutMs regardless of transport timing; this
   * margin only affects which layer reports the failure.
   */
  private deriveTransportTimeouts(timeoutMs: number): { headersTimeoutMs: number; bodyTimeoutMs: number } {
    const bounded = Math.max(1, timeoutMs);
    const margin = Math.min(2_000, Math.floor(bounded / 2));
    const tightened = Math.max(1, bounded - margin);
    return { headersTimeoutMs: tightened, bodyTimeoutMs: tightened };
  }

  private wrapTransportError(
    e: unknown,
    timedSignal: AbortSignal,
    upstreamSignal: AbortSignal | undefined,
    budgetNote = '',
  ): ProviderConnectionError | ProviderTimeoutError | ProviderCancelledError {
    const suffix = budgetNote ? ` (${budgetNote})` : '';
    // undici can propagate an AbortSignal's `reason` directly as the rejection
    // value (not always wrapped in an AbortError/DOMException) — check this
    // first regardless of e's own name/shape.
    if (e === timedSignal.reason && e instanceof ProviderTimeoutError) {
      return e;
    }

    // Signal identity/reason is checked before Undici transport error codes:
    // the configured timeout fired -> preserve ProviderTimeoutError; upstream
    // cancellation (caller/orchestrator abort, not our configured timeout)
    // -> canonical cancellation, never ProviderConnectionError. Undici may
    // reject with the signal's reason directly rather than an AbortError, so
    // this cannot rely on checking `e.name === 'AbortError'` alone.
    if (timedSignal.aborted) {
      const reason = timedSignal.reason;
      if (reason instanceof ProviderTimeoutError) {
        return reason;
      }
      if (upstreamSignal?.aborted) {
        return new ProviderCancelledError('Request was cancelled.', 'ollama', 'upstream:cancellation');
      }
    }
    if (
      e instanceof Error &&
      (e.name === 'AbortError' || e.name === 'DOMException' || e === timedSignal.reason)
    ) {
      const reason = timedSignal.reason;
      if (reason instanceof ProviderTimeoutError) {
        return reason;
      }
      return new ProviderCancelledError('Request was cancelled.', 'ollama', 'upstream:cancellation');
    }

    const diagnostic = inspectOllamaFetchError(e);
    if (diagnostic.classification === 'UND_ERR_HEADERS_TIMEOUT') {
      return new ProviderTimeoutError(
        `Ollama transport timed out waiting for response headers${suffix}.`,
        'ollama',
        0,
        'transport',
        'transport:undici-headers',
      );
    }
    if (diagnostic.classification === 'UND_ERR_BODY_TIMEOUT') {
      return new ProviderTimeoutError(
        `Ollama transport timed out waiting for the response body${suffix}.`,
        'ollama',
        0,
        'transport',
        'transport:undici-body',
      );
    }
    if (diagnostic.classification === 'UND_ERR_CONNECT_TIMEOUT') {
      return new ProviderTimeoutError(
        'Ollama transport timed out establishing a connection.',
        'ollama',
        0,
        'transport',
        'transport:undici-connect',
      );
    }
    if (diagnostic.classification === 'ETIMEDOUT') {
      return new ProviderTimeoutError(
        'Ollama transport timed out.',
        'ollama',
        0,
        'transport',
        'transport:undici-connect',
      );
    }
    if (diagnostic.classification === 'ECONNREFUSED') {
      return new ProviderConnectionError(
        `Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running: https://ollama.com`,
        'ollama',
        this.baseUrl,
      );
    }
    if (diagnostic.classification === 'UND_ERR_SOCKET' || diagnostic.classification === 'ECONNRESET') {
      return new ProviderConnectionError(
        `Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running: https://ollama.com`,
        'ollama',
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
        `Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running: https://ollama.com`,
        'ollama',
        this.baseUrl,
      );
    }
    return new ProviderConnectionError(`Ollama request failed: ${msg}`, 'ollama', this.baseUrl);
  }

  private wrapFetchError(
    e: unknown,
    timedSignal: AbortSignal,
    upstreamSignal: AbortSignal | undefined,
  ): ProviderConnectionError | ProviderTimeoutError | ProviderCancelledError {
    if (timedSignal.aborted) {
      const reason = timedSignal.reason;
      if (reason instanceof ProviderTimeoutError) {
        return reason;
      }
      if (upstreamSignal?.aborted) {
        return new ProviderCancelledError('Request was cancelled.', 'ollama', 'upstream:cancellation');
      }
    }
    if (
      e instanceof Error &&
      (e.name === 'AbortError' || e.name === 'DOMException' || e === timedSignal.reason)
    ) {
      const reason = timedSignal.reason;
      if (reason instanceof ProviderTimeoutError) {
        return reason;
      }
      return new ProviderCancelledError('Request was cancelled.', 'ollama', 'upstream:cancellation');
    }
    const diagnostic = inspectOllamaFetchError(e);
    if (
      diagnostic.classification === 'UND_ERR_HEADERS_TIMEOUT' ||
      diagnostic.classification === 'UND_ERR_BODY_TIMEOUT' ||
      diagnostic.classification === 'UND_ERR_CONNECT_TIMEOUT' ||
      diagnostic.classification === 'ETIMEDOUT'
    ) {
      return new ProviderTimeoutError(
        'Ollama transport timed out before the agent request timeout elapsed.',
        'ollama',
        0,
        'transport',
      );
    }
    if (
      diagnostic.classification === 'UND_ERR_SOCKET' ||
      diagnostic.classification === 'ECONNRESET' ||
      diagnostic.classification === 'ECONNREFUSED'
    ) {
      return new ProviderConnectionError(
        `Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running: https://ollama.com`,
        'ollama',
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
        `Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running: https://ollama.com`,
        'ollama',
        this.baseUrl,
      );
    }
    return new ProviderConnectionError(`Ollama request failed: ${msg}`, 'ollama', this.baseUrl);
  }
}

export function inspectOllamaFetchError(error: unknown): OllamaFetchErrorDiagnostic {
  const top = errorObject(error);
  const cause = errorObject(top?.['cause']);
  const topLevelCode = stringValue(top?.['code']);
  const nestedCauseCode = stringValue(cause?.['code']);
  return {
    topLevelName: stringValue(top?.['name']),
    topLevelCode,
    nestedCauseName: stringValue(cause?.['name']),
    nestedCauseCode,
    nestedCauseConstructorName: constructorName(cause),
    classification: classifyOllamaFetchErrorCode(nestedCauseCode) ?? classifyOllamaFetchErrorCode(topLevelCode),
  };
}

function classifyOllamaFetchErrorCode(value: string | undefined): OllamaFetchDiagnosticCode | undefined {
  return value && BOUNDED_FETCH_ERROR_CODES.has(value as OllamaFetchDiagnosticCode)
    ? value as OllamaFetchDiagnosticCode
    : undefined;
}

function errorObject(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function constructorName(value: Record<string, unknown> | undefined): string | undefined {
  const ctor = value?.['constructor'];
  return typeof ctor === 'function' ? stringValue(ctor.name) : undefined;
}

function parseOllamaNumCtx(parameters: string | undefined): number | undefined {
  if (!parameters) return undefined;
  const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function firstPositiveNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(numberValue) && numberValue > 0) return Math.floor(numberValue);
  }
  return undefined;
}
