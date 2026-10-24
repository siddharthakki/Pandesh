import { OllamaMessage } from '../tools/ToolTypes';
import { TokenBudget } from '../models/TokenBudget';
import { OutputLimiter } from '../services/OutputLimiter';
import { Config } from '../config/Config';
import { MissionCheckpoint } from '../mission/MissionCheckpoint';
import { MissionCompactor } from '../mission/MissionCompactor';

const FRONTIER_REQUEST_MARKER = 'Current user request:';
const INJECTED_CONTEXT_MARKER = '## ';

/**
 * Bounds only automatically composed repository/frontier context. Ordinary
 * user text is never truncated here. The frontier prompt puts the current
 * request near the beginning, so this preserves the authoritative request and
 * drops lower-priority injected context before the shared preflight rejects
 * the entire turn.
 */
export function boundInjectedContextForDispatch(
  content: string,
  contextWindow = Config.getContextWindow(),
): string {
  const automaticallyComposed = content.includes(FRONTIER_REQUEST_MARKER)
    && content.includes(INJECTED_CONTEXT_MARKER);
  if (!automaticallyComposed) { return content; }

  // Conservative cross-tokenizer allowance: about 1.5 characters per token,
  // capped at 60% of the configured window. The remaining window is retained
  // for the system prompt, tool definitions, protocol overhead, repair reserve,
  // and model output.
  const maxChars = Math.max(4_096, Math.floor(Math.max(1_024, contextWindow) * 1.5));
  if (content.length <= maxChars) { return content; }

  const notice = '\n\n[Automatically selected repository context truncated to fit the safe model window.]';
  return `${content.slice(0, Math.max(0, maxChars - notice.length)).trimEnd()}${notice}`;
}

export class ContextManager {
  private messages: OllamaMessage[] = [];
  private readonly tokenBudget = 7000; // leave headroom for response
  private missionCheckpoint?: MissionCheckpoint;

  /**
   * Attaches (or clears, via `undefined`) the mission checkpoint whose durable
   * facts `getMessages()` must preserve through pruning. Short/non-mission
   * tasks never call this, so their behavior is unchanged.
   */
  attachMissionCheckpoint(checkpoint: MissionCheckpoint | undefined): void {
    this.missionCheckpoint = checkpoint;
  }

  /**
   * @param systemPrompt  Initial system prompt.
   * @param initialMessages  Optional messages to pre-load (for task resume).
   *                         Must already include the system message if desired;
   *                         if empty the system message is inserted automatically.
   * @param onMessageAdded   Write-through callback invoked after each message
   *                         is added to in-memory state. Used by AgentRuntime
   *                         to persist messages to TaskStore without coupling
   *                         ContextManager to the store directly.
   */
  constructor(
    private systemPrompt: string,
    initialMessages?: OllamaMessage[],
    private readonly onMessageAdded?: (msg: OllamaMessage) => void,
  ) {
    if (initialMessages && initialMessages.length > 0) {
      this.messages = [...initialMessages];
    } else {
      this.messages = [{ role: 'system', content: systemPrompt }];
    }
  }

  addUserMessage(content: string, images?: string[]): void {
    const msg: OllamaMessage = {
      role: 'user',
      content: boundInjectedContextForDispatch(content),
    };
    if (images && images.length > 0) { msg.images = images; }
    this.messages.push(msg);
    this.onMessageAdded?.(msg);
  }

  addAssistantMessage(msg: OllamaMessage): void {
    const stored: OllamaMessage = {
      role: 'assistant',
      content: msg.content,
      tool_calls: msg.tool_calls,
    };
    this.messages.push(stored);
    this.onMessageAdded?.(stored);
  }

  addToolResult(
    toolName: string,
    result: unknown,
    toolCallId?: string,
  ): void {
    const raw = JSON.stringify(result);
    const { text } = OutputLimiter.truncate(raw, Config.getMaxToolOutputChars(), 'tool result');
    const msg: OllamaMessage = {
      role: 'tool',
      content: text,
      tool_call_id: toolCallId,
      tool_name: toolName,
    };
    this.messages.push(msg);
    this.onMessageAdded?.(msg);
  }

  getMessages(): OllamaMessage[] {
    if (this.missionCheckpoint) {
      return MissionCompactor.compact(this.messages, this.missionCheckpoint, this.tokenBudget);
    }
    return TokenBudget.pruneOldToolResults([...this.messages], this.tokenBudget);
  }

  setMessages(messages: OllamaMessage[]): void {
    this.messages = messages;
  }

  /**
   * Replaces the system message and updates the stored prompt so that
   * clear() also uses the new value.  Call this when the agent mode changes
   * between turns (ask → agent, etc.) so the model context stays accurate.
   */
  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = { role: 'system', content: prompt };
    }
  }

  clear(): void {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
  }

  hasImages(): boolean {
    return this.messages.some((m) => m.images && m.images.length > 0);
  }

  hasDocuments(): boolean {
    return this.messages.some((m) => m.role === 'user' && /\[attached document:/i.test(m.content));
  }

  messageCount(): number {
    return this.messages.length;
  }

  // Get the last N messages
  getLastMessages(count: number): OllamaMessage[] {
    return this.messages.slice(-count);
  }

  // Get messages since a specific timestamp
  getMessagesSince(timestamp: string): OllamaMessage[] {
    return this.messages.filter(m => m.timestamp && m.timestamp > timestamp);
  }
}
