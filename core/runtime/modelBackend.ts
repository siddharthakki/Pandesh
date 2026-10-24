/**
 * Core-owned model execution backend. This is the seam that makes the Core
 * process itself the owner of model calls (M32 Priority 1) rather than an
 * after-the-fact shadow of an Extension-Host-run call.
 *
 * Streaming chat uses direct undici (see ollamaStreamTransport.ts) so the
 * default 300s bodyTimeout cannot terminate a silent Ollama stream. Fakes in
 * tests still implement `ModelBackend` without touching undici.
 */

import {
  isOllamaStreamTransportTermination,
  streamOllamaChatNdjson,
} from './ollamaStreamTransport';
import { CAPABILITY_UNSUPPORTED_PATTERN } from '../platform/autoReroute';
import { parseInlineToolCalls, type InlineToolCallsResult } from './inlineToolCalls';
import {
  assertPromptFitsContext,
  benchmarkSamplingOptions,
  ollamaPayloadControls,
  OLLAMA_ASSUMED_DEFAULT_NUM_CTX,
  resolveImplicitNumCtx,
  sentValuesFromPayload,
  type OllamaSentValues,
} from './ollamaChatControls';
import { adoptLoadedContext, loadedContextLength, resolveKeepAlive } from './ollamaResidency';

export interface ModelChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Base64-encoded image bytes for this message — the real Ollama `/api/chat`
   * multimodal `images` field (M36). Only ever populated on a `user` message,
   * and only after the stored bytes have been verified against their frozen
   * hash (core/runtime/executor.ts). Never a filesystem path. */
  images?: string[];
  /** MIME type of each entry in `images` (same order), from the verified attachment. OpenAI-compatible providers need it for the data URL. */
  imageMimeTypes?: string[];
}

/** A tool the model may call (Ollama /api/chat `tools` shape, function subset). */
export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool call the model requested. */
export interface ModelToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelChatRequest {
  model: string;
  messages: ModelChatMessage[];
  tools?: ModelToolDefinition[];
  signal?: AbortSignal;
  /**
   * Optional Ollama controls resolved from profile/model (or an explicit
   * experiment override). Omitted fields leave Ollama model defaults alone —
   * Core must not globally force num_ctx or think.
   */
  ollama?: {
    numCtx?: number;
    think?: boolean;
  };
  /**
   * The attempt's frozen context window and output reserve. Bounds an implicit
   * num_ctx (never above the model's window) and sets the reserve the
   * prompt-fit guard checks against. An explicit `ollama.numCtx` is unchanged.
   */
  contextBudget?: {
    maxContextTokens: number;
    outputReserveTokens: number;
  };
}

export interface ModelChatResult {
  /** The full assistant message text. */
  content: string;
  /** Tool calls the model requested this turn (empty for a final answer). */
  toolCalls: ModelToolCall[];
  /**
   * Why generation ended, as the provider reported it. `'length'` means the
   * output hit a token/context ceiling and is incomplete; absent when the
   * provider did not say. Never inferred.
   */
  finishReason?: 'stop' | 'length' | (string & {});
  /** Exact num_ctx / num_predict / think the backend put on the wire (Ollama only). Read from the payload, not the request. */
  sent?: OllamaSentValues;
  /** Provider that actually served the call (truth, not what was requested). */
  provider: string;
  /** Model that actually served the call. */
  model: string;
  usage: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    /** End-to-end wall time for the call, including queueing and prompt eval. */
    durationMs: number;
    /** Time the backend spent generating completion tokens, when it reports
     * it. Absent when unknown — never substitute `durationMs`, which would
     * understate the generation rate. */
    generationMs?: number | null;
    /** Time the backend spent evaluating the prompt, when it reports it. */
    promptEvalMs?: number | null;
    /** Time the backend spent loading the model into memory, when it reports it. */
    loadDurationMs?: number | null;
    /** Total end-to-end duration as reported by the backend itself, when available. */
    totalDurationMs?: number | null;
    /** Provider-reported billed USD. Null when unknown — never substitute estimates. */
    costUsd?: number | null;
    budgetState?: string;
    budgetReserveUsd?: number;
    /** Characters of hidden reasoning the backend streamed outside `content`, when it reports reasoning separately. */
    thinkingChars?: number;
  };
}

