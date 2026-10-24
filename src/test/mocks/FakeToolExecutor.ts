import type { IToolExecutor } from '../../agent/AgentLoop';
import type {
  ToolCall,
  ToolContext,
  ToolResult,
  ToolExecutionEvents,
} from '../../tools/ToolTypes';

export interface ExecutorCall {
  toolCall: ToolCall;
  context: ToolContext;
}

/**
 * Injectable ToolExecutor for unit tests.
 * Records every execute() call and returns scripted results.
 */
export class FakeToolExecutor implements IToolExecutor {
  calls: ExecutorCall[] = [];
  private results = new Map<string, ToolResult>();
  defaultResult: ToolResult = { ok: true, data: 'fake result' };

  setResult(toolName: string, result: ToolResult): void {
    this.results.set(toolName, result);
  }

  reset(): void {
    this.calls = [];
    this.results.clear();
  }

  clearRejections(): void { /* no-op in tests */ }

  async execute(
    toolCall: ToolCall,
    context: ToolContext,
    events?: ToolExecutionEvents,
    _signal?: AbortSignal,
  ): Promise<ToolResult> {
    this.calls.push({ toolCall, context });
    const result = this.results.get(toolCall.function.name) ?? this.defaultResult;
    events?.onToolStart?.(toolCall.function.name, toolCall.function.arguments);
    events?.onToolResult?.(toolCall.function.name, result);
    return result;
  }
}
