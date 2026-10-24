import type {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderType,
  StreamEvent,
} from '../../providers/ProviderTypes';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

export interface CapturedRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  options: ProviderChatOptions;
}

/**
 * Scripted InferenceProvider for unit tests.
 *
 * `enqueue*` methods add to the shared response queue.
 * `enqueueStream` adds raw StreamEvent arrays for tests that need streaming-specific control.
 *
 * Both `chat` and `chatStream` consume the same queue in FIFO order.
 * `chatStream` converts a queued ChatResponse to token/tool_call/done events when no
 * dedicated stream fixture was enqueued for that slot.
 */
export class MockProvider implements InferenceProvider {
  readonly providerType: ProviderType = 'ollama';

  private queue: ChatResponse[] = [];
  private streamOverrides: Map<number, StreamEvent[]> = new Map();
  private callIndex = 0;

  capturedRequests: CapturedRequest[] = [];

  /** Optional runtime context metadata returned by getModelContextMetadata. */
  modelContextMetadata: ModelInfo | undefined;

  enqueue(response: ChatResponse): this {
    this.queue.push(response);
    return this;
  }

  enqueueText(content: string): this {
    return this.enqueue({ message: { role: 'assistant', content }, done: true });
  }

  enqueueToolCall(name: string, args: Record<string, unknown>, id?: string): this {
    return this.enqueue({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id, function: { name, arguments: args } }],
      },
      done: true,
    });
  }

  /** Enqueue a raw stream event sequence for the next chatStream call. */
  enqueueStream(events: StreamEvent[]): this {
    this.streamOverrides.set(this.queue.length, events);
    // Push a placeholder so callIndex stays in sync
    this.queue.push({ message: { role: 'assistant', content: '(stream override)' }, done: true });
    return this;
  }

  reset(): void {
    this.queue = [];
    this.streamOverrides.clear();
    this.callIndex = 0;
    this.capturedRequests = [];
  }

  async healthCheck(): Promise<void> {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ name: 'test-model' }];
  }

  async getModelContextMetadata(): Promise<ModelInfo | undefined> {
    return this.modelContextMetadata;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
  ): Promise<ChatResponse> {
    this.capturedRequests.push({ messages, tools, options });
    const resp = this.queue[this.callIndex++];
    if (resp) { return resp; }
    return { message: { role: 'assistant', content: '(mock done)' }, done: true };
  }

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
  ): AsyncIterable<StreamEvent> {
    this.capturedRequests.push({ messages, tools, options });
    const idx = this.callIndex++;

    // Use a dedicated stream override if one was registered for this slot
    const override = this.streamOverrides.get(idx);
    if (override) {
      for (const e of override) { yield e; }
      return;
    }

    // Convert the queued ChatResponse into stream events
    const resp = this.queue[idx];
    if (!resp) {
      yield { type: 'done', content: '(mock done)' };
      return;
    }

    const toolCalls = resp.message.tool_calls ?? [];
    if (toolCalls.length > 0) {
      for (let i = 0; i < toolCalls.length; i++) {
        yield { type: 'tool_call', index: i, toolCall: toolCalls[i] };
      }
      yield { type: 'done', content: '' };
    } else {
      const content = resp.message.content ?? '';
      if (content) { yield { type: 'token', delta: content }; }
      yield { type: 'done', content };
    }
  }
}
