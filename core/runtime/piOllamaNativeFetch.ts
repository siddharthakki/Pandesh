/**
 * Native Ollama transport for Pi.
 *
 * Pi speaks the OpenAI chat-completions protocol. Ollama's /v1 endpoint cannot carry `num_ctx`, so every Pi
 * request loaded the model at the machine default (OLLAMA_CONTEXT_LENGTH, e.g. 65536 x OLLAMA_NUM_PARALLEL slots),
 * and /v1 also leaves thinking on for thinking models. Measured on an RTX 3090 with gemma4 26B (Q4): at the 64K
 * default the KV cache spilled out of VRAM (45 tok/s prompt eval, 3-7 tok/s generation, ~300 s for a 13K-token
 * prompt); at 32K the same request took 3.6 s (4,300 tok/s prompt eval, ~110 tok/s generation).
 *
 * This fetch is handed to Pi's OpenAI client. It rewrites POST .../chat/completions into a native /api/chat
 * request with an explicit num_ctx, think and keep_alive, and re-emits Ollama's NDJSON stream as OpenAI SSE
 * chunks, so Pi's parser, tools and Agent loop are unchanged. Every other request goes to the real fetch.
 */
import { resolveKeepAlive } from './ollamaResidency';
import { streamOllamaChatNdjson } from './ollamaStreamTransport';
import { parseInlineToolCalls } from './inlineToolCalls';
import type { ModelToolDefinition } from './modelBackend';

/** One model call as Ollama measured it, plus what Core sent. Durations are milliseconds. */
export interface OllamaCallMetrics {
  model: string;
  numCtx: number;
  think: boolean | string;
  promptTokens: number;
  promptMs: number;
  outputTokens: number;
  generationMs: number;
  loadMs: number;
  /** Request sent to first streamed token (content, thinking or tool call). */
  firstTokenMs: number | null;
  totalMs: number;
  thinkingChars: number;
  toolCalls: number;
  /** Tool calls the model wrote as JSON text that were recovered into real calls (Build 161 audit). */
  inlineToolCallsRecovered?: number;
  /** Identical calls (same tool, same arguments) repeated within this one response and dropped. */
  duplicateToolCallsDropped?: number;
  /** Set when the response hit the per-response tool-call limit: generation was stopped there. */
  toolCallLimitHit?: number;
  /** Raw chat-template control tokens (e.g. <|tool_response>) removed from the reply text. */
  controlTokensRemoved?: number;
  messages: number;
  toolDefinitions: number;
  /** Characters sent by section: what the prompt budget is spent on. */
  chars: { system: number; history: number; tools: number };
  status: 'ok' | 'error' | 'aborted';
  error?: string;
}

export interface PiOllamaFetchOptions {
  /** Ollama root, without /v1. */
  baseUrl: string;
  /** Context window for this call; may grow with the request. */
  numCtx: (estimatedPromptTokens: number) => number;
  /** Used when the request carries no reasoning_effort. */
  think: boolean;
  onMetrics?: (metrics: OllamaCallMetrics) => void;
  /**
   * A call that has produced no output at all after this long (model load and prompt evaluation included) is stopped.
   * Default 300 s, or PANDESH_MODEL_FIRST_OUTPUT_TIMEOUT_MS.
   */
  firstOutputTimeoutMs?: number;
  /** A reply that stops streaming for this long is stopped. Default 120 s, or PANDESH_MODEL_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /**
   * Most distinct tool calls one model response may carry; generation stops at the limit. Default 12, or
   * PANDESH_MAX_TOOL_CALLS_PER_RESPONSE. Micro-test RAD-020: gemma4:12b looped one call 875 times in a single
   * 12,288-token response and Core ran all of them (199 s); FIN-007 did the same with 372 calls.
   */
  maxToolCallsPerResponse?: number;
}