/**
 * Streams an assistant reply. `onToken` is called with each incremental text
 * delta as it arrives (best-effort live UX); the resolved `ModelChatResult` is
 * the durable source of truth. Must reject with an `AbortError`-named error
 * when `request.signal` aborts so the executor can classify cancellation.
 */
export interface ModelBackend {
  streamChat(request: ModelChatRequest, onToken: (delta: string) => void): Promise<ModelChatResult>;
}

export class ModelBackendError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ModelBackendError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/** Bounded backoff (ms) between retries of a transient (5xx) /api/chat dispatch failure. Two retries = three total attempts. */
const OLLAMA_TRANSIENT_RETRY_BACKOFF_MS = [300, 800];

const ERROR_BODY_READ_CHAR_LIMIT = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort, bounded read of a failed /api/chat response body for
 * diagnostics — Ollama's own error payload (e.g. `{"error":"model requires
 * more system memory..."}`) is genuinely useful for telling a real failure
 * apart from a transient one, but must never block indefinitely or grow
 * unbounded (the connection is being destroyed either way once this
 * returns). Never throws — a malformed or unreadable body just yields ''.
 */
async function readBoundedErrorBody(streamed: Awaited<ReturnType<typeof streamOllamaChatNdjson>>): Promise<string> {
  let snippet = '';
  try {
    for await (const frame of streamed.lines) {
      snippet = JSON.stringify(frame);
      break;
    }
  } catch {
    /* best-effort only */
  } finally {
    streamed.destroy();
  }
  return snippet.slice(0, ERROR_BODY_READ_CHAR_LIMIT);
}

/**
 * Strict chat templates (e.g. the qwen3-coder family's Jinja template) accept
 * exactly ONE system message, at index 0, and answer anything else with
 * `500 "System message must be at the beginning"`. Core composes several system
 * messages (base prompt, continuity brief, retry guidance, corrective notes), so
 * normalise them for every Ollama model: merge the leading system messages into
 * one, and present any later system message as a labelled user note.
 */
export function normalizeSystemMessagesForOllama(messages: ModelChatMessage[]): ModelChatMessage[] {
  let index = 0;
  const leading: string[] = [];
  while (index < messages.length && messages[index].role === 'system') {
    leading.push(messages[index].content);
    index += 1;
  }
  const out: ModelChatMessage[] = leading.length ? [{ role: 'system', content: leading.join('\n\n') }] : [];
  for (; index < messages.length; index += 1) {
    const message = messages[index];
    out.push(message.role === 'system' ? { ...message, role: 'user', content: `[System note] ${message.content}` } : message);
  }
  return out;
}

