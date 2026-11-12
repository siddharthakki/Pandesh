/**
 * Lightweight qualification of a free cloud model before it may join automatic routing.
 *
 * A small, fixed, reproducible suite (at most 7 short requests). Every prompt is synthetic public text written here;
 * no user data, file, memory or history is ever part of a qualification. The tool-call test sends one dummy tool
 * definition (`get_city_time`) that Pandesh never executes. The coding test is checked statically: generated code is
 * never run. It is started only by an explicit user action, never automatically, and stops at the first 429 so it
 * does not burn a free quota.
 *
 * Passing the basic test qualifies a model for plain chat only. Coding, tool calling, structured output and long
 * context each need their own pass: a model that can say "OK" is not thereby trusted with tools.
 */
import { redactSecrets } from '../platform/credentialStore';
import type { CloudProviderCredential } from './cloudCredentials';

export const QUALIFICATION_SUITE_VERSION = 'pandesh-qual-v1';

export type QualificationTestId = 'basic' | 'coding' | 'tool_call' | 'json' | 'context' | 'error_recovery' | 'rate_limit';
export type QualificationOutcome = 'pass' | 'fail' | 'error' | 'skipped' | 'rate_limited';

export interface QualificationTestResult {
  id: QualificationTestId;
  outcome: QualificationOutcome;
  latencyMs: number;
  httpStatus: number | null;
  detail: string;
}

export interface QualificationCapabilities { chat: boolean; coding: boolean; tools: boolean; structuredOutput: boolean; longContext: boolean }

export interface QualificationRecord {
  providerId: string;
  modelId: string;
  /** The model name the provider reported in its replies (its version as far as the API exposes one). */
  modelVersion?: string;
  suiteVersion: string;
  ranAt: string;
  results: QualificationTestResult[];
  capabilities: QualificationCapabilities;
  rateLimit: { limitRequests?: string; remainingRequests?: string; resetRequests?: string; retryAfter?: string };
  observedFailures: string[];
}

type FetchFn = typeof fetch;

export interface QualificationOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  now?: () => Date;
  /** Pause between requests so a 30-requests-per-minute free tier is never hit by the suite itself. */
  pauseMs?: number;
  only?: QualificationTestId[];
}

const CONTEXT_SECRET = 'BLUE-HERON-4721';

/** ~2,400 words of neutral filler with one code word in the middle: a cheap long-context recall check. */
function contextPrompt(): string {
  const sentence = 'The river carried leaves past the old mill while the town clock counted the afternoon hours. ';
  const filler = sentence.repeat(120);
  return `${filler}The code word for this document is ${CONTEXT_SECRET}. ${filler}\n\nWhat is the code word for this document? Reply with the code word only.`;
}

interface TestSpec {
  id: Exclude<QualificationTestId, 'rate_limit'>;
  body: (model: string) => Record<string, unknown>;
  check: (reply: ParsedReply) => { ok: boolean; detail: string };
}

interface ParsedReply {
  content: string;
  toolCalls: Array<{ name?: string; arguments?: string }>;
  model?: string;
}