/** Chat-template control tokens that must never reach the user (FIN-007 showed '<|tool_response>' as the reply). */
const CONTROL_TOKEN = /<\|(?:tool_response|tool_call|tool_calls|im_start|im_end|start_of_turn|end_of_turn|eot_id|end|channel|message|return|call)\|?>/g;
export function stripControlTokens(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(CONTROL_TOKEN, () => { removed += 1; return ''; });
  return { text: out, removed };
}

/**
 * Build 161 audit: the transport disabled undici's timers so the attempt's AbortSignal would own deadlines, but a chat
 * turn's signal is aborted only by Stop — an Ollama that accepted a request and then hung kept the turn (and an
 * unattended scheduled model run) waiting forever. A stalled call now fails with this reason.
 */
export class ModelStalledError extends Error {
  readonly code = 'model_stalled';
  constructor(readonly silentMs: number, phase: 'first_output' | 'mid_reply') {
    super(`no output from Ollama for ${Math.round(silentMs / 1000)} s ${phase === 'first_output' ? 'after the request was sent' : 'in the middle of the reply'} (the model may be stuck or the machine overloaded); the call was stopped`);
    this.name = 'ModelStalledError';
  }
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type OpenAiPart = { type?: string; text?: string; image_url?: { url?: string } | string };
type OpenAiMessage = {
  role: string;
  content?: string | OpenAiPart[] | null;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
};

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** OpenAI chat messages to Ollama's native shape: text content, base64 images, object tool arguments, tool_name. */
export function toOllamaMessages(messages: OpenAiMessage[]): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>();
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role === 'developer' ? 'system' : m.role };
    if (Array.isArray(m.content)) {
      const images: string[] = [];
      out.content = m.content.map((part) => {
        if (part.type === 'text') return part.text ?? '';
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (url) images.push(url.replace(/^data:[^;]+;base64,/, ''));
        return '';
      }).filter(Boolean).join('\n');
      if (images.length) out.images = images;
    } else {
      out.content = m.content ?? '';
    }
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => {
        if (tc.id && tc.function?.name) toolNames.set(tc.id, tc.function.name);
        return { function: { name: tc.function?.name ?? '', arguments: parseArguments(tc.function?.arguments) } };
      });
    }
    if (m.role === 'tool' && m.tool_call_id) {
      out.tool_call_id = m.tool_call_id;
      const name = toolNames.get(m.tool_call_id);
      if (name) out.tool_name = name;
    }
    return out;
  });
}

