/**
 * Direct undici transport for Core → Ollama streaming chat.
 *
 * Global `fetch` uses undici defaults of headersTimeout/bodyTimeout = 300_000ms.
 * A silent Ollama stream (thinking / slow first token) is then closed with
 * TypeError("terminated") — observed as `Ollama stream error: terminated` with
 * durationMs ≈ 309s and no cancellationReason (footer smoke att_63059e63).
 *
 * fetch(dispatcher) does not reliably honor per-request timeout options on
 * this runtime (see src/providers/OllamaTransport.ts). Core therefore uses
 * undici.request with explicit bodyTimeout/headersTimeout: 0 and relies on
 * the attempt AbortSignal for cancellation and mission deadlines.
 */
import { Agent, request as undiciRequest } from 'undici';

/** Disable undici idle timers; AbortSignal owns attempt deadlines. */
export const CORE_OLLAMA_STREAM_TIMEOUTS = {
  headersTimeoutMs: 0,
  bodyTimeoutMs: 0,
} as const;

let sharedAgent: Agent | undefined;

export function getCoreOllamaStreamAgent(): Agent {
  if (!sharedAgent) {
    sharedAgent = new Agent({
      headersTimeout: CORE_OLLAMA_STREAM_TIMEOUTS.headersTimeoutMs,
      bodyTimeout: CORE_OLLAMA_STREAM_TIMEOUTS.bodyTimeoutMs,
    });
  }
  return sharedAgent;
}

/** Test helper — replace the shared agent (e.g. short bodyTimeout). */
export function setCoreOllamaStreamAgentForTests(agent: Agent | undefined): void {
  sharedAgent = agent;
}

export interface CoreOllamaStreamRequest {
  baseUrl: string;
  body: unknown;
  signal?: AbortSignal;
  agent?: Agent;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export interface CoreOllamaStreamResponse {
  statusCode: number;
  /** Async NDJSON frames (parsed objects). Caller must destroy on early exit. */
  lines: AsyncIterable<unknown>;
  destroy: (error?: Error) => void;
}

export async function streamOllamaChatNdjson(options: CoreOllamaStreamRequest): Promise<CoreOllamaStreamResponse> {
  const headersTimeout = options.headersTimeoutMs ?? CORE_OLLAMA_STREAM_TIMEOUTS.headersTimeoutMs;
  const bodyTimeout = options.bodyTimeoutMs ?? CORE_OLLAMA_STREAM_TIMEOUTS.bodyTimeoutMs;
  const agent = options.agent ?? getCoreOllamaStreamAgent();
  const response = await undiciRequest(`${options.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body),
    signal: options.signal,
    dispatcher: agent,
    headersTimeout,
    bodyTimeout,
  });

  const body = response.body;
  return {
    statusCode: response.statusCode,
    lines: ndjsonLines(body),
    destroy: (error?: Error) => {
      try {
        body.destroy(error);
      } catch {
        /* ignore */
      }
    },
  };
}

async function* ndjsonLines(body: AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void }): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          /* ignore malformed NDJSON line */
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      body.destroy?.();
    } catch {
      /* ignore */
    }
  }
}

/** True when undici/fetch closed the body (idle bodyTimeout or premature end). */
export function isOllamaStreamTransportTermination(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code;
  if (code === 'UND_ERR_BODY_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return true;
  if (typeof e.message === 'string' && /^terminated$/i.test(e.message.trim())) return true;
  if (e.name === 'TypeError' && typeof e.message === 'string' && /terminated/i.test(e.message)) return true;
  return false;
}