/** Real Ollama chat backend running inside the Core process. */
export class OllamaModelBackend implements ModelBackend {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  }

  async streamChat(request: ModelChatRequest, onToken: (delta: string) => void): Promise<ModelChatResult> {
    if (request.signal?.aborted) throw abortError();
    const startedAt = Date.now();
    const implicitNumCtx = resolveImplicitNumCtx({
      messages: request.messages,
      tools: request.tools,
      numCtx: request.ollama?.numCtx,
      outputReserveTokens: request.contextBudget?.outputReserveTokens,
      maxContextTokens: request.contextBudget?.maxContextTokens,
    });
    // Ollama reloads the runner whenever num_ctx differs from the loaded one, so an implicit window adopts the loaded one when it already fits.
    const numCtx = request.ollama?.numCtx != null
      ? implicitNumCtx
      : adoptLoadedContext(implicitNumCtx, OLLAMA_ASSUMED_DEFAULT_NUM_CTX, await loadedContextLength(request.model, { baseUrl: this.baseUrl, signal: request.signal }), request.contextBudget?.maxContextTokens);
    try {
      assertPromptFitsContext({
        messages: request.messages,
        tools: request.tools,
        numCtx,
        // Only the implicit window is sized against the real output reserve;
        // an explicit profile/env num_ctx keeps its own default reserve.
        ...(request.ollama?.numCtx == null && request.contextBudget
          ? { outputReserve: request.contextBudget.outputReserveTokens }
          : {}),
      });
    } catch (err) {
      throw new ModelBackendError(
        err instanceof Error ? err.message : String(err),
        'prompt_exceeds_context',
      );
    }
    const controls = ollamaPayloadControls({
      numCtx,
      think: request.ollama?.think,
    });
    const sampling = benchmarkSamplingOptions();
    const payload = {
      model: request.model,
      messages: normalizeSystemMessagesForOllama(request.messages).map((m) => (m.images && m.images.length > 0 ? { role: m.role, content: m.content, images: m.images } : { role: m.role, content: m.content })),
      stream: true,
      keep_alive: resolveKeepAlive(),
      ...controls,
      ...(Object.keys(sampling).length ? { options: { ...controls.options, ...sampling } } : {}),
      ...(request.tools && request.tools.length
        ? { tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    };

    const sent = sentValuesFromPayload(payload);
    let attemptResult: Awaited<ReturnType<typeof streamOllamaChatNdjson>> | undefined;
    // A 5xx from /api/chat before any content is a transient backend
    // condition just as often as a real failure — Ollama returning 500 while
    // it's mid-load/mid-eviction of a model another request is also using is
    // routine, not a model-capability finding. Bounded retry here (never for
    // a genuine client-side error like 404 model-not-found) avoids failing an
    // otherwise-healthy attempt on a blip, while still failing fast and
    // loudly once the budget is exhausted.
    for (let attempt = 0; ; attempt++) {
      console.log(`[karkedikha-core ${new Date().toISOString()}] model=${request.model} stage=ollama_dispatch attempt=${attempt + 1} num_ctx=${sent.numCtx ?? 'default'} num_predict=${sent.numPredict ?? 'default'} think=${sent.think ?? 'default'}`);
      try {
        attemptResult = await streamOllamaChatNdjson({
          baseUrl: this.baseUrl,
          body: payload,
          signal: request.signal,
        });
      } catch (err) {
        if (isAbortError(err) || request.signal?.aborted) throw abortError();
        if (isOllamaStreamTransportTermination(err)) {
          throw new ModelBackendError(
            `Ollama stream transport closed before completion (${describe(err)}); not classified as model weakness`,
            'model_stream_error',
          );
        }
        throw new ModelBackendError(`Ollama request failed: ${describe(err)}`, 'model_unreachable');
      }

      if (attemptResult.statusCode >= 200 && attemptResult.statusCode < 300) break;

      const bodySnippet = await readBoundedErrorBody(attemptResult);
      console.error(
        `[karkedikha-core ${new Date().toISOString()}] model=${request.model} stage=ollama_http_error `
        + `endpoint=${this.baseUrl}/api/chat status=${attemptResult.statusCode} attempt=${attempt + 1} body=${JSON.stringify(bodySnippet)}`,
      );

      // A 4xx the provider words as "this model cannot do that" is a pre-mutation capability/protocol failure of the
      // MODEL, not a transport fault: name it explicitly so Auto can reroute and Manual shows the incompatibility.
      if (attemptResult.statusCode >= 400 && attemptResult.statusCode < 500 && CAPABILITY_UNSUPPORTED_PATTERN.test(bodySnippet)) {
        throw new ModelBackendError(
          `model_capability_unsupported: '${request.model}' cannot serve this request (Ollama responded ${attemptResult.statusCode}${bodySnippet ? `: ${bodySnippet}` : ''})`,
          'model_capability_unsupported',
        );
      }

      const transient = attemptResult.statusCode >= 500 && attemptResult.statusCode < 600;
      if (!transient || attempt >= OLLAMA_TRANSIENT_RETRY_BACKOFF_MS.length) {
        throw new ModelBackendError(
          `Ollama responded ${attemptResult.statusCode}${bodySnippet ? `: ${bodySnippet}` : ''}`,
          'model_http_error',
        );
      }
      if (request.signal?.aborted) throw abortError();
      await sleep(OLLAMA_TRANSIENT_RETRY_BACKOFF_MS[attempt]);
      if (request.signal?.aborted) throw abortError();
    }
    const streamed = attemptResult!;

    let content = '';
    let actualModel = request.model;
    let promptTokens: number | null | undefined;
    let completionTokens: number | null | undefined;
    let generationMs: number | null = null;
    let promptEvalMs: number | null = null;
    let loadDurationMs: number | null = null;
    let totalDurationMs: number | null = null;
    let finishReason: string | undefined;
    let thinkingChars = 0;
    const toolCalls: ModelToolCall[] = [];
    let firstChunkRawLogged = false;

    try {
      for await (const raw of streamed.lines) {
        if (request.signal?.aborted) throw abortError();
        const frame = raw && typeof raw === 'object' ? (raw as OllamaFrame) : null;
        if (!frame) continue;
        if (typeof frame.model === 'string') actualModel = frame.model;
        if (frame.message && typeof frame.message.thinking === 'string') thinkingChars += frame.message.thinking.length;
        const delta = frame.message && typeof frame.message.content === 'string' ? frame.message.content : '';
        if (delta) {
          if (!firstChunkRawLogged) {
            firstChunkRawLogged = true;
            console.log(`[karkedikha-core ${new Date().toISOString()}] model=${request.model} stage=ollama_first_chunk_raw`);
          }
          content += delta;
          onToken(delta);
        }
        for (const tc of frame.message?.tool_calls ?? []) {
          if (tc?.function?.name) {
            toolCalls.push({ name: tc.function.name, arguments: normalizeArgs(tc.function.arguments) });
          }
        }
        if (frame.done) {
          if (typeof frame.done_reason === 'string') finishReason = frame.done_reason;
          if (typeof frame.prompt_eval_count === 'number') promptTokens = frame.prompt_eval_count;
          if (typeof frame.eval_count === 'number') completionTokens = frame.eval_count;
          generationMs = nanosToMs(frame.eval_duration);
          promptEvalMs = nanosToMs(frame.prompt_eval_duration);
          loadDurationMs = nanosToMs(frame.load_duration);
          totalDurationMs = nanosToMs(frame.total_duration);
        }
      }
    } catch (err) {
      if (isAbortError(err) || request.signal?.aborted) throw abortError();
      if (isOllamaStreamTransportTermination(err)) {
        throw new ModelBackendError(
          `Ollama stream transport closed before completion (${describe(err)}); not classified as model weakness`,
          'model_stream_error',
        );
      }
      throw new ModelBackendError(`Ollama stream error: ${describe(err)}`, 'model_stream_error');
    } finally {
      streamed.destroy();
    }

    console.log(
      `[karkedikha-core ${new Date().toISOString()}] model=${actualModel} loadMs=${loadDurationMs ?? -1} promptEvalMs=${promptEvalMs ?? -1} `
      + `promptTokens=${promptTokens ?? -1} evalMs=${generationMs ?? -1} completionTokens=${completionTokens ?? -1} `
      + `totalMs=${totalDurationMs ?? -1}`,
    );

    return {
      content,
      toolCalls,
      ...(finishReason ? { finishReason } : {}),
      sent,
      provider: 'ollama',
      model: actualModel,
      usage: {
        promptTokens,
        completionTokens,
        durationMs: Date.now() - startedAt,
        generationMs,
        promptEvalMs,
        loadDurationMs,
        totalDurationMs,
        ...(thinkingChars > 0 ? { thinkingChars } : {}),
      },
    };
  }
}

interface OllamaToolCallFrame {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaFrame {
  model?: string;
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCallFrame[] };
  done?: boolean;
  /** 'stop' = natural end; 'length' = cut off at the token/context ceiling. */
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  /** Nanoseconds, per the Ollama /api/chat final frame. */
  eval_duration?: number;
  prompt_eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
}

function nanosToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value / 1e6 : null;
}

