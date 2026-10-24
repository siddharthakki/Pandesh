import { OllamaMessage, OllamaResponse, ToolDefinition, ToolCall } from '../tools/ToolTypes';
import { Config } from '../config/Config';

export class OllamaClient {
  async chat(
    messages: OllamaMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    modelOverride?: string,
  ): Promise<OllamaResponse> {
    const apiBase = Config.getApiBase();
    const hasImages = messages.some((m) => m.images && m.images.length > 0);
    const model = modelOverride || Config.getModel();
    const url = `${apiBase}/api/chat`;

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: { num_ctx: hasImages ? 16384 : 8192 },
    };
    // Omit tools entirely for vision requests — sending tools:[] confuses vision models
    if (tools.length > 0) {
      body['tools'] = tools;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('Failed to fetch')) {
        throw new Error(
          `Cannot connect to Ollama at ${apiBase}. Make sure Ollama is running: https://ollama.com`,
        );
      }
      throw new Error(`Ollama request failed: ${msg}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 404 && text.includes('model')) {
        throw new Error(
          `Model "${model}" not found. Run: ollama pull ${model}`,
        );
      }
      throw new Error(`Ollama returned HTTP ${response.status}: ${text}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error('Ollama returned non-JSON response');
    }

    return this.normalize(json);
  }

  private normalize(raw: unknown): OllamaResponse {
    const r = raw as Record<string, unknown>;
    const msg = r['message'] as Record<string, unknown> | undefined;
    if (!msg) {
      throw new Error('Ollama response missing "message" field');
    }

    let toolCalls = this.normalizeToolCalls(msg['tool_calls']);
    const rawContent = String(msg['content'] ?? '');

    // Some models (qwen2.5-coder, llama3.1) embed tool calls as JSON text in content
    // instead of — or in addition to — the tool_calls field.
    let displayContent = rawContent;
    if (toolCalls.length === 0 && rawContent.trim()) {
      const { calls, textContent } = this.extractToolCalls(rawContent);
      if (calls.length > 0) {
        toolCalls = calls;
        displayContent = textContent;
      }
    }

    return {
      message: {
        role: (msg['role'] as OllamaMessage['role']) ?? 'assistant',
        // Preserve explanatory text even when tool calls were extracted
        content: displayContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      done: Boolean(r['done'] ?? true),
    };
  }

  /**
   * Extracts tool calls from content that may be:
   *   1. Pure JSON: `{"name":"read_file","arguments":{...}}`
   *   2. JSON array: `[{"name":"read_file",...}, ...]`
   *   3. Multiple JSON objects on separate lines (one per line)
   *   4. Mixed prose + JSON: "I'll read the file:\n{\"name\":...}"
   *
   * Returns both the extracted calls and the content with JSON lines stripped,
   * so the UI can show the explanatory prose without the raw JSON.
   */
  private extractToolCalls(content: string): { calls: ToolCall[]; textContent: string } {
    // Pass 1: try each line as a standalone JSON value
    const lines = content.split('\n');
    const calls: ToolCall[] = [];
    const keptLines: string[] = [];

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const parsed = JSON.parse(t);
          const extracted = this.callsFromParsed(parsed);
          if (extracted.length > 0) {
            calls.push(...extracted);
            continue; // drop this line from display
          }
        } catch { /* not valid JSON — fall through */ }
      }
      keptLines.push(line);
    }

    if (calls.length > 0) {
      return { calls, textContent: keptLines.join('\n').trimEnd() };
    }

    // Pass 2: try the whole trimmed content as a single JSON value
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const extracted = this.callsFromParsed(parsed);
        if (extracted.length > 0) {
          return { calls: extracted, textContent: '' };
        }
      } catch { /* not valid JSON */ }
    }

    return { calls: [], textContent: content };
  }

  private callsFromParsed(parsed: unknown): ToolCall[] {
    if (Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>[])
        .filter((item) => typeof item['name'] === 'string')
        .map((item) => ({
          function: {
            name: item['name'] as string,
            arguments: this.normalizeArgs(item['arguments'] ?? item['parameters']),
          },
        }));
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj['name'] === 'string') {
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

  private normalizeToolCalls(raw: unknown): ToolCall[] {
    if (!Array.isArray(raw)) { return []; }
    const calls: ToolCall[] = [];

    for (const item of raw) {
      const fn = (item as Record<string, unknown>)['function'] as Record<string, unknown> | undefined;
      if (!fn) { continue; }

      let args: Record<string, unknown> = {};
      const rawArgs = fn['arguments'];
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); } catch { args = {}; }
      } else if (rawArgs && typeof rawArgs === 'object') {
        args = rawArgs as Record<string, unknown>;
      }

      calls.push({
        function: {
          name: String(fn['name'] ?? ''),
          arguments: args,
        },
      });
    }
    return calls;
  }
}
