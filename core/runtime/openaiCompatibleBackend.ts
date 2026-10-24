/**
 * Core-native OpenAI-compatible chat backend (OpenRouter /v1/chat/completions).
 * Do not import extension-host ChatMessage types.
 *
 * OpenRouter (2026 docs): streaming usage including `usage.cost` arrives in the
 * final SSE chunk before `[DONE]`; do not stop at the first finish_reason chunk.
 */
import {
  isAbortError,
  ModelBackendError,
  type ModelBackend,
  type ModelChatMessage,
  type ModelChatRequest,
  type ModelChatResult,
  type ModelToolCall,
  type ModelToolDefinition,
} from './modelBackend';
import { CostGuard, compactForCloud } from '../platform/cloudSkills';

export const OPENROUTER_OFFICIAL_API_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_API_KEY_ENV = 'KARKEDIKHA_OPENROUTER_API_KEY';

export function openaiCompatibleApiUrl(baseUrl: string, apiPath: string): string {
  const base = baseUrl.replace(/\/$/, '');
  const trimmed = apiPath.replace(/^\//, '');
  // A base that already names its API version (/v1, Gemini's /v1beta/openai, a bare /openai) is used as given.
  return /\/(v\d+[a-z]*\d*(\/openai)?|openai)$/i.test(base) ? `${base}/${trimmed}` : `${base}/v1/${trimmed}`;
}

export interface OpenAICompatibleBackendOptions {
  baseUrl: string;
  apiKey: string;
  provider?: string;
  /** Human label used in error messages (defaults to OpenRouter). Never carries credentials. */
  label?: string;
  fetchFn?: typeof fetch;
  /**
   * Cloud pool only: apply the host-side `cloud-token-budget` skill (dedupe, trim old turns) when the attempt froze a
   * context budget, and enforce the `cloud-cost-guard` per-attempt request/token ceiling. Off for legacy callers.
   */
  cloudSkills?: { costGuard: CostGuard };
}

interface StreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Record<string, unknown>;
}

export class OpenAICompatibleModelBackend implements ModelBackend {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly provider: string;
  private readonly label: string;
  private readonly fetchFn: typeof fetch;
  private readonly cloudSkills?: { costGuard: CostGuard };

  constructor(options: OpenAICompatibleBackendOptions) {
    this.cloudSkills = options.cloudSkills;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.provider = options.provider ?? 'openrouter';
    this.label = options.label ?? 'OpenRouter';
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async streamChat(request: ModelChatRequest, onToken: (delta: string) => void): Promise<ModelChatResult> {
    if (request.signal?.aborted) throw abortError();
    const startedAt = Date.now();
    let outgoing: ModelChatMessage[] = request.messages;
    if (this.cloudSkills) {
      const gate = this.cloudSkills.costGuard.beforeRequest({ locality: 'cloud', freeness: 'free', displayName: request.model, providerName: this.label });
      if (!gate.allow) throw new ModelBackendError(gate.reason, 'cloud_task_limit');
      if (request.contextBudget) {
        outgoing = compactForCloud(request.messages, {
          maxContextTokens: request.contextBudget.maxContextTokens,
          outputReserveTokens: request.contextBudget.outputReserveTokens,
        }).messages as ModelChatMessage[];
      }
    }
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(outgoing),
      stream: true,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map(toOpenAITool);
      body.tool_choice = 'auto';
    }

    let response: Response;
    try {
      response = await this.fetchFn(openaiCompatibleApiUrl(this.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ModelBackendError(`${this.label} request failed: ${describe(err)}`, 'model_unreachable');
    }

    if (response.status === 401 || response.status === 403) {
      throw new ModelBackendError(`${this.label} authentication failed`, 'model_auth_error');
    }
    if (response.status === 429 || response.status === 402) {
      // A quota / rate-limit / out-of-credit answer is not a bug: the host's free pool uses it to move on to another provider.
      throw new ModelBackendError(`${this.label} quota or rate limit reached (HTTP ${response.status})`, 'model_quota_exhausted');
    }
    if (!response.ok || !response.body) {
      throw new ModelBackendError(`${this.label} responded ${response.status}`, 'model_http_error');
    }

    let content = '';
    let actualModel = request.model;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let costUsd: number | null = null;
    let finishReason: string | undefined;
    const toolCallAccum = new Map<number, { id: string; name: string; argsRaw: string }>();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(trimmed.slice(6)) as StreamChunk;
          } catch {
            continue;
          }
          if (typeof chunk.model === 'string' && chunk.model) actualModel = chunk.model;
          const usage = readUsage(chunk.usage);
          if (usage.promptTokens !== null) promptTokens = usage.promptTokens;
          if (usage.completionTokens !== null) completionTokens = usage.completionTokens;
          if (usage.costUsd !== null) costUsd = usage.costUsd;

          const reported = chunk.choices?.[0]?.finish_reason;
          if (typeof reported === 'string' && reported) finishReason = reported;
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            content += delta.content;
            onToken(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: tc.id ?? `call_${idx}`, name: '', argsRaw: '' });
            }
            const acc = toolCallAccum.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.argsRaw += tc.function.arguments;
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ModelBackendError(`${this.label} stream error: ${describe(err)}`, 'model_stream_error');
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }

    const toolCalls: ModelToolCall[] = [...toolCallAccum.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({ name: acc.name, arguments: parseArgs(acc.argsRaw) }))
      .filter((call) => call.name);

    this.cloudSkills?.costGuard.afterResponse({ promptTokens, completionTokens });
    return {
      content,
      toolCalls,
      ...(finishReason ? { finishReason } : {}),
      provider: this.provider,
      model: actualModel,
      usage: {
        promptTokens,
        completionTokens,
        durationMs: Date.now() - startedAt,
        costUsd,
      },
    };
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}

function toOpenAITool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function toOpenAIMessages(messages: ModelChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'user', content: `Tool observation:\n${message.content}` };
    }
    if (message.role === 'user' && message.images?.length) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: message.content },
          ...message.images.map((img, index) => ({
            type: 'image_url',
            // The real type of the verified attachment (PNG/GIF/WebP are common); jpeg only when none was recorded.
            image_url: { url: `data:${message.imageMimeTypes?.[index] ?? 'image/jpeg'};base64,${img}` },
          })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

function readUsage(usage: Record<string, unknown> | undefined): {
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
} {
  if (!usage) return { promptTokens: null, completionTokens: null, costUsd: null };
  return {
    promptTokens: numberOrNull(usage.prompt_tokens ?? usage.promptTokens),
    completionTokens: numberOrNull(usage.completion_tokens ?? usage.completionTokens),
    costUsd: numberOrNull(usage.cost ?? usage.total_cost ?? usage.cost_usd),
  };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* empty */ }
  return {};
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