function contentChars(m: OpenAiMessage): number {
  if (typeof m.content === 'string') return m.content.length;
  if (Array.isArray(m.content)) return m.content.reduce((n, p) => n + (p.text?.length ?? 0), 0);
  return 0;
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/**
 * True when the text is nothing but complete JSON objects or arrays (optionally inside one code fence): the reply IS
 * the call. A call followed by prose ("…} Then I will delete the old files") or cut off before its closing brace is
 * not (Build 161 audit: both were recovered, the second after a repair appended the missing brace).
 */
function onlyCompleteJsonValues(text: string): boolean {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let i = 0;
  let values = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (i >= body.length) break;
    if (body[i] !== '{' && body[i] !== '[') return false;
    let depth = 0;
    let inString = false;
    let closed = false;
    for (; i < body.length; i += 1) {
      const ch = body[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth += 1;
      else if ((ch === '}' || ch === ']') && --depth === 0) { i += 1; closed = true; break; }
    }
    if (!closed) return false;
    values += 1;
  }
  return values > 0;
}

/** A reply that is exactly one strict-JSON {"name", "arguments"} object (optionally in one code fence) naming an offered tool. */
function singleInlineCall(text: string, offered: ReadonlySet<string>): { name: string; arguments: Record<string, unknown> } | null {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown };
    if (typeof parsed.name !== 'string' || !offered.has(parsed.name)) return null;
    const args = parsed.arguments;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) return null;
    return { name: parsed.name, arguments: (args ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function createPiOllamaFetch(options: PiOllamaFetchOptions): typeof fetch {
  const passthrough = globalThis.fetch.bind(globalThis);
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\/chat\/completions(?:\?|$)/.test(url) || (init?.method ?? 'GET').toUpperCase() !== 'POST' || typeof init?.body !== 'string') {
      return passthrough(input, init);
    }
    const params = JSON.parse(init.body) as Record<string, any>;
    const messages = (params.messages ?? []) as OpenAiMessage[];
    const tools = Array.isArray(params.tools) ? params.tools : [];
    const offeredToolDefs: ModelToolDefinition[] = tools
      .map((t: { function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }) => ({ name: String(t.function?.name ?? ''), description: String(t.function?.description ?? ''), parameters: t.function?.parameters ?? { type: 'object' } }))
      .filter((t: ModelToolDefinition) => t.name);
    const offeredNames = new Set(offeredToolDefs.map((t) => t.name));
    const chars = {
      system: messages.filter((m) => m.role === 'system' || m.role === 'developer').reduce((n, m) => n + contentChars(m), 0),
      history: messages.filter((m) => m.role !== 'system' && m.role !== 'developer').reduce((n, m) => n + contentChars(m), 0),
      tools: tools.length ? JSON.stringify(tools).length : 0,
    };
    const numCtx = options.numCtx(Math.ceil((chars.system + chars.history + chars.tools) / 4));
    const effort = params.reasoning_effort;
    const think: boolean | string = effort === 'none' ? false : typeof effort === 'string' ? true : options.think;
    const ollamaOptions: Record<string, unknown> = { num_ctx: numCtx };
    const maxTokens = params.max_tokens ?? params.max_completion_tokens;
    if (typeof maxTokens === 'number') ollamaOptions.num_predict = maxTokens;
    for (const key of ['temperature', 'top_p', 'seed', 'stop'] as const) {
      if (params[key] != null) ollamaOptions[key] = params[key];
    }
    const body = {
      model: params.model,
      messages: toOllamaMessages(messages),
      ...(tools.length ? { tools } : {}),
      stream: true,
      think,
      keep_alive: resolveKeepAlive(),
      options: ollamaOptions,
    };

    const started = Date.now();
    const metrics: OllamaCallMetrics = {
      model: String(params.model), numCtx, think, promptTokens: 0, promptMs: 0, outputTokens: 0, generationMs: 0, loadMs: 0,
      firstTokenMs: null, totalMs: 0, thinkingChars: 0, toolCalls: 0, messages: messages.length, toolDefinitions: tools.length, chars, status: 'ok',
    };
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      metrics.totalMs = Date.now() - started;
      try { options.onMetrics?.(metrics); } catch { /* metrics never break a turn */ }
    };

    const firstOutputMs = options.firstOutputTimeoutMs ?? positiveEnv('PANDESH_MODEL_FIRST_OUTPUT_TIMEOUT_MS', 300_000);
    const idleMs = options.idleTimeoutMs ?? positiveEnv('PANDESH_MODEL_IDLE_TIMEOUT_MS', 120_000);
    let upstream: Awaited<ReturnType<typeof streamOllamaChatNdjson>>;
    try {
      // Ollama sends its response headers with the first streamed frame, after loading the model and reading the prompt.
      upstream = await streamOllamaChatNdjson({ baseUrl: options.baseUrl, body, signal: init.signal ?? undefined, headersTimeoutMs: firstOutputMs });
    } catch (err) {
      const stalled = (err as { code?: string })?.code === 'UND_ERR_HEADERS_TIMEOUT' ? new ModelStalledError(firstOutputMs, 'first_output') : null;
      metrics.status = init.signal?.aborted ? 'aborted' : 'error';
      metrics.error = stalled ? stalled.message : err instanceof Error ? err.message : String(err);
      report();
      throw stalled ?? err;
    }

    if (upstream.statusCode !== 200) {
      let message = `Ollama returned HTTP ${upstream.statusCode}`;
      for await (const line of upstream.lines) {
        const error = (line as { error?: unknown })?.error;
        if (error) message = String(error);
      }
      metrics.status = 'error';
      metrics.error = message;
      report();
      return new Response(JSON.stringify({ error: { message, type: 'ollama_error' } }), {
        status: upstream.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    }

    const id = `chatcmpl-${started.toString(36)}`;
    const created = Math.floor(started / 1000);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>) => sse({
      id, object: 'chat.completion.chunk', created, model: params.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    const encoder = new TextEncoder();
    let silence: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (text: string) => controller.enqueue(encoder.encode(text));
        const firstToken = () => { if (metrics.firstTokenMs == null) metrics.firstTokenMs = Date.now() - started; };
        const maxCalls = options.maxToolCallsPerResponse ?? positiveEnv('PANDESH_MAX_TOOL_CALLS_PER_RESPONSE', 12);
        const seenCalls = new Set<string>();
        let capped = false;
        /** Returns false once the response has reached its tool-call limit (the caller then stops reading). */
        const emitToolCall = (name: string, args: unknown): boolean => {
          const argText = typeof args === 'string' ? args : JSON.stringify(args ?? {});
          const key = `${name}\u0000${argText}`;
          if (seenCalls.has(key)) { metrics.duplicateToolCallsDropped = (metrics.duplicateToolCallsDropped ?? 0) + 1; return true; }
          if (metrics.toolCalls >= maxCalls) { capped = true; metrics.toolCallLimitHit = maxCalls; return false; }
          seenCalls.add(key);
          const index = metrics.toolCalls;
          metrics.toolCalls += 1;
          push(chunk({ tool_calls: [{ index, id: `call_${started.toString(36)}_${index}`, type: 'function', function: { name, arguments: argText } }] }));
          return true;
        };
        const cleanText = (text: string) => {
          const { text: out, removed } = stripControlTokens(text);
          if (removed) metrics.controlTokensRemoved = (metrics.controlTokensRemoved ?? 0) + removed;
          return out;
        };
        const inline: { mode: 'undecided' | 'holding' | 'streaming'; held: string } = { mode: 'undecided', held: '' };
        let sawDone = false;
        // Silence watchdog: until the first frame the whole first-output allowance applies, then the idle allowance.
        let stall: ModelStalledError | null = null;
        let sawFrame = false;
        const watch = () => {
          if (silence) clearTimeout(silence);
          const ms = sawFrame ? idleMs : Math.max(idleMs, firstOutputMs - (Date.now() - started));
          silence = setTimeout(() => {
            stall = new ModelStalledError(ms, sawFrame ? 'mid_reply' : 'first_output');
            upstream.destroy(stall);
          }, ms);
          silence.unref?.();
        };
        watch();
        try {
          read: for await (const raw of upstream.lines) {
            sawFrame = true;
            watch();
            const frame = raw as {
              error?: unknown; done?: boolean; done_reason?: string;
              message?: { content?: string; thinking?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
              prompt_eval_count?: number; prompt_eval_duration?: number; eval_count?: number; eval_duration?: number; load_duration?: number;
            };
            if (frame.error) throw new Error(String(frame.error));
            const msg = frame.message;
            if (msg?.thinking) {
              firstToken();
              metrics.thinkingChars += msg.thinking.length;
              push(chunk({ reasoning: msg.thinking }));
            }
            const content = msg?.content ? cleanText(msg.content) : '';
            if (msg?.content) firstToken();
            if (content) {
              // A reply that starts like a JSON object or a code fence may be a tool call written as text: hold it.
              if (inline.mode === 'undecided' && offeredToolDefs.length > 0) {
                inline.held += content;
                const lead = inline.held.trimStart();
                if (lead) inline.mode = lead.startsWith('{') || lead.startsWith('```') ? 'holding' : 'streaming';
                if (inline.mode === 'streaming') { push(chunk({ content: inline.held })); inline.held = ''; }
              } else if (inline.mode === 'holding') {
                inline.held += content;
              } else {
                push(chunk({ content }));
              }
            }
            for (const call of msg?.tool_calls ?? []) {
              firstToken();
              if (!emitToolCall(call.function?.name ?? '', call.function?.arguments ?? {})) break read;
            }
            if (frame.done) {
              if (inline.held) {
                // Build 161 audit: qwen2.5-coder:3b wrote correct calls as JSON text in 8 of 9 benchmark tasks; the
                // transport passed them on as prose, so nothing ran. Recovered only when the reply IS a call to an
                // offered tool and no native call came; anything else is released unchanged.
                // Never from a reply the token limit cut off, and only when the reply is nothing but the call(s).
                const recoverable = metrics.toolCalls === 0 && inline.mode === 'holding' && frame.done_reason !== 'length' && onlyCompleteJsonValues(inline.held);
                const recovered = recoverable ? parseInlineToolCalls(inline.held, offeredToolDefs) : { kind: 'none' as const };
                // A well-formed call to an offered tool that only lacks a required argument goes through like a native
                // call would: the agent loop's own argument validation tells the model what is missing so it can retry
                // (qwen2.5-coder:3b omitted create_reminder's title). Broken JSON or an unknown tool stays prose.
                const incomplete = recovered.kind === 'failure' && recovered.code === 'invalid_arguments' ? singleInlineCall(inline.held, offeredNames) : null;
                if (recovered.kind === 'calls' && recovered.calls.every((c) => offeredNames.has(c.name))) {
                  for (const call of recovered.calls) emitToolCall(call.name, call.arguments ?? {});
                  metrics.inlineToolCallsRecovered = recovered.calls.length;
                } else if (incomplete) {
                  emitToolCall(incomplete.name, incomplete.arguments);
                  metrics.inlineToolCallsRecovered = 1;
                } else {
                  push(chunk({ content: inline.held }));
                }
                inline.held = '';
              }
              sawDone = true;
              metrics.promptTokens = frame.prompt_eval_count ?? 0;
              metrics.promptMs = Math.round((frame.prompt_eval_duration ?? 0) / 1e6);
              metrics.outputTokens = frame.eval_count ?? 0;
              metrics.generationMs = Math.round((frame.eval_duration ?? 0) / 1e6);
              metrics.loadMs = Math.round((frame.load_duration ?? 0) / 1e6);
              const finish = metrics.toolCalls ? 'tool_calls' : frame.done_reason === 'length' ? 'length' : 'stop';
              push(chunk({}, finish, { prompt_tokens: metrics.promptTokens, completion_tokens: metrics.outputTokens, total_tokens: metrics.promptTokens + metrics.outputTokens }));
            }
          }
          // D8: a stream that ends without Ollama's final frame was cut (server stopped, connection lost),
          // not a finished reply; the turn must say the connection was lost, not "no reply".
          if (silence) clearTimeout(silence);
          if (capped && !sawDone) {
            // Stop the model right here: the rest of a looping response is only more of the same calls.
            upstream.destroy();
            sawDone = true;
            push(chunk({}, 'tool_calls'));
          }
          if (stall) throw stall;
          if (!sawDone && !init.signal?.aborted) throw new Error('the connection to Ollama closed before the reply finished');
          push('data: [DONE]\n\n');
          report();
          controller.close();
        } catch (err) {
          if (silence) clearTimeout(silence);
          const failure = stall ?? err;
          metrics.status = init.signal?.aborted ? 'aborted' : 'error';
          metrics.error = failure instanceof Error ? failure.message : String(failure);
          report();
          upstream.destroy();
          controller.error(failure);
        }
      },
      cancel() {
        if (silence) clearTimeout(silence);
        metrics.status = 'aborted';
        upstream.destroy();
        report();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}