/**
 * Small local models (e.g. qwen2.5-coder:1.5b) frequently do NOT emit native
 * Ollama `tool_calls`; instead they print a JSON tool call as text content,
 * often inside a ```json fence. This best-effort fallback recovers a single
 * tool call from such content when — and only when — the content is essentially
 * just that one JSON object naming a known tool, so a genuine prose answer that
 * merely mentions JSON is never misread as a tool call.
 */
export function parseInlineToolCall(content: string, knownToolNames: string[]): ModelToolCall | null {
  let text = content.trim();
  const xmlCalls = [...text.matchAll(/<function=([A-Za-z0-9_]+)>\s*([\s\S]*?)<\/function>\s*(?:<\/tool_call>)?/gi)];
  if (xmlCalls.length > 0) {
    // Qwen-family models can print their native function protocol into
    // message.content instead of Ollama's structured tool_calls field. Accept
    // exactly one complete, known function block; ambiguity or malformed
    // parameter markup remains ordinary text and can never reach execution.
    if (xmlCalls.length !== 1) return null;
    const [, name, body] = xmlCalls[0];
    if (!knownToolNames.includes(name)) return null;
    const args: Record<string, unknown> = {};
    const parameters = [...body.matchAll(/<parameter=([A-Za-z0-9_]+)>\s*([\s\S]*?)<\/parameter>/gi)];
    for (const parameter of parameters) {
      const parameterName = parameter[1];
      if (Object.prototype.hasOwnProperty.call(args, parameterName)) return null;
      args[parameterName] = parameter[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    }
    const unparsedBody = body.replace(/<parameter=([A-Za-z0-9_]+)>\s*([\s\S]*?)<\/parameter>/gi, '').trim();
    if (unparsedBody || /<function=|<parameter=|<\/parameter>/i.test(text.replace(xmlCalls[0][0], ''))) return null;
    return { name, arguments: args };
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  // Accept {name, arguments} or {name, parameters} or {tool_call:{...}} shapes.
  const inner = (obj.tool_call && typeof obj.tool_call === 'object' ? (obj.tool_call as Record<string, unknown>) : obj);
  const name = inner.name ?? inner.tool;
  if (typeof name !== 'string' || !knownToolNames.includes(name)) return null;
  const args = normalizeArgs(inner.arguments ?? inner.parameters ?? {});
  return { name, arguments: args };
}

/**
 * Why `parseInlineToolCall` returned null for content that looks like a tool-call
 * attempt, for Golden/model-bench evidence. Returns null when the content does not
 * look like an attempt at all (ordinary prose) or when it parses fine.
 */
export function describeInlineToolCallFailure(content: string, knownToolNames: string[]): string | null {
  if (parseInlineToolCall(content, knownToolNames)) return null;
  let text = content.trim();
  const xmlCalls = [...text.matchAll(/<function=([A-Za-z0-9_]+)>\s*([\s\S]*?)<\/function>\s*(?:<\/tool_call>)?/gi)];
  if (xmlCalls.length > 1) return `multiple_tool_calls: ${xmlCalls.length} function blocks in one reply (only one is accepted)`;
  if (xmlCalls.length === 1) {
    return knownToolNames.includes(xmlCalls[0][1])
      ? 'malformed_function_block: duplicate or unparsed parameter markup, or text outside the function block'
      : `unknown_tool: '${xmlCalls[0][1]}'`;
  }
  if (/<function=/i.test(text)) return 'malformed_function_block: unterminated <function=...> block';
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return fence || /^\s*\{/.test(content) ? 'not_a_single_json_object: reply is not exactly one JSON object' : null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) { return `invalid_json: ${err instanceof Error ? err.message : String(err)}`; }
  if (!parsed || typeof parsed !== 'object') return 'not_a_json_object';
  const obj = parsed as Record<string, unknown>;
  const inner = (obj.tool_call && typeof obj.tool_call === 'object' ? (obj.tool_call as Record<string, unknown>) : obj);
  const name = inner.name ?? inner.tool;
  if (typeof name !== 'string') return 'no_tool_name: JSON object has no name/tool field';
  return knownToolNames.includes(name) ? 'unparsed' : `unknown_tool: '${name}'`;
}

/**
 * Inline/fallback recovery used by the executor: XML function blocks keep the strict single-call
 * parser; JSON replies go through the tolerant multi-call parser (M49.2). Never used for native calls.
 */
export function recoverInlineToolCalls(content: string, tools: ModelToolDefinition[]): InlineToolCallsResult {
  if (/<function=/i.test(content)) {
    const xml = parseInlineToolCall(content, tools.map((tool) => tool.name));
    return xml ? { kind: 'calls', calls: [xml] } : { kind: 'none' };
  }
  return parseInlineToolCalls(content, tools);
}

/** Ollama sends tool-call arguments as an object; some models emit a JSON string. */
function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* fall through */ }
  }
  return {};
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'ModelAbortError');
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
