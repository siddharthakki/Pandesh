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

    let upstream: Awaited<ReturnType<typeof streamOllamaChatNdjson>>;
    try {
      upstream = await streamOllamaChatNdjson({ baseUrl: options.baseUrl, body, signal: init.signal ?? undefined });
    } catch (err) {
      metrics.status = init.signal?.aborted ? 'aborted' : 'error';
      metrics.error = err instanceof Error ? err.message : String(err);
      report();
      throw err;
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
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (text: string) => controller.enqueue(encoder.encode(text));
        const firstToken = () => { if (metrics.firstTokenMs == null) metrics.firstTokenMs = Date.now() - started; };
        let sawDone = false;
        try {
          for await (const raw of upstream.lines) {
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
            if (msg?.content) {
              firstToken();
              push(chunk({ content: msg.content }));
            }
            for (const call of msg?.tool_calls ?? []) {
              firstToken();
              const index = metrics.toolCalls;
              metrics.toolCalls += 1;
              push(chunk({ tool_calls: [{ index, id: `call_${started.toString(36)}_${index}`, type: 'function', function: { name: call.function?.name ?? '', arguments: JSON.stringify(call.function?.arguments ?? {}) } }] }));
            }
            if (frame.done) {
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
          if (!sawDone && !init.signal?.aborted) throw new Error('the connection to Ollama closed before the reply finished');
          push('data: [DONE]\n\n');
          report();
          controller.close();
        } catch (err) {
          metrics.status = init.signal?.aborted ? 'aborted' : 'error';
          metrics.error = err instanceof Error ? err.message : String(err);
          report();
          upstream.destroy();
          controller.error(err);
        }
      },
      cancel() {
        metrics.status = 'aborted';
        upstream.destroy();
        report();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}