function stripFences(text: string): string {
  return text.trim().replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/```\s*$/, '').trim();
}

export const QUALIFICATION_TESTS: readonly TestSpec[] = [
  {
    id: 'basic',
    body: (model) => ({ model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 16, temperature: 0 }),
    check: (r) => /\bok\b/i.test(r.content) ? { ok: true, detail: 'replied OK' } : { ok: false, detail: `unexpected reply: ${r.content.slice(0, 60)}` },
  },
  {
    id: 'coding',
    body: (model) => ({
      model,
      messages: [{ role: 'user', content: 'Write a JavaScript function named add that takes two numbers and returns their sum. Reply with only the code, no explanation.' }],
      max_tokens: 200,
      temperature: 0,
    }),
    check: (r) => {
      const code = stripFences(r.content);
      const defines = /\bfunction\s+add\s*\(|\b(const|let|var)\s+add\s*=/.test(code);
      const sums = /return\s+\(?\s*\w+\s*\+\s*\w+|=>\s*\(?\s*\w+\s*\+\s*\w+/.test(code);
      return defines && sums ? { ok: true, detail: 'defined add(a, b) returning a sum (checked statically, not executed)' } : { ok: false, detail: 'did not produce a recognisable add function' };
    },
  },
  {
    id: 'tool_call',
    body: (model) => ({
      model,
      messages: [{ role: 'user', content: 'What time is it in Paris right now? Use the provided tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_city_time',
          description: 'Returns the current local time in a city.',
          parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'], additionalProperties: false },
        },
      }],
      tool_choice: 'auto',
      max_tokens: 120,
      temperature: 0,
    }),
    check: (r) => {
      const call = r.toolCalls[0];
      if (!call) return { ok: false, detail: 'no tool call returned' };
      if (call.name !== 'get_city_time') return { ok: false, detail: `called an unknown tool: ${String(call.name).slice(0, 40)}` };
      try {
        const args = JSON.parse(call.arguments ?? '') as { city?: unknown };
        if (typeof args.city === 'string' && /paris/i.test(args.city)) return { ok: true, detail: 'schema-valid call get_city_time({city:"Paris"})' };
        return { ok: false, detail: 'arguments did not match the schema' };
      } catch {
        return { ok: false, detail: 'tool arguments were not valid JSON' };
      }
    },
  },
  {
    id: 'json',
    body: (model) => ({
      model,
      messages: [{ role: 'user', content: 'Return a JSON object with exactly two keys: "name" set to the string "Pandesh" and "count" set to the number 3. Reply with the JSON only.' }],
      response_format: { type: 'json_object' },
      max_tokens: 60,
      temperature: 0,
    }),
    check: (r) => {
      try {
        const parsed = JSON.parse(stripFences(r.content)) as Record<string, unknown>;
        return parsed.name === 'Pandesh' && parsed.count === 3 ? { ok: true, detail: 'valid JSON with the requested values' } : { ok: false, detail: 'JSON did not have the requested values' };
      } catch {
        return { ok: false, detail: 'reply was not valid JSON' };
      }
    },
  },
  {
    id: 'context',
    body: (model) => ({ model, messages: [{ role: 'user', content: contextPrompt() }], max_tokens: 20, temperature: 0 }),
    check: (r) => r.content.includes(CONTEXT_SECRET) ? { ok: true, detail: 'recalled the code word from a ~3k-token prompt' } : { ok: false, detail: 'did not recall the code word' },
  },
  {
    id: 'error_recovery',
    body: () => ({ model: 'pandesh-qualification-nonexistent-model', messages: [{ role: 'user', content: 'OK?' }], max_tokens: 4 }),
    // Inverted: the provider must REFUSE cleanly (4xx with a body), not hang or 5xx. Checked in the runner.
    check: () => ({ ok: false, detail: 'the provider accepted an unknown model id' }),
  },
];

function parseReply(body: unknown): ParsedReply {
  const b = body as { model?: unknown; choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }> } }> } | null;
  const message = b?.choices?.[0]?.message;
  return {
    content: typeof message?.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message?.tool_calls)
      ? message!.tool_calls!.map(call => ({
        name: typeof call?.function?.name === 'string' ? call.function.name : undefined,
        arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : call?.function?.arguments !== undefined ? JSON.stringify(call.function.arguments) : undefined,
      }))
      : [],
    model: typeof b?.model === 'string' ? b.model.slice(0, 120) : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Runs the suite against one model. Never throws; the key never appears in any returned text. */
export async function qualifyModel(
  providerId: string,
  credential: CloudProviderCredential,
  modelId: string,
  options: QualificationOptions = {},
): Promise<QualificationRecord> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pauseMs = options.pauseMs ?? 2_500;
  const results: QualificationTestResult[] = [];
  const failures: string[] = [];
  const rateLimit: QualificationRecord['rateLimit'] = {};
  let modelVersion: string | undefined;
  let rateLimited = false;
  const tests = QUALIFICATION_TESTS.filter(test => !options.only || options.only.includes(test.id));

  for (const [index, test] of tests.entries()) {
    if (rateLimited) {
      results.push({ id: test.id, outcome: 'skipped', latencyMs: 0, httpStatus: null, detail: 'skipped after a 429 so the free quota is not used up' });
      continue;
    }
    if (index > 0 && pauseMs > 0) await sleep(pauseMs);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${credential.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...test.body(modelId), stream: false }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      for (const [field, header] of [['limitRequests', 'x-ratelimit-limit-requests'], ['remainingRequests', 'x-ratelimit-remaining-requests'], ['resetRequests', 'x-ratelimit-reset-requests'], ['retryAfter', 'retry-after']] as const) {
        const value = response.headers.get(header);
        if (value) rateLimit[field] = value.slice(0, 40);
      }
      const text = await response.text().catch(() => '');
      if (test.id === 'error_recovery') {
        const clean = response.status >= 400 && response.status < 500 && response.status !== 429;
        results.push({ id: test.id, outcome: clean ? 'pass' : response.status === 429 ? 'rate_limited' : 'fail', latencyMs, httpStatus: response.status, detail: clean ? `refused an unknown model cleanly (HTTP ${response.status})` : `unexpected HTTP ${response.status} for an unknown model` });
        if (response.status === 429) rateLimited = true;
        continue;
      }
      if (response.status === 429) {
        rateLimited = true;
        results.push({ id: test.id, outcome: 'rate_limited', latencyMs, httpStatus: 429, detail: `rate-limited${rateLimit.retryAfter ? ` (retry after ${rateLimit.retryAfter})` : ''}` });
        failures.push(`${test.id}: HTTP 429`);
        continue;
      }
      if (!response.ok) {
        const detail = redactSecrets(`HTTP ${response.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`, [credential.apiKey]);
        results.push({ id: test.id, outcome: 'error', latencyMs, httpStatus: response.status, detail });
        failures.push(`${test.id}: ${detail}`);
        continue;
      }
      let parsed: ParsedReply;
      try { parsed = parseReply(JSON.parse(text)); } catch { parsed = { content: '', toolCalls: [] }; }
      modelVersion ??= parsed.model;
      const verdict = test.check(parsed);
      results.push({ id: test.id, outcome: verdict.ok ? 'pass' : 'fail', latencyMs, httpStatus: response.status, detail: redactSecrets(verdict.detail, [credential.apiKey]) });
      if (!verdict.ok) failures.push(`${test.id}: ${verdict.detail}`);
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      const detail = name === 'AbortError' ? `no answer within ${timeoutMs} ms` : redactSecrets(error instanceof Error ? error.message : String(error), [credential.apiKey]);
      results.push({ id: test.id, outcome: 'error', latencyMs: Date.now() - started, httpStatus: null, detail });
      failures.push(`${test.id}: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const sawLimitHeaders = Boolean(rateLimit.limitRequests || rateLimit.remainingRequests || rateLimit.retryAfter);
  results.push({
    id: 'rate_limit',
    outcome: rateLimited ? (rateLimit.retryAfter ? 'pass' : 'fail') : 'pass',
    latencyMs: 0,
    httpStatus: null,
    detail: rateLimited
      ? rateLimit.retryAfter ? 'hit a 429 with a Retry-After header; the suite stopped' : 'hit a 429 without Retry-After; the suite stopped'
      : sawLimitHeaders ? 'no 429; the provider reports its limits in headers' : 'no 429; the provider does not report limits in headers',
  });
  const passed = (id: QualificationTestId) => results.some(result => result.id === id && result.outcome === 'pass');
  const chat = passed('basic');
  return {
    providerId,
    modelId,
    modelVersion,
    suiteVersion: QUALIFICATION_SUITE_VERSION,
    ranAt: now().toISOString(),
    results,
    capabilities: {
      chat,
      coding: chat && passed('coding'),
      tools: chat && passed('tool_call'),
      structuredOutput: chat && passed('json'),
      longContext: chat && passed('context'),
    },
    rateLimit,
    observedFailures: failures.slice(0, 20),
  };
}
