import { Agent, request as undiciRequest } from 'undici';

/**
 * Direct undici transport for Ollama chat requests.
 *
 * fetch()'s `dispatcher` option does NOT reliably honor per-request
 * headersTimeout on this runtime (Node v24.17.0 + undici 7.28.0) — proven by
 * both the Extension Host probe (scripts/acceptance/extensionHostTransportProbe.js)
 * and the standalone Extension Host test (src/test/suite/ollamaFetchDiagnostics.test.ts):
 * a request with headersTimeout:250 succeeded even when headers were delayed
 * past 250ms via fetch, while undici.request(...) correctly threw
 * HeadersTimeoutError / UND_ERR_HEADERS_TIMEOUT under the same conditions.
 *
 * This module never calls setGlobalDispatcher and never mutates global
 * undici state. Callers own a single reusable Agent (see OllamaProvider)
 * and pass it in explicitly per request.
 */

export interface OllamaTransportTimeouts {
  /** Max time to wait for response headers, in ms. */
  headersTimeoutMs: number;
  /** Max time to wait for the response body to complete, in ms. */
  bodyTimeoutMs: number;
  /** Max time to wait for the TCP connection to establish, in ms. */
  connectTimeoutMs?: number;
}

export interface OllamaTransportRequestOptions {
  baseUrl: string;
  path: string;
  body: unknown;
  signal?: AbortSignal;
  timeouts: OllamaTransportTimeouts;
  agent: Agent;
  /** Maximum total response bytes to read before aborting. Defaults to 64 MiB. */
  maxResponseBytes?: number;
}

export interface OllamaTransportTextResult {
  statusCode: number;
  text: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Creates the single reusable undici Agent an OllamaProvider instance owns. */
export function createOllamaAgent(timeouts: OllamaTransportTimeouts): Agent {
  return new Agent({
    headersTimeout: timeouts.headersTimeoutMs,
    bodyTimeout: timeouts.bodyTimeoutMs,
    connect: timeouts.connectTimeoutMs !== undefined ? { timeout: timeouts.connectTimeoutMs } : undefined,
  });
}

/** Response-size guard error, thrown when a response exceeds maxResponseBytes. */
export class OllamaResponseTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`Ollama response exceeded the ${limitBytes}-byte cap`);
    this.name = 'OllamaResponseTooLargeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Sends a non-streaming JSON POST via direct undici.request and returns the
 * raw response text (status code + body text). Callers decide how/whether
 * to JSON.parse — error bodies are not guaranteed to be JSON. The response
 * body is always drained/destroyed.
 */
export async function postJson(options: OllamaTransportRequestOptions): Promise<OllamaTransportTextResult> {
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const { statusCode, body } = await ollamaRequest(options);
  try {
    const text = await readBoundedText(body, maxBytes);
    return { statusCode, text };
  } finally {
    // Ensure the body is always drained/destroyed, even on read error.
    body.destroy();
  }
}

export interface OllamaTransportBody {
  destroy: (error?: Error) => void;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

export interface OllamaTransportRawResult {
  statusCode: number;
  body: OllamaTransportBody;
}

/**
 * Sends a POST via direct undici.request and returns the raw status code
 * plus the response body stream. Callers must always drain/destroy the body
 * (via readBoundedText or ndjsonLines below, or explicit body.destroy()).
 */
export async function ollamaRequest(options: OllamaTransportRequestOptions): Promise<OllamaTransportRawResult> {
  const { baseUrl, path, body, signal, timeouts, agent } = options;
  const response = await undiciRequest(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    dispatcher: agent,
    headersTimeout: timeouts.headersTimeoutMs,
    bodyTimeout: timeouts.bodyTimeoutMs,
  });
  return { statusCode: response.statusCode, body: response.body };
}

/**
 * Sends a streaming JSON POST via direct undici.request and returns an async
 * iterable of parsed NDJSON lines. The response body is destroyed when the
 * caller breaks early, the signal aborts, or the stream ends/errors.
 */
export async function postNdjsonStream(
  options: OllamaTransportRequestOptions,
): Promise<{ statusCode: number; lines: AsyncIterable<unknown>; destroy: (error?: Error) => void }> {
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const { statusCode, body } = await ollamaRequest(options);
  return { statusCode, lines: ndjsonLines(body, maxBytes), destroy: (e) => body.destroy(e) };
}

export async function* ndjsonLines(
  body: OllamaTransportBody,
  maxBytes: number,
): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  let destroyed = false;
  try {
    for await (const chunk of body) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        throw new OllamaResponseTooLargeError(maxBytes);
      }
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          yield JSON.parse(trimmed);
        } catch {
          // Ignore malformed NDJSON lines, matching prior fetch-based behavior.
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch { /* ignore malformed tail */ }
    }
  } finally {
    if (!destroyed) {
      destroyed = true;
      body.destroy();
    }
  }
}

export async function readBoundedText(
  body: OllamaTransportBody,
  maxBytes: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new OllamaResponseTooLargeError(maxBytes);
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}
